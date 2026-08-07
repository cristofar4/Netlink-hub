package main

import (
	"reflect"
	"testing"
	"time"
)

func TestSplitCommand(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantCmd  string
		wantArgs []string
	}{
		{
			// How the Windows service control manager launches us.
			name:    "no arguments runs the service",
			args:    nil,
			wantCmd: "run",
		},
		{
			name:     "flags before the subcommand",
			args:     []string{"--data", "C:\\NetLink", "status"},
			wantCmd:  "status",
			wantArgs: []string{"--data", "C:\\NetLink"},
		},
		{
			// The case that was silently dropping --data before.
			name:     "flags after the subcommand",
			args:     []string{"status", "--data", "C:\\NetLink"},
			wantCmd:  "status",
			wantArgs: []string{"--data", "C:\\NetLink"},
		},
		{
			name:     "flags on both sides",
			args:     []string{"-v", "run", "--api", "http://localhost:4000/api"},
			wantCmd:  "run",
			wantArgs: []string{"-v", "--api", "http://localhost:4000/api"},
		},
		{
			name:     "flags only implies run",
			args:     []string{"--api", "http://localhost:4000/api"},
			wantCmd:  "run",
			wantArgs: []string{"--api", "http://localhost:4000/api"},
		},
		{
			name:     "an unknown verb is surfaced, not swallowed",
			args:     []string{"frobnicate", "--data", "x"},
			wantCmd:  "frobnicate",
			wantArgs: []string{"--data", "x"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotCmd, gotArgs := splitCommand(tc.args)
			if gotCmd != tc.wantCmd {
				t.Errorf("command = %q, want %q", gotCmd, tc.wantCmd)
			}
			if len(gotArgs) == 0 && len(tc.wantArgs) == 0 {
				return
			}
			if !reflect.DeepEqual(gotArgs, tc.wantArgs) {
				t.Errorf("flags = %v, want %v", gotArgs, tc.wantArgs)
			}
		})
	}
}

func TestEveryDocumentedCommandIsKnown(t *testing.T) {
	for _, verb := range []string{"run", "status", "reset", "install", "uninstall", "version"} {
		if !knownCommands[verb] {
			t.Errorf("%q is documented but not in knownCommands", verb)
		}
	}
}

func TestEnvDuration(t *testing.T) {
	t.Setenv("NETLINK_TEST_INTERVAL", "45")
	if got := envDuration("NETLINK_TEST_INTERVAL", time.Second); got != 45*time.Second {
		t.Errorf("bare number = %v, want 45s (the variable is documented in seconds)", got)
	}

	t.Setenv("NETLINK_TEST_INTERVAL", "2m")
	if got := envDuration("NETLINK_TEST_INTERVAL", time.Second); got != 2*time.Minute {
		t.Errorf("duration string = %v, want 2m", got)
	}

	t.Setenv("NETLINK_TEST_INTERVAL", "90s")
	if got := envDuration("NETLINK_TEST_INTERVAL", time.Second); got != 90*time.Second {
		t.Errorf("seconds string = %v, want 90s", got)
	}

	t.Setenv("NETLINK_TEST_INTERVAL", "0")
	if got := envDuration("NETLINK_TEST_INTERVAL", 30*time.Second); got != 30*time.Second {
		t.Errorf("zero = %v, want the fallback (a zero interval would spin)", got)
	}

	t.Setenv("NETLINK_TEST_INTERVAL", "not-a-duration")
	if got := envDuration("NETLINK_TEST_INTERVAL", 30*time.Second); got != 30*time.Second {
		t.Errorf("garbage = %v, want the fallback", got)
	}

	if got := envDuration("NETLINK_TEST_UNSET_INTERVAL", 30*time.Second); got != 30*time.Second {
		t.Errorf("unset = %v, want the fallback", got)
	}
}

func TestEnvOr(t *testing.T) {
	t.Setenv("NETLINK_TEST_URL", "http://example.test/api")
	if got := envOr("NETLINK_TEST_URL", "fallback"); got != "http://example.test/api" {
		t.Errorf("envOr = %q", got)
	}
	if got := envOr("NETLINK_TEST_UNSET_URL", "fallback"); got != "fallback" {
		t.Errorf("envOr fallback = %q", got)
	}
}

func TestDefaultDataDirHonoursOverride(t *testing.T) {
	t.Setenv("NETLINK_DATA_DIR", "/custom/netlink")
	if got := defaultDataDir(); got != "/custom/netlink" {
		t.Errorf("defaultDataDir = %q", got)
	}
}
