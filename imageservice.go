package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const (
	imageCommandTimeout     = 15 * time.Second
	imagePushTimeout        = 5 * time.Minute
	maxImageCommandOutput   = 8 << 20
	maxDockerDeleteImages   = 100
	maxSSHConfigFileSize    = 1 << 20
	maxSSHConfigFiles       = 128
	maxSSHConfigDepth       = 8
	maxRegistryRepositories = 10000
	maxRegistryTags         = 10000
	maxRegistryBodySize     = 8 << 20
	maxImageCacheEntries    = 512
	maxImageCacheBytes      = 128 << 20
	maxImageCacheEntryBytes = 2 << 20
	registryConcurrency     = 4
	imageDetailConcurrency  = 4
	prewarmQueueSize        = 128
	registryListTimeout     = 30 * time.Second
)

// SSHConfigHost 是 ~/.ssh/config 中可以直接交给系统 ssh 的 Host 别名。
type SSHConfigHost struct {
	Alias string `json:"alias"`
}

type DockerStatus struct {
	Available bool   `json:"available"`
	CLIPath   string `json:"cliPath"`
	Version   string `json:"version"`
	Error     string `json:"error"`
}

type DockerImage struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Tags       []string `json:"tags"`
	Repository string   `json:"repository"`
	Digest     string   `json:"digest"`
	MediaType  string   `json:"mediaType"`
	SizeType   string   `json:"sizeType"`
	Size       string   `json:"size"`
	SizeBytes  int64    `json:"sizeBytes"`
	CreatedAt  string   `json:"createdAt"`
}

const (
	registryImageMetadataEventName      = "image-manager:registry-metadata"
	registryImageMetadataStateEventName = "image-manager:registry-metadata-state"
	registryImageMetadataStateLoading   = "loading"
	registryImageMetadataStateComplete  = "complete"
)

type registryImageMetadataEvent struct {
	SourceID  string `json:"sourceID"`
	ImageID   string `json:"imageID"`
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
	SizeType  string `json:"sizeType"`
	Size      string `json:"size"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"`
}

type registryImageMetadataStateEvent struct {
	SourceID string `json:"sourceID"`
	State    string `json:"state"`
}

type DockerImageDetail struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Tags         []string            `json:"tags"`
	Size         int64               `json:"size"`
	CreatedAt    string              `json:"createdAt"`
	Architecture string              `json:"architecture"`
	OS           string              `json:"os"`
	Labels       map[string]string   `json:"labels"`
	Command      []string            `json:"command"`
	Entrypoint   []string            `json:"entrypoint"`
	Repository   string              `json:"repository"`
	Digest       string              `json:"digest"`
	MediaType    string              `json:"mediaType"`
	SizeType     string              `json:"sizeType"`
	Manifest     *RegistryManifest   `json:"manifest"`
	Index        *RegistryIndex      `json:"index"`
	Metadata     DockerImageMetadata `json:"metadata"`
	Layers       []DockerImageLayer  `json:"layers"`
	Runtime      DockerRuntimeConfig `json:"runtime"`
	RawManifest  string              `json:"rawManifest"`
}

type DockerImageMetadata struct {
	CreatedAt     string   `json:"createdAt"`
	Architecture  string   `json:"architecture"`
	OS            string   `json:"os"`
	OSVersion     string   `json:"osVersion"`
	Variant       string   `json:"variant"`
	Author        string   `json:"author"`
	DockerVersion string   `json:"dockerVersion"`
	Container     string   `json:"container"`
	ConfigDigest  string   `json:"configDigest"`
	RootFSType    string   `json:"rootfsType"`
	DiffIDs       []string `json:"diffIDs"`
}

type DockerImageLayer struct {
	Size      int64  `json:"size"`
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
}

type DockerHealthcheck struct {
	Test        []string `json:"test"`
	Interval    string   `json:"interval"`
	Timeout     string   `json:"timeout"`
	StartPeriod string   `json:"startPeriod"`
	Retries     int      `json:"retries"`
}

type DockerRuntimeConfig struct {
	User            string             `json:"user"`
	WorkingDir      string             `json:"workingDir"`
	Env             []string           `json:"env"`
	ExposedPorts    []string           `json:"exposedPorts"`
	Volumes         []string           `json:"volumes"`
	StopSignal      string             `json:"stopSignal"`
	Shell           []string           `json:"shell"`
	Command         []string           `json:"command"`
	Entrypoint      []string           `json:"entrypoint"`
	Healthcheck     *DockerHealthcheck `json:"healthcheck"`
	TTY             bool               `json:"tty"`
	OpenStdin       bool               `json:"openStdin"`
	NetworkDisabled bool               `json:"networkDisabled"`
}

type RegistryDescriptor struct {
	MediaType string            `json:"mediaType"`
	Digest    string            `json:"digest"`
	Size      int64             `json:"size"`
	Platform  *RegistryPlatform `json:"platform"`
}

type RegistryPlatform struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Variant      string `json:"variant"`
}

type RegistryManifest struct {
	SchemaVersion int                  `json:"schemaVersion"`
	MediaType     string               `json:"mediaType"`
	Config        RegistryDescriptor   `json:"config"`
	Layers        []RegistryDescriptor `json:"layers"`
}

type RegistryIndex struct {
	SchemaVersion int                  `json:"schemaVersion"`
	MediaType     string               `json:"mediaType"`
	Manifests     []RegistryDescriptor `json:"manifests"`
}

type DockerOperationResult struct {
	Success bool   `json:"success"`
	Image   string `json:"image"`
	Output  string `json:"output"`
	Error   string `json:"error"`
}

type DockerDeleteFailure struct {
	ImageID string `json:"imageID"`
	Error   string `json:"error"`
}

// DockerDeleteTarget 固定删除确认时看到的镜像及其 digest。
type DockerDeleteTarget struct {
	ImageID        string `json:"imageID"`
	ExpectedDigest string `json:"expectedDigest,omitempty"`
}

type DockerDeleteResult struct {
	Deleted []string              `json:"deleted"`
	Failed  []DockerDeleteFailure `json:"failed"`
}

type imageCommandRunner func(context.Context, string, ...string) ([]byte, error)

// ImageService 通过本机 docker CLI 和系统 ssh 管理镜像。
type ImageService struct {
	config                *ConfigService
	runner                imageCommandRunner
	ctx                   context.Context
	cancel                context.CancelFunc
	mu                    sync.Mutex
	cacheCalls            map[string]*imageCacheCall
	cacheDir              string
	registryTransport     http.RoundTripper
	eventEmitter          func(string, any)
	registrySem           chan struct{}
	detailSem             chan struct{}
	inventory             map[string]imageInventory
	prewarmOnce           sync.Once
	prewarmQueue          chan prewarmJob
	prewarmWG             sync.WaitGroup
	prewarmGenerations    map[string]*prewarmGeneration
	activeSourceID        string
	requestToken          uint64
	activeListToken       uint64
	activeListCancel      context.CancelFunc
	activeListFingerprint string
	activeListSourceID    string
	shutdownOnce          sync.Once
	watchStartMu          sync.Mutex
	watchWorker           *watchWorker
	watchGeneration       uint64
	watchSnapshots        map[string]*watchScan
	watchMutationMu       sync.RWMutex
	watchDeleteMu         sync.Mutex
	watchDeleting         map[string]bool
	taskMu                sync.Mutex
	tasks                 map[string]*imageTaskState
	taskOrder             []string
	taskRevision          uint64
	exportSem             chan struct{}
	exportWG              sync.WaitGroup
	exportQueueMu         sync.Mutex
}

type imageCacheCall struct {
	done   chan struct{}
	detail DockerImageDetail
	err    error
}

type prewarmJob struct {
	sourceID    string
	generation  uint64
	ctx         context.Context
	source      ImageSource
	cliPath     string
	fingerprint string
	imageID     string
	repository  string
}

type prewarmGeneration struct {
	number      uint64
	fingerprint string
	ctx         context.Context
	cancel      context.CancelFunc
}

func NewImageService(config *ConfigService) *ImageService {
	ctx, cancel := context.WithCancel(context.Background())
	service := &ImageService{config: config, ctx: ctx, cancel: cancel, cacheCalls: make(map[string]*imageCacheCall), inventory: make(map[string]imageInventory), prewarmGenerations: make(map[string]*prewarmGeneration), exportSem: make(chan struct{}, 2)}
	if config != nil {
		config.setOnChange(func(Config) { service.cleanupImageCache() })
	}
	service.ensurePrewarmWorkers()
	return service
}

func (s *ImageService) ServiceName() string { return "ImageService" }

func (s *ImageService) setEventEmitter(emitter func(string, any)) {
	if s != nil {
		s.eventEmitter = emitter
	}
}

func (s *ImageService) emitEvent(name string, data any) {
	if s != nil && s.eventEmitter != nil {
		s.eventEmitter(name, data)
	}
}

func runImageCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	stdout := &limitedBuffer{limit: maxImageCommandOutput}
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return stdout.Bytes(), ctx.Err()
		}
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return stdout.Bytes(), fmt.Errorf("%w: %s", err, message)
		}
		return stdout.Bytes(), err
	}
	return stdout.Bytes(), nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	remaining := b.limit - b.Len()
	if remaining <= 0 {
		return 0, errors.New("command output exceeds limit")
	}
	if len(p) > remaining {
		_, _ = b.Buffer.Write(p[:remaining])
		return remaining, errors.New("command output exceeds limit")
	}
	return b.Buffer.Write(p)
}

func (s *ImageService) sourceSnapshot(sourceID string) (ImageSource, string, string, error) {
	if s == nil || s.config == nil {
		return ImageSource{}, "", "", errors.New("镜像服务未配置")
	}
	config := normalizeConfig(s.config.Get())
	cliPath := config.DockerCLIPath
	if cliPath == "" {
		cliPath = "docker"
	}
	for _, source := range config.ImageSources {
		if source.ID == sourceID {
			if source.Kind == "local" {
				return source, cliPath, imageSourceFingerprint(source, cliPath), nil
			}
			if source.Kind == "ssh" && validSSHHost(source.SSHHost) {
				return source, "docker", imageSourceFingerprint(source, "docker"), nil
			}
			if source.Kind == "registry" {
				if _, ok := normalizeRegistryURL(source.RegistryURL); ok {
					return source, "", imageSourceFingerprint(source, ""), nil
				}
			}
			return ImageSource{}, "", "", errors.New("镜像来源无效")
		}
	}
	return ImageSource{}, "", "", fmt.Errorf("镜像来源 %q 不存在", sourceID)
}

