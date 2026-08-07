// Command netlink-agent is the NetLink background service.
//
// It is installed by the NetLink installer and normally runs as a Windows
// service; the user sees one NetLink application, not two. It can also be run
// in the foreground for development and troubleshooting:
//
//	netlink-agent run       start in the foreground
//	netlink-agent status    show this installation's identity
//	netlink-agent reset     forget this device identity (re-enrolls on next start)
//	netlink-agent install   register the Windows service (Windows only)
//	netlink-agent uninstall remove the Windows service (Windows only)
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/netlink/agent/internal/agent"
)

// Version is stamped at build time with -ldflags "-X main.Version=…".
var Version = "0.1.0-dev"

const serviceName = "NetLinkAgent"

func main() {
	var (
		apiURL   = flag.String("api", envOr("NETLINK_API_URL", "http://127.0.0.1:4000/api"), "NetLink control-plane base URL")
		dataDir  = flag.String("data", defaultDataDir(), "directory holding this installation's identity")
		name     = flag.String("name", defaultDeviceName(), "name shown for this device in NetLink")
		interval = flag.Duration("heartbeat", envDuration("NETLINK_HEARTBEAT_SECONDS", 30*time.Second), "heartbeat interval")
		verbose  = flag.Bool("v", false, "verbose logging")
	)

	// The subcommand is pulled out before parsing so flags work on either side
	// of it. Go's flag package stops at the first non-flag argument, so without
	// this `netlink-agent status --data C:\NetLink` would ignore --data.
	command, flagArgs := splitCommand(os.Args[1:])
	if err := flag.CommandLine.Parse(flagArgs); err != nil {
		os.Exit(2)
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	cfg := agent.Config{
		APIBaseURL:     *apiURL,
		DataDir:        *dataDir,
		DeviceName:     *name,
		AppVersion:     Version,
		HeartbeatEvery: *interval,
		Logger:         log,
	}

	switch command {
	case "run":
		if err := runService(cfg, log); err != nil {
			log.Error("agent stopped with an error", "error", err)
			os.Exit(1)
		}

	case "status":
		if err := printStatus(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

	case "reset":
		if err := resetIdentity(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("This installation's device identity has been removed. NetLink will enroll it as a new device next time it starts.")

	case "install", "uninstall":
		if err := manageService(command, cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

	case "version":
		fmt.Printf("netlink-agent %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)

	default:
		fmt.Fprintf(os.Stderr, "netlink-agent: unknown command %q\n\n", command)
		flag.Usage()
		os.Exit(2)
	}
}

// knownCommands is the complete verb list. Anything else is a usage error
// rather than being silently treated as "run".
var knownCommands = map[string]bool{
	"run": true, "status": true, "reset": true,
	"install": true, "uninstall": true, "version": true,
}

// splitCommand separates the subcommand from the flags, wherever it appears.
//
// With no subcommand it returns "run", because that is how the Windows service
// control manager launches the executable — with no arguments at all.
func splitCommand(args []string) (command string, flagArgs []string) {
	command = "run"
	found := false

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !found && !strings.HasPrefix(arg, "-") && knownCommands[arg] {
			command = arg
			found = true
			continue
		}
		flagArgs = append(flagArgs, arg)
	}

	// An unrecognised first word is surfaced rather than ignored.
	if !found && len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return command, flagArgs
}

// runForeground is the shared loop used when running interactively and, on
// non-Windows platforms, as the service body.
func runForeground(cfg agent.Config, log *slog.Logger) error {
	a, err := agent.New(cfg)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return a.Run(ctx)
}

func printStatus(cfg agent.Config) error {
	a, err := agent.New(cfg)
	if err != nil {
		return err
	}
	ident := a.Identity()

	fmt.Printf("NetLink agent %s\n", Version)
	fmt.Printf("  Device name      : %s\n", ident.DeviceName)
	fmt.Printf("  Installation ID  : %s\n", ident.InstallationID)
	fmt.Printf("  Public key       : %s\n", ident.PublicKey)
	fmt.Printf("  Key algorithm    : %s\n", ident.Algorithm)
	fmt.Printf("  Key protection   : %s\n", a.KeyProtection())
	fmt.Printf("  Identity created : %s\n", ident.CreatedAt.Format(time.RFC3339))
	fmt.Printf("  Data directory   : %s\n", cfg.DataDir)
	fmt.Printf("  Control plane    : %s\n", cfg.APIBaseURL)
	fmt.Println()
	fmt.Println("The private key for this device never leaves this machine and is not shown here.")
	return nil
}

func resetIdentity(cfg agent.Config) error {
	return agent.ResetIdentity(cfg.DataDir)
}

func defaultDataDir() string {
	if dir := os.Getenv("NETLINK_DATA_DIR"); dir != "" {
		return dir
	}
	if runtime.GOOS == "windows" {
		// ProgramData, not AppData: the service runs as LocalSystem while the
		// desktop app runs as the signed-in user, and both need this path.
		if base := os.Getenv("ProgramData"); base != "" {
			return filepath.Join(base, "NetLink", "agent")
		}
	}
	if home, err := os.UserConfigDir(); err == nil {
		return filepath.Join(home, "netlink", "agent")
	}
	return filepath.Join(".", ".netlink")
}

func defaultDeviceName() string {
	if name := os.Getenv("NETLINK_DEVICE_NAME"); name != "" {
		return name
	}
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return "NetLink PC"
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	// The variable is documented in seconds, so a bare number means seconds.
	// This must be checked with a real integer parse rather than by appending
	// "s" — "2m" + "s" is "2ms", which parses happily as two milliseconds.
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds <= 0 {
			return fallback
		}
		return time.Duration(seconds) * time.Second
	}

	// A full duration string ("2m", "90s") is accepted too.
	if d, err := time.ParseDuration(value); err == nil && d > 0 {
		return d
	}
	return fallback
}
