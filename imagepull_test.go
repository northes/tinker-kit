package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
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
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

func TestCLIPullPlatforms(t *testing.T) {
	for _, scenario := range []struct {
		name, data string
		expected   []string
		invalid    bool
	}{
		{name: "多架构与证明过滤", data: `[{"Descriptor":{"platform":{"os":"linux","architecture":"arm64","variant":"v8"}}},{"Descriptor":{"platform":{"os":"linux","architecture":"amd64"}}},{"Descriptor":{"platform":{"os":"unknown","architecture":"unknown"}}},{"Descriptor":{"platform":{"os":"linux","architecture":"amd64"}}}]`, expected: []string{"linux/amd64", "linux/arm64/v8"}},
		{name: "单架构", data: `{"Descriptor":{"platform":{"os":"linux","architecture":"amd64"}}}`, expected: []string{"linux/amd64"}},
		{name: "缺少平台", data: `{"Descriptor":{}}`, invalid: true},
		{name: "损坏数据", data: `not json`, invalid: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			actual, err := cliManifestPlatforms([]byte(scenario.data))
			if scenario.invalid {
				if err == nil {
					t.Fatal("未传播解析失败")
				}
				return
			}
			if err != nil || !reflect.DeepEqual(actual, scenario.expected) {
				t.Fatalf("架构不正确: %v, %v", actual, err)
			}
		})
	}
}

func TestResolvePullPlatformsUsesSSHCLIAndCancellation(t *testing.T) {
	source := ImageSource{Kind: "ssh", SSHHost: "test-host"}
	calls := 0
	s := &ImageService{runner: func(ctx context.Context, command string, args ...string) ([]byte, error) {
		calls++
		if command != "ssh" || args[len(args)-1] != shellJoin([]string{"docker", "buildx", "imagetools", "inspect", "--raw", "private/image:latest"}) {
			t.Fatalf("未使用 SSH CLI: %s %v", command, args)
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return []byte(`{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}`), nil
	}}
	actual, err := s.resolveImagePullPlatforms(context.Background(), source, "docker", "private/image:latest", ImagePullOptions{})
	if err != nil || !reflect.DeepEqual(actual, []string{"linux/amd64"}) || calls != 1 {
		t.Fatalf("解析结果不正确: %v, %v", actual, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.resolveImagePullPlatforms(ctx, source, "docker", "private/image:latest", ImagePullOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("未传播取消: %v", err)
	}
}

func TestRegistryPullExplicitCredentialsAndPlatform(t *testing.T) {
	originServer := importTestRegistry(t, "reader", "secret", nil)
	targetServer := importTestRegistry(t, "writer", "target-secret", nil)
	origin := ImageSource{Kind: "registry", RegistryURL: originServer.URL, RegistryUsername: "reader", RegistryPassword: "secret"}
	target := ImageSource{ID: "target", Kind: "registry", RegistryURL: targetServer.URL, RegistryUsername: "writer", RegistryPassword: "target-secret"}
	s := importTestService(target)
	s.registryTransport = targetServer.Client().Transport
	ref, _ := importTarget(origin, "source:latest")
	if err := remote.WriteIndex(ref, importTestIndex(t, 1024), remote.WithTransport(originServer.Client().Transport), remote.WithAuth(&authn.Basic{Username: "reader", Password: "secret"})); err != nil {
		t.Fatal(err)
	}
	options := ImagePullOptions{Username: "reader", Password: "secret", Platform: "linux/arm64"}
	platforms, err := s.ResolveImagePullPlatforms(context.Background(), target.ID, ref.Name(), options)
	if err != nil || !reflect.DeepEqual(platforms, []string{"linux/amd64", "linux/arm64"}) {
		t.Fatalf("使用显式凭据解析失败: %v, %v", platforms, err)
	}
	change := DockerImageReferenceChange{Source: ref.Name(), Target: "dest:arm64"}
	if _, err := s.StartRegistryImagePulls(target.ID, []DockerImageReferenceChange{change}, options); err != nil {
		t.Fatal(err)
	}
	s.exportWG.Wait()
	task := s.GetImageTasks().Tasks[0]
	if task.Status != imageTaskSuccess {
		t.Fatalf("拉取失败: %+v", task)
	}
	targetRef, _ := importTarget(target, change.Target)
	descriptor, err := remote.Get(targetRef, s.registryTransferOptions(context.Background(), target)...)
	if err != nil {
		t.Fatal(err)
	}
	if descriptor.MediaType.IsIndex() {
		t.Fatal("单架构仍复制完整索引")
	}
	image, err := descriptor.Image()
	if err != nil {
		t.Fatal(err)
	}
	config, err := image.ConfigFile()
	if err != nil || config.Architecture != "arm64" {
		t.Fatalf("未筛选 arm64: %+v %v", config, err)
	}
	if s.config.Get().ImageSources[0].RegistryUsername == "reader" {
		t.Fatal("拉取凭据污染目标配置")
	}
	s.taskMu.Lock()
	retained := s.tasks[task.ID].pullOptions
	s.taskMu.Unlock()
	if retained != options {
		t.Fatal("重试所需平台和凭据未保留")
	}
	singleRef, _ := importTarget(origin, "source:single")
	if err := remote.Write(singleRef, importTestImage(t, "arm64", 100), remote.WithTransport(originServer.Client().Transport), remote.WithAuth(&authn.Basic{Username: "reader", Password: "secret"})); err != nil {
		t.Fatal(err)
	}
	options.Platform = "linux/amd64"
	err = s.copyRegistryImage(context.Background(), "unused", target, origin, DockerImageReferenceChange{Source: singleRef.Name(), Target: "dest:wrong"}, options)
	if localizedErrorKey(err) != "errors.imageExport.pullPlatformUnavailable" {
		t.Fatalf("单架构镜像忽略了平台不匹配: %v", err)
	}
}

func TestCLIPullAllPlatformsAndSelectedPlatform(t *testing.T) {
	for _, scenario := range []struct {
		platform string
		expected []string
	}{
		{platform: "all", expected: []string{"image pull --platform linux/amd64 private/image:latest", "image pull --platform linux/arm64 private/image:latest"}},
		{platform: "linux/arm64", expected: []string{"image pull --platform linux/arm64 private/image:latest"}},
	} {
		t.Run(scenario.platform, func(t *testing.T) {
			dir := t.TempDir()
			logPath := filepath.Join(dir, "commands")
			cliPath := filepath.Join(dir, "docker")
			script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + shellQuote(logPath) + "\n"
			if err := os.WriteFile(cliPath, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			s := &ImageService{tasks: map[string]*imageTaskState{}, runner: func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if !reflect.DeepEqual(args, []string{"buildx", "imagetools", "inspect", "--raw", "private/image:latest"}) {
					t.Fatalf("解析命令错误: %v", args)
				}
				return []byte(`{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}`), nil
			}}
			id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypePull, SourceID: "local", ImageID: "private/image:latest"}})
			s.runImagePull(context.Background(), id, "private/image:latest", ImageSource{ID: "local", Kind: "local"}, cliPath, ImagePullOptions{Platform: scenario.platform})
			task := s.GetImageTasks().Tasks[0]
			if task.Status != imageTaskSuccess {
				t.Fatalf("CLI 拉取失败: %+v", task)
			}
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			actual := strings.Split(strings.TrimSpace(string(data)), "\n")
			if !reflect.DeepEqual(actual, scenario.expected) {
				t.Fatalf("拉取命令错误: %v", actual)
			}
		})
	}
}

