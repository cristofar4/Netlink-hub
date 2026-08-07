package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(t.TempDir())
}

func TestCreateGeneratesUsableIdentity(t *testing.T) {
	store := newTestStore(t)

	ident, err := store.Create("Home PC")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if ident.Algorithm != "ed25519" {
		t.Errorf("algorithm = %q, want ed25519", ident.Algorithm)
	}
	if ident.DeviceName != "Home PC" {
		t.Errorf("device name = %q", ident.DeviceName)
	}

	pub, err := ident.PublicKeyBytes()
	if err != nil {
		t.Fatalf("PublicKeyBytes: %v", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		t.Errorf("public key is %d bytes, want %d", len(pub), ed25519.PublicKeySize)
	}

	if got := len(ident.InstallationID); got != 36 {
		t.Errorf("installation id length = %d, want 36 (UUID)", got)
	}
	if ident.InstallationID[14] != '4' {
		t.Errorf("installation id is not a v4 UUID: %s", ident.InstallationID)
	}
}

func TestEveryInstallationGetsItsOwnKey(t *testing.T) {
	// The whole point of per-device identity: two installations must never
	// share a key, so revoking one cannot affect the other.
	first, err := newTestStore(t).Create("PC A")
	if err != nil {
		t.Fatalf("Create A: %v", err)
	}
	second, err := newTestStore(t).Create("PC B")
	if err != nil {
		t.Fatalf("Create B: %v", err)
	}

	if first.PublicKey == second.PublicKey {
		t.Error("two installations produced the same public key")
	}
	if first.InstallationID == second.InstallationID {
		t.Error("two installations produced the same installation id")
	}
}

func TestPrivateKeyIsNeverWrittenToTheIdentityFile(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	ident, err := store.Create("Home PC")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil {
		t.Fatalf("reading identity.json: %v", err)
	}

	priv := base64.RawURLEncoding.EncodeToString(ident.PrivateKey())
	if strings.Contains(string(raw), priv) {
		t.Fatal("identity.json contains the private key")
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("identity.json is not valid JSON: %v", err)
	}
	for _, forbidden := range []string{"privateKey", "private_key", "secret", "key"} {
		if _, present := decoded[forbidden]; present {
			t.Errorf("identity.json exposes a %q field", forbidden)
		}
	}
}

func TestKeyFileIsNotWorldReadable(t *testing.T) {
	if os.Getuid() == 0 {
		// Running as root makes the permission check meaningless on some CI
		// images; the mode is still asserted below.
		t.Log("running as root; asserting mode bits only")
	}
	dir := t.TempDir()
	if _, err := NewStore(dir).Create("Home PC"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	info, err := os.Stat(filepath.Join(dir, "device.key"))
	if err != nil {
		t.Fatalf("stat device.key: %v", err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		t.Errorf("device.key mode is %o, want no group or world access", mode)
	}
}

func TestLoadRoundTrips(t *testing.T) {
	dir := t.TempDir()
	created, err := NewStore(dir).Create("Home PC")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := NewStore(dir).Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if loaded.InstallationID != created.InstallationID {
		t.Errorf("installation id changed across load")
	}
	if loaded.PublicKey != created.PublicKey {
		t.Errorf("public key changed across load")
	}
	if !loaded.PrivateKey().Equal(created.PrivateKey()) {
		t.Errorf("private key changed across load")
	}
}

func TestLoadReportsNotEnrolled(t *testing.T) {
	_, err := NewStore(t.TempDir()).Load()
	if !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestCreateRefusesToOverwrite(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	if _, err := store.Create("Home PC"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := store.Create("Home PC"); err == nil {
		t.Fatal("Create overwrote an existing identity")
	}
}

func TestLoadOrCreateIsStable(t *testing.T) {
	dir := t.TempDir()

	first, err := NewStore(dir).LoadOrCreate("Home PC")
	if err != nil {
		t.Fatalf("first LoadOrCreate: %v", err)
	}
	second, err := NewStore(dir).LoadOrCreate("Home PC")
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}

	if first.InstallationID != second.InstallationID {
		t.Error("LoadOrCreate produced a new identity for an enrolled installation")
	}
}

func TestLoadRejectsMismatchedKeyPair(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewStore(dir).Create("Home PC"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Swap in a private key from a different pair.
	_, otherPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	ks := newPlatformKeyStore()
	protected, err := ks.Protect(otherPriv)
	if err != nil {
		t.Fatalf("Protect: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "device.key"), protected, 0o600); err != nil {
		t.Fatalf("writing tampered key: %v", err)
	}

	if _, err := NewStore(dir).Load(); err == nil {
		t.Fatal("Load accepted a private key that does not match the public key")
	}
}

func TestLoadRejectsCorruptIdentityFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewStore(dir).Create("Home PC"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "identity.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("corrupting identity: %v", err)
	}
	if _, err := NewStore(dir).Load(); err == nil {
		t.Fatal("Load accepted a corrupt identity file")
	}
}

func TestSignAndVerify(t *testing.T) {
	ident, err := newTestStore(t).Create("Home PC")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	msg := []byte("netlink heartbeat")
	sig, err := ident.Sign(msg)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	if !Verify(ident.PublicKey, msg, sig) {
		t.Error("a signature from this identity did not verify against its public key")
	}
	if Verify(ident.PublicKey, []byte("different message"), sig) {
		t.Error("a signature verified against a message it was not made over")
	}

	other, err := newTestStore(t).Create("Other PC")
	if err != nil {
		t.Fatalf("Create other: %v", err)
	}
	if Verify(other.PublicKey, msg, sig) {
		t.Error("a signature verified against an unrelated device's public key")
	}
}

func TestResetForcesFreshEnrollment(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	first, err := store.Create("Home PC")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("after Reset, Load err = %v, want ErrNotEnrolled", err)
	}

	// A revoked device must come back as a genuinely new one, not the old one.
	second, err := store.Create("Home PC")
	if err != nil {
		t.Fatalf("re-Create: %v", err)
	}
	if second.InstallationID == first.InstallationID {
		t.Error("re-enrollment reused the previous installation id")
	}
	if second.PublicKey == first.PublicKey {
		t.Error("re-enrollment reused the previous key pair")
	}
}

func TestResetIsIdempotent(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := store.Reset(); err != nil {
		t.Fatalf("Reset on empty dir: %v", err)
	}
}

func TestPublicKeyBytesRejectsGarbage(t *testing.T) {
	for _, key := range []string{"", "not base64!!", base64.RawURLEncoding.EncodeToString([]byte("short"))} {
		ident := &Identity{PublicKey: key}
		if _, err := ident.PublicKeyBytes(); err == nil {
			t.Errorf("PublicKeyBytes accepted %q", key)
		}
	}
}

func TestVerifyRejectsMalformedKey(t *testing.T) {
	if Verify("not base64!!", []byte("x"), []byte("y")) {
		t.Error("Verify accepted a malformed public key")
	}
	if Verify("", []byte("x"), []byte("y")) {
		t.Error("Verify accepted an empty public key")
	}
}

func TestKeyStoreRoundTrip(t *testing.T) {
	ks := newPlatformKeyStore()
	secret := []byte("a device private key would go here")

	protected, err := ks.Protect(secret)
	if err != nil {
		t.Fatalf("Protect: %v", err)
	}
	recovered, err := ks.Unprotect(protected)
	if err != nil {
		t.Fatalf("Unprotect: %v", err)
	}
	if string(recovered) != string(secret) {
		t.Error("Unprotect(Protect(x)) != x")
	}
	if ks.Name() == "" {
		t.Error("key store must report which protection it uses")
	}
}
