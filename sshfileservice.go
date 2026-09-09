package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/crypto/ssh"
)

const (
	fileTaskTypeUpload   = "upload"
	fileTaskTypeDownload = "download"
	fileTaskTypeSize     = "size"
	fileTaskTypeCopy     = "copy"
	fileTaskTypeMove     = "move"
	fileTaskTypeExtract  = "extract"
	fileTaskTypeCompress = "compress"
	fileTaskQueued       = "queued"
	fileTaskScanning     = "scanning"
	fileTaskRunning      = "running"
	fileTaskSuccess      = "success"
	fileTaskFailed       = "failed"
	fileTaskCanceled     = "canceled"
	fileTaskConflict     = "conflict"
	fileTasksEventName   = "ssh-files:tasks"
)

const (
	remoteFileOperationCopy     = fileTaskTypeCopy
	remoteFileOperationMove     = fileTaskTypeMove
	remoteFileOperationRename   = "rename"
	remoteFileOperationDelete   = "delete"
	remoteFileOperationExtract  = fileTaskTypeExtract
	remoteFileOperationCompress = fileTaskTypeCompress
)

const (
	remoteFileConflictAsk       = "ask"
	remoteFileConflictOverwrite = "overwrite"
	remoteFileConflictKeepBoth  = "keep-both"
)

type RemoteFileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	IsDir      bool   `json:"isDir"`
	IsSymlink  bool   `json:"isSymlink"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
}

type RemoteFileOperationResult struct {
	Conflicts []string `json:"conflicts,omitempty"`
}

type FileTask struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"`
	SourceID  string   `json:"sourceID"`
	Status    string   `json:"status"`
	Stage     string   `json:"stage"`
	Current   string   `json:"current,omitempty"`
	Target    string   `json:"target,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	Conflicts []string `json:"conflicts,omitempty"`
	Completed int64    `json:"completed"`
	Total     int64    `json:"total"`
	Files     int      `json:"files"`
	DoneFiles int      `json:"doneFiles"`
	Error     string   `json:"error,omitempty"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

type FileTaskSnapshot struct {
	Revision uint64     `json:"revision"`
	Tasks    []FileTask `json:"tasks"`
}

type remoteFileOperationProgress struct {
	completed  int64
	total      int64
	totalKnown bool
	files      int
	doneFiles  int
	current    string
}

type fileTaskState struct {
	FileTask
	ctx             context.Context
	cancel          context.CancelFunc
	operationPolicy string
}

// cleanupSSHDragTemps 清理上次进程遗留的跨应用拖出临时文件。
// 临时文件只用于交给 Finder 或聊天工具，不作为远程缓存保留。
func cleanupSSHDragTemps() {
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "devutils-ssh-drag-*"))
	if err != nil {
		return
	}
	for _, item := range matches {
		_ = os.RemoveAll(item)
	}
}

func (s *FileService) registerDragTemp(directory string) {
	s.dragTempMu.Lock()
	if s.dragTemps == nil {
		s.dragTemps = make(map[string]struct{})
	}
	s.dragTemps[directory] = struct{}{}
	s.dragTempMu.Unlock()
}

func (s *FileService) removeDragTemp(directory string) {
	s.dragTempMu.Lock()
	delete(s.dragTemps, directory)
	s.dragTempMu.Unlock()
	_ = os.RemoveAll(directory)
}

func (s *FileService) setEventEmitter(emit func(string, any)) { s.emitEvent = emit }

func (s *FileService) emitTasks(snapshot FileTaskSnapshot) {
	if s.emitEvent != nil {
		s.emitEvent(fileTasksEventName, snapshot)
	}
}

func (s *FileService) taskSnapshotLocked() FileTaskSnapshot {
	tasks := make([]FileTask, 0, len(s.taskOrder))
	for _, id := range s.taskOrder {
		if task := s.tasks[id]; task != nil {
			snapshot := task.FileTask
			snapshot.Paths = append([]string(nil), task.Paths...)
			snapshot.Conflicts = append([]string(nil), task.Conflicts...)
			tasks = append(tasks, snapshot)
		}
	}
	return FileTaskSnapshot{Revision: s.taskRevision, Tasks: tasks}
}

func (s *FileService) createFileTask(
	task FileTask,
	ctx context.Context,
	cancel context.CancelFunc,
) string {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task.ID = fmt.Sprintf("ssh-file-task-%d", time.Now().UnixNano())
	task.Status, task.Stage = fileTaskQueued, fileTaskQueued
	task.CreatedAt, task.UpdatedAt = now, now
	s.taskMu.Lock()
	if s.tasks == nil {
		s.tasks = map[string]*fileTaskState{}
	}
	s.tasks[task.ID] = &fileTaskState{FileTask: task, ctx: ctx, cancel: cancel}
	s.taskOrder = append(s.taskOrder, task.ID)
	s.taskRevision++
	snapshot := s.taskSnapshotLocked()
	s.taskMu.Unlock()
	s.emitTasks(snapshot)
	return task.ID
}

func (s *FileService) updateFileTask(id string, update func(*fileTaskState)) {
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return
	}
	update(task)
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.taskRevision++
	snapshot := s.taskSnapshotLocked()
	s.taskMu.Unlock()
	s.emitTasks(snapshot)
}

func (s *FileService) GetFileTasks() FileTaskSnapshot {
	s.taskMu.Lock()
	defer s.taskMu.Unlock()
	return s.taskSnapshotLocked()
}

func (s *FileService) CancelFileTask(id string) error {
	var snapshot FileTaskSnapshot
	immediate := false
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return errors.New("文件任务不存在")
	}
	if task.cancel != nil {
		task.cancel()
	}
	if task.Status == fileTaskConflict {
		task.Status, task.Stage = fileTaskCanceled, fileTaskCanceled
		task.Conflicts = nil
		task.Error = ""
		task.ctx = nil
		task.cancel = nil
		task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		s.taskRevision++
		snapshot = s.taskSnapshotLocked()
		immediate = true
	}
	s.taskMu.Unlock()
	if immediate {
		s.emitTasks(snapshot)
	}
	return nil
}

func (s *FileService) configSnapshot() Config {
	if s.config == nil {
		return defaultConfig()
	}
	return s.config.Get()
}

func copySSHConnections(items []SSHConnection) []SSHConnection {
	return append([]SSHConnection(nil), items...)
}
func copyFileSources(items []FileSource) []FileSource {
	return append([]FileSource(nil), items...)
}

func (s *FileService) GetSSHConnections() []SSHConnection {
	return copySSHConnections(s.configSnapshot().SSHConnections)
}

func (s *FileService) GetFileSources() []FileSource {
	return copyFileSources(s.configSnapshot().FileSources)
}

