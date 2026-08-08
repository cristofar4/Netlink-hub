//go:build windows

package remote

import (
	"fmt"
	"image"
	"unsafe"

	"golang.org/x/sys/windows"
)

/*
Windows screen capture, via GDI.

BitBlt from the virtual screen device context into a 32-bit DIB section. This is
the oldest and least exciting capture path on Windows, chosen on purpose: it
works on every supported version, needs no elevation, needs no graphics driver
cooperation, and captures the whole virtual desktop including secondary
monitors.

It does not capture hardware-overlay content — protected video, and some
full-screen games, come back black. That is the operating system declining to
hand over content it was asked to protect, and NetLink does not attempt to work
around it. A user who sees a black rectangle where a film was is seeing DRM
working, not NetLink failing.
*/

var (
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")
	capU32 = windows.NewLazySystemDLL("user32.dll")

	procGetDC              = capU32.NewProc("GetDC")
	procReleaseDC          = capU32.NewProc("ReleaseDC")
	procGetSystemMetricsC  = capU32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
)

const (
	srccopy = 0x00CC0020
	// CAPTUREBLT is included so layered windows — most notably the mouse
	// cursor's shadow and many tooltips — appear in the capture instead of
	// leaving holes.
	captureblt = 0x40000000

	biRGB           = 0
	dibRGBColors    = 0
	cxVirtualScreen = 78
	cyVirtualScreen = 79
	xVirtualScreen  = 76
	yVirtualScreen  = 77
)

type bitmapInfoHeader struct {
	size          uint32
	width         int32
	height        int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPelsPerMeter int32
	yPelsPerMeter int32
	clrUsed       uint32
	clrImportant  uint32
}

type bitmapInfo struct {
	header bitmapInfoHeader
	colors [1]uint32
}

type gdiCapturer struct {
	screenDC uintptr
	memDC    uintptr
	bitmap   uintptr
	pixels   unsafe.Pointer
	width    int
	height   int
	originX  int
	originY  int
}

func newPlatformCapturer() (Capturer, error) {
	width := int(sysMetric(cxVirtualScreen))
	height := int(sysMetric(cyVirtualScreen))
	if width <= 0 || height <= 0 {
		return nil, ErrNoDisplay
	}

	screenDC, _, err := procGetDC.Call(0)
	if screenDC == 0 {
		return nil, fmt.Errorf("netlink: could not open the screen device context: %w", err)
	}

	memDC, _, err := procCreateCompatibleDC.Call(screenDC)
	if memDC == 0 {
		procReleaseDC.Call(0, screenDC)
		return nil, fmt.Errorf("netlink: could not create a capture device context: %w", err)
	}

	// A negative height requests a top-down DIB, so row 0 is the top of the
	// screen. Bottom-up is the Windows default and would hand us an image that
	// is upside down.
	info := bitmapInfo{header: bitmapInfoHeader{
		size:     uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		width:    int32(width),
		height:   -int32(height),
		planes:   1,
		bitCount: 32,
	}}
	info.header.compression = biRGB

	var pixels unsafe.Pointer
	bitmap, _, err := procCreateDIBSection.Call(
		memDC,
		uintptr(unsafe.Pointer(&info)),
		dibRGBColors,
		uintptr(unsafe.Pointer(&pixels)),
		0,
		0,
	)
	if bitmap == 0 || pixels == nil {
		procDeleteDC.Call(memDC)
		procReleaseDC.Call(0, screenDC)
		return nil, fmt.Errorf("netlink: could not allocate a capture buffer: %w", err)
	}

	procSelectObject.Call(memDC, bitmap)

	return &gdiCapturer{
		screenDC: screenDC,
		memDC:    memDC,
		bitmap:   bitmap,
		pixels:   pixels,
		width:    width,
		height:   height,
		originX:  int(sysMetric(xVirtualScreen)),
		originY:  int(sysMetric(yVirtualScreen)),
	}, nil
}

func sysMetric(index int) int32 {
	v, _, _ := procGetSystemMetricsC.Call(uintptr(index))
	return int32(v)
}

func (c *gdiCapturer) Bounds() (int, int, error) { return c.width, c.height, nil }

func (c *gdiCapturer) Capture() (image.Image, error) {
	ok, _, err := procBitBlt.Call(
		c.memDC, 0, 0, uintptr(c.width), uintptr(c.height),
		c.screenDC, uintptr(c.originX), uintptr(c.originY),
		srccopy|captureblt,
	)
	if ok == 0 {
		return nil, fmt.Errorf("netlink: screen capture failed: %w", err)
	}

	// The DIB is BGRA; Go's RGBA wants RGBA. The channel swap is done into a
	// fresh buffer each frame rather than in place, because the DIB is still
	// owned by GDI and will be overwritten by the next BitBlt.
	src := unsafe.Slice((*byte)(c.pixels), c.width*c.height*4)
	img := image.NewRGBA(image.Rect(0, 0, c.width, c.height))
	for i := 0; i < len(src); i += 4 {
		img.Pix[i+0] = src[i+2]
		img.Pix[i+1] = src[i+1]
		img.Pix[i+2] = src[i+0]
		img.Pix[i+3] = 0xFF
	}
	return img, nil
}

func (c *gdiCapturer) Close() error {
	if c.bitmap != 0 {
		procDeleteObject.Call(c.bitmap)
	}
	if c.memDC != 0 {
		procDeleteDC.Call(c.memDC)
	}
	if c.screenDC != 0 {
		procReleaseDC.Call(0, c.screenDC)
	}
	return nil
}
