package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadImageFileReturnsDataURL(t *testing.T) {
	root := t.TempDir()
	content := []byte("small image content")
	path := filepath.Join(root, "preview.PNG")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("创建测试图片失败: %v", err)
	}

	got, err := (&FileService{}).ReadImageFile(path)
	if err != nil {
		t.Fatalf("读取有效小图片失败: %v", err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(content)
	if got != want {
		t.Fatalf("data URL 为 %q，期望 %q", got, want)
	}
}

func TestReadImageFileUsesStandardMIMETypes(t *testing.T) {
	root := t.TempDir()
	for extension, mimeType := range imageMIMETypes {
		path := filepath.Join(root, "preview"+extension)
		if err := os.WriteFile(path, []byte("image"), 0o600); err != nil {
			t.Fatalf("创建 %s 测试图片失败: %v", extension, err)
		}

		got, err := (&FileService{}).ReadImageFile(path)
		if err != nil {
			t.Fatalf("读取 %s 测试图片失败: %v", extension, err)
		}
		if !strings.HasPrefix(got, "data:"+mimeType+";base64,") {
			t.Fatalf("%s 的 data URL MIME 类型错误: %q", extension, got)
		}
	}
}

func TestReadImageFileRejectsUnsupportedExtension(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preview.gif")
	if _, err := (&FileService{}).ReadImageFile(path); err == nil {
		t.Fatal("读取不支持的扩展名时应返回错误")
	} else if !strings.Contains(err.Error(), "不支持的图片文件类型") {
		t.Fatalf("错误信息不清晰: %v", err)
	}
}

func TestReadImageFileRejectsDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preview.png")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatalf("创建测试目录失败: %v", err)
	}

	if _, err := (&FileService{}).ReadImageFile(path); err == nil {
		t.Fatal("读取目录时应返回错误")
	} else if !strings.Contains(err.Error(), "不是普通文件") {
		t.Fatalf("目录错误信息不清晰: %v", err)
	}
}

func TestReadImageFileRejectsMissingPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.png")
	if _, err := (&FileService{}).ReadImageFile(path); err == nil {
		t.Fatal("读取不存在的路径时应返回错误")
	} else if !strings.Contains(err.Error(), "获取图片文件信息") {
		t.Fatalf("不存在路径的错误信息不清晰: %v", err)
	}
}

func TestReadFileReturnsDataURLAndMetadata(t *testing.T) {
	root := t.TempDir()
	content := []byte(`{"ok":true}`)
	path := filepath.Join(root, "sample.json")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("创建测试文件失败: %v", err)
	}

	got, err := (&FileService{}).ReadFile(path, 0)
	if err != nil {
		t.Fatalf("读取有效文件失败: %v", err)
	}
	if got.Name != "sample.json" {
		t.Fatalf("文件名为 %q，期望 sample.json", got.Name)
	}
	if got.Size != int64(len(content)) {
		t.Fatalf("文件大小为 %d，期望 %d", got.Size, len(content))
	}
	want := "data:application/json;base64," + base64.StdEncoding.EncodeToString(content)
	if got.DataURL != want {
		t.Fatalf("data URL 为 %q，期望 %q", got.DataURL, want)
	}
}

func TestReadFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.txt")
	if err := os.WriteFile(path, []byte("0123456789"), 0o600); err != nil {
		t.Fatalf("创建测试文件失败: %v", err)
	}

	if _, err := (&FileService{}).ReadFile(path, 4); err == nil {
		t.Fatal("超过大小限制时应返回错误")
	} else if !strings.Contains(err.Error(), "超过大小限制") {
		t.Fatalf("大小限制错误信息不清晰: %v", err)
	}
}

func TestReadFileRejectsDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "folder")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatalf("创建测试目录失败: %v", err)
	}

	if _, err := (&FileService{}).ReadFile(path, 0); err == nil {
		t.Fatal("读取目录时应返回错误")
	} else if !strings.Contains(err.Error(), "不是普通文件") {
		t.Fatalf("目录错误信息不清晰: %v", err)
	}
}
