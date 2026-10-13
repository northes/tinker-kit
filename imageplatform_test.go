package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

func TestNormalizeImageArchitectureAliases(t *testing.T) {
	for _, scenario := range []struct{ input, expected string }{
		{"x86_64", "amd64"}, {"X64", "amd64"}, {"aarch64\n", "arm64"}, {"arm64", "arm64"},
		{"i686", "386"}, {"armv7l", "arm"}, {"ppc64le", "ppc64le"}, {"riscv64", "riscv64"}, {"unknown", ""}, {"", ""},
		{"Docker version 29.0.0", ""},
	} {
		if actual := normalizeImageArchitecture(scenario.input); actual != scenario.expected {
			t.Fatalf("架构 %q 规范化为 %q，期望 %q", scenario.input, actual, scenario.expected)
		}
	}
}

func TestSSHArchitectureProbeUsesSingleConnectionAndPropagatesErrors(t *testing.T) {
	for _, scenario := range []struct {
		output   string
		expected string
		fail     bool
	}{
		{output: "aarch64\nDocker version 29.0.0\n", expected: "arm64"},
		{output: "x86_64\r\nDocker version 29.0.0\r\n", expected: "amd64"},
		{output: "Docker version 29.0.0\n", fail: true},
	} {
		calls := 0
		s := &ImageService{runner: func(_ context.Context, command string, args ...string) ([]byte, error) {
			calls++
			if command != "ssh" {
				t.Fatalf("没有复用 SSH 执行入口: %s", command)
			}
			return []byte(scenario.output), nil
		}}
		status, err := s.probeSourceConnection(context.Background(), ImageSource{Kind: "ssh", SSHHost: "test-host"}, "docker")
		if calls != 1 {
			t.Fatalf("架构探测产生 %d 次远程连接", calls)
		}
		if scenario.fail {
			if err == nil || status.Available {
				t.Fatal("不完整的架构响应没有报错")
			}
		} else if err != nil || !status.Available || status.Architecture != scenario.expected || status.LocalArchitecture == "" || status.Version != "Docker version 29.0.0" {
			t.Fatalf("SSH 主机架构或版本解析不正确: %+v, %v", status, err)
		}
	}
	s := &ImageService{runner: func(context.Context, string, ...string) ([]byte, error) { return nil, context.Canceled }}
	if _, err := s.probeSourceConnection(context.Background(), ImageSource{Kind: "ssh", SSHHost: "test-host"}, "docker"); !errors.Is(err, context.Canceled) {
		t.Fatalf("SSH 架构探测没有传播取消: %v", err)
	}
}

func TestRegistryMetadataIncludesAllRunnableArchitectures(t *testing.T) {
	server := importTestRegistry(t, "", "", nil)
	source := ImageSource{ID: "reg", Kind: "registry", RegistryURL: server.URL}
	s := importTestService(source)
	s.registryTransport = server.Client().Transport
	amd64 := importTestImage(t, "amd64", 10)
	arm64 := importTestImage(t, "arm64", 10)
	proof := importTestImage(t, "unknown", 10)
	nested := mutate.AppendManifests(empty.Index, mutate.IndexAddendum{Add: arm64})
	index := mutate.AppendManifests(empty.Index,
		mutate.IndexAddendum{Add: amd64, Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: "amd64"}}},
		mutate.IndexAddendum{Add: nested},
		mutate.IndexAddendum{Add: proof, Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "unknown", Architecture: "unknown"}, Annotations: map[string]string{"vnd.docker.reference.type": "attestation-manifest"}}},
	)
	ref, _ := importTarget(source, "repo:multi")
	if err := remote.WriteIndex(ref, index, s.registryTransferOptions(context.Background(), source)...); err != nil {
		t.Fatal(err)
	}
	puller, err := remote.NewPuller(s.registryOptions(context.Background(), source)...)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := s.fetchRegistryImageMetadata(context.Background(), source, "repo:multi", puller)
	if err != nil {
		t.Fatal(err)
	}
	expected := []RegistryPlatform{{Architecture: "amd64", OS: "linux"}, {Architecture: "arm64", OS: "linux"}}
	if !reflect.DeepEqual(metadata.Platforms, expected) {
		t.Fatalf("多架构、嵌套索引或证明过滤不正确: %+v", metadata.Platforms)
	}
	ref, _ = importTarget(source, "repo:single")
	if err := remote.Write(ref, arm64, s.registryTransferOptions(context.Background(), source)...); err != nil {
		t.Fatal(err)
	}
	metadata, err = s.fetchRegistryImageMetadata(context.Background(), source, "repo:single", puller)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(metadata.Platforms, expected[1:]) {
		t.Fatalf("单架构元数据不正确: %+v", metadata.Platforms)
	}
}

func TestDockerWatchIncludesPlatformsAndDiffsArchitectureChanges(t *testing.T) {
	base := DockerImage{ID: "image", Name: "repo:latest", Tags: []string{"repo:latest"}}
	updated := dockerImageFromDetail(base, DockerImageDetail{Architecture: "aarch64", OS: "linux", Metadata: DockerImageMetadata{Variant: "v8"}})
	expected := []RegistryPlatform{{Architecture: "arm64", OS: "linux", Variant: "v8"}}
	if !reflect.DeepEqual(updated.Platforms, expected) {
		t.Fatalf("Docker watch 未补全架构: %+v", updated)
	}
	if dockerImagesEqual(base, updated) {
		t.Fatal("架构补全没有触发列表更新")
	}
	amended := updated
	amended.Platforms = []RegistryPlatform{{Architecture: "amd64", OS: "linux"}}
	if dockerImagesEqual(updated, amended) {
		t.Fatal("架构变化没有触发列表更新")
	}
	a := DockerImage{ID: "image", Platforms: []RegistryPlatform{{Architecture: "amd64"}, {Architecture: "arm64"}}}
	b := a
	b.Platforms = []RegistryPlatform{{Architecture: "arm64"}, {Architecture: "amd64"}}
	if !dockerImagesEqual(a, b) {
		t.Fatal("仅平台顺序变化应保持列表稳定")
	}
}
