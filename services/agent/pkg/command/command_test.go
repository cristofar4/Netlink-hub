package command

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

const (
	thisDevice  = "device-under-test"
	otherDevice = "somebody-elses-device"
	keyID       = "control-plane-2026-08"
)

type fixture struct {
	priv     ed25519.PrivateKey
	pub      ed25519.PublicKey
	verifier *Verifier
	now      time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	now := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
	f := &fixture{priv: priv, pub: pub, now: now}
	f.verifier = &Verifier{
		DeviceID:    thisDevice,
		TrustedKeys: map[string]ed25519.PublicKey{keyID: pub},
		Nonces:      NewMemoryNonceStoreWithClock(func() time.Time { return f.now }),
		Now:         func() time.Time { return f.now },
		Skew:        30 * time.Second,
	}
	return f
}

func (f *fixture) command(action Action, nonce string) Command {
	return Command{
		ID:          "cmd-" + nonce,
		Action:      action,
		DeviceID:    thisDevice,
		SpaceID:     "space-1",
		IssuedAt:    f.now,
		ExpiresAt:   f.now.Add(2 * time.Minute),
		Nonce:       nonce,
		RequestedBy: "owner-user-id",
	}
}

func (f *fixture) sign(t *testing.T, c Command) Envelope {
	t.Helper()
	env, err := Sign(c, f.priv, keyID)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return env
}

// -----------------------------------------------------------------------------
// Signing
// -----------------------------------------------------------------------------

func TestSignedCommandVerifies(t *testing.T) {
	f := newFixture(t)

	for _, action := range Actions {
		env := f.sign(t, f.command(action, "nonce-"+string(action)))
		got, err := f.verifier.Verify(env)
		if err != nil {
			t.Fatalf("%s: Verify: %v", action, err)
		}
		if got.Action != action {
			t.Errorf("action = %q, want %q", got.Action, action)
		}
	}
}

func TestSigningInputCoversEveryField(t *testing.T) {
	f := newFixture(t)
	base := f.command(ActionShutdown, "n1")

	mutations := map[string]func(*Command){
		"id":          func(c *Command) { c.ID = "different" },
		"action":      func(c *Command) { c.Action = ActionRestart },
		"deviceId":    func(c *Command) { c.DeviceID = otherDevice },
		"spaceId":     func(c *Command) { c.SpaceID = "space-2" },
		"issuedAt":    func(c *Command) { c.IssuedAt = c.IssuedAt.Add(time.Second) },
		"expiresAt":   func(c *Command) { c.ExpiresAt = c.ExpiresAt.Add(time.Hour) },
		"nonce":       func(c *Command) { c.Nonce = "n2" },
		"requestedBy": func(c *Command) { c.RequestedBy = "someone-else" },
	}

	original := SigningInput(base)
	for field, mutate := range mutations {
		mutated := base
		mutate(&mutated)
		if string(SigningInput(mutated)) == string(original) {
			t.Errorf("changing %s did not change the signing input", field)
		}
	}
}

func TestSignRejectsBadKey(t *testing.T) {
	f := newFixture(t)
	if _, err := Sign(f.command(ActionLock, "n"), ed25519.PrivateKey("too short"), keyID); err == nil {
		t.Fatal("Sign accepted an invalid private key")
	}
}

// -----------------------------------------------------------------------------
// Tampering
// -----------------------------------------------------------------------------

func TestVerifyRejectsTamperedAction(t *testing.T) {
	f := newFixture(t)

	// A lock command intercepted and upgraded to a shutdown.
	env := f.sign(t, f.command(ActionLock, "n1"))
	env.Command.Action = ActionShutdown

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}

func TestVerifyRejectsExtendedExpiry(t *testing.T) {
	f := newFixture(t)
	env := f.sign(t, f.command(ActionShutdown, "n1"))
	env.Command.ExpiresAt = f.now.Add(365 * 24 * time.Hour)

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}

func TestVerifyRejectsGarbageSignature(t *testing.T) {
	f := newFixture(t)
	env := f.sign(t, f.command(ActionSleep, "n1"))

	for _, sig := range []string{"", "not base64!!", base64.RawURLEncoding.EncodeToString([]byte("short"))} {
		bad := env
		bad.Signature = sig
		if _, err := f.verifier.Verify(bad); !errors.Is(err, ErrBadSignature) {
			t.Errorf("signature %q: err = %v, want ErrBadSignature", sig, err)
		}
	}
}

