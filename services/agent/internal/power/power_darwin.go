//go:build darwin

package power

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/netlink/agent/pkg/command"
	"github.com/netlink/agent/pkg/wol"
)

/*
macOS power actions.

Every one of these is a documented command-line tool that ships with macOS, and
none of them needs cgo. That is not a compromise here the way it would be for
screen capture — `shutdown` and `pmset` are the interfaces Apple provides, and
binding IOKit would be more code doing the same thing.

Two differences from Windows worth knowing, because both change what a person
sees:

  - **Restart and shut down need root.** macOS will not let an ordinary user
    process halt the machine. The agent installed as a LaunchDaemon runs as
    root and can; the same agent run by hand from a terminal cannot, and says
    so rather than failing silently.

  - **There is no countdown at the machine.** Windows' `shutdown /t` shows the
    person sitting there a warning they can cancel locally. macOS has no
    equivalent, so NetLink's own ten-second countdown — held in the control
    plane, which withholds the command until it elapses — is the only warning.
    That countdown is real on both platforms; on macOS it is also the *whole*
    protection, which is worth knowing before you press the button.
*/

type darwinExecutor struct {
	wakeExecutor
	// run is injectable so the command construction can be tested without
	// shutting down the machine running the tests.
	run func(ctx context.Context, name string, args ...string) (string, error)
}

func newPlatformExecutor() Executor {
	return &darwinExecutor{run: runCommand}
}

// NewWithSender builds an executor with an injected packet sender, so the wake
// path can be exercised without putting traffic on a real network.
func NewWithSender(sender wol.Sender) Executor {
	return &darwinExecutor{wakeExecutor: wakeExecutor{sender: sender}, run: runCommand}
}

func (e *darwinExecutor) Execute(
	ctx context.Context,
	action command.Action,
	target Target,
) (string, error) {
	switch action {
	case command.ActionWake:
		return e.wake(target)

	case command.ActionRestart:
		// `-r now` rather than a delay: the delay that matters already happened
		// in the control plane, and two countdowns would mean the cancel button
		// stops one of them and not the other.
		if _, err := e.run(ctx, "shutdown", "-r", "now"); err != nil {
			return "", elevationHint(err, "restart")
		}
		return "Restarting", nil

	case command.ActionShutdown:
		if _, err := e.run(ctx, "shutdown", "-h", "now"); err != nil {
			return "", elevationHint(err, "shut down")
		}
		return "Shutting down", nil

	case command.ActionSleep:
		// `sleepnow` puts the machine to sleep immediately without forcing
		// anything to close, which is what sleep should do.
		if _, err := e.run(ctx, "pmset", "sleepnow"); err != nil {
			return "", fmt.Errorf("netlink: could not put this Mac to sleep: %w", err)
		}
		return "Sleeping", nil

	case command.ActionLock:
		/*
			Locking on macOS has no single supported command, so this asks the
			login window to do it through a private-but-stable framework entry
			point. It has behaved identically for many macOS versions and is what
			every lock utility uses.

			The alternative — starting the screen saver — is not the same thing:
			a screen saver only locks if the user has set it to, so it would
			leave some machines unlocked while reporting success.
		*/
		if _, err := e.run(ctx,
			"/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
			"-suspend",
		); err != nil {
			return "", fmt.Errorf("netlink: could not lock this Mac: %w", err)
		}
		return "Locked", nil

	case command.ActionCancelShutdown:
		// Nothing to cancel: macOS shutdowns are issued with `now`, and the only
		// delay in the system is the control plane's, which is cancelled there.
		return "", fmt.Errorf("%w: %s", ErrUnsupportedAction, action)

	default:
		return "", fmt.Errorf("%w: %s", ErrUnsupportedAction, action)
	}
}

func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			return "", err
		}
		return "", fmt.Errorf("%w: %s", err, detail)
	}
	return strings.TrimSpace(stdout.String()), nil
}

/*
elevationHint turns the most common failure into something a person can act on.

"exit status 1" tells nobody anything. "NetLink needs to run as a system service
to shut this Mac down" tells them exactly what to change, and it is by far the
likeliest reason this call failed.
*/
func elevationHint(err error, verb string) error {
	if strings.Contains(err.Error(), "not permitted") ||
		strings.Contains(err.Error(), "Operation not permitted") ||
		strings.Contains(err.Error(), "must be root") {
		return fmt.Errorf(
			"netlink: NetLink must be installed as a system service to %s this Mac — run `sudo netlink-agent install`: %w",
			verb, err,
		)
	}
	return fmt.Errorf("netlink: could not %s this Mac: %w", verb, err)
}
