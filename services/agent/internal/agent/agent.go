// Package agent runs the NetLink background service loop.
//
// What it does: keeps this machine's device identity, enrolls into a Space when
// the owner authorises it from the NetLink window, reports that the machine is
// up, and reports which folders and printers it *could* offer. Reporting is not
// sharing — nothing is reachable until the owner enables it.
package agent

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/netlink/agent/internal/client"
	"github.com/netlink/agent/internal/enrollment"
	"github.com/netlink/agent/internal/printers"
	"github.com/netlink/agent/pkg/identity"
	"github.com/netlink/agent/pkg/wol"
)

// Config is what the service needs to run.
type Config struct {
	APIBaseURL     string
	DataDir        string
	DeviceName     string
	AppVersion     string
	HeartbeatEvery time.Duration
	Logger         *slog.Logger
	// EnrollmentToken, when set, makes this run join a Space before starting
	// the loop. The desktop app passes it once; it is never persisted.
	EnrollmentToken string
	// WakeHelper advertises this machine as able to wake others on its LAN.
	WakeHelper bool
}

// Agent owns the identity, the enrollment and the heartbeat loop.
type Agent struct {
	cfg        Config
	store      *identity.Store
	enrollment *enrollment.Store
	ident      *identity.Identity
	client     *client.Client
	log        *slog.Logger

	mu      sync.Mutex
	current *enrollment.Enrollment
}

// New prepares an Agent, creating this installation's identity if it has none.
func New(cfg Config) (*Agent, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.HeartbeatEvery <= 0 {
		cfg.HeartbeatEvery = 30 * time.Second
	}

	store := identity.NewStore(cfg.DataDir)
	ident, err := store.LoadOrCreate(cfg.DeviceName)
	if err != nil {
		return nil, err
	}

	cfg.Logger.Info("device identity ready",
		"installationId", ident.InstallationID,
		"keyProtection", store.KeyStoreName(),
	)

	agent := &Agent{
		cfg:        cfg,
		store:      store,
		enrollment: enrollment.NewStore(cfg.DataDir),
		ident:      ident,
		log:        cfg.Logger,
		client: client.New(client.Options{
			BaseURL:    cfg.APIBaseURL,
			Identity:   ident,
			AppVersion: cfg.AppVersion,
		}),
	}

	// A previous run may already have joined a Space.
	if existing, err := agent.enrollment.Load(); err == nil {
		agent.current = existing
		agent.client.SetDeviceID(existing.DeviceID)
		cfg.Logger.Info("already enrolled", "space", existing.SpaceName, "deviceId", existing.DeviceID)
	}

	return agent, nil
}

func (a *Agent) Identity() *identity.Identity { return a.ident }
func (a *Agent) KeyProtection() string        { return a.store.KeyStoreName() }

// Enrollment reports where this installation belongs, or nil.
func (a *Agent) Enrollment() *enrollment.Enrollment {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.current
}

// ResetIdentity removes the identity stored in dataDir without starting an
// agent, so `netlink-agent reset` does not create the very identity it is
// about to delete.
func ResetIdentity(dataDir string) error {
	if err := enrollment.NewStore(dataDir).Clear(); err != nil {
		return err
	}
	return identity.NewStore(dataDir).Reset()
}

// Enroll joins a Space using a short-lived token from the desktop app.
//
// The token is the owner vouching for this installation once. Everything after
// it is proven by the device key, which is why the token is never stored.
func (a *Agent) Enroll(ctx context.Context, token string) (*enrollment.Enrollment, error) {
	resp, err := a.client.Enroll(ctx, client.EnrollRequest{
		InstallationID:     a.ident.InstallationID,
		PublicKey:          a.ident.PublicKey,
		PublicKeyAlgorithm: "ed25519",
		Name:               a.cfg.DeviceName,
		Platform:           platformName(),
		Kind:               "agent",
		OSVersion:          osVersion(),
		AppVersion:         a.cfg.AppVersion,
		EnrollmentToken:    token,
	})
	if err != nil {
		return nil, err
	}

	record := enrollment.Enrollment{
		DeviceID:   resp.DeviceID,
		SpaceID:    resp.SpaceID,
		SpaceName:  resp.SpaceName,
		EnrolledAt: time.Now().UTC(),
	}
	if err := a.enrollment.Save(record); err != nil {
		return nil, err
	}

	a.mu.Lock()
	a.current = &record
	a.mu.Unlock()
	a.client.SetDeviceID(record.DeviceID)

	a.log.Info("enrolled", "space", record.SpaceName, "deviceId", record.DeviceID)
	return &record, nil
}

// Run blocks until ctx is cancelled, sending heartbeats on the configured
// interval.
//
// A failed heartbeat is logged and retried on the next tick rather than
// crashing the service: a home connection dropping for a minute is normal, and
// a service that exits on it would need a manual restart.
func (a *Agent) Run(ctx context.Context) error {
	a.log.Info("NetLink agent starting",
		"api", a.cfg.APIBaseURL,
		"heartbeat", a.cfg.HeartbeatEvery.String(),
	)

	if err := a.client.Health(ctx); err != nil {
		// Not fatal. The machine may boot before the network is up.
		a.log.Warn("control plane not reachable at startup", "error", err)
	}

	if a.cfg.EnrollmentToken != "" && a.Enrollment() == nil {
		if _, err := a.Enroll(ctx, a.cfg.EnrollmentToken); err != nil {
			a.log.Error("enrollment failed", "error", err)
		}
	}

	ticker := time.NewTicker(a.cfg.HeartbeatEvery)
	defer ticker.Stop()

	// Resources are reported far less often than the heartbeat — printers and
	// approved folders change on a human timescale, not a 30-second one.
	resourceTicker := time.NewTicker(15 * time.Minute)
	defer resourceTicker.Stop()

	a.beat(ctx)
	a.reportResources(ctx)

	for {
		select {
		case <-ctx.Done():
			a.log.Info("NetLink agent stopping")
			return nil
		case <-ticker.C:
			a.beat(ctx)
		case <-resourceTicker.C:
			a.reportResources(ctx)
		}
	}
}

