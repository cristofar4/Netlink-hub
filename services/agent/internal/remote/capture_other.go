//go:build !windows

package remote

import (
	"image"
	"image/color"
	"sync/atomic"
)

/*
The non-Windows capturer.

It returns a generated pattern rather than a real screen, and it is labelled as
such everywhere it surfaces. NetLink captures screens on Windows; grabbing an X
display here would mean the code that ships is not the code anyone develops
against, for a platform we do not support.

What it *is* for: exercising the whole pipeline — encoding, rate limiting,
downscaling, framing, the data channel — on a machine that has no display at
all. Everything downstream of the capture is platform-independent, so testing it
here tests what runs on Windows.
*/

type patternCapturer struct {
	width  int
	height int
	tick   atomic.Int64
}

func newPlatformCapturer() (Capturer, error) {
	return &patternCapturer{width: 640, height: 360}, nil
}

func (p *patternCapturer) Bounds() (int, int, error) { return p.width, p.height, nil }

// Capture draws a moving gradient. It changes between calls on purpose: a
// static image would let a broken frame pipeline look like a working one.
func (p *patternCapturer) Capture() (image.Image, error) {
	n := int(p.tick.Add(1))
	img := image.NewRGBA(image.Rect(0, 0, p.width, p.height))
	for y := 0; y < p.height; y++ {
		for x := 0; x < p.width; x++ {
			img.Set(x, y, color.RGBA{
				R: uint8((x + n) % 256),
				G: uint8((y + n) % 256),
				B: uint8((x + y) % 256),
				A: 0xFF,
			})
		}
	}
	return img, nil
}

func (p *patternCapturer) Close() error { return nil }
