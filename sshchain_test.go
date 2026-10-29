package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// testSSHServer 是测试用的最小 SSH 服务端：既接受会话执行，也可按路由表
// 接受 direct-tcpip 转发，用来验证跳板机链路真的经过上一跳。
type testSSHServer struct {
	address string
	sftpDir string
	active  atomic.Int32
}

func startTestSSHServer(t *testing.T, user, password string, routes map[string]string) *testSSHServer {
	return startTestSSHServerWithOptions(t, user, password, routes, "")
}

func startTestSFTPServer(t *testing.T, user, password, dir string) *testSSHServer {
	return startTestSSHServerWithOptions(t, user, password, nil, dir)
}

func startTestSSHServerWithOptions(t *testing.T, user, password string, routes map[string]string, sftpDir string) *testSSHServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("启动测试 SSH 监听失败: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成测试主机密钥失败: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatalf("构造测试主机密钥失败: %v", err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(metadata ssh.ConnMetadata, given []byte) (*ssh.Permissions, error) {
			if metadata.User() == user && string(given) == password {
				return nil, nil
			}
			return nil, errTestSSHAuth
		},
	}
	config.AddHostKey(signer)
	server := &testSSHServer{address: listener.Addr().String(), sftpDir: sftpDir}
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go server.handle(conn, config, routes)
		}
	}()
	return server
}

var errTestSSHAuth = &localizedError{Key: "tests.sshAuthRejected"}

func (s *testSSHServer) handle(conn net.Conn, config *ssh.ServerConfig, routes map[string]string) {
	serverConn, chans, reqs, err := ssh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer serverConn.Close()
	go ssh.DiscardRequests(reqs)
	for newChannel := range chans {
		switch newChannel.ChannelType() {
		case "direct-tcpip":
			var payload struct {
				Host       string
				Port       uint32
				OriginHost string
				OriginPort uint32
			}
			if err := ssh.Unmarshal(newChannel.ExtraData(), &payload); err != nil {
				_ = newChannel.Reject(ssh.Prohibited, "bad payload")
				continue
			}
			address := net.JoinHostPort(payload.Host, strconv.Itoa(int(payload.Port)))
			route, ok := routes[address]
			if !ok {
				_ = newChannel.Reject(ssh.ConnectionFailed, "no route")
				continue
			}
			upstream, dialErr := net.Dial("tcp", route)
			if dialErr != nil {
				_ = newChannel.Reject(ssh.ConnectionFailed, "route dial failed")
				continue
			}
			channel, requests, acceptErr := newChannel.Accept()
			if acceptErr != nil {
				_ = upstream.Close()
				continue
			}
			s.active.Add(1)
			go func() {
				for range requests {
				}
			}()
			go func() {
				defer s.active.Add(-1)
				defer upstream.Close()
				defer channel.Close()
				done := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(upstream, channel); done <- struct{}{} }()
				go func() { _, _ = io.Copy(channel, upstream); done <- struct{}{} }()
				<-done
			}()
		case "session":
			channel, requests, acceptErr := newChannel.Accept()
			if acceptErr != nil {
				continue
			}
			go s.handleSession(channel, requests)
		default:
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func (s *testSSHServer) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	for request := range requests {
		switch request.Type {
		case "exec":
			_ = request.Reply(true, nil)
			_, _ = channel.Write([]byte("ok"))
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			return
		case "subsystem":
			var payload struct{ Name string }
			if s.sftpDir == "" || ssh.Unmarshal(request.Payload, &payload) != nil || payload.Name != "sftp" {
				if request.WantReply {
					_ = request.Reply(false, nil)
				}
				continue
			}
			_ = request.Reply(true, nil)
			server, err := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(s.sftpDir))
			if err != nil {
				return
			}
			_ = server.Serve()
			_ = server.Close()
			return
		default:
			if request.WantReply {
				_ = request.Reply(false, nil)
			}
		}
	}
}

func testSSHClientConfig(user, password string) *ssh.ClientConfig {
	return &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
}

