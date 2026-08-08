//go:build !windows && !darwin

package printers

import "context"

// discover returns nothing on non-Windows platforms.
//
// NetLink ships as a Windows product; the agent builds elsewhere so its logic
// can be developed and tested on a developer machine. Returning an empty list
// rather than a fabricated one keeps the rest of the system honest — a
// developer sees "no printers", which is true, instead of a fake one.
func discover(_ context.Context) ([]Printer, error) {
	return nil, nil
}
