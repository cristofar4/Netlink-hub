// Package identity manages this installation's device key pair.
//
// Every NetLink installation generates its own Ed25519 key pair on first run.
// The private key never leaves the machine and is never sent to the control
// plane; only the public key is enrolled. There is deliberately no shared or
// baked-in key, so compromising one device tells an attacker nothing about any
// other device.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ErrNotEnrolled is returned when no identity exists on this machine yet.
var ErrNotEnrolled = errors.New("netlink: this installation has no device identity yet")

// Identity is the on-disk record of who this installation is.
//
// PrivateKey is stored separately and protected by the platform key store; it
// is never part of the JSON written to disk.
type Identity struct {
	// InstallationID is generated once, at first run, and never changes.
	InstallationID string    `json:"installationId"`
	PublicKey      string    `json:"publicKey"`
	Algorithm      string    `json:"publicKeyAlgorithm"`
	DeviceName     string    `json:"deviceName"`
	CreatedAt      time.Time `json:"createdAt"`

	privateKey ed25519.PrivateKey
}

// PrivateKey exposes the signing key to callers inside this process only.
func (i *Identity) PrivateKey() ed25519.PrivateKey { return i.privateKey }

// Sign produces a detached Ed25519 signature over msg.
//
// This is what makes a power command or a heartbeat provably from this device
// rather than from anyone who has learned its identifier.
func (i *Identity) Sign(msg []byte) ([]byte, error) {
	if len(i.privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("netlink: identity has no usable private key")
	}
	return ed25519.Sign(i.privateKey, msg), nil
}

// PublicKeyBytes decodes the stored base64url public key.
func (i *Identity) PublicKeyBytes() (ed25519.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(i.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("netlink: public key is not valid base64url: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("netlink: public key is %d bytes, expected %d", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

// Verify checks a signature against this identity's public key. Used by tests
// and by the desktop app when it validates something the agent signed.
func Verify(publicKeyB64 string, msg, sig []byte) bool {
	raw, err := base64.RawURLEncoding.DecodeString(publicKeyB64)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(raw), msg, sig)
}

// KeyStore protects the private key at rest.
//
// On Windows this is DPAPI (see keystore_windows.go); elsewhere it is a
// restricted-permission file, which is enough for development but is not
// claimed to be equivalent.
type KeyStore interface {
	// Name identifies the protection actually in use, so the UI can tell the
	// truth about how the key is protected.
	Name() string
	Protect(plaintext []byte) ([]byte, error)
	Unprotect(ciphertext []byte) ([]byte, error)
}

// Store reads and writes the identity for one installation directory.
type Store struct {
	dir      string
	keyStore KeyStore
}

// NewStore returns a Store rooted at dir, using the platform key store.
func NewStore(dir string) *Store {
	return &Store{dir: dir, keyStore: newPlatformKeyStore()}
}

// NewStoreWithKeyStore lets tests inject a key store.
func NewStoreWithKeyStore(dir string, ks KeyStore) *Store {
	return &Store{dir: dir, keyStore: ks}
}

// KeyStoreName reports the protection in use for the private key.
func (s *Store) KeyStoreName() string { return s.keyStore.Name() }

func (s *Store) identityPath() string { return filepath.Join(s.dir, "identity.json") }
func (s *Store) keyPath() string      { return filepath.Join(s.dir, "device.key") }

// Load reads the existing identity, or returns ErrNotEnrolled.
func (s *Store) Load() (*Identity, error) {
	raw, err := os.ReadFile(s.identityPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}
	if err != nil {
		return nil, fmt.Errorf("netlink: reading identity: %w", err)
	}

	var ident Identity
	if err := json.Unmarshal(raw, &ident); err != nil {
		return nil, fmt.Errorf("netlink: identity file is corrupt: %w", err)
	}

	protected, err := os.ReadFile(s.keyPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}
	if err != nil {
		return nil, fmt.Errorf("netlink: reading device key: %w", err)
	}

	priv, err := s.keyStore.Unprotect(protected)
	if err != nil {
		return nil, fmt.Errorf("netlink: device key could not be unprotected: %w", err)
	}
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("netlink: device key is %d bytes, expected %d", len(priv), ed25519.PrivateKeySize)
	}
	ident.privateKey = ed25519.PrivateKey(priv)

	// A private key that does not match the recorded public key means the pair
	// was tampered with; refuse it rather than enrolling a mismatched identity.
	pub, err := ident.PublicKeyBytes()
	if err != nil {
		return nil, err
	}
	if !pub.Equal(ident.privateKey.Public()) {
		return nil, errors.New("netlink: device key does not match the recorded public key")
	}

	return &ident, nil
}

// Create generates a new key pair and writes it. It refuses to overwrite an
// existing identity, so a stray call cannot silently orphan an enrolled device.
func (s *Store) Create(deviceName string) (*Identity, error) {
	if _, err := os.Stat(s.identityPath()); err == nil {
		return nil, errors.New("netlink: an identity already exists for this installation")
	}

	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return nil, fmt.Errorf("netlink: creating identity directory: %w", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("netlink: generating device key: %w", err)
	}

	installationID, err := newUUIDv4()
	if err != nil {
		return nil, err
	}

	ident := &Identity{
		InstallationID: installationID,
		PublicKey:      base64.RawURLEncoding.EncodeToString(pub),
		Algorithm:      "ed25519",
		DeviceName:     deviceName,
		CreatedAt:      time.Now().UTC(),
		privateKey:     priv,
	}

	protected, err := s.keyStore.Protect(priv)
	if err != nil {
		return nil, fmt.Errorf("netlink: protecting device key: %w", err)
	}
	// 0600 so that even before DPAPI is considered, the file is not readable by
	// other users on the machine.
	if err := os.WriteFile(s.keyPath(), protected, 0o600); err != nil {
		return nil, fmt.Errorf("netlink: writing device key: %w", err)
	}

	encoded, err := json.MarshalIndent(ident, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.identityPath(), encoded, 0o600); err != nil {
		return nil, fmt.Errorf("netlink: writing identity: %w", err)
	}

	return ident, nil
}

// LoadOrCreate is what the agent and the desktop app call at startup.
func (s *Store) LoadOrCreate(deviceName string) (*Identity, error) {
	ident, err := s.Load()
	if err == nil {
		return ident, nil
	}
	if !errors.Is(err, ErrNotEnrolled) {
		return nil, err
	}
	return s.Create(deviceName)
}

// Reset removes this installation's identity.
//
// Used when the owner revokes the device from another machine: the next start
// enrolls as a genuinely new device rather than resurrecting a revoked one.
func (s *Store) Reset() error {
	for _, path := range []string{s.keyPath(), s.identityPath()} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("netlink: removing %s: %w", filepath.Base(path), err)
		}
	}
	return nil
}

// newUUIDv4 builds a RFC 4122 version-4 UUID from crypto/rand, avoiding a
// dependency for the one place the agent needs one.
func newUUIDv4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("netlink: generating installation id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