func TestResolveCLIPullPlatformsOnlyFetchesMissingMetadata(t *testing.T) {
	digest := func(character string) string { return "sha256:" + strings.Repeat(character, 64) }
	child := "index.docker.io/private/image@" + digest("a")
	leaf := "index.docker.io/private/image@" + digest("b")
	root := `{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[
 {"platform":{"os":"linux","architecture":"amd64"}},
 {"platform":{"os":"linux","architecture":"unknown"}},
 {"annotations":{"vnd.docker.reference.type":"attestation-manifest"}},
 {"mediaType":"application/vnd.oci.image.index.v1+json","digest":"` + digest("a") + `"},
 {"digest":"` + digest("b") + `","platform":{"architecture":"s390x"}},
 {"digest":"` + digest("b") + `"}]}`
	var commands [][]string
	s := &ImageService{runner: func(ctx context.Context, _ string, args ...string) ([]byte, error) {
		commands = append(commands, append([]string(nil), args...))
		switch args[len(args)-1] {
		case "private/image:latest":
			return []byte(root), nil
		case child:
			return []byte(`{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"arm64","variant":"v8"}}]}`), nil
		case leaf:
			return []byte(`{"Descriptor":{"platform":{"os":"linux","architecture":"s390x"}}}`), nil
		default:
			t.Fatalf("不应读取完整平台、证明或镜像层: %v", args)
			return nil, nil
		}
	}}
	actual, err := s.resolveImagePullPlatforms(context.Background(), ImageSource{Kind: "local"}, "docker", "private/image:latest", ImagePullOptions{})
	expected := []string{"linux/amd64", "linux/arm64/v8", "linux/s390x"}
	if err != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("解析结果错误: %v, %v", actual, err)
	}
	expectedCommands := [][]string{{"buildx", "imagetools", "inspect", "--raw", "private/image:latest"}, {"buildx", "imagetools", "inspect", "--raw", child}, {"manifest", "inspect", "--verbose", leaf}}
	if !reflect.DeepEqual(commands, expectedCommands) {
		t.Fatalf("应只请求顶层、嵌套索引和一个缺失信息的叶子: %v", commands)
	}
}

