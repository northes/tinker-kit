package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestNormalizeDockerCommand(t *testing.T) {
	if got, err := normalizeDockerCommand(""); err != nil || got != "" {
		t.Fatalf("empty = %q, %v", got, err)
	}
	if got, err := normalizeDockerCommand("/usr/bin/sudo -n /usr/bin/docker"); err != nil || got != "/usr/bin/sudo -n /usr/bin/docker" {
		t.Fatalf("prefix = %q, %v", got, err)
	}
	if _, err := normalizeDockerCommand("-docker"); err == nil {
		t.Fatal("expected reject for leading dash")
	}
	if _, err := normalizeDockerCommand("foo;bar"); err == nil {
		t.Fatal("expected reject for shell meta")
	}
	if _, err := normalizeDockerCommand(`echo "x"`); err == nil {
		t.Fatal("expected reject for quotes")
	}
}

func TestNormalizeImageSourceDockerCommand(t *testing.T) {
	seen := map[string]bool{}
	normalized, err := normalizeImageSource(ImageSource{ID: "ssh:1", Kind: "ssh", SSHProfileID: "p", DockerCommand: "  /usr/bin/sudo -n /usr/bin/docker  "}, seen, nil, map[string]string{"p": "prod"})
	if err != nil || normalized.DockerCommand != "/usr/bin/sudo -n /usr/bin/docker" {
		t.Fatalf("ssh docker command = %q, %v", normalized.DockerCommand, err)
	}
	if _, err := normalizeImageSource(ImageSource{ID: "ssh:2", Kind: "ssh", SSHProfileID: "p", DockerCommand: "docker;rm"}, map[string]bool{}, nil, nil); err == nil {
		t.Fatal("expected invalid docker command to fail save")
	}
	registry, err := normalizeImageSource(ImageSource{ID: "registry:1", Kind: "registry", RegistryURL: "https://registry.example", DockerCommand: "docker"}, map[string]bool{}, nil, nil)
	if err != nil || registry.DockerCommand != "" {
		t.Fatalf("registry docker command should be cleared, got %q, %v", registry.DockerCommand, err)
	}
}

func TestImageSourceDisplayCLI(t *testing.T) {
	cfg := Config{DockerCLIPath: "/bin/docker"}
	if got := imageSourceDisplayCLI(ImageSource{Kind: "local"}, cfg); got != "/bin/docker" {
		t.Fatalf("local cli = %q", got)
	}
	if got := imageSourceDisplayCLI(ImageSource{Kind: "ssh", DockerCommand: "/usr/bin/sudo -n docker"}, cfg); got != "/usr/bin/sudo -n docker" {
		t.Fatalf("ssh prefix = %q", got)
	}
}

func TestNormalizeDockerCommandRejectsControlAndOversize(t *testing.T) {
	for name, raw := range map[string]string{
		"换行":   "/usr/bin/docker\nrm",
		"回车":   "/usr/bin/docker\r",
		"DEL":  "/usr/bin/docker\x7f",
		"管道":   "docker | cat",
		"重定向":  "docker > /tmp/out",
		"变量":   "docker $HOME",
		"反斜杠":  `docker \x`,
		"超长":   "/usr/bin/docker" + strings.Repeat("a", 4096),
		"首项短横": "-n /usr/bin/docker",
	} {
		if _, err := normalizeDockerCommand(raw); err == nil {
			t.Fatalf("%s 应被拒绝: %q", name, raw)
		}
	}
	if got, err := normalizeDockerCommand("  \t "); err != nil || got != "" {
		t.Fatalf("纯空白应视为默认: %q, %v", got, err)
	}
	if got, err := normalizeDockerCommand("  /usr/bin/docker   --config\t/etc/docker  "); err != nil || got != "/usr/bin/docker --config /etc/docker" {
		t.Fatalf("空白分隔结果 = %q, %v", got, err)
	}
}

