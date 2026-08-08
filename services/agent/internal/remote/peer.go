package remote

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

/*
The host side of the peer connection.

Two data channels, and the asymmetry between them is deliberate:

  - "frames" is unreliable and unordered. A screen frame that arrives late is
    worse than useless — it is a stale picture displayed after a newer one. Let
    it drop.
  - "input" is reliable and ordered. A dropped key-up leaves a modifier stuck
    down on someone else's machine, and a reordered click lands in the wrong
    place.

Frames go over a data channel rather than a video track because encoding VP8 or
H.264 in pure Go means either a cgo dependency on libvpx — which would end the
"one binary, no runtime" property the agent has — or a pure-Go encoder slow
enough to be worse than JPEG. JPEG over SCTP is genuinely worse for full-motion
video and genuinely fine for a desktop, which is what this is for. The transport
underneath is the same DTLS-encrypted peer connection either way, so nothing
about the security story changes; a video track is an efficiency upgrade, not a
correctness one.
*/

const (
	frameChannel = "frames"
	inputChannel = "input"

	// frameHeaderBytes is the fixed prefix on every frame message: sequence,
	// width, height, elapsed milliseconds. Fixed-width and little-endian so the
	// viewer can read it with a DataView and no negotiation.
	frameHeaderBytes = 4 + 2 + 2 + 4

	// maxFrameBytes bounds a single message. SCTP will fragment, but a frame
	// larger than this means something has gone wrong with capture, and sending
	// it would stall the channel for everything behind it.
	maxFrameBytes = 4 << 20
)

// Signaller carries SDP and ICE between the two peers. Implemented against the
// control plane; stubbed in tests so the peer connection can be exercised
// without a server.
type Signaller interface {
	Send(ctx context.Context, sessionID, kind, payload string) error
	Receive(ctx context.Context, sessionID string) ([]SignalMessage, error)
}

// SignalMessage is one message from the other peer.
type SignalMessage struct {
	Seq     int    `json:"seq"`
	Kind    string `json:"kind"`
	Payload string `json:"payload"`
}

// Reporter tells the control plane what happened. Kept as an interface so the
// peer has no opinion about HTTP.
type Reporter interface {
	Connected(ctx context.Context, sessionID, localType, remoteType string) error
	Violation(ctx context.Context, sessionID string, count int) error
	Ended(ctx context.Context, sessionID, reason string) error
}

// Host runs one session's peer connection.
type Host struct {
	session   *Session
	capturer  Capturer
	encoder   *Encoder
	signaller Signaller
	reporter  Reporter
	ice       []webrtc.ICEServer
	log       *slog.Logger

	mu     sync.Mutex
	pc     *webrtc.PeerConnection
	frames *webrtc.DataChannel
	closed bool
	done   chan struct{}
}

// HostOptions configures a host session.
type HostOptions struct {
	Session    *Session
	Capturer   Capturer
	Quality    Quality
	Signaller  Signaller
	Reporter   Reporter
	IceServers []webrtc.ICEServer
	Logger     *slog.Logger
}

func NewHost(opts HostOptions) *Host {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Host{
		session:   opts.Session,
		capturer:  opts.Capturer,
		encoder:   NewEncoder(opts.Quality),
		signaller: opts.Signaller,
		reporter:  opts.Reporter,
		ice:       opts.IceServers,
		log:       log,
		done:      make(chan struct{}),
	}
}

