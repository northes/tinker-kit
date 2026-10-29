package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// persistentSFTPSession 供目录浏览与异步元数据查询复用同一条 SSH/SFTP 连接。
// refs 保护已经借出的会话，配置变化时旧会话会在最后一个调用结束后关闭。
type persistentSFTPSession struct {
	connection SSHConnection
	ssh        *ssh.Client
	sftp       *sftp.Client
	refs       int
	retired    bool
}

func closePersistentSFTPSession(session *persistentSFTPSession) {
	if session == nil {
		return
	}
	if session.sftp != nil {
		_ = session.sftp.Close()
	}
	closeSSHClient(session.ssh)
}

func (s *FileService) acquirePersistentSFTP(
	ctx context.Context,
	sourceID string,
	connection SSHConnection,
) (*persistentSFTPSession, error) {
	for {
		s.sessionMu.Lock()
		cached := s.sessions[sourceID]
		if cached != nil && cached.connection == connection && !cached.retired {
			cached.refs++
			s.sessionMu.Unlock()
			return cached, nil
		}
		s.sessionMu.Unlock()

		sshClient, sftpClient, err := s.dialSFTP(ctx, connection)
		if err != nil {
			return nil, err
		}
		candidate := &persistentSFTPSession{
			connection: connection,
			ssh:        sshClient,
			sftp:       sftpClient,
			refs:       1,
		}

		var closeNow []*persistentSFTPSession
		s.sessionMu.Lock()
		cached = s.sessions[sourceID]
		if cached != nil && cached.connection == connection && !cached.retired {
			cached.refs++
			s.sessionMu.Unlock()
			closePersistentSFTPSession(candidate)
			return cached, nil
		}
		if cached != nil {
			cached.retired = true
			if cached.refs == 0 {
				closeNow = append(closeNow, cached)
			}
		}
		if s.sessions == nil {
			s.sessions = map[string]*persistentSFTPSession{}
		}
		s.sessions[sourceID] = candidate
		s.sessionMu.Unlock()
		for _, session := range closeNow {
			closePersistentSFTPSession(session)
		}
		return candidate, nil
	}
}

func (s *FileService) releasePersistentSFTP(session *persistentSFTPSession) {
	if session == nil {
		return
	}
	closeNow := false
	s.sessionMu.Lock()
	session.refs--
	closeNow = session.retired && session.refs == 0
	s.sessionMu.Unlock()
	if closeNow {
		closePersistentSFTPSession(session)
	}
}

func (s *FileService) invalidatePersistentSFTP(sourceID string, session *persistentSFTPSession) {
	s.sessionMu.Lock()
	if s.sessions[sourceID] == session {
		delete(s.sessions, sourceID)
	}
	session.retired = true
	closeNow := session.refs == 0
	s.sessionMu.Unlock()
	if closeNow {
		closePersistentSFTPSession(session)
	}
}

func (s *FileService) shutdown() {
	s.requestMu.Lock()
	for requestID, cancel := range s.requests {
		cancel()
		delete(s.requests, requestID)
	}
	s.requestMu.Unlock()
	s.sessionMu.Lock()
	sessions := make([]*persistentSFTPSession, 0, len(s.sessions))
	for sourceID, session := range s.sessions {
		delete(s.sessions, sourceID)
		session.retired = true
		if session.refs == 0 {
			sessions = append(sessions, session)
		}
	}
	s.sessionMu.Unlock()
	for _, session := range sessions {
		closePersistentSFTPSession(session)
	}
}

func (s *FileService) authMethods(conn SSHConnection) ([]ssh.AuthMethod, error) {
	methods := make([]ssh.AuthMethod, 0, 3)
	if conn.Password != "" {
		methods = append(methods, passwordAuthMethods(conn.Password)...)
	}
	keyData := conn.PrivateKey
	var err error
	if keyData == "" && conn.PrivateKeyPath != "" {
		keyData, err = readSSHPrivateKeyFile(conn.PrivateKeyPath)
	}
	if err != nil {
		return nil, userError("errors.sshFile.readPrivateKeyFailed")
	}
	if keyData != "" {
		var signer ssh.Signer
		if conn.KeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyData), []byte(conn.KeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyData))
		}
		if err != nil {
			return nil, userError("errors.sshFile.parsePrivateKeyFailed")
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if len(methods) == 0 {
		return nil, userError("errors.sshFile.noAuthCredentials")
	}
	return methods, nil
}

func closeSSHClient(client *ssh.Client) {
	if client != nil {
		_ = client.Close()
	}
}

