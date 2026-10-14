package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/crypto/ssh"
)

func (s *FileService) chooseDownloadTarget(remotePaths []string, chooseDirectory bool) (string, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "", userError("errors.common.notInitialized")
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
		return FileTaskSnapshot{}, userError("errors.sshFile.noDownloadFilesSelected")
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
			return FileTaskSnapshot{}, userErrorCause("errors.sshFile.readRemoteItemFailed", statErr)
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
	for _, remotePath := range remotePaths {
		ctx, cancel := context.WithCancel(context.Background())
		id := s.createFileTask(
			FileTask{Type: fileTaskTypeDownload, SourceID: sourceID, Target: target, Paths: []string{remotePath}, Files: 1, Batch: len(remotePaths) > 1},
			ctx,
			cancel,
		)
		go s.runFileDownload(ctx, id, conn, []string{remotePath}, target, len(remotePaths) > 1)
	}
	return s.GetFileTasks(), nil
}

type remoteTreeItem struct {
	remote string
	local  string
	info   os.FileInfo
}

func collectRemoteTree(
	ctx context.Context,
	client *sftp.Client,
	root, localRoot string,
	rootInfo os.FileInfo,
	out *[]remoteTreeItem,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info := rootInfo
	if info == nil {
		var err error
		info, err = client.Lstat(root)
		if err != nil {
			return err
		}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	*out = append(*out, remoteTreeItem{remote: root, local: localRoot, info: info})
	if !info.IsDir() {
		return nil
	}
	entries, err := client.ReadDirContext(ctx, root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := collectRemoteTree(
			ctx,
			client,
			remoteChild(root, entry.Name()),
			filepath.Join(localRoot, entry.Name()),
			nil,
			out,
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *FileService) runFileDownload(ctx context.Context, taskID string, connection SSHConnection, remotePaths []string, target string, batch bool) {
	if !s.acquireTaskSlot(ctx, taskID) {
		return
	}
	if s.taskScheduler != nil {
		defer s.taskScheduler.Release()
	}
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Status, task.Stage = fileTaskScanning, "connecting" })
	sshClient, client, err := s.dialSFTPWithOptions(ctx, connection, remoteDownloadSFTPOptions()...)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	sshClients := []*ssh.Client{sshClient}
	sftpClients := []*sftp.Client{client}
	defer func() { closeDownloadSFTPClients(sshClients, sftpClients) }()
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Stage = "loadingRemoteDirectory" })
	items := make([]remoteTreeItem, 0)
	for _, remote := range remotePaths {
		normalized := normalizedRemotePath(remote)
		info, statErr := client.Lstat(normalized)
		if statErr != nil {
			s.finishFileTask(taskID, statErr)
			return
		}
		destination := target
		if batch || info.IsDir() {
			destination = filepath.Join(target, filepath.Base(normalized))
		}
		if err = collectRemoteTree(ctx, client, normalized, destination, info, &items); err != nil {
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
	filesToDownload, err := prepareRemoteDownloadFiles(items)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	defer cleanupRemoteDownloadFiles(filesToDownload)
	defer closeRemoteDownloadFiles(filesToDownload)
	sshClients, sftpClients = s.expandSFTPClients(
		ctx,
		connection,
		sshClients,
		sftpClients,
		remoteDownloadConnectionWanted(filesToDownload, s.configSnapshot().TaskChunkConcurrency),
	)
	if err := s.downloadRemoteFiles(ctx, sftpClients, filesToDownload, taskID); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	if err := ctx.Err(); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	if err := finalizeRemoteDownloadFiles(filesToDownload); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Completed, task.DoneFiles = fileTaskSuccess, "done", task.Total, task.Files
		task.Current = ""
	})
}

type remoteDownloadFile struct {
	remotePath string
	localPath  string
	size       int64
	temp       *os.File

	// 每个 SFTP 连接各自持有句柄，ReadAt 在同一连接内并发读取。
	remoteMu sync.Mutex
	remotes  map[*sftp.Client]*sftp.File

	segmentCount      int
	completedSegments atomic.Int32
}

