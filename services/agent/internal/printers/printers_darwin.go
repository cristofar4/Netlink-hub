//go:build darwin

package printers

import (
	"bufio"
	"bytes"
	"context"
	"os/exec"
	"strings"
	"time"
)

/*
macOS printer discovery, via CUPS.

macOS printing *is* CUPS, and `lpstat` is its supported query interface. This
parses two calls rather than one because CUPS separates the two facts NetLink
needs: `-p` lists printers and their state, `-d` names the default. Asking for
both in one call (`lpstat -p -d`) works but interleaves the output in a way that
is more fragile to parse than two clean calls.

No elevation, no cgo, no third-party dependency. A printer list is read every
fifteen minutes at most, so two execs is not a cost worth optimising.
*/

func discover(ctx context.Context) ([]Printer, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	listing, err := run(ctx, "lpstat", "-p")
	if err != nil {
		// No printers configured makes lpstat exit non-zero on some versions.
		// That is "none", not a failure, and reporting an error would make the
		// owner think discovery is broken when it is simply empty.
		return nil, nil
	}

	fallbackDefault, _ := run(ctx, "lpstat", "-d")
	defaultName := parseDefault(fallbackDefault)

	printers := parseListing(listing)
	for index := range printers {
		printers[index].IsDefault = printers[index].Name == defaultName
	}
	return printers, nil
}

/*
parseListing reads `lpstat -p` output.

Each printer produces a line like:

	printer Office_Laser is idle.  enabled since Tue  3 Mar 11:04:22 2026
	printer Old_Inkjet disabled since Mon  2 Mar 09:00:00 2026 -
	        Paused

Only the first line of each entry matters. Continuation lines are indented, so
they are skipped by requiring the "printer " prefix — which also means an
unexpected line cannot be mistaken for a printer with a strange name.
*/
func parseListing(output string) []Printer {
	var printers []Printer

	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "printer ") {
			continue
		}

		rest := strings.TrimPrefix(line, "printer ")
		name, state, found := strings.Cut(rest, " ")
		if !found || name == "" {
			continue
		}

		printers = append(printers, Printer{
			Name:   name,
			Status: normaliseState(state),
			// CUPS reports the queue name and its state; the driver and port are
			// Windows concepts with no clean equivalent, and inventing a value
			// would be worse than leaving them empty.
		})
	}
	return printers
}

/*
normaliseState maps CUPS wording onto the same vocabulary the Windows agent
reports, so the desktop and phone show one set of words for one set of states
rather than a different dialect per platform.
*/
func normaliseState(state string) string {
	lower := strings.ToLower(state)
	switch {
	case strings.Contains(lower, "is idle"), strings.Contains(lower, "now printing"):
		return "ready"
	case strings.Contains(lower, "disabled"), strings.Contains(lower, "paused"):
		return "offline"
	case strings.Contains(lower, "not accepting"):
		return "error"
	default:
		return "unknown"
	}
}

// parseDefault reads `lpstat -d`, which prints either
// "system default destination: Office_Laser" or "no system default destination".
func parseDefault(output string) string {
	_, name, found := strings.Cut(output, "destination:")
	if !found {
		return ""
	}
	return strings.TrimSpace(name)
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return stdout.String(), nil
}