func awaitTestSSHServerIdle(t *testing.T, server *testSSHServer, label string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for server.active.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%s 的转发连接未随下游关闭而释放: %d", label, server.active.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDialSSHChainConnectsThroughJump(t *testing.T) {
	target := startTestSSHServer(t, "target-user", "target-pass", nil)
	jump := startTestSSHServer(t, "jump-user", "jump-pass", map[string]string{"target.test:22": target.address})
	hops := []sshChainHop{
		{name: "sshA", address: jump.address, config: testSSHClientConfig("jump-user", "jump-pass")},
		// target.test 只有跳板机能解析，客户端直接拨号不会成功。
		{name: "sshB", address: "target.test:22", config: testSSHClientConfig("target-user", "target-pass")},
	}
	client, err := dialSSHChain(context.Background(), hops)
	if err != nil {
		t.Fatalf("经跳板机连接目标失败: %v", err)
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("目标会话建立失败: %v", err)
	}
	output, err := session.Output("echo ok")
	if err != nil || string(output) != "ok" {
		t.Fatalf("经跳板机执行命令结果异常: %q, %v", output, err)
	}
	_ = session.Close()
	if jump.active.Load() != 1 {
		t.Fatalf("跳板机应保持一条转发连接: %d", jump.active.Load())
	}
	closeSSHClient(client)
	awaitTestSSHServerIdle(t, jump, "跳板机")
}

func TestDialSSHChainSupportsMultipleJumps(t *testing.T) {
	target := startTestSSHServer(t, "target-user", "target-pass", nil)
	inner := startTestSSHServer(t, "inner-user", "inner-pass", map[string]string{"target.test:22": target.address})
	outer := startTestSSHServer(t, "outer-user", "outer-pass", map[string]string{"inner.test:22": inner.address})
	hops := []sshChainHop{
		{name: "outer", address: outer.address, config: testSSHClientConfig("outer-user", "outer-pass")},
		{name: "inner", address: "inner.test:22", config: testSSHClientConfig("inner-user", "inner-pass")},
		{name: "target", address: "target.test:22", config: testSSHClientConfig("target-user", "target-pass")},
	}
	client, err := dialSSHChain(context.Background(), hops)
	if err != nil {
		t.Fatalf("两级跳板机连接失败: %v", err)
	}
	if _, err := client.NewSession(); err != nil {
		t.Fatalf("目标会话建立失败: %v", err)
	}
	closeSSHClient(client)
	awaitTestSSHServerIdle(t, outer, "外层跳板机")
	awaitTestSSHServerIdle(t, inner, "内层跳板机")
}

func TestDialSSHChainNamesFailingJump(t *testing.T) {
	target := startTestSSHServer(t, "target-user", "target-pass", nil)
	jump := startTestSSHServer(t, "jump-user", "jump-pass", map[string]string{"target.test:22": target.address})
	hops := []sshChainHop{
		{name: "sshA", address: jump.address, config: testSSHClientConfig("jump-user", "wrong-pass")},
		{name: "sshB", address: "target.test:22", config: testSSHClientConfig("target-user", "target-pass")},
	}
	client, err := dialSSHChain(context.Background(), hops)
	if err == nil {
		closeSSHClient(client)
		t.Fatal("跳板机认证失败时应返回错误")
	}
	if key := localizedErrorKey(err); key != "errors.ssh.jumpConnectFailed" {
		t.Fatalf("跳板机失败应指明确切机器，实际错误: %v (key=%s)", err, key)
	}
	var localized *localizedError
	if !errors.As(err, &localized) || localized.Params["name"] != "sshA" {
		t.Fatalf("跳板机失败错误缺少机器名称: %v", err)
	}
}

func TestDialSSHChainReportsUnreachableTarget(t *testing.T) {
	jump := startTestSSHServer(t, "jump-user", "jump-pass", nil)
	hops := []sshChainHop{
		{name: "sshA", address: jump.address, config: testSSHClientConfig("jump-user", "jump-pass")},
		{name: "sshB", address: "target.test:22", config: testSSHClientConfig("target-user", "target-pass")},
	}
	client, err := dialSSHChain(context.Background(), hops)
	if err == nil {
		closeSSHClient(client)
		t.Fatal("跳板机无法到达目标时应返回错误")
	}
	if key := localizedErrorKey(err); key != "" {
		t.Fatalf("目标连接失败应保留原始错误，不能误报为跳板机失败: %v (key=%s)", err, key)
	}
	awaitTestSSHServerIdle(t, jump, "跳板机")
}