func validateSSHFileConfig(connections []SSHConnection, sources []FileSource) error {
	seenConnections := make(map[string]bool, len(connections))
	for i := range connections {
		c := &connections[i]
		c.ID, c.Name, c.Mode, c.Alias, c.Host, c.Username, c.PrivateKeyPath = strings.TrimSpace(c.ID), strings.TrimSpace(c.Name), strings.TrimSpace(c.Mode), strings.TrimSpace(c.Alias), strings.TrimSpace(c.Host), strings.TrimSpace(c.Username), strings.TrimSpace(c.PrivateKeyPath)
		if !validConfigValue(c.ID, 128) || seenConnections[c.ID] {
			return fmt.Errorf("SSH 连接 ID 无效或重复: %q", c.ID)
		}
		seenConnections[c.ID] = true
		if c.Mode == "" {
			c.Mode = "manual"
		}
		if c.Mode != "manual" && c.Mode != "local" {
			return fmt.Errorf("SSH 连接 %q 的模式无效", c.ID)
		}
		if c.Mode == "local" {
			if !validSSHHost(c.Alias) {
				return fmt.Errorf("SSH 连接 %q 的本地配置别名无效", c.ID)
			}
			c.Host = c.Alias
		}
		if c.Name == "" {
			c.Name = c.Alias
			if c.Name == "" {
				c.Name = c.Host
			}
		}
		if !validTextValue(c.Name, 256) || (c.Mode == "manual" && !validSSHHost(c.Host)) {
			return fmt.Errorf("SSH 连接 %q 配置无效", c.ID)
		}
		if c.Port == 0 {
			c.Port = 22
		}
		if c.Port < 1 || c.Port > 65535 || (c.Mode == "manual" && (c.Username == "" || !validConfigValue(c.Username, 256))) {
			return fmt.Errorf("SSH 连接 %q 的端口或用户名无效", c.ID)
		}
		if !validSecretValue(c.Password, 4096) || !validSecretValue(c.PrivateKey, 128<<10) || !validSecretValue(c.KeyPassphrase, 4096) {
			return fmt.Errorf("SSH 连接 %q 的认证信息无效", c.ID)
		}
		if c.Mode == "manual" && c.Password == "" && c.PrivateKey == "" && c.PrivateKeyPath == "" {
			return fmt.Errorf("SSH 连接 %q 未配置密码或私钥", c.ID)
		}
		if c.PrivateKeyPath != "" && (!validPathValue(c.PrivateKeyPath, 4096) || strings.HasPrefix(c.PrivateKeyPath, "-")) {
			return fmt.Errorf("SSH 连接 %q 的私钥路径无效", c.ID)
		}
		if c.Mode == "manual" && c.KeyPassphrase != "" && c.PrivateKey == "" && c.PrivateKeyPath == "" {
			return fmt.Errorf("SSH 连接 %q 的密钥口令未关联私钥", c.ID)
		}
	}
	seenSources := make(map[string]bool, len(sources))
	for i := range sources {
		src := &sources[i]
		src.ID, src.Name, src.SSHConnectionID, src.DefaultPath = strings.TrimSpace(src.ID), strings.TrimSpace(src.Name), strings.TrimSpace(src.SSHConnectionID), strings.TrimSpace(src.DefaultPath)
		if !validConfigValue(src.ID, 128) || seenSources[src.ID] || !validConfigValue(src.SSHConnectionID, 128) || !seenConnections[src.SSHConnectionID] {
			return fmt.Errorf("文件源 %q 配置无效", src.ID)
		}
		seenSources[src.ID] = true
		if src.Name == "" || !validTextValue(src.Name, 256) || (src.DefaultPath != "" && !validPathValue(src.DefaultPath, 4096)) {
			return fmt.Errorf("文件源 %q 配置无效", src.ID)
		}
	}
	return nil
}

func (s *FileService) SaveSSHFileConfig(connections []SSHConnection, sources []FileSource) error {
	connections = copySSHConnections(connections)
	sources = copyFileSources(sources)
	if err := validateSSHFileConfig(connections, sources); err != nil {
		return err
	}
	if s.config == nil {
		return errors.New("配置服务尚未初始化")
	}
	cfg := s.config.Get()
	cfg.SSHConnections, cfg.FileSources = connections, sources
	return s.config.Save(cfg)
}

func (s *FileService) sourceSnapshot(sourceID string) (FileSource, SSHConnection, error) {
	cfg := s.configSnapshot()
	var src FileSource
	for _, candidate := range cfg.FileSources {
		if candidate.ID == sourceID {
			src = candidate
			break
		}
	}
	if src.ID == "" {
		return FileSource{}, SSHConnection{}, errors.New("文件源不存在")
	}
	for _, conn := range cfg.SSHConnections {
		if conn.ID == src.SSHConnectionID {
			return src, conn, nil
		}
	}
	return FileSource{}, SSHConnection{}, errors.New("文件源引用的 SSH 连接不存在")
}

func normalizedRemotePath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "/"
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return path.Clean(value)
}

func remoteChild(parent, name string) string {
	if parent == "/" {
		return "/" + name
	}
	return path.Join(parent, name)
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
		return nil, errors.New("读取 SSH 私钥文件失败")
	}
	if keyData != "" {
		var signer ssh.Signer
		if conn.KeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyData), []byte(conn.KeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyData))
		}
		if err != nil {
			return nil, errors.New("解析 SSH 私钥失败")
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if len(methods) == 0 {
		return nil, errors.New("SSH 未配置认证凭据")
	}
	return methods, nil
}

func closeSSHClient(client *ssh.Client) {
	if client != nil {
		_ = client.Close()
	}
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

const remoteArchiveProgressPollInterval = 500 * time.Millisecond

const remoteTarArchiveProbeAwk = `awk '
$1 ~ /^-/ {
	if ($2 ~ /^[0-9]+\/[0-9]+$/ && $3 ~ /^[0-9]+$/) {
		total += $3
		files++
	} else if ($2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/) {
		total += $5
		files++
	}
}
END {
	if (files == 0) {
		exit 42
	}
	printf "%d\t%d\n", total, files
}'`

const remoteZipArchiveProbeAwk = `awk '
$1 ~ /^[0-9]+$/ &&
(
	$2 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ ||
	$2 ~ /^[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]$/
) &&
$NF !~ /\/$/ {
	total += $1
	files++
}
END {
	if (files == 0) {
		exit 42
	}
	printf "%d\t%d\n", total, files
}'`

func remoteArchiveProbeCommand(format, remotePath string) string {
	quotedPath := shellQuote(remotePath)
	switch format {
	case "tar":
		return "command -v tar >/dev/null 2>&1 || exit 127; " +
			"LC_ALL=C tar --numeric-owner -tvf " + quotedPath +
			" 2>/dev/null | " + remoteTarArchiveProbeAwk
	case "tar.gz":
		return "command -v tar >/dev/null 2>&1 || exit 127; " +
			"LC_ALL=C tar --numeric-owner -tvzf " + quotedPath +
			" 2>/dev/null | " + remoteTarArchiveProbeAwk
	case "zip":
		return "command -v unzip >/dev/null 2>&1 || exit 127; " +
			"LC_ALL=C unzip -l " + quotedPath +
			" 2>/dev/null | " + remoteZipArchiveProbeAwk
	default:
		return ""
	}
}

func remoteArchiveExtractCommand(format, remotePath, target string) string {
	quotedPath, quotedTarget := shellQuote(remotePath), shellQuote(target)
	switch format {
	case "tar":
		return "tar -xf " + quotedPath + " -C " + quotedTarget
	case "tar.gz":
		return "tar -xzf " + quotedPath + " -C " + quotedTarget
	case "zip":
		return "unzip -oq " + quotedPath + " -d " + quotedTarget
	default:
		return ""
	}
}

func parseRemoteArchiveStats(output []byte) (remoteArchiveStats, error) {
	fields := strings.Fields(string(output))
	if len(fields) != 2 {
		return remoteArchiveStats{}, errors.New("远程归档统计结果无效")
	}
	total, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || total < 0 {
		return remoteArchiveStats{}, errors.New("远程归档总大小无效")
	}
	files, err := strconv.Atoi(fields[1])
	if err != nil || files < 0 {
		return remoteArchiveStats{}, errors.New("远程归档文件数无效")
	}
	return remoteArchiveStats{total: total, files: files}, nil
}

func probeRemoteArchive(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	format, remotePath string,
) (remoteArchiveStats, bool, error) {
	// 远端工具或列表格式不可用时交给直接解压流程，不阻断用户操作。
	command := remoteArchiveProbeCommand(format, remotePath)
	if command == "" {
		return remoteArchiveStats{}, false, nil
	}
	output, err := runRemoteCommandOutput(ctx, conn, sshClient, command)
	if err != nil {
		if ctx.Err() != nil {
			return remoteArchiveStats{}, false, ctx.Err()
		}
		return remoteArchiveStats{}, false, nil
	}
	stats, err := parseRemoteArchiveStats(output)
	if err != nil {
		return remoteArchiveStats{}, false, nil
	}
	return stats, true, nil
}

func remoteCommandError(stderr string, err error) error {
	if err == nil {
		return nil
	}
	if detail := strings.TrimSpace(stderr); detail != "" {
		return fmt.Errorf("%s: %w", detail, err)
	}
	return err
}

func runRemoteCommandOutput(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	command string,
) ([]byte, error) {
	if conn.Mode == "local" {
		alias := strings.TrimSpace(conn.Alias)
		if !validSSHHost(alias) {
			return nil, errors.New("本地 SSH 配置别名无效")
		}
		process := newSystemSSHCommand(ctx, alias, command)
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		process.Stdout = &stdout
		process.Stderr = &stderr
		err := process.Run()
		if err != nil && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return stdout.Bytes(), remoteCommandError(stderr.String(), err)
	}
	if sshClient == nil {
		return nil, errors.New("SSH 会话尚未建立")
	}
	session, err := sshClient.NewSession()
	if err != nil {
		return nil, err
	}
	defer session.Close()
	var stdout bytes.Buffer
	session.Stdout = &stdout
	var stderr bytes.Buffer
	session.Stderr = &stderr
	done := make(chan error, 1)
	go func() {
		done <- session.Run(command)
	}()
	select {
	case err := <-done:
		return stdout.Bytes(), remoteCommandError(stderr.String(), err)
	case <-ctx.Done():
		_ = session.Close()
		return nil, ctx.Err()
	}
}

func runRemoteCommand(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	command string,
) error {
	_, err := runRemoteCommandOutput(ctx, conn, sshClient, command)
	return err
}

func (s *FileService) dialSFTP(ctx context.Context, conn SSHConnection) (*ssh.Client, *sftp.Client, error) {
	if conn.Mode == "local" {
		alias := strings.TrimSpace(conn.Alias)
		if !validSSHHost(alias) {
			return nil, nil, errors.New("本地 SSH 配置别名无效")
		}
		command := newSystemSFTPCommand(ctx, alias)
		stdout, err := command.StdoutPipe()
		if err != nil {
			return nil, nil, errors.New("启动系统 SSH 失败")
		}
		stdin, err := command.StdinPipe()
		if err != nil {
			return nil, nil, errors.New("启动系统 SSH 失败")
		}
		var stderr bytes.Buffer
		command.Stderr = &stderr
		if err := command.Start(); err != nil {
			return nil, nil, fmt.Errorf("启动系统 SSH 失败: %w", err)
		}
		client, err := sftp.NewClientPipe(stdout, stdin)
		if err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			if detail := strings.TrimSpace(stderr.String()); detail != "" {
				return nil, nil, fmt.Errorf("系统 SSH SFTP 失败: %s", detail)
			}
			return nil, nil, fmt.Errorf("创建 SFTP 会话失败: %w", err)
		}
		go func() { _ = command.Wait() }()
		return nil, client, nil
	}
	auth, err := s.authMethods(conn)
	if err != nil {
		return nil, nil, err
	}
	hostKeyCallback, err := newAppSSHHostKeyCallback(s.configSnapshot().Language)
	if err != nil {
		return nil, nil, fmt.Errorf("读取应用 SSH known_hosts 失败: %w", err)
	}
	host := strings.TrimPrefix(strings.TrimSuffix(conn.Host, "]"), "[")
	port := conn.Port
	if port == 0 {
		port = 22
	}
	address := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	sshConfig := &ssh.ClientConfig{User: conn.Username, Auth: auth, HostKeyCallback: hostKeyCallback, Timeout: 15 * time.Second}
	client, err := dialSSHClient(ctx, address, sshConfig)
	if err != nil {
		var dialErr *sshDialError
		if errors.As(err, &dialErr) || ctx.Err() != nil {
			return nil, nil, err
		}
		var hostKeyErr *sshHostKeyError
		if errors.As(err, &hostKeyErr) {
			return nil, nil, hostKeyErr
		}
		return nil, nil, errors.New("SSH 认证失败")
	}
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		_ = client.Close()
		return nil, nil, fmt.Errorf("创建 SFTP 会话失败: %w", err)
	}
	return client, sftpClient, nil
}

