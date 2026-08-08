//go:build !windows

package power

import (
	"context"
	"fmt"

	"github.com/netlink/agent/pkg/command"
	"github.com/netlink/agent/pkg/wol"
)

/*
The non-Windows executor.

Wake works everywhere — a magic packet is just UDP. Everything else reports
that it is unsupported rather than shelling out to `systemctl` or `pmset`:
NetLink ships as a Windows product, and a half-working power action on a
developer's Linux box would be a worse outcome than an honest refusal.
*/

type otherExecutor struct {
	wakeExecutor
}

func newPlatformExecutor() Executor { return &otherExecutor{} }

// NewWithSender builds an executor with an injected packet sender, so the wake
// path can be exercised without putting traffic on a real network.
func NewWithSender(sender wol.Sender) Executor {
	return &otherExecutor{wakeExecutor{sender: sender}}
}

func (e *otherExecutor) Execute(
	_ context.Context,
	action command.Action,
	target Target,
) (string, error) {
	if action == command.ActionWake {
		return e.wake(target)
	}
	return "", fmt.Errorf("%w: %s (NetLink performs power actions on Windows)", ErrUnsupportedAction, action)
}
