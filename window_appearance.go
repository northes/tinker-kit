package main

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// WindowAppearanceService 在运行时切换主窗口已有的毛玻璃，不重建窗口。
type WindowAppearanceService struct{}

func NewWindowAppearanceService() *WindowAppearanceService {
	return &WindowAppearanceService{}
}

func (s *WindowAppearanceService) ServiceName() string { return "WindowAppearanceService" }

// ApplyWindowEffect 按当前主题切换窗口外观，并显示或隐藏创建时插入的毛玻璃。
// 非 macOS 不改变窗口。
func (s *WindowAppearanceService) ApplyWindowEffect(dark bool, blur bool) {
	if runtime.GOOS != "darwin" {
		return
	}
	window := mainWebviewWindow()
	if window == nil {
		return
	}
	applyWindowEffect(window.NativeWindow(), dark, blur)
}

func mainWebviewWindow() *application.WebviewWindow {
	app := application.Get()
	if app == nil {
		return nil
	}
	window, ok := app.Window.GetByName(appName)
	if !ok || window == nil {
		return nil
	}
	webview, ok := window.(*application.WebviewWindow)
	if !ok {
		return nil
	}
	return webview
}

func windowChromeDark(cfg Config) bool {
	switch cfg.ThemeMode {
	case "light":
		return false
	case "system":
		return systemPrefersDark()
	default:
		return true
	}
}

// initialBackgroundColour 在窗口创建时就带上正确的窗底色和透明度，避免先闪一帧实色。
// 非 macOS 保持原来的不透明深色窗底，不应用这两项设置。
func initialBackgroundColour(cfg Config) application.RGBA {
	if runtime.GOOS != "darwin" {
		return application.NewRGB(27, 27, 27)
	}
	r, g, b := uint8(27), uint8(27), uint8(27)
	if !windowChromeDark(cfg) {
		r, g, b = 235, 235, 235
	}
	return application.NewRGBA(r, g, b, windowOpacityAlpha(cfg.WindowOpacity))
}

func windowOpacityAlpha(opacity int) uint8 {
	opacity = normalizeWindowOpacity(opacity)
	return uint8((opacity*255 + 50) / 100)
}