func (s *FileService) ListRemoteFiles(sourceID, currentPath string, showHidden bool) ([]RemoteFileEntry, error) {
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		return nil, err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	remotePath := normalizedRemotePath(currentPath)
	entries, err := client.ReadDirContext(ctx, remotePath)
	if err != nil {
		return nil, fmt.Errorf("读取远程目录失败: %w", err)
	}
	result := make([]RemoteFileEntry, 0, len(entries))
	for _, entry := range entries {
		if !showHidden && strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		mode := entry.Mode()
		result = append(result, RemoteFileEntry{Name: entry.Name(), Path: remoteChild(remotePath, entry.Name()), IsDir: mode.IsDir(), IsSymlink: mode&os.ModeSymlink != 0, Size: func() int64 {
			if mode.IsRegular() {
				return entry.Size()
			}
			return 0
		}(), ModifiedAt: entry.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (s *FileService) TestSSHFileConnection(connection SSHConnection, defaultPath string) error {
	if connection.Port == 0 {
		connection.Port = 22
	}
	if connection.Mode != "local" && connection.Username == "" {
		return errors.New("SSH 用户名为空")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sshClient, client, err := s.dialSFTP(ctx, connection)
	if err != nil {
		return err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	_, err = client.Stat(normalizedRemotePath(defaultPath))
	if err != nil {
		return fmt.Errorf("默认路径不可访问: %w", err)
	}
	return nil
}

// CreateRemoteDirectory 在远程文件源的指定路径创建文件夹。
func (s *FileService) CreateRemoteDirectory(sourceID, remotePath string) error {
	remotePath = normalizedRemotePath(remotePath)
	if remotePath == "/" {
		return errors.New("文件夹路径无效")
	}
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		return err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()

	info, err := client.Lstat(remotePath)
	if err == nil {
		if info.IsDir() {
			return errors.New("文件夹已存在")
		}
		return errors.New("目标路径已存在且不是文件夹")
	}
	if !isRemoteNotFound(err) {
		return err
	}
	if err := ensureRemoteDirectory(client, path.Dir(remotePath)); err != nil {
		return err
	}
	if err := client.Mkdir(remotePath); err != nil {
		return fmt.Errorf("创建远程文件夹失败: %w", err)
	}
	return nil
}

func normalizeRemotePaths(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		normalized := normalizedRemotePath(value)
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func isRemoteNotFound(err error) bool {
	if err == nil {
		return false
	}
	if os.IsNotExist(err) || errors.Is(err, os.ErrNotExist) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "no such file")
}

func remotePathExists(client *sftp.Client, remotePath string) (bool, error) {
	_, err := client.Lstat(remotePath)
	if err == nil {
		return true, nil
	}
	if isRemoteNotFound(err) {
		return false, nil
	}
	return false, err
}

func ensureRemotePathAbsent(client *sftp.Client, remotePath string) error {
	exists, err := remotePathExists(client, remotePath)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("目标已存在: %s", remotePath)
	}
	return nil
}

func ensureRemoteDirectory(client *sftp.Client, remotePath string) error {
	remotePath = normalizedRemotePath(remotePath)
	info, err := client.Lstat(remotePath)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("目标不是目录: %s", remotePath)
		}
		return nil
	}
	if !isRemoteNotFound(err) {
		return err
	}
	if err := client.MkdirAll(remotePath); err != nil {
		return fmt.Errorf("创建远程目录失败: %w", err)
	}
	return nil
}

func remotePathContains(parent, child string) bool {
	parent, child = normalizedRemotePath(parent), normalizedRemotePath(child)
	if parent == "/" {
		return child != "/"
	}
	return child == parent || strings.HasPrefix(child, parent+"/")
}

type remoteTransferItem struct {
	source      string
	destination string
	info        os.FileInfo
	exists      bool
	noOp        bool
}

func validateRemoteCopyPath(client *sftp.Client, remotePath string) error {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("不支持复制符号链接: %s", remotePath)
	}
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("不支持复制该类型的远程项目: %s", remotePath)
		}
		return nil
	}
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := validateRemoteCopyPath(client, remoteChild(remotePath, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func prepareRemoteTransfers(
	client *sftp.Client,
	operation string,
	remotePaths []string,
	target string,
) ([]remoteTransferItem, error) {
	items := make([]remoteTransferItem, 0, len(remotePaths))
	for _, remotePath := range remotePaths {
		if remotePath == "/" {
			return nil, errors.New("不能复制或移动远程根目录")
		}
		info, err := client.Lstat(remotePath)
		if err != nil {
			return nil, fmt.Errorf("读取远程项目失败: %w", err)
		}
		if operation == remoteFileOperationCopy {
			if err := validateRemoteCopyPath(client, remotePath); err != nil {
				return nil, err
			}
		}
		if info.IsDir() && remotePathContains(remotePath, target) {
			return nil, fmt.Errorf("不能将目录复制到自身或子目录: %s", remotePath)
		}
		items = append(items, remoteTransferItem{source: remotePath, info: info})
	}
	if err := ensureRemoteDirectory(client, target); err != nil {
		return nil, err
	}
	for index := range items {
		item := &items[index]
		item.destination = remoteChild(target, path.Base(item.source))
		if operation == remoteFileOperationMove && item.destination == item.source {
			item.noOp = true
			continue
		}
		exists, err := remotePathExists(client, item.destination)
		if err != nil {
			return nil, err
		}
		item.exists = exists
	}
	return items, nil
}

func remoteTransferConflicts(items []remoteTransferItem) []string {
	conflicts := make([]string, 0)
	for _, item := range items {
		if item.exists && !item.noOp {
			conflicts = append(conflicts, item.destination)
		}
	}
	return conflicts
}

func remoteCopyName(name string, isDir bool, timestamp int64, attempt int) string {
	suffix := fmt.Sprintf("_副本_%d", timestamp)
	if attempt > 0 {
		suffix += fmt.Sprintf("_%d", attempt)
	}
	if isDir {
		return name + suffix
	}
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".tar.gz") {
		index := len(name) - len(".tar.gz")
		return name[:index] + suffix + name[index:]
	}
	extension := path.Ext(name)
	if extension == "" || extension == "." ||
		(strings.HasPrefix(name, ".") && !strings.Contains(name[1:], ".")) {
		return name + suffix
	}
	return strings.TrimSuffix(name, extension) + suffix + extension
}

func resolveRemoteTransferDestination(
	client *sftp.Client,
	target string,
	item remoteTransferItem,
	conflictPolicy string,
	timestamp int64,
	reserved map[string]struct{},
) (string, error) {
	if item.noOp || !item.exists {
		if _, ok := reserved[item.destination]; ok {
			return "", errors.New("目标目录中存在重复项目名称")
		}
		return item.destination, nil
	}
	if conflictPolicy == remoteFileConflictOverwrite {
		return item.destination, nil
	}
	if conflictPolicy != remoteFileConflictKeepBoth {
		return "", errors.New("未确认远程文件冲突处理方式")
	}
	for attempt := 0; ; attempt++ {
		candidate := remoteChild(
			target,
			remoteCopyName(path.Base(item.source), item.info.IsDir(), timestamp, attempt),
		)
		if _, ok := reserved[candidate]; ok {
			continue
		}
		exists, err := remotePathExists(client, candidate)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
}

// OperateRemoteFiles 在远程文件源上执行文件管理操作。
// copy、move 和 extract 的 target 是目录；rename 的 target 是完整的新路径；
// compress 的 target 是压缩文件完整路径；delete 忽略 target。
// copy 和 move 的冲突策略为 ask、overwrite 或 keep-both。
func (s *FileService) OperateRemoteFiles(
	sourceID, operation string,
	remotePaths []string,
	target, conflictPolicy string,
) (RemoteFileOperationResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	return s.operateRemoteFiles(ctx, sourceID, operation, remotePaths, target, conflictPolicy, nil)
}

func (s *FileService) operateRemoteFiles(
	ctx context.Context,
	sourceID, operation string,
	remotePaths []string,
	target, conflictPolicy string,
	onProgress func(remoteFileOperationProgress),
) (RemoteFileOperationResult, error) {
	var result RemoteFileOperationResult
	operation = strings.TrimSpace(operation)
	switch operation {
	case remoteFileOperationCopy, remoteFileOperationMove, remoteFileOperationRename,
		remoteFileOperationDelete, remoteFileOperationExtract, remoteFileOperationCompress:
	default:
		return result, fmt.Errorf("不支持的文件操作: %s", operation)
	}
	paths := normalizeRemotePaths(remotePaths)
	if len(paths) == 0 {
		return result, errors.New("未选择远程项目")
	}
	if operation == remoteFileOperationRename && len(paths) != 1 {
		return result, errors.New("重命名一次只能处理一个项目")
	}
	if operation == remoteFileOperationCopy || operation == remoteFileOperationMove {
		switch strings.TrimSpace(conflictPolicy) {
		case "":
			conflictPolicy = remoteFileConflictAsk
		case remoteFileConflictAsk, remoteFileConflictOverwrite, remoteFileConflictKeepBoth:
		default:
			return result, fmt.Errorf("不支持的冲突处理方式: %s", conflictPolicy)
		}
	} else {
		conflictPolicy = ""
	}
	if operation == remoteFileOperationDelete {
		for _, remotePath := range paths {
			if remotePath == "/" {
				return result, errors.New("不能删除远程根目录")
			}
		}
	}
	if operation == remoteFileOperationCompress {
		target = normalizedRemotePath(target)
		if target == "/" {
			return result, errors.New("压缩文件路径无效")
		}
		if remoteArchiveFormatForPath(target) == "" {
			return result, errors.New("压缩文件必须使用 .zip、.tar、.tar.gz 或 .tgz 扩展名")
		}
	}
	if operation == remoteFileOperationRename {
		target = normalizedRemotePath(target)
		if target == "/" {
			return result, errors.New("重命名目标无效")
		}
	}
	if operation == remoteFileOperationCopy || operation == remoteFileOperationMove ||
		operation == remoteFileOperationExtract {
		target = normalizedRemotePath(target)
	}

	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return result, err
	}
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		return result, err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()

	switch operation {
	case remoteFileOperationCopy, remoteFileOperationMove:
		items, err := prepareRemoteTransfers(client, operation, paths, target)
		if err != nil {
			return result, err
		}
		conflicts := remoteTransferConflicts(items)
		if conflictPolicy == remoteFileConflictAsk && len(conflicts) > 0 {
			result.Conflicts = conflicts
			return result, nil
		}
		timestamp := time.Now().Unix()
		reserved := make(map[string]struct{}, len(items))
		doneFiles := 0
		for _, item := range items {
			if item.noOp {
				doneFiles++
				if onProgress != nil {
					onProgress(remoteFileOperationProgress{
						doneFiles: doneFiles,
						current:   item.source,
					})
				}
				continue
			}
			destination, err := resolveRemoteTransferDestination(
				client,
				target,
				item,
				conflictPolicy,
				timestamp,
				reserved,
			)
			if err != nil {
				return result, err
			}
			if _, ok := reserved[destination]; ok {
				return result, errors.New("目标目录中存在重复项目名称")
			}
			reserved[destination] = struct{}{}
			if item.exists && conflictPolicy == remoteFileConflictOverwrite {
				if operation == remoteFileOperationCopy && destination == item.source {
					return result, errors.New("复制目标与源相同，不能覆盖")
				}
				if err := client.RemoveAll(destination); err != nil {
					return result, fmt.Errorf("覆盖远程项目失败: %w", err)
				}
			}
			if err := runRemoteCommand(
				ctx,
				conn,
				sshClient,
				remoteTransferCommand(operation, item.source, destination),
			); err != nil {
				if operation == remoteFileOperationCopy {
					return result, fmt.Errorf("复制远程项目失败: %w", err)
				}
				return result, fmt.Errorf("移动远程项目失败: %w", err)
			}
			doneFiles++
			if onProgress != nil {
				onProgress(remoteFileOperationProgress{
					doneFiles: doneFiles,
					current:   destination,
				})
			}
		}
	case remoteFileOperationRename:
		remotePath := paths[0]
		if remotePath == "/" || remotePathContains(remotePath, target) {
			return result, errors.New("重命名目标无效")
		}
		if err := ensureRemotePathAbsent(client, target); err != nil {
			return result, err
		}
		if err := client.Rename(remotePath, target); err != nil {
			return result, fmt.Errorf("重命名远程项目失败: %w", err)
		}
	case remoteFileOperationDelete:
		for _, remotePath := range paths {
			if err := client.RemoveAll(remotePath); err != nil {
				return result, fmt.Errorf("删除远程项目失败: %w", err)
			}
		}
	case remoteFileOperationCompress:
		if err := ensureRemotePathAbsent(client, target); err != nil {
			return result, err
		}
		if err := ensureRemoteDirectory(client, path.Dir(target)); err != nil {
			return result, err
		}
		for _, remotePath := range paths {
			info, err := client.Lstat(remotePath)
			if err != nil {
				return result, fmt.Errorf("读取远程项目失败: %w", err)
			}
			if remotePath == target || (info.IsDir() && remotePathContains(remotePath, target)) {
				return result, fmt.Errorf("压缩目标不能位于待压缩目录中: %s", target)
			}
		}
		stats, err := collectRemoteArchiveStats(ctx, client, paths)
		if err != nil {
			return result, fmt.Errorf("统计待压缩项目失败: %w", err)
		}
		if onProgress != nil {
			onProgress(remoteFileOperationProgress{
				total:      stats.total,
				totalKnown: true,
				files:      stats.files,
				current:    target,
			})
		}
		if err := createRemoteArchive(
			ctx,
			client,
			paths,
			target,
			stats.total,
			stats.files,
			onProgress,
		); err != nil {
			return result, fmt.Errorf("压缩远程项目失败: %w", err)
		}
	case remoteFileOperationExtract:
		if err := ensureRemoteDirectory(client, target); err != nil {
			return result, err
		}
		var completed, total int64
		files, doneFiles := 0, 0
		totalKnown := true
		for _, remotePath := range paths {
			baseCompleted, baseTotal := completed, total
			baseFiles, baseDoneFiles := files, doneFiles
			baseTotalKnown := totalKnown
			summary, err := s.extractRemoteArchive(
				ctx,
				conn,
				sshClient,
				client,
				remotePath,
				target,
				func(progress remoteFileOperationProgress) {
					if onProgress == nil {
						return
					}
					progressTotalKnown := baseTotalKnown && progress.totalKnown
					onProgress(remoteFileOperationProgress{
						completed:  baseCompleted + progress.completed,
						total:      baseTotal + progress.total,
						totalKnown: progressTotalKnown,
						files:      baseFiles + progress.files,
						doneFiles:  baseDoneFiles + progress.doneFiles,
						current:    progress.current,
					})
				},
			)
			if err != nil {
				return result, fmt.Errorf("解压远程项目失败: %w", err)
			}
			completed += summary.completed
			doneFiles += summary.files
			if totalKnown && summary.totalKnown {
				total += summary.total
				files += summary.files
			} else {
				totalKnown, total, files = false, 0, 0
			}
		}
	}
	return result, nil
}

func isBackgroundRemoteFileOperation(operation string) bool {
	switch operation {
	case remoteFileOperationCopy, remoteFileOperationMove,
		remoteFileOperationExtract, remoteFileOperationCompress:
		return true
	default:
		return false
	}
}

// StartRemoteFileOperation 将复制、移动、压缩或解压提交到后台任务。
func (s *FileService) StartRemoteFileOperation(
	sourceID, operation string,
	remotePaths []string,
	target, conflictPolicy string,
) (FileTaskSnapshot, error) {
	operation = strings.TrimSpace(operation)
	if !isBackgroundRemoteFileOperation(operation) {
		return FileTaskSnapshot{}, fmt.Errorf("不支持后台执行的文件操作: %s", operation)
	}
	paths := normalizeRemotePaths(remotePaths)
	if len(paths) == 0 {
		return FileTaskSnapshot{}, errors.New("未选择远程项目")
	}
	if operation == remoteFileOperationCopy || operation == remoteFileOperationMove {
		switch strings.TrimSpace(conflictPolicy) {
		case "":
			conflictPolicy = remoteFileConflictAsk
		case remoteFileConflictAsk, remoteFileConflictOverwrite, remoteFileConflictKeepBoth:
		default:
			return FileTaskSnapshot{}, fmt.Errorf("不支持的冲突处理方式: %s", conflictPolicy)
		}
	} else {
		conflictPolicy = ""
	}
	target = normalizedRemotePath(target)
	if _, _, err := s.sourceSnapshot(sourceID); err != nil {
		return FileTaskSnapshot{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	id := s.createFileTask(
		FileTask{
			Type:     operation,
			SourceID: sourceID,
			Current:  target,
			Target:   target,
			Paths:    paths,
			Files:    len(paths),
		},
		ctx,
		cancel,
	)
	s.taskMu.Lock()
	if task := s.tasks[id]; task != nil {
		task.operationPolicy = conflictPolicy
	}
	s.taskMu.Unlock()
	go s.runRemoteFileOperationTask(ctx, id)
	return s.GetFileTasks(), nil
}

// ResolveRemoteFileTask 为等待冲突处理的后台复制或移动任务选择处理方式。
func (s *FileService) ResolveRemoteFileTask(id, conflictPolicy string) (FileTaskSnapshot, error) {
	switch strings.TrimSpace(conflictPolicy) {
	case remoteFileConflictOverwrite, remoteFileConflictKeepBoth:
	default:
		return FileTaskSnapshot{}, errors.New("未确认远程文件冲突处理方式")
	}

	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, errors.New("文件任务不存在")
	}
	if (task.Type != remoteFileOperationCopy && task.Type != remoteFileOperationMove) ||
		task.Status != fileTaskConflict {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, errors.New("文件任务不在等待冲突处理")
	}
	if task.ctx == nil || task.cancel == nil || task.ctx.Err() != nil {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, errors.New("文件任务已结束")
	}
	task.operationPolicy = conflictPolicy
	task.Status, task.Stage = fileTaskQueued, fileTaskQueued
	task.Current = task.Target
	task.Conflicts = nil
	task.Error = ""
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.taskRevision++
	snapshot := s.taskSnapshotLocked()
	ctx := task.ctx
	s.taskMu.Unlock()
	s.emitTasks(snapshot)
	go s.runRemoteFileOperationTask(ctx, id)
	return snapshot, nil
}

func (s *FileService) remoteFileTaskInput(
	id string,
) (sourceID, operation string, paths []string, target, conflictPolicy string, ok bool) {
	s.taskMu.Lock()
	defer s.taskMu.Unlock()
	task := s.tasks[id]
	if task == nil {
		return "", "", nil, "", "", false
	}
	return task.SourceID, task.Type, append([]string(nil), task.Paths...),
		task.Target, task.operationPolicy, true
}

func (s *FileService) runRemoteFileOperationTask(ctx context.Context, taskID string) {
	sourceID, operation, paths, target, conflictPolicy, ok := s.remoteFileTaskInput(taskID)
	if !ok {
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Current = fileTaskScanning, "preparing", target
	})
	onProgress := func(progress remoteFileOperationProgress) {
		s.updateFileTask(taskID, func(task *fileTaskState) {
			task.Status, task.Stage = fileTaskRunning, "working"
			if progress.totalKnown {
				task.Completed, task.Total = progress.completed, progress.total
			} else if progress.completed > 0 {
				task.Completed, task.Total, task.Files = progress.completed, 0, 0
			}
			if progress.totalKnown && progress.files > 0 {
				task.Files = progress.files
			}
			task.DoneFiles, task.Current = progress.doneFiles, progress.current
		})
	}
	result, err := s.operateRemoteFiles(
		ctx,
		sourceID,
		operation,
		paths,
		target,
		conflictPolicy,
		onProgress,
	)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	if err := ctx.Err(); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	if len(result.Conflicts) > 0 {
		s.updateFileTask(taskID, func(task *fileTaskState) {
			task.Status, task.Stage = fileTaskConflict, fileTaskConflict
			task.Current = target
			task.Conflicts = append([]string(nil), result.Conflicts...)
		})
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage = fileTaskSuccess, "done"
		if task.Total > 0 {
			task.Completed = task.Total
		}
		if task.Files > 0 {
			task.DoneFiles = task.Files
		} else {
			task.DoneFiles = len(paths)
		}
		task.Current = ""
		task.Conflicts = nil
		if task.cancel != nil {
			task.cancel()
		}
		task.ctx = nil
		task.cancel = nil
	})
}

func localTree(ctx context.Context, paths []string) (int64, int, error) {
	var total int64
	files := 0
	for _, root := range paths {
		if err := ctx.Err(); err != nil {
			return 0, 0, err
		}
		if _, err := os.Lstat(root); err != nil {
			return 0, 0, err
		}
		err := filepath.Walk(root, func(p string, item os.FileInfo, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if walkErr != nil {
				return walkErr
			}
			if item.Mode()&os.ModeSymlink != 0 {
				if item.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if item.Mode().IsRegular() {
				total += item.Size()
				files++
			}
			return nil
		})
		if err != nil {
			return 0, 0, fmt.Errorf("扫描本地路径 %q 失败: %w", root, err)
		}
	}
	return total, files, nil
}

func addProgressBytes(values ...int64) (int64, error) {
	const maxInt64 = int64(^uint64(0) >> 1)
	var total int64
	for _, value := range values {
		if value < 0 || total > maxInt64-value {
			return 0, errors.New("文件大小超出可统计范围")
		}
		total += value
	}
	return total, nil
}

type remoteArchiveStats struct {
	total int64
	files int
}

func collectRemoteArchivePath(
	ctx context.Context,
	client *sftp.Client,
	remotePath string,
	stats *remoteArchiveStats,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("不支持压缩符号链接: %s", remotePath)
	}
	if !info.IsDir() {
		if info.Size() < 0 {
			return fmt.Errorf("远程文件大小无效: %s", remotePath)
		}
		total, err := addProgressBytes(stats.total, info.Size())
		if err != nil {
			return err
		}
		stats.total = total
		stats.files++
		return nil
	}
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := collectRemoteArchivePath(
			ctx,
			client,
			remoteChild(remotePath, entry.Name()),
			stats,
		); err != nil {
			return err
		}
	}
	return nil
}

