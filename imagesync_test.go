package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// watchTestHarness 提供事件收集与按轮次聚合的辅助。
type watchTestHarness struct {
	service *ImageService
	events  chan WatchDockerImagesEvent
	client  string
	source  string
}

func newWatchTestHarness(t *testing.T, service *ImageService, client, source string) *watchTestHarness {
	t.Helper()
	events := make(chan WatchDockerImagesEvent, 512)
	service.eventEmitter = func(name string, data any) {
		if name == watchDockerImagesEventName {
			events <- data.(WatchDockerImagesEvent)
		}
	}
	return &watchTestHarness{service: service, events: events, client: client, source: source}
}

func (h *watchTestHarness) drain() {
	for {
		select {
		case <-h.events:
		default:
			return
		}
	}
}

// waitFor 等待满足条件的首个事件。
func (h *watchTestHarness) waitFor(timeout time.Duration, predicate func(WatchDockerImagesEvent) bool) (WatchDockerImagesEvent, bool) {
	deadline := time.After(timeout)
	for {
		select {
		case event := <-h.events:
			if predicate(event) {
				return event, true
			}
		case <-deadline:
			return WatchDockerImagesEvent{}, false
		}
	}
}

func (h *watchTestHarness) waitEvent(timeout time.Duration, predicate func(WatchDockerImagesEvent) bool) bool {
	_, ok := h.waitFor(timeout, predicate)
	return ok
}

// collectKind 收集指定 kind 的所有事件（超时截止）。
func (h *watchTestHarness) collectKind(timeout time.Duration, kind string) []WatchDockerImagesEvent {
	var result []WatchDockerImagesEvent
	deadline := time.After(timeout)
	for {
		select {
		case event := <-h.events:
			if event.Kind == kind {
				result = append(result, event)
			}
		case <-deadline:
			return result
		}
	}
}

