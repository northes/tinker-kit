package main

import (
	"embed"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/dock"
	"github.com/wailsapp/wails/v3/pkg/updater"
	githubprovider "github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed assets/tray/*.png
var trayAssets embed.FS

type windowState struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

func windowStatePath() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "DevUtils", "window-state.json")
	}
	return filepath.Join(os.TempDir(), "devutils-window-state.json")
}

func loadWindowState() *windowState {
	b, err := os.ReadFile(windowStatePath())
	if err != nil {
		return nil
	}
	var s windowState
	if err := json.Unmarshal(b, &s); err != nil || s.W <= 0 || s.H <= 0 {
		return nil
	}
	return &s
}

func saveWindowState(s *windowState) {
	b, err := json.Marshal(s)
	if err != nil {
		return
	}
	p := windowStatePath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(p, b, 0o600)
}

const appName = "DevUtils"

var currentVersion = "0.0.0"

func matchGitHubUpdateAsset(req updater.CheckRequest, assets []githubprovider.ReleaseAsset) int {
	if !strings.EqualFold(req.Platform, "darwin") {
		return -1
	}
	for i, asset := range assets {
		if strings.HasSuffix(strings.ToLower(asset.Name), "-darwin-universal.zip") {
			return i
		}
	}
	return -1
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("[startup] DevUtils starting on %s/%s", runtime.GOOS, runtime.GOARCH)
	saved := loadWindowState()
	width, height := 720, 520
	x, y := 0, 0
	if saved != nil {
		width, height = saved.W, saved.H
		x, y = saved.X, saved.Y
	}

	cfgService := NewConfigService()
	logService := NewLogService()
	systemInfoService := NewSystemInfoService()
	updateService := NewUpdateService(currentVersion)
	fileService := NewFileService(cfgService)
	imageService := NewImageService(cfgService)
	dockService := dock.New()
	isQuitting := false
	app := application.New(application.Options{
		Name:        appName,
		Description: "Local-first developer utility launcher",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Services: []application.Service{
			application.NewService(cfgService),
			application.NewService(logService),
			application.NewService(systemInfoService),
			application.NewService(updateService),
			application.NewService(fileService),
			application.NewService(imageService),
			application.NewService(dockService),
		},
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyRegular,
		},
	})
	imageService.setEventEmitter(func(name string, data any) {
		_ = app.Event.Emit(name, data)
	})
	fileService.setEventEmitter(func(name string, data any) {
		_ = app.Event.Emit(name, data)
	})

	gh, err := githubprovider.New(githubprovider.Config{
		Repository:    "northes/dev-utils",
		ChecksumAsset: "SHA256SUMS",
		AssetMatcher:  matchGitHubUpdateAsset,
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := app.Updater.Init(updater.Config{
		CurrentVersion: currentVersion,
		Providers:      []updater.Provider{gh},
		// 无窗口 headless 模式：更新流程完全由主窗口前端药丸驱动，
		// 事件经 app.Event 广播到主窗口，不再创建独立的更新窗口。
		Window: updater.WindowNone,
	}); err != nil {
		log.Fatal(err)
	}
	updateService.start(app.Updater, cfgService.Get().AutoCheckUpdates)
	app.OnShutdown(updateService.stopScheduler)
	app.OnShutdown(imageService.shutdown)
	app.OnShutdown(fileService.cleanup)

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             appName,
		Title:            appName,
		Width:            width,
		Height:           height,
		X:                x,
		Y:                y,
		InitialPosition:  application.WindowXY,
		MinWidth:         640,
		MinHeight:        440,
		DisableResize:    false,
		EnableFileDrop:   true,
		BackgroundColour: application.NewRGB(17, 17, 19),
		URL:              "/",
		Mac: application.MacWindow{
			Appearance: application.NSAppearanceNameDarkAqua,
			Backdrop:   application.MacBackdropTranslucent,
			// TitleBar: application.MacTitleBar{
			// 	AppearsTransparent: true,
			// 	Hide:               false,
			// 	HideTitle:          true,
			// 	FullSizeContent:    false,
			// },
			TitleBar: application.MacTitleBarHiddenInset,
			WebviewPreferences: application.MacWebviewPreferences{
				AllowsBackForwardNavigationGestures: application.Enabled,
			},
		},
	})
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		_ = app.Event.Emit("files-dropped", map[string]any{
			"files":   event.Context().DroppedFiles(),
			"details": event.Context().DropTargetDetails(),
		})
	})
	log.Printf("[startup] window created; WebKit back-forward gestures enabled")
	window.Show()
	log.Printf("[startup] window shown; installing local swipe monitor")
	installMouseNavigationMonitor()
	installMouseNavigationSwipeMonitor(func(direction, phase int) {
		log.Printf("[mouse] local swipe direction=%d phase=%d", direction, phase)
		if phase != 8 {
			return
		}
		if direction == 2 {
			app.Event.Emit("mouse:navigate", "back")
		} else if direction == 1 {
			app.Event.Emit("mouse:navigate", "forward")
		}
	})
	log.Printf("[startup] local swipe monitor installed")
	updateService.setBeforeRestart(func() {
		// 更新重启走真实退出，避免 WindowClosing 钩子把它当成隐藏到托盘。
		isQuitting = true
	})

	var saveTimer *time.Timer
	persistBounds := func() {
		x, y := window.Position()
		w, h := window.Size()
		saved = &windowState{X: x, Y: y, W: w, H: h}
		if saveTimer != nil {
			saveTimer.Stop()
		}
		saveTimer = time.AfterFunc(400*time.Millisecond, func() { saveWindowState(saved) })
	}
	flushBounds := func() {
		if saveTimer != nil {
			saveTimer.Stop()
			saveTimer = nil
		}
		if saved != nil {
			saveWindowState(saved)
		}
	}
	window.RegisterHook(events.Common.WindowDidMove, func(*application.WindowEvent) { persistBounds() })
	window.RegisterHook(events.Common.WindowDidResize, func(*application.WindowEvent) { persistBounds() })
	app.OnShutdown(flushBounds)

	en := cfgService.Get().Language == "en-US"
	tray := app.SystemTray.New()
	if en {
		tray.SetTooltip("DevUtils — local dev tools")
	} else {
		tray.SetTooltip("DevUtils — 本地开发工具")
	}
	macTrayIcon, err := trayAssets.ReadFile("assets/tray/tray-mac-template.png")
	if err != nil {
		log.Fatal(err)
	}
	trayLight, err := trayAssets.ReadFile("assets/tray/tray-light.png")
	if err != nil {
		log.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(macTrayIcon)
	} else {
		tray.SetIcon(trayLight)
	}
	showFromTray := func() {
		if runtime.GOOS == "darwin" {
			go dockService.ShowAppIcon()
		}
		// 临时提升窗口层级，确保从托盘菜单唤回时能越过当前前台窗口；
		// 聚焦后恢复普通层级，避免 DevUtils 变成永久置顶窗口。
		window.SetAlwaysOnTop(true)
		window.Show()
		window.Focus()
		window.SetAlwaysOnTop(false)
	}
	quit := func() {
		isQuitting = true
		app.Quit()
	}
	analyzeClipboard := func() {
		showFromTray()
		app.Event.Emit("tray:analyze")
	}

	menu := app.Menu.New()
	if en {
		menu.Add("Open DevUtils").OnClick(func(_ *application.Context) { showFromTray() })
		menu.Add("Settings").OnClick(func(_ *application.Context) {
			showFromTray()
			app.Event.Emit("navigate", "settings")
		})
		menu.AddSeparator()
		menu.Add("Quit").OnClick(func(_ *application.Context) { quit() })
	} else {
		menu.Add("打开 DevUtils").OnClick(func(_ *application.Context) { showFromTray() })
		menu.Add("设置").OnClick(func(_ *application.Context) {
			showFromTray()
			app.Event.Emit("navigate", "settings")
		})
		menu.AddSeparator()
		menu.Add("退出").OnClick(func(_ *application.Context) { quit() })
	}
	tray.SetMenu(menu)
	tray.OnClick(func() { analyzeClipboard() })
	tray.OnRightClick(func() { tray.OpenMenu() })

	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		x, y := window.Position()
		w, h := window.Size()
		saveWindowState(&windowState{X: x, Y: y, W: w, H: h})
		if isQuitting {
			return
		}
		if runtime.GOOS == "darwin" {
			go dockService.HideAppIcon()
		}
		window.Hide()
		event.Cancel()
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
