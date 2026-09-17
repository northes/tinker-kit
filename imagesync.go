package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// WatchDockerImagesEvent 是 image-manager:watch-docker-images 事件负载。
// 字段与前端 ImageManagerTool 中的 WatchDockerImagesEvent 契约一一对应：
// 每个事件经单一 committer 顺序分配自增 revision；generation 在每次新的
// Watch run 建立或来源 fingerprint 变化时自增，前端据此丢弃过期事件并重建列表。
type WatchDockerImagesEvent struct {
	ClientID   string         `json:"clientID"`
	SourceID   string         `json:"sourceID"`
	Generation uint64         `json:"generation,omitempty"`
	Revision   uint64         `json:"revision,omitempty"`
	Kind       string         `json:"kind,omitempty"`
	Images     []DockerImage  `json:"images,omitempty"`
	Image      *DockerImage   `json:"image,omitempty"`
	ImageID    string         `json:"imageID,omitempty"`
	ImageIDs   []string       `json:"imageIDs,omitempty"`
	Status     *DockerStatus  `json:"status,omitempty"`
	Progress   *WatchProgress `json:"progress,omitempty"`
	IsUpdating *bool          `json:"isUpdating,omitempty"`
	// IsInitialLoad 表示当前来源尚无完整缓存，本轮用于首次构建镜像详情。
	// false 表示已有完整缓存后的定时增量扫描。
	IsInitialLoad     *bool  `json:"isInitialLoad,omitempty"`
	HasSnapshot       *bool  `json:"hasSnapshot,omitempty"`
	SnapshotUpdatedAt string `json:"snapshotUpdatedAt,omitempty"`
	Error             string `json:"error,omitempty"`
}

// WatchProgress 是后台扫描进度，stage 取值见下方常量。
type WatchProgress struct {
	Scanned int    `json:"scanned"`
	Total   int    `json:"total"`
	Stage   string `json:"stage,omitempty"`
}

const (
	watchDockerImagesEventName = "image-manager:watch-docker-images"

	watchStageScanning = "scanning"
	watchStageDone     = "done"
	watchStageFailed   = "failed"

	watchEventKindSnapshot = "snapshot"
	watchEventKindCreate   = "create"
	watchEventKindUpdate   = "update"
	watchEventKindDelete   = "delete"

	watchInterRoundDelay = 2 * time.Minute
	watchScanMaxDocker   = 50
	watchScanMaxRegistry = maxRegistryRepositories

	// watchRegistryCallTimeout 是单个 registry 调用（catalog 页/tags 列表）的预算。
	watchRegistryCallTimeout = 30 * time.Second
)

// watchScan 是某 sourceID+fingerprint 的权威完整列表缓存。
type watchScan struct {
	index     map[string]DockerImage
	updatedAt time.Time
}

// watchWorker 持有单个 watch run 的全部运行状态。
// 每个 WatchDockerImages 调用建立且仅建立一个 worker；新调用替换旧 worker
// （取消并等待旧 done）后发布自身，保证任意时刻至多一个活跃 run。
type watchWorker struct {
	service       *ImageService
	clientID      string
	sourceID      string
	ctx           context.Context
	cancel        context.CancelFunc
	done          chan struct{}
	stopBound     func() bool
	generation    uint64
	fingerprint   string
	fingerprintMu sync.RWMutex

	// emitMu 是唯一事件提交锁：revision 分配与事件同步发送都在锁内完成，
	// 保证任何并发数据路径（diff、detail 补全 worker、状态）的事件顺序单调。
	emitMu      sync.Mutex
	revision    uint64
	taskID      string
	refresh     chan struct{}
	runMu       sync.Mutex
	running     bool
	roundCtx    context.Context
	roundCancel context.CancelFunc
}

func (w *watchWorker) stop() {
	if w.cancel != nil {
		w.cancel()
	}
	if w.done != nil {
		<-w.done
	}
}

func (w *watchWorker) releaseBound() {
	if w.stopBound != nil {
		w.stopBound()
		w.stopBound = nil
	}
}

func watchSnapshotKey(sourceID, fingerprint string) string {
	return sourceID + "\x00" + fingerprint
}

// watchPreviousSnapshot 返回当前 sourceID+fingerprint 的权威缓存。
func (s *ImageService) watchPreviousSnapshot(worker *watchWorker, fingerprint string) (map[string]DockerImage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watchSnapshots == nil {
		s.watchSnapshots = make(map[string]*watchScan)
	}
	scan := s.watchSnapshots[watchSnapshotKey(worker.sourceID, fingerprint)]
	if scan != nil {
		return scan.index, true
	}
	return nil, false
}

func (s *ImageService) watchSnapshotInfo(worker *watchWorker, fingerprint string) (map[string]DockerImage, bool, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watchSnapshots == nil {
		return nil, false, time.Time{}
	}
	scan := s.watchSnapshots[watchSnapshotKey(worker.sourceID, fingerprint)]
	if scan == nil {
		return nil, false, time.Time{}
	}
	return scan.index, true, scan.updatedAt
}

// removeWatchSnapshotImages 将用户已成功删除的镜像从运行期列表缓存中移除。
func (s *ImageService) removeWatchSnapshotImages(sourceID, fingerprint, value, repository string, registry bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	scan := s.watchSnapshots[watchSnapshotKey(sourceID, fingerprint)]
	if scan == nil {
		return
	}
	for id, image := range scan.index {
		remove := id == value
		if registry {
			remove = image.Digest == value && (repository == "" || image.Repository == repository)
		}
		if remove {
			delete(scan.index, id)
		}
	}
}

