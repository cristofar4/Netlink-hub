//go:build windows

package power

import (
	"context"
	"fmt"
	"os/exec"
	"time"

	"github.com/netlink/agent/pkg/command"
)

/*
Windows power actions.

Restart and shutdown go through shutdown.exe; lock through LockWorkStation in
user32.dll; sleep through SetSuspendState in powrprof.dll.

Every argument is a fixed constant — there is no place a value from the network
reaches a command line, because the only thing the control plane can choose is
which of these six branches runs.

The `/t 0` on shutdown is deliberate: the ten-second countdown is enforced by
the control plane, which holds the command back until it elapses and lets
anyone cancel during it. Adding a second Windows-side countdown on top would
make the cancel window disagree with what the UI showed.
*/

type windowsExecutor struct {
	wakeExecutor
}

func newPlatformExecutor() Executor { return &windowsExecutor{} }

func (e *windowsExecutor) Execute(
	ctx context.Context,
	action command.Action,
	target Target,
) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	switch action {
	case command.ActionWake:
		return e.wake(target)

	case command.ActionRestart:
		if err := run(ctx, "shutdown.exe", "/r", "/t", "0", "/c", "NetLink: restarting at your request"); err != nil {
			return "", err
		}
		return "Restart started", nil

	case command.ActionShutdown:
		if err := run(ctx, "shutdown.exe", "/s", "/t", "0", "/c", "NetLink: shutting down at your request"); err != nil {
			return "", err
		}
		return "Shutdown started", nil

	case command.ActionCancelShutdown:
		// Cancels a countdown Windows itself is running. Harmless when there is
		// none, which is why the error is swallowed.
		_ = run(ctx, "shutdown.exe", "/a")
		return "Any pending shutdown was cancelled", nil

	case command.ActionLock:
		if err := lockWorkstation(); err != nil {
			return "", err
		}
		return "Workstation locked", nil

	case command.ActionSleep:
		if err := suspend(); err != nil {
			return "", err
		}
		return "Sleep requested", nil

	default:
		return "", fmt.Errorf("%w: %s", ErrUnsupportedAction, action)
	}
}

func run(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("netlink: %s failed: %w (%s)", name, err, truncate(string(output), 200))
	}
	return nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
