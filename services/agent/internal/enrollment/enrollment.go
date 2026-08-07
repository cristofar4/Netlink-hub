// Package enrollment persists what the control plane assigned this
// installation once it joined a Space.
//
// The device key identifies the machine; this records where it belongs. It is
// kept beside the identity but in a separate file, because the two have
// different lifetimes: revoking and re-enrolling into another Space must not
// require regenerating the key pair.
package enrollment

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ErrNotEnrolled means this installation has not joined a Space yet.
var ErrNotEnrolled = errors.New("netlink: this installation has not been enrolled into a Space")

type Enrollment struct {
	DeviceID   string    `json:"deviceId"`
	SpaceID    string    `json:"spaceId"`
	SpaceName  string    `json:"spaceName"`
	EnrolledAt time.Time `json:"enrolledAt"`
}

type Store struct {
	dir string
}

func NewStore(dir string) *Store { return &Store{dir: dir} }

func (s *Store) path() string { return filepath.Join(s.dir, "enrollment.json") }

func (s *Store) Load() (*Enrollment, error) {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}
	if err != nil {
		return nil, fmt.Errorf("netlink: reading enrollment: %w", err)
	}

	var enrollment Enrollment
	if err := json.Unmarshal(raw, &enrollment); err != nil {
		// A corrupt file is treated as "not enrolled" rather than a hard error,
		// so the agent re-enrolls instead of refusing to start.
		return nil, ErrNotEnrolled
	}
	if enrollment.DeviceID == "" || enrollment.SpaceID == "" {
		return nil, ErrNotEnrolled
	}
	return &enrollment, nil
}

func (s *Store) Save(enrollment Enrollment) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("netlink: creating data directory: %w", err)
	}
	encoded, err := json.MarshalIndent(enrollment, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.path(), encoded, 0o600); err != nil {
		return fmt.Errorf("netlink: writing enrollment: %w", err)
	}
	return nil
}

// Clear forgets the Space assignment, leaving the device identity intact.
func (s *Store) Clear() error {
	if err := os.Remove(s.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("netlink: removing enrollment: %w", err)
	}
	return nil
}
