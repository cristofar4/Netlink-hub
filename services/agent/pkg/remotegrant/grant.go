// Package remotegrant defines the signed permission slip that lets this
// computer accept a remote desktop session.
//
// It exists because of one architectural fact. In a remote desktop session the
// pixels and the keystrokes travel directly between the two machines over
// WebRTC; the control plane never sees them and therefore cannot refuse them.
// So if "view only" is going to be a boundary rather than a label on somebody
// else's button, the machine being viewed has to be able to decide for itself —
// without asking anyone, and without trusting the peer that just connected.
//
// That is what this is. The mode is inside the signature. A viewer who edits
// their copy of the grant to say "control" produces something that fails
// verification here, and the host simply does not move the mouse.
package remotegrant

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Mode is what the session is permitted to do.
type Mode string

const (
	// ModeView may receive frames. Nothing it sends will be applied.
	ModeView Mode = "view"
	// ModeControl may additionally move the pointer and press keys.
	ModeControl Mode = "control"
)

// Valid reports whether m is a recognised mode. An unrecognised mode is refused
// outright rather than being treated as the safer one: a grant we cannot read
// is a grant we do not understand, and guessing at intent is how a permission
// system quietly becomes decorative.
func (m Mode) Valid() bool {
	return m == ModeView || m == ModeControl
}

// AllowsInput reports whether input events may be applied under this mode.
//
// This single function is the view-only boundary. Everything else — the UI
// badge, the disabled buttons, the permission check in the control plane — is
// defence in depth around it.
func (m Mode) AllowsInput() bool {
	return m == ModeControl
}