func (s *ImageService) dropStaleWatchSnapshots(sourceID, fingerprint string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := sourceID + "\x00"
	for key := range s.watchSnapshots {
		if strings.HasPrefix(key, prefix) && key != watchSnapshotKey(sourceID, fingerprint) {
			delete(s.watchSnapshots, key)
		}
	}
}

func (s *ImageService) storeWatchSnapshot(worker *watchWorker, fingerprint string, index map[string]DockerImage) time.Time {
	updatedAt := time.Now()
	s.mu.Lock()
	if s.watchSnapshots == nil {
		s.watchSnapshots = make(map[string]*watchScan)
	}
	s.watchSnapshots[watchSnapshotKey(worker.sourceID, fingerprint)] = &watchScan{index: index, updatedAt: updatedAt}
	s.mu.Unlock()
	return updatedAt
}

// requestSourceRefresh 让正在 watch 该来源的 worker 立刻重扫一轮，不要求 clientID。
// 用于后台任务（如 docker pull）完成后刷新列表：任务在后台异步执行，任务开始时
// 刷新拿到的仍是旧结果，必须在完成后重扫才能看到变化。
func (s *ImageService) requestSourceRefresh(sourceID string) {
	if s == nil || sourceID == "" {
		return
	}
	s.mu.Lock()
	worker := s.watchWorker
	s.mu.Unlock()
	if worker == nil || worker.sourceID != sourceID {
		return
	}
	select {
	case worker.refresh <- struct{}{}:
	default:
	}
}

// RefreshDockerImages 请求当前来源立即执行下一轮扫描。已有扫描不会被打断或并行。
func (s *ImageService) RefreshDockerImages(sourceID string, clientID string) error {
	if s == nil || sourceID == "" || clientID == "" {
		return errors.New("sourceID 与 clientID 不能为空")
	}
	s.mu.Lock()
	worker := s.watchWorker
	s.mu.Unlock()
	if worker == nil || worker.sourceID != sourceID || worker.clientID != clientID {
		return errors.New("镜像来源未处于活动状态")
	}
	// 扫描是单线程循环执行的：刷新请求写入带缓冲的 channel，当前轮结束后立刻再扫一轮，
	// 不会打断或并行。若扫描期间直接丢弃请求，用户点刷新会毫无反应，要等下一个定时轮。
	select {
	case worker.refresh <- struct{}{}:
	default:
	}
	return nil
}

func (w *watchWorker) setFingerprint(fingerprint string) bool {
	w.emitMu.Lock()
	defer w.emitMu.Unlock()
	w.fingerprintMu.Lock()
	defer w.fingerprintMu.Unlock()
	if w.fingerprint == fingerprint {
		return false
	}
	if w.fingerprint != "" {
		w.generation++
		w.revision = 0
	}
	w.fingerprint = fingerprint
	return true
}

func (w *watchWorker) currentFingerprint() string {
	w.fingerprintMu.RLock()
	fingerprint := w.fingerprint
	w.fingerprintMu.RUnlock()
	return fingerprint
}

func watchImagesFromIndex(index map[string]DockerImage) []DockerImage {
	images := make([]DockerImage, 0, len(index))
	for _, image := range index {
		images = append(images, image)
	}
	sort.Slice(images, func(i, j int) bool { return images[i].ID < images[j].ID })
	return images
}

