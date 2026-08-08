package identity

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
)

/*
Authenticated encryption for a key file, under a key held by the operating
system.

Windows does not need this — DPAPI seals and unseals the bytes itself. macOS
and Linux do, because their secret stores hold a *secret* rather than performing
the encryption: the store keeps a wrapping key, and this wraps the device key
under it.

AES-256-GCM rather than a stream cipher, because the property that matters is
not just confidentiality. A device key file that an attacker can flip bits in is
a device key file they can corrupt into a *different valid-looking key*, and the
agent would then present an identity nobody recognises and fail in a way nobody
could diagnose. GCM makes tampering a clean, immediate error.

The nonce is random and prepended. Ninety-six bits of randomness per encryption
is the standard construction, and this encrypts once per installation rather
than once per message, so nonce reuse is not a practical concern here.
*/

const (
	// wrappingKeySize is 32 bytes — AES-256.
	wrappingKeySize = 32
	nonceSize       = 12
)

// ErrTampered is returned when a key file does not authenticate.
var ErrTampered = errors.New("netlink: the device key file has been altered or the wrapping key is wrong")

func randomKey() ([]byte, error) {
	key := make([]byte, wrappingKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("netlink: could not generate a wrapping key: %w", err)
	}
	return key, nil
}

// sealWithKey encrypts plaintext, returning nonce || ciphertext || tag.
func sealWithKey(wrapping, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(wrapping)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("netlink: could not generate a nonce: %w", err)
	}

	// Seal appends to the nonce slice, so the result already carries the nonce
	// in front of the ciphertext.
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// openWithKey reverses sealWithKey.
func openWithKey(wrapping, sealed []byte) ([]byte, error) {
	gcm, err := newGCM(wrapping)
	if err != nil {
		return nil, err
	}
	if len(sealed) < nonceSize+gcm.Overhead() {
		return nil, ErrTampered
	}

	plaintext, err := gcm.Open(nil, sealed[:nonceSize], sealed[nonceSize:], nil)
	if err != nil {
		// Deliberately does not distinguish "wrong key" from "modified bytes".
		// Both mean the same thing to a caller — this file cannot be trusted —
		// and telling them apart would help someone probing it.
		return nil, ErrTampered
	}
	return plaintext, nil
}

func newGCM(wrapping []byte) (cipher.AEAD, error) {
	if len(wrapping) != wrappingKeySize {
		return nil, errors.New("netlink: the wrapping key is the wrong size")
	}
	block, err := aes.NewCipher(wrapping)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
