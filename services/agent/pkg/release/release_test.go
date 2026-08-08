package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func manifest() Manifest {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	return Manifest{
		Version:    "1.4.0",
		Channel:    ChannelStable,
		ReleasedAt: now,
		ExpiresAt:  now.Add(30 * 24 * time.Hour),
		Artifacts: []Artifact{{
			Component: "agent",
			Platform:  "windows/amd64",
			URL:       "https://releases.example.com/netlink-agent-1.4.0.exe",
			SHA256:    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			Bytes:     12_345_678,
		}},
	}
}

func signed(t *testing.T, m Manifest) (*Verifier, Envelope) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating a key: %v", err)
	}
	env, err := Sign(m, priv, "rel-test")
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	v := NewVerifier("1.3.0", ChannelStable, map[string]ed25519.PublicKey{"rel-test": pub})
	v.Now = func() time.Time { return m.ReleasedAt.Add(time.Hour) }
	return v, env
}

func TestAValidManifestIsAccepted(t *testing.T) {
	v, env := signed(t, manifest())

	got, err := v.Verify(env)
	if err != nil {
		t.Fatalf("a valid manifest was refused: %v", err)
	}
	if got.Version != "1.4.0" {
		t.Fatalf("version = %q", got.Version)
	}
}

/*
The attack this exists to stop: swapping the file the manifest points at.

An update mechanism that signs only the version number tells you nothing about
what you are about to run.
*/
func TestChangingAnArtifactHashInvalidatesTheSignature(t *testing.T) {
	v, env := signed(t, manifest())
	env.Manifest.Artifacts[0].SHA256 = "0000000000000000000000000000000000000000000000000000000000000000"

	if _, err := v.Verify(env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}

func TestChangingTheDownloadUrlInvalidatesTheSignature(t *testing.T) {
	v, env := signed(t, manifest())
	env.Manifest.Artifacts[0].URL = "https://attacker.example.com/netlink-agent.exe"

	if _, err := v.Verify(env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}

func TestEveryManifestFieldIsInsideTheSignature(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Envelope)
	}{
		{"version", func(e *Envelope) { e.Manifest.Version = "9.9.9" }},
		{"expiry", func(e *Envelope) { e.Manifest.ExpiresAt = e.Manifest.ExpiresAt.Add(time.Hour) }},
		{"minimum", func(e *Envelope) { e.Manifest.Minimum = "0.0.1" }},
		{"artifact size", func(e *Envelope) { e.Manifest.Artifacts[0].Bytes = 1 }},
		{"artifact platform", func(e *Envelope) { e.Manifest.Artifacts[0].Platform = "linux/amd64" }},
		{"an extra artifact", func(e *Envelope) {
			e.Manifest.Artifacts = append(e.Manifest.Artifacts, Artifact{
				Component: "agent",
				Platform:  "windows/arm64",
				URL:       "https://attacker.example.com/x.exe",
				SHA256:    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				Bytes:     10,
			})
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, env := signed(t, manifest())
			tc.mutate(&env)
			if _, err := v.Verify(env); err == nil {
				t.Fatalf("changing %s left the manifest valid", tc.name)
			}
		})
	}
}

func TestAnUnknownSigningKeyIsRefused(t *testing.T) {
	v, env := signed(t, manifest())
	env.KeyID = "rel-somebody-else"

	if _, err := v.Verify(env); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
}

/*
Downgrade protection.

An attacker who cannot forge a signature can still replay a *genuine* older
release whose vulnerability they know. Refusing it is why signing alone is not
enough, and it is the check most update mechanisms are missing.
*/
func TestAGenuineOlderReleaseIsRefused(t *testing.T) {
	older := manifest()
	older.Version = "1.1.0"
	v, env := signed(t, older)

	if _, err := v.Verify(env); !errors.Is(err, ErrDowngrade) {
		t.Fatalf("err = %v, want ErrDowngrade", err)
	}
}

func TestTheVersionAlreadyRunningIsRefused(t *testing.T) {
	same := manifest()
	same.Version = "1.3.0"
	v, env := signed(t, same)

	if _, err := v.Verify(env); !errors.Is(err, ErrDowngrade) {
		t.Fatalf("err = %v, want ErrDowngrade", err)
	}
}