type remoteDownloadSegment struct {
	file   *remoteDownloadFile
	offset int64
	length int
}

type remoteDownloadPacket struct {
	offset int64
	length int
}

func prepareRemoteDownloadFiles(items []remoteTreeItem) ([]*remoteDownloadFile, error) {
	for _, item := range items {
		if !item.info.IsDir() {
			continue
		}
		if err := os.MkdirAll(item.local, 0o755); err != nil {
			return nil, userErrorParamsCause("errors.sshFile.createDownloadDirectoryFailed", map[string]any{"path": item.local}, err)
		}
	}

	files := make([]*remoteDownloadFile, 0)
	for _, item := range items {
		if !item.info.Mode().IsRegular() {
			continue
		}
		parent := filepath.Dir(item.local)
		if err := os.MkdirAll(parent, 0o755); err != nil {
			cleanupRemoteDownloadFiles(files)
			return nil, userErrorParamsCause("errors.sshFile.createDownloadDirectoryFailed", map[string]any{"path": parent}, err)
		}
		temp, err := os.CreateTemp(parent, ".tinkerkit-download-*")
		if err != nil {
			cleanupRemoteDownloadFiles(files)
			return nil, userErrorParamsCause("errors.sshFile.createDownloadTempFileFailed", map[string]any{"path": item.local}, err)
		}
		file := &remoteDownloadFile{
			remotePath: item.remote,
			localPath:  item.local,
			size:       item.info.Size(),
			temp:       temp,
		}
		files = append(files, file)
		if err := temp.Truncate(file.size); err != nil {
			cleanupRemoteDownloadFiles(files)
			return nil, userErrorParamsCause("errors.sshFile.preallocateDownloadFileFailed", map[string]any{"path": item.local}, err)
		}
	}
	return files, nil
}

func cleanupRemoteDownloadFiles(files []*remoteDownloadFile) {
	for _, file := range files {
		if file.temp == nil {
			continue
		}
		tempPath := file.temp.Name()
		_ = file.temp.Close()
		_ = os.Remove(tempPath)
		file.temp = nil
	}
}

func (file *remoteDownloadFile) openRemote(client *sftp.Client) (*sftp.File, error) {
	file.remoteMu.Lock()
	defer file.remoteMu.Unlock()
	if file.remotes == nil {
		file.remotes = map[*sftp.Client]*sftp.File{}
	}
	if remote := file.remotes[client]; remote != nil {
		return remote, nil
	}
	remote, err := client.Open(file.remotePath)
	if err != nil {
		return nil, err
	}
	file.remotes[client] = remote
	return remote, nil
}

func (file *remoteDownloadFile) closeRemote() {
	file.remoteMu.Lock()
	remotes := file.remotes
	file.remotes = nil
	file.remoteMu.Unlock()
	for _, remote := range remotes {
		if remote != nil {
			_ = remote.Close()
		}
	}
}

func closeRemoteDownloadFiles(files []*remoteDownloadFile) {
	for _, file := range files {
		file.closeRemote()
	}
}

func finalizeRemoteDownloadFiles(files []*remoteDownloadFile) error {
	closeRemoteDownloadFiles(files)
	for _, file := range files {
		if file.temp == nil {
			continue
		}
		tempPath := file.temp.Name()
		if err := file.temp.Sync(); err != nil {
			return userErrorParamsCause("errors.sshFile.syncDownloadFileFailed", map[string]any{"path": file.localPath}, err)
		}
		if err := file.temp.Close(); err != nil {
			return userErrorParamsCause("errors.sshFile.closeDownloadFileFailed", map[string]any{"path": file.localPath}, err)
		}
		if err := os.Rename(tempPath, file.localPath); err != nil {
			return userErrorParamsCause("errors.sshFile.saveDownloadFileFailed", map[string]any{"path": file.localPath}, err)
		}
		file.temp = nil
	}
	return nil
}

