package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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

// fakeRemoteEnvProbeOutput 模拟登录 shell 的 PATH 探测结果：docker 位于 /usr/bin。
const fakeRemoteEnvProbeOutput = "__TK_PATH__ /usr/bin\n__TK_CWD__ /home/dev\n__TK_CMD__ docker /usr/bin/docker\n"

// withRemoteEnvProbe 让登录 PATH 探测直接成功，测试只观察连接与 docker 探测本身。
func withRemoteEnvProbe(run imageCommandRunner) imageCommandRunner {
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "ssh" && len(args) > 0 && strings.Contains(args[len(args)-1], "'-lc'") {
			return []byte(fakeRemoteEnvProbeOutput), nil
		}
		return run(ctx, name, args...)
	}
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

// 无保存凭据的来源（依赖 ssh-agent 或 ~/.ssh/config）同样要探测登录 PATH，不能直接退回裸 docker。
func TestImageSSHCommandLineProbesPathWithoutSavedCredentials(t *testing.T) {
	source := ImageSource{ID: "ssh:agent", Kind: "ssh", SSHHost: "box", SSHUsername: "dev"}
	var probes int
	service := &ImageService{runner: func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "ssh" {
			t.Fatalf("无凭据来源应经系统 ssh 探测: %s %#v", name, args)
		}
		probes++
		return []byte("__TK_PATH__ /opt/bin:/usr/bin\n__TK_CWD__ /home/dev\n__TK_CMD__ docker /opt/bin/docker\n"), nil
	}}
	line, label, err := service.imageSSHCommandLine(context.Background(), source, []string{"images"})
	if err != nil {
		t.Fatalf("解析命令失败: %v", err)
	}
	if want := "PATH='/opt/bin:/usr/bin' 'docker' 'images'"; line != want || label != "docker" {
		t.Fatalf("命令串 = %q (%q), 期望 %q", line, label, want)
	}
	if probes != 1 {
		t.Fatalf("应探测一次登录 PATH: %d", probes)
	}
}

