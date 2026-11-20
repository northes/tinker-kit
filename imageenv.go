package main

import (
	"context"
	"io"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	imageRemoteEnvProbeTimeout = 8 * time.Second
	imageRemoteEnvTTL          = 10 * time.Minute
)

// dockerCommandName 是镜像管理在默认 PATH 下执行的命令名（子命令在调用处追加）。
const dockerCommandName = "docker"

// imageConnectProbeArgs 是「测试连接」第一步的 docker 参数：只验证客户端可执行。
var imageConnectProbeArgs = []string{"--version"}

// imageDaemonProbeArgs 是连接探测的 docker 参数：取 daemon 的 ServerVersion。
// 只看客户端版本无法发现 socket 权限问题（例如未加入 docker 组），必须真正问一次 daemon。
var imageDaemonProbeArgs = []string{"info", "--format", "{{.ServerVersion}}"}

// imageSourceDisplayCLI 返回来源在状态与指纹里展示的 CLI：本机用全局 Docker CLI 路径，
// SSH 用来源自己的 Docker 命令（留空即 docker），Registry 没有 CLI。
func imageSourceDisplayCLI(source ImageSource, config Config) string {
	switch source.Kind {
	case "local":
		if cli := strings.TrimSpace(config.DockerCLIPath); cli != "" {
			return cli
		}
		return dockerCommandName
	case "ssh":
		if cli := strings.TrimSpace(source.DockerCommand); cli != "" {
			return cli
		}
		return dockerCommandName
	default:
		return ""
	}
}

// dockerCommandShellMeta 是 Docker 命令前缀里禁止出现的 shell 元字符：前缀按 argv 执行，
// 不经过 shell，出现这些字符通常意味着用户想写管道、重定向或变量替换。
const dockerCommandShellMeta = "|&;<>$`\\\"'"

// normalizeDockerCommand 校验并规范化 SSH 来源的远端 Docker 命令前缀。
// 空白只作分隔，不解析引号；返回按单个空格连接的 argv 前缀，空串表示默认。
func normalizeDockerCommand(raw string) (string, error) {
	if len(raw) > 4096 {
		return "", userError("errors.config.dockerCommandInvalid")
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	for _, r := range raw {
		// 换行、回车与其它非空白控制字符一律拒绝（包括只含换行的输入）；制表符等空白只作分隔。
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return "", userError("errors.config.dockerCommandInvalid")
		}
		if r == '\n' || r == '\r' || r == 0x7f {
			return "", userError("errors.config.dockerCommandInvalid")
		}
	}
	if strings.ContainsAny(trimmed, dockerCommandShellMeta) {
		return "", userError("errors.config.dockerCommandInvalid")
	}
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return "", nil
	}
	if strings.HasPrefix(fields[0], "-") {
		return "", userError("errors.config.dockerCommandInvalid")
	}
	return strings.Join(fields, " "), nil
}

// imageSSHCommandPrefix 校验 Docker 命令和 sudo 密码，并返回自定义 argv 前缀。
func imageSSHCommandPrefix(source ImageSource) ([]string, error) {
	command, err := normalizeDockerCommand(source.DockerCommand)
	if err != nil {
		return nil, err
	}
	prefix := strings.Fields(command)
	password := source.SudoPassword
	if password == "" {
		return prefix, nil
	}
	if len(password) > 4096 {
		return nil, userError("errors.config.sudoPasswordInvalid")
	}
	for _, r := range password {
		if r == '\n' || r == '\r' || (unicode.IsControl(r) && !unicode.IsSpace(r)) {
			return nil, userError("errors.config.sudoPasswordInvalid")
		}
	}
	for _, token := range prefix {
		if path.Base(token) == "sudo" {
			return nil, userError("errors.config.dockerCommandSudoConflict")
		}
	}
	return prefix, nil
}

// imageDockerStdin 将 sudo 密码行放在原有输入前，镜像数据仍然流式传输。
func imageDockerStdin(source ImageSource, stdin io.Reader) io.Reader {
	if source.Kind != "ssh" || source.SudoPassword == "" {
		return stdin
	}
	passwordLine := strings.NewReader(source.SudoPassword + "\n")
	if stdin == nil {
		return passwordLine
	}
	return io.MultiReader(passwordLine, stdin)
}