// startWatchRun 取消并等待旧 run 退出，随后完整初始化并发布新 worker。
// 调用方随后启动 watchLoop 并阻塞直到 ctx 取消或 run 结束。
func (s *ImageService) startWatchRun(ctx context.Context, clientID, sourceID string) (*watchWorker, error) {
	if s == nil {
		return nil, errors.New("镜像服务未配置")
	}
	if ctx == nil {
		return nil, errors.New("无效的调用上下文")
	}
	s.watchStartMu.Lock()
	defer s.watchStartMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	old := s.watchWorker
	s.mu.Unlock()
	if old != nil {
		// 发布前取消并等待旧 run 完全退出，保证任意时刻至多一个活跃 run。
		old.stop()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	runCtx, runCancel := context.WithCancel(s.serviceContext())
	worker := &watchWorker{
		service:   s,
		clientID:  clientID,
		sourceID:  sourceID,
		ctx:       runCtx,
		cancel:    runCancel,
		done:      make(chan struct{}),
		stopBound: context.AfterFunc(ctx, runCancel),
		refresh:   make(chan struct{}, 1),
	}
	if err := runCtx.Err(); err != nil {
		worker.releaseBound()
		close(worker.done)
		return nil, err
	}
	s.mu.Lock()
	s.watchGeneration++
	worker.generation = s.watchGeneration
	s.watchWorker = worker
	s.mu.Unlock()
	return worker, nil
}

// stopWatch 由 shutdown 调用，摘除并等待当前 run 退出。
func (s *ImageService) stopWatch() {
	s.mu.Lock()
	worker := s.watchWorker
	s.watchWorker = nil
	s.mu.Unlock()
	if worker != nil {
		worker.stop()
	}
}

// WatchDockerImages 是长生命周期、可取消的 Wails 绑定方法。
// 阻塞直到调用方 ctx 取消或本 run 被替换/服务关闭；返回 nil 表示正常结束。
func (s *ImageService) WatchDockerImages(ctx context.Context, sourceID string, clientID string) error {
	if s == nil {
		return errors.New("镜像服务未配置")
	}
	if sourceID == "" || clientID == "" {
		return errors.New("sourceID 与 clientID 不能为空")
	}
	if err := ctx.Err(); err != nil {
		return nil
	}
	worker, err := s.startWatchRun(ctx, clientID, sourceID)
	if err != nil {
		return nil
	}
	go s.watchLoop(worker)
	select {
	case <-ctx.Done():
		// 调用方取消：若本 run 仍是当前 run 则等待其退出。
		s.mu.Lock()
		current := s.watchWorker
		s.mu.Unlock()
		if current == worker {
			worker.stop()
		}
		return nil
	case <-worker.done:
		return nil
	}
}

// watchLoop 是非重入循环：按固定 2 分钟 tick 触发扫描；扫描期间到达的
// tick 在本轮结束后丢弃，保证慢扫描不会与下一轮重叠。
func (s *ImageService) watchLoop(worker *watchWorker) {
	defer worker.releaseBound()
	defer close(worker.done)
	s.logWatch(worker, "watch 循环启动")
	nextTick := time.Now().Add(watchInterRoundDelay)
	s.runWatchRound(worker)
	now := time.Now()
	for !nextTick.After(now) {
		nextTick = nextTick.Add(watchInterRoundDelay)
	}
	timer := time.NewTimer(time.Until(nextTick))
	defer timer.Stop()
	for {
		if err := worker.ctx.Err(); err != nil {
			return
		}
		select {
		case <-worker.ctx.Done():
			return
		case <-timer.C:
			// 定时 tick 与手动刷新同时就绪时只执行一轮，避免重复扫描。
			select {
			case <-worker.refresh:
			default:
			}
			s.runWatchRound(worker)
			// 本轮执行期间错过的所有 tick 都跳过，只等待下一个
			// 固定时间点，而不是在本轮完成后重新计算 2 分钟。
			now := time.Now()
			for !nextTick.After(now) {
				nextTick = nextTick.Add(watchInterRoundDelay)
			}
			timer.Reset(time.Until(nextTick))
		case <-worker.refresh:
			s.runWatchRound(worker)
			now := time.Now()
			for !nextTick.After(now) {
				nextTick = nextTick.Add(watchInterRoundDelay)
			}
			timer.Reset(time.Until(nextTick))
		}
	}
}

// runWatchRound 执行一轮扫描与 diff。CLI/status 操作都从 worker.ctx 派生并带 timeout。
func (s *ImageService) runWatchRound(worker *watchWorker) {
	if worker == nil {
		return
	}
	worker.runMu.Lock()
	if worker.running {
		worker.runMu.Unlock()
		return
	}
	roundCtx, roundCancel := context.WithCancel(worker.ctx)
	worker.running = true
	worker.roundCtx = roundCtx
	worker.roundCancel = roundCancel
	worker.runMu.Unlock()
	defer func() {
		roundCancel()
		worker.runMu.Lock()
		worker.running = false
		worker.roundCtx = nil
		worker.roundCancel = nil
		worker.runMu.Unlock()
	}()
	s.watchMutationMu.RLock()
	defer s.watchMutationMu.RUnlock()
	if s.watchSourceDeleting(worker.sourceID) || roundCtx.Err() != nil {
		return
	}
	taskID := s.newImageTask(imageTaskTypeUpdate, worker.sourceID, "")
	worker.taskID = taskID
	s.updateTask(taskID, func(task *imageTaskState) { task.Status = imageTaskRunning; task.Stage = "scanning" })
	finishTask := func(err error) {
		if errors.Is(err, context.Canceled) || worker.ctx.Err() != nil || roundCtx.Err() != nil {
			s.updateTask(taskID, func(task *imageTaskState) { task.Status = imageTaskCanceled; task.Stage = "canceled" })
		} else if err != nil {
			s.updateTask(taskID, func(task *imageTaskState) {
				task.Status = imageTaskFailed
				task.Stage = "failed"
				task.Error = err.Error()
			})
		} else {
			s.updateTask(taskID, func(task *imageTaskState) { task.Status = imageTaskSuccess; task.Stage = "done" })
		}
	}
	source, cliPath, fingerprint, err := s.sourceSnapshot(worker.sourceID)
	fingerprintChanged := false
	if err == nil {
		fingerprintChanged = worker.setFingerprint(fingerprint)
		s.dropStaleWatchSnapshots(worker.sourceID, fingerprint)
	}
	// 先恢复本运行期缓存。缓存事件必须早于连接探测，以便页面立即可用。
	previous, hasPrevious, snapshotUpdatedAt := s.watchSnapshotInfo(worker, fingerprint)
	restoreCached := func() {
		if !hasPrevious {
			return
		}
		cached := true
		event := s.watchSnapshotEvent(worker, watchImagesFromIndex(previous))
		event.HasSnapshot = &cached
		event.SnapshotUpdatedAt = snapshotUpdatedAt.Format(time.RFC3339Nano)
		s.emitWatchEvent(worker, event)
	}
	clearUncached := func() {
		if hasPrevious {
			return
		}
		s.emitWatchEvent(worker, s.watchSnapshotEvent(worker, nil))
	}
	if hasPrevious {
		cached := true
		cachedEvent := s.watchSnapshotEvent(worker, watchImagesFromIndex(previous))
		cachedEvent.HasSnapshot = &cached
		cachedEvent.SnapshotUpdatedAt = snapshotUpdatedAt.Format(time.RFC3339Nano)
		s.emitWatchEvent(worker, cachedEvent)
	}
	status := DockerStatus{CLIPath: cliPath}
	if err == nil {
		status = s.sourceConnectionStatusContext(roundCtx, source, cliPath)
	}
	_, hasCompleteSnapshot := s.watchPreviousSnapshot(worker, fingerprint)
	s.emitWatchEvent(worker, s.watchScanningEvent(worker, &status, !hasCompleteSnapshot))
	if err != nil {
		finishTask(err)
		s.failWatchRound(worker, err)
		return
	}
	if roundCtx.Err() != nil || s.watchSourceDeleting(worker.sourceID) {
		finishTask(roundCtx.Err())
		return
	}
	if !status.Available {
		statusErr := status.Error
		if statusErr == "" {
			statusErr = "镜像来源不可用"
		}
		statusErrValue := errors.New(statusErr)
		finishTask(statusErrValue)
		s.failWatchRound(worker, statusErrValue)
		return
	}
	// 来源配置变化时，使用当前指纹的缓存重置本地列表；缓存仍不代表连接成功。
	if fingerprintChanged && source.Kind != "registry" {
		cached := previous
		s.emitWatchEvent(worker, s.watchSnapshotEvent(worker, watchImagesFromIndex(cached)))
	}
	ctx, cancel := context.WithCancel(roundCtx)
	defer cancel()
	var images []DockerImage
	var index map[string]DockerImage
	doneScanned, doneTotal := 0, 0
	if source.Kind == "registry" {
		prev, _ := s.watchPreviousSnapshot(worker, fingerprint)
		result, scanErr := s.scanRegistryFlow(ctx, worker, source, prev, !hasPrevious)
		if scanErr != nil {
			finishTask(scanErr)
			s.failWatchRound(worker, scanErr)
			restoreCached()
			clearUncached()
			return
		}
		images = result.images
		index = result.index
		doneScanned = result.completedCount
		doneTotal = result.totalCount
	} else {
		images, err = s.scanDockerSource(ctx, worker, source, cliPath, !hasPrevious)
		if err != nil {
			finishTask(err)
			s.failWatchRound(worker, err)
			restoreCached()
			clearUncached()
			return
		}
		images = s.stabilizeWatchImages(worker, fingerprint, images)
		index = indexImages(images)
		doneScanned = len(images)
		doneTotal = len(images)
		// 同一 generation 内做精准 diff，generation 变化时发 snapshot。
		s.diffWatchRound(worker, fingerprint, images)
	}
	if roundCtx.Err() != nil {
		finishTask(roundCtx.Err())
		return
	}
	if !s.sourceFingerprintCurrent(worker.sourceID, fingerprint) {
		finishTask(context.Canceled)
		return
	}
	// 扫描成功才更新权威缓存与 inventory（供详情缓存 Name/Tags 补充）。
	updatedAt := s.storeWatchSnapshot(worker, fingerprint, index)
	s.updateImageInventory(worker.sourceID, fingerprint, source, images)
	if roundCtx.Err() != nil {
		finishTask(roundCtx.Err())
		return
	}
	doneEvent := s.watchStateEvent(worker, watchStageDone, doneScanned, doneTotal, "")
	doneEvent.Status = &status
	hasSnapshot := true
	doneEvent.HasSnapshot = &hasSnapshot
	doneEvent.SnapshotUpdatedAt = updatedAt.Format(time.RFC3339Nano)
	s.emitWatchEvent(worker, doneEvent)
	finishTask(nil)
}

// stabilizeWatchImages 在 tag 集合未变时沿用上一轮的 Name 与 tag 顺序。
// docker image ls 对同一镜像多个 tag 的返回顺序不稳定，若直接采用本轮顺序，
// 每轮的展示名会在 tag 间来回切换，刷新时看起来像“项目被替换”。
func (s *ImageService) stabilizeWatchImages(worker *watchWorker, fingerprint string, images []DockerImage) []DockerImage {
	previous, ok := s.watchPreviousSnapshot(worker, fingerprint)
	if !ok {
		return images
	}
	for index := range images {
		prev, exists := previous[images[index].ID]
		if !exists || !stringSetsEqual(prev.Tags, images[index].Tags) {
			continue
		}
		images[index].Name = prev.Name
		images[index].Tags = prev.Tags
	}
	return images
}

// diffWatchRound 计算上一轮与本轮差异并推送精准事件（Docker/SSH 源）。
func (s *ImageService) diffWatchRound(worker *watchWorker, fingerprint string, images []DockerImage) {
	previous, hasPrevious := s.watchPreviousSnapshot(worker, fingerprint)
	current := indexImages(images)
	var events []WatchDockerImagesEvent
	if hasPrevious {
		for id, old := range previous {
			if _, ok := current[id]; !ok {
				events = append(events, s.watchDeleteEvent(worker, id))
			} else if !dockerImagesEqual(old, current[id]) {
				image := current[id]
				events = append(events, s.watchImageEvent(worker, watchEventKindUpdate, &image))
			}
		}
		for id, image := range current {
			if _, ok := previous[id]; !ok {
				events = append(events, s.watchImageEvent(worker, watchEventKindCreate, &image))
			}
		}
	} else {
		events = append(events, s.watchSnapshotEvent(worker, images))
	}
	for _, event := range events {
		s.emitWatchEvent(worker, event)
	}
}

// scanWatchSource 分别扫描 Docker 与 Registry 来源。
func (s *ImageService) scanWatchSource(ctx context.Context, worker *watchWorker, source ImageSource, cliPath string) ([]DockerImage, error) {
	if source.Kind == "registry" {
		return nil, errors.New("registry 来源走 scanRegistryFlow")
	}
	return s.scanDockerSource(ctx, worker, source, cliPath, false)
}

// scanDockerSource 通过 Docker CLI 查询本地/SSH 镜像。首次扫描会先逐条发布
// image ls 的基础行，再并发补全 inspect 详情并发布精准 update。
func (s *ImageService) scanDockerSource(ctx context.Context, worker *watchWorker, source ImageSource, cliPath string, emitInitialRows bool) ([]DockerImage, error) {
	commandCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	output, err := s.runDockerSnapshotContext(commandCtx, source, cliPath, []string{"image", "ls", "--no-trunc", "--format", "{{json .}}"})
	if err != nil {
		return nil, redactImageError(err, source)
	}
	items := make([]dockerImageListJSON, 0)
	uniqueIDs := make(map[string]bool)
	for _, rawLine := range strings.Split(string(output), "\n") {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		var item dockerImageListJSON
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			return nil, fmt.Errorf("解析 Docker 镜像列表失败: %w", err)
		}
		items = append(items, item)
		uniqueIDs[item.ID] = true
	}
	total := len(uniqueIDs)
	byID := make(map[string]int, total)
	images := make([]DockerImage, 0, watchScanMaxDocker)
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := item.Repository
		if item.Tag != "" {
			name += ":" + item.Tag
		}
		if index, ok := byID[item.ID]; ok {
			if name != "" && !containsString(images[index].Tags, name) {
				images[index].Tags = append(images[index].Tags, name)
			}
			continue
		}
		byID[item.ID] = len(images)
		image := DockerImage{ID: item.ID, Name: name, Tags: []string{name}, Size: item.Size, SizeBytes: parseDockerImageSize(item.Size), CreatedAt: item.CreatedAt}
		images = append(images, image)
		if emitInitialRows {
			row := image
			s.emitWatchEvent(worker, s.watchImageEvent(worker, watchEventKindCreate, &row))
		}
	}
	// image ls 已完整返回，此时总数确定；后续 scanned 只统计已完成的 inspect。
	s.emitWatchEvent(worker, s.watchProgressEvent(worker, 0, total))
	s.enrichDockerWatchImages(ctx, worker, source, cliPath, images, total)
	sort.Slice(images, func(i, j int) bool { return images[i].ID < images[j].ID })
	return images, nil
}

