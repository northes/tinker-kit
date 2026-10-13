package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/layout"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
)

func importTestImage(t *testing.T, arch string, size int64) v1.Image {
	t.Helper()
	image, err := random.Image(size, 1)
	if err != nil {
		t.Fatal(err)
	}
	config, err := image.ConfigFile()
	if err != nil {
		t.Fatal(err)
	}
	config.OS, config.Architecture = "linux", arch
	image, err = mutate.ConfigFile(image, config)
	if err != nil {
		t.Fatal(err)
	}
	return image
}

func importTestDockerTar(t *testing.T, images map[string]v1.Image) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "images.tar")
	refs := map[name.Tag]v1.Image{}
	for reference, image := range images {
		tag, err := name.NewTag(reference)
		if err != nil {
			t.Fatal(err)
		}
		refs[tag] = image
	}
	if err := tarball.MultiWriteToFile(filename, refs); err != nil {
		t.Fatal(err)
	}
	return filename
}

func importTestIndex(t *testing.T, size int64) v1.ImageIndex {
	t.Helper()
	var adds []mutate.IndexAddendum
	for _, arch := range []string{"arm64", "amd64"} {
		adds = append(adds, mutate.IndexAddendum{Add: importTestImage(t, arch, size), Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: arch}}})
	}
	return mutate.AppendManifests(empty.Index, adds...)
}

func importTestOCITar(t *testing.T, index v1.ImageIndex, reference string) string {
	t.Helper()
	return importTestOCITarWithAnnotations(t, index, map[string]string{"org.opencontainers.image.ref.name": reference, "io.containerd.image.name": reference})
}

func importTestOCITarWithAnnotations(t *testing.T, index v1.ImageIndex, annotations map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	l, err := layout.Write(dir, empty.Index)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.AppendIndex(index, layout.WithAnnotations(annotations)); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "oci.tar")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	err = filepath.WalkDir(dir, func(filename string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(filename)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, filename)
		if err != nil {
			return err
		}
		if err := writer.WriteHeader(&tar.Header{Name: filepath.ToSlash(rel), Size: int64(len(data)), Mode: 0o600}); err != nil {
			return err
		}
		_, err = writer.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestOCIImportUsesFullImageReference(t *testing.T) {
	index := importTestIndex(t, 20)
	for _, scenario := range []struct {
		name        string
		annotations map[string]string
		reference   string
		target      string
	}{
		{
			name:        "containerd 完整名称优先于 OCI tag",
			annotations: map[string]string{"io.containerd.image.name": "docker.io/library/golang:1.25.1", "org.opencontainers.image.ref.name": "1.25.1"},
			reference:   "golang:1.25.1", target: "golang:1.25.1",
		},
		{
			name:        "OCI 自带完整引用",
			annotations: map[string]string{"org.opencontainers.image.ref.name": "golang:1.25.1"},
			reference:   "golang:1.25.1", target: "golang:1.25.1",
		},
		{
			name:        "Docker Hub 用户命名空间保留",
			annotations: map[string]string{"io.containerd.image.name": "docker.io/example/golang:1.25.1", "org.opencontainers.image.ref.name": "1.25.1"},
			reference:   "example/golang:1.25.1", target: "example/golang:1.25.1",
		},
		{
			name:        "自定义 Registry 的 library 路径保留",
			annotations: map[string]string{"io.containerd.image.name": "registry.example.com/library/golang:1.25.1", "org.opencontainers.image.ref.name": "1.25.1"},
			reference:   "registry.example.com/library/golang:1.25.1", target: "registry.example.com/library/golang:1.25.1",
		},
		{
			name:        "只有 OCI tag 时要求用户填写仓库名",
			annotations: map[string]string{"org.opencontainers.image.ref.name": "1.25.1"},
			reference:   "1.25.1", target: "",
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			filename := importTestOCITarWithAnnotations(t, index, scenario.annotations)
			entries := archiveTestEntries(t, filename)
			if len(entries) != 1 || entries[0].Reference != scenario.reference || entries[0].Target != scenario.target {
				t.Fatalf("OCI 镜像名称解析不正确: %+v", entries)
			}
		})
	}
}

