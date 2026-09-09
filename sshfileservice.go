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
	fileTaskQueued       = "queued"
	fileTaskScanning     = "scanning"
	fileTaskRunning      = "running"
	fileTaskSuccess      = "success"
	fileTaskFailed       = "failed"
	fileTaskCanceled     = "canceled"
	fileTasksEventName   = "ssh-files:tasks"
)

const (
	remoteFileOperationCopy     = "copy"
	remoteFileOperationMove     = "move"
	remoteFileOperationRename   = "rename"
	remoteFileOperationDelete   = "delete"
	remoteFileOperationExtract  = "extract"
	remoteFileOperationCompress = "compress"
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
	ID        string `json:"id"`
	Type      string `json:"type"`
	SourceID  string `json:"sourceID"`
	Status    string `json:"status"`
	Stage     string `json:"stage"`
	Current   string `json:"current,omitempty"`
	Target    string `json:"target,omitempty"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Files     int    `json:"files"`
	DoneFiles int    `json:"doneFiles"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type FileTaskSnapshot struct {
	Revision uint64     `json:"revision"`
	Tasks    []FileTask `json:"tasks"`
}

type fileTaskState struct {
	FileTask
	cancel context.CancelFunc
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
			tasks = append(tasks, task.FileTask)
		}
	}
	return FileTaskSnapshot{Revision: s.taskRevision, Tasks: tasks}
}