func collectRemoteArchiveStats(
	ctx context.Context,
	client *sftp.Client,
	remotePaths []string,
) (remoteArchiveStats, error) {
	var stats remoteArchiveStats
	for _, remotePath := range remotePaths {
		if err := collectRemoteArchivePath(ctx, client, remotePath, &stats); err != nil {
			return remoteArchiveStats{}, err
		}
	}
	return stats, nil
}

func collectRemoteDirectoryProgress(
	ctx context.Context,
	client *sftp.Client,
	remotePath string,
) (remoteArchiveStats, error) {
	if err := ctx.Err(); err != nil {
		return remoteArchiveStats{}, err
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return remoteArchiveStats{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return remoteArchiveStats{}, nil
	}
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return remoteArchiveStats{}, nil
		}
		if info.Size() < 0 {
			return remoteArchiveStats{}, fmt.Errorf("远程文件大小无效: %s", remotePath)
		}
		return remoteArchiveStats{total: info.Size(), files: 1}, nil
	}
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		return remoteArchiveStats{}, err
	}
	var stats remoteArchiveStats
	for _, entry := range entries {
		childStats, err := collectRemoteDirectoryProgress(
			ctx,
			client,
			remoteChild(remotePath, entry.Name()),
		)
		if err != nil {
			return remoteArchiveStats{}, err
		}
		total, err := addProgressBytes(stats.total, childStats.total)
		if err != nil {
			return remoteArchiveStats{}, err
		}
		stats.total = total
		stats.files += childStats.files
	}
	return stats, nil
}

