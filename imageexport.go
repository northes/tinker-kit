package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const imageTasksEventName = "image-manager:tasks"

const imageTaskRetention = 24 * time.Hour

type ImageTask struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	SourceID  string `json:"sourceID"`
	ImageID   string `json:"imageID"`
	Status    string `json:"status"`
	Stage     string `json:"stage"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Bytes     int64  `json:"bytes"`
	Error     string `json:"error,omitempty"`
	Path      string `json:"path,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type ImageTaskSnapshot struct {
	Revision uint64      `json:"revision"`
	Tasks    []ImageTask `json:"tasks"`
}

type ImageExportResult struct {
	Started  int               `json:"started"`
	Snapshot ImageTaskSnapshot `json:"snapshot"`
}

const (
	imageTaskTypeExport = "export"
	imageTaskTypeUpdate = "update"
	imageTaskTypeDetail = "detail"
	imageTaskQueued     = "queued"
	imageTaskRunning    = "running"
	imageTaskSuccess    = "success"
	imageTaskFailed     = "failed"
	imageTaskCanceled   = "canceled"
)

type imageTaskState struct {
	ImageTask
	cancel          context.CancelFunc
	exclusiveTarget bool
}

func (s *ImageService) initImageTasks() {
	s.taskMu.Lock()
	defer s.taskMu.Unlock()
	if s.tasks == nil {
		s.tasks = make(map[string]*imageTaskState)
	}
}

func (s *ImageService) taskSnapshotLocked() ImageTaskSnapshot {
	s.pruneTasksLocked()
	result := ImageTaskSnapshot{Revision: s.taskRevision, Tasks: make([]ImageTask, 0, len(s.taskOrder))}
	for _, id := range s.taskOrder {
		if task := s.tasks[id]; task != nil {
			result.Tasks = append(result.Tasks, task.ImageTask)
		}
	}
	return result
}

func (s *ImageService) updateTask(id string, update func(*imageTaskState)) {
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return
	}
	update(task)
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	// 版本与状态在同一临界区提交，查询和事件才能使用同一版本判定新旧。
	s.taskRevision++
	snapshot := s.taskSnapshotLocked()
	s.taskMu.Unlock()
	s.emitEvent(imageTasksEventName, snapshot)
}

func (s *ImageService) pruneTasksLocked() {
	cutoff := time.Now().Add(-imageTaskRetention)
	retained := s.taskOrder[:0]
	for _, id := range s.taskOrder {
		task := s.tasks[id]
		if task == nil {
			continue
		}
		finished := task.Status != imageTaskQueued && task.Status != imageTaskRunning
		updatedAt, err := time.Parse(time.RFC3339Nano, task.UpdatedAt)
		if finished && err == nil && !updatedAt.After(cutoff) {
			delete(s.tasks, id)
			s.taskRevision++
			continue
		}
		retained = append(retained, id)
	}
	s.taskOrder = retained
}

func newTaskID() string {
	return fmt.Sprintf("image-task-%d", time.Now().UnixNano())
}

func exportFilename(imageID string) string {
	name := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "<", "_", ">", "_", "\"", "_", "|", "_", "?", "_", "*", "_").Replace(imageID)
	name = strings.Trim(name, " .")
	if name == "" {
		name = "image"
	}
	return name + ".tar"
}

func (s *ImageService) newImageTask(taskType, sourceID, imageID string) string {
	return s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: taskType, SourceID: sourceID, ImageID: imageID}})
}

func (s *ImageService) createImageTask(task imageTaskState) string {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	id := newTaskID()
	task.ID = id
	task.Status, task.Stage = imageTaskQueued, imageTaskQueued
	task.CreatedAt, task.UpdatedAt = now, now
	s.taskMu.Lock()
	if s.tasks == nil {
		s.tasks = make(map[string]*imageTaskState)
	}
	s.tasks[id] = &task
	s.taskOrder = append(s.taskOrder, id)
	s.taskRevision++
	snapshot := s.taskSnapshotLocked()
	s.taskMu.Unlock()
	s.emitEvent(imageTasksEventName, snapshot)
	return id
}

// GetImageTasks returns the current in-memory task list.
func (s *ImageService) GetImageTasks() ImageTaskSnapshot {
	s.taskMu.Lock()
	defer s.taskMu.Unlock()
	return s.taskSnapshotLocked()
}