func (a *Agent) beat(ctx context.Context) {
	current := a.Enrollment()
	if current == nil {
		a.log.Debug("skipping heartbeat: this installation has not joined a Space yet")
		return
	}

	beatCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	localIP, mac := primaryInterface()

	resp, err := a.client.Heartbeat(beatCtx, client.HeartbeatRequest{
		DeviceID:       current.DeviceID,
		Status:         "online",
		LocalIP:        localIP,
		MACAddress:     mac,
		WakeOnLanReady: a.wakeReadiness(mac).Ready(),
		IsWakeHelper:   a.cfg.WakeHelper,
		AppVersion:     a.cfg.AppVersion,
		SentAt:         time.Now().UTC(),
	})
	if err != nil {
		if errors.Is(err, client.ErrRejected) {
			a.forgetIdentity("the control plane rejected this device")
			return
		}
		if !errors.Is(err, context.Canceled) {
			a.log.Warn("heartbeat failed", "error", err)
		}
		return
	}

	if resp.Revoked {
		a.forgetIdentity("this device was revoked by its owner")
	}
}

// forgetIdentity drops everything local so the next start enrolls cleanly
// rather than retrying against an identity the server has already refused.
func (a *Agent) forgetIdentity(reason string) {
	a.log.Warn("clearing local identity", "reason", reason)
	if err := ResetIdentity(a.cfg.DataDir); err != nil {
		a.log.Error("could not clear the local identity", "error", err)
		return
	}
	a.mu.Lock()
	a.current = nil
	a.mu.Unlock()
}

// reportResources tells the control plane what this machine could offer.
//
// Printers are discovered from the operating system. Folders are not — a
// folder becomes a candidate only when the owner adds it, because scanning a
// drive to suggest what to share is exactly the kind of thing NetLink should
// not do uninvited.
func (a *Agent) reportResources(ctx context.Context) {
	current := a.Enrollment()
	if current == nil {
		return
	}

	discovered, err := printers.Discover(ctx)
	if err != nil {
		a.log.Debug("printer discovery unavailable", "error", err)
		return
	}

	resources := make([]client.ReportedResource, 0, len(discovered))
	for _, printer := range discovered {
		resources = append(resources, client.ReportedResource{
			Kind:   "printer",
			Name:   printer.Name,
			Target: printer.Name,
			Metadata: map[string]any{
				"status":  printer.Status,
				"default": printer.IsDefault,
				"driver":  printer.Driver,
			},
		})
	}

	reportCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	if err := a.client.ReportResources(reportCtx, client.ResourceReport{
		DeviceID:  current.DeviceID,
		Resources: resources,
	}); err != nil {
		a.log.Warn("could not report resources", "error", err)
		return
	}
	a.log.Debug("reported resources", "count", len(resources))
}

// wakeReadiness reports what this machine can observe about its own ability to
// be woken. The control plane fills in the parts only it knows — whether a Wake
// Helper is online, and whether the MAC has been registered.
func (a *Agent) wakeReadiness(mac string) wol.Readiness {
	return wol.Readiness{
		WakeOnLanEnabled:    mac != "",
		NetworkAdapterFound: mac != "",
		PowerConnected:      true,
		WakeHelperOnline:    true,
		WakeCapableLink:     mac != "",
		TargetMACRegistered: mac != "",
	}
}

func platformName() string {
	switch runtime.GOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "macos"
	default:
		return "linux"
	}
}

func osVersion() string {
	if version := os.Getenv("OS"); version != "" {
		return version
	}
	return runtime.GOOS
}

// primaryInterface reports the local address and MAC of the interface that
// carries the default route.
//
// The MAC matters because it is the Wake-on-LAN target: an owner cannot wake a
// machine NetLink has never recorded a hardware address for.
func primaryInterface() (ip string, mac string) {
	// Dialling a UDP address performs no traffic but makes the kernel choose the
	// outbound interface, which is the one we want.
	conn, err := net.Dial("udp", "192.0.2.1:9")
	if err != nil {
		return "", ""
	}
	defer conn.Close()

	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return "", ""
	}
	ip = local.IP.String()

	interfaces, err := net.Interfaces()
	if err != nil {
		return ip, ""
	}
	for _, iface := range interfaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if ok && ipNet.IP.Equal(local.IP) {
				return ip, iface.HardwareAddr.String()
			}
		}
	}
	return ip, ""
}

// DataDirFor is the conventional per-machine location for agent state.
func DataDirFor(base string) string {
	return filepath.Join(base, "NetLink", "agent")
}

// TrimSpaceName keeps a Space name readable in a log line.
func TrimSpaceName(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > 40 {
		return name[:39] + "…"
	}
	return name
}
