package remote

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/netlink/agent/pkg/remotegrant"
	"github.com/pion/webrtc/v4"
)

/*
An end-to-end test of the real transport.

Two genuine pion peer connections negotiate over loopback and exchange real
data channels. Nothing here is a mock of WebRTC: the offer, the answer, the ICE
candidates, the DTLS handshake and the SCTP association are all real. Only the
signalling *courier* is in-memory, standing in for the control plane's REST
endpoints — which is the one part that carries no media and makes no security
decision.

The point is not that pion works. The point is that the view-only gate holds
across the actual channel a real viewer would use, rather than only in a unit
test that calls HandleInput directly.
*/

// memorySignaller is the in-process stand-in for the control plane's post box.
type memorySignaller struct {
	mu       sync.Mutex
	toHost   []SignalMessage
	toViewer []SignalMessage
	seq      int
}

func (m *memorySignaller) Send(_ context.Context, _, kind, payload string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	m.toViewer = append(m.toViewer, SignalMessage{Seq: m.seq, Kind: kind, Payload: payload})
	return nil
}

func (m *memorySignaller) Receive(_ context.Context, _ string) ([]SignalMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.toHost
	m.toHost = nil
	return out, nil
}

func (m *memorySignaller) viewerSend(kind, payload string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	m.toHost = append(m.toHost, SignalMessage{Seq: m.seq, Kind: kind, Payload: payload})
}

func (m *memorySignaller) viewerReceive() []SignalMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.toViewer
	m.toViewer = nil
	return out
}

// recordingReporter captures what the host told the control plane.
type recordingReporter struct {
	mu         sync.Mutex
	connected  bool
	localType  string
	remoteType string
	violations int
}

func (r *recordingReporter) Connected(_ context.Context, _, local, remote string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.connected = true
	r.localType, r.remoteType = local, remote
	return nil
}

func (r *recordingReporter) Violation(_ context.Context, _ string, count int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.violations += count
	return nil
}

func (r *recordingReporter) Ended(context.Context, string, string) error { return nil }

func (r *recordingReporter) counts() (bool, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connected, r.violations
}

// viewer is the peer that would ordinarily be the desktop app's browser view.
type viewer struct {
	pc     *webrtc.PeerConnection
	frames *webrtc.DataChannel
	input  *webrtc.DataChannel

	mu        sync.Mutex
	gotFrames [][]byte
}

func newViewer(t *testing.T, signals *memorySignaller) *viewer {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("creating the viewer peer connection: %v", err)
	}

	v := &viewer{pc: pc}

	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		raw, err := json.Marshal(candidate.ToJSON())
		if err != nil {
			return
		}
		signals.viewerSend("candidate", string(raw))
	})

	ordered := true
	unreliable := uint16(0)
	v.frames, err = pc.CreateDataChannel(frameChannel, &webrtc.DataChannelInit{
		Ordered:        boolPtr(false),
		MaxRetransmits: &unreliable,
	})
	if err != nil {
		t.Fatalf("creating the frame channel: %v", err)
	}
	v.frames.OnMessage(func(message webrtc.DataChannelMessage) {
		v.mu.Lock()
		defer v.mu.Unlock()
		payload := make([]byte, len(message.Data))
		copy(payload, message.Data)
		v.gotFrames = append(v.gotFrames, payload)
	})

	v.input, err = pc.CreateDataChannel(inputChannel, &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		t.Fatalf("creating the input channel: %v", err)
	}

	return v
}

func boolPtr(b bool) *bool { return &b }

