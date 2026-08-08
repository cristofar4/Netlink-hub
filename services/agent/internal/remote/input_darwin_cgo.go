//go:build darwin && cgo

package remote

/*
#cgo LDFLAGS: -framework ApplicationServices

#include <ApplicationServices/ApplicationServices.h>

// Placing the pointer and pressing a button are two calls rather than one
// combined event, for the same reason as on Windows: a press whose position was
// folded into the same event lands before the move on some paths, and the click
// registers in the wrong place.
static void netlinkMouseMove(double x, double y) {
    CGEventRef event = CGEventCreateMouseEvent(
        NULL, kCGEventMouseMoved, CGPointMake(x, y), kCGMouseButtonLeft);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void netlinkMouseButton(double x, double y, int button, int down) {
    CGEventType type;
    CGMouseButton which;

    switch (button) {
        case 1:
            which = kCGMouseButtonCenter;
            type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
            break;
        case 2:
            which = kCGMouseButtonRight;
            type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
            break;
        default:
            which = kCGMouseButtonLeft;
            type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
            break;
    }

    CGEventRef event = CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), which);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void netlinkMouseWheel(int amount) {
    // Unit: kCGScrollEventUnitLine matches what a physical wheel produces, so
    // one notch scrolls what a notch normally scrolls rather than a pixel.
    CGEventRef event = CGEventCreateScrollWheelEvent(
        NULL, kCGScrollEventUnitLine, 1, amount);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void netlinkKey(int keycode, int down) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, down ? true : false);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static int netlinkDisplayWidth(void)  { return (int)CGDisplayPixelsWide(CGMainDisplayID()); }
static int netlinkDisplayHeight(void) { return (int)CGDisplayPixelsHigh(CGMainDisplayID()); }

// Whether this process may post events at all. Without Accessibility permission
// every CGEventPost silently does nothing, which is the worst possible failure
// mode — so it is checked and reported instead.
static int netlinkTrusted(void) { return AXIsProcessTrusted() ? 1 : 0; }
*/
import "C"

import (
	"fmt"
	"sync"
)

/*
macOS input injection, through CGEventPost.

This is the real implementation, and it is only compiled when cgo is available —
which means building on a Mac with the Xcode command line tools. See
`input_darwin_nocgo.go` for what happens otherwise, and why the default build
deliberately does not require a Mac.

**Accessibility permission is mandatory and silent when missing.** Without it,
`CGEventPost` returns no error and does nothing at all. That would present as
"NetLink connects and shows the screen but ignores everything I do", which is
the kind of bug that costs somebody an afternoon. So the permission is checked
once, up front, and a missing one is an error that names the exact settings
panel.

**Coordinates are global, in points, not pixels.** `CGDisplayPixelsWide` reports
the backing resolution; the event API wants the logical coordinate space. On a
Retina display those differ by the scale factor, so the normalised 0..1 the
viewer sends is scaled against the *logical* size to land where the person
expects.
*/

type cgoInjector struct {
	once    sync.Once
	trusted bool

	width  float64
	height float64
}

func newPlatformInjector() Injector { return &cgoInjector{} }

func (c *cgoInjector) ensure() error {
	c.once.Do(func() {
		c.trusted = C.netlinkTrusted() == 1
		c.width = float64(C.netlinkDisplayWidth())
		c.height = float64(C.netlinkDisplayHeight())
	})

	if !c.trusted {
		return fmt.Errorf(
			"netlink: macOS has not granted Accessibility permission — open System Settings, Privacy & Security, Accessibility, and allow NetLink, then restart it. Until then this Mac can be viewed but not controlled",
		)
	}
	if c.width <= 0 || c.height <= 0 {
		return fmt.Errorf("netlink: no display to send input to")
	}
	return nil
}

// point converts the viewer's normalised 0..1 into a screen coordinate.
func (c *cgoInjector) point(x, y float64) (C.double, C.double) {
	return C.double(x * c.width), C.double(y * c.height)
}

func (c *cgoInjector) MouseMove(x, y float64) error {
	if err := c.ensure(); err != nil {
		return err
	}
	px, py := c.point(x, y)
	C.netlinkMouseMove(px, py)
	return nil
}

func (c *cgoInjector) MouseButton(button Button, down bool, x, y float64) error {
	if err := c.ensure(); err != nil {
		return err
	}

	var which C.int
	switch button {
	case ButtonLeft:
		which = 0
	case ButtonMiddle:
		which = 1
	case ButtonRight:
		which = 2
	default:
		return ErrUnknownButton
	}

	px, py := c.point(x, y)
	// Place the pointer first, then press — see the note above the C helper.
	C.netlinkMouseMove(px, py)

	pressed := C.int(0)
	if down {
		pressed = 1
	}
	C.netlinkMouseButton(px, py, which, pressed)
	return nil
}

func (c *cgoInjector) MouseWheel(deltaY float64) error {
	if err := c.ensure(); err != nil {
		return err
	}
	// Browsers report wheel deltas downward-positive; macOS expects
	// upward-positive, hence the negation. Same correction as Windows.
	C.netlinkMouseWheel(C.int(-deltaY))
	return nil
}

func (c *cgoInjector) Key(code string, down bool) error {
	if err := c.ensure(); err != nil {
		return err
	}

	keycode, ok := macVirtualKey(code)
	if !ok {
		// Dropped rather than guessed at. Sending an approximately-right key
		// into somebody's terminal is worse than sending nothing.
		return ErrBadKeyCode
	}

	pressed := C.int(0)
	if down {
		pressed = 1
	}
	C.netlinkKey(C.int(keycode), pressed)
	return nil
}
