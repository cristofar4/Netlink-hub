//go:build windows

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/netlink/agent/internal/agent"
)

// runService starts the agent under the Windows service control manager when
// the SCM launched us, and in the foreground when a person did.
func runService(cfg agent.Config, log *slog.Logger) error {
	isService, err := svc.IsWindowsService()
	if err != nil {
		return fmt.Errorf("netlink: determining service context: %w", err)
	}
	if !isService {
		return runForeground(cfg, log)
	}
	return svc.Run(serviceName, &windowsService{cfg: cfg, log: log})
}

type windowsService struct {
	cfg agent.Config
	log *slog.Logger
}

// Execute is the SCM entry point.
//
// It answers Stop and Shutdown so Windows can bring the machine down cleanly
// rather than killing the agent mid-request.
func (s *windowsService) Execute(
	_ []string,
	requests <-chan svc.ChangeRequest,
	status chan<- svc.Status,
) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}

	a, err := agent.New(s.cfg)
	if err != nil {
		s.log.Error("agent could not start", "error", err)
		status <- svc.Status{State: svc.Stopped}
		return false, 1
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()

	status <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(15 * time.Second):
					s.log.Warn("agent did not stop within 15 seconds; forcing")
				}
				status <- svc.Status{State: svc.Stopped}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				s.log.Error("agent stopped with an error", "error", err)
				status <- svc.Status{State: svc.Stopped}
				return false, 1
			}
			status <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

// manageService registers or removes the Windows service. Both require an
// elevated prompt, which the installer supplies.
func manageService(action string, cfg agent.Config) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("netlink: connecting to the service manager (run as Administrator): %w", err)
	}
	defer m.Disconnect()

	switch action {
	case "install":
		exePath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("netlink: locating the agent executable: %w", err)
		}

		if existing, err := m.OpenService(serviceName); err == nil {
			existing.Close()
			return fmt.Errorf("netlink: the %s service is already installed", serviceName)
		}

		service, err := m.CreateService(serviceName, exePath, mgr.Config{
			DisplayName: "NetLink Agent",
			Description: "Keeps this computer available to its owner through NetLink: heartbeats, approved resources and signed power commands.",
			StartType:   mgr.StartAutomatic,
		}, "run", "--api", cfg.APIBaseURL, "--data", cfg.DataDir)
		if err != nil {
			return fmt.Errorf("netlink: creating the service: %w", err)
		}
		defer service.Close()

		// Best-effort: event-log registration failing should not fail the install.
		if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
			fmt.Fprintf(os.Stderr, "netlink: could not register the event log source: %v\n", err)
		}

		fmt.Printf("The %s service is installed. Start it with: sc.exe start %s\n", serviceName, serviceName)
		return nil

	case "uninstall":
		service, err := m.OpenService(serviceName)
		if err != nil {
			return fmt.Errorf("netlink: the %s service is not installed", serviceName)
		}
		defer service.Close()

		if err := service.Delete(); err != nil {
			return fmt.Errorf("netlink: removing the service: %w", err)
		}
		_ = eventlog.Remove(serviceName)

		fmt.Printf("The %s service has been removed.\n", serviceName)
		return nil

	default:
		return fmt.Errorf("netlink: unknown service action %q", action)
	}
}