func TestSSHJumpConnectionsResolvesOutermostFirst(t *testing.T) {
	profiles := []SSHProfile{
		{ID: "a", Name: "A", Host: "a.example.com", Port: 22, Username: "u", Password: "p"},
		{ID: "b", Name: "B", Host: "b.example.com", Port: 22, Username: "u", Password: "p", JumpProfileID: "a"},
		{ID: "c", Name: "C", Host: "c.example.com", Port: 2222, Username: "u", Password: "p", JumpProfileID: "b"},
	}
	jumps, err := sshJumpConnections(profiles, sshProfileToConnection(profiles[2]))
	if err != nil {
		t.Fatalf("解析跳板机链失败: %v", err)
	}
	if len(jumps) != 2 || jumps[0].ID != "a" || jumps[1].ID != "b" {
		t.Fatalf("跳板机链顺序应为最外层在前: %#v", jumps)
	}
	if direct, err := sshJumpConnections(profiles, sshProfileToConnection(profiles[0])); err != nil || len(direct) != 0 {
		t.Fatalf("没有跳板机的配置不应产生跳: %#v, %v", direct, err)
	}
}

func TestSSHJumpConnectionsRejectsDanglingAndCycles(t *testing.T) {
	dangling := []SSHProfile{{
		ID: "b", Name: "B", Host: "b.example.com", Port: 22, Username: "u", Password: "p", JumpProfileID: "missing",
	}}
	_, err := sshJumpConnections(dangling, sshProfileToConnection(dangling[0]))
	if key := localizedErrorKey(err); key != "errors.sshProfile.jumpNotFound" {
		t.Fatalf("悬空跳板机引用应返回明确错误，实际: %v (key=%s)", err, key)
	}

	cyclic := []SSHProfile{
		{ID: "a", Name: "A", Host: "a.example.com", Port: 22, Username: "u", Password: "p", JumpProfileID: "b"},
		{ID: "b", Name: "B", Host: "b.example.com", Port: 22, Username: "u", Password: "p", JumpProfileID: "a"},
	}
	_, err = sshJumpConnections(cyclic, sshProfileToConnection(cyclic[0]))
	if key := localizedErrorKey(err); key != "errors.sshProfile.jumpCycle" {
		t.Fatalf("循环跳板机引用应返回明确错误，实际: %v (key=%s)", err, key)
	}
}

func TestValidateSSHProfilesAllowsDanglingJumpButRejectsCycle(t *testing.T) {
	// 删除跳板机会留下悬空引用，界面需要能显示并修复，因此保存时允许。
	if err := validateSSHProfiles([]SSHProfile{{
		ID: "b", Host: "b.example.com", Username: "u", Password: "p", JumpProfileID: "deleted",
	}}); err != nil {
		t.Fatalf("悬空跳板机引用应允许保存: %v", err)
	}
	err := validateSSHProfiles([]SSHProfile{
		{ID: "a", Host: "a.example.com", Username: "u", Password: "p", JumpProfileID: "b"},
		{ID: "b", Host: "b.example.com", Username: "u", Password: "p", JumpProfileID: "a"},
	})
	if key := localizedErrorKey(err); key != "errors.sshProfile.jumpCycle" {
		t.Fatalf("循环跳板机引用应拒绝保存，实际: %v (key=%s)", err, key)
	}
	if _, err := normalizeSSHProfile(SSHProfile{
		ID: "a", Host: "a.example.com", Username: "u", Password: "p", JumpProfileID: "a",
	}); err == nil {
		t.Fatal("配置不应把自身设为跳板机")
	}
}

// trustTestSSHHosts 让应用内 known_hosts 在测试中直接信任首次出现的主机指纹，
// 避免依赖界面确认事件。
func trustTestSSHHosts(t *testing.T) {
	t.Helper()
	applicationSSHKnownHosts.mu.Lock()
	previous := applicationSSHKnownHosts.store
	applicationSSHKnownHosts.store = &sshKnownHostStore{
		path:   filepath.Join(t.TempDir(), "known_hosts"),
		prompt: func(string, string, ssh.PublicKey, []knownhosts.KnownKey) bool { return true },
	}
	applicationSSHKnownHosts.mu.Unlock()
	t.Cleanup(func() {
		applicationSSHKnownHosts.mu.Lock()
		applicationSSHKnownHosts.store = previous
		applicationSSHKnownHosts.mu.Unlock()
	})
}