// Run establishes the connection and serves the session until it ends.
//
// The host is the *answering* side: the viewer makes the offer. That is not
// arbitrary — the viewer is the one that knows when a person clicked Connect,
// and having the machine being watched initiate would mean it starts trying to
// stream before anyone has asked.
func (h *Host) Run(ctx context.Context) error {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: h.ice})
	if err != nil {
		return fmt.Errorf("netlink: could not create a peer connection: %w", err)
	}

	h.mu.Lock()
	h.pc = pc
	h.mu.Unlock()

	defer func() {
		_ = pc.Close()
		h.finish()
	}()

	pc.OnDataChannel(h.onDataChannel)
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		raw, err := json.Marshal(candidate.ToJSON())
		if err != nil {
			return
		}
		if err := h.signaller.Send(ctx, h.session.SessionID(), "candidate", string(raw)); err != nil {
			h.log.Warn("could not send an ICE candidate", "error", err)
		}
	})

	connected := make(chan struct{})
	var once sync.Once
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		h.log.Info("remote session connection state", "session", h.session.SessionID(), "state", state.String())
		switch state {
		case webrtc.PeerConnectionStateConnected:
			once.Do(func() { close(connected) })
		case webrtc.PeerConnectionStateFailed,
			webrtc.PeerConnectionStateClosed,
			webrtc.PeerConnectionStateDisconnected:
			h.finish()
		}
	})

	if err := h.negotiate(ctx, pc); err != nil {
		return err
	}

	select {
	case <-connected:
		local, remote := candidateTypes(pc)
		if err := h.reporter.Connected(ctx, h.session.SessionID(), local, remote); err != nil {
			h.log.Warn("could not report the connection", "error", err)
		}
	case <-time.After(45 * time.Second):
		return errors.New("netlink: the two machines could not connect in time")
	case <-ctx.Done():
		return ctx.Err()
	case <-h.done:
		return nil
	}

	go h.pumpFrames(ctx)
	go h.reportViolations(ctx)

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-h.done:
		return nil
	}
}

/*
negotiate polls the control plane for the viewer's offer, answers it, and keeps
feeding in candidates.

Polling rather than a push subscription: the agent already polls for power
commands and print jobs on the same signed channel, and a second long-lived
transport with its own reconnect and auth story would be more to get wrong for a
negotiation that lasts a few seconds.
*/
func (h *Host) negotiate(ctx context.Context, pc *webrtc.PeerConnection) error {
	deadline := time.Now().Add(45 * time.Second)
	answered := false

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-h.done:
			return nil
		default:
		}

		messages, err := h.signaller.Receive(ctx, h.session.SessionID())
		if err != nil {
			h.log.Warn("could not collect signalling messages", "error", err)
		}

		for _, message := range messages {
			switch message.Kind {
			case "offer":
				if answered {
					continue
				}
				var offer webrtc.SessionDescription
				if err := json.Unmarshal([]byte(message.Payload), &offer); err != nil {
					return fmt.Errorf("netlink: the offer could not be read: %w", err)
				}
				if err := pc.SetRemoteDescription(offer); err != nil {
					return fmt.Errorf("netlink: the offer was refused: %w", err)
				}
				answer, err := pc.CreateAnswer(nil)
				if err != nil {
					return fmt.Errorf("netlink: could not answer: %w", err)
				}
				if err := pc.SetLocalDescription(answer); err != nil {
					return fmt.Errorf("netlink: could not apply the answer: %w", err)
				}
				raw, err := json.Marshal(answer)
				if err != nil {
					return err
				}
				if err := h.signaller.Send(ctx, h.session.SessionID(), "answer", string(raw)); err != nil {
					return fmt.Errorf("netlink: could not send the answer: %w", err)
				}
				answered = true

			case "candidate":
				var candidate webrtc.ICECandidateInit
				if err := json.Unmarshal([]byte(message.Payload), &candidate); err != nil {
					continue
				}
				// A candidate that arrives before the offer has nowhere to go.
				// Dropping it is correct: ICE re-sends, and pion refuses one
				// added without a remote description.
				if !answered {
					continue
				}
				if err := pc.AddICECandidate(candidate); err != nil {
					h.log.Debug("discarded an ICE candidate", "error", err)
				}

			case "bye":
				h.finish()
				return nil
			}
		}

		if answered && pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	if !answered {
		return errors.New("netlink: no offer arrived from the viewer")
	}
	return nil
}

func (h *Host) onDataChannel(channel *webrtc.DataChannel) {
	switch channel.Label() {
	case frameChannel:
		h.mu.Lock()
		h.frames = channel
		h.mu.Unlock()

	case inputChannel:
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			err := h.session.HandleInput(message.Data)
			switch {
			case err == nil:
			case errors.Is(err, ErrViewOnly):
				// Counted on the session and reported periodically rather than
				// logged per event, so a peer spraying input cannot also spray
				// the host's log.
			case errors.Is(err, ErrRateLimited):
			default:
				h.log.Debug("dropped an input event", "error", err)
			}
		})

	default:
		// An unrecognised channel is closed rather than ignored. A peer opening
		// channels we did not ask for is a peer doing something we did not
		// design for.
		_ = channel.Close()
	}
}

