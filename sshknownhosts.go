package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
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

// SSHKnownHost 是应用内 known_hosts 中的一条可管理记录。
type SSHKnownHost struct {
	ID          string `json:"id"`
	Hosts       string `json:"hosts"`
	KeyType     string `json:"keyType"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment,omitempty"`
	Marker      string `json:"marker,omitempty"`
}

type sshKnownHostRecord struct {
	line  int
	entry SSHKnownHost
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

func (s *sshKnownHostStore) list() ([]SSHKnownHost, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, _, err := s.recordsLocked()
	if err != nil {
		return nil, err
	}
	result := make([]SSHKnownHost, 0, len(records))
	for _, record := range records {
		result = append(result, record.entry)
	}
	return result, nil
}

func (s *sshKnownHostStore) update(entry SSHKnownHost) (SSHKnownHost, error) {
	if strings.TrimSpace(entry.ID) == "" {
		return SSHKnownHost{}, errors.New("SSH 主机指纹记录 ID 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, lines, err := s.recordsLocked()
	if err != nil {
		return SSHKnownHost{}, err
	}
	var record *sshKnownHostRecord
	for index := range records {
		if records[index].entry.ID == entry.ID {
			record = &records[index]
			break
		}
	}
	if record == nil {
		return SSHKnownHost{}, errors.New("SSH 主机指纹记录已变更，请刷新后重试")
	}
	line, err := formatSSHKnownHostLine(entry, record.entry.Marker)
	if err != nil {
		return SSHKnownHost{}, err
	}
	lines[record.line-1] = line
	if err := writeConfigAtomically(s.path, []byte(strings.Join(lines, "\n"))); err != nil {
		return SSHKnownHost{}, err
	}
	updated, _, err := parseSSHKnownHostLine(line)
	if err != nil {
		return SSHKnownHost{}, err
	}
	updated.ID = sshKnownHostID(record.line, line)
	return updated, nil
}

func (s *sshKnownHostStore) delete(id string) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("SSH 主机指纹记录 ID 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, lines, err := s.recordsLocked()
	if err != nil {
		return err
	}
	line := 0
	for _, record := range records {
		if record.entry.ID == id {
			line = record.line
			break
		}
	}
	if line == 0 {
		return errors.New("SSH 主机指纹记录已变更，请刷新后重试")
	}
	lines = append(lines[:line-1], lines[line:]...)
	return writeConfigAtomically(s.path, []byte(strings.Join(lines, "\n")))
}

func (s *sshKnownHostStore) recordsLocked() ([]sshKnownHostRecord, []string, error) {
	if err := s.ensureFileLocked(); err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil, nil, err
	}
	if _, err := knownhosts.New(s.path); err != nil {
		return nil, nil, err
	}
	lines := strings.Split(string(data), "\n")
	records := make([]sshKnownHostRecord, 0, len(lines))
	for index, line := range lines {
		entry, ok, err := parseSSHKnownHostLine(line)
		if err != nil {
			return nil, nil, fmt.Errorf("应用 SSH known_hosts 第 %d 行无效: %w", index+1, err)
		}
		if !ok {
			continue
		}
		entry.ID = sshKnownHostID(index+1, strings.TrimSpace(line))
		records = append(records, sshKnownHostRecord{line: index + 1, entry: entry})
	}
	return records, lines, nil
}

func parseSSHKnownHostLine(line string) (SSHKnownHost, bool, error) {
	raw := strings.TrimSpace(line)
	if raw == "" || strings.HasPrefix(raw, "#") {
		return SSHKnownHost{}, false, nil
	}
	fields := strings.Fields(raw)
	if len(fields) < 3 {
		return SSHKnownHost{}, false, errors.New("缺少主机、公钥类型或公钥")
	}
	offset := 0
	marker := ""
	if strings.HasPrefix(fields[0], "@") {
		marker = fields[0]
		offset++
	}
	if len(fields) < offset+3 {
		return SSHKnownHost{}, false, errors.New("缺少主机、公钥类型或公钥")
	}
	hosts := fields[offset]
	if !validConfigValue(hosts, 4096) {
		return SSHKnownHost{}, false, errors.New("主机匹配项无效")
	}
	authorizedKey := strings.Join(fields[offset+1:], " ")
	key, comment, options, rest, err := ssh.ParseAuthorizedKey([]byte(authorizedKey))
	if err != nil {
		return SSHKnownHost{}, false, fmt.Errorf("公钥无效: %w", err)
	}
	if len(options) > 0 || strings.TrimSpace(string(rest)) != "" {
		return SSHKnownHost{}, false, errors.New("公钥格式无效")
	}
	return SSHKnownHost{
		Hosts:       hosts,
		KeyType:     key.Type(),
		PublicKey:   strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))),
		Fingerprint: ssh.FingerprintSHA256(key),
		Comment:     strings.TrimSpace(comment),
		Marker:      marker,
	}, true, nil
}

func formatSSHKnownHostLine(entry SSHKnownHost, marker string) (string, error) {
	hosts := strings.TrimSpace(entry.Hosts)
	if !validConfigValue(hosts, 4096) {
		return "", errors.New("主机匹配项无效")
	}
	publicKey := strings.TrimSpace(entry.PublicKey)
	if publicKey == "" {
		return "", errors.New("公钥不能为空")
	}
	key, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(publicKey))
	if err != nil {
		return "", fmt.Errorf("公钥无效: %w", err)
	}
	if len(options) > 0 || strings.TrimSpace(string(rest)) != "" {
		return "", errors.New("公钥格式无效")
	}
	comment := strings.TrimSpace(entry.Comment)
	if comment != "" && !validTextValue(comment, 4096) {
		return "", errors.New("备注无效")
	}
	if marker != "" && marker != "@cert-authority" && marker != "@revoked" {
		return "", errors.New("known_hosts 标记无效")
	}
	parts := make([]string, 0, 4)
	if marker != "" {
		parts = append(parts, marker)
	}
	parts = append(parts, hosts, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))))
	if comment != "" {
		parts = append(parts, comment)
	}
	line := strings.Join(parts, " ")
	if err := validateSSHKnownHostLine(line); err != nil {
		return "", err
	}
	return line, nil
}

func validateSSHKnownHostLine(line string) error {
	file, err := os.CreateTemp("", ".tinkerkit-known-host-*")
	if err != nil {
		return err
	}
	path := file.Name()
	defer func() {
		_ = file.Close()
		_ = os.Remove(path)
	}()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := file.WriteString(line + "\n"); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	_, err = knownhosts.New(path)
	return err
}

func sshKnownHostID(line int, raw string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%d:%s", line, raw)))
	return hex.EncodeToString(digest[:])
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