type remoteArchiveExtractionResult struct {
	completed  int64
	total      int64
	files      int
	totalKnown bool
}

func runRemoteArchiveExtraction(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	client *sftp.Client,
	format, remotePath, target string,
	stats remoteArchiveStats,
	totalKnown bool,
	onProgress func(remoteFileOperationProgress),
) (int64, error) {
	// 归档始终在远端解压，本地只通过 SFTP 读取目标目录的元数据。
	command := remoteArchiveExtractCommand(format, remotePath, target)
	if command == "" {
		return 0, errors.New("压缩文件格式不受支持")
	}
	done := make(chan error, 1)
	go func() {
		done <- runRemoteCommand(ctx, conn, sshClient, command)
	}()
	ticker := time.NewTicker(remoteArchiveProgressPollInterval)
	defer ticker.Stop()
	var lastCompleted int64
	report := func() {
		current, err := collectRemoteDirectoryProgress(ctx, client, target)
		if err != nil {
			return
		}
		completed := current.total
		if completed < lastCompleted {
			completed = lastCompleted
		}
		if totalKnown && completed > stats.total {
			completed = stats.total
		}
		lastCompleted = completed
		if onProgress == nil {
			return
		}
		progress := remoteFileOperationProgress{
			completed:  completed,
			total:      stats.total,
			totalKnown: totalKnown,
			files:      stats.files,
			doneFiles:  current.files,
			current:    target,
		}
		if !totalKnown {
			progress.total, progress.files = 0, 0
		} else if progress.doneFiles > stats.files {
			progress.doneFiles = stats.files
		}
		onProgress(progress)
	}
	report()
	for {
		select {
		case err := <-done:
			report()
			if err == nil && totalKnown {
				lastCompleted = stats.total
				if onProgress != nil {
					onProgress(remoteFileOperationProgress{
						completed:  stats.total,
						total:      stats.total,
						totalKnown: true,
						files:      stats.files,
						doneFiles:  stats.files,
						current:    target,
					})
				}
			}
			return lastCompleted, err
		case <-ticker.C:
			report()
		case <-ctx.Done():
			return lastCompleted, ctx.Err()
		}
	}
}

