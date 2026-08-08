package remote

import (
	"errors"
	"sync"
	"time"

	"github.com/netlink/agent/pkg/remotegrant"
)

// ErrViewOnly is returned when input arrives on a session that was granted as
// view-only.
//
// This is the entire point of the package. It should never happen with the
// client we ship, which is exactly why it is worth counting and reporting: an
// occurrence means someone is running something else.
var ErrViewOnly = errors.New("netlink: this session is view-only")

// ErrRateLimited is returned when a peer sends input faster than any human
// could generate it. Not a security boundary on its own — a bounded flood is
// still a flood — but it keeps one misbehaving peer from saturating the input
// queue of the machine somebody is sitting at.
var ErrRateLimited = errors.New("netlink: too many input events")

// eventsPerSecond mirrors INPUT_EVENTS_PER_SECOND in the contracts package.
const eventsPerSecond = 200

// Session is one live remote desktop session on the host.
//
// It holds the verified grant, and everything that could move the mouse goes
// through it.
type Session struct {
	grant    remotegrant.Grant
	injector Injector

	mu       sync.Mutex
	applied  int
	refused  int
	window   time.Time
	inWindow int
	now      func() time.Time
}

// NewSession returns a session bound to an already-verified grant.
//
// It takes the grant rather than an envelope on purpose: there is no path into
// this type that skips verification, because there is no verification here to
// skip. The caller has to have gone through remotegrant.Verifier first.
func NewSession(grant remotegrant.Grant, injector Injector) *Session {
	return &Session{grant: grant, injector: injector, now: time.Now}
}

// SessionID identifies the session to the control plane.
func (s *Session) SessionID() string { return s.grant.SessionID }

// Mode is the mode the control plane signed.
func (s *Session) Mode() remotegrant.Mode { return s.grant.Mode }

// SpaceID the session belongs to.
func (s *Session) SpaceID() string { return s.grant.SpaceID }

// HandleInput validates an event and applies it, or refuses it.
//
// The order matters. The mode is checked *first* — before parsing, before rate
// limiting — so a view-only session is refused without the event ever being
// interpreted, and a malformed event on a view-only session is reported as what
// it actually is: an attempt to send input where none is allowed.
func (s *Session) HandleInput(raw []byte) error {
	if !s.grant.Mode.AllowsInput() {
		s.mu.Lock()
		s.refused++
		s.mu.Unlock()
		return ErrViewOnly
	}

	if !s.allow() {
		return ErrRateLimited
	}

	ev, err := DecodeEvent(raw)
	if err != nil {
		return err
	}

	if err := Apply(s.injector, ev); err != nil {
		return err
	}

	s.mu.Lock()
	s.applied++
	s.mu.Unlock()
	return nil
}

// allow is a one-second fixed-window counter. A sliding window would be more
// precise, and the imprecision here does not matter: the purpose is to bound a
// flood, not to police the exact rate of a human hand.
func (s *Session) allow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if now.Sub(s.window) >= time.Second {
		s.window = now
		s.inWindow = 0
	}
	if s.inWindow >= eventsPerSecond {
		return false
	}
	s.inWindow++
	return true
}

// Stats reports what the session did, for the report sent back to the control
// plane when it ends.
func (s *Session) Stats() (applied, refused int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applied, s.refused
}

// TakeRefused returns the refusal count and resets it, so repeated reports do
// not double-count the same violations.
func (s *Session) TakeRefused() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.refused
	s.refused = 0
	return n
}