// enrichDockerWatchImages 并发预热 Docker inspect 缓存；每条详情返回后立即
// 推送 update，前端无需等待整批详情完成再刷新列表。
func (s *ImageService) enrichDockerWatchImages(ctx context.Context, worker *watchWorker, source ImageSource, cliPath string, images []DockerImage, total int) {
	if len(images) == 0 {
		return
	}
	var wg sync.WaitGroup
	var imagesMu sync.Mutex
	var progressMu sync.Mutex
	inspected := 0
	reportProgress := func() {
		progressMu.Lock()
		defer progressMu.Unlock()
		inspected++
		s.emitWatchEvent(worker, s.watchProgressEvent(worker, inspected, total))
	}
	jobs := make(chan int)
	workers := min(len(images), imageDetailConcurrency)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				base := images[index]
				detail, err := s.inspectWithGeneration(worker.sourceID, source, cliPath, worker.currentFingerprint(), base.ID, "", ctx, imageDetailBackground, 0)
				if err != nil {
					if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
						s.logWatch(worker, "镜像详情加载失败 image="+base.ID+": "+redactImageError(err, source).Error())
					}
					if ctx.Err() == nil {
						reportProgress()
					}
					continue
				}
				updated := dockerImageFromDetail(base, detail)
				imagesMu.Lock()
				images[index] = updated
				imagesMu.Unlock()
				if !dockerImagesEqual(base, updated) {
					eventImage := updated
					s.emitWatchEvent(worker, s.watchImageEvent(worker, watchEventKindUpdate, &eventImage))
				}
				reportProgress()
			}
		}()
	}
	for index := range images {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return
		case jobs <- index:
		}
	}
	close(jobs)
	wg.Wait()
}