// manualRound 手动推进一轮扫描（绕过真实 2 分钟间隔），返回该轮的最大 revision。
func (h *watchTestHarness) manualRound() uint64 {
	h.service.mu.Lock()
	worker := h.service.watchWorker
	h.service.mu.Unlock()
	if worker == nil {
		panic("watch worker 未创建")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		worker.runMu.Lock()
		running := worker.running
		worker.runMu.Unlock()
		if !running || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.service.runWatchRound(worker)
	worker.emitMu.Lock()
	revision := worker.revision
	worker.emitMu.Unlock()
	return revision
}

func (h *watchTestHarness) start(ctx context.Context) <-chan error {
	return h.startWith(ctx, h.source, h.client)
}

func (h *watchTestHarness) startWith(ctx context.Context, sourceID, clientID string) <-chan error {
	done := make(chan error, 1)
	go func() {
		done <- h.service.WatchDockerImages(ctx, sourceID, clientID)
	}()
	return done
}

func waitWatchStop(t *testing.T, cancel context.CancelFunc, done <-chan error) {
	t.Helper()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("watch 结束失败: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Error("watch 取消后未返回")
	}
}

// registryListServer 提供可编程的 Registry v2 测试服务。
func registryListServer(t *testing.T) (*httptest.Server, *atomic.Bool, *atomic.Bool) {
	t.Helper()
	failCatalog := &atomic.Bool{}
	failTags := &atomic.Bool{}
	configBlob := []byte(`{"architecture":"amd64","os":"linux","created":"2026-01-01T00:00:00Z","config":{"Labels":{"app":"demo"},"Cmd":["run"],"Entrypoint":["/bin/demo"]}}`)
	configDigest := fmt.Sprintf("sha256:%x", sha256.Sum256(configBlob))
	manifest := []byte(fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":%q,"size":%d},"layers":[]}`, configDigest, len(configBlob)))
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(manifest))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "user" || password != "password" {
			w.Header().Set("WWW-Authenticate", `Basic realm="registry"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /v2/":
			w.WriteHeader(http.StatusOK)
		case "GET /v2/_catalog":
			if failCatalog.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"repositories": []string{"repo-a", "repo-b"}})
		case "GET /v2/repo-a/tags/list":
			if failTags.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "repo-a", "tags": []string{"latest", "v1"}})
		case "GET /v2/repo-b/tags/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "repo-b", "tags": []string{"v2"}})
		case "HEAD /v2/repo-a/manifests/latest", "HEAD /v2/repo-a/manifests/v1", "HEAD /v2/repo-b/manifests/v2":
			w.Header().Set("Docker-Content-Digest", digest)
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(manifest)))
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
		case "GET /v2/repo-a/manifests/latest", "GET /v2/repo-a/manifests/v1", "GET /v2/repo-b/manifests/v2", "GET /v2/repo-a/manifests/" + digest, "GET /v2/repo-b/manifests/" + digest:
			w.Header().Set("Docker-Content-Digest", digest)
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
			_, _ = w.Write(manifest)
		case "GET /v2/repo-a/blobs/" + configDigest, "GET /v2/repo-b/blobs/" + configDigest:
			_, _ = w.Write(configBlob)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(func() {
		server.Close()
		server.Client().CloseIdleConnections()
	})
	return server, failCatalog, failTags
}

func makeRegistryConfig(t *testing.T, server *httptest.Server) *ConfigService {
	t.Helper()
	return &ConfigService{cfg: normalizeConfig(Config{ImageSources: []ImageSource{
		{ID: "reg", Kind: "registry", RegistryURL: server.URL, RegistryUsername: "user", RegistryPassword: "password"},
	}})}
}

// TestWatchDockerImagesEmitsSnapshotAndProgress 验证真实循环首轮推送
// snapshot、done 状态与单调 revision。
func TestWatchDockerImagesEmitsSnapshotAndProgress(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) == 1 && args[0] == "--version" {
			return []byte("Docker version 27.0.0, build deadbeef\n"), nil
		}
		if len(args) >= 2 && args[0] == "image" && args[1] == "inspect" {
			return []byte(`[{"Id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","RepoTags":["repo:latest"],"Size":10485760,"Created":"2026-09-02T00:00:00Z"}]`), nil
		}
		return []byte("{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"latest","Size":"10MB"` + "}\n"), nil
	}
	harness := &watchTestHarness{service: service, events: make(chan WatchDockerImagesEvent, 64), client: "client-1", source: "local"}
	service.eventEmitter = func(name string, data any) {
		if name == watchDockerImagesEventName {
			harness.events <- data.(WatchDockerImagesEvent)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	defer waitWatchStop(t, cancel, watchDone)
	// 首个事件必须是连接探测结果，缓存 snapshot 不得抢先结束连接态。
	firstEvent, ok := harness.waitFor(3*time.Second, func(WatchDockerImagesEvent) bool { return true })
	if !ok {
		t.Fatal("等待首个连接状态事件超时")
	}
	if firstEvent.Status == nil || firstEvent.Status.Version == "" || firstEvent.Status.CLIPath != "docker" || firstEvent.IsUpdating == nil || !*firstEvent.IsUpdating || firstEvent.IsInitialLoad == nil || !*firstEvent.IsInitialLoad {
		t.Fatalf("首个事件应携带可用的 Docker 状态: %#v", firstEvent)
	}
	createEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindCreate && event.Image != nil
	})
	if !ok {
		t.Fatal("等待首次基础行 create 事件超时")
	}
	if createEvent.ClientID != "client-1" || createEvent.SourceID != "local" {
		t.Fatalf("事件字段错误: %#v", createEvent)
	}
	if createEvent.Generation == 0 || createEvent.Revision == 0 {
		t.Fatalf("事件缺少 generation/revision: %#v", createEvent)
	}
	if createEvent.Image.Name != "repo:latest" || createEvent.Image.SizeBytes != 10*1000*1000 {
		t.Fatalf("基础行镜像错误: %#v", createEvent.Image)
	}
	initialProgress, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageScanning && event.Progress.Scanned == 0 && event.Progress.Total == 1
	})
	if !ok {
		t.Fatal("image ls 完成后应先推送 0/1 进度")
	}
	if initialProgress.Revision <= createEvent.Revision {
		t.Fatalf("0/1 进度应在基础行之后推送: create=%#v progress=%#v", createEvent, initialProgress)
	}
	updateEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindUpdate && event.Image != nil
	})
	if !ok || updateEvent.Revision <= createEvent.Revision || updateEvent.Image.SizeBytes != 10485760 {
		t.Fatalf("详情 update 应在 create 后推送: create=%#v update=%#v", createEvent, updateEvent)
	}
	if !harness.waitEvent(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageScanning && event.Progress.Scanned == 1 && event.Progress.Total == 1
	}) {
		t.Fatal("inspect 完成后应推送 1/1 进度")
	}
	if !harness.waitEvent(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageDone
	}) {
		t.Fatal("等待 done 状态事件超时")
	}
}

