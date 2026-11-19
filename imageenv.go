package main

import (
	"context"
	"io"
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

// parseDockerCommandPrefix 把已保存的命令前缀拆成 argv；空串返回 nil。
func parseDockerCommandPrefix(raw string) ([]string, error) {
	normalized, err := normalizeDockerCommand(raw)
	if err != nil || normalized == "" {
		return nil, err
	}
	return strings.Fields(normalized), nil
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
	probeCtx, cancel := context.WithTimeout(ctx, imageRemoteEnvProbeTimeout)
	defer cancel()
	env, err := probeRemoteCommandEnv(probeCtx, source, []string{dockerCommandName}, s.sshLanguage())
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
// SSH 来源在前缀非空时按 argv 前缀拼接，前缀留空时仍是裸 docker。
func buildImageInvocation(source ImageSource, cliPath string, args []string) (string, []string, error) {
	if source.Kind == "ssh" {
		remote, _, err := imageSSHSystemCommandLine(source, args)
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

// imageSSHSystemProbeCommand 构建系统 ssh 路径上的架构 + 客户端版本探测脚本。
// 该路径没有登录 PATH 探测，前缀留空时直接探测裸 docker。
func imageSSHSystemProbeCommand(source ImageSource) (script string, label string, err error) {
	prefix, err := imageSSHCommandPrefix(source)
	if err != nil {
		return "", "", err
	}
	if len(prefix) > 0 {
		return "uname -m && exec " + shellJoin(append(prefix, "--version")), remoteCommandLabel(prefix[0]), nil
	}
	return "uname -m && exec " + shellQuote(dockerCommandName) + " --version", dockerCommandName, nil
}

// imageSSHCommandPrefix 返回来源自带的命令前缀；空表示需要走登录 PATH。
func imageSSHCommandPrefix(source ImageSource) ([]string, error) {
	return parseDockerCommandPrefix(source.DockerCommand)
}

// imageSSHCommandLine 返回 SSH 来源上一条 docker 调用的远端命令串与错误信息里的命令名。
// 前缀非空时直接把它当作 argv 前置，不套登录 PATH；前缀留空时使用探测到的 PATH，
// 探测成功但 PATH 里没有 docker 时直接报未找到，不再执行一次必然失败的 exec。
func (s *ImageService) imageSSHCommandLine(ctx context.Context, source ImageSource, dockerArgs []string) (line string, label string, err error) {
	prefix, err := imageSSHCommandPrefix(source)
	if err != nil {
		return "", "", err
	}
	if len(prefix) > 0 {
		return shellJoin(append(prefix, dockerArgs...)), remoteCommandLabel(prefix[0]), nil
	}
	env, ok := s.imageRemoteCommandEnv(ctx, source)
	if !ok {
		return shellJoin(append([]string{dockerCommandName}, dockerArgs...)), dockerCommandName, nil
	}
	if found, checked := env.commands[dockerCommandName]; checked && !found {
		return "", "", userErrorParams("errors.service.remoteCommandMissing", map[string]any{"command": dockerCommandName})
	}
	if env.path == "" {
		return shellJoin(append([]string{dockerCommandName}, dockerArgs...)), dockerCommandName, nil
	}
	return "PATH=" + shellQuote(env.path) + " " + shellJoin(append([]string{dockerCommandName}, dockerArgs...)), dockerCommandName, nil
}

// imageSSHSystemCommandLine 用于没有保存凭据、改由系统 ssh 执行的来源。
// 这条路径没有可用的登录 shell 探测，只按来源的命令前缀拼 argv；留空即裸 docker。
func imageSSHSystemCommandLine(source ImageSource, dockerArgs []string) (string, string, error) {
	prefix, err := imageSSHCommandPrefix(source)
	if err != nil {
		return "", "", err
	}
	if len(prefix) > 0 {
		return shellJoin(append(prefix, dockerArgs...)), remoteCommandLabel(prefix[0]), nil
	}
	return shellJoin(append([]string{dockerCommandName}, dockerArgs...)), dockerCommandName, nil
}

func (s *ImageService) runImageSSH(ctx context.Context, source ImageSource, dockerArgs ...string) ([]byte, error) {
	line, label, err := s.imageSSHCommandLine(ctx, source, dockerArgs)
	if err != nil {
		return nil, err
	}
	return runAuthenticatedSSHLine(ctx, source, label, s.sshLanguage(), line)
}

func (s *ImageService) runImageSSHStream(ctx context.Context, source ImageSource, dst io.Writer, dockerArgs ...string) error {
	line, label, err := s.imageSSHCommandLine(ctx, source, dockerArgs)
	if err != nil {
		return err
	}
	return runAuthenticatedSSHCombinedLine(ctx, source, label, s.sshLanguage(), line, dst)
}

// runImageSSHInput 把本地数据经 stdin 交给远端命令；stdin 始终由远端会话转交，
// 应用不插入 sudo -S，也不自行消费密码输入。
func (s *ImageService) runImageSSHInput(ctx context.Context, source ImageSource, src io.Reader, dockerArgs ...string) error {
	line, label, err := s.imageSSHCommandLine(ctx, source, dockerArgs)
	if err != nil {
		return err
	}
	return runAuthenticatedSSHInputLine(ctx, source, label, s.sshLanguage(), src, line)
}

// sshArchitectureProbeCommand 构建 SSH 来源的架构 + 客户端版本探测命令：
// 先取 uname -m，再 exec docker --version。前缀留空且已确认找不到 docker 时不生成命令。
func (s *ImageService) sshArchitectureProbeCommand(ctx context.Context, source ImageSource) (line string, label string, err error) {
	prefix, err := imageSSHCommandPrefix(source)
	if err != nil {
		return "", "", err
	}
	if len(prefix) > 0 {
		return "uname -m && exec " + shellJoin(append(prefix, "--version")), remoteCommandLabel(prefix[0]), nil
	}
	env, ok := s.imageRemoteCommandEnv(ctx, source)
	if !ok {
		// 探测本身失败：退回与服务管理一致的裸 docker 探测。
		return "uname -m && exec " + shellQuote(dockerCommandName) + " --version", dockerCommandName, nil
	}
	if found, checked := env.commands[dockerCommandName]; checked && !found {
		return "", "", userErrorParams("errors.service.remoteCommandMissing", map[string]any{"command": dockerCommandName})
	}
	if env.path == "" {
		return "uname -m && exec " + shellQuote(dockerCommandName) + " --version", dockerCommandName, nil
	}
	return "uname -m && PATH=" + shellQuote(env.path) + " exec " + shellQuote(dockerCommandName) + " --version", dockerCommandName, nil
}
