package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
)

func TestFavoriteRemoteFileEntryResolvesCurrentType(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "config.json")
	if err := os.WriteFile(file, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.json")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	profile := SSHProfile{ID: "profile", Name: "测试", Host: "example.com", Username: "test", Password: "fixture"}
	service := &FileService{config: &ConfigService{cfg: normalizeConfig(Config{
		SSHProfiles: []SSHProfile{profile},
		FileSources: []FileSource{{ID: "source", Name: "测试", SSHProfileID: "profile", FavoritePaths: []string{file, root}}},
	})}}
	_, conn, err := service.sourceSnapshot("source")
	if err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		service.sessions = map[string]*persistentSFTPSession{"source": {connection: conn, sftp: client}}
		entry, err := service.GetRemoteFileEntry("source", file)
		if err != nil || entry.IsDir || entry.IsSymlink || entry.Path != file || entry.Size != 2 {
			t.Fatalf("文件收藏解析错误: %#v, %v", entry, err)
		}
		entry, err = service.GetRemoteFileEntry("source", root)
		if err != nil || !entry.IsDir {
			t.Fatalf("目录收藏解析错误: %#v, %v", entry, err)
		}
		entry, err = service.GetRemoteFileEntry("source", link)
		if err != nil || !entry.IsSymlink {
			t.Fatalf("符号链接不能作为普通文本文件打开: %#v, %v", entry, err)
		}
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
		if _, err := service.GetRemoteFileEntry("source", file); err == nil {
			t.Fatal("失效收藏必须返回错误")
		}
	})
}