func importTestService(source ImageSource) *ImageService {
	return &ImageService{config: &ConfigService{cfg: normalizeConfig(Config{ImageSources: []ImageSource{source}})}, tasks: map[string]*imageTaskState{}}
}

func archiveTestEntries(t *testing.T, filename string) []ImageImportEntry {
	t.Helper()
	a, err := readImageArchive(context.Background(), filename)
	if err != nil {
		t.Fatal(err)
	}
	defer a.file.Close()
	return a.entries
}

func TestImageImportPreviewAndLocalRename(t *testing.T) {
	image := importTestImage(t, "amd64", 100)
	filename := importTestDockerTar(t, map[string]v1.Image{"myapp:1.0": image, "myapp:stable": image})
	original, _ := os.ReadFile(filename)
	s := importTestService(ImageSource{ID: "local", Kind: "local"})
	s.runner = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("myapp:1.0\nmyapp:stable\n"), nil
	}
	entries, err := s.prepareImageImportPaths(context.Background(), "local", []string{filename, filename})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || !entries[0].Conflict || !entries[1].Conflict {
		t.Fatalf("未识别包内多 Tag 或已有名称: %+v", entries)
	}
	if _, err := s.StartImageImports("local", entries); localizedErrorKey(err) != "errors.imageExport.importTargetExists" {
		t.Fatalf("未阻止覆盖已有名称: %v", err)
	}
	for i := range entries {
		entries[i].Target += "-amd64"
	}
	destination := filepath.Join(t.TempDir(), "loaded.tar")
	previous := execCommandContext
	t.Cleanup(func() { execCommandContext = previous })
	var loads atomic.Int32
	execCommandContext = func(ctx context.Context, command string, args ...string) *exec.Cmd {
		if !reflect.DeepEqual(args, []string{"image", "load"}) {
			t.Errorf("导入命令参数不正确: %v", args)
		}
		loads.Add(1)
		return exec.CommandContext(ctx, "sh", "-c", `cat > "$1"`, "import-test", destination)
	}
	result, err := s.StartImageImports("local", entries)
	if err != nil {
		t.Fatal(err)
	}
	s.exportWG.Wait()
	if result.Started != 1 || loads.Load() != 1 {
		t.Fatal("同一文件应只加载一次")
	}
	task := s.GetImageTasks().Tasks[0]
	if task.Status != imageTaskSuccess || task.Bytes <= 0 {
		t.Fatalf("导入任务未成功: %+v", task)
	}
	loaded := archiveTestEntries(t, destination)
	for _, entry := range loaded {
		if !strings.HasSuffix(entry.Target, "-amd64") {
			t.Fatalf("加载包仍携带旧引用: %+v", loaded)
		}
		if !reflect.DeepEqual(entry.Platforms, []string{"linux/amd64"}) {
			t.Fatalf("镜像架构丢失: %+v", entry)
		}
	}
	unchanged, _ := os.ReadFile(filename)
	if !bytes.Equal(original, unchanged) {
		t.Fatal("修改了用户原始 tar")
	}
	// 终态失败/取消后重试仍使用确认后的映射。
	s.updateTask(task.ID, func(task *imageTaskState) { task.Status = imageTaskCanceled })
	if _, err := s.RetryImageTask(task.ID); err != nil {
		t.Fatal(err)
	}
	s.exportWG.Wait()
	if loads.Load() != 2 {
		t.Fatal("重试没有重新加载")
	}
	for _, entry := range archiveTestEntries(t, destination) {
		if !strings.HasSuffix(entry.Target, "-amd64") {
			t.Fatal("重试恢复了旧引用")
		}
	}
}

