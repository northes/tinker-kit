package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNormalizedRemotePath(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", "/"},
		{"var/log", "/var/log"},
		{"//var///log/", "/var/log"},
		{"/var/../tmp", "/tmp"},
	}
	for _, test := range tests {
		if got := normalizedRemotePath(test.input); got != test.want {
			t.Errorf("normalizedRemotePath(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

func TestValidateSSHFileConfigAllowsSharedConnection(t *testing.T) {
	connections := []SSHConnection{{ID: "prod", Name: "生产", Host: "example.com", Port: 22, Username: "deploy", Password: "secret"}}
	sources := []FileSource{
		{ID: "app", Name: "应用目录", SSHConnectionID: "prod", DefaultPath: "/srv/app"},
		{ID: "logs", Name: "日志目录", SSHConnectionID: "prod", DefaultPath: "/var/log"},
	}
	if err := validateSSHFileConfig(connections, sources); err != nil {
		t.Fatalf("共享 SSH 连接的多个源不应失败: %v", err)
	}
	if connections[0].Port != 22 {
		t.Fatalf("默认端口被意外修改: %d", connections[0].Port)
	}
}

func TestValidateSSHFileConfigAllowsLocalSSHAlias(t *testing.T) {
	connections := []SSHConnection{{ID: "local", Name: "开发机", Mode: "local", Alias: "dev-box"}}
	sources := []FileSource{{ID: "home", Name: "主目录", SSHConnectionID: "local", DefaultPath: "/home/dev"}}
	if err := validateSSHFileConfig(connections, sources); err != nil {
		t.Fatalf("本地 SSH 配置不应要求重复填写凭据: %v", err)
	}
	if connections[0].Host != "dev-box" || connections[0].Mode != "local" {
		t.Fatalf("本地 SSH 配置未规范化: %#v", connections[0])
	}
}

func TestNewSystemSFTPCommandUsesSSHSubsystem(t *testing.T) {
	cmd := newSystemSFTPCommand(context.Background(), "dev-box")
	if got, want := cmd.Args, []string{"ssh", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-s", "dev-box", "sftp"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("系统 SSH SFTP 参数 = %#v, want %#v", got, want)
	}
}

func TestValidateSSHFileConfigRejectsDanglingSource(t *testing.T) {
	err := validateSSHFileConfig(
		[]SSHConnection{{ID: "prod", Name: "生产", Host: "example.com", Username: "deploy", Password: "secret"}},
		[]FileSource{{ID: "logs", Name: "日志目录", SSHConnectionID: "missing", DefaultPath: "/var/log"}},
	)
	if err == nil {
		t.Fatal("引用不存在 SSH 连接的文件源应被拒绝")
	}
}

func TestLocalTreeCountsRegularFilesAndBytes(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first.txt")
	nested := filepath.Join(root, "nested", "second.bin")
	if err := os.MkdirAll(filepath.Dir(nested), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(first, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nested, []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	total, files, err := localTree(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if total != 8 || files != 2 {
		t.Fatalf("localTree() = (%d, %d), want (8, 2)", total, files)
	}
}

func TestCopySSHConfigSlicesAreIndependent(t *testing.T) {
	original := []SSHConnection{{ID: "prod", Name: "生产"}}
	copy := copySSHConnections(original)
	copy[0].Name = "changed"
	if reflect.DeepEqual(original, copy) {
		t.Fatal("复制 SSH 连接切片后修改副本不应影响原切片")
	}
}