func remoteDownloadSegments(files []*remoteDownloadFile) []remoteDownloadSegment {
	segments := make([]remoteDownloadSegment, 0)
	for _, file := range files {
		file.segmentCount = 0
		file.completedSegments.Store(0)
		for offset := int64(0); offset < file.size; {
			length := remoteDownloadSegmentSize
			if remaining := file.size - offset; remaining < length {
				length = remaining
			}
			segments = append(segments, remoteDownloadSegment{
				file:   file,
				offset: offset,
				length: int(length),
			})
			file.segmentCount++
			offset += length
		}
	}
	return segments
}

func downloadRemoteSegment(
	ctx context.Context,
	client *sftp.Client,
	segment remoteDownloadSegment,
	onProgress func(int64, bool),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if segment.length == 0 {
		if onProgress != nil {
			onProgress(0, true)
		}
		return nil
	}
	remote, err := segment.file.openRemote(client)
	if err != nil {
		return userErrorParamsCause("errors.sshFile.openRemoteFileFailed", map[string]any{"path": segment.file.remotePath}, err)
	}

	packetSize := int(remoteDownloadPacketSize)
	packetCount := (segment.length + packetSize - 1) / packetSize
	workerCount := remoteDownloadSFTPRequestCount
	if workerCount > packetCount {
		workerCount = packetCount
	}

	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan remoteDownloadPacket)
	var remaining atomic.Int64
	remaining.Store(int64(segment.length))

	var firstErr error
	var firstErrMu sync.Mutex
	setError := func(readErr error) {
		if readErr == nil {
			return
		}
		firstErrMu.Lock()
		if firstErr == nil {
			firstErr = readErr
			cancel()
		}
		firstErrMu.Unlock()
	}

	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			buffer := make([]byte, packetSize)
			for {
				select {
				case <-workCtx.Done():
					return
				case job, ok := <-jobs:
					if !ok {
						return
					}
					chunk := buffer[:job.length]
					read, readErr := remote.ReadAt(chunk, job.offset)
					if read != job.length {
						if readErr == nil || errors.Is(readErr, io.EOF) {
							readErr = io.ErrUnexpectedEOF
						}
						setError(userErrorParamsCause(
							"errors.sshFile.readRemoteFileSegmentFailed",
							map[string]any{
								"path":   segment.file.remotePath,
								"offset": job.offset,
								"length": job.length,
							},
							readErr,
						))
						return
					}
					if readErr != nil && !errors.Is(readErr, io.EOF) {
						setError(userErrorParamsCause("errors.sshFile.readRemoteFileFailed", map[string]any{"path": segment.file.remotePath}, readErr))
						return
					}
					if err := workCtx.Err(); err != nil {
						return
					}
					written, writeErr := segment.file.temp.WriteAt(chunk, job.offset)
					if writeErr != nil {
						setError(userErrorParamsCause("errors.sshFile.writeDownloadFileFailed", map[string]any{"path": segment.file.localPath}, writeErr))
						return
					}
					if written != job.length {
						setError(userErrorParamsCause("errors.sshFile.writeDownloadFileShort", map[string]any{"path": segment.file.localPath}, io.ErrShortWrite))
						return
					}
					left := remaining.Add(-int64(written))
					if onProgress != nil {
						onProgress(int64(written), left == 0)
					}
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		for offset := 0; offset < segment.length; {
			length := packetSize
			if left := segment.length - offset; left < length {
				length = left
			}
			select {
			case <-workCtx.Done():
				return
			case jobs <- remoteDownloadPacket{offset: segment.offset + int64(offset), length: length}:
				offset += length
			}
		}
	}()
	workers.Wait()

	firstErrMu.Lock()
	err = firstErr
	firstErrMu.Unlock()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if remaining.Load() != 0 {
		return userErrorParams("errors.sshFile.readRemoteFileSegmentIncomplete", map[string]any{"path": segment.file.remotePath})
	}
	return nil
}

