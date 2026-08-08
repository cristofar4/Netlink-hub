//go:build !windows && !darwin

package remote

import "fmt"

/*
The non-Windows injector.

NetLink hosts remote desktop sessions on Windows. Everywhere else the agent
refuses rather than shelling out to xdotool or CGEventPost: a half-working
remote control on a developer's Linux box would be a worse outcome than an
honest refusal, and it would mean the code that actually ships to users is not
the code anyone runs during development.

The view-only gate, the event validation, the key table and the session
lifecycle are all platform-independent and are exercised on every platform.
Only the final "move the pointer" step is Windows-only.
*/

type unsupportedInjector struct{}

func newPlatformInjector() Injector { return &unsupportedInjector{} }

var errUnsupported = fmt.Errorf("netlink: input injection is available on Windows")

func (unsupportedInjector) MouseMove(float64, float64) error { return errUnsupported }
func (unsupportedInjector) MouseButton(Button, bool, float64, float64) error {
	return errUnsupported
}
func (unsupportedInjector) MouseWheel(float64) error { return errUnsupported }
func (unsupportedInjector) Key(string, bool) error   { return errUnsupported }