func remoteDownloadSFTPOptions() []sftp.ClientOption {
	return []sftp.ClientOption{
		sftp.MaxPacketUnchecked(int(remoteDownloadPacketSize)),
		sftp.MaxConcurrentRequestsPerFile(remoteDownloadSFTPRequestCount),
		sftp.UseConcurrentWrites(true),
	}
}

func remoteUploadSFTPOptions() []sftp.ClientOption {
	return []sftp.ClientOption{
		sftp.MaxPacketUnchecked(int(remoteDownloadPacketSize)),
		sftp.MaxConcurrentRequestsPerFile(remoteUploadSFTPRequestCount),
		sftp.UseConcurrentWrites(true),
	}
}

func remoteDownloadConnectionWanted(files []*remoteDownloadFile, configured ...int) int {
	connectionLimit := remoteDownloadConnectionCount
	if len(configured) > 0 && configured[0] > 0 {
		connectionLimit = clampTaskLimit(configured[0])
	}
	segments := 0
	for _, file := range files {
		if file == nil || file.size <= 0 {
			continue
		}
		n := file.size / remoteDownloadSegmentSize
		if file.size%remoteDownloadSegmentSize != 0 {
			n++
		}
		segments += int(n)
	}
	if segments <= 1 {
		return 1
	}
	if segments > connectionLimit {
		return connectionLimit
	}
	return segments
}

func closeDownloadSFTPClients(sshClients []*ssh.Client, sftpClients []*sftp.Client) {
	for _, client := range sftpClients {
		if client != nil {
			_ = client.Close()
		}
	}
	for _, client := range sshClients {
		closeSSHClient(client)
	}
}

func (s *FileService) expandSFTPClients(
	ctx context.Context,
	conn SSHConnection,
	sshClients []*ssh.Client,
	sftpClients []*sftp.Client,
	wanted int,
	clientOptions ...sftp.ClientOption,
) ([]*ssh.Client, []*sftp.Client) {
	extra := wanted - len(sftpClients)
	if extra <= 0 || ctx.Err() != nil {
		return sshClients, sftpClients
	}
	type dialed struct {
		ssh  *ssh.Client
		sftp *sftp.Client
	}
	results := make(chan dialed, extra)
	var wait sync.WaitGroup
	options := clientOptions
	if len(options) == 0 {
		options = remoteDownloadSFTPOptions()
	}
	for range extra {
		wait.Add(1)
		go func() {
			defer wait.Done()
			extraSSH, extraSFTP, err := s.dialSFTPWithOptions(ctx, conn, options...)
			if err != nil {
				if extraSFTP != nil {
					_ = extraSFTP.Close()
				}
				closeSSHClient(extraSSH)
				return
			}
			results <- dialed{ssh: extraSSH, sftp: extraSFTP}
		}()
	}
	go func() {
		wait.Wait()
		close(results)
	}()
	for item := range results {
		sshClients = append(sshClients, item.ssh)
		sftpClients = append(sftpClients, item.sftp)
	}
	return sshClients, sftpClients
}

func newSystemSFTPCommand(ctx context.Context, alias string) *exec.Cmd {
	return exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-s", alias, "sftp")
}

func newSystemSSHCommand(ctx context.Context, alias, remoteCommand string) *exec.Cmd {
	return exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "RequestTTY=no", alias, remoteCommand)
}

func remoteTransferCommand(operation, source, destination string) string {
	command := "cp -a "
	if operation == remoteFileOperationMove {
		command = "mv "
	}
	return command + shellQuote(source) + " " + shellQuote(destination)
}

func remoteDeleteCommand(remotePaths []string) string {
	quotedPaths := make([]string, len(remotePaths))
	for index, remotePath := range remotePaths {
		quotedPaths[index] = shellQuote(remotePath)
	}
	return "rm -rf -- " + strings.Join(quotedPaths, " ")
}

const remoteArchiveProgressPollInterval = 500 * time.Millisecond

