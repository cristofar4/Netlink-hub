// Package agent runs the NetLink background service loop.
//
// The loop is intentionally small: prove the control plane is reachable, keep
// this device's identity, and send an authenticated heartbeat on a schedule.
// Phase 2 gives it resource registration, Phase 4 power commands, Phase 5 files
// and printers. Nothing here executes anything on the owner's behalf yet.
package agent

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"time"

	"github.com/netlink/agent/internal/client"
	"github.com/netlink/agent/pkg/identity"
)

// Config is what the service needs to run.
type Config struct {
	APIBaseURL     string
	DataDir        string
	DeviceName     string
	AppVersion     string
	HeartbeatEvery time.Duration
	Logger         *slog.Logger
}

// Agent owns the identity and the heartbeat loop.
type Agent struct {
	cfg    Config
	store  *identity.Store
	ident  *identity.Identity
	client *client.Client
	log    *slog.Logger
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

	return &Agent{
		cfg:   cfg,
		store: store,
		ident: ident,
		log:   cfg.Logger,
		client: client.New(client.Options{
			BaseURL:    cfg.APIBaseURL,
			Identity:   ident,
			AppVersion: cfg.AppVersion,
		}),
	}, nil
}

// Identity exposes this installation's identity, for the status command.
func (a *Agent) Identity() *identity.Identity { return a.ident }

// ResetIdentity removes the identity stored in dataDir without starting an
// agent, so `netlink-agent reset` does not create the very identity it is
// about to delete.
func ResetIdentity(dataDir string) error {
	return identity.NewStore(dataDir).Reset()
}

// KeyProtection reports how the private key is protected on this machine.
func (a *Agent) KeyProtection() string { return a.store.KeyStoreName() }

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

	ticker := time.NewTicker(a.cfg.HeartbeatEvery)
	defer ticker.Stop()

	a.beat(ctx)

	for {
		select {
		case <-ctx.Done():
			a.log.Info("NetLink agent stopping")
			return nil
		case <-ticker.C:
			a.beat(ctx)
		}
	}
}

func (a *Agent) beat(ctx context.Context) {
	deviceID := a.client.DeviceID()
	if deviceID == "" {
		// Enrollment is driven by the desktop app, which holds the owner's
		// session. Until that has happened there is nothing to report to.
		a.log.Debug("skipping heartbeat: this installation is not enrolled yet")
		return
	}

	beatCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	localIP, mac := primaryInterface()

	resp, err := a.client.Heartbeat(beatCtx, client.HeartbeatRequest{
		DeviceID:   deviceID,
		Status:     "online",
		LocalIP:    localIP,
		MACAddress: mac,
		AppVersion: a.cfg.AppVersion,
		SentAt:     time.Now().UTC(),
	})
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			a.log.Warn("heartbeat failed", "error", err)
		}
		return
	}

	if resp.Revoked {
		// The owner removed this device. Drop the identity so the next start
		// enrolls as a new device rather than retrying against a dead one.
		a.log.Warn("this device was revoked by its owner; clearing local identity")
		if err := a.store.Reset(); err != nil {
			a.log.Error("could not clear the local identity", "error", err)
		}
	}
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