func dockerImageFromDetail(base DockerImage, detail DockerImageDetail) DockerImage {
	updated := base
	// docker image ls 的 Name/Tags 才是 Docker/SSH 来源的权威值；详情缓存里的
	// Name/Tags 来自上一轮 inventory，重命名或新增 tag 后会是旧值，若覆盖新结果
	// 会让 diff 误判为“没有变化”，列表也就不刷新。仅在缺失时用详情补充。
	if updated.Name == "" && detail.Name != "" {
		updated.Name = detail.Name
	}
	if len(updated.Tags) == 0 && len(detail.Tags) > 0 {
		updated.Tags = append([]string(nil), detail.Tags...)
	}
	if detail.Size > 0 {
		updated.SizeBytes = detail.Size
	}
	if detail.CreatedAt != "" {
		updated.CreatedAt = detail.CreatedAt
	}
	return updated
}

// watchRegistryResult 是一轮 registry 流式扫描的结果。
type watchRegistryResult struct {
	index          map[string]DockerImage
	images         []DockerImage
	completedCount int
	totalCount     int
}

// scanRegistryFlow 流式处理 catalog/repo/tags，并保持详情补全与 catalog 并发流水：
//   - repo tags 成功后立即对 base 对象做精确 create/tag-delete 并更新 cur；
//   - 详情补全走独立 worker 池（imageDetailConcurrency），只在实际变化时 emit update；
//     detail 失败保留历史元数据（用 prev 覆盖，避免退化覆盖 digest）；
//   - repo 级 delete 只在 catalog 完整成功（无截断、无错误）后执行；
//   - 任何截断/异常整体返回错误，禁止一切 delete。
func (s *ImageService) scanRegistryFlow(ctx context.Context, worker *watchWorker, source ImageSource, prev map[string]DockerImage, bootstrap bool) (*watchRegistryResult, error) {
	registry, err := registryEndpoint(source)
	if err != nil {
		return nil, err
	}
	options := s.registryOptions(ctx, source)
	puller, err := remote.NewPuller(options...)
	if err != nil {
		return nil, fmt.Errorf("创建 Registry 客户端失败: %w", redactRegistryError(err, source))
	}
	cur := make(map[string]DockerImage)
	catalogRepos := make(map[string]bool)
	pendingDeletes := make([]string, 0)
	var mu sync.Mutex
	scanCtx, cancelScan := context.WithCancel(ctx)
	defer cancelScan()
	jobs := make(chan DockerImage, imageDetailConcurrency*4)
	var detailWG sync.WaitGroup
	var progressMu sync.Mutex
	completedDetails := 0
	totalTags := 0
	reportProgress := func(completedDelta, totalDelta int) {
		progressMu.Lock()
		completedDetails += completedDelta
		totalTags += totalDelta
		completed, total := completedDetails, totalTags
		progressMu.Unlock()
		s.emitWatchEvent(worker, s.watchProgressEvent(worker, completed, total))
	}
	reportTagProgress := func(count int) { reportProgress(0, count) }
	reportDetailProgress := func() { reportProgress(1, 0) }
	for i := 0; i < imageDetailConcurrency; i++ {
		detailWG.Add(1)
		go func() {
			defer detailWG.Done()
			for base := range jobs {
				s.registryDetailWorker(scanCtx, worker, source, puller, prev, base, cur, &mu, bootstrap, reportDetailProgress)
			}
		}()
	}
	repoJobs := make(chan string, imageDetailConcurrency*2)
	var repoWG sync.WaitGroup
	var scanErrMu sync.Mutex
	var firstScanErr error
	setScanErr := func(err error) {
		if err == nil {
			return
		}
		scanErrMu.Lock()
		if firstScanErr == nil {
			firstScanErr = err
			cancelScan()
		}
		scanErrMu.Unlock()
	}
	getScanErr := func() error {
		scanErrMu.Lock()
		defer scanErrMu.Unlock()
		return firstScanErr
	}
	for i := 0; i < registryConcurrency; i++ {
		repoWG.Add(1)
		go func() {
			defer repoWG.Done()
			for repositoryName := range repoJobs {
				if scanCtx.Err() != nil {
					return
				}
				repo, repoErr := registryRepository(source, repositoryName)
				if repoErr != nil {
					continue
				}
				callCtx, callCancel := context.WithTimeout(scanCtx, watchRegistryCallTimeout)
				tags, tagsErr := puller.List(callCtx, repo)
				callCancel()
				if tagsErr != nil {
					setScanErr(fmt.Errorf("枚举 Registry 仓库 %q 的标签失败: %w", repositoryName, redactRegistryError(tagsErr, source)))
					return
				}
				if len(tags) > maxRegistryTags {
					setScanErr(fmt.Errorf("Registry 仓库 %q 的标签数量超过限制，扫描非权威", repositoryName))
					return
				}
				mu.Lock()
				catalogRepos[repositoryName] = true
				mu.Unlock()
				s.commitRegistryRepo(scanCtx, worker, jobs, repositoryName, tags, prev, cur, &mu, &pendingDeletes, bootstrap, reportTagProgress)
				if scanCtx.Err() != nil {
					return
				}
			}
		}()
	}
	scanErr := func() error {
		const pageSize = 100
		last := ""
		discovered := 0
		for {
			if discovered >= watchScanMaxRegistry {
				probe, probeErr := s.registryCatalogPage(scanCtx, registry, last, 1, options)
				if probeErr != nil {
					return fmt.Errorf("确认 Registry 仓库目录是否结束失败: %w", redactRegistryError(probeErr, source))
				}
				if len(probe) > 0 {
					return errors.New("Registry 仓库数量达到 watch 上限，目录截断")
				}
				return nil
			}
			page, err := s.registryCatalogPage(scanCtx, registry, last, pageSize, options)
			if err != nil {
				return fmt.Errorf("枚举 Registry 仓库失败: %w", redactRegistryError(err, source))
			}
			if len(page) == 0 {
				return nil
			}
			if len(page) > pageSize {
				return errors.New("Registry 目录页异常，扫描非权威")
			}
			discovered += len(page)
			for _, repositoryName := range page {
				select {
				case <-scanCtx.Done():
					return scanCtx.Err()
				case repoJobs <- repositoryName:
				}
			}
			if len(page) < pageSize {
				return nil
			}
			next := page[len(page)-1]
			if next == last {
				return errors.New("Registry 仓库目录分页未前进，扫描非权威")
			}
			last = next
		}
	}()
	close(repoJobs)
	repoWG.Wait()
	if err := getScanErr(); err != nil {
		scanErr = err
	}
	close(jobs)
	detailWG.Wait()
	if scanErr != nil {
		return nil, scanErr
	}
	// catalog 与所有 tags 均成功后，才提交本轮积累的删除。
	mu.Lock()
	for id, img := range prev {
		if !catalogRepos[img.Repository] {
			pendingDeletes = append(pendingDeletes, id)
		}
	}
	mu.Unlock()
	for _, id := range pendingDeletes {
		s.emitWatchEvent(worker, s.watchDeleteEvent(worker, id))
	}
	// detail 补全失败的条目保留历史元数据（prev 覆盖 base），防止 digest 退化。
	mu.Lock()
	for id, img := range cur {
		if img.Digest == "" {
			if previous, ok := prev[id]; ok {
				cur[id] = previous
			}
		}
	}
	result := make([]DockerImage, 0, len(cur))
	for _, image := range cur {
		result = append(result, image)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	mu.Unlock()
	progressMu.Lock()
	completed, total := completedDetails, totalTags
	progressMu.Unlock()
	return &watchRegistryResult{index: cur, images: result, completedCount: completed, totalCount: total}, nil
}

// registryCatalogPage 对单次 catalog 分页调用设 timeout。
func (s *ImageService) registryCatalogPage(ctx context.Context, registry name.Registry, last string, pageSize int, options []remote.Option) ([]string, error) {
	callCtx, cancel := context.WithTimeout(ctx, watchRegistryCallTimeout)
	defer cancel()
	callOptions := make([]remote.Option, 0, len(options)+1)
	callOptions = append(callOptions, options...)
	callOptions = append(callOptions, remote.WithContext(callCtx))
	return remote.CatalogPage(registry, last, pageSize, callOptions...)
}

// commitRegistryRepo 在 repo tags 成功后原子提交该 repo 的 base 对象：
//   - 新 tag（prev 无）→ create(base)；已有 tag 不在此降级，交给 detail 判定；
//   - 该 repo 内 prev 有而 cur 无的 tag → delete（该 repo tags 已成功，权威）；
//   - 所有 base 进入 cur 并送入详情补全池。
func (s *ImageService) commitRegistryRepo(ctx context.Context, worker *watchWorker, jobs chan<- DockerImage, repositoryName string, tags []string, prev map[string]DockerImage, cur map[string]DockerImage, mu *sync.Mutex, pendingDeletes *[]string, bootstrap bool, reportProgress func(int)) {
	mu.Lock()
	var baseList []DockerImage
	repoIDs := make(map[string]bool)
	for _, tag := range tags {
		if !validRegistryTag(tag) {
			continue
		}
		id := registryTagImageID(repositoryName, tag)
		base := DockerImage{ID: id, Name: id, Tags: []string{id}, Repository: repositoryName}
		cur[id] = base
		baseList = append(baseList, base)
		repoIDs[id] = true
	}
	tagDeletes := make([]string, 0)
	creates := make([]DockerImage, 0, len(baseList))
	for id, img := range prev {
		if img.Repository == repositoryName && !repoIDs[id] {
			tagDeletes = append(tagDeletes, id)
		}
	}
	for _, base := range baseList {
		if bootstrap {
			creates = append(creates, base)
		} else if _, ok := prev[base.ID]; !ok {
			creates = append(creates, base)
		}
	}
	mu.Unlock()
	mu.Lock()
	*pendingDeletes = append(*pendingDeletes, tagDeletes...)
	mu.Unlock()
	for _, base := range creates {
		select {
		case <-ctx.Done():
			return
		default:
		}
		image := base
		s.emitWatchEvent(worker, s.watchImageEvent(worker, watchEventKindCreate, &image))
	}
	if reportProgress != nil {
		reportProgress(len(baseList))
	}
	// 送详情补全池（流水：不等待 catalog 全部读完）。
	for _, base := range baseList {
		select {
		case <-ctx.Done():
			return
		case jobs <- base:
		}
	}
}

// registryDetailWorker 从池中取 base 补全详情；只在实际变化时 emit update。
func (s *ImageService) registryDetailWorker(ctx context.Context, worker *watchWorker, source ImageSource, puller *remote.Puller, prev map[string]DockerImage, base DockerImage, cur map[string]DockerImage, mu *sync.Mutex, bootstrap bool, reportProgress func()) {
	metadata, err := s.fetchRegistryImageMetadata(ctx, source, base.ID, puller)
	if err != nil {
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			log.Printf("Registry 镜像元数据加载失败 image=%s: %v", base.ID, redactRegistryError(err, source))
		}
		return
	}
	if reportProgress != nil {
		reportProgress()
	}
	detail := DockerImage{
		ID:         base.ID,
		Name:       metadata.ImageID,
		Tags:       []string{metadata.ImageID},
		Repository: base.Repository,
		Digest:     metadata.Digest,
		MediaType:  metadata.MediaType,
		SizeType:   metadata.SizeType,
		Size:       metadata.Size,
		SizeBytes:  metadata.SizeBytes,
		CreatedAt:  metadata.CreatedAt,
	}
	var shouldEmit bool
	func() {
		mu.Lock()
		defer mu.Unlock()
		previous, hasPrev := prev[base.ID]
		if !bootstrap && hasPrev && dockerImagesEqual(previous, detail) {
			// 与历史权威值一致，无实际变化：仅保持 cur 完整，不 emit。
			cur[base.ID] = detail
			return
		}
		if existing, ok := cur[base.ID]; ok && dockerImagesEqual(existing, detail) {
			return
		}
		cur[base.ID] = detail
		shouldEmit = true
	}()
	if shouldEmit {
		// 在 mu 之外发送 update，避免持锁回调。
		image := detail
		s.emitWatchEvent(worker, s.watchImageEvent(worker, watchEventKindUpdate, &image))
	}
}

