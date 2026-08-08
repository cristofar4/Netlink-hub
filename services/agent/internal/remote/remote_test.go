package remote

import (
	"encoding/json"
	"errors"
	"image"
	"testing"
	"time"

	"github.com/netlink/agent/pkg/remotegrant"
)

// recorder stands in for the platform injector so the gate can be proven
// without a real pointer to move.
type recorder struct {
	moves   []([2]float64)
	buttons []string
	keys    []string
	wheels  []float64
}

func (r *recorder) MouseMove(x, y float64) error {
	r.moves = append(r.moves, [2]float64{x, y})
	return nil
}

func (r *recorder) MouseButton(button Button, down bool, x, y float64) error {
	state := "up"
	if down {
		state = "down"
	}
	r.buttons = append(r.buttons, string(button)+":"+state)
	r.moves = append(r.moves, [2]float64{x, y})
	return nil
}

func (r *recorder) MouseWheel(deltaY float64) error {
	r.wheels = append(r.wheels, deltaY)
	return nil
}

func (r *recorder) Key(code string, down bool) error {
	state := "up"
	if down {
		state = "down"
	}
	r.keys = append(r.keys, code+":"+state)
	return nil
}

func (r *recorder) touched() bool {
	return len(r.moves) > 0 || len(r.buttons) > 0 || len(r.keys) > 0 || len(r.wheels) > 0
}

func session(t *testing.T, mode remotegrant.Mode) (*Session, *recorder) {
	t.Helper()
	rec := &recorder{}
	s := NewSession(remotegrant.Grant{SessionID: "s-1", SpaceID: "sp-1", Mode: mode}, rec)
	return s, rec
}

func event(t *testing.T, ev Event) []byte {
	t.Helper()
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshalling an event: %v", err)
	}
	return raw
}

// ---------------------------------------------------------------------------
// The view-only boundary
// ---------------------------------------------------------------------------

/*
This is the test the whole package exists for.

A view-only session is not "a session where the buttons are hidden". It is a
session where the machine being watched refuses to act on anything it is sent,
regardless of what the peer believes it is entitled to.
*/
func TestAViewOnlySessionRefusesEveryKindOfInput(t *testing.T) {
	events := []Event{
		{Kind: KindMouseMove, X: 0.5, Y: 0.5},
		{Kind: KindMouseDown, X: 0.5, Y: 0.5, Button: ButtonLeft},
		{Kind: KindMouseUp, X: 0.5, Y: 0.5, Button: ButtonLeft},
		{Kind: KindMouseWheel, X: 0.5, Y: 0.5, DeltaY: 3},
		{Kind: KindKeyDown, Code: "KeyA"},
		{Kind: KindKeyUp, Code: "KeyA"},
	}

	for _, ev := range events {
		t.Run(string(ev.Kind), func(t *testing.T) {
			s, rec := session(t, remotegrant.ModeView)

			if err := s.HandleInput(event(t, ev)); !errors.Is(err, ErrViewOnly) {
				t.Fatalf("err = %v, want ErrViewOnly", err)
			}
			if rec.touched() {
				t.Fatalf("a view-only session reached the machine: %+v", rec)
			}
		})
	}
}

func TestAControlSessionAppliesInput(t *testing.T) {
	s, rec := session(t, remotegrant.ModeControl)

	if err := s.HandleInput(event(t, Event{Kind: KindMouseMove, X: 0.25, Y: 0.75})); err != nil {
		t.Fatalf("a control session refused a legitimate move: %v", err)
	}
	if len(rec.moves) != 1 || rec.moves[0] != [2]float64{0.25, 0.75} {
		t.Fatalf("moves = %+v, want one move to (0.25, 0.75)", rec.moves)
	}
}

// A refusal must be counted even when the payload is nonsense, because the
// thing worth recording is that input arrived at all.
func TestRefusalsAreCountedEvenForMalformedInput(t *testing.T) {
	s, rec := session(t, remotegrant.ModeView)

	for i := 0; i < 3; i++ {
		if err := s.HandleInput([]byte("{not json")); !errors.Is(err, ErrViewOnly) {
			t.Fatalf("err = %v, want ErrViewOnly", err)
		}
	}
	if rec.touched() {
		t.Fatal("malformed input on a view-only session reached the machine")
	}

	if _, refused := s.Stats(); refused != 3 {
		t.Fatalf("refused = %d, want 3", refused)
	}
	if n := s.TakeRefused(); n != 3 {
		t.Fatalf("TakeRefused = %d, want 3", n)
	}
	if n := s.TakeRefused(); n != 0 {
		t.Fatalf("TakeRefused after draining = %d, want 0 — violations would be double-counted", n)
	}
}

