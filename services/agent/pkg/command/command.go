// Package command defines the signed envelope every power command travels in.
//
// A power command is the most dangerous thing NetLink can do to a machine, so
// the agent accepts one only when it is: signed by a key the agent trusts,
// addressed to this specific device, still inside its validity window, and
// carrying a nonce this agent has not already seen. Failing any one of those
// is a rejection, not a warning.
//
// The command surface is a fixed list. There is no "run this program" verb, by
// design — arbitrary remote execution is not something NetLink offers.
package command

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Action is one of the fixed power verbs.
type Action string

const (
	ActionWake           Action = "power.wake"
	ActionRestart        Action = "power.restart"
	ActionShutdown       Action = "power.shutdown"
	ActionLock           Action = "power.lock"
	ActionSleep          Action = "power.sleep"
	ActionCancelShutdown Action = "power.cancel"
)

// Actions is the complete allow-list. Anything not in it is refused.
var Actions = []Action{
	ActionWake,
	ActionRestart,
	ActionShutdown,
	ActionLock,
	ActionSleep,
	ActionCancelShutdown,
}

// Valid reports whether a is a recognised action.
func (a Action) Valid() bool {
	for _, known := range Actions {
		if a == known {
			return true
		}
	}
	return false
}

// Destructive actions interrupt whatever the person at the machine is doing,
// so they get a visible countdown that can be cancelled.
func (a Action) Destructive() bool {
	return a == ActionRestart || a == ActionShutdown
}

// CountdownSeconds is how long the machine warns before restarting or shutting
// down, giving anyone sitting at it a chance to cancel.
const CountdownSeconds = 10