// indexImages 以 ID 为键建立镜像索引。
func indexImages(images []DockerImage) map[string]DockerImage {
	result := make(map[string]DockerImage, len(images))
	for _, image := range images {
		result[image.ID] = image
	}
	return result
}

// dockerImagesEqual 比较 diff 相关的可展示字段。Name 只是 Tags 里的展示值，且
// docker image ls 对同一镜像多个 tag 的返回顺序并不保证稳定；若比较 Name 或按
// 顺序比较 Tags，会把“只是顺序变化”误判为更新，导致列表反复刷新、搜索结果闪烁。
// 因此这里按 tag 集合比较，忽略 Name 与顺序。
func dockerImagesEqual(a, b DockerImage) bool {
	if a.ID != b.ID || a.Repository != b.Repository || a.Digest != b.Digest || a.MediaType != b.MediaType || a.SizeType != b.SizeType || a.SizeBytes != b.SizeBytes || a.CreatedAt != b.CreatedAt {
		return false
	}
	return stringSetsEqual(a.Tags, b.Tags)
}

func stringSetsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, value := range a {
		counts[value]++
	}
	for _, value := range b {
		counts[value]--
		if counts[value] < 0 {
			return false
		}
	}
	return true
}

func (s *ImageService) logWatch(worker *watchWorker, message string) {
	worker.emitMu.Lock()
	generation, revision := worker.generation, worker.revision
	worker.emitMu.Unlock()
	log.Printf("[image-watch] source=%s client=%s generation=%d revision=%d %s", worker.sourceID, worker.clientID, generation, revision, message)
}