func copyWithProgress(
	ctx context.Context,
	dst io.Writer,
	src io.Reader,
	onBytes func(int64),
) error {
	buf := make([]byte, 256*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			written, writeErr := dst.Write(buf[:n])
			if writeErr != nil {
				return writeErr
			}
			if written != n {
				return io.ErrShortWrite
			}
			if onBytes != nil {
				onBytes(int64(written))
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func remoteArchiveFormatForPath(remotePath string) string {
	lower := strings.ToLower(remotePath)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return "zip"
	case strings.HasSuffix(lower, ".tar"):
		return "tar"
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return "tar.gz"
	default:
		return ""
	}
}

func archiveEntryName(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = path.Clean(value)
	if value == "." {
		return ""
	}
	return strings.TrimPrefix(value, "./")
}

func writeRemoteFileToArchive(
	ctx context.Context,
	client *sftp.Client,
	remotePath string,
	dst io.Writer,
	onBytes func(int64, string),
	onFileComplete func(string),
) error {
	input, err := client.Open(remotePath)
	if err != nil {
		return err
	}
	copyErr := copyWithProgress(ctx, dst, input, func(delta int64) {
		if onBytes != nil {
			onBytes(delta, remotePath)
		}
	})
	closeErr := input.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if onFileComplete != nil {
		onFileComplete(remotePath)
	}
	return nil
}

func addRemoteToTar(
	ctx context.Context,
	client *sftp.Client,
	remotePath, relativePath string,
	writer *tar.Writer,
	onBytes func(int64, string),
	onFileComplete func(string),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("不支持压缩符号链接: %s", remotePath)
	}
	name := archiveEntryName(relativePath)
	if name == "" {
		return errors.New("压缩项目名称无效")
	}
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = name
	if info.IsDir() && !strings.HasSuffix(header.Name, "/") {
		header.Name += "/"
	}
	if err := writer.WriteHeader(header); err != nil {
		return err
	}
	if !info.IsDir() {
		return writeRemoteFileToArchive(ctx, client, remotePath, writer, onBytes, onFileComplete)
	}
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := addRemoteToTar(
			ctx,
			client,
			remoteChild(remotePath, entry.Name()),
			path.Join(name, entry.Name()),
			writer,
			onBytes,
			onFileComplete,
		); err != nil {
			return err
		}
	}
	return nil
}

func addRemoteToZip(
	ctx context.Context,
	client *sftp.Client,
	remotePath, relativePath string,
	writer *zip.Writer,
	onBytes func(int64, string),
	onFileComplete func(string),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("不支持压缩符号链接: %s", remotePath)
	}
	name := archiveEntryName(relativePath)
	if name == "" {
		return errors.New("压缩项目名称无效")
	}
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = name
	if info.IsDir() && !strings.HasSuffix(header.Name, "/") {
		header.Name += "/"
	}
	header.SetMode(info.Mode())
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return writeRemoteFileToArchive(ctx, client, remotePath, entry, onBytes, onFileComplete)
	}
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		return err
	}
	for _, child := range entries {
		if err := addRemoteToZip(
			ctx,
			client,
			remoteChild(remotePath, child.Name()),
			path.Join(name, child.Name()),
			writer,
			onBytes,
			onFileComplete,
		); err != nil {
			return err
		}
	}
	return nil
}

func uploadLocalFileToRemote(
	ctx context.Context,
	client *sftp.Client,
	localPath, remotePath string,
	onBytes func(int64),
) error {
	input, err := os.Open(localPath)
	if err != nil {
		return err
	}
	output, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		_ = input.Close()
		return err
	}
	copyErr := copyWithProgress(ctx, output, input, onBytes)
	outputErr := output.Close()
	inputErr := input.Close()
	if copyErr != nil {
		return copyErr
	}
	if outputErr != nil {
		return outputErr
	}
	return inputErr
}

