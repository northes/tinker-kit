package main

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

// startStalledSSHServer 只接受 TCP 连接、从不进行 SSH 握手，用来模拟卡在连接阶段的远端。
func startStalledSSHServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("启动测试监听失败: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	var mu sync.Mutex
	var held []net.Conn
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			mu.Lock()
			held = append(held, conn)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, conn := range held {
			_ = conn.Close()
		}
	})
	return listener.Addr().String()
}

func stalledSSHFileService(t *testing.T) *FileService {
	t.Helper()
	host, portText, err := net.SplitHostPort(startStalledSSHServer(t))
	if err != nil {
		t.Fatalf("解析测试地址失败: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("解析测试端口失败: %v", err)
	}
	profile := SSHProfile{ID: "profile", Name: "卡住的机器", Host: host, Port: port, Username: "deploy", Password: "secret"}
	return &FileService{config: &ConfigService{cfg: normalizeConfig(Config{
		SSHProfiles: []SSHProfile{profile},
		FileSources: []FileSource{{ID: "source", Name: "卡住的来源", SSHProfileID: profile.ID}},
	})}}
}

func TestListRemoteFilesAbortsWhileConnecting(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond)
		cancel()
	}()
	started := time.Now()
	_, err := service.ListRemoteFiles(ctx, "source", "/", false, "req-1")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("连接阶段取消应返回 context.Canceled，实际: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("取消后应及时返回，实际耗时 %s", elapsed)
	}
	service.sessionMu.Lock()
	cached := len(service.sessions)
	service.sessionMu.Unlock()
	if cached != 0 {
		t.Fatalf("取消的连接不应缓存会话: %d", cached)
	}
}

func TestListRemoteFilesRejectsAlreadyCanceledContext(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.ListRemoteFiles(ctx, "source", "/", false, "req-2"); !errors.Is(err, context.Canceled) {
		t.Fatalf("已取消的调用不应建立连接，实际: %v", err)
	}
}

func TestReadRemoteTextFileHonorsCanceledContext(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond)
		cancel()
	}()
	if _, err := service.ReadRemoteTextFile(ctx, "source", "/etc/hosts"); !errors.Is(err, context.Canceled) {
		t.Fatalf("读取文本时取消应返回 context.Canceled，实际: %v", err)
	}
}