// The mode comes from the verified grant. There is no setter, and this test
// exists so that stays true.
func TestModeComesFromTheGrant(t *testing.T) {
	s, _ := session(t, remotegrant.ModeView)
	if s.Mode() != remotegrant.ModeView {
		t.Fatalf("mode = %q, want view", s.Mode())
	}
	if s.SessionID() != "s-1" || s.SpaceID() != "sp-1" {
		t.Fatal("the session did not carry its grant's identifiers")
	}
}

func TestAnUnknownModeBehavesAsViewOnly(t *testing.T) {
	rec := &recorder{}
	s := NewSession(remotegrant.Grant{SessionID: "s-1", Mode: "superuser"}, rec)

	if err := s.HandleInput(event(t, Event{Kind: KindKeyDown, Code: "KeyA"})); !errors.Is(err, ErrViewOnly) {
		t.Fatalf("err = %v, want ErrViewOnly", err)
	}
	if rec.touched() {
		t.Fatal("an unrecognised mode was treated as permission to type")
	}
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

func TestCoordinatesAreClampedIntoRange(t *testing.T) {
	cases := []struct {
		name  string
		x, y  float64
		wantX float64
		wantY float64
	}{
		{"negative", -5, -0.2, 0, 0},
		{"beyond one", 4, 1.5, 1, 1},
		{"in range", 0.3, 0.6, 0.3, 0.6},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, rec := session(t, remotegrant.ModeControl)
			if err := s.HandleInput(event(t, Event{Kind: KindMouseMove, X: tc.x, Y: tc.y})); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got := rec.moves[0]
			if got[0] != tc.wantX || got[1] != tc.wantY {
				t.Fatalf("moved to %v, want (%v, %v)", got, tc.wantX, tc.wantY)
			}
		})
	}
}

func TestAnUnknownEventKindIsRefused(t *testing.T) {
	s, rec := session(t, remotegrant.ModeControl)

	if err := s.HandleInput([]byte(`{"kind":"shell.exec","command":"whoami"}`)); !errors.Is(err, ErrUnknownKind) {
		t.Fatalf("err = %v, want ErrUnknownKind", err)
	}
	if rec.touched() {
		t.Fatal("an unrecognised event kind did something")
	}
}

func TestAClickWithNoButtonIsRefusedRatherThanAssumedLeft(t *testing.T) {
	s, rec := session(t, remotegrant.ModeControl)

	if err := s.HandleInput([]byte(`{"kind":"mouse.down","x":0.5,"y":0.5}`)); !errors.Is(err, ErrUnknownButton) {
		t.Fatalf("err = %v, want ErrUnknownButton", err)
	}
	if len(rec.buttons) != 0 {
		t.Fatalf("a button-less press clicked %v", rec.buttons)
	}
}

func TestAnUnknownButtonIsRefused(t *testing.T) {
	s, _ := session(t, remotegrant.ModeControl)
	if err := s.HandleInput([]byte(`{"kind":"mouse.up","x":0.1,"y":0.1,"button":"back"}`)); !errors.Is(err, ErrUnknownButton) {
		t.Fatalf("err = %v, want ErrUnknownButton", err)
	}
}

func TestKeyCodesOutsideThePatternAreRefused(t *testing.T) {
	bad := []string{
		"",
		"Key A",
		"Key-A",
		"../../etc/passwd",
		"Key\x00A",
		"AVeryLongKeyCodeThatNobodyWouldEverSendLegitimately",
		`{"nested":"json"}`,
	}

	for _, code := range bad {
		s, rec := session(t, remotegrant.ModeControl)
		err := s.HandleInput(event(t, Event{Kind: KindKeyDown, Code: code}))
		if !errors.Is(err, ErrBadKeyCode) {
			t.Fatalf("code %q: err = %v, want ErrBadKeyCode", code, err)
		}
		if rec.touched() {
			t.Fatalf("code %q reached the machine", code)
		}
	}
}