// TestWatchUnavailableStopsBeforeSnapshot 验证连接探测失败时直接进入失败态，
// 不发布缓存 snapshot，也不继续调用 Docker 列表命令。
func TestWatchUnavailableStopsBeforeSnapshot(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	var listCalls atomic.Int32
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) == 1 && args[0] == "--version" {
			return nil, errors.New("docker unavailable")
		}
		listCalls.Add(1)
		return nil, errors.New("不应执行镜像列表命令")
	}
	harness := newWatchTestHarness(t, service, "client-unavailable", "local")
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	defer waitWatchStop(t, cancel, watchDone)

	statusEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Status != nil
	})
	if !ok || statusEvent.Status.Available {
		t.Fatalf("连接失败应先推送不可用状态: %#v", statusEvent)
	}
	if _, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageFailed
	}); !ok {
		t.Fatal("连接失败后未进入 failed 状态")
	}
	if listCalls.Load() != 0 {
		t.Fatalf("连接失败后不应继续扫描镜像，实际调用 %d 次", listCalls.Load())
	}
	if events := harness.collectKind(100*time.Millisecond, watchEventKindSnapshot); len(events) != 0 {
		t.Fatalf("连接失败前不应发布 snapshot: %#v", events)
	}
}

// TestWatchDockerImagesDiffRoundEmitsCreateUpdateDelete 手动驱动三轮，
// 验证精准 create/update/delete 事件与完整对象。
func TestWatchDockerImagesDiffRoundEmitsCreateUpdateDelete(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	var current int32
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		round := atomic.LoadInt32(&current)
		imageA := "{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"one","Size":"1MB"` + "}\n"
		imageB := "{" + `"ID":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Repository":"repo","Tag":"two","Size":"1MB"` + "}\n"
		switch round {
		case 0:
			return []byte(imageA + imageB), nil
		case 1:
			return []byte(imageA + "{" + `"ID":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Repository":"repo","Tag":"renamed","Size":"1MB"` + "}\n"), nil
		default:
			return []byte(imageA), nil
		}
	}
	harness := newWatchTestHarness(t, service, "client-2", "local")
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	defer waitWatchStop(t, cancel, watchDone)
	// 第一轮：真实循环先逐条推送基础行（2 个镜像）。
	createEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindCreate && event.Image != nil
	})
	if !ok {
		t.Fatal("等待首轮 create 超时")
	}
	firstRevision := createEvent.Revision
	if !harness.waitEvent(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageDone
	}) {
		t.Fatal("等待首轮 done 超时")
	}
	harness.drain()

	// 第二轮：b 标签变化 -> update（完整对象）。
	atomic.StoreInt32(&current, 1)
	secondRevision := harness.manualRound()
	if secondRevision <= firstRevision {
		t.Fatalf("第二轮 revision 应大于首轮: first=%d second=%d", firstRevision, secondRevision)
	}
	secondScanEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Status != nil && event.Progress != nil && event.Progress.Stage == watchStageScanning
	})
	if !ok || secondScanEvent.IsInitialLoad == nil || *secondScanEvent.IsInitialLoad {
		t.Fatalf("已有完整缓存后的第二轮应标记为后台更新: %#v", secondScanEvent)
	}
	updateEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindUpdate
	})
	if !ok {
		t.Fatal("等待第二轮 update 事件超时")
	}
	if updateEvent.Image == nil || updateEvent.Image.ID != "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" || updateEvent.Image.Name != "repo:renamed" {
		t.Fatalf("update 事件应携带完整对象: %#v", updateEvent.Image)
	}
	harness.drain()

	// 第三轮：b 消失 -> delete。
	atomic.StoreInt32(&current, 2)
	thirdRevision := harness.manualRound()
	if thirdRevision <= secondRevision {
		t.Fatalf("第三轮 revision 应大于第二轮: second=%d third=%d", secondRevision, thirdRevision)
	}
	deleteEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindDelete
	})
	if !ok {
		t.Fatal("等待第三轮 delete 事件超时")
	}
	if deleteEvent.ImageID != "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" || len(deleteEvent.ImageIDs) != 1 {
		t.Fatalf("delete 事件字段错误: %#v", deleteEvent)
	}
}