const (
	// 大文件用多条 SSH/SFTP 连接分片，各自占用独立 TCP 窗口和加解密循环。
	remoteDownloadConnectionCount       = 4
	remoteDownloadSegmentSize     int64 = 8 * 1024 * 1024
	// 上传按活动连接数自适应分片与请求窗口，降低高 RTT 链路的尾部等待。
	remoteUploadMinWindowSize int64 = 1 * 1024 * 1024
	remoteUploadMaxWindowSize int64 = 8 * 1024 * 1024
	remoteUploadWindowBudget  int64 = 64 * 1024 * 1024
	// 与几乎所有 SFTP 服务器都支持的 32KiB 包对齐，避免大包被短读后整段失败。
	remoteDownloadPacketSize int64 = 32 * 1024
	// 任务事件与 SFTP 包解耦，合并进度推送，避免每个包都发全量快照。
	remoteDownloadProgressEmitInterval = 80 * time.Millisecond
	// 单条连接上的在途读请求数，用来填满该连接的带宽时延积。
	remoteDownloadSFTPRequestCount = 32
	remoteUploadSFTPRequestCount   = int(remoteUploadMaxWindowSize / remoteDownloadPacketSize)
)

func (s *FileService) dialSFTP(ctx context.Context, conn SSHConnection) (*ssh.Client, *sftp.Client, error) {
	return s.dialSFTPWithOptions(ctx, conn)
}

func (s *FileService) dialSFTPWithOptions(
	ctx context.Context,
	conn SSHConnection,
	options ...sftp.ClientOption,
) (*ssh.Client, *sftp.Client, error) {
	releaseHandshake, err := fileSSHHandshakeGate.acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer releaseHandshake()

	if conn.Mode == "local" {
		alias := strings.TrimSpace(conn.Alias)
		if !validSSHHost(alias) {
			return nil, nil, userError("errors.sshFile.invalidLocalSSHAlias")
		}
		command := newSystemSFTPCommand(ctx, alias)
		stdout, err := command.StdoutPipe()
		if err != nil {
			return nil, nil, userError("errors.sshFile.startSystemSSHFailed")
		}
		stdin, err := command.StdinPipe()
		if err != nil {
			return nil, nil, userError("errors.sshFile.startSystemSSHFailed")
		}
		var stderr bytes.Buffer
		command.Stderr = &stderr
		if err := command.Start(); err != nil {
			return nil, nil, userErrorCause("errors.sshFile.startSystemSSHFailed", err)
		}
		client, err := sftp.NewClientPipe(stdout, stdin, options...)
		if err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			if detail := strings.TrimSpace(stderr.String()); detail != "" {
				return nil, nil, userErrorCause("errors.sshFile.systemSFTPFailed", errors.New(detail))
			}
			return nil, nil, userErrorCause("errors.sshFile.createSFTPSessionFailed", err)
		}
		go func() { _ = command.Wait() }()
		return nil, client, nil
	}
	auth, err := s.authMethods(conn)
	if err != nil {
		return nil, nil, err
	}
	config := s.configSnapshot()
	hostKeyCallback, err := newAppSSHHostKeyCallback(config.Language)
	if err != nil {
		return nil, nil, userErrorCause("errors.sshFile.readKnownHostsFailed", err)
	}
	host := strings.TrimPrefix(strings.TrimSuffix(conn.Host, "]"), "[")
	port := conn.Port
	if port == 0 {
		port = 22
	}
	jumps, err := sshJumpConnections(config.SSHProfiles, conn)
	if err != nil {
		return nil, nil, err
	}
	hops, err := sshJumpHops(jumps, hostKeyCallback, 15*time.Second)
	if err != nil {
		return nil, nil, err
	}
	hops = append(hops, sshChainHop{
		name:    conn.Name,
		address: net.JoinHostPort(host, fmt.Sprintf("%d", port)),
		config:  &ssh.ClientConfig{User: conn.Username, Auth: auth, HostKeyCallback: hostKeyCallback, Timeout: 15 * time.Second},
	})
	client, err := dialSSHChain(ctx, hops)
	if err != nil {
		var dialErr *sshDialError
		if errors.As(err, &dialErr) || ctx.Err() != nil {
			return nil, nil, err
		}
		var hostKeyErr *sshHostKeyError
		if errors.As(err, &hostKeyErr) {
			return nil, nil, hostKeyErr
		}
		// 跳板机失败已经指明确切机器，不能再简化成目标的认证或连接错误。
		var localized *localizedError
		if errors.As(err, &localized) {
			return nil, nil, err
		}
		if isSSHAuthenticationFailure(err) {
			return nil, nil, userError("errors.sshFile.authFailed")
		}
		return nil, nil, userErrorCause("errors.ssh.connectFailed", err)
	}
	sftpClient, err := sftp.NewClient(client, options...)
	if err != nil {
		_ = client.Close()
		return nil, nil, userErrorCause("errors.sshFile.createSFTPSessionFailed", err)
	}
	return client, sftpClient, nil
}