func (s *FileService) createFileTask(task FileTask, cancel context.CancelFunc) string {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task.ID = fmt.Sprintf("ssh-file-task-%d", time.Now().UnixNano())
	task.Status, task.Stage = fileTaskQueued, fileTaskQueued
	task.CreatedAt, task.UpdatedAt = now, now
	s.taskMu.Lock()
	if s.tasks == nil {
		s.tasks = map[string]*fileTaskState{}
	}
	s.tasks[task.ID] = &fileTaskState{FileTask: task, cancel: cancel}
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
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return errors.New("文件任务不存在")
	}
	if task.cancel != nil {
		task.cancel()
	}
	s.taskMu.Unlock()
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
		if operation == remoteFileOperationCopy && info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("不支持复制符号链接: %s", remotePath)
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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
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
		for _, item := range items {
			if item.noOp {
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
			if operation == remoteFileOperationCopy {
				if err := copyRemotePath(ctx, client, item.source, destination); err != nil {
					return result, fmt.Errorf("复制远程项目失败: %w", err)
				}
			} else if err := client.Rename(item.source, destination); err != nil {
				return result, fmt.Errorf("移动远程项目失败: %w", err)
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
		if err := createRemoteArchive(ctx, client, paths, target); err != nil {
			return result, fmt.Errorf("压缩远程项目失败: %w", err)
		}
	case remoteFileOperationExtract:
		if err := ensureRemoteDirectory(client, target); err != nil {
			return result, err
		}
		for _, remotePath := range paths {
			if err := s.extractRemoteArchive(ctx, client, remotePath, target); err != nil {
				return result, fmt.Errorf("解压远程项目失败: %w", err)
			}
		}
	}
	return result, nil
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

func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) error {
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
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func copyRemoteFile(ctx context.Context, client *sftp.Client, source, target string) error {
	input, err := client.Open(source)
	if err != nil {
		return err
	}
	output, err := client.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		_ = input.Close()
		return err
	}
	copyErr := copyWithContext(ctx, output, input)
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

func copyRemotePath(ctx context.Context, client *sftp.Client, source, target string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := client.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("不支持复制符号链接: %s", source)
	}
	if info.IsDir() {
		if err := client.MkdirAll(target); err != nil {
			return err
		}
		entries, err := client.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyRemotePath(
				ctx,
				client,
				remoteChild(source, entry.Name()),
				remoteChild(target, entry.Name()),
			); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	return copyRemoteFile(ctx, client, source, target)
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

func writeRemoteFileToArchive(ctx context.Context, client *sftp.Client, remotePath string, dst io.Writer) error {
	input, err := client.Open(remotePath)
	if err != nil {
		return err
	}
	copyErr := copyWithContext(ctx, dst, input)
	closeErr := input.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func addRemoteToTar(
	ctx context.Context,
	client *sftp.Client,
	remotePath, relativePath string,
	writer *tar.Writer,
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
		return writeRemoteFileToArchive(ctx, client, remotePath, writer)
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
		return writeRemoteFileToArchive(ctx, client, remotePath, entry)
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
		); err != nil {
			return err
		}
	}
	return nil
}

func uploadLocalFileToRemote(ctx context.Context, client *sftp.Client, localPath, remotePath string) error {
	input, err := os.Open(localPath)
	if err != nil {
		return err
	}
	output, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		_ = input.Close()
		return err
	}
	copyErr := copyWithContext(ctx, output, input)
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

	var archiveErr error
	switch format {
	case "zip":
		writer := zip.NewWriter(archiveFile)
		for _, remotePath := range remotePaths {
			if archiveErr != nil {
				break
			}
			archiveErr = addRemoteToZip(ctx, client, remotePath, path.Base(remotePath), writer)
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
			archiveErr = addRemoteToTar(ctx, client, remotePath, path.Base(remotePath), writer)
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
			archiveErr = addRemoteToTar(ctx, client, remotePath, path.Base(remotePath), tarWriter)
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
	return uploadLocalFileToRemote(ctx, client, localPath, target)
}

func downloadRemoteFileToLocal(
	ctx context.Context,
	client *sftp.Client,
	remotePath string,
) (string, error) {
	input, err := client.Open(remotePath)
	if err != nil {
		return "", err
	}
	output, err := os.CreateTemp("", "devutils-ssh-extract-*")
	if err != nil {
		_ = input.Close()
		return "", err
	}
	localPath := output.Name()
	copyErr := copyWithContext(ctx, output, input)
	outputErr := output.Close()
	inputErr := input.Close()
	if copyErr != nil {
		_ = os.Remove(localPath)
		return "", copyErr
	}
	if outputErr != nil {
		_ = os.Remove(localPath)
		return "", outputErr
	}
	if inputErr != nil {
		_ = os.Remove(localPath)
		return "", inputErr
	}
	return localPath, nil
}

func safeArchiveRelativePath(value string) (string, error) {
	value = strings.ReplaceAll(value, "\\", "/")
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	if strings.HasPrefix(value, "/") {
		return "", fmt.Errorf("压缩包包含绝对路径: %s", value)
	}
	cleaned := path.Clean(value)
	first := strings.Split(cleaned, "/")[0]
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") ||
		strings.Contains(first, ":") {
		return "", fmt.Errorf("压缩包包含不安全路径: %s", value)
	}
	return cleaned, nil
}

func safeArchiveDestination(root, relativePath string) (string, error) {
	destination := filepath.Join(root, filepath.FromSlash(relativePath))
	relative, err := filepath.Rel(root, destination)
	if err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(os.PathSeparator)) ||
		filepath.IsAbs(relative) {
		return "", fmt.Errorf("压缩包包含不安全路径: %s", relativePath)
	}
	return destination, nil
}

func extractZipArchive(ctx context.Context, archivePath, destinationRoot string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, item := range reader.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		relativePath, err := safeArchiveRelativePath(item.Name)
		if err != nil {
			return err
		}
		if relativePath == "" {
			continue
		}
		destination, err := safeArchiveDestination(destinationRoot, relativePath)
		if err != nil {
			return err
		}
		if item.FileInfo().IsDir() || strings.HasSuffix(item.Name, "/") {
			if err := os.MkdirAll(destination, 0o755); err != nil {
				return err
			}
			continue
		}
		if item.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("不支持解压符号链接: %s", item.Name)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return err
		}
		input, err := item.Open()
		if err != nil {
			return err
		}
		mode := item.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
		output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
		if err != nil {
			_ = input.Close()
			return err
		}
		copyErr := copyWithContext(ctx, output, input)
		outputErr := output.Close()
		inputErr := input.Close()
		if copyErr != nil {
			return copyErr
		}
		if outputErr != nil {
			return outputErr
		}
		if inputErr != nil {
			return inputErr
		}
	}
	return nil
}

