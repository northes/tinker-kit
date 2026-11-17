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
// 模糊开时 opacity 只作用于原生毛玻璃层；模糊关时由前端 CSS 承担透明度。
// 非 macOS 不改变窗口。
func (s *WindowAppearanceService) ApplyWindowEffect(dark bool, blur bool, opacity int) {
	if runtime.GOOS != "darwin" {
		return
	}
	window := mainWebviewWindow()
	if window == nil {
		return
	}
	applyWindowEffect(window.NativeWindow(), dark, blur, opacity)
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

// initialBackgroundColour 在 webview 首帧出来前用不透明窗底盖住空窗。
// 透明度只由 CSS 决定；macOS 上前端画出首帧后再把原生 alpha 归零。
// 非 macOS 保持原来的不透明深色窗底，不应用这两项设置。
func initialBackgroundColour(cfg Config) application.RGBA {
	if runtime.GOOS != "darwin" {
		return application.NewRGB(27, 27, 27)
	}
	r, g, b := uint8(27), uint8(27), uint8(27)
	if !windowChromeDark(cfg) {
		r, g, b = 235, 235, 235
	}
	return application.NewRGBA(r, g, b, 255)
}
