package main

import (
	"context"
	"errors"
	"fmt"
	"net"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func passwordAuthMethods(password string) []ssh.AuthMethod {
	return []ssh.AuthMethod{
		ssh.Password(password),
		// 部分 SSH 服务端关闭 password 方法，仅通过 keyboard-interactive 提供密码认证。
		ssh.KeyboardInteractive(func(_, _ string, questions []string, echos []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for index := range questions {
				if index >= len(echos) || !echos[index] {
					answers[index] = password
				}
			}
			return answers, nil
		}),
	}
}

func sshHostKeyAlgorithms() []string {
	// OpenSSH 通常优先使用 Ed25519；x/crypto 的默认顺序把 ECDSA 放在 Ed25519 前。
	// known_hosts 往往只记录首次协商的一个算法，因此先按常见 OpenSSH 顺序尝试。
	available := append(
		ssh.SupportedAlgorithms().HostKeys,
		ssh.InsecureAlgorithms().HostKeys...,
	)
	preferred := []string{
		ssh.KeyAlgoED25519,
		ssh.KeyAlgoECDSA256,
		ssh.KeyAlgoECDSA384,
		ssh.KeyAlgoECDSA521,
		ssh.KeyAlgoRSASHA256,
		ssh.KeyAlgoRSASHA512,
		ssh.KeyAlgoRSA,
	}
	result := make([]string, 0, len(available))
	add := func(algorithm string) {
		for _, existing := range result {
			if existing == algorithm {
				return
			}
		}
		for _, candidate := range available {
			if candidate == algorithm {
				result = append(result, algorithm)
				return
			}
		}
	}
	for _, algorithm := range preferred {
		add(algorithm)
	}
	for _, algorithm := range available {
		add(algorithm)
	}
	return result
}

type sshDialError struct {
	err error
}

func (e *sshDialError) Error() string {
	return fmt.Sprintf("连接 SSH 主机失败: %v", e.err)
}

func (e *sshDialError) Unwrap() error {
	return e.err
}

func sshHostKeyAlgorithmType(algorithm string) string {
	switch algorithm {
	case ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSA:
		return ssh.KeyAlgoRSA
	default:
		return algorithm
	}
}

func sshHostKeyAlgorithmsForKnownKeys(keys []knownhosts.KnownKey) []string {
	knownTypes := make(map[string]struct{}, len(keys))
	for _, known := range keys {
		knownTypes[known.Key.Type()] = struct{}{}
	}
	result := make([]string, 0, len(knownTypes))
	for _, algorithm := range sshHostKeyAlgorithms() {
		if _, ok := knownTypes[sshHostKeyAlgorithmType(algorithm)]; ok {
			result = append(result, algorithm)
		}
	}
	return result
}

func dialSSHClient(ctx context.Context, address string, config *ssh.ClientConfig) (*ssh.Client, error) {
	preferredConfig := *config
	preferredConfig.HostKeyAlgorithms = sshHostKeyAlgorithms()
	client, err := dialSSHClientOnce(ctx, address, &preferredConfig)
	if err == nil {
		return client, nil
	}

	var keyErr *knownhosts.KeyError
	if !errors.As(err, &keyErr) || len(keyErr.Want) == 0 {
		return nil, err
	}
	// 服务端可能在多个已知主机密钥中选中了另一个算法；只用 known_hosts
	// 已确认的密钥类型重试，不能因此放宽主机指纹校验。
	knownAlgorithms := sshHostKeyAlgorithmsForKnownKeys(keyErr.Want)
	if len(knownAlgorithms) == 0 {
		return nil, err
	}
	retryConfig := *config
	retryConfig.HostKeyAlgorithms = knownAlgorithms
	return dialSSHClientOnce(ctx, address, &retryConfig)
}

func dialSSHClientOnce(ctx context.Context, address string, config *ssh.ClientConfig) (*ssh.Client, error) {
	netConn, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, &sshDialError{err: err}
	}
	handshake := make(chan struct {
		client *ssh.Client
		err    error
	}, 1)
	go func() {
		clientConn, channels, requests, handshakeErr := ssh.NewClientConn(netConn, address, config)
		if handshakeErr != nil {
			handshake <- struct {
				client *ssh.Client
				err    error
			}{err: handshakeErr}
			return
		}
		handshake <- struct {
			client *ssh.Client
			err    error
		}{client: ssh.NewClient(clientConn, channels, requests)}
	}()
	select {
	case result := <-handshake:
		if result.err != nil {
			_ = netConn.Close()
			return nil, result.err
		}
		return result.client, nil
	case <-ctx.Done():
		_ = netConn.Close()
		return nil, ctx.Err()
	}
}