func TestImageImportRejectsChangedDuplicateAndLateConflict(t *testing.T) {
	filename := importTestDockerTar(t, map[string]v1.Image{"repo:old": importTestImage(t, "arm64", 50)})
	entries := archiveTestEntries(t, filename)
	entries[0].Target = "repo:new"
	s := importTestService(ImageSource{ID: "local", Kind: "local"})
	s.runner = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	if err := s.checkImportTargets(context.Background(), ImageSource{Kind: "local"}, "docker", []ImageImportEntry{{Target: "repo:new"}, {Target: "docker.io/library/repo:new"}}); localizedErrorKey(err) != "errors.imageExport.importTargetDuplicate" {
		t.Fatalf("未识别规范化后的重复名称: %v", err)
	}
	// 用户确认后出现的新冲突必须在真正 load 前阻止。
	s.runner = func(context.Context, string, ...string) ([]byte, error) { return []byte("repo:new\n"), nil }
	id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypeLoad}})
	s.runPlannedImageImport(context.Background(), id, entries, ImageSource{Kind: "local"}, "docker")
	if key := localizedMessageKey(t, s.GetImageTasks().Tasks[0].Error); key != "errors.imageExport.importTargetExists" {
		t.Fatalf("未阻止执行时的冲突: %s", key)
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("changed"))
	file.Close()
	if _, err := s.StartImageImports("local", entries); localizedErrorKey(err) != "errors.imageExport.importArchiveChanged" {
		t.Fatalf("未识别预览后变化的 tar: %v", err)
	}
}

