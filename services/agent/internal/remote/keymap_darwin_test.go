//go:build darwin

package remote

import "testing"

func TestTheMacKeyTableCoversWhatPeopleActuallyPress(t *testing.T) {
	required := []string{
		"KeyA", "KeyZ", "Digit0", "Digit9",
		"Enter", "Escape", "Backspace", "Tab", "Space", "Delete",
		"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
		"ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft",
		"F1", "F12", "Home", "End", "PageUp", "PageDown",
	}
	for _, code := range required {
		if !IsMappedKeyDarwin(code) {
			t.Errorf("%s is not in the macOS key table", code)
		}
	}
}

/*
The two tables are genuinely different numbers for the same keys.

macOS virtual key codes come from the Apple Extended Keyboard layout and have
no relationship to Windows VK codes. This test exists because the tempting
mistake — reusing one table for both — produces an app that types apparent
nonsense on the other platform, which is a confusing bug to chase.
*/
func TestMacCodesAreNotWindowsCodes(t *testing.T) {
	macA, ok := macVirtualKey("KeyA")
	if !ok {
		t.Fatal("KeyA is missing from the macOS table")
	}
	if macA == 0x41 {
		t.Fatal("KeyA maps to the Windows virtual key code — the wrong table is in use")
	}
	if macA != 0x00 {
		t.Fatalf("KeyA = %#x, want 0x00", macA)
	}
}

func TestUnmappedMacKeysAreNotApproximated(t *testing.T) {
	for _, code := range []string{"Fn", "Power", "KeyÄ", "", "ScrollLock"} {
		if IsMappedKeyDarwin(code) {
			t.Errorf("%q is mapped but nobody chose to map it", code)
		}
	}
}

// Both platforms must agree on which keys exist, or a viewer's key works on one
// host and silently does nothing on the other.
func TestBothPlatformTablesCoverTheSameCommonKeys(t *testing.T) {
	shared := []string{
		"KeyA", "KeyM", "Digit5", "Enter", "Escape", "Tab", "Space",
		"ArrowUp", "ShiftLeft", "ControlLeft", "MetaLeft", "F5",
		"Minus", "Equal", "Comma", "Period", "Slash", "Numpad0",
	}
	for _, code := range shared {
		if IsMappedKey(code) != IsMappedKeyDarwin(code) {
			t.Errorf(
				"%s: Windows=%v macOS=%v — a key that works on one host and not the other",
				code, IsMappedKey(code), IsMappedKeyDarwin(code),
			)
		}
	}
}
