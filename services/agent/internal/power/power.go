// Package power carries out verified power commands on this machine.
//
// Nothing here is reachable without a command that has already passed every
// check in pkg/command: signed by a trusted key, addressed to this device,
// inside its validity window, and carrying an unseen nonce. This package is
// only the "what to actually do" half.
//
// The verbs are fixed. There is no path here that runs an arbitrary program,
// and the test suite fails if one is added.
package power

import (
	"context"
	"errors"
	"fmt"

	"github.com/netlink/agent/pkg/command"
	"github.com/netlink/agent/pkg/wol"
)

// Executor performs one verified command.
type Executor interface {
	// Execute carries out the action, returning a short human-readable detail
	// for the audit record.
	Execute(ctx context.Context, action command.Action, target Target) (string, error)
}

// Target describes the machine a command concerns.
//
// For everything but a wake, that is this machine. For a wake it is another
// machine on the same local network, and only its address matters.
type Target struct {
	MACAddress  string
	BroadcastIP string
}

// ErrUnsupportedAction is returned for an action this platform cannot perform.
var ErrUnsupportedAction = errors.New("netlink: this action is not supported on this platform")

// New returns the platform executor.
func New() Executor { return newPlatformExecutor() }

// wakeExecutor handles power.wake identically everywhere, because a magic
// packet is just UDP — nothing platform-specific about it.
type wakeExecutor struct {
	sender wol.Sender
}

func (w wakeExecutor) wake(target Target) (string, error) {
	sender := w.sender
	if sender == nil {
		sender = wol.UDPSender{}
	}
	if target.MACAddress == "" {
		return "", errors.New("netlink: no network address registered for that computer")
	}

	broadcast := target.BroadcastIP
	if broadcast == "" {
		broadcast = "255.255.255.255"
	}

	if err := wol.Wake(sender, target.MACAddress, broadcast, wol.DefaultPort); err != nil {
		return "", err
	}
	return fmt.Sprintf("Magic packet sent to %s via %s", target.MACAddress, broadcast), nil
}
