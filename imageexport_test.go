package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRegistryExportLargeSharedBlob(t *testing.T) {
	for _, mode := range []string{"complete", "corrupt", "truncated", "canceled"} {
		t.Run(mode, func(t *testing.T) {
			blob := bytes.Repeat([]byte("layer-data"), 1<<20)
			digestOf := func(data []byte) string { return fmt.Sprintf("sha256:%x", sha256.Sum256(data)) }
			blobDigest := digestOf(blob)
			objects := map[string][]byte{blobDigest: blob}
			mediaTypes := map[string]string{}
			describe := func(data []byte, mediaType string) map[string]any {
				digest := digestOf(data)
				objects[digest], mediaTypes[digest] = data, mediaType
				return map[string]any{"digest": digest, "size": len(data), "mediaType": mediaType}
			}
			encode := func(value any) []byte {
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				return data
			}
			var manifests []map[string]any
			for _, arch := range []string{"amd64", "arm64"} {
				config := describe(encode(map[string]any{"architecture": arch, "os": "linux"}), "application/vnd.oci.image.config.v1+json")
				manifest := describe(encode(map[string]any{"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": config, "layers": []any{map[string]any{"digest": blobDigest, "size": len(blob), "mediaType": "application/vnd.oci.image.layer.v1.tar"}}}), "application/vnd.oci.image.manifest.v1+json")
				manifest["platform"] = map[string]string{"architecture": arch, "os": "linux"}
				manifests = append(manifests, manifest)
			}
			indexType := "application/vnd.oci.image.index.v1+json"
			inner := describe(encode(map[string]any{"schemaVersion": 2, "mediaType": indexType, "manifests": manifests}), indexType)
			root := describe(encode(map[string]any{"schemaVersion": 2, "mediaType": indexType, "manifests": []any{inner}}), indexType)
			rootDigest := root["digest"].(string)
			var mu sync.Mutex
			blobGets := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v2/" {
					return
				}
				key := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
				if key == "latest" {
					key = rootDigest
				}
				data, ok := objects[key]
				if !ok {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", mediaTypes[key])
				w.Header().Set("Docker-Content-Digest", key)
				w.Header().Set("Content-Length", strconv.Itoa(len(data)))
				if r.Method == http.MethodHead {
					return
				}
				if key == blobDigest {
					mu.Lock()
					blobGets++
					mu.Unlock()
					if mode == "corrupt" {
						data = bytes.Repeat([]byte("x"), len(data))
					}
					if mode == "truncated" {
						data = data[:maxRegistryBodySize]
					}
				}
				_, _ = w.Write(data)
			}))
			defer server.Close()
			source := ImageSource{ID: "reg", Kind: "registry", RegistryURL: server.URL}
			s := NewImageService(&ConfigService{cfg: normalizeConfig(Config{ImageSources: []ImageSource{source}})})
			defer s.shutdown()
			s.registryTransport = server.Client().Transport
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			progressSeen := false
			s.eventEmitter = func(name string, data any) {
				if name != imageTasksEventName {
					return
				}
				for _, task := range data.(ImageTaskSnapshot).Tasks {
					if task.Status == imageTaskRunning && task.Bytes > 0 && task.Total > task.Bytes {
						progressSeen = true
						if mode == "canceled" {
							cancel()
						}
					}
				}
			}
			id := s.newImageTask(imageTaskTypeExport, "reg", "repo:latest")
			target := filepath.Join(t.TempDir(), "image.tar")
			if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
				t.Fatal(err)
			}
			s.runImageExport(ctx, id, "reg", "repo:latest", target)
			task := s.GetImageTasks().Tasks[0]
			if mode != "complete" {
				if task.Status != imageTaskFailed && task.Status != imageTaskCanceled {
					t.Fatalf("失败被标记为成功: %+v", task)
				}
				data, _ := os.ReadFile(target)
				if string(data) != "original" {
					t.Fatal("失败覆盖了原文件")
				}
				partials, _ := filepath.Glob(target + ".*.partial")
				if len(partials) != 0 {
					t.Fatal("失败未清理临时文件")
				}
				return
			}
			info, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if task.Status != imageTaskSuccess || task.Bytes != info.Size() || task.Total != info.Size() || task.Completed != info.Size() {
				t.Fatalf("完成进度未收敛: %+v", task)
			}
			if !progressSeen {
				t.Fatal("传输过程中没有已知总量的进度")
			}
			file, err := os.Open(target)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			tr := tar.NewReader(file)
			found := make(map[string]bool)
			for {
				header, err := tr.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if !strings.HasPrefix(header.Name, "blobs/sha256/") {
					continue
				}
				key := "sha256:" + strings.TrimPrefix(header.Name, "blobs/sha256/")
				data, err := io.ReadAll(tr)
				if err != nil || !bytes.Equal(data, objects[key]) || found[key] {
					t.Fatalf("对象字节不一致或重复: %s，%v", key, err)
				}
				found[key] = true
			}
			mu.Lock()
			gets := blobGets
			mu.Unlock()
			if len(found) != len(objects) || gets != 1 {
				t.Fatalf("对象缺失或共享层重复下载: %d/%d，下载 %d 次", len(found), len(objects), gets)
			}
		})
	}
}