// connect drives the viewer through offer, answer and candidates.
func (v *viewer) connect(t *testing.T, signals *memorySignaller) {
	t.Helper()

	offer, err := v.pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("creating the offer: %v", err)
	}
	if err := v.pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("applying the offer: %v", err)
	}
	raw, err := json.Marshal(offer)
	if err != nil {
		t.Fatalf("marshalling the offer: %v", err)
	}
	signals.viewerSend("offer", string(raw))

	deadline := time.After(30 * time.Second)
	answered := false

	for {
		select {
		case <-deadline:
			t.Fatalf("the peers did not connect (state = %s)", v.pc.ConnectionState())
		default:
		}

		for _, message := range signals.viewerReceive() {
			switch message.Kind {
			case "answer":
				var answer webrtc.SessionDescription
				if err := json.Unmarshal([]byte(message.Payload), &answer); err != nil {
					t.Fatalf("reading the answer: %v", err)
				}
				if err := v.pc.SetRemoteDescription(answer); err != nil {
					t.Fatalf("applying the answer: %v", err)
				}
				answered = true
			case "candidate":
				if !answered {
					continue
				}
				var candidate webrtc.ICECandidateInit
				if err := json.Unmarshal([]byte(message.Payload), &candidate); err != nil {
					continue
				}
				_ = v.pc.AddICECandidate(candidate)
			}
		}

		if v.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (v *viewer) frameCount() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.gotFrames)
}

func (v *viewer) firstFrame() []byte {
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.gotFrames) == 0 {
		return nil
	}
	return v.gotFrames[0]
}

// runSession stands up a host and a viewer and connects them for real.
func runSession(t *testing.T, mode remotegrant.Mode) (*viewer, *recorder, *recordingReporter, func()) {
	t.Helper()

	signals := &memorySignaller{}
	reporter := &recordingReporter{}
	rec := &recorder{}

	capturer, err := NewCapturer()
	if err != nil {
		t.Skipf("no capturer on this platform: %v", err)
	}

	session := NewSession(
		remotegrant.Grant{SessionID: "session-1", SpaceID: "space-1", AgentID: "agent-1", Mode: mode},
		rec,
	)

	host := NewHost(HostOptions{
		Session:   session,
		Capturer:  capturer,
		Quality:   Quality{JPEGQuality: 40, MaxFPS: 30, MaxWidth: 320},
		Signaller: signals,
		Reporter:  reporter,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)

	hostDone := make(chan error, 1)
	go func() { hostDone <- host.Run(ctx) }()

	v := newViewer(t, signals)
	v.connect(t, signals)

	// Idempotent: a test that closes the session early to assert on what was
	// reported at shutdown still has its deferred cleanup run, and a second
	// call must not block waiting for a shutdown that already happened.
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			host.Close()
			_ = v.pc.Close()
			_ = capturer.Close()
			cancel()
			select {
			case <-hostDone:
			case <-time.After(10 * time.Second):
				t.Error("the host did not shut down")
			}
		})
	}

	return v, rec, reporter, cleanup
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A real connection, real frames, over a real peer connection.
func TestScreenFramesArriveOverARealPeerConnection(t *testing.T) {
	v, _, reporter, cleanup := runSession(t, remotegrant.ModeView)
	defer cleanup()

	waitFor(t, "frames to arrive", func() bool { return v.frameCount() > 0 })

	frame, err := DecodeFrame(v.firstFrame())
	if err != nil {
		t.Fatalf("decoding a frame off the wire: %v", err)
	}
	if frame.Width <= 0 || frame.Height <= 0 {
		t.Fatalf("frame is %dx%d", frame.Width, frame.Height)
	}
	if len(frame.JPEG) < 2 || frame.JPEG[0] != 0xFF || frame.JPEG[1] != 0xD8 {
		t.Fatal("the frame payload is not a JPEG")
	}

	connected, _ := reporter.counts()
	if !connected {
		t.Fatal("the host did not report the connection to the control plane")
	}
}

