package identity

import (
	"bytes"
	"errors"
	"testing"
)

/*
The wrapping used by the macOS and Linux key stores.

Windows does not use this — DPAPI seals the bytes itself — but every other
platform stores a wrapping key in the OS secret store and wraps the device key
under it, so this is the code standing between a copied key file and a usable
identity.
*/

func TestAKeyRoundTrips(t *testing.T) {
	key, err := randomKey()
	if err != nil {
		t.Fatalf("generating a key: %v", err)
	}

	secret := []byte("this is a device private key")
	sealed, err := sealWithKey(key, secret)
	if err != nil {
		t.Fatalf("sealing: %v", err)
	}

	opened, err := openWithKey(key, sealed)
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	if !bytes.Equal(opened, secret) {
		t.Fatalf("round trip changed the key: %q", opened)
	}
}

// The point of the whole exercise: the file alone is worth nothing.
func TestADifferentWrappingKeyCannotOpenIt(t *testing.T) {
	mine, _ := randomKey()
	theirs, _ := randomKey()

	sealed, err := sealWithKey(mine, []byte("device private key"))
	if err != nil {
		t.Fatalf("sealing: %v", err)
	}

	if _, err := openWithKey(theirs, sealed); !errors.Is(err, ErrTampered) {
		t.Fatalf("err = %v, want ErrTampered — a key file copied to another machine opened", err)
	}
}

/*
Authenticated, not merely encrypted.

A stream cipher would decrypt a modified file into a *different valid-looking
key*, and the agent would then present an identity nobody recognises and fail
in a way nobody could diagnose. GCM makes tampering an immediate, clean error.
*/
func TestFlippingASingleBitIsDetected(t *testing.T) {
	key, _ := randomKey()
	sealed, err := sealWithKey(key, []byte("device private key"))
	if err != nil {
		t.Fatalf("sealing: %v", err)
	}

	for index := range sealed {
		tampered := make([]byte, len(sealed))
		copy(tampered, sealed)
		tampered[index] ^= 0x01

		if _, err := openWithKey(key, tampered); !errors.Is(err, ErrTampered) {
			t.Fatalf("flipping bit %d went undetected", index)
		}
	}
}

func TestTruncationIsDetected(t *testing.T) {
	key, _ := randomKey()
	sealed, _ := sealWithKey(key, []byte("device private key"))

	for length := 0; length < len(sealed); length++ {
		if _, err := openWithKey(key, sealed[:length]); !errors.Is(err, ErrTampered) {
			t.Fatalf("a file truncated to %d bytes opened", length)
		}
	}
}

// Two seals of the same key must differ, or the file leaks that nothing changed
// between two installations.
func TestSealingTwiceProducesDifferentBytes(t *testing.T) {
	key, _ := randomKey()
	secret := []byte("device private key")

	first, _ := sealWithKey(key, secret)
	second, _ := sealWithKey(key, secret)

	if bytes.Equal(first, second) {
		t.Fatal("two seals of the same input were identical — the nonce is not random")
	}
}

func TestAWrongSizedWrappingKeyIsRefused(t *testing.T) {
	for _, size := range []int{0, 16, 31, 33, 64} {
		if _, err := sealWithKey(make([]byte, size), []byte("x")); err == nil {
			t.Fatalf("a %d-byte wrapping key was accepted", size)
		}
	}
}

func TestGeneratedKeysAreTheRightSizeAndNotRepeated(t *testing.T) {
	seen := map[string]bool{}
	for attempt := 0; attempt < 50; attempt++ {
		key, err := randomKey()
		if err != nil {
			t.Fatalf("generating: %v", err)
		}
		if len(key) != wrappingKeySize {
			t.Fatalf("key is %d bytes, want %d", len(key), wrappingKeySize)
		}
		if seen[string(key)] {
			t.Fatal("the same wrapping key was generated twice")
		}
		seen[string(key)] = true
	}
}