// CancelImageTask cancels a queued or running export task.
func (s *ImageService) CancelImageTask(id string) error {
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return errors.New("任务不存在")
	}
	if task.Type != imageTaskTypeExport || (task.Status != imageTaskQueued && task.Status != imageTaskRunning) {
		s.taskMu.Unlock()
		return nil
	}
	if task.cancel != nil {
		task.cancel()
	}
	s.taskMu.Unlock()
	return nil
}

// RetryImageExport retries a failed export from the beginning using its original target path.
func (s *ImageService) RetryImageExport(id string) (ImageExportResult, error) {
	s.taskMu.Lock()
	task := s.tasks[id]
	if task == nil {
		s.taskMu.Unlock()
		return ImageExportResult{}, errors.New("任务不存在")
	}
	if task.Type != imageTaskTypeExport || task.Status != imageTaskFailed {
		s.taskMu.Unlock()
		return ImageExportResult{}, errors.New("任务不可重试")
	}
	sourceID, imageID, target, exclusive := task.SourceID, task.ImageID, task.Path, task.exclusiveTarget
	s.taskMu.Unlock()
	if sourceID == "" || imageID == "" || target == "" {
		return ImageExportResult{}, errors.New("导出任务信息不完整")
	}
	if _, _, _, err := s.sourceSnapshot(sourceID); err != nil {
		return ImageExportResult{}, err
	}

	s.exportQueueMu.Lock()
	defer s.exportQueueMu.Unlock()
	s.enqueueImageExport(sourceID, imageID, target, exclusive)
	return ImageExportResult{Started: 1, Snapshot: s.GetImageTasks()}, nil
}

// StartImageExport opens a native save dialog and starts an asynchronous export.
func (s *ImageService) StartImageExport(sourceID, imageID string) (ImageExportResult, error) {
	if strings.TrimSpace(imageID) == "" {
		return ImageExportResult{}, errors.New("镜像 ID 为空")
	}
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return ImageExportResult{}, errors.New("应用尚未初始化")
	}
	filename := exportFilename(imageID)
	dialog := app.Dialog.SaveFile().SetFilename(filename).CanCreateDirectories(true).AddFilter("Tar archive", "*.tar")
	if window := app.Window.Current(); window != nil {
		dialog.AttachToWindow(window)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return ImageExportResult{}, fmt.Errorf("选择保存路径: %w", err)
	}
	if path == "" {
		return ImageExportResult{}, nil
	}
	if filepath.Ext(strings.ToLower(path)) != ".tar" {
		path += ".tar"
	}
	s.exportQueueMu.Lock()
	defer s.exportQueueMu.Unlock()
	s.enqueueImageExport(sourceID, imageID, path, false)
	return ImageExportResult{Started: 1, Snapshot: s.GetImageTasks()}, nil
}

// StartImageExports 选择一次目录，为每个镜像创建独立导出任务。
func (s *ImageService) StartImageExports(sourceID string, imageIDs []string) (ImageExportResult, error) {
	ids := make([]string, 0, len(imageIDs))
	seen := make(map[string]bool)
	for _, id := range imageIDs {
		if strings.TrimSpace(id) == "" {
			return ImageExportResult{}, errors.New("镜像 ID 为空")
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return ImageExportResult{}, errors.New("未选择镜像")
	}
	if _, _, _, err := s.sourceSnapshot(sourceID); err != nil {
		return ImageExportResult{}, err
	}
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return ImageExportResult{}, errors.New("应用尚未初始化")
	}
	dialog := app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).CanCreateDirectories(true)
	if window := app.Window.Current(); window != nil {
		dialog.AttachToWindow(window)
	}
	directory, err := dialog.PromptForSingleSelection()
	if err != nil {
		return ImageExportResult{}, fmt.Errorf("选择保存目录: %w", err)
	}
	if directory == "" {
		return ImageExportResult{}, nil
	}
	return s.enqueueImageExports(sourceID, ids, directory)
}

func (s *ImageService) enqueueImageExports(sourceID string, ids []string, directory string) (ImageExportResult, error) {
	s.exportQueueMu.Lock()
	defer s.exportQueueMu.Unlock()
	reserved := make(map[string]bool)
	s.taskMu.Lock()
	for _, task := range s.tasks {
		if task.Status == imageTaskQueued || task.Status == imageTaskRunning {
			reserved[task.Path] = true
		}
	}
	s.taskMu.Unlock()
	paths, err := batchExportPaths(directory, ids, reserved)
	if err != nil {
		return ImageExportResult{}, err
	}
	for i, id := range ids {
		s.enqueueImageExport(sourceID, id, paths[i], true)
	}
	return ImageExportResult{Started: len(ids), Snapshot: s.GetImageTasks()}, nil
}

