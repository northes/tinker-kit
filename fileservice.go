package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// FileService 提供需要原生文件对话框的文件操作。
type FileService struct {
	config       *ConfigService
	taskMu       sync.Mutex
	tasks        map[string]*fileTaskState
	taskOrder    []string
	taskRevision uint64
	emitEvent    func(string, any)
	dragTempMu   sync.Mutex
	dragTemps    map[string]struct{}
}

const maxImageFileSize = 10 * 1024 * 1024

var imageMIMETypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".svg":  "image/svg+xml",
	".webp": "image/webp",
}

func NewFileService(config ...*ConfigService) *FileService {
	service := &FileService{}
	if len(config) > 0 {
		service.config = config[0]
	}
	cleanupSSHDragTemps()
	return service
}

func (s *FileService) ServiceName() string { return "FileService" }

func (s *FileService) cleanup() {
	s.dragTempMu.Lock()
	paths := make([]string, 0, len(s.dragTemps))
	for path := range s.dragTemps {
		paths = append(paths, path)
	}
	s.dragTemps = nil
	s.dragTempMu.Unlock()
	for _, path := range paths {
		_ = os.RemoveAll(path)
	}
}

// SaveText 打开原生保存对话框，并将文本以 UTF-8 写入用户选择的路径。
// 返回实际保存路径；用户取消时返回空路径和 nil error。
func (s *FileService) SaveText(content string, filename string) (string, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "", errors.New("应用尚未初始化")
	}

	dialog := app.Dialog.SaveFile().
		SetFilename(filename).
		CanCreateDirectories(true).
		AllowsOtherFileTypes(true).
		AddFilter("JSON", "*.json").
		AddFilter("XML", "*.xml").
		AddFilter("TOML", "*.toml").
		AddFilter("YAML", "*.yaml;*.yml").
		AddFilter("CSV", "*.csv")
	if window := app.Window.Current(); window != nil {
		dialog.AttachToWindow(window)
	}

	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("选择保存路径: %w", err)
	}
	if path == "" {
		return "", nil
	}

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("写入文件 %q: %w", path, err)
	}
	return path, nil
}

// ReadImageFile 读取用户选择的图片，并返回可直接用于 img 或 canvas 的 data URL。
// 仅支持 PNG、JPG、JPEG、SVG 和 WebP，且单个文件不得超过 10 MiB。
func (s *FileService) ReadImageFile(path string) (string, error) {
	extension := strings.ToLower(filepath.Ext(path))
	mimeType, ok := imageMIMETypes[extension]
	if !ok {
		return "", fmt.Errorf("不支持的图片文件类型 %q，仅允许 png、jpg、jpeg、svg 和 webp", extension)
	}

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("获取图片文件信息 %q: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("图片路径 %q 不是普通文件", path)
	}
	if info.Size() > maxImageFileSize {
		return "", fmt.Errorf("图片文件 %q 超过大小限制（最大 10 MiB）", path)
	}

	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("打开图片文件 %q: %w", path, err)
	}
	defer file.Close()

	// 打开后再次检查，避免路径在预检查与打开之间发生变化。
	info, err = file.Stat()
	if err != nil {
		return "", fmt.Errorf("获取图片文件信息 %q: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("图片路径 %q 不是普通文件", path)
	}

	data, err := io.ReadAll(io.LimitReader(file, maxImageFileSize+1))
	if err != nil {
		return "", fmt.Errorf("读取图片文件 %q: %w", path, err)
	}
	if int64(len(data)) > maxImageFileSize {
		return "", fmt.Errorf("图片文件 %q 超过大小限制（最大 10 MiB）", path)
	}

	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}