// TestWatchFailedRoundDoesNotDelete 验证失败轮不推送删除且不污染状态：
// 失败后恢复扫描时，缺失的镜像仍走 delete（而不是被误删）。
func TestWatchFailedRoundDoesNotDelete(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	var current int32
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		round := atomic.LoadInt32(&current)
		imageA := "{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"one","Size":"1MB"` + "}\n"
		imageB := "{" + `"ID":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Repository":"repo","Tag":"two","Size":"1MB"` + "}\n"
		switch round {
		case 0:
			return []byte(imageA + imageB), nil
		case 1:
			return nil, fmt.Errorf("docker daemon unavailable")
		case 2:
			return []byte(imageA), nil
		default:
			return []byte(imageA), nil
		}
	}
	harness := newWatchTestHarness(t, service, "client-3", "local")
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	defer waitWatchStop(t, cancel, watchDone)
	snapshotEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot && len(event.Images) == 2
	})
	if !ok {
		t.Fatal("等待首轮 snapshot 超时")
	}
	firstRevision := snapshotEvent.Revision
	harness.drain()

	// 第二轮：扫描失败 -> 应推送 failed 状态，且无任何 diff 事件。
	atomic.StoreInt32(&current, 1)
	secondRevision := harness.manualRound()
	if secondRevision <= firstRevision {
		t.Fatalf("第二轮 revision 应大于首轮: first=%d second=%d", firstRevision, secondRevision)
	}
	failedEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageFailed
	})
	if !ok {
		t.Fatal("等待 failed 状态事件超时")
	}
	if failedEvent.Error == "" {
		t.Fatal("failed 事件应携带错误信息")
	}
	time.Sleep(50 * time.Millisecond)
	harness.drain()
	if events := harness.collectKind(100*time.Millisecond, watchEventKindDelete); len(events) != 0 {
		t.Fatalf("失败轮不应推送 delete 事件: %#v", events)
	}
	harness.drain()

	// 第三轮：恢复，b 消失 -> delete 仍正常出现。
	atomic.StoreInt32(&current, 2)
	thirdRevision := harness.manualRound()
	if thirdRevision <= secondRevision {
		t.Fatalf("第三轮 revision 应大于第二轮: second=%d third=%d", secondRevision, thirdRevision)
	}
	deleteEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindDelete
	})
	if !ok {
		t.Fatal("恢复后缺失镜像应正常推送 delete")
	}
	if deleteEvent.ImageID != "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("delete 目标错误: %#v", deleteEvent)
	}
}

// TestWatchDockerImagesCancelStopsLoop 验证调用方取消后循环退出。
func TestWatchDockerImagesCancelStopsLoop(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		return []byte("{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"latest","Size":"1MB"` + "}\n"), nil
	}
	harness := newWatchTestHarness(t, service, "client-4", "local")
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	if _, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot
	}); !ok {
		t.Fatal("等待 snapshot 超时")
	}
	service.mu.Lock()
	worker := service.watchWorker
	service.mu.Unlock()
	if worker == nil || worker.done == nil {
		t.Fatal("watch worker 未注册")
	}
	cancel()
	select {
	case <-worker.done:
	case <-time.After(3 * time.Second):
		t.Fatal("取消后 watch 循环未退出")
	}
	select {
	case err := <-watchDone:
		if err != nil {
			t.Fatalf("watch 结束失败: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("取消后 watch 调用未返回")
	}
}

// TestWatchSameClientDoesNotStartSecondLoop 验证同 client+source 重复注册
// 共享循环，不启动第二个。
func TestWatchSameClientDoesNotStartSecondLoop(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		return []byte("{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"latest","Size":"1MB"` + "}\n"), nil
	}
	harness := newWatchTestHarness(t, service, "client-5", "local")
	ctx1, cancel1 := context.WithCancel(context.Background())
	watchDone1 := harness.start(ctx1)
	defer waitWatchStop(t, cancel1, watchDone1)
	firstSnapshot, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot
	})
	if !ok {
		t.Fatal("等待 snapshot 超时")
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	watchDone2 := harness.start(ctx2)
	defer waitWatchStop(t, cancel2, watchDone2)
	if _, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot && event.Generation > firstSnapshot.Generation
	}); !ok {
		t.Fatal("等待替换后的 snapshot 超时")
	}
	service.mu.Lock()
	worker := service.watchWorker
	service.mu.Unlock()
	if worker == nil || worker.done == nil {
		t.Fatal("watch worker 未注册")
	}
	// 取消第一个调用不应终止共享循环（同一 client/source 仍活跃）。
	cancel1()
	select {
	case <-worker.done:
		t.Fatal("取消一个调用不应终止共享循环")
	case <-time.After(200 * time.Millisecond):
	}
}