func (s *ImageService) source(sourceID string) (ImageSource, string, error) {
	source, cliPath, _, err := s.sourceSnapshot(sourceID)
	return source, cliPath, err
}

func imageSourceFingerprint(source ImageSource, cliPath string) string {
	value := struct {
		Kind          string `json:"kind"`
		Endpoint      string `json:"endpoint"`
		Host          string `json:"host"`
		Port          int    `json:"port"`
		Username      string `json:"username"`
		Password      string `json:"password"`
		CLI           string `json:"cli"`
		KeyPath       string `json:"keyPath"`
		PrivateKey    string `json:"privateKey"`
		KeyPassphrase string `json:"keyPassphrase"`
	}{Kind: source.Kind, CLI: cliPath}
	switch source.Kind {
	case "registry":
		value.Endpoint, value.Username, value.Password = source.RegistryURL, source.RegistryUsername, source.RegistryPassword
	case "ssh":
		value.Host, value.Port, value.Username = source.SSHHost, source.SSHPort, source.SSHUsername
		value.Password, value.KeyPath = source.SSHPassword, source.SSHPrivateKeyPath
		value.PrivateKey, value.KeyPassphrase = source.SSHPrivateKey, source.SSHKeyPassphrase
	}
	b, _ := json.Marshal(value)
	digest := sha256.Sum256(b)
	return fmt.Sprintf("sha256:%x", digest[:])
}

func validSSHHost(host string) bool {
	if !validConfigValue(host, 255) || strings.HasPrefix(host, "-") {
		return false
	}
	for _, r := range host {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune(".-:_[]", r) {
			continue
		}
		return false
	}
	return true
}

func validPathValue(path string, maxLength int) bool {
	if path == "" || len(path) > maxLength {
		return false
	}
	for _, r := range path {
		if r == '\x00' || r == '\n' || r == '\r' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validImageReference(reference string) bool {
	if !validConfigValue(reference, 512) || strings.HasPrefix(reference, "-") {
		return false
	}
	return true
}

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

func buildImageCommand(source ImageSource, cliPath string, dockerArgs ...string) (string, []string, error) {
	if !validPathValue(cliPath, 4096) || strings.HasPrefix(cliPath, "-") {
		return "", nil, errors.New("Docker CLI 路径无效")
	}
	if source.Kind == "local" {
		return cliPath, append([]string(nil), dockerArgs...), nil
	}
	if source.Kind != "ssh" || !validSSHHost(source.SSHHost) {
		return "", nil, errors.New("镜像来源无效")
	}
	remoteArgs := append([]string{cliPath}, dockerArgs...)
	sshArgs := []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"}
	if source.SSHPort > 0 && source.SSHPort != 22 {
		sshArgs = append(sshArgs, "-p", strconv.Itoa(source.SSHPort))
	}
	if source.SSHUsername != "" {
		sshArgs = append(sshArgs, "-l", source.SSHUsername)
	}
	if source.SSHPrivateKeyPath != "" {
		sshArgs = append(sshArgs, "-i", source.SSHPrivateKeyPath)
	}
	sshArgs = append(sshArgs, "--", source.SSHHost, shellJoin(remoteArgs))
	return "ssh", sshArgs, nil
}

func (s *ImageService) runDocker(sourceID string, args []string, timeout time.Duration) ([]byte, error) {
	source, cliPath, err := s.source(sourceID)
	if err != nil {
		return nil, err
	}
	return s.runDockerSnapshot(source, cliPath, args, timeout)
}

func (s *ImageService) runDockerSnapshot(source ImageSource, cliPath string, args []string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(s.serviceContext(), timeout)
	defer cancel()
	return s.runDockerSnapshotContext(ctx, source, cliPath, args)
}

func (s *ImageService) runDockerSnapshotContext(ctx context.Context, source ImageSource, cliPath string, args []string) ([]byte, error) {
	if source.Kind == "ssh" && (source.SSHPassword != "" || source.SSHPrivateKey != "" || source.SSHPrivateKeyPath != "") {
		return runAuthenticatedSSH(ctx, source, cliPath, args...)
	}
	name, commandArgs, err := buildImageCommand(source, cliPath, args...)
	if err != nil {
		return nil, err
	}
	runner := s.runner
	if runner == nil {
		runner = runImageCommand
	}
	return runner(ctx, name, commandArgs...)
}

func runAuthenticatedSSH(ctx context.Context, source ImageSource, cliPath string, dockerArgs ...string) ([]byte, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("获取 SSH 主目录失败")
	}
	hostKeyCallback, err := knownhosts.New(filepath.Join(home, ".ssh", "known_hosts"))
	if err != nil {
		return nil, errors.New("读取 SSH known_hosts 失败")
	}
	user := source.SSHUsername
	if user == "" {
		user = os.Getenv("USER")
	}
	if user == "" {
		return nil, errors.New("SSH 用户名为空")
	}
	authMethods := make([]ssh.AuthMethod, 0, 3)
	if source.SSHPassword != "" {
		authMethods = append(authMethods, passwordAuthMethods(source.SSHPassword)...)
	}
	keyData := source.SSHPrivateKey
	if keyData == "" && source.SSHPrivateKeyPath != "" {
		keyData, err = readSSHPrivateKeyFile(source.SSHPrivateKeyPath)
		if err != nil {
			return nil, errors.New("读取 SSH 私钥文件失败")
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
			return nil, errors.New("解析 SSH 私钥失败")
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if len(authMethods) == 0 {
		return nil, errors.New("SSH 未配置认证凭据")
	}
	host := strings.TrimPrefix(strings.TrimSuffix(source.SSHHost, "]"), "[")
	port := source.SSHPort
	if port == 0 {
		port = 22
	}
	config := &ssh.ClientConfig{User: user, Auth: authMethods, HostKeyCallback: hostKeyCallback, Timeout: imageCommandTimeout}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	client, err := dialSSHClient(ctx, address, config)
	if err == nil {
		defer client.Close()
		return runSSHCommand(ctx, client, cliPath, dockerArgs...)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, errors.New("连接 SSH 主机失败")
}

func runAuthenticatedSSHStream(ctx context.Context, source ImageSource, cliPath string, dst io.Writer, dockerArgs ...string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return errors.New("获取 SSH 主目录失败")
	}
	hostKeyCallback, err := knownhosts.New(filepath.Join(home, ".ssh", "known_hosts"))
	if err != nil {
		return errors.New("读取 SSH known_hosts 失败")
	}
	user := source.SSHUsername
	if user == "" {
		user = os.Getenv("USER")
	}
	if user == "" {
		return errors.New("SSH 用户名为空")
	}
	authMethods := make([]ssh.AuthMethod, 0, 3)
	if source.SSHPassword != "" {
		authMethods = append(authMethods, passwordAuthMethods(source.SSHPassword)...)
	}
	keyData := source.SSHPrivateKey
	if keyData == "" && source.SSHPrivateKeyPath != "" {
		keyData, err = readSSHPrivateKeyFile(source.SSHPrivateKeyPath)
		if err != nil {
			return errors.New("读取 SSH 私钥文件失败")
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
			return errors.New("解析 SSH 私钥失败")
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if len(authMethods) == 0 {
		return errors.New("SSH 未配置认证凭据")
	}
	host := strings.TrimPrefix(strings.TrimSuffix(source.SSHHost, "]"), "[")
	port := source.SSHPort
	if port == 0 {
		port = 22
	}
	config := &ssh.ClientConfig{User: user, Auth: authMethods, HostKeyCallback: hostKeyCallback, Timeout: imageCommandTimeout}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	client, err := dialSSHClient(ctx, address, config)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("连接 SSH 主机失败")
	}
	defer client.Close()
	return runSSHCommandToWriter(ctx, client, cliPath, dst, dockerArgs...)
}

func runSSHCommand(ctx context.Context, client *ssh.Client, cliPath string, dockerArgs ...string) ([]byte, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, errors.New("创建 SSH 会话失败")
	}
	defer session.Close()
	stdout := &limitedBuffer{limit: maxImageCommandOutput}
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	session.Stdout = stdout
	session.Stderr = stderr
	if err := session.Start(shellJoin(append([]string{cliPath}, dockerArgs...))); err != nil {
		return nil, errors.New("启动远程 Docker 命令失败")
	}
	wait := make(chan error, 1)
	go func() { wait <- session.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			return stdout.Bytes(), fmt.Errorf("远程 Docker 命令失败: %w", err)
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
		return errors.New("创建 SSH 会话失败")
	}
	defer session.Close()
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	session.Stdout = dst
	session.Stderr = stderr
	if err := session.Start(shellJoin(append([]string{cliPath}, dockerArgs...))); err != nil {
		return errors.New("启动远程 Docker 命令失败")
	}
	wait := make(chan error, 1)
	go func() { wait <- session.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			if stderr.Len() > 0 {
				return fmt.Errorf("远程 Docker 导出失败: %s", stderr.String())
			}
			return err
		}
		return nil
	case <-ctx.Done():
		_ = client.Close()
		return ctx.Err()
	}
}

func readSSHPrivateKeyFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 128<<10 {
		return "", errors.New("SSH 私钥文件无效")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (s *ImageService) GetSSHConfigHosts() ([]SSHConfigHost, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return []SSHConfigHost{}, fmt.Errorf("获取用户主目录失败: %w", err)
	}
	return parseSSHConfigFileTree(filepath.Join(home, ".ssh", "config"))
}

type sshConfigParseState struct {
	home         string
	hosts        []SSHConfigHost
	seenHosts    map[string]bool
	seenFiles    map[string]bool
	fileCount    int
	totalBytes   int64
	currentHosts []string
}

func parseSSHConfigFileTree(path string) ([]SSHConfigHost, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return []SSHConfigHost{}, fmt.Errorf("获取用户主目录失败: %w", err)
	}
	state := &sshConfigParseState{home: home, hosts: []SSHConfigHost{}, seenHosts: map[string]bool{}, seenFiles: map[string]bool{}}
	if err := state.parseFile(path, 0); err != nil {
		return []SSHConfigHost{}, err
	}
	return state.hosts, nil
}

func parseSSHConfigHosts(reader io.Reader) []SSHConfigHost {
	data, err := io.ReadAll(io.LimitReader(reader, maxSSHConfigFileSize))
	if err != nil {
		return []SSHConfigHost{}
	}
	return parseSSHConfigHostData(data)
}

func parseSSHConfigHostData(data []byte) []SSHConfigHost {
	result := make([]SSHConfigHost, 0)
	seen := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		key, values := parseSSHConfigDirective(line)
		if key != "host" {
			continue
		}
		for _, alias := range values {
			if !isConcreteSSHHostAlias(alias) || seen[alias] {
				continue
			}
			seen[alias] = true
			result = append(result, SSHConfigHost{Alias: alias})
		}
	}
	return result
}

