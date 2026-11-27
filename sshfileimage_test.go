package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
)

func TestRemoteImagePathMapsSupportedExtensions(t *testing.T) {
	cases := map[string]string{
		"/tmp/photo.png":  "image/png",
		"/tmp/photo.JPG":  "image/jpeg",
		"/tmp/photo.jpeg": "image/jpeg",
		"/tmp/icon.svg":   "image/svg+xml",
		"/tmp/shot.webp":  "image/webp",
		"/tmp/scan.tiff":  "image/tiff",
		"/tmp/phone.heic": "image/heic",
		"photo.gif":       "image/gif",
	}
	for input, want := range cases {
		gotPath, gotMIME, err := remoteImagePath(input)
		if err != nil {
			t.Fatalf("remoteImagePath(%q) 返回错误: %v", input, err)
		}
		if gotMIME != want {
			t.Fatalf("remoteImagePath(%q) MIME = %q, want %q", input, gotMIME, want)
		}
		if !strings.HasPrefix(gotPath, "/") {
			t.Fatalf("remoteImagePath(%q) 未返回绝对路径: %q", input, gotPath)
		}
	}
}

func TestRemoteImagePathRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{"", "   ", "/tmp/\x00.png", "/"} {
		if _, _, err := remoteImagePath(input); localizedErrorKey(err) != "errors.sshFile.imagePathInvalid" {
			t.Fatalf("remoteImagePath(%q) 错误 = %v", input, err)
		}
	}
	if _, _, err := remoteImagePath("/tmp/notes.txt"); localizedErrorKey(err) != "errors.sshFile.imageTypeUnsupported" {
		t.Fatalf("非图片后缀应被拒绝: %v", err)
	}
	if _, _, err := remoteImagePath("/tmp/README"); localizedErrorKey(err) != "errors.sshFile.imageTypeUnsupported" {
		t.Fatalf("无后缀应被拒绝: %v", err)
	}
}

func TestReadRemoteImageReturnsDataURL(t *testing.T) {
	root := t.TempDir()
	data := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff}
	filePath := filepath.Join(root, "photo.png")
	if err := os.WriteFile(filePath, data, 0o640); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		got, err := readRemoteImage(client, filePath, "image/png")
		if err != nil {
			t.Fatal(err)
		}
		wantURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
		if got.DataURL != wantURL {
			t.Fatalf("data URL 不正确: %q", got.DataURL)
		}
		if got.MIMEType != "image/png" || got.Size != int64(len(data)) || got.Name != "photo.png" {
			t.Fatalf("元数据不正确: %#v", got)
		}
	})
}

func TestReadRemoteImageRejectsNonRegularAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	directoryPath := filepath.Join(root, "folder.png")
	if err := os.Mkdir(directoryPath, 0o750); err != nil {
		t.Fatal(err)
	}
	largePath := filepath.Join(root, "large.png")
	if err := os.WriteFile(largePath, []byte{0x89, 'P', 'N', 'G'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(largePath, remoteImageFileLimit+1); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		if _, err := readRemoteImage(client, directoryPath, "image/png"); localizedErrorKey(err) != "errors.sshFile.imageNotRegular" {
			t.Fatalf("目录不应被当作图片读取: %v", err)
		}
		if _, err := readRemoteImage(client, largePath, "image/png"); localizedErrorKey(err) != "errors.sshFile.imageTooLarge" {
			t.Fatalf("超过 10 MiB 的图片应被拒绝: %v", err)
		}
	})
}

func TestReadRemoteImageHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	service := stalledSSHFileService(t, cancel)
	file, err := service.ReadRemoteImageFile(ctx, "source", "/tmp/photo.png")
	if err != nil || file != (RemoteImageFile{}) {
		t.Fatalf("关闭正在连接的预览弹窗不能向已取消的 Wails 调用返回错误: %#v, %v", file, err)
	}
}

func TestReadRemoteImageAlreadyCanceledDoesNotReject(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.ReadRemoteImageFile(ctx, "missing", ""); err != nil {
		t.Fatalf("已取消的图片读取不能再返回校验错误: %v", err)
	}
	if _, err := service.ReadRemoteImageFile(ctx, "missing", "/tmp/photo.png"); err != nil {
		t.Fatalf("已取消的图片读取不能再返回连接错误: %v", err)
	}
}

func TestReadRemoteImagePreservesDeadlineError(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := service.ReadRemoteImageFile(ctx, "source", "/tmp/photo.png"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("图片读取超时不能被当作主动取消: %v", err)
	}
}

func TestReadRemoteImageRejectsUnsupportedExtensionBeforeConnecting(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := service.ReadRemoteImageFile(ctx, "source", "/tmp/notes.txt"); localizedErrorKey(err) != "errors.sshFile.imageTypeUnsupported" {
		t.Fatalf("非图片后缀应在建立连接前被拒绝: %v", err)
	}
}
