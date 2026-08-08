//go:build darwin

package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/netlink/agent/internal/agent"
)

/*
Running as a macOS system service, via launchd.

A LaunchDaemon rather than a LaunchAgent, and the difference is the whole point:
a LaunchAgent runs only while a user is logged in, which would mean NetLink
could not wake, reach or power a Mac that nobody is sitting at — the exact
situation it exists for. A LaunchDaemon runs from boot, as root, whether anyone
is logged in or not.

Running as root is what makes `shutdown` work. It is also why the plist is
written to a root-owned directory with root-owned permissions: a LaunchDaemon
plist that a non-root user can edit is a local privilege escalation, and launchd
refuses to load one, correctly.
*/

const launchdLabel = "com.netlink.agent"

func plistPath() string {
	return filepath.Join("/Library/LaunchDaemons", launchdLabel+".plist")
}

// runService runs in the foreground.
//
// launchd expects exactly this: it supervises the process itself rather than
// having the process detach, so a daemon that forks into the background is a
// daemon launchd immediately restarts forever.
func runService(cfg agent.Config, log *slog.Logger) error {
	return runForeground(cfg, log)
}

func manageService(action string, cfg agent.Config) error {
	switch action {
	case "install":
		return installDaemon(cfg)
	case "uninstall":
		return uninstallDaemon()
	default:
		return fmt.Errorf("netlink: unknown service action %q", action)
	}
}

func installDaemon(cfg agent.Config) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("netlink: installing the service needs root — run `sudo netlink-agent install`")
	}

	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("netlink: could not find this executable: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("netlink: could not resolve this executable: %w", err)
	}

	plist := buildPlist(executable, cfg)
	// 0644 root:wheel. launchd refuses to load a daemon plist that is
	// group- or world-writable, which is the check that stops a local user
	// turning this into a root shell.
	if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
		return fmt.Errorf("netlink: could not write the launchd plist: %w", err)
	}
	if err := os.Chown(plistPath(), 0, 0); err != nil {
		return fmt.Errorf("netlink: could not set the plist owner: %w", err)
	}

	if out, err := exec.Command("launchctl", "load", "-w", plistPath()).CombinedOutput(); err != nil {
		return fmt.Errorf("netlink: launchctl load failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	fmt.Println("NetLink agent installed and started.")
	fmt.Println()
	fmt.Println("macOS will ask for two permissions the first time they are needed:")
	fmt.Println("  Screen Recording  — to show this Mac's screen in a remote session")
	fmt.Println("  Accessibility     — to let a remote session control it")
	fmt.Println()
	fmt.Println("Both are in System Settings, Privacy & Security. Until they are")
	fmt.Println("granted NetLink says so rather than failing quietly.")
	return nil
}

func uninstallDaemon() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("netlink: removing the service needs root — run `sudo netlink-agent uninstall`")
	}

	// Unload before deleting: removing the plist first leaves launchd
	// supervising a job it can no longer describe.
	if out, err := exec.Command("launchctl", "unload", "-w", plistPath()).CombinedOutput(); err != nil {
		// An already-unloaded job is not an error worth stopping for.
		if !strings.Contains(string(out), "Could not find") {
			return fmt.Errorf("netlink: launchctl unload failed: %w: %s", err, strings.TrimSpace(string(out)))
		}
	}

	if err := os.Remove(plistPath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("netlink: could not remove the launchd plist: %w", err)
	}

	fmt.Println("NetLink agent removed.")
	return nil
}

/*
buildPlist writes the launchd job description.

`RunAtLoad` plus `KeepAlive` is what makes the agent a thing that is simply
always there: started at boot, restarted if it exits. `ThrottleInterval` stops a
crash loop from consuming the machine — launchd's default of 10 seconds is fine,
and stated explicitly so it is a decision rather than a default nobody read.

The enrollment token is deliberately *not* written here. It is single-use and
short-lived; putting it in a file on disk that persists for the life of the
installation would leave a spent credential lying around for no reason.
*/
func buildPlist(executable string, cfg agent.Config) string {
	var arguments strings.Builder
	arguments.WriteString("    <string>" + xmlEscape(executable) + "</string>\n")
	arguments.WriteString("    <string>run</string>\n")
	if cfg.APIBaseURL != "" {
		arguments.WriteString("    <string>--api</string>\n")
		arguments.WriteString("    <string>" + xmlEscape(cfg.APIBaseURL) + "</string>\n")
	}
	if cfg.DataDir != "" {
		arguments.WriteString("    <string>--data</string>\n")
		arguments.WriteString("    <string>" + xmlEscape(cfg.DataDir) + "</string>\n")
	}
	if cfg.WakeHelper {
		arguments.WriteString("    <string>--wake-helper</string>\n")
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + launchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
` + arguments.String() + `  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/var/log/netlink-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/netlink-agent.log</string>
</dict>
</plist>
`
}

// xmlEscape keeps a path with an ampersand or an angle bracket in it from
// producing a plist launchd cannot parse. Rare, but a directory named
// "Work & Home" is not exotic.
func xmlEscape(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(value)
}
