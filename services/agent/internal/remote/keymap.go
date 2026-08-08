package remote

/*
W3C `KeyboardEvent.code` to Windows virtual-key code.

Physical key positions, not characters. That distinction matters: the viewer
tells the host *which key was pressed*, and the host's own keyboard layout
decides what that key produces. A German host running a UK viewer types German,
which is correct, and the viewer never gets to influence the host's layout.

The table is explicit rather than computed. A generated mapping would be shorter
and would quietly acquire entries nobody chose — and every entry here is a key
somebody can press on someone else's machine.
*/

var virtualKeys = map[string]uint16{
	// Letters. VK codes for A-Z are the ASCII uppercase values.
	"KeyA": 0x41, "KeyB": 0x42, "KeyC": 0x43, "KeyD": 0x44, "KeyE": 0x45,
	"KeyF": 0x46, "KeyG": 0x47, "KeyH": 0x48, "KeyI": 0x49, "KeyJ": 0x4A,
	"KeyK": 0x4B, "KeyL": 0x4C, "KeyM": 0x4D, "KeyN": 0x4E, "KeyO": 0x4F,
	"KeyP": 0x50, "KeyQ": 0x51, "KeyR": 0x52, "KeyS": 0x53, "KeyT": 0x54,
	"KeyU": 0x55, "KeyV": 0x56, "KeyW": 0x57, "KeyX": 0x58, "KeyY": 0x59,
	"KeyZ": 0x5A,

	// Digit row. VK codes for 0-9 are the ASCII digits.
	"Digit0": 0x30, "Digit1": 0x31, "Digit2": 0x32, "Digit3": 0x33, "Digit4": 0x34,
	"Digit5": 0x35, "Digit6": 0x36, "Digit7": 0x37, "Digit8": 0x38, "Digit9": 0x39,

	// Editing and navigation.
	"Enter": 0x0D, "Escape": 0x1B, "Backspace": 0x08, "Tab": 0x09, "Space": 0x20,
	"Insert": 0x2D, "Delete": 0x2E, "Home": 0x24, "End": 0x23,
	"PageUp": 0x21, "PageDown": 0x22,
	"ArrowLeft": 0x25, "ArrowUp": 0x26, "ArrowRight": 0x27, "ArrowDown": 0x28,

	// Modifiers. Left and right are distinguished, because an application that
	// treats AltGr differently from Alt is relying on exactly that.
	"ShiftLeft": 0xA0, "ShiftRight": 0xA1,
	"ControlLeft": 0xA2, "ControlRight": 0xA3,
	"AltLeft": 0xA4, "AltRight": 0xA5,
	"MetaLeft": 0x5B, "MetaRight": 0x5C,
	"CapsLock": 0x14, "NumLock": 0x90, "ScrollLock": 0x91,

	// Function keys.
	"F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73, "F5": 0x74, "F6": 0x75,
	"F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,

	// Punctuation, by position. These are the OEM keys, whose meaning depends on
	// the host layout — which is the behaviour we want.
	"Minus": 0xBD, "Equal": 0xBB, "BracketLeft": 0xDB, "BracketRight": 0xDD,
	"Backslash": 0xDC, "Semicolon": 0xBA, "Quote": 0xDE, "Backquote": 0xC0,
	"Comma": 0xBC, "Period": 0xBE, "Slash": 0xBF,

	// Numeric keypad.
	"Numpad0": 0x60, "Numpad1": 0x61, "Numpad2": 0x62, "Numpad3": 0x63,
	"Numpad4": 0x64, "Numpad5": 0x65, "Numpad6": 0x66, "Numpad7": 0x67,
	"Numpad8": 0x68, "Numpad9": 0x69,
	"NumpadMultiply": 0x6A, "NumpadAdd": 0x6B, "NumpadSubtract": 0x6D,
	"NumpadDecimal": 0x6E, "NumpadDivide": 0x6F, "NumpadEnter": 0x0D,
}

// virtualKey resolves a W3C code to a Windows virtual-key code.
//
// An unmapped code returns false and the caller drops the event. There is no
// fallback: sending an approximately-correct key into somebody's shell is worse
// than sending nothing at all.
func virtualKey(code string) (uint16, bool) {
	vk, ok := virtualKeys[code]
	return vk, ok
}

// MappedKeyCount is used by tests to notice when the table changes, so a key
// cannot be added to what a remote peer may press without someone deciding to.
func MappedKeyCount() int { return len(virtualKeys) }

// IsMappedKey reports whether a code will actually do anything on the host.
func IsMappedKey(code string) bool {
	_, ok := virtualKeys[code]
	return ok
}