/*
An expired manifest is refused, so a signed one captured today cannot be served
forever to pin machines at a version somebody knows how to attack.
*/
func TestAnExpiredManifestIsRefused(t *testing.T) {
	v, env := signed(t, manifest())
	v.Now = func() time.Time { return env.Manifest.ExpiresAt.Add(time.Second) }

	if _, err := v.Verify(env); !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v, want ErrExpired", err)
	}
}

func TestAManifestForAnotherChannelIsRefused(t *testing.T) {
	beta := manifest()
	beta.Channel = ChannelBeta
	v, env := signed(t, beta)

	if _, err := v.Verify(env); !errors.Is(err, ErrWrongChannel) {
		t.Fatalf("err = %v, want ErrWrongChannel", err)
	}
}

func TestAVersionTooOldToJumpIsRefused(t *testing.T) {
	m := manifest()
	m.Minimum = "1.3.5"
	v, env := signed(t, m)
	v.Current = "1.3.0"

	if _, err := v.Verify(env); !errors.Is(err, ErrTooOldToJump) {
		t.Fatalf("err = %v, want ErrTooOldToJump", err)
	}
}

func TestAPlainHttpArtifactIsRefused(t *testing.T) {
	m := manifest()
	m.Artifacts[0].URL = "http://releases.example.com/netlink-agent-1.4.0.exe"
	v, env := signed(t, m)

	if _, err := v.Verify(env); !errors.Is(err, ErrUnsafeURL) {
		t.Fatalf("err = %v, want ErrUnsafeURL", err)
	}
}

func TestAManifestWithNoArtifactsIsRefused(t *testing.T) {
	m := manifest()
	m.Artifacts = nil
	v, env := signed(t, m)

	if _, err := v.Verify(env); !errors.Is(err, ErrMalformed) {
		t.Fatalf("err = %v, want ErrMalformed", err)
	}
}

func TestThereIsNothingForAPlatformWeDoNotShip(t *testing.T) {
	m := manifest()
	if _, err := m.ArtifactFor("agent", "darwin/arm64"); !errors.Is(err, ErrNoArtifact) {
		t.Fatalf("err = %v, want ErrNoArtifact", err)
	}
	if _, err := m.ArtifactFor("agent", "windows/amd64"); err != nil {
		t.Fatalf("the platform we do ship was not found: %v", err)
	}
}

// ---------------------------------------------------------------------------
// The downloaded file
// ---------------------------------------------------------------------------

func writeFile(t *testing.T, content []byte) (string, Artifact) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "download.bin")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}
	sum := sha256.Sum256(content)
	return path, Artifact{
		Component: "agent",
		Platform:  "windows/amd64",
		URL:       "https://releases.example.com/x.exe",
		SHA256:    hex.EncodeToString(sum[:]),
		Bytes:     int64(len(content)),
	}
}

func TestAFileMatchingItsSignedChecksumIsAccepted(t *testing.T) {
	path, artifact := writeFile(t, []byte("this is a NetLink agent binary"))

	if err := VerifyFile(path, artifact); err != nil {
		t.Fatalf("a genuine file was refused: %v", err)
	}
}

// The whole point: the transport is not trusted, the hash is.
func TestAFileThatDoesNotMatchIsRefused(t *testing.T) {
	path, artifact := writeFile(t, []byte("this is a NetLink agent binary"))

	// Same length, different content — so a size check alone would pass it.
	if err := os.WriteFile(path, []byte("this is NOT a NetLink agent bin"), 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}
	artifact.Bytes = 31

	if err := VerifyFile(path, artifact); !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v, want ErrChecksum", err)
	}
}

func TestAFileOfTheWrongSizeIsRefusedBeforeItIsRead(t *testing.T) {
	path, artifact := writeFile(t, []byte("short"))
	artifact.Bytes = 40 << 20

	if err := VerifyFile(path, artifact); !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v, want ErrChecksum", err)
	}
}

// A server answering a small download with an enormous one must not be able to
// fill the disk of a machine that is only trying to stay up to date.
func TestAnOversizedFileIsRefused(t *testing.T) {
	content := []byte("the real binary")
	path, artifact := writeFile(t, content)

	padded := append(append([]byte{}, content...), make([]byte, 4096)...)
	if err := os.WriteFile(path, padded, 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}

	if err := VerifyFile(path, artifact); !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v, want ErrChecksum", err)
	}
}

