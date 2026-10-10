package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pkg/sftp"
)

func TestRemoteTextEditPreservesFileAndRejectsStaleRevision(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(filePath, []byte("原内容\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		original, _, err := readRemoteText(client, filePath)
		if err != nil {
			t.Fatal(err)
		}
		revision, err := saveRemoteText(client, filePath, "更新内容\n", original.Revision)
		if err != nil {
			t.Fatal(err)
		}
		updated, mode, err := readRemoteText(client, filePath)
		if err != nil {
			t.Fatal(err)
		}
		if updated.Content != "更新内容\n" || updated.Revision != revision || mode != 0o640 {
			t.Fatalf("保存后的内容、版本或权限不正确: %#v, %o", updated, mode)
		}
		if _, err := saveRemoteText(client, filePath, "过期覆盖", original.Revision); err == nil {
			t.Fatal("旧版本不应覆盖新内容")
		}
		contents, err := os.ReadFile(filePath)
		if err != nil || string(contents) != "更新内容\n" {
			t.Fatalf("版本冲突后文件被改写: %q, %v", contents, err)
		}
	})
}

func TestRemoteTextEditRejectsBinaryAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	binaryPath := filepath.Join(root, "binary.txt")
	largePath := filepath.Join(root, "large.txt")
	if err := os.WriteFile(binaryPath, []byte{'a', 0, 'b'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(largePath, []byte(strings.Repeat("x", remoteTextFileLimit+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		if _, _, err := readRemoteText(client, binaryPath); err == nil {
			t.Fatal("二进制文件不应进入文本编辑器")
		}
		if _, _, err := readRemoteText(client, largePath); err == nil {
			t.Fatal("超大文件不应进入文本编辑器")
		}
	})
}
