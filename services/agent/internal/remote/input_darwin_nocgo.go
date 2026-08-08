//go:build darwin && !cgo

package remote

import "fmt"

/*
The macOS injector, in a build without cgo.

Synthesising input on macOS means CGEventPost, which lives in the
ApplicationServices framework and can only be reached through cgo. A binary
built with `CGO_ENABLED=0` — which is the default when cross-compiling from a
machine that is not a Mac — therefore cannot move the pointer or press a key.

**It says so rather than pretending.** A remote session against this build works
perfectly as *view only*: frames flow, the viewer sees the screen, and every
input event is refused with an error that names the reason. That is a real,
useful mode — NetLink has a first-class view-only session — and it is a great
deal better than a binary that silently swallows every keystroke and leaves
somebody wondering why their clicks do nothing.

To get full control on a Mac, build on a Mac with the Xcode command line tools
present:

	CGO_ENABLED=1 go build ./cmd/netlink-agent

macOS will then also ask for Accessibility permission the first time input is
injected, and refuse until it is granted. That prompt is the operating system
doing its job.
*/

type noCgoInjector struct{}

func newPlatformInjector() Injector { return noCgoInjector{} }

var errNeedsCgo = fmt.Errorf(
	"netlink: this build cannot control a Mac — it was compiled without cgo, so CGEventPost is unavailable. Rebuild on macOS with CGO_ENABLED=1. Viewing this screen still works",
)

func (noCgoInjector) MouseMove(float64, float64) error                 { return errNeedsCgo }
func (noCgoInjector) MouseButton(Button, bool, float64, float64) error { return errNeedsCgo }
func (noCgoInjector) MouseWheel(float64) error                         { return errNeedsCgo }
func (noCgoInjector) Key(string, bool) error                           { return errNeedsCgo }