// ---------------------------------------------------------------------------
// Version ordering
// ---------------------------------------------------------------------------

func TestVersionOrdering(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.1.0", "1.0.9", 1},
		{"2.0.0", "1.9.9", 1},
		{"1.0.0", "1.0.1", -1},
		{"v1.2.3", "1.2.3", 0},
		// A pre-release sorts before the release it precedes, which is what
		// makes "rc then final" an upgrade rather than a downgrade.
		{"1.2.0-rc.1", "1.2.0", -1},
		{"1.2.0", "1.2.0-rc.1", 1},
		{"1.2.0-rc.1", "1.2.0-rc.2", -1},
		// A malformed field must not be able to make itself look newest.
		{"1.x.0", "1.0.0", 0},
		{"", "0.0.1", -1},
	}

	for _, tc := range cases {
		if got := CompareVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

/*
The signing input is pinned byte for byte.

The release tooling produces these bytes and every agent in the field consumes
them. A change on one side that is not mirrored on the other does not fail
loudly — it silently stops every machine updating, which is the failure nobody
notices until it matters.
*/
func TestSigningInputIsExactlyThis(t *testing.T) {
	m := Manifest{
		Version:    "1.4.0",
		Channel:    ChannelStable,
		ReleasedAt: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		ExpiresAt:  time.Date(2026, 3, 31, 12, 0, 0, 0, time.UTC),
		Minimum:    "1.2.0",
		Artifacts: []Artifact{{
			Component: "agent",
			Platform:  "windows/amd64",
			URL:       "https://releases.example.com/a.exe",
			SHA256:    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			Bytes:     100,
		}},
	}

	want := "netlink.release.v1\n" +
		"1.4.0\n" +
		"stable\n" +
		"2026-03-01T12:00:00.000Z\n" +
		"2026-03-31T12:00:00.000Z\n" +
		"1.2.0\n" +
		"agent\n" +
		"windows/amd64\n" +
		"https://releases.example.com/a.exe\n" +
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
		"100"

	if got := string(SigningInput(m)); got != want {
		t.Fatalf("signing input drifted.\n got: %q\nwant: %q", got, want)
	}
}

func TestAMalformedEnvelopeIsRefused(t *testing.T) {
	if _, err := UnmarshalEnvelope([]byte("{nope")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("err = %v, want ErrMalformed", err)
	}
}

/*
A summary, written as the claim being made.

Nothing runs unless a key this installation trusts signed a manifest naming its
exact hash, that manifest is current, it is for this channel, and it is newer
than what is running.
*/
func TestNothingUnverifiedCanBecomeTheRunningBinary(t *testing.T) {
	attempts := []struct {
		name  string
		build func(t *testing.T) (*Verifier, Envelope)
	}{
		{"unsigned", func(t *testing.T) (*Verifier, Envelope) {
			v, env := signed(t, manifest())
			env.Signature = ""
			return v, env
		}},
		{"signed by the wrong key", func(t *testing.T) (*Verifier, Envelope) {
			v, env := signed(t, manifest())
			_, other, _ := ed25519.GenerateKey(rand.Reader)
			forged, _ := Sign(env.Manifest, other, "rel-test")
			return v, forged
		}},
		{"a genuine older release", func(t *testing.T) (*Verifier, Envelope) {
			old := manifest()
			old.Version = "0.9.0"
			return signed(t, old)
		}},
		{"an expired manifest", func(t *testing.T) (*Verifier, Envelope) {
			v, env := signed(t, manifest())
			v.Now = func() time.Time { return env.Manifest.ExpiresAt.Add(time.Hour) }
			return v, env
		}},
		{"a redirected download", func(t *testing.T) (*Verifier, Envelope) {
			v, env := signed(t, manifest())
			env.Manifest.Artifacts[0].URL = "https://attacker.example.com/a.exe"
			return v, env
		}},
	}

	for _, attempt := range attempts {
		t.Run(attempt.name, func(t *testing.T) {
			v, env := attempt.build(t)
			if _, err := v.Verify(env); err == nil {
				t.Fatalf("%s was accepted", attempt.name)
			}
		})
	}
}
