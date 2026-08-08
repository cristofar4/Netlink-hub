// Package remote hosts the remote desktop session on the computer being viewed.
//
// The important thing in this package is small and lives in session.go: input
// events are only applied when the session's signed grant says "control". The
// rest — capture, encoding, the peer connection — is plumbing around it.
package remote

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Kind is one input verb. The list is closed; anything else is refused.
type Kind string

const (
	KindMouseMove  Kind = "mouse.move"
	KindMouseDown  Kind = "mouse.down"
	KindMouseUp    Kind = "mouse.up"
	KindMouseWheel Kind = "mouse.wheel"
	KindKeyDown    Kind = "key.down"
	KindKeyUp      Kind = "key.up"
)

// Button is a mouse button.
type Button string

const (
	ButtonLeft   Button = "left"
	ButtonMiddle Button = "middle"
	ButtonRight  Button = "right"
)

// Event is one input event as it arrives on the data channel.
//
// X and Y are normalised 0..1 rather than pixels, so a viewer on a laptop and a
// host on a 4K monitor agree without either knowing the other's resolution.
type Event struct {
	Kind   Kind    `json:"kind"`
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button Button  `json:"button,omitempty"`
	DeltaY float64 `json:"deltaY,omitempty"`
	// Code is a W3C KeyboardEvent.code — a physical key position, not a
	// character. Passing positions rather than characters means the host's own
	// keyboard layout decides what a key produces, which is both correct and
	// one fewer thing the viewer gets to control.
	Code string `json:"code,omitempty"`
}

var (
	ErrUnknownKind   = errors.New("netlink: unrecognised input kind")
	ErrUnknownButton = errors.New("netlink: unrecognised mouse button")
	ErrBadKeyCode    = errors.New("netlink: key code is not acceptable")
	ErrMalformed     = errors.New("netlink: input event is malformed")
)

// keyCodePattern bounds what can reach the host's key mapping. W3C `code`
// values are alphanumeric identifiers like "KeyA", "Digit4", "ArrowLeft",
// "ShiftLeft"; nothing legitimate needs punctuation, and an unbounded string
// arriving from a peer is a string somebody will eventually try to make
// interesting.
var keyCodePattern = regexp.MustCompile(`^[A-Za-z0-9]{1,24}$`)

// DecodeEvent parses and validates one event.
//
// Validation is strict and happens before anything is applied: coordinates are
// clamped into range, buttons and kinds must be in the closed lists, and key
// codes must match the pattern. An event that fails is dropped, never
// approximated.
func DecodeEvent(raw []byte) (Event, error) {
	var ev Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		return Event{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return validate(ev)
}

func validate(ev Event) (Event, error) {
	switch ev.Kind {
	case KindMouseMove, KindMouseWheel:
		ev.X = clamp01(ev.X)
		ev.Y = clamp01(ev.Y)
		ev.Code = ""
		ev.Button = ""

	case KindMouseDown, KindMouseUp:
		ev.X = clamp01(ev.X)
		ev.Y = clamp01(ev.Y)
		ev.Code = ""
		switch ev.Button {
		case ButtonLeft, ButtonMiddle, ButtonRight:
		case "":
			// A press with no button named is ambiguous, and guessing "left"
			// would mean a malformed event still clicks something.
			return Event{}, ErrUnknownButton
		default:
			return Event{}, ErrUnknownButton
		}

	case KindKeyDown, KindKeyUp:
		if !keyCodePattern.MatchString(ev.Code) {
			return Event{}, ErrBadKeyCode
		}
		ev.X, ev.Y, ev.DeltaY = 0, 0, 0
		ev.Button = ""

	default:
		return Event{}, ErrUnknownKind
	}

	// A wheel delta is bounded so one event cannot scroll a document to its end,
	// and so a NaN cannot reach the platform layer.
	if ev.DeltaY != ev.DeltaY { // NaN
		ev.DeltaY = 0
	}
	if ev.DeltaY > 10 {
		ev.DeltaY = 10
	}
	if ev.DeltaY < -10 {
		ev.DeltaY = -10
	}

	return ev, nil
}

// clamp01 forces a coordinate into range. A value outside 0..1 is either a bug
// or an attempt to steer the pointer off-screen, and neither should succeed.
func clamp01(v float64) float64 {
	if v != v { // NaN
		return 0
	}
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// Injector applies input to the machine. Implemented by the platform layer;
// swapped for a recorder in tests so the gate can be proven without moving a
// real pointer.
type Injector interface {
	MouseMove(x, y float64) error
	MouseButton(button Button, down bool, x, y float64) error
	MouseWheel(deltaY float64) error
	Key(code string, down bool) error
}

// Apply dispatches a validated event to an injector.
func Apply(in Injector, ev Event) error {
	switch ev.Kind {
	case KindMouseMove:
		return in.MouseMove(ev.X, ev.Y)
	case KindMouseDown:
		return in.MouseButton(ev.Button, true, ev.X, ev.Y)
	case KindMouseUp:
		return in.MouseButton(ev.Button, false, ev.X, ev.Y)
	case KindMouseWheel:
		return in.MouseWheel(ev.DeltaY)
	case KindKeyDown:
		return in.Key(ev.Code, true)
	case KindKeyUp:
		return in.Key(ev.Code, false)
	default:
		return ErrUnknownKind
	}
}

// NewInjector returns the platform input injector.
func NewInjector() Injector { return newPlatformInjector() }