func TestAWheelDeltaIsBounded(t *testing.T) {
	s, rec := session(t, remotegrant.ModeControl)

	if err := s.HandleInput(event(t, Event{Kind: KindMouseWheel, DeltaY: 100_000})); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.wheels[0] != 10 {
		t.Fatalf("wheel delta = %v, want it clamped to 10", rec.wheels[0])
	}
}

func TestAKeyEventCannotCarryCoordinates(t *testing.T) {
	// A key event with coordinates attached should not move the pointer as a
	// side effect: one event, one action.
	s, rec := session(t, remotegrant.ModeControl)

	if err := s.HandleInput([]byte(`{"kind":"key.down","code":"KeyA","x":0.9,"y":0.9}`)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rec.moves) != 0 {
		t.Fatalf("a key press also moved the pointer to %v", rec.moves)
	}
	if len(rec.keys) != 1 || rec.keys[0] != "KeyA:down" {
		t.Fatalf("keys = %v", rec.keys)
	}
}

func TestInputIsRateLimited(t *testing.T) {
	s, _ := session(t, remotegrant.ModeControl)
	frozen := time.Now()
	s.now = func() time.Time { return frozen }

	raw := event(t, Event{Kind: KindMouseMove, X: 0.5, Y: 0.5})
	for i := 0; i < eventsPerSecond; i++ {
		if err := s.HandleInput(raw); err != nil {
			t.Fatalf("event %d was refused early: %v", i, err)
		}
	}
	if err := s.HandleInput(raw); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}

	// A new second is a new budget.
	s.now = func() time.Time { return frozen.Add(1100 * time.Millisecond) }
	if err := s.HandleInput(raw); err != nil {
		t.Fatalf("the window did not reset: %v", err)
	}
}

// ---------------------------------------------------------------------------
// The key table
// ---------------------------------------------------------------------------

func TestTheKeyTableCoversWhatPeopleActuallyPress(t *testing.T) {
	required := []string{
		"KeyA", "KeyZ", "Digit0", "Digit9",
		"Enter", "Escape", "Backspace", "Tab", "Space", "Delete",
		"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
		"ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft",
		"F1", "F12", "Home", "End", "PageUp", "PageDown",
	}
	for _, code := range required {
		if !IsMappedKey(code) {
			t.Fatalf("%s is not in the key table", code)
		}
	}
}