func createRemoteArchive(
	ctx context.Context,
	client *sftp.Client,
	remotePaths []string,
	target string,
	sourceTotal int64,
	sourceFiles int,
	onProgress func(remoteFileOperationProgress),
) error {
	format := remoteArchiveFormatForPath(target)
	if format == "" {
		return errors.New("压缩文件格式不受支持")
	}
	archiveFile, err := os.CreateTemp("", "devutils-ssh-compress-*")
	if err != nil {
		return err
	}
	localPath := archiveFile.Name()
	defer os.Remove(localPath)
	defer archiveFile.Close()

	sourceCompleted, doneFiles := int64(0), 0
	report := func(completed int64, current string) {
		if onProgress != nil {
			onProgress(remoteFileOperationProgress{
				completed:  completed,
				total:      sourceTotal,
				totalKnown: true,
				files:      sourceFiles,
				doneFiles:  doneFiles,
				current:    current,
			})
		}
	}
	onBytes := func(delta int64, current string) {
		sourceCompleted += delta
		report(sourceCompleted, current)
	}
	onFileComplete := func(current string) {
		doneFiles++
		report(sourceCompleted, current)
	}

	var archiveErr error
	switch format {
	case "zip":
		writer := zip.NewWriter(archiveFile)
		for _, remotePath := range remotePaths {
			if archiveErr != nil {
				break
			}
			archiveErr = addRemoteToZip(
				ctx,
				client,
				remotePath,
				path.Base(remotePath),
				writer,
				onBytes,
				onFileComplete,
			)
		}
		closeErr := writer.Close()
		if archiveErr == nil {
			archiveErr = closeErr
		}
	case "tar":
		writer := tar.NewWriter(archiveFile)
		for _, remotePath := range remotePaths {
			if archiveErr != nil {
				break
			}
			archiveErr = addRemoteToTar(
				ctx,
				client,
				remotePath,
				path.Base(remotePath),
				writer,
				onBytes,
				onFileComplete,
			)
		}
		closeErr := writer.Close()
		if archiveErr == nil {
			archiveErr = closeErr
		}
	case "tar.gz":
		gzipWriter := gzip.NewWriter(archiveFile)
		tarWriter := tar.NewWriter(gzipWriter)
		for _, remotePath := range remotePaths {
			if archiveErr != nil {
				break
			}
			archiveErr = addRemoteToTar(
				ctx,
				client,
				remotePath,
				path.Base(remotePath),
				tarWriter,
				onBytes,
				onFileComplete,
			)
		}
		tarCloseErr := tarWriter.Close()
		gzipCloseErr := gzipWriter.Close()
		if archiveErr == nil {
			archiveErr = tarCloseErr
		}
		if archiveErr == nil {
			archiveErr = gzipCloseErr
		}
	}
	if archiveErr != nil {
		return archiveErr
	}
	if err := archiveFile.Sync(); err != nil {
		return err
	}
	if err := archiveFile.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if onProgress != nil {
		// 压缩进度按源文件字节计数，归档生成后的上传不重复折算。
		onProgress(remoteFileOperationProgress{
			completed:  sourceCompleted,
			total:      sourceTotal,
			totalKnown: true,
			files:      sourceFiles,
			doneFiles:  doneFiles,
			current:    target,
		})
	}
	if err := uploadLocalFileToRemote(
		ctx,
		client,
		localPath,
		target,
		nil,
	); err != nil {
		return err
	}
	return nil
}

func (s *FileService) extractRemoteArchive(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	client *sftp.Client,
	remotePath, remoteTarget string,
	onProgress func(remoteFileOperationProgress),
) (remoteArchiveExtractionResult, error) {
	format := remoteArchiveFormatForPath(remotePath)
	if format == "" {
		return remoteArchiveExtractionResult{}, fmt.Errorf("不支持解压该文件格式: %s", remotePath)
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return remoteArchiveExtractionResult{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return remoteArchiveExtractionResult{}, fmt.Errorf("不支持解压符号链接: %s", remotePath)
	}
	if info.IsDir() {
		return remoteArchiveExtractionResult{}, fmt.Errorf("不能解压目录: %s", remotePath)
	}
	stats, totalKnown, err := probeRemoteArchive(ctx, conn, sshClient, format, remotePath)
	if err != nil {
		return remoteArchiveExtractionResult{}, err
	}
	if onProgress != nil {
		onProgress(remoteFileOperationProgress{
			total:      stats.total,
			totalKnown: totalKnown,
			files:      stats.files,
			current:    remotePath,
		})
	}
	completed, err := runRemoteArchiveExtraction(
		ctx,
		conn,
		sshClient,
		client,
		format,
		remotePath,
		remoteTarget,
		stats,
		totalKnown,
		onProgress,
	)
	if err != nil {
		return remoteArchiveExtractionResult{completed: completed}, err
	}
	return remoteArchiveExtractionResult{
		completed:  completed,
		total:      stats.total,
		files:      stats.files,
		totalKnown: totalKnown,
	}, nil
}

func (s *FileService) StartFileUpload(sourceID string, localPaths []string, remotePath string) (FileTaskSnapshot, error) {
	if len(localPaths) == 0 {
		return FileTaskSnapshot{}, errors.New("未选择上传文件")
	}
	src, _, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return FileTaskSnapshot{}, err
	}
	remotePath = normalizedRemotePath(remotePath)
	ctx, cancel := context.WithCancel(context.Background())
	id := s.createFileTask(
		FileTask{Type: fileTaskTypeUpload, SourceID: sourceID, Target: remotePath},
		ctx,
		cancel,
	)
	go s.runFileUpload(ctx, id, src, localPaths, remotePath)
	return s.GetFileTasks(), nil
}

func (s *FileService) chooseDownloadTarget(remotePaths []string, chooseDirectory bool) (string, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "", errors.New("应用尚未初始化")
	}
	window := app.Window.Current()
	if len(remotePaths) == 1 && !chooseDirectory {
		filename := filepath.Base(remotePaths[0])
		dialog := app.Dialog.SaveFile().SetFilename(filename).CanCreateDirectories(true)
		if window != nil {
			dialog.AttachToWindow(window)
		}
		return dialog.PromptForSingleSelection()
	}
	dialog := app.Dialog.OpenFile().CanChooseFiles(false).CanChooseDirectories(true).CanCreateDirectories(true)
	if window != nil {
		dialog.AttachToWindow(window)
	}
	return dialog.PromptForSingleSelection()
}

func (s *FileService) StartFileDownload(sourceID string, remotePaths []string) (FileTaskSnapshot, error) {
	if len(remotePaths) == 0 {
		return FileTaskSnapshot{}, errors.New("未选择下载文件")
	}
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return FileTaskSnapshot{}, err
	}
	chooseDirectory := len(remotePaths) > 1
	if len(remotePaths) == 1 {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		sshClient, client, statErr := s.dialSFTP(ctx, conn)
		if statErr != nil {
			cancel()
			return FileTaskSnapshot{}, statErr
		}
		info, statErr := client.Lstat(normalizedRemotePath(remotePaths[0]))
		_ = client.Close()
		closeSSHClient(sshClient)
		// 本地 SSH 模式的 SFTP 进程绑定了 ctx，必须完成 Lstat 后再取消，否则会提前断开连接。
		cancel()
		if statErr != nil {
			return FileTaskSnapshot{}, fmt.Errorf("读取远程项目失败: %w", statErr)
		}
		chooseDirectory = info.IsDir()
	}
	target, err := s.chooseDownloadTarget(remotePaths, chooseDirectory)
	if err != nil {
		return FileTaskSnapshot{}, err
	}
	if target == "" {
		return s.GetFileTasks(), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	id := s.createFileTask(
		FileTask{Type: fileTaskTypeDownload, SourceID: sourceID, Target: target, Files: len(remotePaths)},
		ctx,
		cancel,
	)
	go s.runFileDownload(ctx, id, sourceID, remotePaths, target)
	return s.GetFileTasks(), nil
}

// PrepareFileForDrag 将远程项目准备到临时目录，返回可交给 Finder 或聊天工具的本地路径。
// 调用方在 dragstart 前预取，避免把未完成的远程内容交给接收方。
func (s *FileService) PrepareFileForDrag(sourceID, remotePath string) (string, error) {
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		return "", err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	remotePath = normalizedRemotePath(remotePath)
	if _, err := client.Lstat(remotePath); err != nil {
		return "", err
	}
	directory, err := os.MkdirTemp("", "devutils-ssh-drag-")
	if err != nil {
		return "", err
	}
	s.registerDragTemp(directory)
	target := filepath.Join(directory, filepath.Base(remotePath))
	done, doneFiles := int64(0), 0
	if err := s.downloadRemotePath(ctx, client, remotePath, target, "", &done, &doneFiles); err != nil {
		s.removeDragTemp(directory)
		return "", err
	}
	time.AfterFunc(30*time.Minute, func() { s.removeDragTemp(directory) })
	return target, nil
}

