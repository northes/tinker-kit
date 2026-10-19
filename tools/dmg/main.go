// Command dmg 生成带背景与固定图标位置的 TinkerKit 安装镜像。
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

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
	flag.Parse()

	if err := run(*name, *out, *background, *volumeIcon, *fileIcon, *width, *height); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(name, out, background, volumeIcon, fileIcon string, width, height int) error {
	appPath := filepath.Join(out, name+".app")
	if _, err := os.Stat(appPath); err != nil {
		return fmt.Errorf("application bundle not found: %s", appPath)
	}

	opts := dmg.DefaultOptions(appPath, filepath.Join(out, name+".dmg"))
	opts.VolumeName = name
	opts.Window = dmg.WindowConfig{X: 100, Y: 100, Width: width, Height: height}
	opts.Icon = dmg.IconConfig{Size: 80, TextSize: 12, GridSpace: 100}
	opts.Files = map[string]string{name + ".app": appPath}
	opts.IconPositions = map[string]dmg.IconPosition{}

	// 安装主行位于内容区上半部，坐标与背景 SVG 同步。
	mainY := 155
	opts.IconPositions[name+".app"] = dmg.IconPosition{X: width / 4, Y: mainY}
	opts.IconPositions["Applications"] = dmg.IconPosition{X: width * 3 / 4, Y: mainY}

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