func parseSSHConfigDirective(line string) (string, []string) {
	if index := strings.IndexByte(line, '#'); index >= 0 {
		line = line[:index]
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return "", nil
	}
	key := strings.ToLower(fields[0])
	if strings.HasPrefix(key, "host=") {
		fields = append([]string{"host", fields[0][len("host="):]}, fields[1:]...)
		key = "host"
	}
	if strings.HasPrefix(key, "include=") {
		fields = append([]string{"include", fields[0][len("include="):]}, fields[1:]...)
		key = "include"
	}
	if len(fields) < 2 {
		return key, nil
	}
	return key, fields[1:]
}

func isConcreteSSHHostAlias(alias string) bool {
	return !strings.ContainsAny(alias, "*?![") && validSSHHost(alias)
}

func (s *sshConfigParseState) parseFile(path string, depth int) error {
	if depth > maxSSHConfigDepth {
		return fmt.Errorf("SSH 配置 Include 嵌套超过限制（最大 %d 层）", maxSSHConfigDepth)
	}
	canonicalPath, err := canonicalSSHConfigPath(path)
	if err != nil {
		return fmt.Errorf("解析 SSH 配置文件 %q 失败: %w", path, err)
	}
	if s.seenFiles[canonicalPath] {
		return nil
	}
	if s.fileCount >= maxSSHConfigFiles {
		return fmt.Errorf("SSH 配置 Include 文件数量超过限制（最大 %d 个）", maxSSHConfigFiles)
	}
	info, err := os.Stat(canonicalPath)
	if err != nil {
		return fmt.Errorf("读取 SSH 配置文件 %q 失败: %w", canonicalPath, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("SSH 配置路径 %q 不是普通文件", canonicalPath)
	}
	if info.Size() > maxSSHConfigFileSize {
		return fmt.Errorf("SSH 配置文件 %q 超过大小限制", canonicalPath)
	}
	file, err := os.Open(canonicalPath)
	if err != nil {
		return fmt.Errorf("读取 SSH 配置文件 %q 失败: %w", canonicalPath, err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSSHConfigFileSize+1))
	if err != nil {
		return fmt.Errorf("读取 SSH 配置文件 %q 失败: %w", canonicalPath, err)
	}
	if len(data) > maxSSHConfigFileSize {
		return fmt.Errorf("SSH 配置文件 %q 超过大小限制", canonicalPath)
	}
	s.totalBytes += int64(len(data))
	if s.totalBytes > int64(maxSSHConfigFileSize)*maxSSHConfigFiles {
		return errors.New("SSH 配置总读取大小超过限制")
	}
	s.seenFiles[canonicalPath] = true
	s.fileCount++
	for _, line := range strings.Split(string(data), "\n") {
		key, values := parseSSHConfigDirective(line)
		switch key {
		case "host":
			s.currentHosts = nil
			for _, alias := range values {
				if !isConcreteSSHHostAlias(alias) {
					continue
				}
				s.currentHosts = append(s.currentHosts, alias)
				if !s.seenHosts[alias] {
					s.seenHosts[alias] = true
					s.hosts = append(s.hosts, SSHConfigHost{Alias: alias})
				}
			}
		case "include":
			for _, pattern := range values {
				matches, err := s.expandInclude(pattern, filepath.Dir(canonicalPath))
				if err != nil {
					return err
				}
				for _, match := range matches {
					if err := s.parseFile(match, depth+1); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

func canonicalSSHConfigPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}
	return filepath.Clean(abs), nil
}

func (s *sshConfigParseState) expandInclude(pattern string, baseDir string) ([]string, error) {
	if pattern == "" || len(pattern) > maxSSHConfigFileSize {
		return nil, errors.New("SSH Include 路径无效")
	}
	hosts := s.currentHosts
	if len(hosts) == 0 && strings.Contains(pattern, "%h") {
		hosts = []string{"*"}
	}
	if len(hosts) == 0 {
		hosts = []string{""}
	}
	matches := make([]string, 0)
	seen := make(map[string]bool)
	for _, host := range hosts {
		includePath := strings.ReplaceAll(pattern, "%d", s.home)
		includePath = strings.ReplaceAll(includePath, "%h", host)
		if includePath == "~" {
			includePath = s.home
		} else if strings.HasPrefix(includePath, "~/") {
			includePath = filepath.Join(s.home, includePath[2:])
		}
		if !filepath.IsAbs(includePath) {
			includePath = filepath.Join(baseDir, includePath)
		}
		if len(includePath) > maxSSHConfigFileSize {
			return nil, errors.New("SSH Include 路径过长")
		}
		globMatches, err := filepath.Glob(includePath)
		if err != nil {
			return nil, fmt.Errorf("解析 SSH Include 路径 %q 失败: %w", pattern, err)
		}
		for _, match := range globMatches {
			canonical, err := canonicalSSHConfigPath(match)
			if err != nil {
				return nil, fmt.Errorf("解析 SSH Include 文件 %q 失败: %w", match, err)
			}
			if !seen[canonical] {
				seen[canonical] = true
				matches = append(matches, match)
			}
		}
	}
	return matches, nil
}

func (s *ImageService) GetDockerStatus(sourceID string) DockerStatus {
	source, cliPath, err := s.source(sourceID)
	if err != nil {
		return DockerStatus{CLIPath: cliPath, Error: err.Error()}
	}
	return s.sourceConnectionStatus(source, cliPath)
}

// TestImageSourceConnection 使用未持久化的来源配置测试 SSH 或 Registry 连接。
func (s *ImageService) TestImageSourceConnection(source ImageSource) error {
	if s == nil || s.config == nil {
		return errors.New("镜像服务未配置")
	}
	normalized, err := s.config.ValidateImageSource(source)
	if err != nil {
		return err
	}
	if normalized.Kind != "ssh" && normalized.Kind != "registry" {
		return errors.New("仅支持测试 SSH 或 Registry 来源")
	}
	config := normalizeConfig(s.config.Get())
	cliPath := config.DockerCLIPath
	if cliPath == "" {
		cliPath = "docker"
	}
	status := s.sourceConnectionStatus(normalized, cliPath)
	if !status.Available {
		return errors.New(status.Error)
	}
	return nil
}

func (s *ImageService) sourceConnectionStatus(source ImageSource, cliPath string) DockerStatus {
	return s.sourceConnectionStatusContext(s.serviceContext(), source, cliPath)
}

// sourceConnectionStatusContext 从外部 ctx 派生连接探测（registry ping 与 CLI --version），
// 保证所有 CLI/registry 状态操作随调用方 ctx（watch 循环/shutdown）取消。
func (s *ImageService) sourceConnectionStatusContext(ctx context.Context, source ImageSource, cliPath string) DockerStatus {
	status := DockerStatus{CLIPath: cliPath}
	if source.Kind == "registry" {
		itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
		defer cancel()
		if err := s.pingRegistry(itemCtx, source); err != nil {
			status.Error = err.Error()
			return status
		}
		status.Available = true
		status.Version = "Registry"
		return status
	}
	itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	output, err := s.runDockerSnapshotContext(itemCtx, source, cliPath, []string{"--version"})
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Available = true
	status.Version = strings.TrimSpace(string(output))
	return status
}

func (s *ImageService) pingRegistry(ctx context.Context, source ImageSource) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	endpoint, ok := normalizeRegistryURL(source.RegistryURL)
	if !ok {
		return errors.New("镜像仓库地址无效：仅支持 HTTPS")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/v2/", nil)
	if err != nil {
		return errors.New("创建 Registry 探测请求失败")
	}
	if source.RegistryUsername != "" {
		request.SetBasicAuth(source.RegistryUsername, source.RegistryPassword)
	}
	transport := http.RoundTripper(remote.DefaultTransport)
	if s.registryTransport != nil {
		transport = s.registryTransport
	}
	client := &http.Client{Transport: &limitedRegistryTransport{base: transport}}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("Registry 不可达: %w", redactRegistryError(err, source))
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	if response.StatusCode == http.StatusUnauthorized {
		if source.RegistryUsername == "" {
			return errors.New("Registry 需要认证：请填写用户名和密码")
		}
		return errors.New("Registry 认证失败：用户名或密码错误，或账号无权访问")
	}
	if response.StatusCode == http.StatusForbidden {
		return errors.New("Registry 认证成功但没有访问权限")
	}
	return fmt.Errorf("Registry 探测返回 HTTP %d", response.StatusCode)
}

type dockerImageListJSON struct {
	ID         string `json:"ID"`
	Repository string `json:"Repository"`
	Tag        string `json:"Tag"`
	Size       string `json:"Size"`
	CreatedAt  string `json:"CreatedAt"`
}

func parseDockerImageSize(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	for i := len(value); i > 0; i-- {
		numberPart := strings.TrimSpace(value[:i])
		unit := strings.ToLower(strings.TrimSpace(value[i:]))
		multiplier, ok := map[string]float64{
			"b":   1,
			"kb":  1000,
			"mb":  1000 * 1000,
			"gb":  1000 * 1000 * 1000,
			"tb":  1000 * 1000 * 1000 * 1000,
			"kib": 1 << 10,
			"mib": 1 << 20,
			"gib": 1 << 30,
			"tib": 1 << 40,
		}[unit]
		if !ok {
			continue
		}
		number, err := strconv.ParseFloat(numberPart, 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			continue
		}
		if number < 0 {
			return 0
		}
		bytes := number * multiplier
		if bytes >= float64(math.MaxInt64) {
			return 0
		}
		return int64(math.Round(bytes))
	}
	return 0
}

func (s *ImageService) ListDockerImages(sourceID string) ([]DockerImage, error) {
	token, requestCtx := s.beginListRequest(sourceID)
	source, cliPath, fingerprint, err := s.sourceSnapshot(sourceID)
	if err != nil {
		if s.listRequestObsolete(token, requestCtx) {
			return []DockerImage{}, nil
		}
		return nil, err
	}
	if !s.setListFingerprint(token, fingerprint) {
		return []DockerImage{}, nil
	}
	if source.Kind == "registry" {
		images, err := s.listRegistryImages(sourceID, source, token, requestCtx)
		if s.listRequestObsolete(token, requestCtx) {
			return []DockerImage{}, nil
		}
		return images, err
	}
	s.cleanupImageCache()
	listCtx, cancel := context.WithTimeout(requestCtx, imageCommandTimeout)
	defer cancel()
	output, err := s.runDockerSnapshotContext(listCtx, source, cliPath, []string{"image", "ls", "--no-trunc", "--format", "{{json .}}"})
	if err != nil {
		if s.listRequestObsolete(token, requestCtx) {
			return []DockerImage{}, nil
		}
		return nil, err
	}
	images := make([]DockerImage, 0)
	byID := make(map[string]int)
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var item dockerImageListJSON
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			if s.listRequestObsolete(token, requestCtx) {
				return []DockerImage{}, nil
			}
			return nil, fmt.Errorf("解析 Docker 镜像列表失败: %w", err)
		}
		name := item.Repository
		if item.Tag != "" {
			name += ":" + item.Tag
		}
		if index, ok := byID[item.ID]; ok {
			if name != "" && !containsString(images[index].Tags, name) {
				images[index].Tags = append(images[index].Tags, name)
			}
			continue
		}
		byID[item.ID] = len(images)
		images = append(images, DockerImage{ID: item.ID, Name: name, Tags: []string{name}, Size: item.Size, SizeBytes: parseDockerImageSize(item.Size), CreatedAt: item.CreatedAt})
	}
	if !s.updateImageInventoryIfCurrent(token, sourceID, fingerprint, source, images) {
		return images, nil
	}
	s.schedulePrewarm(sourceID, source, cliPath, fingerprint, images, token, requestCtx)
	return images, nil
}

func containsString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func registryEndpoint(source ImageSource) (name.Registry, error) {
	u, ok := normalizeRegistryURL(source.RegistryURL)
	if !ok {
		return name.Registry{}, errors.New("镜像仓库地址无效：仅支持 HTTPS")
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return name.Registry{}, errors.New("镜像仓库地址无效")
	}
	registry, err := name.NewRegistry(parsed.Host)
	if err != nil {
		return name.Registry{}, fmt.Errorf("解析镜像仓库地址失败: %w", err)
	}
	return registry, nil
}

func registryOptions(ctx context.Context, source ImageSource) []remote.Option {
	options := []remote.Option{remote.WithContext(ctx)}
	if source.RegistryUsername != "" {
		options = append(options, remote.WithAuth(&authn.Basic{Username: source.RegistryUsername, Password: source.RegistryPassword}))
	}
	return options
}

func (s *ImageService) registryOptions(ctx context.Context, source ImageSource) []remote.Option {
	options := registryOptions(ctx, source)
	transport := http.RoundTripper(remote.DefaultTransport)
	if s != nil && s.registryTransport != nil {
		transport = s.registryTransport
	}
	options = append(options, remote.WithTransport(&limitedRegistryTransport{base: transport}))
	return options
}

type limitedRegistryTransport struct {
	base http.RoundTripper
}

// 仅导出 blob 的请求携带声明大小，其他元数据请求继续使用默认上限。
type registryBlobSizeKey struct{}

func (t *limitedRegistryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err == nil && response != nil && response.Body != nil {
		limit := int64(maxRegistryBodySize)
		if size, ok := request.Context().Value(registryBlobSizeKey{}).(int64); ok && size >= limit && request.Method == http.MethodGet && response.StatusCode == http.StatusOK {
			limit = size + 1
		}
		response.Body = struct {
			io.Reader
			io.Closer
		}{Reader: io.LimitReader(response.Body, limit), Closer: response.Body}
	}
	return response, err
}

func (s *ImageService) registryPermit(ctx context.Context) (func(), error) {
	s.mu.Lock()
	if s.registrySem == nil {
		s.registrySem = make(chan struct{}, registryConcurrency)
	}
	sem := s.registrySem
	s.mu.Unlock()
	select {
	case sem <- struct{}{}:
		return func() { <-sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func registryRepository(source ImageSource, repository string) (name.Repository, error) {
	registry, err := registryEndpoint(source)
	if err != nil {
		return name.Repository{}, err
	}
	if repository == "" || strings.ContainsAny(repository, "@\x00\r\n") {
		return name.Repository{}, errors.New("镜像仓库名称无效")
	}
	repo, err := name.NewRepository(registry.String()+"/"+repository, name.WeakValidation)
	if err != nil {
		return name.Repository{}, fmt.Errorf("解析镜像仓库名称失败: %w", err)
	}
	return repo, nil
}

func registryImageID(repository, digest string) string {
	return repository + "@" + digest
}

func registryTagImageID(repository, tag string) string {
	return repository + ":" + tag
}

func validRegistryTag(tag string) bool {
	if len(tag) == 0 || len(tag) > 128 {
		return false
	}
	for i, r := range tag {
		if i == 0 {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_') {
				return false
			}
			continue
		}
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_.-", r)) {
			return false
		}
	}
	return true
}

func parseRegistryImageID(imageID string) (string, string, error) {
	separator := strings.LastIndexByte(imageID, '@')
	if separator <= 0 {
		return "", "", errors.New("Registry 镜像 ID 无效")
	}
	repository, digest := imageID[:separator], imageID[separator+1:]
	if _, err := v1.NewHash(digest); err != nil || !strings.HasPrefix(digest, "sha256:") || len(digest) != len("sha256:")+64 {
		return "", "", errors.New("Registry 镜像 ID 必须包含规范 sha256 digest")
	}
	if _, err := registryRepository(ImageSource{RegistryURL: "https://placeholder.invalid"}, repository); err != nil {
		// 这里只借助仓库解析器校验名称，不接受任意镜像引用。
		return "", "", errors.New("Registry 镜像仓库名称无效")
	}
	return repository, digest, nil
}

func parseRegistryImageReference(imageID string) (repository, tag, digest string, err error) {
	if separator := strings.LastIndexByte(imageID, '@'); separator > 0 {
		repository, digest, err = parseRegistryImageID(imageID)
		return repository, "", digest, err
	}
	separator := strings.LastIndexByte(imageID, ':')
	if separator <= 0 || separator == len(imageID)-1 {
		return "", "", "", errors.New("Registry 镜像引用必须包含标签或 digest")
	}
	repository, tag = imageID[:separator], imageID[separator+1:]
	if _, err := registryRepository(ImageSource{RegistryURL: "https://placeholder.invalid"}, repository); err != nil {
		return "", "", "", errors.New("Registry 镜像仓库名称无效")
	}
	if !validRegistryTag(tag) {
		return "", "", "", errors.New("Registry 镜像标签无效")
	}
	return repository, tag, "", nil
}

func formatRegistrySize(size int64) string {
	if size <= 0 {
		return ""
	}
	return strconv.FormatInt(size, 10) + " B"
}

func addRegistrySize(total, size int64) int64 {
	if size < 0 || total > math.MaxInt64-size {
		return 0
	}
	return total + size
}

func registryManifestSize(manifest *v1.Manifest) int64 {
	if manifest == nil {
		return 0
	}
	total := addRegistrySize(0, manifest.Config.Size)
	if total == 0 && manifest.Config.Size != 0 {
		return 0
	}
	for _, layer := range manifest.Layers {
		total = addRegistrySize(total, layer.Size)
		if total == 0 && layer.Size != 0 {
			return 0
		}
	}
	return total
}

func registryImageSize(descriptor *remote.Descriptor, image v1.Image) int64 {
	if image != nil {
		if manifest, err := image.Manifest(); err == nil {
			if size := registryManifestSize(manifest); size > 0 {
				return size
			}
		}
	}
	var manifest v1.Manifest
	if descriptor != nil && json.Unmarshal(descriptor.Manifest, &manifest) == nil {
		if size := registryManifestSize(&manifest); size > 0 {
			return size
		}
	}
	if descriptor == nil {
		return 0
	}
	return descriptor.Size
}

func (s *ImageService) listRegistryImages(sourceID string, source ImageSource, token uint64, requestCtx context.Context) ([]DockerImage, error) {
	s.cleanupImageCache()
	ctx, cancel := context.WithTimeout(requestCtx, registryListTimeout)
	defer cancel()
	release, err := s.registryPermit(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	registry, err := registryEndpoint(source)
	if err != nil {
		return nil, err
	}
	options := s.registryOptions(ctx, source)
	puller, err := remote.NewPuller(options...)
	if err != nil {
		return nil, fmt.Errorf("创建 Registry 客户端失败: %w", redactRegistryError(err, source))
	}
	const pageSize = 1000
	repositories := make([]string, 0)
	last := ""
	for len(repositories) < maxRegistryRepositories {
		page, err := remote.CatalogPage(registry, last, pageSize, options...)
		if err != nil {
			return nil, fmt.Errorf("枚举 Registry 仓库失败: %w", redactRegistryError(err, source))
		}
		if len(page) == 0 || len(page) > pageSize {
			break
		}
		repositories = append(repositories, page...)
		if len(page) < pageSize {
			break
		}
		next := page[len(page)-1]
		if next == last {
			return nil, errors.New("Registry 仓库目录分页未前进")
		}
		last = next
	}
	if len(repositories) >= maxRegistryRepositories {
		return nil, errors.New("Registry 仓库数量超过限制")
	}
	byID := make(map[string]int)
	images := make([]DockerImage, 0)
	for _, repositoryName := range repositories {
		repository, err := registryRepository(source, repositoryName)
		if err != nil {
			continue
		}
		tags, err := puller.List(ctx, repository)
		if err != nil {
			return nil, fmt.Errorf("枚举 Registry 仓库 %q 的标签失败: %w", repositoryName, redactRegistryError(err, source))
		}
		if len(tags) > maxRegistryTags {
			return nil, fmt.Errorf("Registry 仓库 %q 的标签数量超过限制", repositoryName)
		}
		for _, tag := range tags {
			if !validRegistryTag(tag) {
				continue
			}
			fullTag := registryTagImageID(repositoryName, tag)
			id := fullTag
			if index, ok := byID[id]; ok {
				if !containsString(images[index].Tags, fullTag) {
					images[index].Tags = append(images[index].Tags, fullTag)
				}
				continue
			}
			byID[id] = len(images)
			images = append(images, DockerImage{ID: id, Name: fullTag, Tags: []string{fullTag}, Repository: repositoryName})
		}
	}
	sort.Slice(images, func(i, j int) bool { return images[i].ID < images[j].ID })
	fingerprint := imageSourceFingerprint(source, "")
	if !s.updateImageInventoryIfCurrent(token, sourceID, fingerprint, source, images) {
		return images, requestCtx.Err()
	}
	s.schedulePrewarm(sourceID, source, "", fingerprint, images, token, requestCtx)
	s.scheduleRegistryMetadata(sourceID, source, images, token, fingerprint, requestCtx)
	return images, nil
}

func (s *ImageService) resolveRegistryTagDigest(ctx context.Context, source ImageSource, repositoryName, tag string) (string, error) {
	repository, err := registryRepository(source, repositoryName)
	if err != nil {
		return "", err
	}
	puller, err := remote.NewPuller(s.registryOptions(ctx, source)...)
	if err != nil {
		return "", fmt.Errorf("创建 Registry 客户端失败: %w", redactRegistryError(err, source))
	}
	descriptor, err := puller.Head(ctx, repository.Tag(tag))
	if err != nil {
		return "", redactRegistryError(err, source)
	}
	digest := descriptor.Digest.String()
	if !canonicalSHA256Digest(digest) {
		return "", fmt.Errorf("Registry 镜像 %q:%q 返回了无效 digest", repositoryName, tag)
	}
	return digest, nil
}

func (s *ImageService) fetchRegistryImageMetadata(ctx context.Context, source ImageSource, imageID string, puller *remote.Puller) (registryImageMetadataEvent, error) {
	repositoryName, tag, digest, err := parseRegistryImageReference(imageID)
	if err != nil {
		return registryImageMetadataEvent{}, err
	}
	repository, err := registryRepository(source, repositoryName)
	if err != nil {
		return registryImageMetadataEvent{}, err
	}
	itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	release, err := s.registryPermit(itemCtx)
	if err != nil {
		return registryImageMetadataEvent{}, err
	}
	defer release()
	var descriptor *remote.Descriptor
	if tag != "" {
		descriptor, err = puller.Get(itemCtx, repository.Tag(tag))
	} else {
		descriptor, err = puller.Get(itemCtx, repository.Digest(digest))
	}
	if err != nil {
		return registryImageMetadataEvent{}, redactRegistryError(err, source)
	}
	resolvedDigest := descriptor.Digest.String()
	if !canonicalSHA256Digest(resolvedDigest) {
		return registryImageMetadataEvent{}, errors.New("Registry 返回了无效 manifest digest")
	}
	if digest != "" && digest != resolvedDigest {
		return registryImageMetadataEvent{}, errors.New("Registry 返回的 manifest digest 与请求不一致")
	}
	var image v1.Image
	if resolvedImage, imageErr := descriptor.Image(); imageErr == nil {
		image = resolvedImage
	}
	sizeType := "manifest"
	if descriptor.MediaType == types.OCIImageIndex || descriptor.MediaType == types.DockerManifestList {
		sizeType = "manifest-index"
	}
	metadata := registryImageMetadataEvent{
		ImageID:   imageID,
		Digest:    resolvedDigest,
		MediaType: string(descriptor.MediaType),
		SizeType:  sizeType,
		SizeBytes: registryImageSize(descriptor, image),
	}
	metadata.Size = formatRegistrySize(metadata.SizeBytes)
	if image != nil {
		if config, configErr := image.ConfigFile(); configErr == nil && config != nil && !config.Created.Time.IsZero() {
			metadata.CreatedAt = config.Created.Time.UTC().Format(time.RFC3339Nano)
		}
	}
	return metadata, nil
}

func (s *ImageService) scheduleRegistryMetadata(sourceID string, source ImageSource, images []DockerImage, token uint64, fingerprint string, requestCtx context.Context) {
	if s == nil || source.Kind != "registry" || len(images) == 0 || s.eventEmitter == nil {
		return
	}
	puller, err := remote.NewPuller(s.registryOptions(requestCtx, source)...)
	if err != nil {
		log.Printf("创建 Registry 元数据客户端失败 source=%s: %v", sourceID, redactRegistryError(err, source))
		return
	}
	s.emitEvent(registryImageMetadataStateEventName, registryImageMetadataStateEvent{
		SourceID: sourceID,
		State:    registryImageMetadataStateLoading,
	})
	jobs := make(chan DockerImage, len(images))
	for _, image := range images {
		jobs <- image
	}
	close(jobs)
	workers := min(registryConcurrency, len(images))
	var workerGroup sync.WaitGroup
	workerGroup.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer workerGroup.Done()
			for {
				select {
				case <-requestCtx.Done():
					return
				case <-s.serviceContext().Done():
					return
				case image, ok := <-jobs:
					if !ok {
						return
					}
					metadata, err := s.fetchRegistryImageMetadata(requestCtx, source, image.ID, puller)
					if err != nil {
						if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
							log.Printf("Registry 镜像元数据加载失败 image=%s: %v", image.ID, redactRegistryError(err, source))
						}
						continue
					}
					metadata.SourceID = sourceID
					if s.listRequestObsolete(token, requestCtx) || !s.sourceFingerprintCurrent(sourceID, fingerprint) {
						return
					}
					s.emitEvent(registryImageMetadataEventName, metadata)
				}
			}
		}()
	}
	go func() {
		workerGroup.Wait()
		if s.listRequestObsolete(token, requestCtx) || !s.sourceFingerprintCurrent(sourceID, fingerprint) {
			return
		}
		s.emitEvent(registryImageMetadataStateEventName, registryImageMetadataStateEvent{
			SourceID: sourceID,
			State:    registryImageMetadataStateComplete,
		})
	}()
}

func redactRegistryError(err error, source ImageSource) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	for _, secret := range []string{source.RegistryPassword, source.RegistryUsername} {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "[redacted]")
		}
	}
	return errors.New(message)
}