// Grant is the payload the control plane signs.
type Grant struct {
	SessionID string `json:"sessionId"`
	SpaceID   string `json:"spaceId"`
	AgentID   string `json:"agentId"`
	Mode      Mode   `json:"mode"`
	// RequestedBy is recorded for the audit trail, not used for authorisation —
	// authorisation happened in the control plane before this was signed.
	RequestedBy string    `json:"requestedBy"`
	IssuedAt    time.Time `json:"issuedAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
	// Nonce is single-use, so a captured grant cannot open a second session.
	Nonce string `json:"nonce"`
}

// Envelope is a grant plus its detached signature.
type Envelope struct {
	Grant     Grant  `json:"grant"`
	Signature string `json:"signature"`
	KeyID     string `json:"keyId"`
}

// TimestampLayout is the exact timestamp format inside a signing input.
//
// Not RFC3339Nano: that strips trailing zeros, so 12:00:00.000 serialises as
// "12:00:00Z" in Go while JavaScript's toISOString always emits three decimal
// places. The control plane signs and this package verifies, so the two must
// agree byte for byte.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// SigningInput is the exact byte sequence that gets signed.
//
// The leading domain string is what stops a power command being replayed as a
// session grant, and vice versa: the two message types share the control
// plane's signing key, and without a domain separator a signature over one
// could be presented as a signature over the other.
//
// Built field by field in a fixed order rather than by marshalling the struct,
// because JSON key order and whitespace are not guaranteed stable — and a
// signature over a representation that can shift is not a signature.
func SigningInput(g Grant) []byte {
	var b strings.Builder
	b.WriteString("netlink.remote.v1\n")
	b.WriteString(g.SessionID)
	b.WriteString("\n")
	b.WriteString(g.SpaceID)
	b.WriteString("\n")
	b.WriteString(g.AgentID)
	b.WriteString("\n")
	b.WriteString(string(g.Mode))
	b.WriteString("\n")
	b.WriteString(g.RequestedBy)
	b.WriteString("\n")
	b.WriteString(g.IssuedAt.UTC().Format(TimestampLayout))
	b.WriteString("\n")
	b.WriteString(g.ExpiresAt.UTC().Format(TimestampLayout))
	b.WriteString("\n")
	b.WriteString(g.Nonce)
	return []byte(b.String())
}

// Sign produces an envelope for g. Used by tests and by nothing else in the
// agent — the agent verifies grants, it does not issue them.
func Sign(g Grant, key ed25519.PrivateKey, keyID string) (Envelope, error) {
	if len(key) != ed25519.PrivateKeySize {
		return Envelope{}, errors.New("netlink: signing key is not a valid Ed25519 private key")
	}
	sig := ed25519.Sign(key, SigningInput(g))
	return Envelope{
		Grant:     g,
		Signature: base64.RawURLEncoding.EncodeToString(sig),
		KeyID:     keyID,
	}, nil
}

// Rejection reasons, separate errors so an audit record can say which check
// failed rather than logging one opaque failure.
var (
	ErrBadSignature = errors.New("netlink: session grant signature is not valid")
	ErrUnknownKey   = errors.New("netlink: session grant was signed by an unrecognised key")
	ErrWrongAgent   = errors.New("netlink: session grant was issued for a different computer")
	ErrExpired      = errors.New("netlink: session grant has expired")
	ErrNotYetValid  = errors.New("netlink: session grant is not valid yet")
	ErrReplayed     = errors.New("netlink: session grant has already been used")
	ErrUnknownMode  = errors.New("netlink: session grant mode is not recognised")
	ErrMalformed    = errors.New("netlink: session grant is malformed")
)

// NonceStore remembers spent nonces.
type NonceStore interface {
	// Remember records nonce as used and reports false if it was already there.
	Remember(nonce string, until time.Time) bool
}

// Verifier checks incoming grants against this agent's identity.
type Verifier struct {
	// AgentID this computer answers to.
	AgentID string
	// TrustedKeys maps key id to a control-plane public key that may issue
	// grants. A map rather than a single key so a key can be rotated by
	// publishing the new one before retiring the old.
	TrustedKeys map[string]ed25519.PublicKey
	Nonces      NonceStore
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now func() time.Time
	// Skew tolerated on IssuedAt, for ordinary clock drift.
	Skew time.Duration
}

// NewVerifier returns a Verifier with sensible defaults.
func NewVerifier(agentID string, trusted map[string]ed25519.PublicKey, nonces NonceStore) *Verifier {
	return &Verifier{
		AgentID:     agentID,
		TrustedKeys: trusted,
		Nonces:      nonces,
		Now:         time.Now,
		Skew:        30 * time.Second,
	}
}

// Verify runs every check in order and returns the grant only if all pass.
func (v *Verifier) Verify(env Envelope) (Grant, error) {
	g := env.Grant

	if g.SessionID == "" || g.Nonce == "" || g.AgentID == "" || g.SpaceID == "" {
		return Grant{}, ErrMalformed
	}
	if !g.Mode.Valid() {
		return Grant{}, ErrUnknownMode
	}

	// Addressed to us? Checked before the signature so a grant for another
	// computer is refused even if it is perfectly signed.
	if g.AgentID != v.AgentID {
		return Grant{}, ErrWrongAgent
	}

	key, ok := v.TrustedKeys[env.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return Grant{}, ErrUnknownKey
	}

	sig, err := base64.RawURLEncoding.DecodeString(env.Signature)
	if err != nil {
		return Grant{}, ErrBadSignature
	}
	if !ed25519.Verify(key, SigningInput(g), sig) {
		return Grant{}, ErrBadSignature
	}

	now := v.Now()
	if g.ExpiresAt.IsZero() || !now.Before(g.ExpiresAt) {
		return Grant{}, ErrExpired
	}
	if g.IssuedAt.After(now.Add(v.Skew)) {
		return Grant{}, ErrNotYetValid
	}

	// Last, so a replay of an otherwise-invalid grant does not consume a nonce
	// slot and a valid grant's nonce is only spent when it is accepted.
	if v.Nonces != nil && !v.Nonces.Remember(g.Nonce, g.ExpiresAt) {
		return Grant{}, ErrReplayed
	}

	return g, nil
}

// UnmarshalEnvelope parses an envelope off the wire.
func UnmarshalEnvelope(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return env, nil
}