func (s *ImageService) failWatchRound(worker *watchWorker, err error) {
	if worker.ctx.Err() != nil {
		return
	}
	s.logWatch(worker, "扫描失败: "+err.Error())
	s.emitWatchEvent(worker, s.watchStateEvent(worker, watchStageFailed, 0, 0, err.Error()))
}

func (s *ImageService) watchStateEvent(worker *watchWorker, stage string, scanned, total int, errorMessage string) WatchDockerImagesEvent {
	return WatchDockerImagesEvent{
		ClientID:   worker.clientID,
		SourceID:   worker.sourceID,
		IsUpdating: boolPtr(stage != watchStageDone && stage != watchStageFailed),
		Progress:   &WatchProgress{Scanned: scanned, Total: total, Stage: stage},
		Error:      errorMessage,
	}
}

// watchScanningEvent 推送扫描开始状态，携带版本、CLI 路径和本轮是否首次构建缓存。
func (s *ImageService) watchScanningEvent(worker *watchWorker, status *DockerStatus, isInitialLoad bool) WatchDockerImagesEvent {
	return WatchDockerImagesEvent{
		ClientID:      worker.clientID,
		SourceID:      worker.sourceID,
		Status:        status,
		IsUpdating:    boolPtr(true),
		IsInitialLoad: boolPtr(isInitialLoad),
		Progress:      &WatchProgress{Scanned: 0, Total: 0, Stage: watchStageScanning},
	}
}