type imageCacheEntry struct {
	Schema            int               `json:"schema"`
	SourceID          string            `json:"sourceID"`
	SourceFingerprint string            `json:"sourceFingerprint"`
	Digest            string            `json:"digest"`
	Repository        string            `json:"repository"`
	Detail            DockerImageDetail `json:"detail"`
}

type imageInventory struct {
	Name string
	Tags []string
}

// 详情字段扩展后必须淘汰旧缓存，避免旧 JSON 缺少 layers/runtime/rawManifest。
const imageCacheSchema = 2

func imageCacheKey(sourceID, fingerprint, imageID, repository string) string {
	value := sourceID + "\x00" + fingerprint + "\x00" + imageID + "\x00" + repository
	digest := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", digest[:])
}

func (s *ImageService) imageCacheRoot() string {
	if s != nil && s.cacheDir != "" {
		return s.cacheDir
	}
	return filepath.Join(appDataDir(), "image-cache")
}

func canonicalSHA256Digest(value string) bool {
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	for _, r := range value[len("sha256:"):] {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

func cacheIdentity(source ImageSource, imageID, repository string) (string, string, bool) {
	if source.Kind == "registry" {
		parsedRepository, digest, err := parseRegistryImageID(imageID)
		if err != nil || (repository != "" && repository != parsedRepository) {
			return "", "", false
		}
		return digest, parsedRepository, true
	}
	if !canonicalSHA256Digest(imageID) {
		return "", "", false
	}
	return imageID, "", true
}

func imageInventoryKey(sourceID, fingerprint, digest, repository string) string {
	return sourceID + "\x00" + fingerprint + "\x00" + digest + "\x00" + repository
}

func (s *ImageService) currentInventory(sourceID, fingerprint, digest, repository string) (imageInventory, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.inventory[imageInventoryKey(sourceID, fingerprint, digest, repository)]
	if !ok {
		return imageInventory{}, false
	}
	item.Tags = append([]string(nil), item.Tags...)
	return item, true
}

func applyImageInventory(detail DockerImageDetail, inventory imageInventory, ok bool) DockerImageDetail {
	if !ok {
		return detail
	}
	detail.Name = inventory.Name
	detail.Tags = append([]string(nil), inventory.Tags...)
	return detail
}

func (s *ImageService) updateImageInventory(sourceID, fingerprint string, source ImageSource, images []DockerImage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updateImageInventoryLocked(sourceID, fingerprint, source, images)
}

func (s *ImageService) updateImageInventoryIfCurrent(token uint64, sourceID, fingerprint string, source ImageSource, images []DockerImage) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeListToken != token || s.activeListFingerprint != fingerprint || !s.sourceFingerprintCurrent(sourceID, fingerprint) {
		return false
	}
	s.updateImageInventoryLocked(sourceID, fingerprint, source, images)
	return true
}

func (s *ImageService) updateImageInventoryLocked(sourceID, fingerprint string, source ImageSource, images []DockerImage) {
	if s.inventory == nil {
		s.inventory = make(map[string]imageInventory)
	}
	prefix := sourceID + "\x00" + fingerprint + "\x00"
	for key := range s.inventory {
		if strings.HasPrefix(key, prefix) {
			delete(s.inventory, key)
		}
	}
	for _, image := range images {
		digest, repository, ok := cacheIdentity(source, image.ID, image.Repository)
		if !ok {
			continue
		}
		s.inventory[imageInventoryKey(sourceID, fingerprint, digest, repository)] = imageInventory{Name: image.Name, Tags: append([]string(nil), image.Tags...)}
	}
}

func (s *ImageService) loadImageCache(sourceID, fingerprint, digest, repository, detailID string) (DockerImageDetail, bool) {
	path := filepath.Join(s.imageCacheRoot(), imageCacheKey(sourceID, fingerprint, digest, repository)+".json")
	info, err := os.Stat(path)
	if err != nil || info.Size() <= 0 || info.Size() > maxImageCacheEntryBytes {
		return DockerImageDetail{}, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return DockerImageDetail{}, false
	}
	var entry imageCacheEntry
	if json.Unmarshal(b, &entry) != nil || entry.Schema != imageCacheSchema || entry.SourceID != sourceID || entry.SourceFingerprint != fingerprint || entry.Digest != digest || entry.Repository != repository || entry.Detail.ID != detailID {
		return DockerImageDetail{}, false
	}
	inventory, ok := s.currentInventory(sourceID, fingerprint, digest, repository)
	return applyImageInventory(entry.Detail, inventory, ok), true
}

func writeImageCacheAtomically(path string, data []byte) error {
	if len(data) > maxImageCacheEntryBytes {
		return errors.New("镜像详情缓存条目超过大小限制")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".image-cache-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = tmp.Close(); _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func (s *ImageService) saveImageCache(sourceID, fingerprint, digest, repository string, detail DockerImageDetail) error {
	if !s.sourceFingerprintCurrent(sourceID, fingerprint) {
		return nil
	}
	core := detail
	core.Name = ""
	core.Tags = nil
	entry := imageCacheEntry{Schema: imageCacheSchema, SourceID: sourceID, SourceFingerprint: fingerprint, Digest: digest, Repository: repository, Detail: core}
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	path := filepath.Join(s.imageCacheRoot(), imageCacheKey(sourceID, fingerprint, digest, repository)+".json")
	if err := writeImageCacheAtomically(path, b); err != nil {
		return err
	}
	s.enforceImageCacheLimit()
	return nil
}

func (s *ImageService) removeImageCache(sourceID, fingerprint, imageID, repository string) {
	path := filepath.Join(s.imageCacheRoot(), imageCacheKey(sourceID, fingerprint, imageID, repository)+".json")
	_ = os.Remove(path)
}

type imageCacheFile struct {
	path    string
	size    int64
	modTime time.Time
}

func (s *ImageService) cacheFiles() []imageCacheFile {
	entries, err := os.ReadDir(s.imageCacheRoot())
	if err != nil {
		return nil
	}
	files := make([]imageCacheFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, imageCacheFile{path: filepath.Join(s.imageCacheRoot(), entry.Name()), size: info.Size(), modTime: info.ModTime()})
	}
	return files
}

func (s *ImageService) enforceImageCacheLimit() {
	files := s.cacheFiles()
	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	total := int64(0)
	for _, file := range files {
		total += file.size
	}
	for len(files) > maxImageCacheEntries || total > maxImageCacheBytes {
		if len(files) == 0 {
			break
		}
		oldest := files[0]
		files = files[1:]
		if os.Remove(oldest.path) == nil {
			total -= oldest.size
		}
	}
}

func (s *ImageService) cleanupImageCache() {
	current := make(map[string]string)
	if s != nil && s.config != nil {
		config := normalizeConfig(s.config.Get())
		for _, source := range config.ImageSources {
			cliPath := ""
			if source.Kind == "local" {
				cliPath = config.DockerCLIPath
				if cliPath == "" {
					cliPath = "docker"
				}
			} else if source.Kind == "ssh" {
				cliPath = "docker"
			}
			current[source.ID] = imageSourceFingerprint(source, cliPath)
		}
	}
	s.invalidatePrewarmSources(current)
	for _, file := range s.cacheFiles() {
		remove := file.size <= 0 || file.size > maxImageCacheEntryBytes
		if !remove {
			b, err := os.ReadFile(file.path)
			var entry imageCacheEntry
			if err != nil || json.Unmarshal(b, &entry) != nil || entry.Schema != imageCacheSchema {
				remove = true
			} else if fingerprint, ok := current[entry.SourceID]; !ok || fingerprint != entry.SourceFingerprint {
				remove = true
			}
		}
		if remove {
			_ = os.Remove(file.path)
		}
	}
	s.enforceImageCacheLimit()
}

func (s *ImageService) invalidatePrewarmSources(current map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sourceID, generation := range s.prewarmGenerations {
		fingerprint, ok := current[sourceID]
		if !ok || fingerprint != generation.fingerprint {
			generation.cancel()
			delete(s.prewarmGenerations, sourceID)
			if s.activeSourceID == sourceID {
				s.activeSourceID = ""
			}
		}
	}
	for key := range s.inventory {
		parts := strings.SplitN(key, "\x00", 3)
		if len(parts) < 2 {
			continue
		}
		fingerprint, ok := current[parts[0]]
		if !ok || fingerprint != parts[1] {
			delete(s.inventory, key)
		}
	}
	for key := range s.watchSnapshots {
		parts := strings.SplitN(key, "\x00", 2)
		if len(parts) < 2 {
			continue
		}
		fingerprint, ok := current[parts[0]]
		if !ok || fingerprint != parts[1] {
			delete(s.watchSnapshots, key)
		}
	}
	if s.activeListToken != 0 && s.activeListFingerprint != "" {
		fingerprint, ok := current[s.activeListSourceID]
		if !ok || fingerprint != s.activeListFingerprint {
			if s.activeListCancel != nil {
				s.activeListCancel()
			}
			s.activeListToken = 0
		}
	}
}

func (s *ImageService) sourceFingerprintCurrent(sourceID, fingerprint string) bool {
	_, _, current, err := s.sourceSnapshot(sourceID)
	return err == nil && current == fingerprint
}

func (s *ImageService) watchSourceDeleting(sourceID string) bool {
	s.mu.Lock()
	deleting := s.watchDeleting[sourceID]
	s.mu.Unlock()
	return deleting
}

func (s *ImageService) serviceContext() context.Context {
	if s != nil && s.ctx != nil {
		return s.ctx
	}
	return context.Background()
}

func (s *ImageService) beginListRequest(sourceID string) (uint64, context.Context) {
	s.ensurePrewarmWorkers()
	requestCtx, cancel := context.WithCancel(s.serviceContext())
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requestToken++
	if s.activeListCancel != nil {
		s.activeListCancel()
	}
	if s.activeSourceID != "" {
		if generation := s.prewarmGenerations[s.activeSourceID]; generation != nil {
			generation.cancel()
		}
		delete(s.prewarmGenerations, s.activeSourceID)
	}
	s.activeListToken = s.requestToken
	s.activeListCancel = cancel
	s.activeListFingerprint = ""
	s.activeListSourceID = sourceID
	s.activeSourceID = sourceID
	return s.requestToken, requestCtx
}

func (s *ImageService) listRequestCurrent(token uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeListToken == token
}

// 被新请求或服务生命周期取消的刷新属于正常控制流，不应把 context.Canceled
// 穿透到 Wails 绑定层，变成用户可见的 Binding call failed。
func (s *ImageService) listRequestObsolete(token uint64, requestCtx context.Context) bool {
	return requestCtx.Err() != nil || !s.listRequestCurrent(token)
}

func (s *ImageService) setListFingerprint(token uint64, fingerprint string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeListToken != token {
		return false
	}
	s.activeListFingerprint = fingerprint
	return true
}

func (s *ImageService) ensurePrewarmWorkers() {
	if s == nil {
		return
	}
	s.prewarmOnce.Do(func() {
		if s.ctx == nil {
			s.ctx, s.cancel = context.WithCancel(context.Background())
		}
		if s.cacheCalls == nil {
			s.cacheCalls = make(map[string]*imageCacheCall)
		}
		if s.inventory == nil {
			s.inventory = make(map[string]imageInventory)
		}
		if s.prewarmGenerations == nil {
			s.prewarmGenerations = make(map[string]*prewarmGeneration)
		}
		s.detailSem = make(chan struct{}, imageDetailConcurrency)
		s.prewarmQueue = make(chan prewarmJob, prewarmQueueSize)
		for i := 0; i < imageDetailConcurrency; i++ {
			s.prewarmWG.Add(1)
			go s.prewarmWorker()
		}
	})
}

func (s *ImageService) prewarmWorker() {
	defer s.prewarmWG.Done()
	for {
		select {
		case <-s.serviceContext().Done():
			return
		case job := <-s.prewarmQueue:
			if !s.prewarmGenerationCurrent(job.sourceID, job.fingerprint, job.generation, job.ctx) {
				continue
			}
			if _, err := s.inspectWithGeneration(job.sourceID, job.source, job.cliPath, job.fingerprint, job.imageID, job.repository, job.ctx, job.generation); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				log.Printf("镜像详情预热失败 source=%s fingerprint=%s: %v", job.sourceID, job.fingerprint, redactImageError(err, job.source))
			}
		}
	}
}

