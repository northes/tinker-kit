package main

import (
	"context"
	"errors"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

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

func remoteArchiveMemberName(remotePath string) string {
	name := path.Base(remotePath)
	if strings.HasPrefix(name, "-") {
		return "./" + name
	}
	return name
}

func remoteArchiveCompressCommand(format string, remotePaths []string, target string) string {
	if len(remotePaths) == 0 {
		return ""
	}
	switch format {
	case "tar", "tar.gz":
		flag := "-cf"
		if format == "tar.gz" {
			flag = "-czf"
		}
		command := "command -v tar >/dev/null 2>&1 || exit 127; tar " + flag + " " + shellQuote(target)
		for _, remotePath := range remotePaths {
			command += " -C " + shellQuote(path.Dir(remotePath)) +
				" " + shellQuote(remoteArchiveMemberName(remotePath))
		}
		return command
	case "zip":
		type zipSourceGroup struct {
			parent string
			names  []string
		}
		groups := make([]zipSourceGroup, 0, len(remotePaths))
		for _, remotePath := range remotePaths {
			parent := path.Dir(remotePath)
			name := remoteArchiveMemberName(remotePath)
			if len(groups) > 0 && groups[len(groups)-1].parent == parent {
				groups[len(groups)-1].names = append(groups[len(groups)-1].names, name)
				continue
			}
			groups = append(groups, zipSourceGroup{parent: parent, names: []string{name}})
		}
		command := "command -v zip >/dev/null 2>&1 || exit 127; "
		for index, group := range groups {
			if index > 0 {
				command += " && "
			}
			command += "(cd " + shellQuote(group.parent) + " && zip -qr "
			if index > 0 {
				command += "-g "
			}
			command += shellQuote(target)
			for _, name := range group.names {
				command += " " + shellQuote(name)
			}
			command += ")"
		}
		return command
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
		return userErrorParams("errors.sshFile.compressSymlinkUnsupported", map[string]any{"path": remotePath})
	}
	if !info.IsDir() {
		if info.Size() < 0 {
			return userErrorParams("errors.sshFile.remoteFileSizeInvalid", map[string]any{"path": remotePath})
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
			return remoteArchiveStats{}, userErrorParams("errors.sshFile.remoteFileSizeInvalid", map[string]any{"path": remotePath})
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

func runRemoteArchiveCompression(
	ctx context.Context,
	conn SSHConnection,
	sshClient *ssh.Client,
	client *sftp.Client,
	format string,
	remotePaths []string,
	target string,
	onProgress func(remoteFileOperationProgress),
) (int64, error) {
	// 归档由远端 tar/zip 直接生成，本地只通过 SFTP 读取目标文件大小。
	command := remoteArchiveCompressCommand(format, remotePaths, target)
	if command == "" {
		return 0, userError("errors.sshFile.compressFormatUnsupported")
	}
	done := make(chan error, 1)
	go func() {
		done <- runRemoteCommand(ctx, conn, sshClient, command)
	}()
	ticker := time.NewTicker(remoteArchiveProgressPollInterval)
	defer ticker.Stop()
	var lastCompleted int64
	report := func() {
		info, err := client.Lstat(target)
		if err != nil || !info.Mode().IsRegular() {
			return
		}
		completed := info.Size()
		if completed < lastCompleted {
			completed = lastCompleted
		}
		lastCompleted = completed
		if onProgress == nil {
			return
		}
		onProgress(remoteFileOperationProgress{
			completed:  completed,
			current:    target,
			totalKnown: false,
		})
	}
	// 压缩总大小取决于压缩率，运行期间只能报告远端已生成的归档字节数。
	report()
	for {
		select {
		case err := <-done:
			report()
			if err != nil {
				_ = client.Remove(target)
				return lastCompleted, err
			}
			if onProgress != nil {
				onProgress(remoteFileOperationProgress{
					completed:  lastCompleted,
					total:      lastCompleted,
					totalKnown: true,
					current:    target,
				})
			}
			return lastCompleted, nil
		case <-ticker.C:
			report()
		case <-ctx.Done():
			if err := <-done; err != nil {
				_ = client.Remove(target)
			}
			return lastCompleted, ctx.Err()
		}
	}
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
		return 0, userError("errors.sshFile.compressFormatUnsupported")
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
		return remoteArchiveExtractionResult{}, userErrorParams("errors.sshFile.extractFormatUnsupported", map[string]any{"path": remotePath})
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		return remoteArchiveExtractionResult{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return remoteArchiveExtractionResult{}, userErrorParams("errors.sshFile.extractSymlinkUnsupported", map[string]any{"path": remotePath})
	}
	if info.IsDir() {
		return remoteArchiveExtractionResult{}, userErrorParams("errors.sshFile.extractDirectoryUnsupported", map[string]any{"path": remotePath})
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