// imageRemoteEnvCacheKey 用连接身份与命令前缀标识一次 PATH 解析。
// 镜像管理不和服务管理共用缓存，前缀不同的来源也不会复用同一条 PATH 结论。
func imageRemoteEnvCacheKey(source ImageSource, commandPrefix string) string {
	port := source.SSHPort
	if port == 0 {
		port = 22
	}
	hops := make([]string, 0, len(source.SSHJump))
	for _, hop := range source.SSHJump {
		hopPort := hop.Port
		if hopPort == 0 {
			hopPort = 22
		}
		hops = append(hops, hop.Username+"@"+hop.Host+":"+strconv.Itoa(hopPort))
	}
	return strings.Join([]string{
		source.SSHHost,
		strconv.Itoa(port),
		source.SSHUsername,
		strings.Join(hops, ","),
		strings.TrimSpace(commandPrefix),
	}, "|")
}

// imageRemoteCommandEnv 探测远端登录 shell 的 PATH，并确认其中是否有 docker。
// 探测本身失败时返回 false，由调用方退回裸 docker，不因探测失败把来源判死。
func (s *ImageService) imageRemoteCommandEnv(ctx context.Context, source ImageSource) (remoteCommandEnv, bool) {
	if s == nil {
		return remoteCommandEnv{}, false
	}
	key := imageRemoteEnvCacheKey(source, "")
	s.remoteEnvMu.Lock()
	cached, ok := s.remoteEnv[key]
	s.remoteEnvMu.Unlock()
	if ok && time.Since(cached.resolvedAt) < imageRemoteEnvTTL {
		return cached, true
	}
	// 无保存凭据的来源同样要探测登录 PATH（依赖 ssh-agent 或 ~/.ssh/config），由闭包选择系统 ssh。
	authenticated := hasSSHCredentials(source)
	probeCtx, cancel := context.WithTimeout(ctx, imageRemoteEnvProbeTimeout)
	defer cancel()
	// 记录登录 shell 的目录，便于把 PATH 里的相对可执行路径转换成绝对路径。
	script := buildRemoteEnvProbeScript([]string{dockerCommandName}) + `printf '__TK_CWD__ %s\n' "$PWD"`
	env, err := probeRemoteCommandEnvWithRunner(probeCtx, script, func(ctx context.Context, shell string, args ...string) ([]byte, error) {
		if authenticated {
			return runAuthenticatedSSH(ctx, source, shell, s.sshLanguage(), args...)
		}
		// 系统 ssh 的登录 PATH 探测不运行 Docker，不接收 sudo 密码。
		name, sshArgs, err := buildImageCommand(source, shell, args...)
		if err != nil {
			return nil, err
		}
		out, _, err := s.runImageCommand(ctx, nil, name, sshArgs...)
		return out, err
	})
	if err != nil {
		return remoteCommandEnv{}, false
	}
	env.resolvedAt = time.Now()
	s.remoteEnvMu.Lock()
	if s.remoteEnv == nil {
		s.remoteEnv = map[string]remoteCommandEnv{}
	}
	s.remoteEnv[key] = env
	s.remoteEnvMu.Unlock()
	return env, true
}

// buildImageInvocation 构造一条 docker 调用的本机或系统 ssh 命令。
func (s *ImageService) buildImageInvocation(ctx context.Context, source ImageSource, cliPath string, args []string) (string, []string, error) {
	if source.Kind == "ssh" {
		remote, _, err := s.imageSSHCommandLine(ctx, source, args)
		if err != nil {
			return "", nil, err
		}
		return buildImageCommandLine(source, remote)
	}
	return buildImageCommand(source, cliPath, args...)
}