// pumpFrames captures, encodes and sends until the session ends.
func (h *Host) pumpFrames(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-h.done:
			return
		case <-ticker.C:
		}

		h.mu.Lock()
		channel := h.frames
		h.mu.Unlock()
		if channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen {
			continue
		}

		if !h.encoder.Due() {
			continue
		}

		img, err := h.capturer.Capture()
		if err != nil {
			h.log.Warn("screen capture failed", "error", err)
			continue
		}

		frame, err := h.encoder.Encode(img)
		if err != nil {
			h.log.Warn("frame encoding failed", "error", err)
			continue
		}

		payload := EncodeFrame(frame)
		if len(payload) > maxFrameBytes {
			h.log.Warn("dropped an oversized frame", "bytes", len(payload))
			continue
		}
		if err := channel.Send(payload); err != nil {
			h.log.Debug("could not send a frame", "error", err)
		}
	}
}

// reportViolations tells the control plane about input refused on a view-only
// session, batched so a flood produces one record a minute rather than
// thousands.
func (h *Host) reportViolations(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-h.done:
			// One last report, so violations in the final seconds are not lost.
			if n := h.session.TakeRefused(); n > 0 {
				_ = h.reporter.Violation(context.WithoutCancel(ctx), h.session.SessionID(), n)
			}
			return
		case <-ticker.C:
			if n := h.session.TakeRefused(); n > 0 {
				if err := h.reporter.Violation(ctx, h.session.SessionID(), n); err != nil {
					h.log.Warn("could not report refused input", "error", err)
				}
			}
		}
	}
}

// Close ends the session.
func (h *Host) Close() {
	h.finish()
	h.mu.Lock()
	pc := h.pc
	h.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

func (h *Host) finish() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	close(h.done)
}

/*
EncodeFrame lays a frame out for the wire: a fixed twelve-byte header followed
by the JPEG.

Fixed-width little-endian rather than JSON, because the viewer reads this in a
hot path with a DataView and parsing a JSON envelope around a megabyte of binary
would mean base64 and a 33% size penalty on every frame.
*/
func EncodeFrame(frame Frame) []byte {
	out := make([]byte, frameHeaderBytes+len(frame.JPEG))
	binary.LittleEndian.PutUint32(out[0:4], uint32(frame.Seq))
	binary.LittleEndian.PutUint16(out[4:6], uint16(frame.Width))
	binary.LittleEndian.PutUint16(out[6:8], uint16(frame.Height))
	binary.LittleEndian.PutUint32(out[8:12], uint32(frame.At))
	copy(out[frameHeaderBytes:], frame.JPEG)
	return out
}

// DecodeFrame reads the layout back. Used by tests and by nothing on the host —
// the viewer that consumes this is the browser.
func DecodeFrame(raw []byte) (Frame, error) {
	if len(raw) < frameHeaderBytes {
		return Frame{}, errors.New("netlink: frame is too short to contain a header")
	}
	jpegBytes := make([]byte, len(raw)-frameHeaderBytes)
	copy(jpegBytes, raw[frameHeaderBytes:])
	return Frame{
		Seq:    int(binary.LittleEndian.Uint32(raw[0:4])),
		Width:  int(binary.LittleEndian.Uint16(raw[4:6])),
		Height: int(binary.LittleEndian.Uint16(raw[6:8])),
		At:     int64(binary.LittleEndian.Uint32(raw[8:12])),
		JPEG:   jpegBytes,
	}, nil
}

/*
candidateTypes reports which kinds of ICE candidate ended up carrying the
session, so the viewer can be told honestly whether its pixels are going direct
or through a relay.

A relayed connection is not a failure — it is what happens behind a symmetric
NAT — but it is slower and it means the traffic takes a detour, and a person
deserves to know that rather than just experiencing it as lag.
*/
func candidateTypes(pc *webrtc.PeerConnection) (string, string) {
	stats := pc.GetStats()
	for _, entry := range stats {
		pair, ok := entry.(webrtc.ICECandidatePairStats)
		if !ok || pair.State != webrtc.StatsICECandidatePairStateSucceeded || !pair.Nominated {
			continue
		}
		local, remote := "", ""
		if candidate, ok := stats[pair.LocalCandidateID].(webrtc.ICECandidateStats); ok {
			local = candidate.CandidateType.String()
		}
		if candidate, ok := stats[pair.RemoteCandidateID].(webrtc.ICECandidateStats); ok {
			remote = candidate.CandidateType.String()
		}
		return local, remote
	}
	return "", ""
}
