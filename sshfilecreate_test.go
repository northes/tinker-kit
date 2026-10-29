package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
)

func TestCreateRemoteTextFileCreatesEditableEmptyFile(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "纯文本 notes.txt")
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		if err := createRemoteText(client, filePath); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filePath)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() || info.Size() != 0 || info.Mode().Perm()&0o111 != 0 {
			t.Fatalf("新文件不是无执行权限的空白普通文件: %v", info)
		}
		text, _, err := readRemoteText(client, filePath)
		if err != nil || text.Content != "" || text.Revision == "" {
			t.Fatalf("新文件无法通过现有文本编辑链路读取: %#v, %v", text, err)
		}
		if _, err := saveRemoteText(client, filePath, "第一行\n", text.Revision); err != nil {
			t.Fatal(err)
		}
		contents, err := os.ReadFile(filePath)
		if err != nil || string(contents) != "第一行\n" {
			t.Fatalf("编辑后的文件内容不正确: %q, %v", contents, err)
		}
	})
}

func TestCreateRemoteTextFileRejectsExistingEntriesWithoutOverwrite(t *testing.T) {
	root := t.TempDir()
	original := filepath.Join(root, "existing.txt")
	directory := filepath.Join(root, "folder")
	link := filepath.Join(root, "link.txt")
	dangling := filepath.Join(root, "dangling.txt")
	missingTarget := filepath.Join(root, "not-created.txt")
	if err := os.WriteFile(original, []byte("保留原内容"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(original, link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(missingTarget, dangling); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		for _, filePath := range []string{original, directory, link, dangling} {
			if err := createRemoteText(client, filePath); localizedErrorKey(err) != "errors.sshFile.targetExists" {
				t.Fatalf("已存在的项目应返回冲突: %s, %v", filePath, err)
			}
		}
	})
	contents, err := os.ReadFile(original)
	if err != nil || string(contents) != "保留原内容" {
		t.Fatalf("已有内容被覆盖: %q, %v", contents, err)
	}
	if _, err := os.Stat(missingTarget); !os.IsNotExist(err) {
		t.Fatalf("不应跟随悬空符号链接创建文件: %v", err)
	}
}

func TestCreateRemoteTextFileDoesNotCreateMissingParent(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "missing")
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		if err := createRemoteText(client, filepath.Join(parent, "notes.txt")); err == nil {
			t.Fatal("父目录不存在时不应成功")
		}
	})
	if _, err := os.Stat(parent); !os.IsNotExist(err) {
		t.Fatalf("不应隐式创建父目录: %v", err)
	}
}

func TestCreateRemoteTextFileRejectsInvalidPathsBeforeConnecting(t *testing.T) {
	service := &FileService{}
	for _, remotePath := range []string{"", " ", "/", "/folder/..", "/bad\x00name"} {
		if err := service.CreateRemoteTextFile(context.Background(), "", remotePath); localizedErrorKey(err) != "errors.sshFile.textPathInvalid" {
			t.Fatalf("应在建立连接前拒绝无效路径 %q: %v", remotePath, err)
		}
	}
}

func TestCreateRemoteTextFileHasOneConcurrentWinner(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "concurrent.txt")
	withTestSFTPClients(t, root, 2, func(clients []*sftp.Client) {
		start := make(chan struct{})
		results := make(chan error, len(clients))
		for _, client := range clients {
			go func() {
				<-start
				results <- createRemoteText(client, filePath)
			}()
		}
		close(start)
		succeeded := 0
		for range clients {
			if <-results == nil {
				succeeded++
			}
		}
		if succeeded != 1 {
			t.Fatalf("并发创建只能有一个成功，实际为 %d", succeeded)
		}
	})
}