// buildImageInputInvocation 构造需要数据输入的 docker 调用（本机或系统 ssh）。
// SSH 填了 sudo 密码时用远端 askpass 助手把密码与数据分开，避免 sudo 免密或缓存命中
// 时密码行污染 Docker 的 stdin。
func (s *ImageService) buildImageInputInvocation(ctx context.Context, source ImageSource, cliPath string, args []string) (string, []string, error) {
	if source.Kind == "ssh" {
		remote, _, err := s.imageSSHInputLine(ctx, source, args)
		if err != nil {
			return "", nil, err
		}
		return buildImageCommandLine(source, remote)
	}
	return buildImageCommand(source, cliPath, args...)
}

// hasSSHCredentials 判断 SSH 来源能否由 Go 的 SSH 客户端建链（需要密码或私钥）。
// 没有凭据时继续交给系统 ssh，行为与历史一致。
func hasSSHCredentials(source ImageSource) bool {
	return source.SSHPassword != "" || source.SSHPrivateKey != "" || source.SSHPrivateKeyPath != ""
}

// imageSSHCommandLine 返回 SSH Docker 调用的远端命令和错误信息里的命令名。
func (s *ImageService) imageSSHCommandLine(ctx context.Context, source ImageSource, dockerArgs []string) (string, string, error) {
	return s.imageSSHLine(ctx, source, dockerArgs, false)
}

// imageSSHDockerArgv 校验并解析 SSH 来源的一次 Docker 调用：返回不带 sudo 的完整 argv
// （命令前缀或登录 PATH 解析出的 docker 路径）、错误信息标签，以及需要前置的远端 PATH。
func (s *ImageService) imageSSHDockerArgv(ctx context.Context, source ImageSource, dockerArgs []string) (argv []string, label, remotePath string, err error) {
	prefix, err := imageSSHCommandPrefix(source)
	if err != nil {
		return nil, "", "", err
	}
	if len(prefix) == 0 {
		cli := dockerCommandName
		if env, ok := s.imageRemoteCommandEnv(ctx, source); ok {
			if found, checked := env.commands[dockerCommandName]; checked && !found {
				return nil, "", "", imageRemoteDockerMissing()
			}
			if source.SudoPassword == "" {
				remotePath = env.path
			} else {
				// sudo 会重置 PATH，必须传登录 PATH 解析出的可执行文件路径。
				cli = env.commandPaths[dockerCommandName]
				if !path.IsAbs(cli) && strings.Contains(cli, "/") && path.IsAbs(env.cwd) {
					cli = strings.TrimRight(env.cwd, "/") + "/" + cli
				}
				if !path.IsAbs(cli) {
					return nil, "", "", imageRemoteDockerMissing()
				}
			}
		}
		// 探测过程失败时仍按默认命令名尝试执行。
		prefix = []string{cli}
	}
	return append(prefix, dockerArgs...), remoteCommandLabel(prefix[0]), remotePath, nil
}

func (s *ImageService) imageSSHLine(ctx context.Context, source ImageSource, dockerArgs []string, probeArchitecture bool) (string, string, error) {
	argv, label, remotePath, err := s.imageSSHDockerArgv(ctx, source, dockerArgs)
	if err != nil {
		return "", "", err
	}
	if source.SudoPassword != "" {
		argv = append([]string{"sudo", "-S", "-p", ""}, argv...)
	}
	var line strings.Builder
	if probeArchitecture {
		line.WriteString("uname -m && ")
	}
	if remotePath != "" {
		line.WriteString("PATH=" + shellQuote(remotePath) + " ")
	}
	if probeArchitecture {
		line.WriteString("exec ")
	}
	line.WriteString(shellJoin(argv))
	return line.String(), label, nil
}