func TestImageSSHCommandLineReportsMissingDocker(t *testing.T) {
	source := ImageSource{ID: "ssh:a", Kind: "ssh", SSHHost: "box"}
	service := cachedImageService(source, remoteCommandEnv{path: "/usr/bin", commands: map[string]bool{"docker": false}})
	if _, _, err := service.imageSSHCommandLine(context.Background(), source, []string{"image", "ls"}); err == nil || localizedErrorKey(err) != "errors.service.remoteCommandMissing" {
		t.Fatalf("探测成功但缺少 docker 时应直接报未找到: %v", err)
	}
	if _, _, err := service.sshArchitectureProbeCommand(context.Background(), source, imageDaemonProbeArgs); err == nil || localizedErrorKey(err) != "errors.service.remoteCommandMissing" {
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
	probe, _, err := service.sshArchitectureProbeCommand(context.Background(), source, imageDaemonProbeArgs)
	if err != nil {
		t.Fatalf("探测失败时连接探测不应报错: %v", err)
	}
	if want := "uname -m && exec 'docker' 'info' '--format' '{{.ServerVersion}}'"; probe != want {
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
	probe, _, err := service.sshArchitectureProbeCommand(context.Background(), source, imageDaemonProbeArgs)
	if err != nil {
		t.Fatalf("自定义前缀连接探测失败: %v", err)
	}
	if want := "uname -m && exec '/usr/bin/sudo' '-n' '/usr/bin/docker' 'info' '--format' '{{.ServerVersion}}'"; probe != want {
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

func TestImageSSHCommandLineUsesAbsoluteDockerPathWithSudoPassword(t *testing.T) {
	source := ImageSource{Kind: "ssh", SSHHost: "box", SudoPassword: " dummy password "}
	for _, tc := range []struct {
		probePath string
		wantPath  string
	}{
		{probePath: "/opt/docker bin/docker", wantPath: "/opt/docker bin/docker"},
		{probePath: "./bin/docker", wantPath: "/home/dev/./bin/docker"},
	} {
		t.Run(tc.probePath, func(t *testing.T) {
			env, err := parseRemoteEnvProbe("__TK_PATH__ /opt/docker bin:/usr/bin\n__TK_CWD__ /home/dev\n__TK_CMD__ docker " + tc.probePath + "\n")
			if err != nil {
				t.Fatal(err)
			}
			service := cachedImageService(source, env)
			ctx := context.Background()
			// 普通调用继续 sudo -S。
			name, args, err := service.buildImageInvocation(ctx, source, "ignored", []string{"image", "ls"})
			wantLine := "'sudo' '-S' '-p' '' '" + tc.wantPath + "' 'image' 'ls'"
			if err != nil || name != "ssh" || len(args) == 0 || args[len(args)-1] != wantLine {
				t.Fatalf("系统 SSH 应使用绝对路径和 sudo 前缀: %s %#v, %v", name, args, err)
			}
			// 需要数据输入的调用走 askpass。
			name, args, err = service.buildImageInputInvocation(ctx, source, "ignored", []string{"image", "load"})
			if err != nil || name != "ssh" || len(args) == 0 {
				t.Fatalf("系统 SSH 的 load 应生成 askpass 命令: %s %#v, %v", name, args, err)
			}
			remote := args[len(args)-1]
			// 固定脚本通过 "$@" 接收独立 argv，Docker 参数作为 sh 的位置参数传入。
			if !strings.HasPrefix(remote, "/bin/sh -c ") || !strings.Contains(remote, `sudo -A -- "$@"`) || !strings.HasSuffix(remote, " sh '"+tc.wantPath+"' 'image' 'load'") {
				t.Fatalf("系统 SSH 的 load 应使用 askpass 包装: %s %#v", name, args)
			}
			probe, _, err := service.sshArchitectureProbeCommand(ctx, source, imageConnectProbeArgs)
			wantProbe := "uname -m && exec 'sudo' '-S' '-p' '' '" + tc.wantPath + "' '--version'"
			if err != nil || probe != wantProbe {
				t.Fatalf("探测命令应使用绝对路径和 sudo 前缀: %q, %v", probe, err)
			}
		})
	}
	service := cachedImageService(source, remoteCommandEnv{path: "/usr/bin", commands: map[string]bool{"docker": false}})
	if _, _, err := service.imageSSHCommandLine(context.Background(), source, []string{"images"}); localizedErrorKey(err) != "errors.service.remoteCommandMissing" {
		t.Fatalf("找不到 docker 时应在执行 sudo 前报错: %v", err)
	}
}

func TestImageSourceRejectsDockerCommandSudoConflictBeforeSSH(t *testing.T) {
	cfg := defaultConfig()
	cfg.SSHProfiles = []SSHProfile{{ID: "p", Name: "Test", Origin: "manual", Host: "box", Port: 22, Username: "dev"}}
	config := &ConfigService{cfg: normalizeConfig(cfg), path: filepath.Join(t.TempDir(), "config.json")}
	service := &ImageService{config: config, runner: func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("校验失败时不应发起 SSH")
		return nil, nil
	}}
	for _, prefix := range []string{"sudo -n /usr/bin/docker", "/usr/bin/sudo -n /usr/bin/docker", "env /usr/bin/sudo docker"} {
		source := ImageSource{ID: "ssh:draft", Kind: "ssh", SSHProfileID: "p", DockerCommand: prefix, SudoPassword: "dummy password"}
		const conflictKey = "errors.config.dockerCommandSudoConflict"
		if err := config.SaveImageSources("", []ImageSource{source}); localizedErrorKey(errors.Unwrap(err)) != conflictKey {
			t.Fatalf("保存前应拒绝 %q 和 sudo 密码同时存在: %v", prefix, err)
		}
		if err := service.TestImageSourceConnection(source); localizedErrorKey(err) != conflictKey {
			t.Fatalf("测试连接前应拒绝 %q 和 sudo 密码同时存在: %v", prefix, err)
		}
	}
	if _, err := os.Stat(config.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("校验失败时不应写入配置文件: %v", err)
	}
}

func TestNormalizeImageSourceSudoPassword(t *testing.T) {
	for _, source := range []ImageSource{
		{ID: "local", Kind: "local", SudoPassword: "dummy password"},
		{ID: "registry:1", Kind: "registry", RegistryURL: "https://registry.example", SudoPassword: "dummy password"},
	} {
		got, err := normalizeImageSource(source, map[string]bool{}, nil, nil)
		if err != nil || got.SudoPassword != "" {
			t.Fatalf("%s 来源应清空 sudo 密码: %v", source.Kind, err)
		}
	}
	source := ImageSource{ID: "ssh:1", Kind: "ssh", SSHProfileID: "p", SudoPassword: " \t dummy password "}
	got, err := normalizeImageSource(source, map[string]bool{}, nil, nil)
	if err != nil || got.SudoPassword != source.SudoPassword {
		t.Fatalf("SSH 来源应保留密码的首尾空白: %v", err)
	}
	for _, invalid := range []string{"\n", "\r", "\x1b", "\u0080", strings.Repeat("a", 4097)} {
		source.SudoPassword = invalid
		_, err := normalizeImageSource(source, map[string]bool{}, nil, nil)
		if localizedErrorKey(err) != "errors.config.sudoPasswordInvalid" {
			t.Fatalf("应拒绝包含换行或非空白控制字符以及超长的密码: %v", err)
		}
	}
}

func TestImageSourceFingerprintTracksSudoPassword(t *testing.T) {
	source := ImageSource{Kind: "ssh", SSHHost: "box", SudoPassword: "dummy password"}
	before := imageSourceFingerprint(source, "docker")
	source.SudoPassword += " "
	if before == imageSourceFingerprint(source, "docker") {
		t.Fatal("修改密码的首尾空白也应改变来源指纹")
	}
}

func TestStreamDockerLoadSendsSudoPasswordAndArchiveToSystemSSH(t *testing.T) {
	source := ImageSource{Kind: "ssh", SSHHost: "box", DockerCommand: "/usr/bin/docker", SudoPassword: " dummy password "}
	var stdin bytes.Buffer
	previous := execCommandContext
	t.Cleanup(func() { execCommandContext = previous })
	execCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name != "ssh" || len(args) == 0 {
			t.Fatalf("系统 SSH 应执行 ssh: %s %#v", name, args)
		}
		remote := args[len(args)-1]
		if !strings.HasPrefix(remote, "/bin/sh -c ") || !strings.Contains(remote, `sudo -A -- "$@"`) || !strings.HasSuffix(remote, " sh '/usr/bin/docker' 'image' 'load'") {
			t.Fatalf("系统 SSH 应执行 askpass 包装后的 load: %s %#v", name, args)
		}
		// 用 cat 接收并保存 ssh 子进程本应收到的完整字节流。
		cmd := exec.CommandContext(ctx, "cat")
		cmd.Stdout = &stdin
		return cmd
	}
	const archive = "\x00\xffimage\nbytes"
	service := &ImageService{}
	if err := service.streamDockerLoad(context.Background(), source, "docker", strings.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	if stdin.String() != source.SudoPassword+"\n"+archive {
		t.Fatal("ssh stdin 应依次接收原始密码行与完整镜像数据")
	}
}

func TestImageDockerStdinPrefixesSudoPassword(t *testing.T) {
	source := ImageSource{Kind: "ssh", SudoPassword: " dummy password "}
	const archive = "\x00\xffimage\nbytes"
	for _, tc := range []struct {
		name  string
		input io.Reader
		want  string
	}{
		{name: "load", input: strings.NewReader(archive), want: source.SudoPassword + "\n" + archive},
		{name: "output only", want: source.SudoPassword + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := io.ReadAll(imageDockerStdin(source, tc.input))
			if err != nil || string(got) != tc.want {
				t.Fatalf("stdin 应完整保留密码行和原始数据: %v", err)
			}
		})
	}
	source.SudoPassword = ""
	input := strings.NewReader(archive)
	if imageDockerStdin(source, input) != input || imageDockerStdin(source, nil) != nil {
		t.Fatal("无密码时应原样保留 stdin")
	}
}

// runAskpassScenario 生成 imageSSHInputLine 的真实 shell 命令，并在 PATH 里放假的
// sudo/docker 执行它。返回 docker 收到的 stdin、是否执行过 docker、退出错误和残留目录。
func runAskpassScenario(t *testing.T, mode, password, payload string) (dockerStdin string, dockerRan bool, runErr error, residue []string, sudoArgv, dockerArgv string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	tmp := filepath.Join(dir, "tmp")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	sudoLog := filepath.Join(dir, "sudo.log")
	dockerLog := filepath.Join(dir, "docker.log")
	dockerStdinPath := filepath.Join(dir, "docker.stdin")

	// 假 sudo 只解析 -A/--，其余原样交给 docker；模式由环境变量决定。
	const sudoScript = `#!/bin/sh
mode=${FAKE_SUDO_MODE:-require}
{
  printf 'sudo argv:'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\n'
} >> "$FAKE_SUDO_LOG"
while [ $# -gt 0 ]; do
  case "$1" in
    -A|--) shift ;;
    *) break ;;
  esac
done
case "$mode" in
  skip)
    printf 'mode=skip\n' >> "$FAKE_SUDO_LOG"
    ;;
  require)
    pw=$("$SUDO_ASKPASS")
    if [ "$pw" = "$FAKE_SUDO_EXPECT_PW" ]; then
      printf 'auth ok\n' >> "$FAKE_SUDO_LOG"
    else
      pw2=$("$SUDO_ASKPASS")
      printf 'auth retry: [%s]\n' "$pw2" >> "$FAKE_SUDO_LOG"
      exit 1
    fi
    ;;
  fail)
    pw=$("$SUDO_ASKPASS")
    printf 'auth fail: [%s]\n' "$pw" >> "$FAKE_SUDO_LOG"
    pw2=$("$SUDO_ASKPASS")
    printf 'auth fail retry: [%s]\n' "$pw2" >> "$FAKE_SUDO_LOG"
    exit 1
    ;;
esac
exec "$@"
`
	const dockerScript = `#!/bin/sh
{
  printf 'docker argv:'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\n'
} >> "$FAKE_DOCKER_LOG"
cat > "$FAKE_DOCKER_STDIN"
printf 'docker ran\n' >> "$FAKE_DOCKER_LOG"
`
	if err := os.WriteFile(filepath.Join(bin, "sudo"), []byte(sudoScript), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(dockerScript), 0o755); err != nil {
		t.Fatal(err)
	}

	source := ImageSource{Kind: "ssh", DockerCommand: "docker", SudoPassword: password}
	service := &ImageService{}
	line, _, err := service.imageSSHInputLine(context.Background(), source, []string{"image", "load"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "/bin/sh -c ") || !strings.Contains(line, "sudo -A --") {
		t.Fatalf("输入路径应走 askpass 包装: %q", line)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", line)
	cmd.Env = append(os.Environ(),
		"PATH="+bin+":"+os.Getenv("PATH"),
		"TMPDIR="+tmp,
		"FAKE_SUDO_MODE="+mode,
		"FAKE_SUDO_EXPECT_PW="+password,
		"FAKE_SUDO_LOG="+sudoLog,
		"FAKE_DOCKER_LOG="+dockerLog,
		"FAKE_DOCKER_STDIN="+dockerStdinPath,
	)
	cmd.Stdin = strings.NewReader(password + "\n" + payload)
	runErr = cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		t.Fatal("askpass 包装超时未退出")
	}

	if data, err := os.ReadFile(dockerStdinPath); err == nil {
		dockerStdin = string(data)
	}
	if logData, err := os.ReadFile(sudoLog); err == nil {
		sudoArgv = firstLine(string(logData))
	}
	if logData, err := os.ReadFile(dockerLog); err == nil {
		dockerRan = strings.Contains(string(logData), "docker ran")
		dockerArgv = firstLine(string(logData))
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tk.") {
			residue = append(residue, entry.Name())
		}
	}
	return dockerStdin, dockerRan, runErr, residue, sudoArgv, dockerArgv
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

func TestImageSSHInputAskpassKeepsDockerInput(t *testing.T) {
	const password = " p@ss\\ word "
	const payload = "\x00\xffimage\nbytes"
	for _, tc := range []struct {
		name    string
		mode    string
		wantOK  bool
		wantRun bool
	}{
		{name: "要求密码", mode: "require", wantOK: true, wantRun: true},
		{name: "免密或缓存命中", mode: "skip", wantOK: true, wantRun: true},
		{name: "认证失败再请求", mode: "fail", wantOK: false, wantRun: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dockerStdin, dockerRan, err, residue, sudoArgv, dockerArgv := runAskpassScenario(t, tc.mode, password, payload)
			if tc.wantOK && err != nil {
				t.Fatalf("命令应成功: %v", err)
			}
			if !tc.wantOK && err == nil {
				t.Fatal("认证失败时命令应失败")
			}
			if dockerRan != tc.wantRun {
				t.Fatalf("docker 执行状态 = %v, 期望 %v", dockerRan, tc.wantRun)
			}
			if sudoArgv != "sudo argv: <-A> <--> <docker> <image> <load>" {
				t.Fatalf("sudo 应只拿到 -A -- 与原样 docker argv: %q", sudoArgv)
			}
			if tc.wantRun && dockerArgv != "docker argv: <image> <load>" {
				t.Fatalf("docker argv 应原样保留: %q", dockerArgv)
			}
			if tc.wantRun && dockerStdin != payload {
				t.Fatal("docker 只应收到原始数据，不能混入密码行")
			}
			if len(residue) != 0 {
				t.Fatalf("不应残留远端助手或 FIFO: %v", residue)
			}
		})
	}
}

func TestImageSSHInputLineUsesAskpassForBothInputPaths(t *testing.T) {
	source := ImageSource{Kind: "ssh", DockerCommand: "docker", SudoPassword: "secret-pw-123"}
	service := &ImageService{}
	for _, args := range [][]string{{"image", "load"}, {"system", "dial-stdio"}} {
		line, label, err := service.imageSSHInputLine(context.Background(), source, args)
		if err != nil {
			t.Fatal(err)
		}
		if label != "docker" {
			t.Fatalf("错误信息命令名应为 docker: %q", label)
		}
		if !strings.HasPrefix(line, "/bin/sh -c ") || !strings.Contains(line, "sudo -A --") {
			t.Fatalf("输入路径应使用 askpass 包装: %q", line)
		}
		if strings.Contains(line, "-S") {
			t.Fatalf("askpass 路径不应出现 sudo -S: %q", line)
		}
		if strings.Contains(line, source.SudoPassword) {
			t.Fatal("密码不应进入命令串")
		}
	}
	noPassword := source
	noPassword.SudoPassword = ""
	line, _, err := service.imageSSHInputLine(context.Background(), noPassword, []string{"image", "load"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(line, "sudo -A") || strings.Contains(line, "askpass") {
		t.Fatalf("无密码时不应使用 askpass: %q", line)
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

func TestTestImageSourceConnectionStepsReportsDaemonSocketDenied(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	var lines []string
	service := &ImageService{config: config, runner: withRemoteEnvProbe(func(_ context.Context, _ string, args ...string) ([]byte, error) {
		line := args[len(args)-1]
		lines = append(lines, line)
		if strings.Contains(line, "'info'") {
			return []byte("aarch64\n"), userErrorParamsCause(
				"errors.image.remoteCommandFailed",
				map[string]any{"command": "docker"},
				errors.New("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"),
			)
		}
		return []byte("aarch64\nDocker version 27.0.0, build deadbeef\n"), nil
	})}
	steps := service.TestImageSourceConnectionSteps(context.Background(), ImageSource{ID: "ssh:draft", Kind: "ssh", SSHHost: "dev-box"})
	if len(steps) != 2 || steps[0].Key != imageConnectionStepConnect || steps[0].Error != "" {
		t.Fatalf("第一步应通过: %#v", steps)
	}
	if steps[1].Key != imageConnectionStepDaemon || steps[1].Error == "" {
		t.Fatalf("daemon 探测应失败: %#v", steps)
	}
	if !strings.Contains(steps[1].Error, "permission denied") {
		t.Fatalf("失败原因应包含远端 stderr: %q", steps[1].Error)
	}
	if want := []string{"uname", "info"}; len(lines) != 2 || !strings.Contains(lines[0], "'--version'") || !strings.Contains(lines[1], "'info'") {
		t.Fatalf("应按连接、daemon 顺序执行: %#v (%v)", lines, want)
	}
}

func TestTestImageSourceConnectionStepsFailsValidationBeforeSSH(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	called := false
	service := &ImageService{config: config, runner: func(context.Context, string, ...string) ([]byte, error) {
		called = true
		return nil, nil
	}}
	steps := service.TestImageSourceConnectionSteps(context.Background(), ImageSource{ID: "ssh:draft", Kind: "ssh", SSHHost: "dev-box", DockerCommand: "/usr/bin/docker;rm -rf /"})
	if len(steps) != 2 || steps[0].Key != imageConnectionStepConnect || steps[0].Error == "" {
		t.Fatalf("校验失败应只让第一步失败: %#v", steps)
	}
	if steps[1].Key != imageConnectionStepDaemon || !steps[1].Skipped {
		t.Fatalf("daemon 探测应标记为未执行: %#v", steps)
	}
	if !strings.Contains(steps[0].Error, "errors.config.dockerCommandInvalid") {
		t.Fatalf("失败原因应指向非法命令前缀: %q", steps[0].Error)
	}
	if called {
		t.Fatal("校验失败时不应执行任何命令")
	}
}

func TestTestImageSourceConnectionStepsStopsOnCancel(t *testing.T) {
	config := &ConfigService{cfg: normalizeConfig(defaultConfig())}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	service := &ImageService{config: config, runner: func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("取消后不应再执行任何命令")
		return nil, nil
	}}
	steps := service.TestImageSourceConnectionSteps(ctx, ImageSource{ID: "ssh:draft", Kind: "ssh", SSHHost: "dev-box"})
	if len(steps) != 2 || !steps[0].Skipped || !steps[1].Skipped {
		t.Fatalf("取消后两步都应标记为未执行: %#v", steps)
	}
}

func TestImageProbeErrorKeepsRawStdoutAndStderr(t *testing.T) {
	if _, _, parsed := splitImageProbeOutput(ImageSource{Kind: "ssh"}, []byte("x86_64\n")); parsed {
		t.Fatal("只有架构行时不应视为解析成功")
	}
	err := imageProbeError([]byte("x86_64\n"), "flag provided but not defined: -format")
	if got := err.Error(); got != "x86_64\nflag provided but not defined: -format" {
		t.Fatalf("原始输出应原样保留: %q", got)
	}
	if empty := imageProbeError(nil, ""); localizedErrorKey(empty) != "errors.image.sshArchitectureProbeInvalid" {
		t.Fatalf("完全无输出时才用提示文案: %v", empty)
	}
}
