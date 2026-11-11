package main

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// startStalledSSHServer 只接受 TCP 连接、从不进行 SSH 握手，用来模拟卡在连接阶段的远端。
func startStalledSSHServer(t *testing.T, onConnect ...func()) string {
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
			for _, notify := range onConnect {
				notify()
			}
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

func stalledSSHFileService(t *testing.T, onConnect ...func()) *FileService {
	t.Helper()
	host, portText, err := net.SplitHostPort(startStalledSSHServer(t, onConnect...))
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// TCP 已接通但 SSH 握手尚未完成时取消，避免固定延迟造成时序不确定。
	service := stalledSSHFileService(t, cancel)
	started := time.Now()
	listing, err := service.ListRemoteFiles(ctx, "source", "/", false, "req-1")
	if err != nil {
		t.Fatalf("主动取消不能向已取消的 Wails 调用返回错误，否则触发 CancelledRejectionError: %v", err)
	}
	if listing.Path != "" || len(listing.Entries) != 0 {
		t.Fatalf("取消后不应返回目录内容: %+v", listing)
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

func TestListRemoteFilesHonorsAlreadyCanceledContext(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.ListRemoteFiles(ctx, "source", "/", false, "req-2"); err != nil {
		t.Fatalf("已取消的绑定调用应正常结束且不建立连接，实际: %v", err)
	}
}

func TestListRemoteFilesPreservesDeadlineError(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := service.ListRemoteFiles(ctx, "source", "/", false, "deadline"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("超时仍须返回错误，不能被当作主动取消: %v", err)
	}
}

func TestListRemoteFilesPreservesConnectionError(t *testing.T) {
	service := stalledSSHFileService(t)
	service.config.cfg.SSHProfiles[0].Password = ""
	if _, err := service.ListRemoteFiles(context.Background(), "source", "/", false, "auth"); err == nil {
		t.Fatal("未提供认证凭据时仍须返回连接错误")
	}
}

func TestAcquirePersistentSFTPHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	service := stalledSSHFileService(t, cancel)
	_, connection, err := service.sourceSnapshot("source")
	if err != nil {
		t.Fatal(err)
	}
	session, err := service.acquirePersistentSFTP(ctx, "source", connection)
	if !errors.Is(err, context.Canceled) || session != nil {
		t.Fatalf("连接层仍须传播取消且不能返回会话: session=%v, err=%v", session, err)
	}
}

func TestReadRemoteTextFileHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	service := stalledSSHFileService(t, cancel)
	file, err := service.ReadRemoteTextFile(ctx, "source", "/etc/hosts", 0)
	if err != nil || file != (RemoteTextFile{}) {
		t.Fatalf("关闭正在连接的编辑器不能向已取消的 Wails 调用返回错误: %#v, %v", file, err)
	}
}

func TestCanceledFileBindingsDoNotRejectValidationErrors(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.ListRemoteFiles(ctx, "missing", "/", false, "canceled"); err != nil {
		t.Fatalf("已取消的目录调用不能再返回校验错误: %v", err)
	}
	if _, err := service.SearchRemoteFiles(ctx, "missing", "/", "", "invalid", "invalid", false, "canceled"); err != nil {
		t.Fatalf("已取消的搜索调用不能再返回校验错误: %v", err)
	}
	if _, err := service.ReadRemoteTextFile(ctx, "missing", "", 0); err != nil {
		t.Fatalf("已取消的编辑器读取不能再返回校验错误: %v", err)
	}
	if _, err := service.GetRemoteCreationTimes(ctx, "missing", []string{"/file"}); err != nil {
		t.Fatalf("已取消的元数据读取不能再返回校验错误: %v", err)
	}
}

func TestReadRemoteTextFilePreservesDeadlineError(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := service.ReadRemoteTextFile(ctx, "source", "/etc/hosts", 0); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("读取超时不能被当作主动取消: %v", err)
	}
}

func TestGetRemoteFileEntryDoesNotRejectCanceledConnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	service := stalledSSHFileService(t, cancel)
	entry, err := service.GetRemoteFileEntry(ctx, "source", "/etc/hosts")
	if err != nil || entry != (RemoteFileEntry{}) {
		t.Fatalf("取消正在建立的收藏解析不能向已取消的 Wails 调用返回错误: %#v, %v", entry, err)
	}
}

func TestGetRemoteFileEntryAlreadyCanceledDoesNotReject(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.GetRemoteFileEntry(ctx, "missing", "/etc/hosts"); err != nil {
		t.Fatalf("已取消的条目解析不能再返回校验错误: %v", err)
	}
}

type cancelOnReadConn struct {
	net.Conn
	cancel func()
	once   sync.Once
}

func (c *cancelOnReadConn) Read(p []byte) (int, error) {
	c.once.Do(c.cancel)
	return 0, net.ErrClosed
}

func (c *cancelOnReadConn) Write(p []byte) (int, error) {
	c.once.Do(c.cancel)
	return 0, net.ErrClosed
}

func TestDialCanceledContextWinsOverHandshakeFailure(t *testing.T) {
	for attempt := 0; attempt < 40; attempt++ {
		left, right := net.Pipe()
		ctx, cancel := context.WithCancel(context.Background())
		wrapped := &cancelOnReadConn{Conn: right, cancel: cancel}
		_, err := dialSSHClientVia(ctx, func(context.Context, string) (net.Conn, error) {
			return wrapped, nil
		}, "127.0.0.1:22", &ssh.ClientConfig{
			User:            "deploy",
			Auth:            []ssh.AuthMethod{ssh.Password("secret")},
			HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		})
		_ = left.Close()
		_ = right.Close()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("第 %d 次：取消与握手失败同时发生时必须返回 context.Canceled，实际: %v", attempt, err)
		}
	}
}

func TestGetRemoteFileEntryPreservesDeadlineError(t *testing.T) {
	service := stalledSSHFileService(t)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := service.GetRemoteFileEntry(ctx, "source", "/etc/hosts"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("条目解析超时不能被当作主动取消: %v", err)
	}
}