func TestDockerStreamExportFinalSize(t *testing.T) {
	previous := execCommandContext
	defer func() { execCommandContext = previous }()
	for _, kind := range []string{"local", "ssh"} {
		t.Run(kind, func(t *testing.T) {
			execCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
				return exec.CommandContext(ctx, "printf", "%s", "archive-stream")
			}
			s := &ImageService{tasks: make(map[string]*imageTaskState)}
			id := s.newImageTask(imageTaskTypeExport, kind, "image:tag")
			target := filepath.Join(t.TempDir(), "image.tar")
			err := s.exportDockerTar(context.Background(), id, ImageSource{Kind: kind, SSHHost: "example.test"}, "docker", "image:tag", target)
			if err != nil {
				t.Fatal(err)
			}
			task := s.GetImageTasks().Tasks[0]
			if task.Bytes != 14 || task.Completed != 14 || task.Total != 14 {
				t.Fatalf("未回填最终大小: %+v", task)
			}
		})
	}
}

func TestRetryImageExportStartsFromOriginalTarget(t *testing.T) {
	previous := execCommandContext
	defer func() { execCommandContext = previous }()
	execCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "%s", "fresh-archive")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &ImageService{
		config:    &ConfigService{cfg: normalizeConfig(Config{ImageSources: []ImageSource{{ID: "local", Kind: "local"}}})},
		ctx:       ctx,
		tasks:     make(map[string]*imageTaskState),
		exportSem: make(chan struct{}, 2),
	}
	target := filepath.Join(t.TempDir(), "image.tar")
	if err := os.WriteFile(target, []byte("old-archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	failedID := s.createImageTask(imageTaskState{ImageTask: ImageTask{
		Type:           imageTaskTypeExport,
		SourceID:       "local",
		ImageID:        "image:tag",
		Path:           target,
		Total:          123,
		TotalEstimated: true,
	}})
	s.updateTask(failedID, func(task *imageTaskState) {
		task.Status = imageTaskFailed
		task.Stage = "failed"
		task.Error = "previous failure"
	})

	result, err := s.RetryImageExport(failedID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Started != 1 {
		t.Fatalf("重试未启动任务: %+v", result)
	}
	if len(result.Snapshot.Tasks) != 1 || result.Snapshot.Tasks[0].ID != failedID {
		t.Fatalf("重试没有复用原任务: %+v", result)
	}
	s.exportWG.Wait()

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "fresh-archive" {
		t.Fatalf("重试未从头覆盖目标文件: %q", data)
	}
	snapshot := s.GetImageTasks()
	if len(snapshot.Tasks) != 1 {
		t.Fatalf("重试任务数量 = %d，期望 1", len(snapshot.Tasks))
	}
	task := snapshot.Tasks[0]
	if task.ID != failedID || task.Status != imageTaskSuccess || task.Path != target {
		t.Fatalf("重试任务未复用原任务或未成功: %+v", task)
	}
	if task.Error != "" || task.TotalEstimated {
		t.Fatalf("重试任务未清理失败状态或未收敛实际大小: %+v", task)
	}
}

func TestBatchExportPathsAvoidCollisions(t *testing.T) {
	dir := t.TempDir()
	filename := exportFilename("repo/image:tag")
	existing := filepath.Join(dir, filename)
	if err := os.WriteFile(existing, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	reserved := map[string]bool{filepath.Join(dir, "repo_image_tag (1).tar"): true}
	paths, err := batchExportPaths(dir, []string{"repo/image:tag", "repo_image:tag"}, reserved)
	if err != nil {
		t.Fatal(err)
	}
	for i, path := range paths {
		want := filepath.Join(dir, fmt.Sprintf("repo_image_tag (%d).tar", i+2))
		if path != want {
			t.Errorf("导出路径 = %q，期望 %q", path, want)
		}
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("规划路径时不应创建最终文件: %v", err)
		}
	}
}