func (s *ImageService) prewarmGenerationCurrent(sourceID, fingerprint string, number uint64, expected context.Context) bool {
	s.mu.Lock()
	generation := s.prewarmGenerations[sourceID]
	current := generation != nil && generation.number == number && generation.fingerprint == fingerprint && generation.ctx == expected
	s.mu.Unlock()
	return current && expected.Err() == nil && s.sourceFingerprintCurrent(sourceID, fingerprint)
}

func (s *ImageService) detailPermit(ctx context.Context) (func(), error) {
	s.ensurePrewarmWorkers()
	select {
	case s.detailSem <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-s.detailSem
			return nil, err
		}
		return func() { <-s.detailSem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func redactImageError(err error, source ImageSource) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	for _, secret := range []string{source.SSHPassword, source.SSHPrivateKey, source.SSHPrivateKeyPath, source.RegistryPassword, source.RegistryUsername, source.RegistryURL} {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "[redacted]")
		}
	}
	return errors.New(message)
}

func (s *ImageService) shutdown() {
	if s == nil {
		return
	}
	s.shutdownOnce.Do(func() {
		// 先取消根 ctx，使所有派生 context（watch run、prewarm、CLI 命令）立即收到取消，
		// 再等待各 worker 退出。
		if s.cancel != nil {
			s.cancel()
		}
		s.stopWatch()
		s.mu.Lock()
		for _, generation := range s.prewarmGenerations {
			generation.cancel()
		}
		s.prewarmGenerations = make(map[string]*prewarmGeneration)
		s.watchSnapshots = make(map[string]*watchScan)
		s.mu.Unlock()
		s.prewarmWG.Wait()
		s.exportWG.Wait()
	})
}

