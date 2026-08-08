package remotegrant

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/netlink/agent/pkg/command"
)

const (
	agentID   = "6f0f4a1c-9a6d-4f0e-9a5f-2d1c3b4a5e6f"
	sessionID = "11111111-2222-3333-4444-555555555555"
	spaceID   = "99999999-8888-7777-6666-555555555555"
)

func newGrant(mode Mode) Grant {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	return Grant{
		SessionID:   sessionID,
		SpaceID:     spaceID,
		AgentID:     agentID,
		Mode:        mode,
		RequestedBy: "owner-user-id",
		IssuedAt:    now,
		ExpiresAt:   now.Add(2 * time.Minute),
		Nonce:       "nonce-one",
	}
}

func newVerifier(t *testing.T, mode Mode) (*Verifier, Envelope) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating a key: %v", err)
	}
	env, err := Sign(newGrant(mode), priv, "cp-test")
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	// The nonce store shares the verifier's clock. It prunes nonces once they
	// pass their expiry, and with the real clock a fixture dated in the past
	// would be pruned the instant it was recorded — making a replay look
	// accepted for reasons that have nothing to do with the code under test.
	at := func() time.Time { return newGrant(mode).IssuedAt.Add(time.Second) }
	v := NewVerifier(agentID, map[string]ed25519.PublicKey{"cp-test": pub}, command.NewMemoryNonceStoreWithClock(at))
	v.Now = at
	return v, env
}

func TestAValidGrantIsAccepted(t *testing.T) {
	v, env := newVerifier(t, ModeControl)

	grant, err := v.Verify(env)
	if err != nil {
		t.Fatalf("a valid grant was refused: %v", err)
	}
	if grant.Mode != ModeControl {
		t.Fatalf("mode = %q, want control", grant.Mode)
	}
}

// The central claim of the whole feature: a viewer cannot promote itself.
func TestChangingTheModeInvalidatesTheSignature(t *testing.T) {
	v, env := newVerifier(t, ModeView)

	// Exactly what a modified client would do: flip the one field that decides
	// whether the mouse moves.
	env.Grant.Mode = ModeControl

	if _, err := v.Verify(env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("a grant escalated from view to control was accepted (err = %v)", err)
	}
}

func TestEveryFieldIsInsideTheSignature(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Envelope)
	}{
		{"session id", func(e *Envelope) { e.Grant.SessionID = "different-session" }},
		{"space id", func(e *Envelope) { e.Grant.SpaceID = "different-space" }},
		{"requested by", func(e *Envelope) { e.Grant.RequestedBy = "someone-else" }},
		{"issued at", func(e *Envelope) { e.Grant.IssuedAt = e.Grant.IssuedAt.Add(-time.Hour) }},
		{"expires at", func(e *Envelope) { e.Grant.ExpiresAt = e.Grant.ExpiresAt.Add(time.Hour) }},
		{"nonce", func(e *Envelope) { e.Grant.Nonce = "another-nonce" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, env := newVerifier(t, ModeControl)
			tc.mutate(&env)
			if _, err := v.Verify(env); err == nil {
				t.Fatalf("changing %s left the grant valid", tc.name)
			}
		})
	}
}

func TestAGrantForAnotherComputerIsRefused(t *testing.T) {
	v, env := newVerifier(t, ModeControl)
	v.AgentID = "a-different-agent"

	if _, err := v.Verify(env); !errors.Is(err, ErrWrongAgent) {
		t.Fatalf("err = %v, want ErrWrongAgent", err)
	}
}

func TestAGrantSignedByAnUnknownKeyIsRefused(t *testing.T) {
	v, env := newVerifier(t, ModeControl)
	env.KeyID = "cp-somebody-else"

	if _, err := v.Verify(env); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
}

func TestAnExpiredGrantIsRefused(t *testing.T) {
	v, env := newVerifier(t, ModeControl)
	v.Now = func() time.Time { return env.Grant.ExpiresAt.Add(time.Second) }

	if _, err := v.Verify(env); !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v, want ErrExpired", err)
	}
}

func TestAGrantFromTheFutureIsRefused(t *testing.T) {
	v, env := newVerifier(t, ModeControl)
	v.Now = func() time.Time { return env.Grant.IssuedAt.Add(-10 * time.Minute) }

	if _, err := v.Verify(env); !errors.Is(err, ErrNotYetValid) && !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v, want a time-window rejection", err)
	}
}

func TestAGrantCannotBeUsedTwice(t *testing.T) {
	v, env := newVerifier(t, ModeControl)

	if _, err := v.Verify(env); err != nil {
		t.Fatalf("first use failed: %v", err)
	}
	if _, err := v.Verify(env); !errors.Is(err, ErrReplayed) {
		t.Fatalf("err = %v, want ErrReplayed", err)
	}
}