// watchProgressEvent 推送扫描进度。Registry 的 scanned 是已成功获取
// digest/size 的 tag 数量，total 随 tags list 返回动态增加；Docker 的
// total 是 image ls 返回的唯一镜像数，scanned 是已完成 inspect 的数量。
func (s *ImageService) watchProgressEvent(worker *watchWorker, scanned, total int) WatchDockerImagesEvent {
	if worker != nil && worker.taskID != "" {
		s.updateTask(worker.taskID, func(task *imageTaskState) {
			task.Stage = "scanning"
			task.Completed = int64(scanned)
			task.Total = int64(total)
		})
	}
	return WatchDockerImagesEvent{
		ClientID:   worker.clientID,
		SourceID:   worker.sourceID,
		IsUpdating: boolPtr(true),
		Progress:   &WatchProgress{Scanned: scanned, Total: total, Stage: watchStageScanning},
	}
}

func (s *ImageService) watchSnapshotEvent(worker *watchWorker, images []DockerImage) WatchDockerImagesEvent {
	return WatchDockerImagesEvent{
		ClientID: worker.clientID,
		SourceID: worker.sourceID,
		Kind:     watchEventKindSnapshot,
		Images:   append([]DockerImage(nil), images...),
	}
}

func (s *ImageService) watchImageEvent(worker *watchWorker, kind string, image *DockerImage) WatchDockerImagesEvent {
	return WatchDockerImagesEvent{
		ClientID: worker.clientID,
		SourceID: worker.sourceID,
		Kind:     kind,
		Image:    image,
	}
}

func (s *ImageService) watchDeleteEvent(worker *watchWorker, imageID string) WatchDockerImagesEvent {
	return WatchDockerImagesEvent{
		ClientID: worker.clientID,
		SourceID: worker.sourceID,
		Kind:     watchEventKindDelete,
		ImageID:  imageID,
		ImageIDs: []string{imageID},
	}
}

func (s *ImageService) watchEventAllowed(worker *watchWorker) bool {
	if worker == nil || worker.ctx.Err() != nil {
		return false
	}
	worker.runMu.Lock()
	roundCtx := worker.roundCtx
	worker.runMu.Unlock()
	if roundCtx != nil && roundCtx.Err() != nil {
		return false
	}
	fingerprint := worker.currentFingerprint()
	if fingerprint != "" && !s.sourceFingerprintCurrent(worker.sourceID, fingerprint) {
		return false
	}
	return true
}

// emitWatchEvent 是唯一事件提交入口：emitMu 保护下顺序分配 revision 并同步发送。
// 已取消的扫描轮次或来源配置已变化时，迟到事件直接丢弃。
func (s *ImageService) emitWatchEvent(worker *watchWorker, event WatchDockerImagesEvent) {
	if !s.watchEventAllowed(worker) {
		return
	}
	worker.emitMu.Lock()
	defer worker.emitMu.Unlock()
	if !s.watchEventAllowed(worker) {
		return
	}
	worker.revision++
	event.Generation = worker.generation
	event.Revision = worker.revision
	s.emitEvent(watchDockerImagesEventName, event)
}

func boolPtr(value bool) *bool { return &value }