func TestNormalizeImageSourceClearsDockerCommandOutsideSSH(t *testing.T) {
	local, err := normalizeImageSource(ImageSource{ID: "local", Kind: "local", DockerCommand: "docker"}, map[string]bool{}, nil, nil)
	if err != nil || local.DockerCommand != "" {
		t.Fatalf("本机来源应清空命令前缀: %q, %v", local.DockerCommand, err)
	}
	registry, err := normalizeImageSource(ImageSource{ID: "registry:1", Kind: "registry", RegistryURL: "https://registry.example", DockerCommand: "docker"}, map[string]bool{}, nil, nil)
	if err != nil || registry.DockerCommand != "" {
		t.Fatalf("registry 来源应清空命令前缀: %q, %v", registry.DockerCommand, err)
	}
}

func TestImageRemoteEnvCacheKeySeparatesConnectionAndPrefix(t *testing.T) {
	base := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box", SSHPort: 22, SSHUsername: "dev"}
	otherUser := base
	otherUser.SSHUsername = "root"
	otherPort := base
	otherPort.SSHPort = 2222
	withJump := base
	withJump.SSHJump = []SSHConnection{{Host: "jump", Port: 22, Username: "dev"}}

	key := imageRemoteEnvCacheKey(base, "")
	if key != imageRemoteEnvCacheKey(base, "") {
		t.Fatal("同一连接应得到同一缓存键")
	}
	if key == imageRemoteEnvCacheKey(base, "/usr/bin/docker") {
		t.Fatal("命令前缀应参与缓存键")
	}
	for name, other := range map[string]ImageSource{"用户": otherUser, "端口": otherPort, "跳板": withJump} {
		if key == imageRemoteEnvCacheKey(other, "") {
			t.Fatalf("%s 变化后不应复用缓存: %s", name, key)
		}
	}
}

func cachedImageService(source ImageSource, env remoteCommandEnv) *ImageService {
	service := &ImageService{remoteEnv: map[string]remoteCommandEnv{}}
	env.resolvedAt = time.Now()
	service.remoteEnv[imageRemoteEnvCacheKey(source, "")] = env
	return service
}

func TestImageSSHCommandLineUsesProbedPath(t *testing.T) {
	source := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box", SSHUsername: "dev"}
	service := cachedImageService(source, remoteCommandEnv{path: "/usr/local/bin:/usr/bin", commands: map[string]bool{"docker": true}})
	line, label, err := service.imageSSHCommandLine(context.Background(), source, []string{"image", "ls"})
	if err != nil {
		t.Fatalf("解析命令失败: %v", err)
	}
	if label != "docker" {
		t.Fatalf("错误信息命令名应为 docker: %q", label)
	}
	if want := "PATH='/usr/local/bin:/usr/bin' 'docker' 'image' 'ls'"; line != want {
		t.Fatalf("命令串 = %q, 期望 %q", line, want)
	}
}

func TestImageSSHCommandLineReportsMissingDocker(t *testing.T) {
	source := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box"}
	service := cachedImageService(source, remoteCommandEnv{path: "/usr/bin", commands: map[string]bool{"docker": false}})
	if _, _, err := service.imageSSHCommandLine(context.Background(), source, []string{"image", "ls"}); err == nil || localizedErrorKey(err) != "errors.service.remoteCommandMissing" {
		t.Fatalf("探测成功但缺少 docker 时应直接报未找到: %v", err)
	}
	if _, _, err := service.sshArchitectureProbeCommand(context.Background(), source); err == nil || localizedErrorKey(err) != "errors.service.remoteCommandMissing" {
		t.Fatalf("连接探测也不应再 exec 一次: %v", err)
	}
}

