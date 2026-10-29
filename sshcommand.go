package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func shellJoin(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}

// remoteCommandLabel 提取远程命令的可读名称。这套 SSH 执行器同时服务
// Docker、PM2 与 systemd，错误信息不能写死为 Docker。
func remoteCommandLabel(cliPath string) string {
	name := filepath.Base(strings.TrimSpace(cliPath))
	if name != "" && name != "." && name != string(filepath.Separator) {
		return name
	}
	return strings.TrimSpace(cliPath)
}

func runAuthenticatedSSH(
	ctx context.Context,
	source ImageSource,
	cliPath string,
	language string,
	dockerArgs ...string,
) ([]byte, error) {
	client, err := dialAuthenticatedSSH(ctx, source, language)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	return runSSHCommand(ctx, client, cliPath, dockerArgs...)
}

// runAuthenticatedSSHLine 执行一条已由调用方安全拼接的远程命令；label 仅用于
// 错误信息，使设置 PATH 包装后的报错仍指向真实命令。
func runAuthenticatedSSHLine(
	ctx context.Context,
	source ImageSource,
	label string,
	language string,
	commandLine string,
) ([]byte, error) {
	client, err := dialAuthenticatedSSH(ctx, source, language)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	return runSSHCommandLine(ctx, client, label, commandLine)
}

// runAuthenticatedSSHCombinedLine 与 runAuthenticatedSSHCombined 相同，
// 只是接收已拼接好的命令并单独指定错误信息里的命令名。
func runAuthenticatedSSHCombinedLine(
	ctx context.Context,
	source ImageSource,
	label string,
	language string,
	commandLine string,
	dst io.Writer,
) error {
	client, err := dialAuthenticatedSSH(ctx, source, language)
	if err != nil {
		return err
	}
	defer client.Close()
	return runSSHCommandWritersLine(ctx, client, label, commandLine, nil, dst, dst)
}

func dialAuthenticatedSSH(ctx context.Context, source ImageSource, language string) (*ssh.Client, error) {
	hostKeyCallback, err := newAppSSHHostKeyCallback(language)
	if err != nil {
		return nil, userErrorCause("errors.image.knownHostsReadFailed", err)
	}
	user := source.SSHUsername
	if user == "" {
		user = os.Getenv("USER")
	}
	if user == "" {
		return nil, userError("errors.image.sshUserEmpty")
	}
	authMethods := make([]ssh.AuthMethod, 0, 3)
	if source.SSHPassword != "" {
		authMethods = append(authMethods, passwordAuthMethods(source.SSHPassword)...)
	}
	keyData := source.SSHPrivateKey
	if keyData == "" && source.SSHPrivateKeyPath != "" {
		keyData, err = readSSHPrivateKeyFile(source.SSHPrivateKeyPath)
		if err != nil {
			return nil, userError("errors.image.privateKeyReadFailed")
		}
	}
	if keyData != "" {
		var signer ssh.Signer
		if source.SSHKeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyData), []byte(source.SSHKeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyData))
		}
		if err != nil {
			return nil, userErrorCause("errors.image.privateKeyParseFailed", err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if len(authMethods) == 0 {
		return nil, userError("errors.image.sshCredentialsMissing")
	}
	host := strings.TrimPrefix(strings.TrimSuffix(source.SSHHost, "]"), "[")
	port := source.SSHPort
	if port == 0 {
		port = 22
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	jumpHops, err := sshJumpHops(source.SSHJump, hostKeyCallback, imageCommandTimeout)
	if err != nil {
		return nil, err
	}
	hops := append(jumpHops, sshChainHop{
		name:    source.Name,
		address: address,
		config:  &ssh.ClientConfig{User: user, Auth: authMethods, HostKeyCallback: hostKeyCallback, Timeout: imageCommandTimeout},
	})
	client, err := dialSSHChain(ctx, hops)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var hostKeyErr *sshHostKeyError
		if errors.As(err, &hostKeyErr) {
			return nil, hostKeyErr
		}
		// 跳板机失败已经带上了具体机器名称，不能再简化成目标的通用连接错误。
		var localized *localizedError
		if errors.As(err, &localized) {
			return nil, err
		}
		return nil, userError("errors.image.sshConnectFailed")
	}
	return client, nil
}

func runAuthenticatedSSHStream(
	ctx context.Context,
	source ImageSource,
	cliPath string,
	language string,
	dst io.Writer,
	dockerArgs ...string,
) error {
	client, err := dialAuthenticatedSSH(ctx, source, language)
	if err != nil {
		return err
	}
	defer client.Close()
	return runSSHCommandToWriter(ctx, client, cliPath, dst, dockerArgs...)
}

// runAuthenticatedSSHCombined 把远程命令的 stdout 和 stderr 都写到同一个 writer，
// 用于需要读取 docker pull 进度（stderr）的场景。
func runAuthenticatedSSHCombined(
	ctx context.Context,
	source ImageSource,
	cliPath string,
	language string,
	dst io.Writer,
	dockerArgs ...string,
) error {
	client, err := dialAuthenticatedSSH(ctx, source, language)
	if err != nil {
		return err
	}
	defer client.Close()
	return runSSHCommandToWriters(ctx, client, cliPath, nil, dst, dst, dockerArgs...)
}

// runAuthenticatedSSHInput 把本地数据经 stdin 送给远端命令，用于在 SSH 来源上 docker load。
func runAuthenticatedSSHInput(ctx context.Context, source ImageSource, cliPath, language string, src io.Reader, dockerArgs ...string) error {
	client, err := dialAuthenticatedSSH(ctx, source, language)
	if err != nil {
		return err
	}
	defer client.Close()
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	if err := runSSHCommandToWriters(ctx, client, cliPath, src, io.Discard, stderr, dockerArgs...); err != nil {
		if stderr.Len() > 0 {
			return userErrorCause("errors.image.importFailed", errors.New(strings.TrimSpace(stderr.String())))
		}
		return err
	}
	return nil
}

func runSSHCommand(ctx context.Context, client *ssh.Client, cliPath string, dockerArgs ...string) ([]byte, error) {
	return runSSHCommandLine(ctx, client, remoteCommandLabel(cliPath), shellJoin(append([]string{cliPath}, dockerArgs...)))
}

// runSSHCommandLine 执行一条已由调用方安全拼接的远程命令；label 只用于错误信息。
func runSSHCommandLine(ctx context.Context, client *ssh.Client, label, commandLine string) ([]byte, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, userError("errors.image.sshSessionFailed")
	}
	defer session.Close()
	stdout := &limitedBuffer{limit: maxImageCommandOutput}
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	session.Stdout = stdout
	session.Stderr = stderr
	if err := session.Start(commandLine); err != nil {
		return nil, userErrorParams("errors.image.remoteCommandStartFailed", map[string]any{"command": label})
	}
	wait := make(chan error, 1)
	go func() { wait <- session.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			if stderr.Len() > 0 {
				return stdout.Bytes(), userErrorParamsCause("errors.image.remoteCommandFailed", map[string]any{"command": label}, errors.New(strings.TrimSpace(stderr.String())))
			}
			return stdout.Bytes(), userErrorParamsCause("errors.image.remoteCommandFailed", map[string]any{"command": label}, err)
		}
		return stdout.Bytes(), nil
	case <-ctx.Done():
		_ = client.Close()
		return stdout.Bytes(), ctx.Err()
	}
}

