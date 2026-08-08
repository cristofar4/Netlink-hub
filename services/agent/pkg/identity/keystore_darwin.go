//go:build darwin

package identity

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

/*
macOS key protection, via the login Keychain.

This is the counterpart of the Windows DPAPI store, and it does the same job:
the private key on disk is useless without the operating system's cooperation,
so copying the file to another machine gains nothing.

**Why the `security` command rather than the Security framework directly.**
Binding SecItemAdd would need cgo, and cgo would cost the agent the property
that makes it easy to ship — one static binary, cross-compilable from any
machine, with no Xcode toolchain in the build. The `security` tool is part of
macOS, is present on every install, and talks to the same Keychain the framework
does. A key is protected once and read once per process start; this is not a hot
path where an exec matters.

**What this actually protects against.** The Keychain item is bound to this
account on this machine. Another user on the same Mac cannot read it, and the
file copied to a different Mac decrypts to nothing. It does *not* protect
against a process running as this same user with Keychain access already
granted — the same limit DPAPI has on Windows, and for the same reason: at that
point the attacker is already you.

**What is stored where.** The Keychain holds a random 32-byte wrapping key. The
key file on disk holds the device key encrypted under it. The private key itself
never goes into the Keychain, because a Keychain item has a size limit that a
future larger key could exceed, and because keeping the file the single source
of truth means one code path for "is this installation enrolled".
*/

const (
	keychainService = "com.netlink.agent"
	keychainAccount = "device-key-wrap"
)

type keychainKeyStore struct{}

func newPlatformKeyStore() KeyStore { return keychainKeyStore{} }

func (keychainKeyStore) Name() string { return "macos-keychain" }

func (k keychainKeyStore) Protect(plaintext []byte) ([]byte, error) {
	wrapping, err := k.wrappingKey()
	if err != nil {
		return nil, err
	}
	return sealWithKey(wrapping, plaintext)
}

func (k keychainKeyStore) Unprotect(ciphertext []byte) ([]byte, error) {
	wrapping, err := k.wrappingKey()
	if err != nil {
		return nil, err
	}
	return openWithKey(wrapping, ciphertext)
}

/*
wrappingKey reads the wrapping key from the Keychain, creating it on first use.

The create path deliberately uses `-U` (update if present) so two agents racing
on first start converge on one key rather than one of them silently overwriting
the other's — which would leave the loser unable to read the key file it just
wrote.
*/
func (k keychainKeyStore) wrappingKey() ([]byte, error) {
	existing, err := k.read()
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, errNoKeychainItem) {
		return nil, err
	}

	fresh, err := randomKey()
	if err != nil {
		return nil, err
	}
	if err := k.write(fresh); err != nil {
		return nil, err
	}

	// Read back rather than trusting the write. If another process won the
	// race, its key is the real one and ours must be discarded.
	return k.read()
}

func (keychainKeyStore) read() ([]byte, error) {
	cmd := exec.Command(
		"security", "find-generic-password",
		"-s", keychainService,
		"-a", keychainAccount,
		"-w", // print only the password
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// `security` exits 44 for "item not found", which is the ordinary first
		// run rather than a failure. Anything else is a real problem — a locked
		// Keychain, or a denied prompt — and must not be mistaken for it.
		if strings.Contains(stderr.String(), "could not be found") {
			return nil, errNoKeychainItem
		}
		return nil, fmt.Errorf("netlink: could not read the Keychain: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(stdout.String()))
	if err != nil {
		return nil, fmt.Errorf("netlink: the Keychain item is not valid: %w", err)
	}
	if len(decoded) != wrappingKeySize {
		return nil, errors.New("netlink: the Keychain item is the wrong size")
	}
	return decoded, nil
}

func (keychainKeyStore) write(key []byte) error {
	cmd := exec.Command(
		"security", "add-generic-password",
		"-s", keychainService,
		"-a", keychainAccount,
		"-w", base64.StdEncoding.EncodeToString(key),
		"-U", // update rather than fail if it already exists
		// Only this binary may read it without a prompt. Without -T the item is
		// readable by any application the user approves, which turns a Keychain
		// entry into a shared secret.
		"-T", selfPath(),
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("netlink: could not write to the Keychain: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

var errNoKeychainItem = errors.New("netlink: no Keychain item yet")

// selfPath returns this executable's path, for the Keychain access control
// list. An empty string is acceptable to `security` and simply means the user
// is prompted the first time — a worse experience, not a wrong one.
func selfPath() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
}