// sudoAskpassScript 是远端 askpass 包装的固定 /bin/sh 脚本：从 stdin 首行读取 sudo 密码，
// 通过私有目录里的 FIFO 交给一次性 askpass 助手，其余 fd 0 原样传给 sudo -A。
// Docker argv 作为位置参数传入，不拼进脚本正文；密码只留在内存与 FIFO，不进入 argv、
// 环境变量、磁盘文件或 stderr。
const sudoAskpassScript = `d=
writer=
cleanup() {
  if [ -n "$writer" ]; then
    kill "$writer" 2>/dev/null || true
    wait "$writer" 2>/dev/null || true
  fi
  if [ -n "$d" ]; then
    rm -rf "$d"
  fi
}
trap cleanup 0
trap 'exit 130' HUP INT TERM
d=$(mktemp -d "${TMPDIR:-/tmp}/.tk.XXXXXX") || exit 125
umask 077
fifo=$d/pass
helper=$d/askpass
mkfifo "$fifo" || exit 125
cat > "$helper" <<'ASKPASS'
#!/bin/sh
case "$0" in
  */*) d=${0%/*} ;;
  *) d=. ;;
esac
mkdir "$d/claimed" 2>/dev/null || exit 1
IFS= read -r line < "$d/pass" || exit 1
printf '%s\n' "$line"
ASKPASS
chmod 700 "$helper"
IFS= read -r pw || pw=
( printf '%s\n' "$pw" > "$fifo" ) 2>/dev/null &
writer=$!
SUDO_ASKPASS="$helper" sudo -A -- "$@"
rc=$?
kill "$writer" 2>/dev/null || true
wait "$writer" 2>/dev/null || true
writer=
exit "$rc"
`

// sudoAskpassLine 把解析好的 Docker argv 包进固定的 /bin/sh -c 远端 askpass 入口。
func sudoAskpassLine(dockerArgv []string) string {
	return "/bin/sh -c " + shellQuote(sudoAskpassScript) + " sh " + shellJoin(dockerArgv)
}

// imageSSHInputLine 构造需要数据输入的 SSH Docker 调用（docker load 与 dial-stdio）。
// 填了 sudo 密码时走 askpass 通道；无密码时与普通调用一致。
func (s *ImageService) imageSSHInputLine(ctx context.Context, source ImageSource, dockerArgs []string) (string, string, error) {
	if source.SudoPassword == "" {
		return s.imageSSHLine(ctx, source, dockerArgs, false)
	}
	argv, label, _, err := s.imageSSHDockerArgv(ctx, source, dockerArgs)
	if err != nil {
		return "", "", err
	}
	return sudoAskpassLine(argv), label, nil
}

func imageRemoteDockerMissing() error {
	return userErrorParams("errors.service.remoteCommandMissing", map[string]any{"command": dockerCommandName})
}

func (s *ImageService) runImageSSH(ctx context.Context, source ImageSource, dockerArgs ...string) ([]byte, error) {
	line, label, err := s.imageSSHCommandLine(ctx, source, dockerArgs)
	if err != nil {
		return nil, err
	}
	out, _, err := runAuthenticatedSSHLineCapture(ctx, source, label, s.sshLanguage(), line, imageDockerStdin(source, nil))
	return out, err
}

func (s *ImageService) runImageSSHStream(ctx context.Context, source ImageSource, stdout, stderr io.Writer, dockerArgs ...string) error {
	line, label, err := s.imageSSHCommandLine(ctx, source, dockerArgs)
	if err != nil {
		return err
	}
	return runAuthenticatedSSHWritersLine(ctx, source, label, s.sshLanguage(), line, imageDockerStdin(source, nil), stdout, stderr)
}

// runImageSSHInput 把 sudo 密码行（如有）与本地数据一起流式送入远端 stdin。
func (s *ImageService) runImageSSHInput(ctx context.Context, source ImageSource, src io.Reader, dockerArgs ...string) error {
	line, label, err := s.imageSSHInputLine(ctx, source, dockerArgs)
	if err != nil {
		return err
	}
	return runAuthenticatedSSHInputLine(ctx, source, label, s.sshLanguage(), imageDockerStdin(source, src), line)
}

// sshArchitectureProbeCommand 构建 SSH 来源的架构 + docker 探测命令：
// 先取 uname -m，再 exec 给定的 docker 参数（连接探测用 info，测试连接第一步用 --version）。
// 前缀留空且已确认找不到 docker 时不生成命令。
func (s *ImageService) sshArchitectureProbeCommand(ctx context.Context, source ImageSource, dockerArgs []string) (line string, label string, err error) {
	return s.imageSSHLine(ctx, source, dockerArgs, true)
}
