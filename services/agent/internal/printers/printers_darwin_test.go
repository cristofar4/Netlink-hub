//go:build darwin

package printers

import "testing"

/*
Parsing `lpstat`.

These fixtures are real output shapes rather than invented ones, because the
whole risk in this file is that CUPS words a state slightly differently than
expected and a printer silently becomes "unknown" — or worse, a continuation
line is read as a printer.
*/

func TestReadsPrintersAndTheirState(t *testing.T) {
	output := `printer Office_Laser is idle.  enabled since Tue  3 Mar 11:04:22 2026
printer Old_Inkjet disabled since Mon  2 Mar 09:00:00 2026 -
	Paused
printer Studio_Photo now printing Studio_Photo-42.  enabled since Tue  3 Mar 12:00:00 2026`

	got := parseListing(output)
	if len(got) != 3 {
		t.Fatalf("found %d printers, want 3: %+v", len(got), got)
	}

	want := map[string]string{
		"Office_Laser": "ready",
		"Old_Inkjet":   "offline",
		"Studio_Photo": "ready",
	}
	for _, printer := range got {
		if want[printer.Name] != printer.Status {
			t.Errorf("%s = %q, want %q", printer.Name, printer.Status, want[printer.Name])
		}
	}
}

// An indented continuation line must not become a printer called "Paused".
func TestContinuationLinesAreNotPrinters(t *testing.T) {
	output := `printer Office_Laser is idle.  enabled since Tue  3 Mar 11:04:22 2026
	Paused
	Ready to print`

	got := parseListing(output)
	if len(got) != 1 {
		t.Fatalf("found %d printers, want 1: %+v", len(got), got)
	}
}

func TestNoPrintersIsEmptyRatherThanAnError(t *testing.T) {
	if got := parseListing("no destinations added.\n"); len(got) != 0 {
		t.Fatalf("found %d printers in an empty listing: %+v", len(got), got)
	}
	if got := parseListing(""); len(got) != 0 {
		t.Fatalf("found %d printers in no output at all", len(got))
	}
}

func TestReadsTheDefaultPrinter(t *testing.T) {
	if got := parseDefault("system default destination: Office_Laser\n"); got != "Office_Laser" {
		t.Fatalf("default = %q, want Office_Laser", got)
	}
}

func TestNoDefaultPrinterIsEmpty(t *testing.T) {
	if got := parseDefault("no system default destination\n"); got != "" {
		t.Fatalf("default = %q, want empty", got)
	}
	if got := parseDefault(""); got != "" {
		t.Fatalf("default = %q, want empty", got)
	}
}

func TestStateWordsMapOntoTheSharedVocabulary(t *testing.T) {
	// The desktop and the phone show one set of words for one set of states.
	// A dialect per platform would mean the UI has to know which OS it is
	// looking at, which is exactly what this normalisation exists to prevent.
	cases := map[string]string{
		"is idle.":             "ready",
		"now printing job-1.":  "ready",
		"disabled since Mon":   "offline",
		"is idle. Paused":      "ready",
		"not accepting jobs":   "error",
		"something unexpected": "unknown",
	}
	for input, want := range cases {
		if got := normaliseState(input); got != want {
			t.Errorf("normaliseState(%q) = %q, want %q", input, got, want)
		}
	}
}
