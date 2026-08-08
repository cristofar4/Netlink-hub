// Package release defines the signed manifest that describes an update, and
// the checks an agent runs before it will replace its own binary.
//
// Automatic updates are the single most dangerous feature in any product that
// ships an agent running as a Windows service. A compromised update channel is
// remote code execution as SYSTEM on every machine at once — a far bigger prize
// than anything else NetLink holds. So the rule here is that the *transport is
// not trusted at all*: HTTPS, the CDN, DNS and the file on disk are all treated
// as hostile, and the only thing that decides whether a binary runs is an
// Ed25519 signature over a manifest that names its exact SHA-256.
//
// Three properties this enforces, each one a real attack:
//
//   - **Nothing runs without a signature over its hash.** Serving a different
//     binary than the manifest describes fails, whoever served it.
//   - **A version cannot go backwards.** Otherwise an attacker who cannot forge
//     a signature can replay a genuine older release whose vulnerability they
//     know — a downgrade attack, and the reason signing alone is not enough.
//   - **A manifest expires.** So a signed manifest captured today cannot be
//     served indefinitely to pin machines at one version.
package release

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Channel separates releases that most people get from ones they opt into.
type Channel string

const (
	ChannelStable Channel = "stable"
	ChannelBeta   Channel = "beta"
)

func (c Channel) Valid() bool { return c == ChannelStable || c == ChannelBeta }

// Artifact is one downloadable file in a release.
type Artifact struct {
	// Component is "agent" or "desktop".
	Component string `json:"component"`
	// Platform is a GOOS/GOARCH pair, e.g. "windows/amd64".
	Platform string `json:"platform"`
	URL      string `json:"url"`
	// SHA256 is hex-encoded, lower case. This is what makes the download
	// untrusted-until-verified rather than trusted-because-it-arrived.
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

// Manifest describes one release. It is what gets signed.
type Manifest struct {
	Version    string    `json:"version"`
	Channel    Channel   `json:"channel"`
	ReleasedAt time.Time `json:"releasedAt"`
	// ExpiresAt bounds how long this manifest may be served, so a captured one
	// cannot pin machines at an old version indefinitely.
	ExpiresAt time.Time `json:"expiresAt"`
	// Minimum is the oldest version that may update straight to this one. Set
	// when an intermediate release is required — a migration that cannot be
	// skipped, for instance.
	Minimum   string     `json:"minimumVersion,omitempty"`
	Notes     string     `json:"notes,omitempty"`
	Artifacts []Artifact `json:"artifacts"`
}

// Envelope is a manifest plus its detached signature.
type Envelope struct {
	Manifest  Manifest `json:"manifest"`
	Signature string   `json:"signature"`
	KeyID     string   `json:"keyId"`
}

// TimestampLayout is pinned for the same reason it is pinned everywhere else in
// NetLink: Go's RFC3339Nano strips trailing zeros and JavaScript's toISOString
// does not, and a signature over a representation that can shift is not a
// signature.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// SigningInput is the exact byte sequence that gets signed.
//
// Field by field in a fixed order, artifacts included — a manifest whose
// signature covered only the version would let an attacker swap the hash of the
// file it points at, which is the entire thing being protected.
func SigningInput(m Manifest) []byte {
	var b strings.Builder
	b.WriteString("netlink.release.v1\n")
	b.WriteString(m.Version)
	b.WriteString("\n")
	b.WriteString(string(m.Channel))
	b.WriteString("\n")
	b.WriteString(m.ReleasedAt.UTC().Format(TimestampLayout))
	b.WriteString("\n")
	b.WriteString(m.ExpiresAt.UTC().Format(TimestampLayout))
	b.WriteString("\n")
	b.WriteString(m.Minimum)
	for _, artifact := range m.Artifacts {
		b.WriteString("\n")
		b.WriteString(artifact.Component)
		b.WriteString("\n")
		b.WriteString(artifact.Platform)
		b.WriteString("\n")
		b.WriteString(artifact.URL)
		b.WriteString("\n")
		b.WriteString(strings.ToLower(artifact.SHA256))
		b.WriteString("\n")
		b.WriteString(strconv.FormatInt(artifact.Bytes, 10))
	}
	return []byte(b.String())
}

// Sign produces an envelope. Used by the release tooling, never by an agent.
func Sign(m Manifest, key ed25519.PrivateKey, keyID string) (Envelope, error) {
	if len(key) != ed25519.PrivateKeySize {
		return Envelope{}, errors.New("netlink: release signing key is not a valid Ed25519 private key")
	}
	sig := ed25519.Sign(key, SigningInput(m))
	return Envelope{
		Manifest:  m,
		Signature: base64.RawURLEncoding.EncodeToString(sig),
		KeyID:     keyID,
	}, nil
}

// Refusal reasons, kept separate so an operator can tell "we are up to date"
// from "somebody served us something we will not run".
var (
	ErrBadSignature = errors.New("netlink: update manifest signature is not valid")
	ErrUnknownKey   = errors.New("netlink: update manifest was signed by an unrecognised key")
	ErrExpired      = errors.New("netlink: update manifest has expired")
	ErrWrongChannel = errors.New("netlink: update manifest is for a different channel")
	ErrDowngrade    = errors.New("netlink: update manifest offers an older version")
	ErrTooOldToJump = errors.New("netlink: this version must update to an intermediate release first")
	ErrNoArtifact   = errors.New("netlink: update manifest has nothing for this platform")
	ErrChecksum     = errors.New("netlink: the downloaded file does not match the signed checksum")
	ErrMalformed    = errors.New("netlink: update manifest is malformed")
	ErrUnsafeURL    = errors.New("netlink: update artifact must be served over HTTPS")
)

// Verifier checks manifests against the keys this installation trusts.
type Verifier struct {
	// TrustedKeys maps key id to a release public key. A map so a key can be
	// rotated by publishing the new one before retiring the old.
	TrustedKeys map[string]ed25519.PublicKey
	// Current is the version running now.
	Current string
	Channel Channel
	Now     func() time.Time
}

func NewVerifier(current string, channel Channel, trusted map[string]ed25519.PublicKey) *Verifier {
	return &Verifier{TrustedKeys: trusted, Current: current, Channel: channel, Now: time.Now}
}

// Verify runs every check and returns the manifest only if all pass.
func (v *Verifier) Verify(env Envelope) (Manifest, error) {
	m := env.Manifest

	if m.Version == "" || len(m.Artifacts) == 0 {
		return Manifest{}, ErrMalformed
	}
	if !m.Channel.Valid() {
		return Manifest{}, ErrMalformed
	}
	if m.Channel != v.Channel {
		return Manifest{}, ErrWrongChannel
	}

	key, ok := v.TrustedKeys[env.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return Manifest{}, ErrUnknownKey
	}

	sig, err := base64.RawURLEncoding.DecodeString(env.Signature)
	if err != nil {
		return Manifest{}, ErrBadSignature
	}
	if !ed25519.Verify(key, SigningInput(m), sig) {
		return Manifest{}, ErrBadSignature
	}

	now := v.Now()
	if m.ExpiresAt.IsZero() || !now.Before(m.ExpiresAt) {
		return Manifest{}, ErrExpired
	}

	// A downgrade is what an attacker reaches for when they cannot forge a
	// signature: replay a genuine older release whose vulnerability they know.
	// Refusing it is why signing alone is not enough.
	switch CompareVersions(m.Version, v.Current) {
	case 0:
		return Manifest{}, ErrDowngrade
	case -1:
		return Manifest{}, ErrDowngrade
	}

	if m.Minimum != "" && CompareVersions(v.Current, m.Minimum) < 0 {
		return Manifest{}, ErrTooOldToJump
	}

	for _, artifact := range m.Artifacts {
		if !strings.HasPrefix(artifact.URL, "https://") {
			return Manifest{}, ErrUnsafeURL
		}
		if len(artifact.SHA256) != 64 {
			return Manifest{}, ErrMalformed
		}
		if _, err := hex.DecodeString(artifact.SHA256); err != nil {
			return Manifest{}, ErrMalformed
		}
	}

	return m, nil
}

// ArtifactFor finds the file for one component on one platform.
func (m Manifest) ArtifactFor(component, platform string) (Artifact, error) {
	for _, artifact := range m.Artifacts {
		if artifact.Component == component && artifact.Platform == platform {
			return artifact, nil
		}
	}
	return Artifact{}, ErrNoArtifact
}

/*
VerifyFile checks a downloaded file against the signed checksum.

The size is checked first and the read is bounded to it, so a server cannot
answer a 40 MB download with 40 GB and fill the disk of a machine that is only
trying to stay up to date.
*/
func VerifyFile(path string, artifact Artifact) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() != artifact.Bytes {
		return fmt.Errorf("%w: expected %d bytes, got %d", ErrChecksum, artifact.Bytes, info.Size())
	}

	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	digest := sha256.New()
	if _, err := io.Copy(digest, io.LimitReader(file, artifact.Bytes)); err != nil {
		return err
	}

	got := hex.EncodeToString(digest.Sum(nil))
	if got != strings.ToLower(artifact.SHA256) {
		return fmt.Errorf("%w: expected %s, got %s", ErrChecksum, artifact.SHA256, got)
	}
	return nil
}

