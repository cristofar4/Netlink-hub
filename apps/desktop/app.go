package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"

	"github.com/netlink/agent/pkg/identity"
)

// App holds what the window needs from the machine it is running on.
//
// Its exported methods are bound into JavaScript by Wails. Keeping the device
// identity behind these methods — rather than letting the frontend read files —
// means the private key has exactly one path in and out, in Go.
type App struct {
	ctx      context.Context
	store    *identity.Store
	identity *identity.Identity
	apiURL   string
}

// Version is stamped at build time with -ldflags "-X main.Version=…".
var Version = "0.1.0-dev"

func NewApp() *App {
	return &App{}
}

// Startup runs once, before the window is shown.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	a.apiURL = envOr("NETLINK_API_URL", "http://127.0.0.1:4000/api")
	a.store = identity.NewStore(desktopDataDir())
}

func (a *App) Shutdown(_ context.Context) {}

// DeviceIdentity is the public half of this installation's identity, in exactly
// the shape the control plane's `deviceIdentitySchema` expects.
//
// There is no method that returns the private key, and there never should be.
type DeviceIdentity struct {
	InstallationID     string `json:"installationId"`
	PublicKey          string `json:"publicKey"`
	PublicKeyAlgorithm string `json:"publicKeyAlgorithm"`
	Name               string `json:"name"`
	Platform           string `json:"platform"`
	Kind               string `json:"kind"`
	OSVersion          string `json:"osVersion,omitempty"`
	AppVersion         string `json:"appVersion,omitempty"`
}

// GetDeviceIdentity returns this installation's identity, generating one on
// first run. The frontend calls this before every sign-in so the session is
// always bound to a real device key.
func (a *App) GetDeviceIdentity() (*DeviceIdentity, error) {
	if a.identity == nil {
		ident, err := a.store.LoadOrCreate(defaultDeviceName())
		if err != nil {
			return nil, err
		}
		a.identity = ident
	}

	return &DeviceIdentity{
		InstallationID:     a.identity.InstallationID,
		PublicKey:          a.identity.PublicKey,
		PublicKeyAlgorithm: a.identity.Algorithm,
		Name:               a.identity.DeviceName,
		Platform:           platformName(),
		Kind:               "desktop",
		OSVersion:          runtime.GOOS,
		AppVersion:         Version,
	}, nil
}

// Environment is what the app can honestly say about where it is running.
type Environment struct {
	APIBaseURL    string `json:"apiBaseUrl"`
	AppVersion    string `json:"appVersion"`
	Platform      string `json:"platform"`
	DataDirectory string `json:"dataDirectory"`
	// KeyProtection names the actual protection guarding the private key, so
	// Settings can state it rather than implying something stronger.
	KeyProtection string `json:"keyProtection"`
}

func (a *App) GetEnvironment() Environment {
	return Environment{
		APIBaseURL:    a.apiURL,
		AppVersion:    Version,
		Platform:      platformName(),
		DataDirectory: desktopDataDir(),
		KeyProtection: a.store.KeyStoreName(),
	}
}

// ForgetDeviceIdentity removes this installation's identity.
//
// Used from Settings after the owner revokes this device from elsewhere: the
// next sign-in then enrolls a genuinely new device rather than presenting a
// key the control plane has already refused.
func (a *App) ForgetDeviceIdentity() error {
	a.identity = nil
	return a.store.Reset()
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

// desktopDataDir is per-user, unlike the agent's machine-wide directory: the
// window's identity belongs to the person signed in to Windows.
func desktopDataDir() string {
	if dir := os.Getenv("NETLINK_DESKTOP_DATA_DIR"); dir != "" {
		return dir
	}
	if base, err := os.UserConfigDir(); err == nil {
		return filepath.Join(base, "NetLink", "desktop")
	}
	return filepath.Join(".", ".netlink-desktop")
}

func defaultDeviceName() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return "My PC"
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