func (s *FileService) downloadRemoteFiles(
	ctx context.Context,
	clients []*sftp.Client,
	files []*remoteDownloadFile,
	taskID string,
) error {
	if len(clients) == 0 {
		return userError("errors.sshFile.noAvailableSFTPConnection")
	}
	segments := remoteDownloadSegments(files)
	if err := ctx.Err(); err != nil {
		return err
	}

	var completed atomic.Int64
	var doneFiles atomic.Int32
	for _, file := range files {
		if file.segmentCount == 0 {
			doneFiles.Add(1)
		}
	}
	if len(segments) == 0 {
		return nil
	}

	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan remoteDownloadSegment)
	workerCount := len(clients)
	if workerCount > len(segments) {
		workerCount = len(segments)
	}

	var firstErr error
	var firstErrMu sync.Mutex
	setError := func(err error) {
		if err == nil {
			return
		}
		firstErrMu.Lock()
		if firstErr == nil {
			firstErr = err
			cancel()
		}
		firstErrMu.Unlock()
	}

	var currentFile atomic.Value
	currentFile.Store("")
	var progressMu sync.Mutex
	var lastProgress time.Time
	var progressTimer *time.Timer
	stopProgressTimer := func() {
		if progressTimer != nil {
			progressTimer.Stop()
			progressTimer = nil
		}
	}
	emitProgress := func() {
		if taskID == "" {
			return
		}
		current, _ := currentFile.Load().(string)
		total := completed.Load()
		done := int(doneFiles.Load())
		s.updateFileTask(taskID, func(task *fileTaskState) {
			if total > task.Completed {
				task.Completed = total
			}
			if done > task.DoneFiles {
				task.DoneFiles = done
			}
			if current != "" {
				task.Current = current
			}
		})
	}
	scheduleProgress := func() {
		if taskID == "" {
			return
		}
		progressMu.Lock()
		now := time.Now()
		if lastProgress.IsZero() || now.Sub(lastProgress) >= remoteDownloadProgressEmitInterval {
			lastProgress = now
			stopProgressTimer()
			progressMu.Unlock()
			emitProgress()
			return
		}
		if progressTimer == nil {
			delay := remoteDownloadProgressEmitInterval - now.Sub(lastProgress)
			progressTimer = time.AfterFunc(delay, func() {
				progressMu.Lock()
				lastProgress = time.Now()
				progressTimer = nil
				progressMu.Unlock()
				emitProgress()
			})
		}
		progressMu.Unlock()
	}
	defer func() {
		progressMu.Lock()
		stopProgressTimer()
		progressMu.Unlock()
		emitProgress()
	}()

	reportProgress := func(segment remoteDownloadSegment, written int64, segmentDone bool) {
		completed.Add(written)
		if segmentDone {
			if segment.file.completedSegments.Add(1) == int32(segment.file.segmentCount) {
				segment.file.closeRemote()
				doneFiles.Add(1)
			}
		}
		currentFile.Store(segment.file.remotePath)
		scheduleProgress()
	}

	var workers sync.WaitGroup
	workers.Add(workerCount)
	for _, client := range clients[:workerCount] {
		client := client
		go func() {
			defer workers.Done()
			for {
				select {
				case <-workCtx.Done():
					return
				case segment, ok := <-work:
					if !ok {
						return
					}
					err := downloadRemoteSegment(workCtx, client, segment, func(written int64, segmentDone bool) {
						reportProgress(segment, written, segmentDone)
					})
					if err != nil {
						setError(err)
						return
					}
				}
			}
		}()
	}

	go func() {
		defer close(work)
		for _, segment := range segments {
			select {
			case work <- segment:
			case <-workCtx.Done():
				return
			}
		}
	}()
	workers.Wait()

	firstErrMu.Lock()
	err := firstErr
	firstErrMu.Unlock()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}