/*
CompareVersions orders two semantic versions.

Returns -1 if a is older, 0 if equal, 1 if a is newer. A pre-release suffix
("1.2.0-beta.1") sorts *before* the release it precedes, per semver — which is
what makes "beta.2 then final" an upgrade rather than a downgrade.

Deliberately hand-written rather than pulled in: this function decides whether a
binary is allowed to replace the one currently running, and it is short enough
to read in full.
*/
func CompareVersions(a, b string) int {
	aCore, aPre := splitVersion(a)
	bCore, bPre := splitVersion(b)

	for i := 0; i < 3; i++ {
		if aCore[i] != bCore[i] {
			if aCore[i] < bCore[i] {
				return -1
			}
			return 1
		}
	}

	// Same numbers. A version with a pre-release suffix is older than one
	// without: 1.2.0-rc.1 comes before 1.2.0.
	switch {
	case aPre == "" && bPre == "":
		return 0
	case aPre == "":
		return 1
	case bPre == "":
		return -1
	case aPre < bPre:
		return -1
	case aPre > bPre:
		return 1
	default:
		return 0
	}
}

func splitVersion(version string) ([3]int, string) {
	version = strings.TrimPrefix(strings.TrimSpace(version), "v")

	pre := ""
	if index := strings.IndexAny(version, "-+"); index >= 0 {
		pre = version[index+1:]
		version = version[:index]
	}

	var parts [3]int
	for i, field := range strings.SplitN(version, ".", 3) {
		if i > 2 {
			break
		}
		// A field that is not a number contributes zero rather than failing.
		// A malformed version should not be able to make itself look newest.
		value, err := strconv.Atoi(field)
		if err != nil || value < 0 {
			value = 0
		}
		parts[i] = value
	}
	return parts, pre
}

// UnmarshalEnvelope parses a manifest off the wire.
func UnmarshalEnvelope(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return env, nil
}