func TestUnmappedKeysAreNotSilentlyApproximated(t *testing.T) {
	if IsMappedKey("KeyÄ") || IsMappedKey("Fn") || IsMappedKey("Power") {
		t.Fatal("a key nobody chose to map is mapped")
	}
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

func TestAFrameSurvivesTheWireFormat(t *testing.T) {
	frame := Frame{Seq: 42, Width: 1600, Height: 900, At: 1234, JPEG: []byte{0xFF, 0xD8, 0xFF, 0x01}}

	got, err := DecodeFrame(EncodeFrame(frame))
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if got.Seq != 42 || got.Width != 1600 || got.Height != 900 || got.At != 1234 {
		t.Fatalf("header did not round-trip: %+v", got)
	}
	if string(got.JPEG) != string(frame.JPEG) {
		t.Fatalf("payload did not round-trip: %v", got.JPEG)
	}
}

func TestATruncatedFrameIsRefused(t *testing.T) {
	if _, err := DecodeFrame([]byte{1, 2, 3}); err == nil {
		t.Fatal("a frame shorter than its own header was accepted")
	}
}

func TestEncodingProducesAJpegAtTheRequestedSize(t *testing.T) {
	encoder := NewEncoder(QualityFor("balanced"))
	source := image.NewRGBA(image.Rect(0, 0, 3200, 1800))

	frame, err := encoder.Encode(source)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	if frame.Width != 1600 {
		t.Fatalf("width = %d, want the balanced cap of 1600", frame.Width)
	}
	if frame.Height != 900 {
		t.Fatalf("height = %d, want the aspect ratio preserved", frame.Height)
	}
	if len(frame.JPEG) < 2 || frame.JPEG[0] != 0xFF || frame.JPEG[1] != 0xD8 {
		t.Fatal("the payload is not a JPEG")
	}
}

// Each frame must own its bytes; the encoder reuses its buffer, and a frame
// still in flight must not be rewritten by the next one.
func TestFramesDoNotShareABuffer(t *testing.T) {
	encoder := NewEncoder(QualityFor("low"))

	first, err := encoder.Encode(image.NewRGBA(image.Rect(0, 0, 64, 64)))
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	before := string(first.JPEG)

	filled := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for i := range filled.Pix {
		filled.Pix[i] = byte(i)
	}
	if _, err := encoder.Encode(filled); err != nil {
		t.Fatalf("encoding: %v", err)
	}

	if string(first.JPEG) != before {
		t.Fatal("encoding a second frame rewrote the first")
	}
}

func TestTheFrameRateIsBounded(t *testing.T) {
	encoder := NewEncoder(Quality{JPEGQuality: 50, MaxFPS: 10, MaxWidth: 640})
	frozen := time.Now()
	encoder.now = func() time.Time { return frozen }

	if !encoder.Due() {
		t.Fatal("the first frame should be due immediately")
	}
	if _, err := encoder.Encode(image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatalf("encoding: %v", err)
	}
	if encoder.Due() {
		t.Fatal("a second frame was due in the same instant")
	}

	encoder.now = func() time.Time { return frozen.Add(101 * time.Millisecond) }
	if !encoder.Due() {
		t.Fatal("a frame was not due after the interval elapsed")
	}
}

func TestQualitySettingsMatchTheContract(t *testing.T) {
	// These three must agree with FRAME_QUALITY_SETTINGS in packages/contracts,
	// so the viewer's "Balanced" and the host's "balanced" are the same thing.
	cases := map[string]Quality{
		"low":      {JPEGQuality: 45, MaxFPS: 20, MaxWidth: 1280},
		"balanced": {JPEGQuality: 65, MaxFPS: 15, MaxWidth: 1600},
		"sharp":    {JPEGQuality: 82, MaxFPS: 10, MaxWidth: 1920},
	}
	for name, want := range cases {
		if got := QualityFor(name); got != want {
			t.Fatalf("%s = %+v, want %+v", name, got, want)
		}
	}
	if QualityFor("nonsense") != cases["balanced"] {
		t.Fatal("an unknown quality did not fall back to balanced")
	}
}

func TestTheCapturerProducesChangingImages(t *testing.T) {
	capturer, err := NewCapturer()
	if err != nil {
		t.Skipf("no capturer on this platform: %v", err)
	}
	defer capturer.Close()

	width, height, err := capturer.Bounds()
	if err != nil || width <= 0 || height <= 0 {
		t.Fatalf("bounds = %dx%d, err = %v", width, height, err)
	}

	first, err := capturer.Capture()
	if err != nil {
		t.Fatalf("capturing: %v", err)
	}
	if first.Bounds().Dx() <= 0 {
		t.Fatal("the capture is empty")
	}
}

// ---------------------------------------------------------------------------
// The refusal that ties the two halves together
// ---------------------------------------------------------------------------

/*
A summary test, deliberately written as the claim NetLink makes to a user.

If someone is given a view-only pass, nothing they send moves anything on the
computer they are watching — not by sending a different event kind, not by
sending malformed data, not by flooding, and not by editing their own copy of
the session mode, because the mode they hold is signed and the one used here
came out of that verification.
*/
func TestNothingAViewOnlyPeerSendsCanReachTheMachine(t *testing.T) {
	s, rec := session(t, remotegrant.ModeView)

	attempts := [][]byte{
		event(t, Event{Kind: KindMouseMove, X: 0.5, Y: 0.5}),
		event(t, Event{Kind: KindMouseDown, X: 0, Y: 0, Button: ButtonRight}),
		event(t, Event{Kind: KindKeyDown, Code: "MetaLeft"}),
		event(t, Event{Kind: KindKeyDown, Code: "KeyR"}),
		event(t, Event{Kind: KindMouseWheel, DeltaY: -8}),
		[]byte(`{"kind":"mouse.move","x":1e308,"y":-1e308}`),
		[]byte(`{"kind":"shell.exec","command":"format c:"}`),
		[]byte(`[]`),
		[]byte(``),
		make([]byte, 4096),
	}

	for i, raw := range attempts {
		if err := s.HandleInput(raw); !errors.Is(err, ErrViewOnly) {
			t.Fatalf("attempt %d: err = %v, want ErrViewOnly", i, err)
		}
	}

	if rec.touched() {
		t.Fatalf("a view-only peer reached the machine: %+v", rec)
	}
	if applied, refused := s.Stats(); applied != 0 || refused != len(attempts) {
		t.Fatalf("applied = %d, refused = %d, want 0 and %d", applied, refused, len(attempts))
	}
}