func (s *ImageService) schedulePrewarm(sourceID string, source ImageSource, cliPath, fingerprint string, images []DockerImage, token uint64, requestCtx context.Context) {
	if s == nil {
		return
	}
	s.ensurePrewarmWorkers()
	s.mu.Lock()
	if s.activeListToken != token || s.activeListFingerprint != fingerprint || !s.sourceFingerprintCurrent(sourceID, fingerprint) {
		s.mu.Unlock()
		return
	}
	if s.prewarmGenerations == nil {
		s.prewarmGenerations = make(map[string]*prewarmGeneration)
	}
	if s.activeSourceID != "" && s.activeSourceID != sourceID {
		if previous := s.prewarmGenerations[s.activeSourceID]; previous != nil {
			previous.cancel()
		}
		delete(s.prewarmGenerations, s.activeSourceID)
	}
	previous := s.prewarmGenerations[sourceID]
	if previous != nil {
		previous.cancel()
	}
	number := token
	generationContext, cancel := context.WithCancel(requestCtx)
	s.prewarmGenerations[sourceID] = &prewarmGeneration{number: number, fingerprint: fingerprint, ctx: generationContext, cancel: cancel}
	s.activeSourceID = sourceID
	s.mu.Unlock()

	misses := make([]DockerImage, 0, len(images))
	for _, image := range images {
		digest, repository, ok := cacheIdentity(source, image.ID, image.Repository)
		if !ok && source.Kind == "registry" {
			continue
		}
		if ok {
			if _, cached := s.loadImageCache(sourceID, fingerprint, digest, repository, image.ID); !cached {
				misses = append(misses, image)
			}
		}
		if !ok {
			misses = append(misses, image)
		}
	}
	if len(misses) == 0 {
		return
	}
	for _, image := range misses {
		job := prewarmJob{sourceID: sourceID, generation: number, ctx: generationContext, source: source, cliPath: cliPath, fingerprint: fingerprint, imageID: image.ID, repository: image.Repository}
		select {
		case s.prewarmQueue <- job:
		case <-requestCtx.Done():
			return
		case <-s.serviceContext().Done():
			return
		default:
			log.Printf("镜像详情预热队列已满 source=%s fingerprint=%s", sourceID, fingerprint)
			return
		}
	}
}