// Command is the payload the control plane signs.
//
// Every field is inside the signature. Changing any of them — swapping the
// target device, widening the window, replaying an old nonce — invalidates it.
type Command struct {
	ID        string    `json:"id"`
	Action    Action    `json:"action"`
	DeviceID  string    `json:"deviceId"`
	SpaceID   string    `json:"spaceId"`
	IssuedAt  time.Time `json:"issuedAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	// Nonce is single-use. The agent remembers it for at least the command's
	// lifetime, which is what makes a captured command un-replayable.
	Nonce string `json:"nonce"`
	// RequestedBy is recorded for the audit trail, not used for authorisation —
	// authorisation happened in the control plane before this was signed.
	RequestedBy string `json:"requestedBy"`
}

// Envelope is a command plus its detached signature.
type Envelope struct {
	Command   Command `json:"command"`
	Signature string  `json:"signature"`
	KeyID     string  `json:"keyId"`
}

// TimestampLayout is the exact timestamp format inside a signing input.
//
// Not RFC3339Nano: that strips trailing zeros, so 12:00:00.000 serialises as
// "12:00:00Z" in Go while JavaScript's toISOString always emits three decimal
// places. The control plane signs and the agent verifies, so the two must
// agree byte for byte — which means pinning one explicit layout rather than
// trusting two libraries to make the same choice.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// SigningInput is the exact byte sequence that gets signed.
//
// It is built field by field in a fixed order rather than by marshalling the
// struct, because JSON key order and whitespace are not guaranteed stable —
// and a signature over a representation that can shift is not a signature.
func SigningInput(c Command) []byte {
	var b strings.Builder
	b.WriteString("netlink.power.v1\n")
	b.WriteString(c.ID)
	b.WriteString("\n")
	b.WriteString(string(c.Action))
	b.WriteString("\n")
	b.WriteString(c.DeviceID)
	b.WriteString("\n")
	b.WriteString(c.SpaceID)
	b.WriteString("\n")
	b.WriteString(c.IssuedAt.UTC().Format(TimestampLayout))
	b.WriteString("\n")
	b.WriteString(c.ExpiresAt.UTC().Format(TimestampLayout))
	b.WriteString("\n")
	b.WriteString(c.Nonce)
	b.WriteString("\n")
	b.WriteString(c.RequestedBy)
	return []byte(b.String())
}

// Sign produces an envelope for c.
func Sign(c Command, key ed25519.PrivateKey, keyID string) (Envelope, error) {
	if len(key) != ed25519.PrivateKeySize {
		return Envelope{}, errors.New("netlink: signing key is not a valid Ed25519 private key")
	}
	sig := ed25519.Sign(key, SigningInput(c))
	return Envelope{
		Command:   c,
		Signature: base64.RawURLEncoding.EncodeToString(sig),
		KeyID:     keyID,
	}, nil
}

// Rejection reasons, returned as errors so a caller can tell them apart in an
// audit record rather than logging one opaque failure.
var (
	ErrBadSignature  = errors.New("netlink: command signature is not valid")
	ErrUnknownKey    = errors.New("netlink: command was signed by an unrecognised key")
	ErrWrongDevice   = errors.New("netlink: command was issued for a different device")
	ErrExpired       = errors.New("netlink: command has expired")
	ErrNotYetValid   = errors.New("netlink: command is not valid yet")
	ErrReplayed      = errors.New("netlink: command has already been used")
	ErrUnknownAction = errors.New("netlink: command action is not recognised")
	ErrMalformed     = errors.New("netlink: command is malformed")
)

// NonceStore remembers spent nonces.
type NonceStore interface {
	// Remember records nonce as used and reports false if it was already there.
	Remember(nonce string, until time.Time) bool
}

// MemoryNonceStore is the agent's in-process replay guard.
//
// Nonces are kept until the command they belong to has expired, so the window
// in which a replay could work is exactly zero for as long as the process
// lives. A restarted agent forgets them, which is why every command also
// carries a short expiry — the two protections cover each other.
type MemoryNonceStore struct {
	mu    sync.Mutex
	seen  map[string]time.Time
	clock func() time.Time
}

func NewMemoryNonceStore() *MemoryNonceStore {
	return &MemoryNonceStore{seen: make(map[string]time.Time), clock: time.Now}
}

// NewMemoryNonceStoreWithClock is used by tests to control time.
func NewMemoryNonceStoreWithClock(clock func() time.Time) *MemoryNonceStore {
	return &MemoryNonceStore{seen: make(map[string]time.Time), clock: clock}
}

func (s *MemoryNonceStore) Remember(nonce string, until time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock()
	for key, expiry := range s.seen {
		if expiry.Before(now) {
			delete(s.seen, key)
		}
	}

	if _, exists := s.seen[nonce]; exists {
		return false
	}
	s.seen[nonce] = until
	return true
}

// Len reports how many nonces are being remembered. Used by tests.
func (s *MemoryNonceStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.seen)
}

// Verifier checks incoming envelopes against this device's identity.
type Verifier struct {
	// DeviceID this agent answers to.
	DeviceID string
	// TrustedKeys maps key id to the control-plane public key that may issue
	// commands. A map rather than a single key so a key can be rotated by
	// publishing the new one before retiring the old.
	TrustedKeys map[string]ed25519.PublicKey
	Nonces      NonceStore
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now func() time.Time
	// Skew tolerated on IssuedAt, for ordinary clock drift between the control
	// plane and the machine.
	Skew time.Duration
}

// NewVerifier returns a Verifier with sensible defaults.
func NewVerifier(deviceID string, trusted map[string]ed25519.PublicKey) *Verifier {
	return &Verifier{
		DeviceID:    deviceID,
		TrustedKeys: trusted,
		Nonces:      NewMemoryNonceStore(),
		Now:         time.Now,
		Skew:        30 * time.Second,
	}
}

// Verify runs every check in order and returns the command only if all pass.
func (v *Verifier) Verify(env Envelope) (Command, error) {
	c := env.Command

	if c.ID == "" || c.Nonce == "" || c.DeviceID == "" {
		return Command{}, ErrMalformed
	}
	if !c.Action.Valid() {
		return Command{}, ErrUnknownAction
	}

	// Addressed to us? Checked before the signature so a command for another
	// machine is refused even if it is perfectly signed.
	if c.DeviceID != v.DeviceID {
		return Command{}, ErrWrongDevice
	}

	key, ok := v.TrustedKeys[env.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return Command{}, ErrUnknownKey
	}

	sig, err := base64.RawURLEncoding.DecodeString(env.Signature)
	if err != nil {
		return Command{}, ErrBadSignature
	}
	if !ed25519.Verify(key, SigningInput(c), sig) {
		return Command{}, ErrBadSignature
	}

	now := v.Now()
	if c.ExpiresAt.IsZero() || !now.Before(c.ExpiresAt) {
		return Command{}, ErrExpired
	}
	if c.IssuedAt.After(now.Add(v.Skew)) {
		return Command{}, ErrNotYetValid
	}

	// Last, so a replay of an otherwise-invalid command does not consume a
	// nonce slot and a valid command's nonce is only spent when it is accepted.
	if !v.Nonces.Remember(c.Nonce, c.ExpiresAt) {
		return Command{}, ErrReplayed
	}

	return c, nil
}

// Result is what the agent reports back after acting.
type Result struct {
	CommandID string    `json:"commandId"`
	Action    Action    `json:"action"`
	Succeeded bool      `json:"succeeded"`
	Detail    string    `json:"detail,omitempty"`
	At        time.Time `json:"at"`
}

// MarshalEnvelope is a small helper so callers do not re-derive the encoding.
func MarshalEnvelope(env Envelope) ([]byte, error) {
	return json.Marshal(env)
}

// UnmarshalEnvelope parses an envelope off the wire.
func UnmarshalEnvelope(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return env, nil
}

// SortedActions returns the action list in a stable order, for documentation
// and for the desktop app's capability display.
func SortedActions() []string {
	out := make([]string, 0, len(Actions))
	for _, a := range Actions {
		out = append(out, string(a))
	}
	sort.Strings(out)
	return out
}