func TestVerifyRejectsUnknownSigningKey(t *testing.T) {
	f := newFixture(t)

	// Signed with a key the agent has never been told to trust.
	_, rogue, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	env, err := Sign(f.command(ActionShutdown, "n1"), rogue, "rogue-key")
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
}

func TestVerifyRejectsKnownKeyIDWithWrongKey(t *testing.T) {
	f := newFixture(t)

	// Signed by a different key, but claiming the trusted key's id.
	_, rogue, _ := ed25519.GenerateKey(rand.Reader)
	env, err := Sign(f.command(ActionShutdown, "n1"), rogue, keyID)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}

// -----------------------------------------------------------------------------
// Targeting
// -----------------------------------------------------------------------------

func TestVerifyRejectsCommandForAnotherDevice(t *testing.T) {
	f := newFixture(t)

	c := f.command(ActionShutdown, "n1")
	c.DeviceID = otherDevice
	env := f.sign(t, c) // correctly signed, just not for us

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrWrongDevice) {
		t.Fatalf("err = %v, want ErrWrongDevice", err)
	}
}

func TestVerifyRejectsUnknownAction(t *testing.T) {
	f := newFixture(t)
	c := f.command("power.format_disk", "n1")
	env := f.sign(t, c)

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrUnknownAction) {
		t.Fatalf("err = %v, want ErrUnknownAction", err)
	}
}

func TestNoArbitraryExecutionVerbExists(t *testing.T) {
	// NetLink never offers remote shell execution. If someone adds an action
	// that looks like one, this fails.
	for _, action := range Actions {
		for _, forbidden := range []string{"exec", "run", "shell", "cmd", "powershell", "script"} {
			if string(action) == "power."+forbidden {
				t.Errorf("action %q looks like arbitrary execution", action)
			}
		}
	}
}

func TestVerifyRejectsMalformedCommand(t *testing.T) {
	f := newFixture(t)

	for name, mutate := range map[string]func(*Command){
		"no id":       func(c *Command) { c.ID = "" },
		"no nonce":    func(c *Command) { c.Nonce = "" },
		"no deviceId": func(c *Command) { c.DeviceID = "" },
	} {
		c := f.command(ActionLock, "n-"+name)
		mutate(&c)
		env := f.sign(t, c)
		if _, err := f.verifier.Verify(env); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: err = %v, want ErrMalformed", name, err)
		}
	}
}

// -----------------------------------------------------------------------------
// Freshness and replay
// -----------------------------------------------------------------------------

func TestVerifyRejectsExpiredCommand(t *testing.T) {
	f := newFixture(t)
	env := f.sign(t, f.command(ActionShutdown, "n1"))

	f.now = f.now.Add(3 * time.Minute) // past the two-minute window

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v, want ErrExpired", err)
	}
}

func TestVerifyRejectsCommandAtExactExpiry(t *testing.T) {
	f := newFixture(t)
	c := f.command(ActionShutdown, "n1")
	env := f.sign(t, c)

	f.now = c.ExpiresAt

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v, want ErrExpired at the exact expiry instant", err)
	}
}

func TestVerifyRejectsCommandFromTheFuture(t *testing.T) {
	f := newFixture(t)
	c := f.command(ActionShutdown, "n1")
	c.IssuedAt = f.now.Add(10 * time.Minute)
	c.ExpiresAt = f.now.Add(20 * time.Minute)
	env := f.sign(t, c)

	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrNotYetValid) {
		t.Fatalf("err = %v, want ErrNotYetValid", err)
	}
}

func TestVerifyToleratesSmallClockDrift(t *testing.T) {
	f := newFixture(t)
	c := f.command(ActionLock, "n1")
	c.IssuedAt = f.now.Add(10 * time.Second) // inside the 30s skew allowance
	env := f.sign(t, c)

	if _, err := f.verifier.Verify(env); err != nil {
		t.Fatalf("Verify rejected ordinary clock drift: %v", err)
	}
}

func TestReplayIsRejected(t *testing.T) {
	f := newFixture(t)
	env := f.sign(t, f.command(ActionShutdown, "n1"))

	if _, err := f.verifier.Verify(env); err != nil {
		t.Fatalf("first Verify: %v", err)
	}

	// The identical, still-unexpired, perfectly-signed envelope, replayed.
	if _, err := f.verifier.Verify(env); !errors.Is(err, ErrReplayed) {
		t.Fatalf("replay err = %v, want ErrReplayed", err)
	}
}