func batchExportPaths(directory string, ids []string, reserved map[string]bool) ([]string, error) {
	paths := make([]string, 0, len(ids))
	for _, id := range ids {
		filename := exportFilename(id)
		for suffix := 0; ; suffix++ {
			candidate := filename
			if suffix > 0 {
				candidate = fmt.Sprintf("%s (%d).tar", strings.TrimSuffix(filename, ".tar"), suffix)
			}
			path := filepath.Join(directory, candidate)
			if reserved[path] {
				continue
			}
			_, err := os.Lstat(path)
			if err == nil {
				continue
			}
			if !errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("检查导出路径失败: %w", err)
			}
			reserved[path] = true
			paths = append(paths, path)
			break
		}
	}
	return paths, nil
}

// 调用方持有 exportQueueMu，避免批量任务分配到相同目标路径。
func (s *ImageService) enqueueImageExport(sourceID, imageID, path string, exclusive bool) ImageTask {
	ctx, cancel := context.WithCancel(s.serviceContext())
	id := s.createImageTask(imageTaskState{
		ImageTask:       ImageTask{Type: imageTaskTypeExport, SourceID: sourceID, ImageID: imageID, Path: path},
		cancel:          cancel,
		exclusiveTarget: exclusive,
	})
	s.taskMu.Lock()
	result := s.tasks[id].ImageTask
	s.taskMu.Unlock()
	s.exportWG.Add(1)
	go func() {
		defer s.exportWG.Done()
		s.runImageExport(ctx, id, sourceID, imageID, path)
	}()
	return result
}

func (s *ImageService) commitImageExport(taskID, tmp, target string) error {
	info, err := os.Stat(tmp)
	if err != nil {
		return err
	}
	s.taskMu.Lock()
	task := s.tasks[taskID]
	exclusive := task != nil && task.exclusiveTarget
	s.taskMu.Unlock()
	if !exclusive {
		err = os.Rename(tmp, target)
	} else {
		// 批量导出不覆盖已有文件，包括下载过程中由外部程序创建的文件。
		err = os.Link(tmp, target)
		if err == nil {
			err = os.Remove(tmp)
		}
	}
	if err != nil {
		return err
	}
	s.updateTask(taskID, func(task *imageTaskState) {
		task.Bytes = info.Size()
		task.Total = info.Size()
		task.Completed = info.Size()
	})
	return nil
}

func (s *ImageService) runImageExport(ctx context.Context, taskID, sourceID, imageID, target string) {
	s.taskMu.Lock()
	if s.exportSem == nil {
		s.exportSem = make(chan struct{}, 2)
	}
	exportSem := s.exportSem
	s.taskMu.Unlock()
	select {
	case exportSem <- struct{}{}:
		defer func() { <-exportSem }()
	case <-ctx.Done():
		s.updateTask(taskID, func(task *imageTaskState) { task.Status = imageTaskCanceled; task.Stage = "canceled" })
		return
	}
	s.updateTask(taskID, func(task *imageTaskState) { task.Status = imageTaskRunning; task.Stage = "preparing" })
	source, cliPath, _, err := s.sourceSnapshot(sourceID)
	if err == nil {
		if source.Kind == "registry" {
			err = s.exportRegistryOCI(ctx, taskID, source, imageID, target)
			err = redactRegistryError(err, source)
		} else {
			err = s.exportDockerTar(ctx, taskID, source, cliPath, imageID, target)
		}
	}
	if errors.Is(err, context.Canceled) {
		s.updateTask(taskID, func(task *imageTaskState) { task.Status = imageTaskCanceled; task.Stage = "canceled"; task.Error = "" })
	} else if err != nil {
		s.updateTask(taskID, func(task *imageTaskState) {
			task.Status = imageTaskFailed
			task.Stage = "failed"
			task.Error = err.Error()
		})
	} else {
		s.updateTask(taskID, func(task *imageTaskState) {
			task.Status = imageTaskSuccess
			task.Stage = "done"
			task.Completed = task.Total
			task.Path = target
		})
	}
	s.taskMu.Lock()
	if task := s.tasks[taskID]; task != nil && task.cancel != nil {
		task.cancel = nil
	}
	s.taskMu.Unlock()
}

type progressWriter struct {
	w       io.Writer
	onWrite func(int64)
}

func (w progressWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if n > 0 && w.onWrite != nil {
		w.onWrite(int64(n))
	}
	return n, err
}