func (s *ImageService) inspectWithSnapshot(sourceID string, source ImageSource, cliPath, fingerprint, imageID, repository string) (DockerImageDetail, error) {
	return s.inspectWithGeneration(sourceID, source, cliPath, fingerprint, imageID, repository, s.serviceContext(), 0)
}

func (s *ImageService) inspectWithGeneration(sourceID string, source ImageSource, cliPath, fingerprint, imageID, repository string, requestCtx context.Context, generation uint64) (DockerImageDetail, error) {
	digest, repository, cacheable := cacheIdentity(source, imageID, repository)
	if !cacheable {
		release, err := s.detailPermit(requestCtx)
		if err != nil {
			return DockerImageDetail{}, err
		}
		defer release()
		if source.Kind == "registry" {
			return s.inspectRegistryImage(requestCtx, source, imageID, repository)
		}
		return s.inspectDockerImage(requestCtx, source, cliPath, imageID)
	}
	if detail, ok := s.loadImageCache(sourceID, fingerprint, digest, repository, imageID); ok {
		return detail, nil
	}
	key := imageCacheKey(sourceID, fingerprint, digest, repository)
	s.mu.Lock()
	if s.cacheCalls == nil {
		s.cacheCalls = make(map[string]*imageCacheCall)
	}
	if call, ok := s.cacheCalls[key]; ok {
		s.mu.Unlock()
		select {
		case <-call.done:
			if generation == 0 && (errors.Is(call.err, context.Canceled) || errors.Is(call.err, context.DeadlineExceeded)) && requestCtx.Err() == nil {
				return s.inspectWithGeneration(sourceID, source, cliPath, fingerprint, imageID, repository, requestCtx, generation)
			}
			return call.detail, call.err
		case <-requestCtx.Done():
			return DockerImageDetail{}, requestCtx.Err()
		}
	}
	call := &imageCacheCall{done: make(chan struct{})}
	s.cacheCalls[key] = call
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.cacheCalls, key)
		close(call.done)
		s.mu.Unlock()
	}()
	if detail, ok := s.loadImageCache(sourceID, fingerprint, digest, repository, imageID); ok {
		call.detail = detail
		return detail, nil
	}
	release, err := s.detailPermit(requestCtx)
	if err != nil {
		call.err = err
		return DockerImageDetail{}, err
	}
	defer release()
	var detail DockerImageDetail
	var inspectErr error
	if source.Kind == "registry" {
		detail, inspectErr = s.inspectRegistryImage(requestCtx, source, imageID, repository)
	} else {
		detail, inspectErr = s.inspectDockerImage(requestCtx, source, cliPath, imageID)
	}
	if inspectErr == nil {
		inventory, ok := s.currentInventory(sourceID, fingerprint, digest, repository)
		detail = applyImageInventory(detail, inventory, ok)
		if generation == 0 || s.prewarmGenerationCurrent(sourceID, fingerprint, generation, requestCtx) {
			_ = s.saveImageCache(sourceID, fingerprint, digest, repository, detail)
		}
	}
	call.detail, call.err = detail, inspectErr
	return detail, inspectErr
}

func (s *ImageService) inspectDockerImage(ctx context.Context, source ImageSource, cliPath, imageID string) (DockerImageDetail, error) {
	if !validImageReference(imageID) {
		return DockerImageDetail{}, errors.New("镜像 ID 无效")
	}
	commandCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	output, err := s.runDockerSnapshotContext(commandCtx, source, cliPath, []string{"image", "inspect", imageID})
	if err != nil {
		return DockerImageDetail{}, err
	}
	var entries []dockerImageInspectJSON
	if err := json.Unmarshal(output, &entries); err != nil {
		return DockerImageDetail{}, fmt.Errorf("解析 Docker 镜像详情失败: %w", err)
	}
	if len(entries) == 0 {
		return DockerImageDetail{}, errors.New("Docker 镜像详情为空")
	}
	item := entries[0]
	tags := append([]string(nil), item.RepoTags...)
	nameValue := ""
	if len(tags) > 0 {
		nameValue = tags[0]
	}
	metadata := DockerImageMetadata{
		CreatedAt:    item.Created,
		Architecture: item.Architecture,
		OS:           item.OS,
		ConfigDigest: item.ID,
		RootFSType:   item.RootFS.Type,
	}
	return DockerImageDetail{
		ID:           item.ID,
		Name:         nameValue,
		Tags:         tags,
		Size:         item.Size,
		CreatedAt:    item.Created,
		Architecture: item.Architecture,
		OS:           item.OS,
		Labels:       item.Config.Labels,
		Command:      item.Config.Cmd,
		Entrypoint:   item.Config.Entrypoint,
		Metadata:     metadata,
		Layers:       dockerRootFSLayers(item.RootFS.Layers),
		Runtime:      dockerRuntimeConfig(item.Config),
	}, nil
}

func registryDescriptor(value v1.Descriptor) RegistryDescriptor {
	result := RegistryDescriptor{MediaType: string(value.MediaType), Digest: digestString(value.Digest), Size: value.Size}
	if value.Platform != nil {
		result.Platform = &RegistryPlatform{Architecture: value.Platform.Architecture, OS: value.Platform.OS, Variant: value.Platform.Variant}
	}
	return result
}

func digestString(value v1.Hash) string {
	if value.Algorithm == "" || value.Hex == "" {
		return ""
	}
	return value.String()
}

func sortedStringSet(values map[string]struct{}) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func copyStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return append([]string(nil), values...)
}

func durationString(value time.Duration) string {
	if value <= 0 {
		return ""
	}
	return value.String()
}

func dockerHealthcheck(value *v1.HealthConfig) *DockerHealthcheck {
	if value == nil {
		return nil
	}
	return &DockerHealthcheck{
		Test:        copyStrings(value.Test),
		Interval:    durationString(value.Interval),
		Timeout:     durationString(value.Timeout),
		StartPeriod: durationString(value.StartPeriod),
		Retries:     value.Retries,
	}
}

func dockerRuntimeConfig(config v1.Config) DockerRuntimeConfig {
	return DockerRuntimeConfig{
		User:            config.User,
		WorkingDir:      config.WorkingDir,
		Env:             copyStrings(config.Env),
		ExposedPorts:    sortedStringSet(config.ExposedPorts),
		Volumes:         sortedStringSet(config.Volumes),
		StopSignal:      config.StopSignal,
		Shell:           copyStrings(config.Shell),
		Command:         copyStrings(config.Cmd),
		Entrypoint:      copyStrings(config.Entrypoint),
		Healthcheck:     dockerHealthcheck(config.Healthcheck),
		TTY:             config.Tty,
		OpenStdin:       config.OpenStdin,
		NetworkDisabled: config.NetworkDisabled,
	}
}

func dockerImageMetadata(config *v1.ConfigFile, configDigest string, rootfsType string, diffIDs []string) DockerImageMetadata {
	metadata := DockerImageMetadata{ConfigDigest: configDigest, RootFSType: rootfsType, DiffIDs: copyStrings(diffIDs)}
	if config == nil {
		return metadata
	}
	metadata.Architecture = config.Architecture
	metadata.OS = config.OS
	metadata.OSVersion = config.OSVersion
	metadata.Variant = config.Variant
	metadata.Author = config.Author
	metadata.DockerVersion = config.DockerVersion
	metadata.Container = config.Container
	if !config.Created.Time.IsZero() {
		metadata.CreatedAt = config.Created.Time.UTC().Format(time.RFC3339Nano)
	}
	return metadata
}

func dockerImageLayers(values []v1.Descriptor) []DockerImageLayer {
	if len(values) == 0 {
		return nil
	}
	result := make([]DockerImageLayer, 0, len(values))
	for _, value := range values {
		result = append(result, DockerImageLayer{Size: value.Size, Digest: digestString(value.Digest), MediaType: string(value.MediaType)})
	}
	return result
}

func dockerRootFSLayers(values []string) []DockerImageLayer {
	if len(values) == 0 {
		return nil
	}
	result := make([]DockerImageLayer, 0, len(values))
	for _, value := range values {
		result = append(result, DockerImageLayer{Digest: value})
	}
	return result
}

