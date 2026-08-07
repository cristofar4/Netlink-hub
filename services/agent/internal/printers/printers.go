// Package printers discovers printers installed on this computer.
//
// Discovery is not sharing. Everything found here is reported to the control
// plane disabled, and stays unreachable until the owner explicitly enables it.
package printers

import "context"

// Printer is one printer the operating system knows about.
type Printer struct {
	Name      string `json:"name"`
	Driver    string `json:"driver"`
	PortName  string `json:"portName"`
	Status    string `json:"status"`
	IsDefault bool   `json:"isDefault"`
	// Location and Comment are whatever the owner set in Windows. They are
	// useful for telling two office printers apart and are not sensitive.
	Location string `json:"location,omitempty"`
	Comment  string `json:"comment,omitempty"`
}

// Discover lists installed printers. The Windows implementation reads them from
// the spooler; other platforms return nothing rather than pretending.
func Discover(ctx context.Context) ([]Printer, error) {
	return discover(ctx)
}
