package agent

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/netlink/agent/internal/client"
	"github.com/netlink/agent/internal/remote"
	"github.com/netlink/agent/pkg/remotegrant"
	"github.com/pion/webrtc/v4"
)

/*
Hosting remote desktop sessions.

The agent polls for signed grants on the same signed channel it uses for power
commands. A grant that verifies becomes a session; a grant that does not is
discarded with a reason.

Nothing in a grant is treated as true before it verifies. In particular the mode
— view or control — is read only out of the verified struct, never off the wire,
because that single field is the difference between someone watching a screen
and someone typing on it.
*/

// remoteSignaller adapts the API client to what the peer connection needs.
type remoteSignaller struct{ client *client.Client }

func (s remoteSignaller) Send(ctx context.Context, sessionID, kind, payload string) error {
	return s.client.SendRemoteSignal(ctx, sessionID, kind, payload)
}

func (s remoteSignaller) Receive(ctx context.Context, sessionID string) ([]remote.SignalMessage, error) {
	signals, err := s.client.CollectRemoteSignals(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	out := make([]remote.SignalMessage, 0, len(signals))
	for _, signal := range signals {
		out = append(out, remote.SignalMessage{Seq: signal.Seq, Kind: signal.Kind, Payload: signal.Payload})
	}
	return out, nil
}

// remoteReporter adapts the API client to what the peer connection reports.
type remoteReporter struct{ client *client.Client }

func (r remoteReporter) Connected(ctx context.Context, sessionID, local, remoteType string) error {
	return r.client.ReportRemoteConnected(ctx, sessionID, local, remoteType)
}

func (r remoteReporter) Violation(ctx context.Context, sessionID string, count int) error {
	return r.client.ReportRemoteViolation(ctx, sessionID, count)
}

func (r remoteReporter) Ended(context.Context, string, string) error { return nil }

// sessions tracks what is running, so a grant collected twice does not start a
// second peer connection for the same session.
type sessions struct {
	mu     sync.Mutex
	active map[string]*remote.Host
}

func newSessions() *sessions { return &sessions{active: map[string]*remote.Host{}} }

func (s *sessions) claim(id string, host *remote.Host) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, running := s.active[id]; running {
		return false
	}
	s.active[id] = host
	return true
}

func (s *sessions) release(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.active, id)
}

func (s *sessions) closeAll() {
	s.mu.Lock()
	hosts := make([]*remote.Host, 0, len(s.active))
	for _, host := range s.active {
		hosts = append(hosts, host)
	}
	s.active = map[string]*remote.Host{}
	s.mu.Unlock()

	for _, host := range hosts {
		host.Close()
	}
}

// pollRemote collects grants and starts a session for each one that verifies.
func (a *Agent) pollRemote(ctx context.Context) {
	current := a.Enrollment()
	if current == nil {
		return
	}

	if current.AgentID == "" {
		// Enrolled before the control plane returned an agent id. The next
		// heartbeat fills it in; until then there is nothing a grant could be
		// checked against.
		return
	}

	a.mu.Lock()
	verifier := a.remoteVerifier
	a.mu.Unlock()

	if verifier == nil {
		// The signing key is fetched alongside the power one; without it every
		// grant is refused, which is the correct failure. Retry rather than
		// give up — the control plane may have been unreachable at startup.
		a.loadSigningKey(ctx)
		return
	}

	pollCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	envelopes, err := a.client.CollectRemoteGrants(pollCtx)
	if err != nil {
		if errors.Is(err, client.ErrRejected) {
			a.forgetIdentity("the control plane rejected this device")
		}
		return
	}

	for _, raw := range envelopes {
		a.startRemoteSession(ctx, verifier, raw)
	}
}

func (a *Agent) startRemoteSession(
	ctx context.Context,
	verifier *remotegrant.Verifier,
	raw json.RawMessage,
) {
	envelope, err := remotegrant.UnmarshalEnvelope(raw)
	if err != nil {
		a.log.Warn("discarding a malformed session grant", "error", err)
		return
	}

	grant, err := verifier.Verify(envelope)
	if err != nil {
		// A replayed grant is the ordinary case, not an alarm: the agent polls
		// faster than a session takes to establish, so it will see the same
		// grant again while the first one is still connecting.
		if errors.Is(err, remotegrant.ErrReplayed) {
			return
		}
		a.log.Warn("refused a session grant",
			"session", envelope.Grant.SessionID,
			"reason", err.Error(),
		)
		return
	}

	capturer, err := remote.NewCapturer()
	if err != nil {
		a.log.Error("cannot capture the screen for a remote session", "error", err)
		return
	}

	host := remote.NewHost(remote.HostOptions{
		Session:   remote.NewSession(grant, remote.NewInjector()),
		Capturer:  capturer,
		Quality:   remote.QualityFor("balanced"),
		Signaller: remoteSignaller{client: a.client},
		Reporter:  remoteReporter{client: a.client},
		// The viewer supplies its own ICE servers from the control plane. The
		// host does not need TURN credentials of its own: it answers, and the
		// relay candidate the viewer offers is enough to establish the pair.
		IceServers: []webrtc.ICEServer{},
		Logger:     a.log,
	})

	if !a.remoteSessions.claim(grant.SessionID, host) {
		_ = capturer.Close()
		return
	}

	a.log.Info("remote session starting",
		"session", grant.SessionID,
		"mode", string(grant.Mode),
	)

	go func() {
		defer a.remoteSessions.release(grant.SessionID)
		defer capturer.Close()

		if err := host.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			a.log.Warn("remote session ended", "session", grant.SessionID, "error", err)
			return
		}
		a.log.Info("remote session ended", "session", grant.SessionID)
	}()
}
