package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/authn"
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
		if command != "ssh" || args[len(args)-1] != shellJoin([]string{"docker", "manifest", "inspect", "--verbose", "private/image:latest"}) {
			t.Fatalf("未使用 SSH CLI: %s %v", command, args)
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return []byte(`{"Descriptor":{"platform":{"os":"linux","architecture":"amd64"}}}`), nil
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
				if !reflect.DeepEqual(args, []string{"manifest", "inspect", "--verbose", "private/image:latest"}) {
					t.Fatalf("解析命令错误: %v", args)
				}
				return []byte(`[{"Descriptor":{"platform":{"os":"linux","architecture":"amd64"}}},{"Descriptor":{"platform":{"os":"linux","architecture":"arm64"}}}]`), nil
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