func runSSHCommandToWriter(ctx context.Context, client *ssh.Client, cliPath string, dst io.Writer, dockerArgs ...string) error {
	session, err := client.NewSession()
	if err != nil {
		return userError("errors.image.sshSessionFailed")
	}
	defer session.Close()
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	session.Stdout = dst
	session.Stderr = stderr
	if err := session.Start(shellJoin(append([]string{cliPath}, dockerArgs...))); err != nil {
		return userErrorParams("errors.image.remoteCommandStartFailed", map[string]any{"command": remoteCommandLabel(cliPath)})
	}
	wait := make(chan error, 1)
	go func() { wait <- session.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			if stderr.Len() > 0 {
				return userErrorParamsCause("errors.image.remoteCommandFailed", map[string]any{"command": remoteCommandLabel(cliPath)}, errors.New(strings.TrimSpace(stderr.String())))
			}
			return err
		}
		return nil
	case <-ctx.Done():
		_ = client.Close()
		return ctx.Err()
	}
}

// runSSHCommandToWriters 分别把远程命令的 stdin / stdout / stderr 接到指定 reader / writer，
// 且 stdout 与 stderr 都实时流式输出。
func runSSHCommandToWriters(ctx context.Context, client *ssh.Client, cliPath string, stdin io.Reader, stdout, stderr io.Writer, dockerArgs ...string) error {
	return runSSHCommandWritersLine(ctx, client, remoteCommandLabel(cliPath), shellJoin(append([]string{cliPath}, dockerArgs...)), stdin, stdout, stderr)
}

// runSSHCommandWritersLine 与 runSSHCommandToWriters 相同，只是接收已拼接好的
// 命令并单独指定错误信息里的命令名。
func runSSHCommandWritersLine(ctx context.Context, client *ssh.Client, label, commandLine string, stdin io.Reader, stdout, stderr io.Writer) error {
	session, err := client.NewSession()
	if err != nil {
		return userError("errors.image.sshSessionFailed")
	}
	defer session.Close()
	session.Stdin = stdin
	session.Stdout = stdout
	session.Stderr = stderr
	if err := session.Start(commandLine); err != nil {
		return userErrorParams("errors.image.remoteCommandStartFailed", map[string]any{"command": label})
	}
	wait := make(chan error, 1)
	go func() { wait <- session.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			return userErrorParamsCause("errors.image.remoteCommandFailed", map[string]any{"command": label}, err)
		}
		return nil
	case <-ctx.Done():
		_ = client.Close()
		return ctx.Err()
	}
}
