package client

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// randomNonce returns 128 bits of randomness, base64url encoded.
func randomNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("netlink: generating nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