type remoteTreeItem struct {
	remote string
	info   os.FileInfo
}

func collectRemoteTree(client *sftp.Client, root string, out *[]remoteTreeItem) error {
	info, err := client.Lstat(root)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	*out = append(*out, remoteTreeItem{remote: root, info: info})
	if !info.IsDir() {
		return nil
	}
	entries, err := client.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := collectRemoteTree(client, remoteChild(root, entry.Name()), out); err != nil {
			return err
		}
	}
	return nil
}

func (s *FileService) runFileUpload(ctx context.Context, taskID string, source FileSource, localPaths []string, remoteRoot string) {
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage = fileTaskScanning, fileTaskScanning
	})
	total, files, err := localTree(ctx, localPaths)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Total, task.Files = total, files
	})
	_, conn, err := s.sourceSnapshot(source.ID)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	if err := client.MkdirAll(remoteRoot); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Status, task.Stage = fileTaskRunning, "uploading" })
	var done int64
	doneFiles := 0
	for _, localRoot := range localPaths {
		if err = s.uploadLocalPath(ctx, client, localRoot, remoteRoot, taskID, &done, &doneFiles, nil); err != nil {
			s.finishFileTask(taskID, err)
			return
		}
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Completed, task.DoneFiles = fileTaskSuccess, "done", done, doneFiles
		task.Current = ""
	})
}

func (s *FileService) uploadLocalPath(
	ctx context.Context,
	client *sftp.Client,
	localRoot, remoteRoot, taskID string,
	done *int64,
	doneFiles *int,
	onProgress func(int64, int, string),
) error {
	info, err := os.Lstat(localRoot)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	base := remoteChild(remoteRoot, filepath.Base(localRoot))
	if info.IsDir() {
		if err := client.MkdirAll(base); err != nil {
			return err
		}
		return filepath.Walk(localRoot, func(localPath string, item os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if item.Mode()&os.ModeSymlink != 0 {
				if item.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			rel, err := filepath.Rel(localRoot, localPath)
			if err != nil {
				return err
			}
			remote := base
			if rel != "." {
				remote = path.Join(base, filepath.ToSlash(rel))
			}
			if item.IsDir() {
				return client.MkdirAll(remote)
			}
			if !item.Mode().IsRegular() {
				return nil
			}
			return s.uploadLocalFile(ctx, client, localPath, remote, taskID, done, doneFiles, onProgress)
		})
	}
	return s.uploadLocalFile(ctx, client, localRoot, base, taskID, done, doneFiles, onProgress)
}

func (s *FileService) uploadLocalFile(
	ctx context.Context,
	client *sftp.Client,
	localPath, remotePath, taskID string,
	done *int64,
	doneFiles *int,
	onProgress func(int64, int, string),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	input, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	defer output.Close()
	buf := make([]byte, 256*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := input.Read(buf)
		if n > 0 {
			if _, err = output.Write(buf[:n]); err != nil {
				return err
			}
			*done += int64(n)
			s.updateFileTask(taskID, func(task *fileTaskState) { task.Completed = *done; task.Current = localPath })
			if onProgress != nil {
				onProgress(*done, *doneFiles, remotePath)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	*doneFiles++
	s.updateFileTask(taskID, func(task *fileTaskState) { task.DoneFiles = *doneFiles })
	if onProgress != nil {
		onProgress(*done, *doneFiles, remotePath)
	}
	return nil
}

func (s *FileService) runFileDownload(ctx context.Context, taskID, sourceID string, remotePaths []string, target string) {
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Status, task.Stage = fileTaskScanning, fileTaskScanning })
	items := make([]remoteTreeItem, 0)
	for _, remote := range remotePaths {
		if err = collectRemoteTree(client, normalizedRemotePath(remote), &items); err != nil {
			s.finishFileTask(taskID, err)
			return
		}
	}
	var total int64
	files := 0
	for _, item := range items {
		if item.info.Mode().IsRegular() {
			total += item.info.Size()
			files++
		}
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Total, task.Files = total, files
		task.Status, task.Stage = fileTaskRunning, "downloading"
	})
	var done int64
	doneFiles := 0
	for _, remote := range remotePaths {
		info, statErr := client.Lstat(normalizedRemotePath(remote))
		if statErr != nil {
			s.finishFileTask(taskID, statErr)
			return
		}
		destination := target
		if len(remotePaths) > 1 || info.IsDir() {
			destination = filepath.Join(target, filepath.Base(remote))
		}
		if err = s.downloadRemotePath(ctx, client, normalizedRemotePath(remote), destination, taskID, &done, &doneFiles); err != nil {
			s.finishFileTask(taskID, err)
			return
		}
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Completed, task.DoneFiles = fileTaskSuccess, "done", done, doneFiles
		task.Current = ""
	})
}

func (s *FileService) downloadRemotePath(ctx context.Context, client *sftp.Client, remotePath, localPath, taskID string, done *int64, doneFiles *int) error {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	if info.IsDir() {
		if err := os.MkdirAll(localPath, 0o755); err != nil {
			return err
		}
		entries, err := client.ReadDir(remotePath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := s.downloadRemotePath(ctx, client, remoteChild(remotePath, entry.Name()), filepath.Join(localPath, entry.Name()), taskID, done, doneFiles); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(localPath), ".devutils-download-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	input, err := client.Open(remotePath)
	if err != nil {
		tmp.Close()
		return err
	}
	defer input.Close()
	buf := make([]byte, 256*1024)
	for {
		if err := ctx.Err(); err != nil {
			tmp.Close()
			return err
		}
		n, readErr := input.Read(buf)
		if n > 0 {
			if _, err = tmp.Write(buf[:n]); err != nil {
				tmp.Close()
				return err
			}
			*done += int64(n)
			s.updateFileTask(taskID, func(task *fileTaskState) { task.Completed, task.Current = *done, remotePath })
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			tmp.Close()
			return readErr
		}
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, localPath); err != nil {
		return err
	}
	*doneFiles++
	s.updateFileTask(taskID, func(task *fileTaskState) { task.DoneFiles = *doneFiles })
	return nil
}

func (s *FileService) finishFileTask(taskID string, err error) {
	if errors.Is(err, context.Canceled) {
		s.updateFileTask(taskID, func(task *fileTaskState) {
			task.Status, task.Stage = fileTaskCanceled, fileTaskCanceled
			task.Error = ""
			if task.cancel != nil {
				task.cancel()
			}
			task.ctx = nil
			task.cancel = nil
		})
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Error = fileTaskFailed, fileTaskFailed, err.Error()
		if task.cancel != nil {
			task.cancel()
		}
		task.ctx = nil
		task.cancel = nil
	})
}

func (s *FileService) CalculateRemoteSize(sourceID, remotePath string) (FileTaskSnapshot, error) {
	if _, _, err := s.sourceSnapshot(sourceID); err != nil {
		return FileTaskSnapshot{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	id := s.createFileTask(
		FileTask{Type: fileTaskTypeSize, SourceID: sourceID, Target: normalizedRemotePath(remotePath)},
		ctx,
		cancel,
	)
	go s.runSizeTask(ctx, id, sourceID, normalizedRemotePath(remotePath))
	return s.GetFileTasks(), nil
}

func (s *FileService) runSizeTask(ctx context.Context, taskID, sourceID, remotePath string) {
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Status, task.Stage = fileTaskScanning, fileTaskScanning })
	var total int64
	count := 0
	var walk func(string) error
	walk = func(current string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := client.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if info.Mode().IsRegular() {
			count++
			total += info.Size()
		}
		s.updateFileTask(taskID, func(task *fileTaskState) {
			task.Completed, task.Files, task.DoneFiles = total, count, count
			task.Current = current
		})
		if !info.IsDir() {
			return nil
		}
		entries, err := client.ReadDir(current)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := walk(remoteChild(current, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if err = walk(remotePath); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Total, task.Completed = fileTaskSuccess, "done", total, total
		task.Current = ""
	})
}
