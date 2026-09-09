package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type sshKnownHostStore struct {
	path   string
	mu     sync.Mutex
	prompt func(string, string, ssh.PublicKey, []knownhosts.KnownKey) bool
}

type sshHostKeyError struct {
	cause    error
	store    *sshKnownHostStore
	address  string
	language string
	key      ssh.PublicKey
	want     []knownhosts.KnownKey
}

type sshHostAddress string

func (a sshHostAddress) Network() string { return "tcp" }

func (a sshHostAddress) String() string { return string(a) }

const sshHostKeyPromptEventName = "ssh:host-key"

type sshHostKeyPrompt struct {
	ID                string   `json:"id"`
	Address           string   `json:"address"`
	Fingerprint       string   `json:"fingerprint"`
	KnownFingerprints []string `json:"knownFingerprints,omitempty"`
	Changed           bool     `json:"changed"`
}

var pendingSSHHostKeyPrompts = struct {
	mu      sync.Mutex
	prompts map[string]chan bool
}{
	prompts: make(map[string]chan bool),
}

var applicationSSHKnownHosts = struct {
	mu    sync.Mutex
	store *sshKnownHostStore
}{}

func appSSHKnownHostsPath() string {
	return filepath.Join(appDataDir(), "known_hosts")
}

func applicationSSHKnownHostStore() *sshKnownHostStore {
	applicationSSHKnownHosts.mu.Lock()
	defer applicationSSHKnownHosts.mu.Unlock()
	if applicationSSHKnownHosts.store == nil {
		applicationSSHKnownHosts.store = &sshKnownHostStore{path: appSSHKnownHostsPath()}
	}
	return applicationSSHKnownHosts.store
}

func newAppSSHHostKeyCallback(language string) (ssh.HostKeyCallback, error) {
	// 手动 SSH 连接使用应用目录中的 known_hosts，不读取用户系统 SSH 目录。
	return applicationSSHKnownHostStore().callback(language)
}

func (e *sshHostKeyError) Error() string {
	if e.language == "en-US" {
		if len(e.want) == 0 {
			return fmt.Sprintf("SSH host key is not trusted: %s (%s)", e.address, ssh.FingerprintSHA256(e.key))
		}
		return fmt.Sprintf("SSH host key changed: %s (%s)", e.address, ssh.FingerprintSHA256(e.key))
	}
	if len(e.want) == 0 {
		return fmt.Sprintf("SSH 主机指纹未受信任：%s（%s）", e.address, ssh.FingerprintSHA256(e.key))
	}
	return fmt.Sprintf("SSH 主机指纹已变更：%s（%s）", e.address, ssh.FingerprintSHA256(e.key))
}

func (e *sshHostKeyError) Unwrap() error { return e.cause }

func registerSSHHostKeyPrompt() (string, <-chan bool) {
	var idBytes [16]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return "", nil
	}
	id := hex.EncodeToString(idBytes[:])
	result := make(chan bool, 1)
	pendingSSHHostKeyPrompts.mu.Lock()
	pendingSSHHostKeyPrompts.prompts[id] = result
	pendingSSHHostKeyPrompts.mu.Unlock()
	return id, result
}

func removeSSHHostKeyPrompt(id string) {
	pendingSSHHostKeyPrompts.mu.Lock()
	delete(pendingSSHHostKeyPrompts.prompts, id)
	pendingSSHHostKeyPrompts.mu.Unlock()
}

func resolveSSHHostKeyPrompt(id string, accepted bool) error {
	pendingSSHHostKeyPrompts.mu.Lock()
	result, ok := pendingSSHHostKeyPrompts.prompts[id]
	if ok {
		delete(pendingSSHHostKeyPrompts.prompts, id)
	}
	pendingSSHHostKeyPrompts.mu.Unlock()
	if !ok {
		return errors.New("SSH 主机指纹提示已失效")
	}
	result <- accepted
	return nil
}

func sshHostKeyFingerprints(keys []knownhosts.KnownKey) []string {
	result := make([]string, 0, len(keys))
	seen := make(map[string]struct{}, len(keys))
	for _, known := range keys {
		if known.Key == nil {
			continue
		}
		fingerprint := ssh.FingerprintSHA256(known.Key)
		if _, ok := seen[fingerprint]; ok {
			continue
		}
		seen[fingerprint] = struct{}{}
		result = append(result, fingerprint)
	}
	return result
}

