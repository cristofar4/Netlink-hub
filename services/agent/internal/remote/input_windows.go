//go:build windows

package remote

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

/*
Windows input injection.

SendInput is the documented way to synthesise input, and the only one that
behaves correctly with modern applications: unlike mouse_event/keybd_event it is
atomic per call and cannot be interleaved with real hardware input mid-gesture.

Two things it deliberately cannot do, and NetLink does not work around either:

  - It cannot send Ctrl+Alt+Delete. The secure attention sequence is reserved
    for physically-present users by design, and defeating that would mean
    defeating the one thing Windows guarantees is not remotely forgeable.
  - It cannot reach a window running at a higher integrity level than the agent
    (UAC prompts, the lock screen). That is the same boundary, and it is the
    right one.
*/

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procSendInput   = user32.NewProc("SendInput")
	procGetSystemMt = user32.NewProc("GetSystemMetrics")
	procMapVirtKey  = user32.NewProc("MapVirtualKeyW")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove       = 0x0001
	mouseeventfLeftDown   = 0x0002
	mouseeventfLeftUp     = 0x0004
	mouseeventfRightDown  = 0x0008
	mouseeventfRightUp    = 0x0010
	mouseeventfMiddleDown = 0x0020
	mouseeventfMiddleUp   = 0x0040
	mouseeventfWheel      = 0x0800
	mouseeventfAbsolute   = 0x8000
	mouseeventfVirtualDsk = 0x4000

	keyeventfKeyUp   = 0x0002
	keyeventfScancde = 0x0008

	wheelDelta = 120

	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79
)

// mouseInput matches MOUSEINPUT. The trailing padding in `input` exists because
// SendInput takes a union sized to the largest member; getting the size wrong
// is the classic way this call silently does nothing.
type mouseInput struct {
	dx        int32
	dy        int32
	mouseData uint32
	flags     uint32
	time      uint32
	extraInfo uintptr
}

type keyboardInput struct {
	vk        uint16
	scan      uint16
	flags     uint32
	time      uint32
	extraInfo uintptr
	_         [8]byte
}

type input struct {
	kind uint32
	_    uint32 // alignment before the union on 64-bit
	data [32]byte
}

type winInjector struct{}

func newPlatformInjector() Injector { return &winInjector{} }

func send(in input) error {
	ret, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if ret != 1 {
		return fmt.Errorf("netlink: SendInput did not deliver the event: %w", err)
	}
	return nil
}

func metric(index int) int32 {
	v, _, _ := procGetSystemMt.Call(uintptr(index))
	return int32(v)
}

/*
absolute converts a normalised 0..1 coordinate into SendInput's absolute space.

MOUSEEVENTF_VIRTUALDESK makes 0..65535 span *all* monitors rather than the
primary one, which is what a viewer looking at a captured virtual screen
expects. Without it a second monitor is unreachable and the pointer lands in the
wrong place on a multi-monitor machine — a bug that looks like a capture problem
and is not.
*/
func absolute(x, y float64) (int32, int32) {
	width := metric(smCXVirtualScreen)
	height := metric(smCYVirtualScreen)
	if width <= 0 || height <= 0 {
		return 0, 0
	}
	return int32(x * 65535), int32(y * 65535)
}

func mouseEvent(flags uint32, x, y float64, data uint32) error {
	m := mouseInput{flags: flags, mouseData: data}
	if flags&mouseeventfAbsolute != 0 {
		m.dx, m.dy = absolute(x, y)
	}
	in := input{kind: inputMouse}
	*(*mouseInput)(unsafe.Pointer(&in.data)) = m
	return send(in)
}

func (w *winInjector) MouseMove(x, y float64) error {
	return mouseEvent(mouseeventfMove|mouseeventfAbsolute|mouseeventfVirtualDsk, x, y, 0)
}

func (w *winInjector) MouseButton(button Button, down bool, x, y float64) error {
	// The pointer is placed and the button pressed in two calls rather than one
	// combined flag set, because a press whose position was folded into the same
	// event lands before the move on some drivers.
	if err := w.MouseMove(x, y); err != nil {
		return err
	}

	var flag uint32
	switch button {
	case ButtonLeft:
		flag = mouseeventfLeftDown
		if !down {
			flag = mouseeventfLeftUp
		}
	case ButtonMiddle:
		flag = mouseeventfMiddleDown
		if !down {
			flag = mouseeventfMiddleUp
		}
	case ButtonRight:
		flag = mouseeventfRightDown
		if !down {
			flag = mouseeventfRightUp
		}
	default:
		return ErrUnknownButton
	}
	return mouseEvent(flag, 0, 0, 0)
}

func (w *winInjector) MouseWheel(deltaY float64) error {
	// Browsers report wheel deltas downward-positive; Windows expects
	// upward-positive, hence the negation.
	return mouseEvent(mouseeventfWheel, 0, 0, uint32(int32(-deltaY*wheelDelta)))
}

func (w *winInjector) Key(code string, down bool) error {
	vk, ok := virtualKey(code)
	if !ok {
		// An unmapped key is dropped rather than guessed at. Sending an
		// approximately-right key into somebody's terminal is worse than
		// sending nothing.
		return ErrBadKeyCode
	}

	// The scan code is looked up and sent alongside the virtual key: some
	// applications (notably games and remote-desktop clients themselves) read
	// the scan code and ignore the virtual key entirely.
	scan, _, _ := procMapVirtKey.Call(uintptr(vk), 0)

	k := keyboardInput{vk: vk, scan: uint16(scan)}
	if !down {
		k.flags |= keyeventfKeyUp
	}
	in := input{kind: inputKeyboard}
	*(*keyboardInput)(unsafe.Pointer(&in.data)) = k
	return send(in)
}

var _ = keyeventfScancde
var _ = smXVirtualScreen
var _ = smYVirtualScreen