// TestWatchRegistryStreamsAndFailsWithoutDelete 验证 Registry 流式扫描：
// 返回完整列表、补全详情并推送 update；失败轮不误删。
func TestWatchRegistryStreamsAndFailsWithoutDelete(t *testing.T) {
	server, failCatalog, failTags := registryListServer(t)
	config := makeRegistryConfig(t, server)
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	service.registryTransport = server.Client().Transport
	events := make(chan WatchDockerImagesEvent, 512)
	service.eventEmitter = func(name string, data any) {
		if name == watchDockerImagesEventName {
			events <- data.(WatchDockerImagesEvent)
		}
	}
	harness := &watchTestHarness{service: service, events: events, client: "client-6", source: "reg"}
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	defer waitWatchStop(t, cancel, watchDone)
	doneEvent, ok := harness.waitFor(5*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageDone
	})
	if !ok {
		t.Fatal("等待 Registry 首轮完成超时")
	}
	if doneEvent.Progress == nil || doneEvent.Progress.Scanned != 3 || doneEvent.Progress.Total != 3 {
		t.Fatalf("Registry done 进度应为已完成详情数/总 tag 数 3/3: %#v", doneEvent.Progress)
	}
	firstRevision := doneEvent.Revision
	harness.drain()

	// 手动推进失败轮：catalog 失败 -> 无 delete。
	failCatalog.Store(true)
	secondRevision := harness.manualRound()
	if secondRevision <= firstRevision {
		t.Fatalf("失败轮 revision 应大于首轮: first=%d second=%d", firstRevision, secondRevision)
	}
	if _, ok := harness.waitFor(5*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageFailed
	}); !ok {
		t.Fatal("等待 Registry 失败状态超时")
	}
	time.Sleep(50 * time.Millisecond)
	harness.drain()
	if events := harness.collectKind(100*time.Millisecond, watchEventKindDelete); len(events) != 0 {
		t.Fatalf("Registry 失败轮不应推送 delete: %#v", events)
	}
	harness.drain()

	// 恢复并让 repo-b 标签列表失败：仓库级失败也应整体失败，不误删。
	failCatalog.Store(false)
	failTags.Store(true)
	thirdRevision := harness.manualRound()
	if thirdRevision <= secondRevision {
		t.Fatalf("第三轮 revision 应大于第二轮: second=%d third=%d", secondRevision, thirdRevision)
	}
	if _, ok := harness.waitFor(5*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Progress != nil && event.Progress.Stage == watchStageFailed
	}); !ok {
		t.Fatal("等待 tags 失败状态超时")
	}
	time.Sleep(50 * time.Millisecond)
	harness.drain()
	if events := harness.collectKind(100*time.Millisecond, watchEventKindDelete); len(events) != 0 {
		t.Fatalf("tags 失败轮不应推送 delete: %#v", events)
	}
}

// TestWatchGenerationIncrementsOnNewClient 验证不同 client 建立新循环时
// generation 自增。
func TestWatchGenerationIncrementsOnNewClient(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		return []byte("{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"latest","Size":"1MB"` + "}\n"), nil
	}
	harness := newWatchTestHarness(t, service, "client-7", "local")
	ctx1, cancel1 := context.WithCancel(context.Background())
	watchDone1 := harness.start(ctx1)
	defer waitWatchStop(t, cancel1, watchDone1)
	first, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot && len(event.Images) == 1
	})
	if !ok {
		t.Fatal("等待首次 snapshot 超时")
	}
	cancel1()
	service.mu.Lock()
	oldWorker := service.watchWorker
	service.mu.Unlock()
	if oldWorker != nil {
		<-oldWorker.done
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	watchDone2 := harness.startWith(ctx2, "local", "client-8")
	defer waitWatchStop(t, cancel2, watchDone2)
	second, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot && event.ClientID == "client-8"
	})
	if !ok {
		t.Fatal("等待第二次 snapshot 超时")
	}
	if second.Generation <= first.Generation {
		t.Fatalf("新 client 应使 generation 自增: first=%d second=%d", first.Generation, second.Generation)
	}
	if second.HasSnapshot == nil || !*second.HasSnapshot || second.SnapshotUpdatedAt == "" {
		t.Fatalf("重新订阅应先恢复带更新时间的缓存快照: %#v", second)
	}
}

