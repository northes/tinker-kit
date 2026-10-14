package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func (s *FileService) StartFileUpload(sourceID string, localPaths []string, remotePath string) (FileTaskSnapshot, error) {
	if len(localPaths) == 0 {
		return FileTaskSnapshot{}, userError("errors.sshFile.noUploadFilesSelected")
	}
	src, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return FileTaskSnapshot{}, err
	}
	remotePath = normalizedRemotePath(remotePath)
	for _, localPath := range localPaths {
		ctx, cancel := context.WithCancel(context.Background())
		id := s.createFileTask(
			FileTask{Type: fileTaskTypeUpload, SourceID: sourceID, Target: remotePath, Paths: []string{localPath}, Files: 1},
			ctx,
			cancel,
		)
		go s.runFileUpload(ctx, id, src, connection, []string{localPath}, remotePath)
	}
	return s.GetFileTasks(), nil
}

func (s *FileService) runFileUpload(ctx context.Context, taskID string, source FileSource, connection SSHConnection, localPaths []string, remoteRoot string) {
	if !s.acquireTaskSlot(ctx, taskID) {
		return
	}
	if s.taskScheduler != nil {
		defer s.taskScheduler.Release()
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage = fileTaskScanning, "scanningLocalFiles"
	})
	total, files, err := localTree(ctx, localPaths)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Total, task.Files = total, files
	})
	config := s.configSnapshot()
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Stage = "connecting" })
	sshClient, client, err := s.dialSFTPWithOptions(ctx, connection, remoteUploadSFTPOptions()...)
	if err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	sshClients, sftpClients := s.expandSFTPClients(
		ctx,
		connection,
		[]*ssh.Client{sshClient},
		[]*sftp.Client{client},
		config.TaskChunkConcurrency,
		remoteUploadSFTPOptions()...,
	)
	defer closeDownloadSFTPClients(sshClients, sftpClients)
	tuning := remoteUploadTransferTuning(config.TaskConcurrency, config.TaskChunkConcurrency)
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Stage = "creatingRemoteDirectory" })
	if err := client.MkdirAll(remoteRoot); err != nil {
		s.finishFileTask(taskID, err)
		return
	}
	s.updateFileTask(taskID, func(task *fileTaskState) { task.Status, task.Stage = fileTaskRunning, "uploading" })
	var done atomic.Int64
	var doneFiles atomic.Int32
	for _, localRoot := range localPaths {
		if err = s.uploadLocalPath(ctx, sftpClients, localRoot, remoteRoot, taskID, &done, &doneFiles, tuning); err != nil {
			s.finishFileTask(taskID, err)
			return
		}
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Status, task.Stage, task.Completed, task.DoneFiles = fileTaskSuccess, "done", done.Load(), int(doneFiles.Load())
		task.Current = ""
	})
}

func (s *FileService) uploadLocalPath(
	ctx context.Context,
	clients []*sftp.Client,
	localRoot, remoteRoot, taskID string,
	done *atomic.Int64,
	doneFiles *atomic.Int32,
	tuning uploadTransferTuning,
) error {
	if len(clients) == 0 {
		return userError("errors.sshFile.noAvailableSFTPConnection")
	}
	client := clients[0]
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
		files := make([]*localUploadFile, 0)
		if err := filepath.Walk(localRoot, func(localPath string, item os.FileInfo, walkErr error) error {
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
			files = append(files, &localUploadFile{localPath: localPath, remotePath: remote, size: item.Size()})
			return nil
		}); err != nil {
			return err
		}
		return s.uploadLocalFiles(ctx, clients, files, taskID, done, doneFiles, tuning)
	}
	return s.uploadLocalFiles(ctx, clients, []*localUploadFile{{localPath: localRoot, remotePath: base, size: info.Size()}}, taskID, done, doneFiles, tuning)
}

type localUploadFile struct {
	localPath       string
	remotePath      string
	remoteTemp      string
	size            int64
	segmentCount    int
	completedChunks atomic.Int32
}

type localUploadSegment struct {
	file   *localUploadFile
	offset int64
	length int64
}

