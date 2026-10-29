package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

const (
	fileTaskTypeUpload        = "upload"
	fileTaskTypeDownload      = "download"
	fileTaskTypeSize          = "size"
	fileTaskTypeCopy          = "copy"
	fileTaskTypeMove          = "move"
	fileTaskTypeExtract       = "extract"
	fileTaskTypeCompress      = "compress"
	fileTaskQueued            = "queued"
	fileTaskScanning          = "scanning"
	fileTaskRunning           = "running"
	fileTaskSuccess           = "success"
	fileTaskFailed            = "failed"
	fileTaskCanceled          = "canceled"
	fileTaskConflict          = "conflict"
	fileTasksEventName        = "ssh-files:tasks"
	directoryLoadingEventName = "ssh-files:directory-loading"
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

const (
	remoteFileSearchName           = "name"
	remoteFileSearchContent        = "content"
	remoteFileSearchScopeCurrent   = "current"
	remoteFileSearchScopeRecursive = "recursive"
	remoteFileSearchTimeout        = 5 * time.Minute
)

type RemoteFileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	IsDir      bool   `json:"isDir"`
	IsSymlink  bool   `json:"isSymlink"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
	CreatedAt  string `json:"createdAt"`
}

// RemoteDirectoryListing 是一次远程目录读取结果，Path 为实际列出的绝对路径。
// 请求路径为空时 Path 为 SFTP 工作目录（通常是 SSH 登录目录），而不是 "/"。
type RemoteDirectoryListing struct {
	Path    string            `json:"path"`
	Entries []RemoteFileEntry `json:"entries"`
}

type RemoteFileOperationResult struct {
	Conflicts []string `json:"conflicts,omitempty"`
}

func (s *FileService) configSnapshot() Config {
	if s.config == nil {
		return defaultConfig()
	}
	return s.config.Get()
}

func copyFileSources(items []FileSource) []FileSource {
	copied := append([]FileSource(nil), items...)
	for index := range copied {
		copied[index].FavoritePaths = append([]string(nil), items[index].FavoritePaths...)
	}
	return copied
}

func (s *FileService) GetFileSources() []FileSource {
	return copyFileSources(s.configSnapshot().FileSources)
}

// SaveFileSources 只持久化文件工具元数据；SSH 凭据保存在 ConfigService.SSHProfiles，
// 不会由此接口提交。
func (s *FileService) SaveFileSources(sources []FileSource) error {
	sources = copyFileSources(sources)
	if s == nil || s.config == nil {
		return userError("errors.common.configNotInitialized")
	}
	return s.config.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		profiles := make(map[string]struct{}, len(cfg.SSHProfiles))
		for _, profile := range cfg.SSHProfiles {
			profiles[profile.ID] = struct{}{}
		}
		for index := range sources {
			source := &sources[index]
			source.ID = strings.TrimSpace(source.ID)
			source.Name = strings.TrimSpace(source.Name)
			source.SSHProfileID = strings.TrimSpace(source.SSHProfileID)
			source.DefaultPath = strings.TrimSpace(source.DefaultPath)
			if !validConfigValue(source.ID, 128) || source.Name == "" || !validTextValue(source.Name, 256) {
				return userErrorParams("errors.sshFile.invalidFileSource", map[string]any{"id": source.ID})
			}
			if !validConfigValue(source.SSHProfileID, 128) {
				return userErrorParams("errors.sshFile.invalidFileSourceSSHProfileID", map[string]any{"id": source.ID})
			}
			if _, ok := profiles[source.SSHProfileID]; !ok {
				return userErrorParams("errors.sshFile.fileSourceSSHProfileMissing", map[string]any{"id": source.ID})
			}
			if source.DefaultPath != "" && !validPathValue(source.DefaultPath, 4096) {
				return userErrorParams("errors.sshFile.invalidFileSourceDefaultPath", map[string]any{"id": source.ID})
			}
			source.FavoritePaths = normalizeFavoritePaths(source.FavoritePaths)
		}
		seen := make(map[string]struct{}, len(sources))
		for _, source := range sources {
			if _, ok := seen[source.ID]; ok {
				return userErrorParams("errors.sshFile.duplicateFileSourceID", map[string]any{"id": source.ID})
			}
			seen[source.ID] = struct{}{}
		}
		cfg.FileSources = sources
		return nil
	})
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
		return FileSource{}, SSHConnection{}, userError("errors.sshFile.fileSourceNotFound")
	}
	if src.SSHProfileID != "" {
		for _, profile := range cfg.SSHProfiles {
			if profile.ID == src.SSHProfileID {
				return src, sshProfileToConnection(profile), nil
			}
		}
		return FileSource{}, SSHConnection{}, userError("errors.sshFile.fileSourceSSHProfileNotFound")
	}
	return FileSource{}, SSHConnection{}, userError("errors.sshFile.fileSourceSSHProfileNotFound")
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

func resolveRemoteDirectory(client *sftp.Client, currentPath string) (string, error) {
	if strings.TrimSpace(currentPath) != "" {
		return normalizedRemotePath(currentPath), nil
	}
	wd, err := client.Getwd()
	if err != nil {
		return "", userErrorCause("errors.sshFile.readWorkingDirectoryFailed", err)
	}
	return normalizedRemotePath(wd), nil
}

func remoteChild(parent, name string) string {
	if parent == "/" {
		return "/" + name
	}
	return path.Join(parent, name)
}

type uploadTransferTuning struct {
	segmentSize int64
	writeSize   int64
}

func remoteUploadTransferTuning(taskConcurrency, chunkConcurrency int) uploadTransferTuning {
	lanes := int64(clampTaskLimit(taskConcurrency) * clampTaskLimit(chunkConcurrency))
	window := remoteUploadWindowBudget / lanes
	window = max(remoteUploadMinWindowSize, min(remoteUploadMaxWindowSize, window))
	return uploadTransferTuning{segmentSize: window, writeSize: window}
}

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
			return nil, userError("errors.sshFile.invalidLocalSSHAlias")
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
		return nil, userError("errors.sshFile.sessionNotEstablished")
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

func remoteCreationTimesCommand(remotePaths []string) string {
	quotedPaths := make([]string, len(remotePaths))
	for index, remotePath := range remotePaths {
		quotedPaths[index] = shellQuote(remotePath)
	}
	return "for item in " + strings.Join(quotedPaths, " ") +
		`; do stat -c %W -- "$item" 2>/dev/null || stat -f %B "$item" 2>/dev/null || printf '0\n'; done`
}

func parseRemoteCreationTimes(output []byte, count int) []string {
	createdAt := make([]string, count)
	for index, value := range strings.Fields(string(output)) {
		if index >= count {
			break
		}
		seconds, err := strconv.ParseInt(value, 10, 64)
		if err != nil || seconds <= 0 {
			continue
		}
		createdAt[index] = time.Unix(seconds, 0).UTC().Format(time.RFC3339)
	}
	return createdAt
}

func remoteCreationTimes(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	remotePaths []string,
) ([]string, error) {
	createdAt := make([]string, len(remotePaths))
	if len(remotePaths) == 0 {
		return createdAt, nil
	}
	output, err := runRemoteCommandOutput(ctx, conn, sshClient, remoteCreationTimesCommand(remotePaths))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// 创建时间是可选元数据，远程 stat 不可用时仍返回目录列表。
		return createdAt, nil
	}
	return parseRemoteCreationTimes(output, len(remotePaths)), nil
}

// ListRemoteFiles 列出远程目录。ctx 来自 Wails 绑定调用，前端取消时中断连接与读取；
// requestID 只用于关联连接与读取阶段的加载事件。
func (s *FileService) ListRemoteFiles(ctx context.Context, sourceID, currentPath string, showHidden bool, requestID string) (RemoteDirectoryListing, error) {
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return RemoteDirectoryListing{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	s.sessionMu.Lock()
	cached := s.sessions[sourceID]
	hasCachedSession := cached != nil && cached.connection == conn && !cached.retired
	s.sessionMu.Unlock()
	if !hasCachedSession {
		s.emitDirectoryLoading(requestID, "connecting")
	}
	session, err := s.acquirePersistentSFTP(ctx, sourceID, conn)
	if err != nil {
		return RemoteDirectoryListing{}, err
	}
	defer s.releasePersistentSFTP(session)
	s.emitDirectoryLoading(requestID, "loadingDirectory")
	remotePath, err := resolveRemoteDirectory(session.sftp, currentPath)
	if err != nil {
		s.invalidatePersistentSFTP(sourceID, session)
		return RemoteDirectoryListing{}, err
	}
	entries, err := session.sftp.ReadDirContext(ctx, remotePath)
	if err != nil {
		s.invalidatePersistentSFTP(sourceID, session)
		return RemoteDirectoryListing{}, userErrorCause("errors.sshFile.readRemoteDirectoryFailed", err)
	}
	visibleEntries := make([]os.FileInfo, 0, len(entries))
	for _, entry := range entries {
		if !showHidden && strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		visibleEntries = append(visibleEntries, entry)
	}
	result := make([]RemoteFileEntry, 0, len(visibleEntries))
	for _, entry := range visibleEntries {
		entryPath := remoteChild(remotePath, entry.Name())
		result = append(result, remoteFileEntryFromInfo(entryPath, entry, ""))
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return RemoteDirectoryListing{Path: remotePath, Entries: result}, nil
}

// emitDirectoryLoading 把连接、读取阶段同步给界面，requestID 用于忽略过期请求。
func (s *FileService) emitDirectoryLoading(requestID, phase string) {
	if requestID == "" || s.emitEvent == nil {
		return
	}
	s.emitEvent(directoryLoadingEventName, map[string]string{
		"requestID": requestID,
		"phase":     phase,
	})
}

// GetRemoteCreationTimes 在目录列表返回后补充可选的创建时间元数据。
func (s *FileService) GetRemoteCreationTimes(ctx context.Context, sourceID string, remotePaths []string) (times map[string]string, err error) {
	result := make(map[string]string, len(remotePaths))
	if len(remotePaths) == 0 {
		return result, nil
	}
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	defer func() {
		if errors.Is(ctx.Err(), context.Canceled) {
			times, err = nil, nil
		}
	}()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, conn)
	if err != nil {
		return nil, err
	}
	defer s.releasePersistentSFTP(session)
	createdAt, err := remoteCreationTimes(ctx, conn, session.ssh, remotePaths)
	if err != nil {
		s.invalidatePersistentSFTP(sourceID, session)
		return nil, err
	}
	for index, remotePath := range remotePaths {
		result[remotePath] = createdAt[index]
	}
	return result, nil
}

// GetRemoteFileEntry 解析收藏路径的当前类型，不读取整个父目录。
func (s *FileService) GetRemoteFileEntry(ctx context.Context, sourceID, remotePath string) (RemoteFileEntry, error) {
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return RemoteFileEntry{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, conn)
	if err != nil {
		return RemoteFileEntry{}, err
	}
	defer s.releasePersistentSFTP(session)
	remotePath = normalizedRemotePath(remotePath)
	info, err := session.sftp.Lstat(remotePath)
	if err != nil {
		return RemoteFileEntry{}, userErrorCause("errors.sshFile.readRemoteItemFailed", err)
	}
	return remoteFileEntryFromInfo(remotePath, info, ""), nil
}

func remoteFileEntryFromInfo(remotePath string, entry os.FileInfo, createdAt string) RemoteFileEntry {
	mode := entry.Mode()
	size := int64(0)
	if mode.IsRegular() {
		size = entry.Size()
	}
	return RemoteFileEntry{
		Name:       entry.Name(),
		Path:       remotePath,
		IsDir:      mode.IsDir(),
		IsSymlink:  mode&os.ModeSymlink != 0,
		Size:       size,
		ModifiedAt: entry.ModTime().UTC().Format(time.RFC3339),
		CreatedAt:  createdAt,
	}
}

func (s *FileService) TestSSHFileConnection(ctx context.Context, connection SSHConnection, defaultPath string) error {
	if connection.Port == 0 {
		connection.Port = 22
	}
	if connection.Mode != "local" && connection.Username == "" {
		return userError("errors.sshFile.emptyUsername")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	sshClient, client, err := s.dialSFTPWithOptions(ctx, connection, remoteDownloadSFTPOptions()...)
	if err != nil {
		return err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	remotePath, err := resolveRemoteDirectory(client, defaultPath)
	if err != nil {
		return err
	}
	_, err = client.Stat(remotePath)
	if err != nil {
		return userErrorCause("errors.sshFile.defaultPathInaccessible", err)
	}
	return nil
}

// CreateRemoteDirectory 在远程文件源的指定路径创建文件夹。
func (s *FileService) CreateRemoteDirectory(ctx context.Context, sourceID, remotePath string) error {
	remotePath = normalizedRemotePath(remotePath)
	if remotePath == "/" {
		return userError("errors.sshFile.invalidFolderPath")
	}
	_, conn, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
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
			return userError("errors.sshFile.folderExists")
		}
		return userError("errors.sshFile.targetNotFolder")
	}
	if !isRemoteNotFound(err) {
		return err
	}
	if err := ensureRemoteDirectory(client, path.Dir(remotePath)); err != nil {
		return err
	}
	if err := client.Mkdir(remotePath); err != nil {
		return userErrorCause("errors.sshFile.createRemoteFolderFailed", err)
	}
	return nil
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
			return 0, 0, userErrorParamsCause("errors.sshFile.scanLocalPathFailed", map[string]any{"path": root}, err)
		}
	}
	return total, files, nil
}

func addProgressBytes(values ...int64) (int64, error) {
	const maxInt64 = int64(^uint64(0) >> 1)
	var total int64
	for _, value := range values {
		if value < 0 || total > maxInt64-value {
			return 0, userError("errors.sshFile.archiveSizeOverflow")
		}
		total += value
	}
	return total, nil
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
