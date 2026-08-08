package remote

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"time"
)

// Frame is one captured screen, ready to send.
type Frame struct {
	Seq    int `json:"seq"`
	Width  int `json:"width"`
	Height int `json:"height"`
	// At is milliseconds since the session started, for the viewer's latency
	// read-out.
	At int64 `json:"at"`
	// JPEG is the encoded image. It is never written to disk and never leaves
	// the peer connection.
	JPEG []byte `json:"-"`
}

// Quality is what the viewer asked for. The three settings mirror
// FRAME_QUALITY_SETTINGS in the contracts package so both ends agree about what
// "balanced" means.
type Quality struct {
	JPEGQuality int
	MaxFPS      int
	MaxWidth    int
}

var qualities = map[string]Quality{
	"low":      {JPEGQuality: 45, MaxFPS: 20, MaxWidth: 1280},
	"balanced": {JPEGQuality: 65, MaxFPS: 15, MaxWidth: 1600},
	"sharp":    {JPEGQuality: 82, MaxFPS: 10, MaxWidth: 1920},
}

// QualityFor resolves a name, falling back to balanced for anything unknown.
func QualityFor(name string) Quality {
	if q, ok := qualities[name]; ok {
		return q
	}
	return qualities["balanced"]
}

// ErrNoDisplay is returned when there is no screen to capture — a headless
// server, or a session running before anyone has logged in.
var ErrNoDisplay = errors.New("netlink: no display is available to capture")

// Capturer grabs the screen. Implemented per platform.
type Capturer interface {
	// Capture returns the current screen as an image.
	Capture() (image.Image, error)
	// Bounds reports the virtual screen size, spanning all monitors.
	Bounds() (int, int, error)
	Close() error
}

// NewCapturer returns the platform capturer.
func NewCapturer() (Capturer, error) { return newPlatformCapturer() }

// Encoder turns captured images into frames at a bounded rate.
//
// Rate limiting lives here rather than in the capture loop because the cost
// that matters is encoding, not grabbing: a 4K screen encoded thirty times a
// second will saturate a core and make the machine somebody is sitting at feel
// worse than the connection does.
type Encoder struct {
	quality Quality
	started time.Time
	seq     int
	last    time.Time
	buf     bytes.Buffer
	now     func() time.Time
}

func NewEncoder(quality Quality) *Encoder {
	now := time.Now()
	return &Encoder{quality: quality, started: now, now: time.Now}
}

// Due reports whether enough time has passed to encode another frame.
func (e *Encoder) Due() bool {
	if e.quality.MaxFPS <= 0 {
		return true
	}
	interval := time.Second / time.Duration(e.quality.MaxFPS)
	return e.now().Sub(e.last) >= interval
}

// Encode produces a frame from an image.
func (e *Encoder) Encode(img image.Image) (Frame, error) {
	scaled := downscale(img, e.quality.MaxWidth)

	e.buf.Reset()
	if err := jpeg.Encode(&e.buf, scaled, &jpeg.Options{Quality: e.quality.JPEGQuality}); err != nil {
		return Frame{}, err
	}

	now := e.now()
	e.last = now
	e.seq++

	bounds := scaled.Bounds()
	// The buffer is reused between frames, so the bytes are copied out rather
	// than handed over — otherwise the next Encode would rewrite a frame that is
	// still in flight.
	payload := make([]byte, e.buf.Len())
	copy(payload, e.buf.Bytes())

	return Frame{
		Seq:    e.seq,
		Width:  bounds.Dx(),
		Height: bounds.Dy(),
		At:     now.Sub(e.started).Milliseconds(),
		JPEG:   payload,
	}, nil
}

/*
downscale shrinks an image to fit a maximum width.

Nearest-neighbour, deliberately. A proper resampling filter looks better and
costs several times as much per frame, and this runs on the machine someone is
actually using — spending their CPU to make a remote viewer's text marginally
smoother is the wrong trade. Anyone who wants sharp text picks the "Sharpest"
setting, which raises the width cap instead of the filter quality.
*/
func downscale(img image.Image, maxWidth int) image.Image {
	bounds := img.Bounds()
	if maxWidth <= 0 || bounds.Dx() <= maxWidth {
		return img
	}

	ratio := float64(maxWidth) / float64(bounds.Dx())
	width := maxWidth
	height := int(float64(bounds.Dy()) * ratio)
	if height < 1 {
		height = 1
	}

	out := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		srcY := bounds.Min.Y + int(float64(y)/ratio)
		for x := 0; x < width; x++ {
			srcX := bounds.Min.X + int(float64(x)/ratio)
			out.Set(x, y, img.At(srcX, srcY))
		}
	}
	return out
}
