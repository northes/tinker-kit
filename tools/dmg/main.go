// Command dmg builds the TinkerKit installer disk image.
//
// `wails3 tool package --format dmg` has no way to set Finder icon positions for
// extra files, so the installer helper scripts it adds land on top of the app
// and Applications icons. This tool drives the same github.com/leaanthony/dmg
// library directly and pins every icon, keeping the layout produced by wails3
// while placing the helper scripts on their own row.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/leaanthony/dmg/dmg"
)

func main() {
	name := flag.String("name", "TinkerKit", "application and volume name")
	out := flag.String("out", "bin", "output directory holding <name>.app and the .dmg")
	background := flag.String("background", "", "background image path")
	volumeIcon := flag.String("volume-icon", "", "mounted volume icon path")
	fileIcon := flag.String("file-icon", "", "DMG file icon path")
	width := flag.Int("window-width", 540, "Finder window width in pixels")
	height := flag.Int("window-height", 380, "Finder window height in pixels")
	extra := flag.String("files", "", "additional files as name=path pairs separated by commas")
	flag.Parse()

	if err := run(*name, *out, *background, *volumeIcon, *fileIcon, *width, *height, *extra); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(name, out, background, volumeIcon, fileIcon string, width, height int, extra string) error {
	appPath := filepath.Join(out, name+".app")
	if _, err := os.Stat(appPath); err != nil {
		return fmt.Errorf("application bundle not found: %s", appPath)
	}

	opts := dmg.DefaultOptions(appPath, filepath.Join(out, name+".dmg"))
	opts.VolumeName = name
	opts.Window = dmg.WindowConfig{X: 100, Y: 100, Width: width, Height: height}
	opts.Icon = dmg.IconConfig{Size: 96, TextSize: 12, GridSpace: 100}
	opts.Files = map[string]string{name + ".app": appPath}
	opts.IconPositions = map[string]dmg.IconPosition{}

	var helpers []string
	for _, item := range strings.Split(extra, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		helperName, helperPath, ok := strings.Cut(item, "=")
		helperName = strings.TrimSpace(helperName)
		helperPath = strings.TrimSpace(helperPath)
		if !ok || helperName == "" || helperPath == "" {
			return fmt.Errorf("invalid file %q: expected name=path", item)
		}
		if _, err := os.Stat(helperPath); err != nil {
			return fmt.Errorf("file %q: %w", helperName, err)
		}
		opts.Files[helperName] = helperPath
		helpers = append(helpers, helperName)
	}

	// Main row: app on the left, Applications drop target on the right, matching
	// the arrow drawn in the background image.
	mainY := height/2 - 26
	if mainY < 0 {
		mainY = height / 2
	}
	opts.IconPositions[name+".app"] = dmg.IconPosition{X: width * 28 / 100, Y: mainY}
	opts.IconPositions["Applications"] = dmg.IconPosition{X: width * 72 / 100, Y: mainY}

	// Helper scripts get their own centered row below the main icons.
	helperY := height * 78 / 100
	for i, helperName := range helpers {
		opts.IconPositions[helperName] = dmg.IconPosition{X: width * (i + 1) / (len(helpers) + 1), Y: helperY}
	}

	if background != "" {
		opts.Background = &dmg.BackgroundConfig{File: background}
	}
	opts.VolumeIcon = volumeIcon
	opts.FileIcon = fileIcon

	if err := dmg.Build(opts); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "created %s\n", opts.OutputPath)
	return nil
}
