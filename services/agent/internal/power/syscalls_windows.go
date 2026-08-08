//go:build windows

package power

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Lock and sleep have no command-line equivalent worth shelling out for, so
// they are called directly. Both are documented, stable Win32 entry points.
var (
	user32              = windows.NewLazySystemDLL("user32.dll")
	powrprof            = windows.NewLazySystemDLL("powrprof.dll")
	procLockWorkStation = user32.NewProc("LockWorkStation")
	procSetSuspendState = powrprof.NewProc("SetSuspendState")
)

func lockWorkstation() error {
	result, _, err := procLockWorkStation.Call()
	if result == 0 {
		return fmt.Errorf("netlink: LockWorkStation failed: %w", err)
	}
	return nil
}

// suspend puts the machine to sleep.
//
// SetSuspendState(hibernate=0, force=0, wakeEventsDisabled=0): sleep rather
// than hibernate, and force=0 so an application that has a good reason to
// object still can. Forcing it would make "sleep" able to discard unsaved work,
// which is not what a sleep button should ever do.
func suspend() error {
	result, _, err := procSetSuspendState.Call(0, 0, 0)
	if result == 0 {
		return fmt.Errorf("netlink: SetSuspendState failed: %w", err)
	}
	return nil
}