func TestReplayIsRejectedForEveryAction(t *testing.T) {
	for _, action := range Actions {
		f := newFixture(t)
		env := f.sign(t, f.command(action, "n1"))

		if _, err := f.verifier.Verify(env); err != nil {
			t.Fatalf("%s: first Verify: %v", action, err)
		}
		if _, err := f.verifier.Verify(env); !errors.Is(err, ErrReplayed) {
			t.Errorf("%s: replay err = %v, want ErrReplayed", action, err)
		}
	}
}

func TestDistinctNoncesAreAccepted(t *testing.T) {
	f := newFixture(t)

	for _, nonce := range []string{"n1", "n2", "n3"} {
		if _, err := f.verifier.Verify(f.sign(t, f.command(ActionLock, nonce))); err != nil {
			t.Fatalf("nonce %s: %v", nonce, err)
		}
	}
}

func TestFailedVerificationDoesNotConsumeANonce(t *testing.T) {
	f := newFixture(t)

	// A command that fails on signature must not burn its nonce — otherwise an
	// attacker could pre-emptively block a legitimate command by sending a
	// broken copy of it first.
	c := f.command(ActionShutdown, "n1")
	tampered := f.sign(t, c)
	tampered.Command.SpaceID = "space-2"

	if _, err := f.verifier.Verify(tampered); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}

	if _, err := f.verifier.Verify(f.sign(t, c)); err != nil {
		t.Fatalf("the legitimate command was blocked by a failed one: %v", err)
	}
}

func TestNonceStoreForgetsExpiredEntries(t *testing.T) {
	now := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
	store := NewMemoryNonceStoreWithClock(func() time.Time { return now })

	if !store.Remember("n1", now.Add(time.Minute)) {
		t.Fatal("first Remember returned false")
	}
	if store.Remember("n1", now.Add(time.Minute)) {
		t.Fatal("Remember allowed a duplicate nonce")
	}

	now = now.Add(2 * time.Minute)
	// The sweep runs on the next call; after it, the map must not grow forever.
	store.Remember("n2", now.Add(time.Minute))
	if store.Len() != 1 {
		t.Errorf("store holds %d nonces, want 1 after expiry sweep", store.Len())
	}
}

// -----------------------------------------------------------------------------
// Encoding and metadata
// -----------------------------------------------------------------------------

func TestEnvelopeRoundTripsThroughJSON(t *testing.T) {
	f := newFixture(t)
	env := f.sign(t, f.command(ActionRestart, "n1"))

	raw, err := MarshalEnvelope(env)
	if err != nil {
		t.Fatalf("MarshalEnvelope: %v", err)
	}
	decoded, err := UnmarshalEnvelope(raw)
	if err != nil {
		t.Fatalf("UnmarshalEnvelope: %v", err)
	}

	// The signature must survive a wire round trip — a marshalling detail that
	// changes the bytes would break every command.
	if _, err := f.verifier.Verify(decoded); err != nil {
		t.Fatalf("Verify after JSON round trip: %v", err)
	}
}

func TestUnmarshalRejectsGarbage(t *testing.T) {
	if _, err := UnmarshalEnvelope([]byte("{not json")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("err = %v, want ErrMalformed", err)
	}
}

func TestDestructiveActionsGetACountdown(t *testing.T) {
	if !ActionShutdown.Destructive() || !ActionRestart.Destructive() {
		t.Error("shutdown and restart must be treated as destructive")
	}
	for _, action := range []Action{ActionLock, ActionSleep, ActionWake, ActionCancelShutdown} {
		if action.Destructive() {
			t.Errorf("%s should not require a countdown", action)
		}
	}
	if CountdownSeconds != 10 {
		t.Errorf("CountdownSeconds = %d, want 10", CountdownSeconds)
	}
}

func TestCancelIsAvailableForEveryDestructiveAction(t *testing.T) {
	// A countdown the user cannot stop is not a safeguard.
	if !ActionCancelShutdown.Valid() {
		t.Fatal("there is no way to cancel a pending shutdown")
	}
}

func TestActionValidity(t *testing.T) {
	if Action("power.shutdown").Valid() != true {
		t.Error("a known action was rejected")
	}
	for _, bad := range []Action{"", "shutdown", "power.", "POWER.SHUTDOWN", "files.delete"} {
		if bad.Valid() {
			t.Errorf("Action(%q).Valid() = true", bad)
		}
	}
}

func TestSortedActionsIsStable(t *testing.T) {
	a := SortedActions()
	b := SortedActions()
	if len(a) != len(Actions) {
		t.Fatalf("SortedActions returned %d entries, want %d", len(a), len(Actions))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatal("SortedActions is not stable across calls")
		}
	}
}