func (s *ImageService) exportDockerTar(ctx context.Context, taskID string, source ImageSource, cliPath, imageID, target string) error {
	tmp := target + ".devutils-" + taskID + ".partial"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("创建导出文件失败: %w", err)
	}
	defer f.Close()
	var progressMu sync.Mutex
	var pendingBytes int64
	lastProgress := time.Time{}
	onWrite := func(n int64) {
		progressMu.Lock()
		pendingBytes += n
		if !lastProgress.IsZero() && time.Since(lastProgress) < 150*time.Millisecond {
			progressMu.Unlock()
			return
		}
		delta := pendingBytes
		pendingBytes = 0
		lastProgress = time.Now()
		progressMu.Unlock()
		s.updateTask(taskID, func(task *imageTaskState) { task.Bytes += delta; task.Stage = "writing" })
	}
	err = s.streamDockerCommand(ctx, source, cliPath, []string{"image", "save", imageID}, progressWriter{w: f, onWrite: onWrite})
	progressMu.Lock()
	delta := pendingBytes
	pendingBytes = 0
	progressMu.Unlock()
	if delta > 0 {
		s.updateTask(taskID, func(task *imageTaskState) { task.Bytes += delta; task.Stage = "writing" })
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := s.commitImageExport(taskID, tmp, target); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("提交导出文件失败: %w", err)
	}
	return nil
}

