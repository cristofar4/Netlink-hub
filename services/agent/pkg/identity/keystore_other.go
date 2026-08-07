//go:build !windows

package identity

// filePermissionKeyStore is the non-Windows fallback.
//
// It applies no cryptographic protection of its own — the private key is
// protected only by the 0600 file mode that Store.Create sets. This exists so
// the agent builds and its logic can be tested on a developer's Linux or macOS
// machine. It is not equivalent to DPAPI, and Name() says so rather than
// letting the UI imply a protection that is not there.
//
// A macOS build intended for real use would implement this against the
// Keychain, and a Linux one against the Secret Service API.
type filePermissionKeyStore struct{}

func newPlatformKeyStore() KeyStore { return filePermissionKeyStore{} }

func (filePermissionKeyStore) Name() string { return "file-permissions-only" }

func (filePermissionKeyStore) Protect(plaintext []byte) ([]byte, error) {
	out := make([]byte, len(plaintext))
	copy(out, plaintext)
	return out, nil
}

func (filePermissionKeyStore) Unprotect(ciphertext []byte) ([]byte, error) {
	out := make([]byte, len(ciphertext))
	copy(out, ciphertext)
	return out, nil
}