func (s *FileService) uploadLocalFile(
	ctx context.Context,
	clients []*sftp.Client,
	localPath, remotePath, taskID string,
	done *atomic.Int64,
	doneFiles *atomic.Int32,
) error {
	info, err := os.Stat(localPath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	return s.uploadLocalFiles(
		ctx,
		clients,
		[]*localUploadFile{{localPath: localPath, remotePath: remotePath, size: info.Size()}},
		taskID,
		done,
		doneFiles,
		remoteUploadTransferTuning(4, 4),
	)
}

func (s *FileService) uploadLocalFiles(
	ctx context.Context,
	clients []*sftp.Client,
	files []*localUploadFile,
	taskID string,
	done *atomic.Int64,
	doneFiles *atomic.Int32,
	tuning uploadTransferTuning,
) error {
	if len(clients) == 0 {
		return userError("errors.sshFile.noAvailableSFTPConnection")
	}
	if len(files) == 0 {
		return nil
	}
	cleanupTemps := func() {
		for _, file := range files {
			if file.remoteTemp != "" {
				_ = clients[0].Remove(file.remoteTemp)
			}
		}
	}
	segments := make([]localUploadSegment, 0)
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			cleanupTemps()
			return err
		}
		file.remoteTemp = file.remotePath + ".tinkerkit-" + taskID + ".partial"
		initial, err := clients[0].OpenFile(file.remoteTemp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
		if err != nil {
			cleanupTemps()
			return err
		}
		if err := initial.Close(); err != nil {
			cleanupTemps()
			return err
		}
		for offset := int64(0); offset < file.size; offset += tuning.segmentSize {
			length := min(tuning.segmentSize, file.size-offset)
			segments = append(segments, localUploadSegment{file: file, offset: offset, length: length})
			file.segmentCount++
		}
		if file.segmentCount == 0 {
			segments = append(segments, localUploadSegment{file: file})
			file.segmentCount = 1
		}
	}

	workerCount := min(len(clients), len(segments))
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan localUploadSegment)
	var firstErr error
	var errMu sync.Mutex
	setError := func(value error) {
		if value == nil {
			return
		}
		errMu.Lock()
		if firstErr == nil {
			firstErr = value
			cancel()
		}
		errMu.Unlock()
	}
	var progressMu sync.Mutex
	lastProgress := time.Time{}
	report := func(current string) {
		progressMu.Lock()
		now := time.Now()
		if !lastProgress.IsZero() && now.Sub(lastProgress) < remoteDownloadProgressEmitInterval {
			progressMu.Unlock()
			return
		}
		lastProgress = now
		progressMu.Unlock()
		s.updateFileTask(taskID, func(task *fileTaskState) {
			task.Completed = done.Load()
			task.DoneFiles = int(doneFiles.Load())
			task.Current = current
		})
	}
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for _, transferClient := range clients[:workerCount] {
		transferClient := transferClient
		go func() {
			defer workers.Done()
			for segment := range work {
				if err := uploadLocalSegment(workCtx, transferClient, segment, tuning.writeSize, done, report); err != nil {
					setError(err)
					return
				}
				if segment.file.completedChunks.Add(1) == int32(segment.file.segmentCount) {
					if err := commitRemoteUpload(transferClient, segment.file.remoteTemp, segment.file.remotePath); err != nil {
						setError(err)
						return
					}
					doneFiles.Add(1)
					report(segment.file.localPath)
				}
			}
		}()
	}
	go func() {
		defer close(work)
		for _, segment := range segments {
			select {
			case <-workCtx.Done():
				return
			case work <- segment:
			}
		}
	}()
	workers.Wait()
	errMu.Lock()
	transferErr := firstErr
	errMu.Unlock()
	if transferErr != nil {
		cleanupTemps()
		return transferErr
	}
	if err := ctx.Err(); err != nil {
		cleanupTemps()
		return err
	}
	s.updateFileTask(taskID, func(task *fileTaskState) {
		task.Completed = done.Load()
		task.DoneFiles = int(doneFiles.Load())
	})
	return nil
}

func uploadLocalSegment(
	ctx context.Context,
	client *sftp.Client,
	segment localUploadSegment,
	writeSize int64,
	done *atomic.Int64,
	report func(string),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	input, err := os.Open(segment.file.localPath)
	if err != nil {
		return err
	}
	defer input.Close()
	remote, err := client.OpenFile(segment.file.remoteTemp, os.O_WRONLY)
	if err != nil {
		return err
	}
	defer remote.Close()
	buffer := make([]byte, int(writeSize))
	for offset := int64(0); offset < segment.length; {
		if err := ctx.Err(); err != nil {
			return err
		}
		length := min(int64(len(buffer)), segment.length-offset)
		chunk := buffer[:int(length)]
		read, readErr := input.ReadAt(chunk, segment.offset+offset)
		if read != len(chunk) {
			if readErr == nil || errors.Is(readErr, io.EOF) {
				readErr = io.ErrUnexpectedEOF
			}
			return readErr
		}
		written, writeErr := remote.WriteAt(chunk, segment.offset+offset)
		if writeErr != nil {
			return writeErr
		}
		if written != len(chunk) {
			return io.ErrShortWrite
		}
		done.Add(int64(written))
		offset += int64(written)
		report(segment.file.localPath)
	}
	return nil
}

func commitRemoteUpload(client *sftp.Client, remoteTemp, remotePath string) error {
	if err := client.PosixRename(remoteTemp, remotePath); err == nil {
		return nil
	}
	if _, statErr := client.Lstat(remotePath); statErr == nil {
		if removeErr := client.Remove(remotePath); removeErr != nil {
			return removeErr
		}
	}
	return client.Rename(remoteTemp, remotePath)
}
