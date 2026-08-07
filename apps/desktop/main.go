// Command NetLink is the desktop application.
//
// The user installs and sees one NetLink. This process is the window; the
// background service (services/agent) is installed alongside it and keeps the
// machine reachable when the window is closed. Everything the window needs from
// the machine — the device identity, the agent's state — it gets through the
// bound App methods below rather than reaching into the filesystem from
// JavaScript.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:  "NetLink",
		Width:  1280,
		Height: 840,
		// Below this the sidebar and the Spaces map stop being readable.
		MinWidth:  1024,
		MinHeight: 700,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// Matches --nl-bg so there is no white flash before the app paints.
		BackgroundColour: &options.RGBA{R: 6, G: 11, B: 24, A: 1},
		OnStartup:        app.Startup,
		OnShutdown:       app.Shutdown,
		Bind: []any{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			// The app is dark-first; asking WebView2 for dark theme stops
			// native scrollbars and context menus rendering light.
			Theme: windows.Dark,
		},
	})
	if err != nil {
		log.Fatalf("NetLink could not start: %v", err)
	}
}
