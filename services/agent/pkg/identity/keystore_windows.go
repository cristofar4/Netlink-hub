//go:build windows

package identity

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// dpapiKeyStore protects the device private key with the Windows Data
// Protection API, scoped to the local machine.
//
// CRYPTPROTECT_LOCAL_MACHINE is required because the agent runs as a Windows
// service under LocalSystem while the desktop app runs as the signed-in user;
// a user-scoped blob written by one could not be read by the other. The
// additional entropy below means another process on the same machine cannot
// unprotect the key by calling CryptUnprotectData with default parameters —
// it must also know this value.
type dpapiKeyStore struct{}

func newPlatformKeyStore() KeyStore { return dpapiKeyStore{} }

func (dpapiKeyStore) Name() string { return "windows-dpapi" }

// Bound into every blob so a DPAPI decrypt attempt from unrelated software
// fails even when it runs on the same machine.
var dpapiEntropy = []byte("netlink.device-identity.v1")

const cryptProtectLocalMachine = 0x4

func (dpapiKeyStore) Protect(plaintext []byte) ([]byte, error) {
	in := newBlob(plaintext)
	entropy := newBlob(dpapiEntropy)
	var out windows.DataBlob

	if err := windows.CryptProtectData(&in, nil, &entropy, 0, nil, cryptProtectLocalMachine, &out); err != nil {
		return nil, fmt.Errorf("CryptProtectData: %w", err)
	}
	defer localFree(out.Data)

	return copyBlob(out), nil
}

func (dpapiKeyStore) Unprotect(ciphertext []byte) ([]byte, error) {
	in := newBlob(ciphertext)
	entropy := newBlob(dpapiEntropy)
	var out windows.DataBlob

	if err := windows.CryptUnprotectData(&in, nil, &entropy, 0, nil, cryptProtectLocalMachine, &out); err != nil {
		return nil, fmt.Errorf("CryptUnprotectData: %w", err)
	}
	defer localFree(out.Data)

	return copyBlob(out), nil
}

func newBlob(data []byte) windows.DataBlob {
	if len(data) == 0 {
		return windows.DataBlob{Size: 0, Data: nil}
	}
	return windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
}

// copyBlob copies out of the LocalAlloc'd buffer before it is freed.
func copyBlob(blob windows.DataBlob) []byte {
	if blob.Size == 0 || blob.Data == nil {
		return nil
	}
	src := unsafe.Slice(blob.Data, blob.Size)
	dst := make([]byte, blob.Size)
	copy(dst, src)
	return dst
}

func localFree(ptr *byte) {
	if ptr != nil {
		_, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(ptr)))
	}
}
