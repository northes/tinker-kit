package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func openLocalFolder(path string) error {
	if path == "" {
		return errors.New("本地目录路径为空")
	}

	cleanPath, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	folder := cleanPath
	if info, statErr := os.Stat(cleanPath); statErr != nil || !info.IsDir() {
		folder = filepath.Dir(cleanPath)
	}
	if info, statErr := os.Stat(folder); statErr != nil || !info.IsDir() {
		if statErr != nil {
			return statErr
		}
		return errors.New("目标目录不是目录")
	}

	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", folder)
	case "windows":
		command = exec.Command("explorer", folder)
	default:
		command = exec.Command("xdg-open", folder)
	}
	return command.Start()
}