// TestWatchSnapshotCacheKeyedByFingerprint 验证完整列表缓存在 service 层
// 按 sourceID+fingerprint 保存；同一循环内来源配置变化（fingerprint 变化）
// 后，新 fingerprint 无缓存首轮走 snapshot，旧 fingerprint 缓存失效。
func TestWatchSnapshotCacheKeyedByFingerprint(t *testing.T) {
	config := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(defaultConfig())}
	service := NewImageService(config)
	defer service.shutdown()
	service.cacheDir = t.TempDir()
	service.runner = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		return []byte("{" + `"ID":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Repository":"repo","Tag":"latest","Size":"1MB"` + "}\n"), nil
	}
	harness := newWatchTestHarness(t, service, "client-9", "local")
	ctx, cancel := context.WithCancel(context.Background())
	watchDone := harness.start(ctx)
	defer waitWatchStop(t, cancel, watchDone)
	first, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot && len(event.Images) == 1
	})
	if !ok {
		t.Fatal("等待首次 snapshot 超时")
	}
	_, _, originalFingerprint, err := service.sourceSnapshot("local")
	if err != nil {
		t.Fatalf("读取来源失败: %v", err)
	}
	// 缓存应存在。
	service.mu.Lock()
	_, cached := service.watchSnapshots["local\x00"+originalFingerprint]
	service.mu.Unlock()
	if !cached {
		t.Fatal("完整列表缓存未按 sourceID+fingerprint 保存")
	}

	// 同循环内修改来源（CLI 路径变化 -> fingerprint 变化），手动推进一轮。
	changed := config.Get()
	changed.DockerCLIPath = "docker-other"
	if err := config.Save(changed); err != nil {
		t.Fatalf("修改来源失败: %v", err)
	}
	harness.drain()
	harness.manualRound()
	// 新 fingerprint 无缓存 -> 首轮发 snapshot。
	snapshotEvent, ok := harness.waitFor(3*time.Second, func(event WatchDockerImagesEvent) bool {
		return event.Kind == watchEventKindSnapshot && len(event.Images) == 1
	})
	if !ok {
		t.Fatal("来源 fingerprint 变化后应推送 snapshot（新 key 无缓存）")
	}
	if snapshotEvent.Generation <= first.Generation {
		t.Fatalf("新 fingerprint snapshot generation 应更大: first=%d second=%d", first.Generation, snapshotEvent.Generation)
	}
	// 旧 fingerprint 缓存应被清理，避免认证配置变化后误复用。
	service.mu.Lock()
	_, oldCached := service.watchSnapshots["local\x00"+originalFingerprint]
	service.mu.Unlock()
	if oldCached {
		t.Fatal("来源变化后不应保留旧 fingerprint 缓存")
	}
}

func TestRefreshDockerImagesTargetsActiveWorkerAndCoalesces(t *testing.T) {
	service := &ImageService{}
	worker := &watchWorker{sourceID: "local", clientID: "client", refresh: make(chan struct{}, 1)}
	service.watchWorker = worker
	if err := service.RefreshDockerImages("local", "client"); err != nil {
		t.Fatalf("刷新活动来源失败: %v", err)
	}
	if err := service.RefreshDockerImages("local", "client"); err != nil {
		t.Fatalf("重复刷新请求失败: %v", err)
	}
	if got := len(worker.refresh); got != 1 {
		t.Fatalf("重复刷新应合并为一个请求，实际 %d", got)
	}
	worker.runMu.Lock()
	worker.running = true
	worker.runMu.Unlock()
	if err := service.RefreshDockerImages("local", "client"); err != nil {
		t.Fatalf("扫描进行中刷新应安全忽略: %v", err)
	}
	if got := len(worker.refresh); got != 1 {
		t.Fatalf("扫描进行中不应追加刷新请求，实际 %d", got)
	}
	if err := service.RefreshDockerImages("other", "client"); err == nil {
		t.Fatal("来源不匹配时应拒绝刷新")
	}
}
