//go:build darwin

package remote

/*
W3C `KeyboardEvent.code` to macOS virtual key code.

A separate table from the Windows one, because the numbers are genuinely
different — macOS virtual key codes come from the old Apple Extended Keyboard
layout and have no relationship to Windows VK codes. `KeyA` is 0x41 on Windows
and 0x00 here.

The same principle applies as on Windows: these are *physical key positions*,
not characters. The viewer says which key was pressed and the host's own layout
decides what it produces, so a French Mac types French from a UK viewer's
keyboard — which is correct, and means the viewer never gets to influence the
host's layout.

Explicit rather than generated, for the same reason as the Windows table: every
entry is a key somebody can press on someone else's machine, and each one should
be there because a person put it there.
*/

var macVirtualKeys = map[string]int{
	// Letters. Note how little order there is — this is the physical layout of
	// a 1987 keyboard, not an alphabet.
	"KeyA": 0x00, "KeyB": 0x0B, "KeyC": 0x08, "KeyD": 0x02, "KeyE": 0x0E,
	"KeyF": 0x03, "KeyG": 0x05, "KeyH": 0x04, "KeyI": 0x22, "KeyJ": 0x26,
	"KeyK": 0x28, "KeyL": 0x25, "KeyM": 0x2E, "KeyN": 0x2D, "KeyO": 0x1F,
	"KeyP": 0x23, "KeyQ": 0x0C, "KeyR": 0x0F, "KeyS": 0x01, "KeyT": 0x11,
	"KeyU": 0x20, "KeyV": 0x09, "KeyW": 0x0D, "KeyX": 0x07, "KeyY": 0x10,
	"KeyZ": 0x06,

	// Digit row.
	"Digit0": 0x1D, "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14,
	"Digit4": 0x15, "Digit5": 0x17, "Digit6": 0x16, "Digit7": 0x1A,
	"Digit8": 0x1C, "Digit9": 0x19,

	// Editing and navigation.
	"Enter": 0x24, "Escape": 0x35, "Backspace": 0x33, "Tab": 0x30,
	"Space": 0x31, "Delete": 0x75, "Home": 0x73, "End": 0x77,
	"PageUp": 0x74, "PageDown": 0x79,
	"ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,

	// Modifiers. Left and right are distinct, because an application that
	// treats right Option differently is relying on exactly that.
	"ShiftLeft": 0x38, "ShiftRight": 0x3C,
	"ControlLeft": 0x3B, "ControlRight": 0x3E,
	"AltLeft": 0x3A, "AltRight": 0x3D,
	// Command, which is what a Mac uses where Windows uses Control.
	"MetaLeft": 0x37, "MetaRight": 0x36,
	"CapsLock": 0x39,

	// Function keys.
	"F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61,
	"F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,

	// Punctuation, by position.
	"Minus": 0x1B, "Equal": 0x18, "BracketLeft": 0x21, "BracketRight": 0x1E,
	"Backslash": 0x2A, "Semicolon": 0x29, "Quote": 0x27, "Backquote": 0x32,
	"Comma": 0x2B, "Period": 0x2F, "Slash": 0x2C,

	// Numeric keypad.
	"Numpad0": 0x52, "Numpad1": 0x53, "Numpad2": 0x54, "Numpad3": 0x55,
	"Numpad4": 0x56, "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59,
	"Numpad8": 0x5B, "Numpad9": 0x5C,
	"NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumpadSubtract": 0x4E,
	"NumpadDecimal": 0x41, "NumpadDivide": 0x4B, "NumpadEnter": 0x4C,
}

// macVirtualKey resolves a W3C code to a macOS virtual key code.
func macVirtualKey(code string) (int, bool) {
	keycode, ok := macVirtualKeys[code]
	return keycode, ok
}

// MappedKeyCountDarwin is used by tests to notice when the table changes, so a
// key cannot be added to what a remote peer may press without someone deciding.
func MappedKeyCountDarwin() int { return len(macVirtualKeys) }

// IsMappedKeyDarwin reports whether a code will do anything on a Mac.
func IsMappedKeyDarwin(code string) bool {
	_, ok := macVirtualKeys[code]
	return ok
}