func (s *ImageService) streamDockerCommand(ctx context.Context, source ImageSource, cliPath string, args []string, dst io.Writer) error {
	if source.Kind == "ssh" && (source.SSHPassword != "" || source.SSHPrivateKey != "" || source.SSHPrivateKeyPath != "") {
		return runAuthenticatedSSHStream(ctx, source, cliPath, dst, args...)
	}
	name, commandArgs, err := buildImageCommand(source, cliPath, args...)
	if err != nil {
		return err
	}
	cmd := execCommandContext(ctx, name, commandArgs...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	_, copyErr := io.Copy(dst, stdout)
	waitErr := cmd.Wait()
	if copyErr != nil {
		return copyErr
	}
	if waitErr != nil {
		if stderr.Len() > 0 {
			return fmt.Errorf("Docker 导出失败: %s", stderr.String())
		}
		return waitErr
	}
	return nil
}

// execCommandContext is a variable to make command streaming testable.
var execCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func (s *ImageService) exportRegistryOCI(ctx context.Context, taskID string, source ImageSource, imageID, target string) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	repositoryName, tag, digest, err := parseRegistryImageReference(imageID)
	if err != nil {
		return err
	}
	repository, err := registryRepository(source, repositoryName)
	if err != nil {
		return err
	}
	puller, err := remote.NewPuller(s.registryOptions(ctx, source)...)
	if err != nil {
		return err
	}
	var rootRef name.Reference = repository.Tag(tag)
	if digest != "" {
		rootRef = repository.Digest(digest)
	}
	root, err := puller.Get(ctx, rootRef)
	if err != nil {
		return fmt.Errorf("读取 Registry manifest 失败: %w", redactRegistryError(err, source))
	}
	rootDigest := root.Digest.String()
	if !canonicalSHA256Digest(rootDigest) {
		return errors.New("Registry 返回了无效 manifest digest")
	}
	if digest != "" && digest != rootDigest {
		return errors.New("Registry 返回的 manifest digest 与请求不一致")
	}
	objects := map[string]registryObject{}
	if err := s.collectRegistryObjects(ctx, puller, repository, root, objects); err != nil {
		return err
	}
	total := int64(0)
	keys := make([]string, 0, len(objects))
	for digest, object := range objects {
		total += object.size
		keys = append(keys, digest)
	}
	sort.Strings(keys)
	index := map[string]any{"schemaVersion": 2, "manifests": []map[string]any{{"mediaType": string(root.MediaType), "digest": rootDigest, "size": root.Size, "annotations": map[string]string{"org.opencontainers.image.ref.name": imageID}}}}
	indexData, err := json.Marshal(index)
	if err != nil {
		return err
	}
	indexData = append(indexData, '\n')
	ociData := []byte("{\"imageLayoutVersion\":\"1.0.0\"}\n")
	total += int64(len(ociData) + len(indexData))
	s.updateTask(taskID, func(task *imageTaskState) {
		task.Total = total
		task.Completed = 0
		task.Bytes = 0
		task.Stage = "writing"
	})
	tmp := target + ".devutils-" + taskID + ".partial"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() { f.Close(); os.Remove(tmp) }()
	tw := tar.NewWriter(f)
	var downloaded int64
	lastProgress := time.Time{}
	report := func(force bool) {
		if !force && time.Since(lastProgress) < 150*time.Millisecond {
			return
		}
		lastProgress = time.Now()
		s.updateTask(taskID, func(task *imageTaskState) { task.Completed = downloaded; task.Bytes = downloaded })
	}
	writeEntry := func(path string, size int64, reader io.Reader) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := tw.WriteHeader(&tar.Header{Name: path, Mode: 0o644, Size: size, ModTime: time.Unix(0, 0).UTC()}); err != nil {
			return err
		}
		n, err := io.Copy(progressWriter{w: tw, onWrite: func(n int64) { downloaded += n; report(false) }}, reader)
		report(true)
		if err != nil {
			return err
		}
		if n != size {
			return fmt.Errorf("Registry 对象大小不一致: %s，实际 %d，声明 %d", path, n, size)
		}
		return nil
	}
	if err := writeEntry("oci-layout", int64(len(ociData)), strings.NewReader(string(ociData))); err != nil {
		return err
	}
	if err := writeEntry("index.json", int64(len(indexData)), strings.NewReader(string(indexData))); err != nil {
		return err
	}
	for _, digest := range keys {
		object := objects[digest]
		path := "blobs/sha256/" + strings.TrimPrefix(digest, "sha256:")
		if object.data != nil {
			if err := writeEntry(path, object.size, strings.NewReader(string(object.data))); err != nil {
				return err
			}
			continue
		}
		// 先收集所有 manifest 中的大小；大 blob 直接流入 tar，不缓存在内存中。
		blobCtx := context.WithValue(ctx, registryBlobSizeKey{}, object.size)
		layer, err := puller.Layer(blobCtx, repository.Digest(digest))
		if err != nil {
			return err
		}
		reader, err := layer.Compressed()
		if err != nil {
			return err
		}
		hash := sha256.New()
		writeErr := writeEntry(path, object.size, io.TeeReader(reader, hash))
		closeErr := reader.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
		if hex.EncodeToString(hash.Sum(nil)) != strings.TrimPrefix(digest, "sha256:") {
			return fmt.Errorf("Registry blob digest 校验失败: %s", digest)
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.commitImageExport(taskID, tmp, target)
}

type registryObject struct {
	data []byte
	size int64
}

func (s *ImageService) collectRegistryObjects(ctx context.Context, puller *remote.Puller, repo name.Repository, descriptor *remote.Descriptor, objects map[string]registryObject) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	digest := descriptor.Digest.String()
	if object, ok := objects[digest]; ok && object.data != nil {
		return nil
	}
	raw, err := descriptor.RawManifest()
	if err != nil {
		return err
	}
	hash := sha256.Sum256(raw)
	if !canonicalSHA256Digest(digest) || hex.EncodeToString(hash[:]) != strings.TrimPrefix(digest, "sha256:") || int64(len(raw)) != descriptor.Size {
		return fmt.Errorf("Registry manifest digest 或大小校验失败: %s", digest)
	}
	objects[digest] = registryObject{data: raw, size: int64(len(raw))}
	var envelope struct {
		Config    v1.Descriptor   `json:"config"`
		Layers    []v1.Descriptor `json:"layers"`
		Manifests []v1.Descriptor `json:"manifests"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("解析 Registry manifest 失败: %w", err)
	}
	for _, child := range envelope.Manifests {
		childDesc, err := puller.Get(ctx, repo.Digest(child.Digest.String()))
		if err != nil {
			return err
		}
		if childDesc.Digest != child.Digest || childDesc.Size != child.Size {
			return errors.New("Registry 子 manifest 与索引声明不一致")
		}
		if err := s.collectRegistryObjects(ctx, puller, repo, childDesc, objects); err != nil {
			return err
		}
	}
	blobs := append([]v1.Descriptor(nil), envelope.Layers...)
	if envelope.Config.Digest.Hex != "" {
		blobs = append(blobs, envelope.Config)
	}
	for _, blob := range blobs {
		key := blob.Digest.String()
		if !canonicalSHA256Digest(key) || blob.Size < 0 || blob.Size == int64(^uint64(0)>>1) {
			return fmt.Errorf("Registry blob 描述无效: %s", key)
		}
		if previous, ok := objects[key]; ok {
			if previous.size != blob.Size {
				return fmt.Errorf("Registry 共享 blob 大小不一致: %s", key)
			}
			continue
		}
		objects[key] = registryObject{size: blob.Size}
	}
	return nil
}
