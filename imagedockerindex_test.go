package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// 模拟 daemon 的 chunked HTTP 响应，同时记录通过 stdin 发出的请求。
func dockerIndexTestCLI(t *testing.T, body string, status int) (string, string) {
	t.Helper()
	dir := t.TempDir()
	requestPath := filepath.Join(dir, "request")
	cliPath := filepath.Join(dir, "docker")
	response := fmt.Sprintf("HTTP/1.1 %d Test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n%x\r\n%s\r\n0\r\n\r\n", status, len(body), body)
	script := "#!/bin/sh\ncat > " + shellQuote(requestPath) + "\nprintf '%s' " + shellQuote(response) + "\n"
	if err := os.WriteFile(cliPath, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return cliPath, requestPath
}

func dockerIndexTestBody(t *testing.T, platforms ...string) string {
	t.Helper()
	manifests := []map[string]any{}
	for _, architecture := range platforms {
		manifests = append(manifests, map[string]any{"Kind": "image", "Available": true, "Size": map[string]any{"Total": 1000}, "Descriptor": map[string]any{"mediaType": "application/vnd.oci.image.manifest.v1+json"}, "ImageData": map[string]any{"Platform": map[string]any{"os": "linux", "architecture": architecture}}})
	}
	// 索引支持但未下载的平台、证明、无效平台不能算作本地可用架构。
	manifests = append(manifests,
		map[string]any{"Kind": "image", "Available": false, "Size": map[string]any{"Total": 50}, "ImageData": map[string]any{"Platform": map[string]any{"os": "linux", "architecture": "ppc64le"}}},
		map[string]any{"Kind": "attestation", "Available": true, "Size": map[string]any{"Total": 10}},
		map[string]any{"Kind": "image", "Available": true, "ImageData": map[string]any{"Platform": map[string]any{"os": "unknown", "architecture": "unknown"}}},
	)
	body, err := json.Marshal(map[string]any{"Id": "sha256:" + strings.Repeat("a", 64), "Architecture": "s390x", "Os": "linux", "Size": 14, "Descriptor": map[string]any{"mediaType": "application/vnd.oci.image.index.v1+json"}, "Manifests": manifests})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestDockerIndexAvailablePlatformsReachWatch(t *testing.T) {
	body := dockerIndexTestBody(t, "s390x", "arm64", "amd64", "arm64")
	cliPath, requestPath := dockerIndexTestCLI(t, body, 200)
	s := &ImageService{runner: func(context.Context, string, ...string) ([]byte, error) { return []byte("[" + body + "]"), nil }}
	detail, err := s.inspectDockerImage(context.Background(), ImageSource{Kind: "local"}, cliPath, "alpine:latest")
	if err != nil {
		t.Fatal(err)
	}
	row := dockerImageFromDetail(DockerImage{}, detail)
	if detail.Size != 4060 || row.SizeBytes != 4060 {
		t.Fatalf("镜像总大小应包含所有 manifest 的本地磁盘占用，不能沿用单平台大小: detail=%d row=%d", detail.Size, row.SizeBytes)
	}
	expected := []RegistryPlatform{{OS: "linux", Architecture: "amd64"}, {OS: "linux", Architecture: "arm64"}, {OS: "linux", Architecture: "s390x"}}
	if !reflect.DeepEqual(row.Platforms, expected) {
		t.Fatalf("列表应包含本地可用平台，而非默认 s390x 或未下载的平台: %+v", row.Platforms)
	}
	if detail.Index == nil || len(detail.Index.Manifests) != 3 {
		t.Fatalf("详情平台没有同步: %+v", detail.Index)
	}
	request, err := os.ReadFile(requestPath)
	if err != nil || !strings.HasPrefix(string(request), "GET /images/alpine:latest/json?manifests=true HTTP/1.1\r\n") {
		t.Fatalf("本地 manifest 请求不正确: %q, %v", request, err)
	}
}

func TestDockerIndexPlatformAvailabilityDoesNotUseImmutableCache(t *testing.T) {
	body := dockerIndexTestBody(t, "arm64")
	cliPath, _ := dockerIndexTestCLI(t, body, 200)
	cfg := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(Config{DockerCLIPath: cliPath, ImageSources: []ImageSource{{ID: "local", Kind: "local"}}})}
	s := NewImageService(cfg)
	defer s.shutdown()
	s.cacheDir = t.TempDir()
	s.runner = func(context.Context, string, ...string) ([]byte, error) { return []byte("[" + body + "]"), nil }
	id := "sha256:" + strings.Repeat("a", 64)
	first, err := s.InspectDockerImage("local", id)
	if err != nil {
		t.Fatal(err)
	}
	if first.Index == nil || len(first.Index.Manifests) != 1 {
		t.Fatalf("首次平台错误: %+v", first.Index)
	}
	// 相同索引摘要增加了本地平台；缓存不能把它当作不可变的远端索引。
	body = dockerIndexTestBody(t, "arm64", "s390x")
	nextCLI, _ := dockerIndexTestCLI(t, body, 200)
	script, err := os.ReadFile(nextCLI)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliPath, script, 0700); err != nil {
		t.Fatal(err)
	}
	second, err := s.InspectDockerImage("local", id)
	if err != nil {
		t.Fatal(err)
	}
	if second.Index == nil || len(second.Index.Manifests) != 2 {
		t.Fatalf("相同摘要的新平台被旧缓存隐藏: %+v", second.Index)
	}
}