// A rejected grant must not burn its nonce, or a single malformed replay could
// lock out the legitimate one that follows.
func TestARejectedGrantDoesNotSpendItsNonce(t *testing.T) {
	v, env := newVerifier(t, ModeControl)

	tampered := env
	tampered.Grant.SpaceID = "tampered"
	if _, err := v.Verify(tampered); err == nil {
		t.Fatal("a tampered grant was accepted")
	}

	if _, err := v.Verify(env); err != nil {
		t.Fatalf("the genuine grant was refused after a tampered one: %v", err)
	}
}

func TestAnUnknownModeIsRefused(t *testing.T) {
	v, env := newVerifier(t, ModeControl)
	env.Grant.Mode = "administrator"

	if _, err := v.Verify(env); !errors.Is(err, ErrUnknownMode) {
		t.Fatalf("err = %v, want ErrUnknownMode", err)
	}
}

func TestOnlyControlAllowsInput(t *testing.T) {
	if ModeView.AllowsInput() {
		t.Fatal("a view-only grant reported that it allows input")
	}
	if !ModeControl.AllowsInput() {
		t.Fatal("a control grant reported that it does not allow input")
	}
	if Mode("").AllowsInput() || Mode("control ").AllowsInput() || Mode("CONTROL").AllowsInput() {
		t.Fatal("a mode that is not exactly \"control\" allowed input")
	}
}

/*
The signing input is pinned byte for byte.

The control plane produces these bytes in TypeScript and this package consumes
them in Go. Two implementations of "join the fields with newlines" agree right
up until one of them formats a timestamp differently — Go's RFC3339Nano strips
trailing zeros and JavaScript's toISOString does not — at which point every
session silently stops connecting. Spelling out the exact expected bytes means
that change fails here instead.
*/
func TestSigningInputIsExactlyThis(t *testing.T) {
	g := Grant{
		SessionID:   "session-1",
		SpaceID:     "space-1",
		AgentID:     "agent-1",
		Mode:        ModeView,
		RequestedBy: "user-1",
		IssuedAt:    time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		ExpiresAt:   time.Date(2026, 3, 1, 12, 2, 0, 0, time.UTC),
		Nonce:       "nonce-1",
	}

	want := "netlink.remote.v1\n" +
		"session-1\n" +
		"space-1\n" +
		"agent-1\n" +
		"view\n" +
		"user-1\n" +
		"2026-03-01T12:00:00.000Z\n" +
		"2026-03-01T12:02:00.000Z\n" +
		"nonce-1"

	if got := string(SigningInput(g)); got != want {
		t.Fatalf("signing input drifted.\n got: %q\nwant: %q", got, want)
	}
}

/*
A power command must never be usable as a session grant.

Both are signed with the same control-plane key, so without a domain separator
at the head of the signing input a signature over one message type could be
presented as a signature over the other. This test is what keeps the two
separated.
*/
func TestAPowerCommandCannotBeReplayedAsASessionGrant(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating a key: %v", err)
	}

	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	cmd := command.Command{
		ID:          sessionID,
		Action:      command.ActionLock,
		DeviceID:    agentID,
		SpaceID:     spaceID,
		IssuedAt:    now,
		ExpiresAt:   now.Add(2 * time.Minute),
		Nonce:       "nonce-one",
		RequestedBy: "owner-user-id",
	}
	signed, err := command.Sign(cmd, priv, "cp-test")
	if err != nil {
		t.Fatalf("signing the command: %v", err)
	}

	// The most favourable case for an attacker: every field lines up, and the
	// signature is genuine. Only the domain string differs.
	forged := Envelope{
		Grant: Grant{
			SessionID:   cmd.ID,
			SpaceID:     cmd.SpaceID,
			AgentID:     cmd.DeviceID,
			Mode:        ModeControl,
			RequestedBy: cmd.RequestedBy,
			IssuedAt:    cmd.IssuedAt,
			ExpiresAt:   cmd.ExpiresAt,
			Nonce:       cmd.Nonce,
		},
		Signature: signed.Signature,
		KeyID:     signed.KeyID,
	}

	at := func() time.Time { return now.Add(time.Second) }
	v := NewVerifier(agentID, map[string]ed25519.PublicKey{"cp-test": pub}, command.NewMemoryNonceStoreWithClock(at))
	v.Now = at

	if _, err := v.Verify(forged); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("a power command was accepted as a session grant (err = %v)", err)
	}
}

func TestAMalformedEnvelopeIsRefused(t *testing.T) {
	if _, err := UnmarshalEnvelope([]byte("{not json")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("err = %v, want ErrMalformed", err)
	}
}

func TestAnEmptyGrantIsRefused(t *testing.T) {
	v, _ := newVerifier(t, ModeControl)
	if _, err := v.Verify(Envelope{}); !errors.Is(err, ErrMalformed) {
		t.Fatalf("err = %v, want ErrMalformed", err)
	}
}