func TestImageSSHCommandLineFallsBackWhenProbeFails(t *testing.T) {
	// 没有凭据时 Go 的 SSH 客户端无法建链，探测必然失败，用来模拟探测本身没有结论。
	source := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box"}
	service := &ImageService{}
	line, label, err := service.imageSSHCommandLine(context.Background(), source, []string{"image", "ls"})
	if err != nil {
		t.Fatalf("探测失败不应阻断命令: %v", err)
	}
	if label != "docker" || line != "'docker' 'image' 'ls'" {
		t.Fatalf("应退回裸 docker: line=%q label=%q", line, label)
	}
	probe, _, err := service.sshArchitectureProbeCommand(context.Background(), source)
	if err != nil {
		t.Fatalf("探测失败时连接探测不应报错: %v", err)
	}
	if want := "uname -m && exec 'docker' --version"; probe != want {
		t.Fatalf("连接探测命令 = %q, 期望 %q", probe, want)
	}
}

func TestImageSSHCommandLineUsesCustomPrefix(t *testing.T) {
	source := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box", DockerCommand: "/usr/bin/sudo -n /usr/bin/docker"}
	service := &ImageService{}
	line, label, err := service.imageSSHCommandLine(context.Background(), source, []string{"image", "ls"})
	if err != nil {
		t.Fatalf("自定义前缀解析失败: %v", err)
	}
	if want := "'/usr/bin/sudo' '-n' '/usr/bin/docker' 'image' 'ls'"; line != want {
		t.Fatalf("命令串 = %q, 期望 %q", line, want)
	}
	if label != "sudo" {
		t.Fatalf("错误信息命令名应为 sudo: %q", label)
	}
	probe, _, err := service.sshArchitectureProbeCommand(context.Background(), source)
	if err != nil {
		t.Fatalf("自定义前缀连接探测失败: %v", err)
	}
	if want := "uname -m && exec '/usr/bin/sudo' '-n' '/usr/bin/docker' '--version'"; probe != want {
		t.Fatalf("连接探测命令 = %q, 期望 %q", probe, want)
	}
}

func TestImageSSHInputKeepsStdinAndPrefix(t *testing.T) {
	source := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box", DockerCommand: "/usr/bin/sudo -n /usr/bin/docker"}
	service := &ImageService{}
	line, _, err := service.imageSSHCommandLine(context.Background(), source, []string{"image", "load"})
	if err != nil {
		t.Fatalf("load 命令解析失败: %v", err)
	}
	if want := "'/usr/bin/sudo' '-n' '/usr/bin/docker' 'image' 'load'"; line != want {
		t.Fatalf("load 命令 = %q, 期望 %q", line, want)
	}
	if strings.Contains(line, "-S") {
		t.Fatalf("应用不应插入 sudo -S: %q", line)
	}
}

func TestImageSourceFingerprintTracksDockerCommand(t *testing.T) {
	base := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box", SSHPort: 22, SSHUsername: "dev"}
	before := imageSourceFingerprint(base, imageSourceDisplayCLI(base, Config{}))
	changed := base
	changed.DockerCommand = "/usr/bin/sudo -n /usr/bin/docker"
	after := imageSourceFingerprint(changed, imageSourceDisplayCLI(changed, Config{}))
	if before == after {
		t.Fatal("修改命令前缀后指纹应变化")
	}
	other := base
	other.DockerCommand = "/usr/bin/docker"
	if after == imageSourceFingerprint(other, imageSourceDisplayCLI(other, Config{})) {
		t.Fatal("不同命令前缀不应共用指纹")
	}
}

func TestTestImageSourceConnectionRejectsInvalidDockerCommandWithoutSSH(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	called := false
	service := &ImageService{config: config, runner: func(context.Context, string, ...string) ([]byte, error) {
		called = true
		return nil, nil
	}}
	err := service.TestImageSourceConnection(ImageSource{ID: "ssh:draft", Kind: "ssh", SSHHost: "dev-box", DockerCommand: "/usr/bin/docker;rm -rf /"})
	if err == nil || localizedErrorKey(err) != "errors.config.dockerCommandInvalid" {
		t.Fatalf("非法命令前缀应在发起 SSH 前被拒绝: %v", err)
	}
	if called {
		t.Fatal("校验失败时不应执行任何命令")
	}
	if got := config.Get().ImageSources; len(got) != 1 || got[0].DockerCommand != "" {
		t.Fatalf("连接测试不应写入配置: %#v", got)
	}
}