func (s *sshKnownHostStore) callback(language string) (ssh.HostKeyCallback, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureFileLocked(); err != nil {
		return nil, err
	}
	checkKnownHost, err := knownhosts.New(s.path)
	if err != nil {
		return nil, err
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		if err := checkKnownHost(hostname, remote, key); err != nil {
			var keyErr *knownhosts.KeyError
			if errors.As(err, &keyErr) {
				return &sshHostKeyError{
					cause:    err,
					store:    s,
					address:  hostname,
					language: language,
					key:      key,
					want:     append([]knownhosts.KnownKey(nil), keyErr.Want...),
				}
			}
			return err
		}
		return nil
	}, nil
}

func (s *sshKnownHostStore) ensureFileLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(s.path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func (s *sshKnownHostStore) confirm(ctx context.Context, hostKeyErr *sshHostKeyError) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureFileLocked(); err != nil {
		return false, err
	}
	checkKnownHost, err := knownhosts.New(s.path)
	if err != nil {
		return false, err
	}
	currentErr := checkKnownHost(
		hostKeyErr.address,
		sshHostAddress(hostKeyErr.address),
		hostKeyErr.key,
	)
	if currentErr == nil {
		return true, nil
	}
	var keyErr *knownhosts.KeyError
	if !errors.As(currentErr, &keyErr) {
		return false, currentErr
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	var accepted bool
	if s.prompt != nil {
		accepted = s.prompt(hostKeyErr.language, hostKeyErr.address, hostKeyErr.key, keyErr.Want)
	} else {
		var promptErr error
		accepted, promptErr = awaitSSHHostKeyPrompt(
			ctx,
			hostKeyErr.language,
			hostKeyErr.address,
			hostKeyErr.key,
			keyErr.Want,
		)
		if promptErr != nil {
			return false, promptErr
		}
	}
	if !accepted {
		return false, currentErr
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if err := s.replaceLocked(hostKeyErr.address, hostKeyErr.key, keyErr.Want); err != nil {
		return false, err
	}
	return true, nil
}

func (s *sshKnownHostStore) replaceLocked(
	address string,
	key ssh.PublicKey,
	want []knownhosts.KnownKey,
) error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	removeLines := make(map[int]struct{})
	for _, known := range want {
		if known.Filename == s.path && known.Key != nil && known.Key.Type() == key.Type() {
			removeLines[known.Line] = struct{}{}
		}
	}
	data = removeSSHKnownHostLines(data, removeLines)
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, []byte(knownhosts.Line([]string{address}, key)+"\n")...)
	return writeConfigAtomically(s.path, data)
}

func removeSSHKnownHostLines(data []byte, remove map[int]struct{}) []byte {
	if len(remove) == 0 {
		return data
	}
	result := make([]byte, 0, len(data))
	lineNumber := 0
	for start := 0; start < len(data); {
		end := bytes.IndexByte(data[start:], '\n')
		if end >= 0 {
			end += start + 1
		} else {
			end = len(data)
		}
		lineNumber++
		if _, ok := remove[lineNumber]; !ok {
			result = append(result, data[start:end]...)
		}
		start = end
	}
	return result
}

func awaitSSHHostKeyPrompt(
	ctx context.Context,
	language string,
	address string,
	key ssh.PublicKey,
	want []knownhosts.KnownKey,
) (bool, error) {
	app := application.Get()
	if app == nil || app.Event == nil {
		return false, nil
	}
	id, result := registerSSHHostKeyPrompt()
	if id == "" || result == nil {
		return false, errors.New("生成 SSH 主机指纹提示 ID 失败")
	}
	prompt := sshHostKeyPrompt{
		ID:                id,
		Address:           address,
		Fingerprint:       ssh.FingerprintSHA256(key),
		KnownFingerprints: sshHostKeyFingerprints(want),
		Changed:           len(want) > 0,
	}
	if app.Event.Emit(sshHostKeyPromptEventName, prompt) {
		removeSSHHostKeyPrompt(id)
		return false, nil
	}
	select {
	case accepted := <-result:
		return accepted, nil
	case <-ctx.Done():
		removeSSHHostKeyPrompt(id)
		return false, ctx.Err()
	}
}
