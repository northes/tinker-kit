package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

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
		return userErrorParams("errors.sshFile.targetExists", map[string]any{"path": remotePath})
	}
	return nil
}

func ensureRemoteDirectory(client *sftp.Client, remotePath string) error {
	remotePath = normalizedRemotePath(remotePath)
	info, err := client.Lstat(remotePath)
	if err == nil {
		if !info.IsDir() {
			return userErrorParams("errors.sshFile.targetNotDirectory", map[string]any{"path": remotePath})
		}
		return nil
	}
	if !isRemoteNotFound(err) {
		return err
	}
	if err := client.MkdirAll(remotePath); err != nil {
		return userErrorCause("errors.sshFile.createRemoteDirectoryFailed", err)
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
		return userErrorParams("errors.sshFile.copySymlinkUnsupported", map[string]any{"path": remotePath})
	}
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return userErrorParams("errors.sshFile.copyTypeUnsupported", map[string]any{"path": remotePath})
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
			return nil, userError("errors.sshFile.cannotTransferRoot")
		}
		info, err := client.Lstat(remotePath)
		if err != nil {
			return nil, userErrorCause("errors.sshFile.readRemoteItemFailed", err)
		}
		if operation == remoteFileOperationCopy {
			if err := validateRemoteCopyPath(client, remotePath); err != nil {
				return nil, err
			}
		}
		if info.IsDir() && remotePathContains(remotePath, target) {
			return nil, userErrorParams("errors.sshFile.cannotCopyIntoSelf", map[string]any{"path": remotePath})
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
			return "", userError("errors.sshFile.duplicateTargetName")
		}
		return item.destination, nil
	}
	if conflictPolicy == remoteFileConflictOverwrite {
		return item.destination, nil
	}
	if conflictPolicy != remoteFileConflictKeepBoth {
		return "", userError("errors.sshFile.conflictUnresolved")
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
	return s.operateRemoteFilesWithConnection(ctx, sourceID, operation, remotePaths, target, conflictPolicy, SSHConnection{}, false, onProgress)
}

func (s *FileService) operateRemoteFilesWithConnection(
	ctx context.Context,
	sourceID, operation string,
	remotePaths []string,
	target, conflictPolicy string,
	connection SSHConnection,
	hasConnectionSnapshot bool,
	onProgress func(remoteFileOperationProgress),
) (RemoteFileOperationResult, error) {
	var result RemoteFileOperationResult
	operation = strings.TrimSpace(operation)
	switch operation {
	case remoteFileOperationCopy, remoteFileOperationMove, remoteFileOperationRename,
		remoteFileOperationDelete, remoteFileOperationExtract, remoteFileOperationCompress:
	default:
		return result, userErrorParams("errors.sshFile.unsupportedOperation", map[string]any{"operation": operation})
	}
	paths := normalizeRemotePaths(remotePaths)
	if len(paths) == 0 {
		return result, userError("errors.sshFile.noRemoteItemsSelected")
	}
	if operation == remoteFileOperationRename && len(paths) != 1 {
		return result, userError("errors.sshFile.renameSingleItem")
	}
	if operation == remoteFileOperationCopy || operation == remoteFileOperationMove {
		switch strings.TrimSpace(conflictPolicy) {
		case "":
			conflictPolicy = remoteFileConflictAsk
		case remoteFileConflictAsk, remoteFileConflictOverwrite, remoteFileConflictKeepBoth:
		default:
			return result, userErrorParams("errors.sshFile.unsupportedConflictPolicy", map[string]any{"policy": conflictPolicy})
		}
	} else {
		conflictPolicy = ""
	}
	if operation == remoteFileOperationDelete {
		for _, remotePath := range paths {
			if remotePath == "/" {
				return result, userError("errors.sshFile.cannotDeleteRoot")
			}
		}
	}
	if operation == remoteFileOperationCompress {
		target = normalizedRemotePath(target)
		if target == "/" {
			return result, userError("errors.sshFile.invalidArchivePath")
		}
		if remoteArchiveFormatForPath(target) == "" {
			return result, userError("errors.sshFile.unsupportedArchiveExtension")
		}
	}
	if operation == remoteFileOperationRename {
		target = normalizedRemotePath(target)
		if target == "/" {
			return result, userError("errors.sshFile.invalidRenameTarget")
		}
	}
	if operation == remoteFileOperationCopy || operation == remoteFileOperationMove ||
		operation == remoteFileOperationExtract {
		target = normalizedRemotePath(target)
	}

	var err error
	if !hasConnectionSnapshot {
		_, connection, err = s.sourceSnapshot(sourceID)
		if err != nil {
			return result, err
		}
	}
	if operation == remoteFileOperationDelete {
		if connection.Mode == "local" {
			if err := runRemoteCommand(ctx, connection, nil, remoteDeleteCommand(paths)); err != nil {
				return result, userErrorCause("errors.sshFile.deleteRemoteItemFailed", err)
			}
			return result, nil
		}
		session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
		if err != nil {
			return result, err
		}
		defer s.releasePersistentSFTP(session)
		if err := runRemoteCommand(ctx, connection, session.ssh, remoteDeleteCommand(paths)); err != nil {
			return result, userErrorCause("errors.sshFile.deleteRemoteItemFailed", err)
		}
		return result, nil
	}
	sshClient, client, err := s.dialSFTP(ctx, connection)
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
				return result, userError("errors.sshFile.duplicateTargetName")
			}
			reserved[destination] = struct{}{}
			if item.exists && conflictPolicy == remoteFileConflictOverwrite {
				if operation == remoteFileOperationCopy && destination == item.source {
					return result, userError("errors.sshFile.copyTargetIsSource")
				}
				if err := client.RemoveAll(destination); err != nil {
					return result, userErrorCause("errors.sshFile.overwriteRemoteItemFailed", err)
				}
			}
			if err := runRemoteCommand(
				ctx,
				connection,
				sshClient,
				remoteTransferCommand(operation, item.source, destination),
			); err != nil {
				if operation == remoteFileOperationCopy {
					return result, userErrorCause("errors.sshFile.copyRemoteItemFailed", err)
				}
				return result, userErrorCause("errors.sshFile.moveRemoteItemFailed", err)
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
			return result, userError("errors.sshFile.invalidRenameTarget")
		}
		if err := ensureRemotePathAbsent(client, target); err != nil {
			return result, err
		}
		if err := client.Rename(remotePath, target); err != nil {
			return result, userErrorCause("errors.sshFile.renameRemoteItemFailed", err)
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
				return result, userErrorCause("errors.sshFile.readRemoteItemFailed", err)
			}
			if remotePath == target || (info.IsDir() && remotePathContains(remotePath, target)) {
				return result, userErrorParams("errors.sshFile.archiveTargetInsideSource", map[string]any{"target": target})
			}
		}
		_, err := collectRemoteArchiveStats(ctx, client, paths)
		if err != nil {
			return result, userErrorCause("errors.sshFile.collectArchiveStatsFailed", err)
		}
		format := remoteArchiveFormatForPath(target)
		if _, err := runRemoteArchiveCompression(
			ctx,
			connection,
			sshClient,
			client,
			format,
			paths,
			target,
			onProgress,
		); err != nil {
			return result, userErrorCause("errors.sshFile.compressRemoteItemFailed", err)
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
				connection,
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
				return result, userErrorCause("errors.sshFile.extractRemoteItemFailed", err)
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
