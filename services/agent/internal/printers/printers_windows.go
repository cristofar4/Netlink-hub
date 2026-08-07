//go:build windows

package printers

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

/*
Windows printer discovery.

This shells out to PowerShell's Get-Printer rather than binding winspool
directly. The reasons are practical: Get-Printer already normalises the status
enumeration and the driver metadata across Windows versions, it needs no
elevation, and a printer list is not a hot path — it is read every fifteen
minutes at most. Binding EnumPrinters would mean maintaining struct layouts for
several PRINTER_INFO levels for no behavioural gain.

The command takes no user input, so there is nothing to inject into it.
*/

const discoveryScript = `Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Location,Comment | ConvertTo-Json -Compress -Depth 3`
const defaultPrinterScript = `(Get-CimInstance -Class Win32_Printer -Filter "Default = $true" | Select-Object -First 1).Name`

type rawPrinter struct {
	Name          string `json:"Name"`
	DriverName    string `json:"DriverName"`
	PortName      string `json:"PortName"`
	PrinterStatus any    `json:"PrinterStatus"`
	Location      string `json:"Location"`
	Comment       string `json:"Comment"`
}

func discover(ctx context.Context) ([]Printer, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	output, err := runPowerShell(ctx, discoveryScript)
	if err != nil {
		return nil, fmt.Errorf("netlink: listing printers: %w", err)
	}
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return nil, nil
	}

	// ConvertTo-Json emits an object rather than an array for a single printer.
	if !strings.HasPrefix(trimmed, "[") {
		trimmed = "[" + trimmed + "]"
	}

	var raws []rawPrinter
	if err := json.Unmarshal([]byte(trimmed), &raws); err != nil {
		return nil, fmt.Errorf("netlink: reading the printer list: %w", err)
	}

	// Best effort — an unknown default simply means no printer is marked.
	defaultName := ""
	if out, err := runPowerShell(ctx, defaultPrinterScript); err == nil {
		defaultName = strings.TrimSpace(out)
	}

	printers := make([]Printer, 0, len(raws))
	for _, raw := range raws {
		if strings.TrimSpace(raw.Name) == "" {
			continue
		}
		printers = append(printers, Printer{
			Name:      raw.Name,
			Driver:    raw.DriverName,
			PortName:  raw.PortName,
			Status:    normaliseStatus(raw.PrinterStatus),
			IsDefault: defaultName != "" && strings.EqualFold(defaultName, raw.Name),
			Location:  raw.Location,
			Comment:   raw.Comment,
		})
	}
	return printers, nil
}

func runPowerShell(ctx context.Context, script string) (string, error) {
	cmd := exec.CommandContext(ctx, "powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

// normaliseStatus turns the Windows printer-status value into the three words a
// person actually needs: ready, offline or error.
//
// The enumeration is a bit field with a dozen members; collapsing it is more
// honest than surfacing "PaperProblem, DoorOpen" in a status pill.
func normaliseStatus(value any) string {
	switch typed := value.(type) {
	case string:
		return statusFromName(typed)
	case float64:
		return statusFromCode(int(typed))
	case int:
		return statusFromCode(typed)
	default:
		return "unknown"
	}
}

func statusFromName(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "normal", "idle", "printing", "processing", "warmingup":
		return "ready"
	case "offline", "notavailable", "paused":
		return "offline"
	case "":
		return "unknown"
	default:
		return "error"
	}
}

func statusFromCode(code int) string {
	// MSFT_Printer.PrinterStatus: 3 = Idle, 4 = Printing, 5 = Warming Up.
	switch code {
	case 3, 4, 5:
		return "ready"
	case 1, 2:
		return "unknown"
	case 7, 9:
		return "offline"
	default:
		return "error"
	}
}
