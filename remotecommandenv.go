package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

// remoteCommandEnv 是远端登录 shell 解析出的执行环境：登录 PATH 与命令可解析状态。
type remoteCommandEnv struct {
	path       string
	commands   map[string]bool
	resolvedAt time.Time
}

// probeRemoteCommandEnv 通过远端登录 shell 解析 PATH：先取登录 shell 的 PATH，
// 再补上版本管理器与常见安装目录，最后逐条确认目标命令是否存在。
// 命令列表与错误语言由调用方决定：服务管理查整套命令，镜像管理只查 docker。
func probeRemoteCommandEnv(ctx context.Context, source ImageSource, commandNames []string, language string) (remoteCommandEnv, error) {
	script := buildRemoteEnvProbeScript(commandNames)
	var lastErr error
	for _, sh := range []string{"bash", "zsh", "sh"} {
		out, err := runAuthenticatedSSH(ctx, source, sh, language, "-lc", script)
		if err != nil {
			lastErr = err
			continue
		}
		if ctx.Err() != nil {
			return remoteCommandEnv{}, ctx.Err()
		}
		env, err := parseRemoteEnvProbe(string(out))
		if err != nil {
			lastErr = err
			continue
		}
		return env, nil
	}
	if lastErr == nil {
		lastErr = errors.New("远端 shell 环境探测失败")
	}
	return remoteCommandEnv{}, lastErr
}

func buildRemoteEnvProbeScript(commands []string) string {
	var b strings.Builder
	b.WriteString("p=$PATH\n")
	b.WriteString(`for d in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.asdf/shims" "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.volta/bin" "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && p="$d:$p"; done` + "\n")
	b.WriteString("PATH=$p; export PATH\n")
	b.WriteString("printf '__TK_PATH__ %s\\n' \"$PATH\"\n")
	b.WriteString("for c in")
	for _, command := range commands {
		b.WriteString(" " + command)
	}
	b.WriteString("; do printf '__TK_CMD__ %s %s\\n' \"$c\" \"$(command -v \"$c\" 2>/dev/null)\"; done\n")
	return b.String()
}

func parseRemoteEnvProbe(out string) (remoteCommandEnv, error) {
	env := remoteCommandEnv{commands: map[string]bool{}}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "__TK_PATH__ "); ok {
			env.path = strings.TrimSpace(rest)
			continue
		}
		if rest, ok := strings.CutPrefix(line, "__TK_CMD__ "); ok {
			name, path, _ := strings.Cut(rest, " ")
			if name != "" {
				env.commands[name] = strings.TrimSpace(path) != ""
			}
		}
	}
	if env.path == "" {
		return remoteCommandEnv{}, errors.New("解析远端 shell 环境失败")
	}
	return env, nil
}