func TestImageImportInvalidArchive(t *testing.T) {
	for _, member := range []string{"../outside", "/absolute", "blobs/../../outside"} {
		t.Run(member, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "invalid.tar")
			file, _ := os.Create(filename)
			writer := tar.NewWriter(file)
			_ = writer.WriteHeader(&tar.Header{Name: member, Mode: 0o600})
			writer.Close()
			file.Close()
			if _, err := readImageArchive(context.Background(), filename); err == nil {
				t.Fatal("接受了不安全的 tar 路径")
			}
		})
	}
	for _, filename := range []string{filepath.Join(t.TempDir(), "missing.tar"), t.TempDir()} {
		if _, err := readImageArchive(context.Background(), filename); err == nil {
			t.Fatal("接受了不存在的文件或目录")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	filename := importTestDockerTar(t, map[string]v1.Image{"repo:tag": importTestImage(t, "amd64", 5)})
	if _, err := readImageArchive(ctx, filename); err != context.Canceled {
		t.Fatalf("没有传播预检取消: %v", err)
	}
}

func importTestRegistry(t *testing.T, username, password string, writes *atomic.Int32) *httptest.Server {
	t.Helper()
	handler := registry.New(registry.Logger(log.New(io.Discard, "", 0)))
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if username != "" {
			user, secret, ok := request.BasicAuth()
			if !ok || user != username || secret != password {
				writer.Header().Set("WWW-Authenticate", `Basic realm="test"`)
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
		if writes != nil && request.Method == http.MethodPut && strings.Contains(request.URL.Path, "/manifests/") {
			writes.Add(1)
		}
		handler.ServeHTTP(writer, request)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRegistryImportDockerAndOCIWithoutCLI(t *testing.T) {
	for _, format := range []string{"docker", "oci"} {
		t.Run(format, func(t *testing.T) {
			var writes atomic.Int32
			server := importTestRegistry(t, "", "", &writes)
			source := ImageSource{ID: "registry", Kind: "registry", RegistryURL: server.URL}
			s := importTestService(source)
			s.registryTransport = server.Client().Transport
			s.runner = func(context.Context, string, ...string) ([]byte, error) {
				t.Error("Registry 导入调用了 CLI")
				return nil, nil
			}
			index := importTestIndex(t, 500)
			filename := ""
			if format == "oci" {
				filename = importTestOCITar(t, index, "myapp:old")
			} else {
				filename = importTestDockerTar(t, map[string]v1.Image{"myapp:old": importTestImage(t, "amd64", 500)})
			}
			entries, err := s.prepareImageImportPaths(context.Background(), source.ID, []string{filename})
			if err != nil {
				t.Fatal(err)
			}
			if entries[0].Target != "myapp:old" {
				t.Fatalf("意外改变了目标仓库路径: %s", entries[0].Target)
			}
			entries[0].Target = "myapp:new"
			result, err := s.StartImageImports(source.ID, entries)
			if err != nil {
				t.Fatal(err)
			}
			s.exportWG.Wait()
			if result.Started != 1 {
				t.Fatal("没有创建导入任务")
			}
			task := s.GetImageTasks().Tasks[0]
			if task.Status != imageTaskSuccess {
				t.Fatalf("Registry 导入失败: %+v", task)
			}
			tag, _ := importTarget(source, entries[0].Target)
			descriptor, err := remote.Get(tag, s.registryTransferOptions(context.Background(), source)...)
			if err != nil {
				t.Fatal(err)
			}
			if format == "oci" {
				digest, _ := index.Digest()
				if descriptor.Digest != digest {
					t.Fatal("OCI 多架构索引发生变化")
				}
				if !reflect.DeepEqual(entries[0].Platforms, []string{"linux/amd64", "linux/arm64"}) {
					t.Fatalf("未展示全部架构: %+v", entries)
				}
			}
			before := writes.Load()
			preview, err := s.prepareImageImportPaths(context.Background(), source.ID, []string{filename})
			if err != nil {
				t.Fatal(err)
			}
			preview[0].Target = "myapp:new"
			if _, err := s.StartImageImports(source.ID, preview); localizedErrorKey(err) != "errors.imageExport.importTargetExists" {
				t.Fatalf("未阻止 Registry 覆盖: %v", err)
			}
			if writes.Load() != before {
				t.Fatal("冲突检查期间写入了 Registry")
			}
		})
	}
}

func TestOCIRenamePreservesIndexAndAnnotations(t *testing.T) {
	index := importTestIndex(t, 20)
	filename := importTestOCITar(t, index, "repo:old")
	a, err := readImageArchive(context.Background(), filename)
	if err != nil {
		t.Fatal(err)
	}
	defer a.file.Close()
	entries := a.entries
	entries[0].Target = "repo:new"
	output := filepath.Join(t.TempDir(), "renamed.tar")
	if err := a.writeRenamedTar(context.Background(), output, entries); err != nil {
		t.Fatal(err)
	}
	renamed, err := readImageArchive(context.Background(), output)
	if err != nil {
		t.Fatal(err)
	}
	defer renamed.file.Close()
	if renamed.index.Manifests[0].Digest != a.index.Manifests[0].Digest {
		t.Fatal("重命名改变了内容 digest")
	}
	annotations := renamed.index.Manifests[0].Annotations
	if annotations["org.opencontainers.image.ref.name"] != "repo:new" || annotations["io.containerd.image.name"] != "repo:new" {
		t.Fatalf("旧引用没有全部替换: %+v", annotations)
	}
	// 验证内容破坏被发现，而不是上传损坏的 layer。
	for member, location := range a.members {
		if strings.HasPrefix(member, "blobs/") && location.size > 0 {
			file, _ := os.OpenFile(filename, os.O_WRONLY, 0o600)
			_, _ = file.WriteAt([]byte{'x'}, location.offset)
			file.Close()
			break
		}
	}
	if err := a.extractOCI(context.Background(), t.TempDir()); err == nil {
		t.Fatal("接受了损坏的 OCI blob")
	}
}

func TestRegistryPullPreservesAllPlatformsLargeLayersAndCredentials(t *testing.T) {
	originServer := importTestRegistry(t, "reader", "source-secret", nil)
	targetServer := importTestRegistry(t, "writer", "target-secret", nil)
	origin := ImageSource{ID: "origin", Kind: "registry", RegistryURL: originServer.URL, RegistryUsername: "reader", RegistryPassword: "source-secret"}
	target := ImageSource{ID: "target", Kind: "registry", RegistryURL: targetServer.URL, RegistryUsername: "writer", RegistryPassword: "target-secret"}
	s := importTestService(target)
	s.registryTransport = targetServer.Client().Transport
	s.config.cfg.ImageSources = append(s.config.cfg.ImageSources, origin)
	s.runner = func(context.Context, string, ...string) ([]byte, error) {
		t.Error("Registry 拉取调用了 CLI")
		return nil, nil
	}
	index := importTestIndex(t, maxRegistryBodySize+1024)
	ref, _ := importTarget(origin, "source/image:latest")
	if err := remote.WriteIndex(ref, index, remote.WithTransport(originServer.Client().Transport), remote.WithAuth(&authn.Basic{Username: origin.RegistryUsername, Password: origin.RegistryPassword})); err != nil {
		t.Fatal(err)
	}
	change := DockerImageReferenceChange{Source: ref.Name(), Target: "destination/image:amd64-and-arm64"}
	if _, err := s.StartRegistryImagePulls(target.ID, []DockerImageReferenceChange{change}); err != nil {
		t.Fatal(err)
	}
	s.exportWG.Wait()
	task := s.GetImageTasks().Tasks[0]
	if task.Status != imageTaskSuccess {
		t.Fatalf("跨 Registry 拉取失败: %+v", task)
	}
	if task.ProgressUnit != "bytes" || task.Bytes <= maxRegistryBodySize || task.Completed != task.Bytes {
		t.Fatalf("Registry 拉取未按字节报告进度: %+v", task)
	}
	targetRef, _ := importTarget(target, change.Target)
	descriptor, err := remote.Get(targetRef, s.registryTransferOptions(context.Background(), target)...)
	if err != nil {
		t.Fatal(err)
	}
	digest, _ := index.Digest()
	if descriptor.Digest != digest {
		t.Fatal("跨 Registry 拉取改变了多架构索引")
	}
	got, err := descriptor.ImageIndex()
	if err != nil {
		t.Fatal(err)
	}
	manifest, _ := got.IndexManifest()
	if len(manifest.Manifests) != 2 {
		t.Fatal("跨 Registry 拉取遗漏架构")
	}
	for _, child := range manifest.Manifests {
		image, err := got.Image(child.Digest)
		if err != nil {
			t.Fatal(err)
		}
		layers, _ := image.Layers()
		reader, err := layers[0].Compressed()
		if err != nil {
			t.Fatal(err)
		}
		length, err := io.Copy(io.Discard, reader)
		reader.Close()
		if err != nil || length <= maxRegistryBodySize {
			t.Fatalf("大镜像层未完整复制: %d, %v", length, err)
		}
	}
	if _, err := s.StartRegistryImagePulls(target.ID, []DockerImageReferenceChange{change}); localizedErrorKey(err) != "errors.imageExport.importTargetExists" {
		t.Fatalf("允许覆盖已有 Registry 引用: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.copyRegistryImage(ctx, "unused", target, origin, DockerImageReferenceChange{Source: ref.Name(), Target: "repo:canceled"}); err == nil {
		t.Fatal("Registry 拉取没有响应取消")
	}
}

func TestRegistryTransferProgressStopsOnPreparationError(t *testing.T) {
	s := &ImageService{tasks: map[string]*imageTaskState{}}
	if err := s.withRegistryTransferProgress(context.Background(), "missing", ImageSource{}, func([]remote.Option) error { return io.ErrUnexpectedEOF }); err != io.ErrUnexpectedEOF {
		t.Fatal("解析错误未传播")
	}
}

func TestArchiveMetadataLimit(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "huge.tar")
	file, _ := os.Create(filename)
	writer := tar.NewWriter(file)
	_ = writer.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0o600, Size: maxRegistryBodySize + 1})
	_, _ = writer.Write(bytes.Repeat([]byte{' '}, maxRegistryBodySize+1))
	writer.Close()
	file.Close()
	if _, err := readImageArchive(context.Background(), filename); localizedErrorKey(err) != "errors.imageExport.importInvalidMetadata" {
		t.Fatalf("未限制元数据大小: %v", err)
	}
}

func TestDockerImportMultiImageTargetMapping(t *testing.T) {
	filename := importTestDockerTar(t, map[string]v1.Image{"one:tag": importTestImage(t, "amd64", 5), "two:tag": importTestImage(t, "arm64", 5)})
	a, err := readImageArchive(context.Background(), filename)
	if err != nil {
		t.Fatal(err)
	}
	defer a.file.Close()
	for i := range a.entries {
		a.entries[i].Target = a.entries[i].Reference + "-renamed"
	}
	_, data, err := a.renamedMetadata(a.entries)
	if err != nil {
		t.Fatal(err)
	}
	var manifest tarball.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, entry := range a.entries {
		if !reflect.DeepEqual(manifest[entry.Image].RepoTags, []string{entry.Target}) {
			t.Fatal("多镜像引用映射串位")
		}
	}
}

func TestRegistryImportRetryAfterPartialUpload(t *testing.T) {
	var rejectSecond atomic.Bool
	rejectSecond.Store(true)
	handler := registry.New(registry.Logger(log.New(io.Discard, "", 0)))
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if rejectSecond.Load() && request.Method == http.MethodPut && strings.HasSuffix(request.URL.Path, "/manifests/second") {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		handler.ServeHTTP(writer, request)
	}))
	defer server.Close()
	source := ImageSource{ID: "registry", Kind: "registry", RegistryURL: server.URL}
	s := importTestService(source)
	s.registryTransport = server.Client().Transport
	filename := importTestDockerTar(t, map[string]v1.Image{"repo:one": importTestImage(t, "amd64", 30), "repo:two": importTestImage(t, "arm64", 30)})
	entries := archiveTestEntries(t, filename)
	entries[0].Target, entries[1].Target = "repo:first", "repo:second"
	if _, err := s.StartImageImports(source.ID, entries); err != nil {
		t.Fatal(err)
	}
	s.exportWG.Wait()
	failed := s.GetImageTasks().Tasks[0]
	if failed.Status != imageTaskFailed {
		t.Fatalf("没有得到部分上传失败的任务: %+v", failed)
	}
	rejectSecond.Store(false)
	if _, err := s.StartImageImports(source.ID, entries); localizedErrorKey(err) != "errors.imageExport.importTargetExists" {
		t.Fatal("新导入不应复用既有引用")
	}
	if _, err := s.RetryImageTask(failed.ID); err != nil {
		t.Fatal(err)
	}
	s.exportWG.Wait()
	snapshot := s.GetImageTasks()
	if snapshot.Tasks[len(snapshot.Tasks)-1].Status != imageTaskSuccess {
		t.Fatalf("部分上传重试失败: %+v", snapshot.Tasks)
	}
	// 若其他客户端替换了本任务已上传的引用，不允许重试覆盖它。
	first, _ := importTarget(source, "repo:first")
	if err := remote.Write(first, importTestImage(t, "amd64", 60), s.registryTransferOptions(context.Background(), source)...); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryImageTask(failed.ID); localizedErrorKey(err) != "errors.imageExport.importTargetExists" {
		t.Fatalf("重试覆盖了其他客户端写入的镜像: %v", err)
	}
}

func TestImageImportMutationWaitCanBeCanceled(t *testing.T) {
	s := &ImageService{}
	release, err := s.acquireImageImportMutation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.acquireImageImportMutation(ctx); err != context.Canceled {
		t.Fatalf("排队写入没有响应取消: %v", err)
	}
}