func (s *ImageService) inspectRegistryImage(ctx context.Context, source ImageSource, imageID, repository string) (DockerImageDetail, error) {
	parsedRepository, tag, digest, err := parseRegistryImageReference(imageID)
	if err != nil {
		return DockerImageDetail{}, err
	}
	if repository != "" && repository != parsedRepository {
		return DockerImageDetail{}, errors.New("Registry 镜像仓库不匹配")
	}
	repository = parsedRepository
	repo, err := registryRepository(source, repository)
	if err != nil {
		return DockerImageDetail{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, registryListTimeout)
	defer cancel()
	release, err := s.registryPermit(ctx)
	if err != nil {
		return DockerImageDetail{}, err
	}
	defer release()
	var descriptor *remote.Descriptor
	if digest == "" {
		descriptor, err = remote.Get(repo.Tag(tag), s.registryOptions(ctx, source)...)
	} else {
		descriptor, err = remote.Get(repo.Digest(digest), s.registryOptions(ctx, source)...)
	}
	if err != nil {
		return DockerImageDetail{}, fmt.Errorf("读取 Registry manifest 失败: %w", redactRegistryError(err, source))
	}
	resolvedDigest := descriptor.Digest.String()
	if !canonicalSHA256Digest(resolvedDigest) {
		return DockerImageDetail{}, errors.New("Registry 返回了无效 manifest digest")
	}
	if digest != "" && resolvedDigest != digest {
		return DockerImageDetail{}, errors.New("Registry 返回的 manifest digest 与请求不一致")
	}
	digest = resolvedDigest
	detailName := repository
	var detailTags []string
	if tag != "" {
		detailName = registryTagImageID(repository, tag)
		detailTags = []string{detailName}
	}
	detail := DockerImageDetail{ID: imageID, Name: detailName, Tags: detailTags, Repository: repository, Digest: digest, MediaType: string(descriptor.MediaType), Size: registryImageSize(descriptor, nil), SizeType: "manifest", RawManifest: string(descriptor.Manifest)}
	var envelope struct {
		SchemaVersion int             `json:"schemaVersion"`
		MediaType     string          `json:"mediaType"`
		Config        v1.Descriptor   `json:"config"`
		Layers        []v1.Descriptor `json:"layers"`
		Manifests     []v1.Descriptor `json:"manifests"`
	}
	if err := json.Unmarshal(descriptor.Manifest, &envelope); err != nil {
		return DockerImageDetail{}, fmt.Errorf("解析 Registry manifest 失败: %w", err)
	}
	detail.Metadata.ConfigDigest = digestString(envelope.Config.Digest)
	if descriptor.MediaType == types.OCIImageIndex || descriptor.MediaType == types.DockerManifestList {
		detail.SizeType = "manifest-index"
		manifests := make([]RegistryDescriptor, 0, len(envelope.Manifests))
		for _, item := range envelope.Manifests {
			manifests = append(manifests, registryDescriptor(item))
		}
		detail.Index = &RegistryIndex{SchemaVersion: envelope.SchemaVersion, MediaType: envelope.MediaType, Manifests: manifests}
	} else {
		layers := make([]RegistryDescriptor, 0, len(envelope.Layers))
		for _, item := range envelope.Layers {
			layers = append(layers, registryDescriptor(item))
		}
		detail.Manifest = &RegistryManifest{SchemaVersion: envelope.SchemaVersion, MediaType: envelope.MediaType, Config: registryDescriptor(envelope.Config), Layers: layers}
		detail.Layers = dockerImageLayers(envelope.Layers)
	}
	if image, imageErr := descriptor.Image(); imageErr == nil {
		detail.Size = registryImageSize(descriptor, image)
		if config, configErr := image.ConfigFile(); configErr == nil && config != nil {
			detail.Metadata = dockerImageMetadata(config, digestString(envelope.Config.Digest), config.RootFS.Type, hashesToStrings(config.RootFS.DiffIDs))
			detail.Runtime = dockerRuntimeConfig(config.Config)
			detail.CreatedAt = detail.Metadata.CreatedAt
			detail.Architecture = config.Architecture
			detail.OS = config.OS
			detail.Labels = config.Config.Labels
			detail.Command = config.Config.Cmd
			detail.Entrypoint = config.Config.Entrypoint
		}
	}
	return detail, nil
}

func hashesToStrings(values []v1.Hash) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		digest := digestString(value)
		if digest == "" {
			continue
		}
		result = append(result, digest)
	}
	return result
}

type dockerImageInspectJSON struct {
	ID           string    `json:"Id"`
	RepoTags     []string  `json:"RepoTags"`
	Size         int64     `json:"Size"`
	Created      string    `json:"Created"`
	Architecture string    `json:"Architecture"`
	OS           string    `json:"Os"`
	Config       v1.Config `json:"Config"`
	RootFS       struct {
		Type   string   `json:"Type"`
		Layers []string `json:"Layers"`
	} `json:"RootFS"`
}

func (s *ImageService) InspectDockerImage(sourceID string, imageID string) (DockerImageDetail, error) {
	taskID := s.newImageTask(imageTaskTypeDetail, sourceID, imageID)
	s.updateTask(taskID, func(task *imageTaskState) {
		task.Status = imageTaskRunning
		task.Stage = "loading"
		task.Total = 1
	})
	finish := func(detail DockerImageDetail, err error) (DockerImageDetail, error) {
		if err != nil {
			s.updateTask(taskID, func(task *imageTaskState) {
				task.Status = imageTaskFailed
				task.Stage = "failed"
				task.Error = err.Error()
			})
		} else {
			s.updateTask(taskID, func(task *imageTaskState) {
				task.Status = imageTaskSuccess
				task.Stage = "done"
				task.Completed = task.Total
			})
		}
		return detail, err
	}
	s.cleanupImageCache()
	source, cliPath, fingerprint, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return finish(DockerImageDetail{}, err)
	}
	repository := ""
	if source.Kind == "registry" {
		repository, _, _, err = parseRegistryImageReference(imageID)
		if err != nil {
			return finish(DockerImageDetail{}, err)
		}
	} else if !validImageReference(imageID) {
		return finish(DockerImageDetail{}, errors.New("镜像 ID 无效"))
	}
	return finish(s.inspectWithSnapshot(sourceID, source, cliPath, fingerprint, imageID, repository))
}

func (s *ImageService) PushDockerImage(sourceID string, image string) (DockerOperationResult, error) {
	result := DockerOperationResult{Image: image}
	if !validImageReference(image) {
		result.Error = "镜像引用无效"
		return result, errors.New(result.Error)
	}
	source, cliPath, err := s.source(sourceID)
	if err != nil {
		result.Error = err.Error()
		return result, err
	}
	if source.Kind == "registry" {
		result.Error = "Registry 来源不支持 Docker CLI 推送"
		return result, errors.New(result.Error)
	}
	output, err := s.runDockerSnapshot(source, cliPath, []string{"image", "push", image}, imagePushTimeout)
	result.Output = string(output)
	if err != nil {
		result.Error = err.Error()
		return result, nil
	}
	result.Success = true
	return result, nil
}

func (s *ImageService) DeleteDockerImages(sourceID string, targets []DockerDeleteTarget) DockerDeleteResult {
	// 删除与扫描共享一个写锁。先标记来源进入删除态并取消当前扫描，
	// 再获取写锁等待扫描退出；删除期间新扫描会在取得读锁后立即放弃。
	s.watchDeleteMu.Lock()
	defer s.watchDeleteMu.Unlock()
	s.mu.Lock()
	if s.watchDeleting == nil {
		s.watchDeleting = make(map[string]bool)
	}
	s.watchDeleting[sourceID] = true
	worker := s.watchWorker
	s.mu.Unlock()
	if worker != nil && worker.sourceID == sourceID {
		worker.runMu.Lock()
		cancelRound := worker.roundCancel
		worker.runMu.Unlock()
		if cancelRound != nil {
			cancelRound()
		}
	}
	s.watchMutationMu.Lock()
	defer s.watchMutationMu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.watchDeleting, sourceID)
		s.mu.Unlock()
	}()
	result := DockerDeleteResult{Deleted: []string{}, Failed: []DockerDeleteFailure{}}
	seen := make(map[string]bool)
	uniqueTargets := make([]DockerDeleteTarget, 0, len(targets))
	for _, target := range targets {
		imageID := strings.TrimSpace(target.ImageID)
		if seen[imageID] {
			continue
		}
		seen[imageID] = true
		target.ImageID = imageID
		target.ExpectedDigest = strings.TrimSpace(target.ExpectedDigest)
		uniqueTargets = append(uniqueTargets, target)
	}
	if len(uniqueTargets) > maxDockerDeleteImages {
		for _, target := range uniqueTargets[maxDockerDeleteImages:] {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: target.ImageID, Error: "超过镜像删除数量限制"})
		}
		uniqueTargets = uniqueTargets[:maxDockerDeleteImages]
	}
	source, cliPath, fingerprint, sourceErr := s.sourceSnapshot(sourceID)
	if sourceErr != nil {
		for _, target := range uniqueTargets {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: target.ImageID, Error: sourceErr.Error()})
		}
		return result
	}
	ctx := s.serviceContext()
	var cancel context.CancelFunc
	if source.Kind == "registry" {
		ctx, cancel = context.WithTimeout(ctx, registryListTimeout)
		defer cancel()
		release, err := s.registryPermit(ctx)
		if err != nil {
			for _, target := range uniqueTargets {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: target.ImageID, Error: err.Error()})
			}
			return result
		}
		defer release()
	}
	for _, target := range uniqueTargets {
		imageID := target.ImageID
		if !s.sourceFingerprintCurrent(sourceID, fingerprint) {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: "来源配置已变化，请刷新后重新确认删除"})
			continue
		}
		if source.Kind == "registry" {
			repository, tag, digest, err := parseRegistryImageReference(imageID)
			if err != nil {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: err.Error()})
				continue
			}
			if digest == "" {
				digest, err = s.resolveRegistryTagDigest(ctx, source, repository, tag)
				if err != nil {
					result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: fmt.Sprintf("解析 Registry 镜像 digest 失败: %v", redactRegistryError(err, source))})
					continue
				}
			}
			if target.ExpectedDigest == "" {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: "删除确认缺少 manifest digest，请刷新后重试"})
				continue
			}
			if digest != target.ExpectedDigest {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: "镜像 digest 已变化，请刷新后重新确认"})
				continue
			}
			repo, err := registryRepository(source, repository)
			if err != nil {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: err.Error()})
				continue
			}
			if err := remote.Delete(repo.Digest(digest), s.registryOptions(ctx, source)...); err != nil {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: fmt.Sprintf("删除 Registry manifest 失败: %v", redactRegistryError(err, source))})
				continue
			}
			s.removeImageCache(sourceID, fingerprint, digest, repository)
			s.removeWatchSnapshotImages(sourceID, fingerprint, digest, repository, true)
			result.Deleted = append(result.Deleted, imageID)
			continue
		}
		if !validImageReference(imageID) {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: "镜像 ID 无效"})
			continue
		}
		_, err := s.runDockerSnapshot(source, cliPath, []string{"image", "rm", imageID}, imageCommandTimeout)
		if err != nil {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: err.Error()})
			continue
		}
		if digest, _, ok := cacheIdentity(source, imageID, ""); ok {
			s.removeImageCache(sourceID, fingerprint, digest, "")
		}
		s.removeWatchSnapshotImages(sourceID, fingerprint, imageID, "", false)
		result.Deleted = append(result.Deleted, imageID)
	}
	return result
}