func TestDockerIndexErrorsAndCancellation(t *testing.T) {
	cliPath, _ := dockerIndexTestCLI(t, `{"message":"No such image"}`, 404)
	s := &ImageService{}
	if _, err := s.inspectDockerIndex(context.Background(), ImageSource{Kind: "local"}, cliPath, "missing:latest"); err == nil || !strings.Contains(err.Error(), "No such image") {
		t.Fatalf("daemon 错误未传播: %v", err)
	}
	cliPath, _ = dockerIndexTestCLI(t, `invalid`, 200)
	if _, err := s.inspectDockerIndex(context.Background(), ImageSource{Kind: "local"}, cliPath, "alpine:latest"); localizedErrorKey(err) != "errors.image.dockerDetailParseFailed" {
		t.Fatalf("无效响应未报解析错误: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.inspectDockerIndex(ctx, ImageSource{Kind: "local"}, cliPath, "alpine:latest"); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消未传播: %v", err)
	}
}

// 显式设置本地多架构镜像名后运行，只读验证真实 daemon，不拉取或修改镜像。
func TestDockerIndexLive(t *testing.T) {
	reference := os.Getenv("TINKERKIT_TEST_LOCAL_MULTI_IMAGE")
	if reference == "" {
		t.Skip("未指定本地多架构镜像")
	}
	s := &ImageService{}
	detail, err := s.inspectDockerImage(context.Background(), ImageSource{Kind: "local"}, "docker", reference)
	if err != nil {
		t.Fatal(err)
	}
	row := dockerImageFromDetail(DockerImage{}, detail)
	if len(row.Platforms) < 2 {
		t.Fatalf("本地多架构镜像只读到单个平台: %+v", row.Platforms)
	}
	output, err := s.runDockerSnapshotContext(context.Background(), ImageSource{Kind: "local"}, "docker", []string{"image", "ls", "--format", "{{.Size}}", reference})
	if err != nil {
		t.Fatal(err)
	}
	listedSize := parseDockerImageSize(strings.TrimSpace(string(output)))
	difference := detail.Size - listedSize
	if difference < 0 {
		difference = -difference
	}
	// CLI 大小只保留约三位有效数字；应用保留精确字节数。
	if listedSize <= 0 || difference > listedSize/100 {
		t.Fatalf("本地镜像总大小与 Docker 列表不一致: detail=%d list=%q", detail.Size, output)
	}
	t.Logf("本地镜像总大小: %d 字节，Docker 列表: %s", detail.Size, strings.TrimSpace(string(output)))
	t.Logf("本地实际可用平台: %+v", row.Platforms)
}

func TestDockerIndexSSHTransportCarriesRequest(t *testing.T) {
	cliPath, requestPath := dockerIndexTestCLI(t, dockerIndexTestBody(t, "amd64", "s390x"), 200)
	script, err := os.ReadFile(cliPath)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(cliPath)
	if err := os.WriteFile(filepath.Join(dir, "ssh"), script, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	s := &ImageService{}
	item, err := s.inspectDockerIndex(context.Background(), ImageSource{Kind: "ssh", SSHHost: "test-host"}, "docker", "repo/alpine:latest")
	if err != nil || item.Architecture != "s390x" {
		t.Fatalf("SSH 未传回 daemon 响应: %+v, %v", item, err)
	}
	request, err := os.ReadFile(requestPath)
	if err != nil || !strings.Contains(string(request), "repo%2Falpine:latest/json?manifests=true") {
		t.Fatalf("SSH stdin 请求丢失: %q, %v", request, err)
	}
}
