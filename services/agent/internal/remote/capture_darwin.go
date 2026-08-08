//go:build darwin

package remote

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
macOS screen capture, via the `screencapture` tool.

**This is the honest compromise in the macOS port, so it is worth being plain
about it.** The Windows path uses GDI BitBlt and comfortably sustains fifteen
frames a second. This spawns a process per frame, which costs roughly 80–150 ms
on current hardware — so a Mac being viewed streams at something like six to
eight frames a second rather than fifteen.

The proper fix is ScreenCaptureKit (macOS 12.3+) or CGDisplayCreateImage, and
both need cgo. cgo would cost the agent the property that makes it easy to
ship — one static binary, cross-compilable from any machine, no Xcode toolchain
in the build — and would mean the macOS agent could only be built on a Mac.
Trading that for a smoother picture is a decision worth making deliberately
rather than by accident, and it is not made here.

**Nothing is written to disk.** `screencapture -` writes the image to standard
output, which is what makes this acceptable at all. Capturing to a temporary
file would put frames of somebody's screen on their filesystem, and no framerate
would be worth that.

**macOS will ask for permission the first time**, and until it is granted every
capture returns a black or empty image. That is TCC working as designed, and the
agent reports it as a missing permission rather than as a broken connection.
*/

type screencaptureCapturer struct {
	width  int
	height int

	// Guards the exec: two overlapping `screencapture` processes fight over the
	// display and one of them returns a partial image.
	mu sync.Mutex

	warnedAboutPermission bool
}

func newPlatformCapturer() (Capturer, error) {
	if _, err := exec.LookPath("screencapture"); err != nil {
		return nil, fmt.Errorf("%w: screencapture is not available", ErrNoDisplay)
	}

	width, height := displayBounds()
	if width <= 0 || height <= 0 {
		return nil, ErrNoDisplay
	}
	return &screencaptureCapturer{width: width, height: height}, nil
}

func (c *screencaptureCapturer) Bounds() (int, int, error) { return c.width, c.height, nil }

func (c *screencaptureCapturer) Capture() (image.Image, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	/*
		-x  no camera shutter sound. Capturing somebody's screen fifteen times a
		    minute while their Mac clicks each time is not a product.
		-C  include the cursor, so the viewer sees what the person sees.
		-t png  lossless out of the capture; the JPEG quality trade is made once,
		    later, by the encoder that already knows what the viewer asked for.
		-   write to stdout rather than a file.
	*/
	cmd := exec.CommandContext(ctx, "screencapture", "-x", "-C", "-t", "png", "-")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, c.explain(err, stderr.String())
	}
	if stdout.Len() == 0 {
		return nil, c.explain(nil, stderr.String())
	}

	img, err := png.Decode(bytes.NewReader(stdout.Bytes()))
	if err != nil {
		return nil, fmt.Errorf("netlink: the captured image could not be read: %w", err)
	}

	// The display can be resized or a monitor unplugged mid-session; taking the
	// bounds from the image rather than caching them means the next frame is
	// simply the new size instead of being stretched into the old one.
	bounds := img.Bounds()
	c.width, c.height = bounds.Dx(), bounds.Dy()

	return img, nil
}

func (c *screencaptureCapturer) Close() error { return nil }

/*
explain turns a capture failure into something actionable.

The overwhelmingly likely cause on macOS is that Screen Recording permission has
not been granted, and "exit status 1" would send somebody hunting through the
wrong part of the system.
*/
func (c *screencaptureCapturer) explain(err error, stderr string) error {
	lower := strings.ToLower(stderr)
	if strings.Contains(lower, "not authorized") ||
		strings.Contains(lower, "permission") ||
		stderr == "" {
		c.warnedAboutPermission = true
		return fmt.Errorf(
			"netlink: macOS has not granted Screen Recording permission — open System Settings, Privacy & Security, Screen Recording, and allow NetLink, then restart it",
		)
	}
	if err != nil {
		return fmt.Errorf("netlink: screen capture failed: %w: %s", err, strings.TrimSpace(stderr))
	}
	return fmt.Errorf("netlink: screen capture returned nothing: %s", strings.TrimSpace(stderr))
}

/*
displayBounds reads the main display's pixel size from system_profiler.

Only used to report a size before the first frame arrives; after that the image
itself is authoritative. system_profiler is slow (a second or so) but this runs
once per session.
*/
func displayBounds() (int, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "system_profiler", "SPDisplaysDataType").Output()
	if err != nil {
		// A sensible default rather than a failure: the first captured frame
		// corrects it, and refusing to start a session because a metadata tool
		// was slow would be the wrong trade.
		return 1920, 1080
	}

	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "Resolution:") {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(trimmed, "Resolution:"))
		if len(fields) < 3 {
			continue
		}
		width, errWidth := strconv.Atoi(fields[0])
		height, errHeight := strconv.Atoi(fields[2])
		if errWidth == nil && errHeight == nil && width > 0 && height > 0 {
			return width, height
		}
	}
	return 1920, 1080
}