func extractTarArchive(ctx context.Context, archivePath, destinationRoot, format string) error {
	input, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer input.Close()
	var reader io.Reader = input
	var gzipReader *gzip.Reader
	if format == "tar.gz" {
		gzipReader, err = gzip.NewReader(input)
		if err != nil {
			return err
		}
		defer gzipReader.Close()
		reader = gzipReader
	}
	tarReader := tar.NewReader(reader)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		relativePath, err := safeArchiveRelativePath(header.Name)
		if err != nil {
			return err
		}
		if relativePath == "" {
			continue
		}
		destination, err := safeArchiveDestination(destinationRoot, relativePath)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(destination, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(header.Mode).Perm()
			if mode == 0 {
				mode = 0o644
			}
			output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			copyErr := copyWithContext(ctx, output, tarReader)
			outputErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if outputErr != nil {
				return outputErr
			}
		case tar.TypeSymlink, tar.TypeLink:
			return fmt.Errorf("不支持解压链接: %s", header.Name)
		}
	}
}

func extractArchive(ctx context.Context, archivePath, destinationRoot, format string) error {
	switch format {
	case "zip":
		return extractZipArchive(ctx, archivePath, destinationRoot)
	case "tar", "tar.gz":
		return extractTarArchive(ctx, archivePath, destinationRoot, format)
	default:
		return errors.New("压缩文件格式不受支持")
	}
}

func (s *FileService) uploadLocalDirectoryContents(
	ctx context.Context,
	client *sftp.Client,
	localRoot, remoteRoot string,
) error {
	entries, err := os.ReadDir(localRoot)
	if err != nil {
		return err
	}
	var done int64
	doneFiles := 0
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.uploadLocalPath(
			ctx,
			client,
			filepath.Join(localRoot, entry.Name()),
			remoteRoot,
			"",
			&done,
			&doneFiles,
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *FileService) extractRemoteArchive(
	ctx context.Context,
	client *sftp.Client,
	remotePath, remoteTarget string,
) error {
	format := remoteArchiveFormatForPath(remotePath)
	if format == "" {
		return fmt.Errorf("不支持解压该文件格式: %s", remotePath)
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("不能解压目录: %s", remotePath)
	}
	localArchive, err := downloadRemoteFileToLocal(ctx, client, remotePath)
	if err != nil {
		return err
	}
	defer os.Remove(localArchive)
	localRoot, err := os.MkdirTemp("", "devutils-ssh-extract-dir-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(localRoot)
	if err := extractArchive(ctx, localArchive, localRoot, format); err != nil {
		return err
	}
	return s.uploadLocalDirectoryContents(ctx, client, localRoot, remoteTarget)
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
	id := s.createFileTask(FileTask{Type: fileTaskTypeUpload, SourceID: sourceID, Target: remotePath}, cancel)
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
	id := s.createFileTask(FileTask{Type: fileTaskTypeDownload, SourceID: sourceID, Target: target, Files: len(remotePaths)}, cancel)
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
		if err = s.uploadLocalPath(ctx, client, localRoot, remoteRoot, taskID, &done, &doneFiles); err != nil {
			s.finishFileTask(taskID, err)
			return
		}
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Completed, task.DoneFiles = fileTaskSuccess, "done", done, doneFiles
		task.Current = ""
	})
}

func (s *FileService) uploadLocalPath(ctx context.Context, client *sftp.Client, localRoot, remoteRoot, taskID string, done *int64, doneFiles *int) error {
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
			return s.uploadLocalFile(ctx, client, localPath, remote, taskID, done, doneFiles)
		})
	}
	return s.uploadLocalFile(ctx, client, localRoot, base, taskID, done, doneFiles)
}

func (s *FileService) uploadLocalFile(ctx context.Context, client *sftp.Client, localPath, remotePath, taskID string, done *int64, doneFiles *int) error {
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
		})
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Error = fileTaskFailed, fileTaskFailed, err.Error()
	})
}

func (s *FileService) CalculateRemoteSize(sourceID, remotePath string) (FileTaskSnapshot, error) {
	if _, _, err := s.sourceSnapshot(sourceID); err != nil {
		return FileTaskSnapshot{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	id := s.createFileTask(FileTask{Type: fileTaskTypeSize, SourceID: sourceID, Target: normalizedRemotePath(remotePath)}, cancel)
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