func TestResolveCLIPullPlatformsSingleImageAndErrors(t *testing.T) {
	for _, scenario := range []struct {
		name string
		raw  string
		fail error
	}{
		{name: "单平台", raw: `{"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{}}`},
		{name: "损坏索引", raw: `invalid`},
		{name: "命令失败", fail: errors.New("registry unavailable")},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			calls := 0
			s := &ImageService{runner: func(context.Context, string, ...string) ([]byte, error) {
				calls++
				if calls == 1 {
					return []byte(scenario.raw), scenario.fail
				}
				return []byte(`{"Descriptor":{"platform":{"os":"linux","architecture":"arm64"}}}`), nil
			}}
			actual, err := s.resolveImagePullPlatforms(context.Background(), ImageSource{Kind: "local"}, "docker", "private/image:latest", ImagePullOptions{})
			if scenario.name == "单平台" {
				if err != nil || calls != 2 || !reflect.DeepEqual(actual, []string{"linux/arm64"}) {
					t.Fatalf("单平台应补查配置: %v, %v, %d", actual, err, calls)
				}
			} else if err == nil || calls != 1 {
				t.Fatalf("错误应立即传播，不回退到完整解析: %v, %d", err, calls)
			}
		})
	}
}

// 显式启用后用真实 Buildx 访问本地 Registry，统计网络请求，不依赖外网。
func TestResolveCLIPullPlatformsLiveRequests(t *testing.T) {
	if os.Getenv("TINKERKIT_TEST_BUILDX") == "" {
		t.Skip("未启用本地 Buildx 集成验证")
	}
	var rootReads, childReads, blobReads atomic.Int32
	var rootDigest string
	handler := registry.New()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if strings.Contains(r.URL.Path, "/blobs/") {
				blobReads.Add(1)
			}
			if strings.Contains(r.URL.Path, "/manifests/") {
				if strings.HasSuffix(r.URL.Path, "/latest") || strings.HasSuffix(r.URL.Path, "/"+rootDigest) {
					rootReads.Add(1)
				} else {
					childReads.Add(1)
				}
			}
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	ref, err := name.NewTag(strings.TrimPrefix(server.URL, "http://")+"/test:latest", name.Insecure)
	if err != nil {
		t.Fatal(err)
	}
	index := mutate.AppendManifests(empty.Index,
		mutate.IndexAddendum{Add: importTestImage(t, "amd64", 10), Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: "amd64"}}},
		mutate.IndexAddendum{Add: importTestImage(t, "arm64", 10), Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: "arm64"}}},
		mutate.IndexAddendum{Add: importTestImage(t, "unknown", 10), Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "unknown", Architecture: "unknown"}}},
	)
	digest, err := index.Digest()
	if err != nil {
		t.Fatal(err)
	}
	rootDigest = digest.String()
	if err := remote.WriteIndex(ref, index); err != nil {
		t.Fatal(err)
	}
	rootReads.Store(0)
	childReads.Store(0)
	blobReads.Store(0)
	s := &ImageService{}
	actual, err := s.resolveImagePullPlatforms(context.Background(), ImageSource{Kind: "local"}, "docker", ref.Name(), ImagePullOptions{})
	if err != nil || !reflect.DeepEqual(actual, []string{"linux/amd64", "linux/arm64"}) {
		t.Fatalf("真实 Buildx 解析失败: %v, %v", actual, err)
	}
	if rootReads.Load() != 1 || childReads.Load() != 0 || blobReads.Load() != 0 {
		t.Fatalf("产生不必要的请求: root=%d child=%d blob=%d", rootReads.Load(), childReads.Load(), blobReads.Load())
	}
	t.Logf("真实 Buildx 请求: 顶层索引 GET=%d，子 manifest GET=%d，配置/层 GET=%d", rootReads.Load(), childReads.Load(), blobReads.Load())
}
