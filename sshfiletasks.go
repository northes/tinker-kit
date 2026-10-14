package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

type FileTask struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"`
	SourceID  string   `json:"sourceID"`
	Status    string   `json:"status"`
	Stage     string   `json:"stage"`
	Current   string   `json:"current,omitempty"`
	Target    string   `json:"target,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	Batch     bool     `json:"batch,omitempty"`
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
	ctx                   context.Context
	cancel                context.CancelFunc
	operationPolicy       string
	connection            SSHConnection
	hasConnectionSnapshot bool
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

func (s *FileService) setFileTaskConnection(id string, connection SSHConnection) {
	s.taskMu.Lock()
	if task := s.tasks[id]; task != nil {
		task.connection = connection
		task.hasConnectionSnapshot = true
	}
	s.taskMu.Unlock()
}

func (s *FileService) fileTaskConnection(id string) (SSHConnection, bool) {
	s.taskMu.Lock()
	defer s.taskMu.Unlock()
	task := s.tasks[id]
	if task == nil || !task.hasConnectionSnapshot {
		return SSHConnection{}, false
	}
	return task.connection, true
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

// ClearFileTasks 移除所有已结束（非排队、扫描、运行或等待处理）的文件任务并返回最新快照。
func (s *FileService) ClearFileTasks() FileTaskSnapshot {
	s.taskMu.Lock()
	retained := s.taskOrder[:0]
	for _, id := range s.taskOrder {
		task := s.tasks[id]
		if task == nil {
			continue
		}
		if task.Status != fileTaskQueued && task.Status != fileTaskScanning && task.Status != fileTaskRunning && task.Status != fileTaskConflict {
			delete(s.tasks, id)
			s.taskRevision++
			continue
		}
		retained = append(retained, id)
	}
	s.taskOrder = retained
	snapshot := s.taskSnapshotLocked()
	s.taskMu.Unlock()
	s.emitTasks(snapshot)
	return snapshot
}

func (s *FileService) CancelFileTask(id string) error {
	var snapshot FileTaskSnapshot
	immediate := false
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return userError("errors.sshFile.taskNotFound")
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

// RetryFileTask 在失败或已取消的文件任务上复用原始参数，创建一个新的后台任务。
func (s *FileService) RetryFileTask(id string) (FileTaskSnapshot, error) {
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, userError("errors.sshFile.taskNotFound")
	}
	if task.Status != fileTaskFailed && task.Status != fileTaskCanceled {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, userError("errors.sshFile.taskNotRetryable")
	}
	previous := task.FileTask
	previous.Paths = append([]string(nil), task.Paths...)
	conflictPolicy := task.operationPolicy
	s.taskMu.Unlock()

	switch previous.Type {
	case fileTaskTypeUpload:
		if len(previous.Paths) != 1 {
			return FileTaskSnapshot{}, userError("errors.sshFile.taskNotRetryable")
		}
		return s.StartFileUpload(previous.SourceID, previous.Paths, previous.Target)
	case fileTaskTypeDownload:
		if len(previous.Paths) != 1 {
			return FileTaskSnapshot{}, userError("errors.sshFile.taskNotRetryable")
		}
		_, connection, err := s.sourceSnapshot(previous.SourceID)
		if err != nil {
			return FileTaskSnapshot{}, err
		}
		ctx, cancel := context.WithCancel(context.Background())
		newID := s.createFileTask(FileTask{
			Type: fileTaskTypeDownload, SourceID: previous.SourceID, Target: previous.Target,
			Paths: previous.Paths, Files: 1, Batch: previous.Batch,
		}, ctx, cancel)
		go s.runFileDownload(ctx, newID, connection, previous.Paths, previous.Target, previous.Batch)
		return s.GetFileTasks(), nil
	case remoteFileOperationCopy, remoteFileOperationMove, remoteFileOperationExtract, remoteFileOperationCompress:
		return s.StartRemoteFileOperation(previous.SourceID, previous.Type, previous.Paths, previous.Target, conflictPolicy)
	default:
		return FileTaskSnapshot{}, userError("errors.sshFile.taskNotRetryable")
	}
}

// OpenFileTaskFolder 在系统文件管理器中打开下载任务的目标目录。
func (s *FileService) OpenFileTaskFolder(id string) error {
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return userError("errors.sshFile.taskNotFound")
	}
	taskType := task.Type
	target := task.Target
	s.taskMu.Unlock()
	if taskType != fileTaskTypeDownload || target == "" {
		return userError("errors.sshFile.taskFolderUnavailable")
	}
	return openLocalFolder(target)
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
		return FileTaskSnapshot{}, userErrorParams("errors.sshFile.unsupportedBackgroundOperation", map[string]any{"operation": operation})
	}
	paths := normalizeRemotePaths(remotePaths)
	if len(paths) == 0 {
		return FileTaskSnapshot{}, userError("errors.sshFile.noRemoteItemsSelected")
	}
	if operation == remoteFileOperationCopy || operation == remoteFileOperationMove {
		switch strings.TrimSpace(conflictPolicy) {
		case "":
			conflictPolicy = remoteFileConflictAsk
		case remoteFileConflictAsk, remoteFileConflictOverwrite, remoteFileConflictKeepBoth:
		default:
			return FileTaskSnapshot{}, userErrorParams("errors.sshFile.unsupportedConflictPolicy", map[string]any{"policy": conflictPolicy})
		}
	} else {
		conflictPolicy = ""
	}
	target = normalizedRemotePath(target)
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
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
	s.setFileTaskConnection(id, connection)
	go s.runRemoteFileOperationTask(ctx, id)
	return s.GetFileTasks(), nil
}

// ResolveRemoteFileTask 为等待冲突处理的后台复制或移动任务选择处理方式。
func (s *FileService) ResolveRemoteFileTask(id, conflictPolicy string) (FileTaskSnapshot, error) {
	switch strings.TrimSpace(conflictPolicy) {
	case remoteFileConflictOverwrite, remoteFileConflictKeepBoth:
	default:
		return FileTaskSnapshot{}, userError("errors.sshFile.conflictUnresolved")
	}

	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, userError("errors.sshFile.taskNotFound")
	}
	if (task.Type != remoteFileOperationCopy && task.Type != remoteFileOperationMove) ||
		task.Status != fileTaskConflict {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, userError("errors.sshFile.taskNotAwaitingConflict")
	}
	if task.ctx == nil || task.cancel == nil || task.ctx.Err() != nil {
		s.taskMu.Unlock()
		return FileTaskSnapshot{}, userError("errors.sshFile.taskFinished")
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
	if !s.acquireTaskSlot(ctx, taskID) {
		return
	}
	if s.taskScheduler != nil {
		defer s.taskScheduler.Release()
	}
	sourceID, operation, paths, target, conflictPolicy, ok := s.remoteFileTaskInput(taskID)
	if !ok {
		return
	}
	connection, hasConnectionSnapshot := s.fileTaskConnection(taskID)
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
	result, err := s.operateRemoteFilesWithConnection(
		ctx,
		sourceID,
		operation,
		paths,
		target,
		conflictPolicy,
		connection,
		hasConnectionSnapshot,
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
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return FileTaskSnapshot{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	id := s.createFileTask(
		FileTask{Type: fileTaskTypeSize, SourceID: sourceID, Target: normalizedRemotePath(remotePath)},
		ctx,
		cancel,
	)
	go s.runSizeTask(ctx, id, connection, normalizedRemotePath(remotePath))
	return s.GetFileTasks(), nil
}

func (s *FileService) runSizeTask(ctx context.Context, taskID string, connection SSHConnection, remotePath string) {
	sshClient, client, err := s.dialSFTP(ctx, connection)
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