/*
The claim, proven over the wire rather than in isolation.

A view-only viewer sends genuine input on a genuine data channel — the exact
bytes a modified client would send — and nothing reaches the machine.
*/
func TestAViewOnlyPeerCannotDriveTheMachineOverTheDataChannel(t *testing.T) {
	v, rec, reporter, cleanup := runSession(t, remotegrant.ModeView)
	defer cleanup()

	waitFor(t, "the input channel to open", func() bool {
		return v.input.ReadyState() == webrtc.DataChannelStateOpen
	})

	attempts := []Event{
		{Kind: KindMouseMove, X: 0.5, Y: 0.5},
		{Kind: KindMouseDown, X: 0.5, Y: 0.5, Button: ButtonLeft},
		{Kind: KindKeyDown, Code: "MetaLeft"},
		{Kind: KindKeyDown, Code: "KeyR"},
	}
	for _, ev := range attempts {
		raw, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("marshalling: %v", err)
		}
		if err := v.input.Send(raw); err != nil {
			t.Fatalf("sending input: %v", err)
		}
	}

	// Give the host every chance to act on them.
	time.Sleep(500 * time.Millisecond)

	if rec.touched() {
		t.Fatalf("a view-only peer moved the machine over the data channel: %+v", rec)
	}

	// Frames still flow — view-only means view, not disconnected.
	waitFor(t, "frames to keep arriving", func() bool { return v.frameCount() > 0 })

	cleanup()
	if _, violations := reporter.counts(); violations < len(attempts) {
		t.Fatalf("violations reported = %d, want at least %d", violations, len(attempts))
	}
}

// The other half: a control session really does drive the machine.
func TestAControlPeerDrivesTheMachineOverTheDataChannel(t *testing.T) {
	v, rec, _, cleanup := runSession(t, remotegrant.ModeControl)
	defer cleanup()

	waitFor(t, "the input channel to open", func() bool {
		return v.input.ReadyState() == webrtc.DataChannelStateOpen
	})

	raw, err := json.Marshal(Event{Kind: KindMouseMove, X: 0.4, Y: 0.6})
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	if err := v.input.Send(raw); err != nil {
		t.Fatalf("sending input: %v", err)
	}

	waitFor(t, "the pointer to move", func() bool { return len(rec.moves) > 0 })
	if rec.moves[0] != [2]float64{0.4, 0.6} {
		t.Fatalf("moved to %v, want (0.4, 0.6)", rec.moves[0])
	}
}

// A channel NetLink did not open is closed rather than served.
func TestAnUnexpectedDataChannelIsClosed(t *testing.T) {
	signals := &memorySignaller{}
	rec := &recorder{}
	capturer, err := NewCapturer()
	if err != nil {
		t.Skipf("no capturer on this platform: %v", err)
	}
	defer capturer.Close()

	host := NewHost(HostOptions{
		Session: NewSession(
			remotegrant.Grant{SessionID: "s", SpaceID: "sp", Mode: remotegrant.ModeControl},
			rec,
		),
		Capturer:  capturer,
		Quality:   QualityFor("low"),
		Signaller: signals,
		Reporter:  &recordingReporter{},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()

	v := newViewer(t, signals)
	defer v.pc.Close()

	extra, err := v.pc.CreateDataChannel("filesystem", nil)
	if err != nil {
		t.Fatalf("creating the extra channel: %v", err)
	}
	closed := make(chan struct{})
	extra.OnClose(func() { close(closed) })

	v.connect(t, signals)

	select {
	case <-closed:
	case <-time.After(15 * time.Second):
		t.Fatal("an unrecognised data channel was left open")
	}

	host.Close()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Error("the host did not shut down")
	}
}

func TestTheHostGivesUpWhenNoOfferArrives(t *testing.T) {
	capturer, err := NewCapturer()
	if err != nil {
		t.Skipf("no capturer on this platform: %v", err)
	}
	defer capturer.Close()

	host := NewHost(HostOptions{
		Session: NewSession(
			remotegrant.Grant{SessionID: "s", SpaceID: "sp", Mode: remotegrant.ModeView},
			&recorder{},
		),
		Capturer:  capturer,
		Quality:   QualityFor("low"),
		Signaller: &memorySignaller{},
		Reporter:  &recordingReporter{},
	})

	// A short deadline rather than the full 45 seconds: the behaviour under
	// test is that it stops, not how long it waits.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err = host.Run(ctx)
	if err == nil {
		t.Fatal("the host waited forever for an offer that never came")
	}
	if !errors.Is(err, context.DeadlineExceeded) && err.Error() == "" {
		t.Fatalf("unexpected error: %v", err)
	}
}