// testJumpFileService 构造「sshB 经 sshA 连接」的文件服务与目标连接参数。
func testJumpFileService(t *testing.T, jumpAddress, jumpPassword string) (*FileService, SSHConnection) {
	t.Helper()
	jumpHost, jumpPortText, err := net.SplitHostPort(jumpAddress)
	if err != nil {
		t.Fatalf("解析测试跳板机地址失败: %v", err)
	}
	jumpPort, err := strconv.Atoi(jumpPortText)
	if err != nil {
		t.Fatalf("解析测试跳板机端口失败: %v", err)
	}
	config := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg: normalizeConfig(Config{SSHProfiles: []SSHProfile{
			{ID: "sshA", Name: "sshA", Host: jumpHost, Port: jumpPort, Username: "jump-user", Password: jumpPassword},
			{ID: "sshB", Name: "sshB", Host: "target.test", Port: 22, Username: "target-user", Password: "target-pass", JumpProfileID: "sshA"},
		}}),
	}
	return NewFileService(config), sshProfileToConnection(config.GetSSHProfiles()[1])
}

func TestFileServiceListsDirectoryThroughJump(t *testing.T) {
	remoteDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(remoteDir, "jump.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatalf("写入远端测试文件失败: %v", err)
	}
	target := startTestSFTPServer(t, "target-user", "target-pass", remoteDir)
	jump := startTestSSHServer(t, "jump-user", "jump-pass", map[string]string{"target.test:22": target.address})
	trustTestSSHHosts(t)

	service, conn := testJumpFileService(t, jump.address, "jump-pass")
	sshClient, sftpClient, err := service.dialSFTP(context.Background(), conn)
	if err != nil {
		t.Fatalf("文件管理经跳板机建立 SFTP 失败: %v", err)
	}
	defer closeDownloadSFTPClients([]*ssh.Client{sshClient}, []*sftp.Client{sftpClient})

	wantDir, err := filepath.EvalSymlinks(remoteDir)
	if err != nil {
		t.Fatalf("解析远端目录失败: %v", err)
	}
	workingDir, err := sftpClient.Getwd()
	if err != nil {
		t.Fatalf("读取远端工作目录失败: %v", err)
	}
	resolvedWorkingDir, err := filepath.EvalSymlinks(workingDir)
	if err != nil {
		t.Fatalf("解析远端工作目录失败: %v", err)
	}
	if resolvedWorkingDir != wantDir {
		t.Fatalf("远端工作目录错误: %q, want %q", workingDir, wantDir)
	}
	entries, err := sftpClient.ReadDir(".")
	if err != nil {
		t.Fatalf("经跳板机读取远端目录失败: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "jump.txt" {
		t.Fatalf("远端目录内容错误: %#v", entries)
	}
	if jump.active.Load() != 1 {
		t.Fatalf("SFTP 会话应经跳板机转发: %d", jump.active.Load())
	}
	closeDownloadSFTPClients([]*ssh.Client{sshClient}, []*sftp.Client{sftpClient})
	awaitTestSSHServerIdle(t, jump, "跳板机")
}

func TestFileServiceReportsJumpAuthenticationFailure(t *testing.T) {
	target := startTestSFTPServer(t, "target-user", "target-pass", t.TempDir())
	jump := startTestSSHServer(t, "jump-user", "jump-pass", map[string]string{"target.test:22": target.address})
	trustTestSSHHosts(t)

	service, conn := testJumpFileService(t, jump.address, "wrong-pass")
	sshClient, sftpClient, err := service.dialSFTP(context.Background(), conn)
	if err == nil {
		closeDownloadSFTPClients([]*ssh.Client{sshClient}, []*sftp.Client{sftpClient})
		t.Fatal("跳板机认证失败时不应建立 SFTP 会话")
	}
	if key := localizedErrorKey(err); key != "errors.ssh.jumpConnectFailed" {
		t.Fatalf("文件管理应指出是跳板机认证失败，实际: %v (key=%s)", err, key)
	}
	awaitTestSSHServerIdle(t, jump, "跳板机")
}