func TestBatchExportCommitDoesNotOverwrite(t *testing.T) {
	for _, exists := range []bool{false, true} {
		t.Run(fmt.Sprint(exists), func(t *testing.T) {
			dir := t.TempDir()
			tmp, target := filepath.Join(dir, "image.partial"), filepath.Join(dir, "image.tar")
			if err := os.WriteFile(tmp, []byte("archive"), 0o600); err != nil {
				t.Fatal(err)
			}
			if exists {
				if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			s := &ImageService{tasks: map[string]*imageTaskState{"export": {exclusiveTarget: true}}}
			err := s.commitImageExport("export", tmp, target)
			if exists && !errors.Is(err, os.ErrExist) || !exists && err != nil {
				t.Fatalf("提交结果错误: %v", err)
			}
			data, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			want := "archive"
			if exists {
				want = "original"
			}
			if string(data) != want {
				t.Fatalf("文件内容 = %q，期望 %q", data, want)
			}
		})
	}
}

func TestImageTaskRetention(t *testing.T) {
	s := &ImageService{tasks: make(map[string]*imageTaskState)}
	add := func(id, status string, age time.Duration) {
		s.tasks[id] = &imageTaskState{ImageTask: ImageTask{
			ID: id, Status: status, UpdatedAt: time.Now().Add(-age).UTC().Format(time.RFC3339Nano),
		}}
		s.taskOrder = append(s.taskOrder, id)
	}
	// 较早的活动任务不能阻止后续过期记录清理。
	add("active", imageTaskRunning, 48*time.Hour)
	add("queued", imageTaskQueued, 48*time.Hour)
	for _, status := range []string{imageTaskSuccess, imageTaskFailed, imageTaskCanceled} {
		add("old-"+status, status, 25*time.Hour)
		add("recent-"+status, status, 23*time.Hour)
	}
	// 一天内超过 50 条也应保留。
	for i := range 60 {
		add(fmt.Sprintf("recent-%d", i), imageTaskSuccess, time.Hour)
	}
	snapshot := s.GetImageTasks()
	if snapshot.Revision == 0 {
		t.Fatal("过期任务清理后没有更新快照版本")
	}
	if len(snapshot.Tasks) != 65 {
		t.Fatalf("任务数量 = %d，期望 65", len(snapshot.Tasks))
	}
	for _, status := range []string{imageTaskSuccess, imageTaskFailed, imageTaskCanceled} {
		if _, exists := s.tasks["old-"+status]; exists {
			t.Errorf("过期任务未清理: %s", status)
		}
		if _, exists := s.tasks["recent-"+status]; !exists {
			t.Errorf("近期任务被清理: %s", status)
		}
	}
}

func TestBatchExportSnapshotWithoutEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &ImageService{ctx: ctx, exportSem: make(chan struct{}, 2)}
	// 占满并发槽，使任务停在队列中，无需 Docker 或原生目录对话框。
	s.exportSem <- struct{}{}
	s.exportSem <- struct{}{}
	defer func() {
		cancel()
		s.exportWG.Wait()
	}()
	var mu sync.Mutex
	var events []ImageTaskSnapshot
	s.eventEmitter = func(name string, data any) {
		if name == imageTasksEventName {
			mu.Lock()
			events = append(events, data.(ImageTaskSnapshot))
			mu.Unlock()
		}
	}
	historyID := s.newImageTask(imageTaskTypeDetail, "local", "existing:latest")
	ids := []string{"repo/a:latest", "repo/b:latest", "repo/c:latest"}
	estimates := []int64{10, 20, 30}
	result, err := s.enqueueImageExports("local", ids, estimates, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if result.Started != len(ids) || len(result.Snapshot.Tasks) != len(ids)+1 {
		t.Fatalf("导出响应没有携带完整任务列表: %+v", result)
	}
	if result.Snapshot.Tasks[0].ID != historyID {
		t.Fatal("导出响应丢失了已有任务")
	}
	for i, id := range ids {
		task := result.Snapshot.Tasks[i+1]
		if task.ImageID != id || task.Total != estimates[i] || !task.TotalEstimated {
			t.Fatalf("导出任务没有保留大小估算: %+v", task)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for _, event := range events {
		for _, task := range event.Tasks {
			if task.Type == imageTaskTypeExport && task.Path == "" {
				t.Fatal("导出任务尚未初始化完成就发出了事件")
			}
		}
		if event.Revision > result.Snapshot.Revision {
			t.Fatal("响应快照比创建事件更旧")
		}
	}
}

func TestImageTaskSnapshotRevisionConsistency(t *testing.T) {
	s := &ImageService{}
	id := s.newImageTask(imageTaskTypeExport, "local", "repo:latest")
	var mu sync.Mutex
	versions := make(map[uint64]string)
	check := func(snapshot ImageTaskSnapshot) {
		data, err := json.Marshal(snapshot.Tasks)
		if err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if previous, ok := versions[snapshot.Revision]; ok && previous != string(data) {
			t.Errorf("同一版本 %d 对应不同任务状态", snapshot.Revision)
		}
		versions[snapshot.Revision] = string(data)
	}
	s.eventEmitter = func(name string, data any) {
		if name == imageTasksEventName {
			check(data.(ImageTaskSnapshot))
		}
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 64 {
				check(s.GetImageTasks())
				s.updateTask(id, func(task *imageTaskState) { task.Bytes++ })
			}
		}()
	}
	wg.Wait()
	snapshot := s.GetImageTasks()
	check(snapshot)
	if snapshot.Tasks[0].Bytes != 512 {
		t.Fatalf("并发更新丢失: %+v", snapshot)
	}
}
