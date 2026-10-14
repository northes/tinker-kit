package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/v1/remote"
)

const (
	imageCommandTimeout         = 15 * time.Second
	imagePushTimeout            = 5 * time.Minute
	maxImageCommandOutput       = 8 << 20
	maxDockerDeleteImages       = 100
	maxRegistryRepositories     = 10000
	maxRegistryTags             = 10000
	maxRegistryBodySize         = 8 << 20
	maxImageCacheEntries        = 512
	maxImageCacheBytes          = 128 << 20
	maxImageCacheEntryBytes     = 2 << 20
	registryConcurrency         = 4
	imageDetailConcurrency      = 4
	backgroundDetailConcurrency = imageDetailConcurrency - 1
	prewarmQueueSize            = 128
	registryListTimeout         = 30 * time.Second
	registryTagTimeout          = 5 * time.Minute
)

type imageDetailRequestClass uint8

const (
	imageDetailForeground imageDetailRequestClass = iota
	imageDetailBackground
)

type DockerStatus struct {
	Available         bool   `json:"available"`
	CLIPath           string `json:"cliPath"`
	Version           string `json:"version"`
	Error             string `json:"error"`
	LocalArchitecture string `json:"localArchitecture"`
	Architecture      string `json:"architecture"`
}

type DockerImage struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Tags       []string           `json:"tags"`
	Repository string             `json:"repository"`
	Digest     string             `json:"digest"`
	MediaType  string             `json:"mediaType"`
	SizeType   string             `json:"sizeType"`
	Size       string             `json:"size"`
	SizeBytes  int64              `json:"sizeBytes"`
	CreatedAt  string             `json:"createdAt"`
	Platforms  []RegistryPlatform `json:"platforms"`
}

const (
	registryImageMetadataEventName      = "image-manager:registry-metadata"
	registryImageMetadataStateEventName = "image-manager:registry-metadata-state"
	registryImageMetadataStateLoading   = "loading"
	registryImageMetadataStateComplete  = "complete"
)

type registryImageMetadataEvent struct {
	SourceID  string             `json:"sourceID"`
	ImageID   string             `json:"imageID"`
	Digest    string             `json:"digest"`
	MediaType string             `json:"mediaType"`
	SizeType  string             `json:"sizeType"`
	Size      string             `json:"size"`
	SizeBytes int64              `json:"sizeBytes"`
	CreatedAt string             `json:"createdAt"`
	Platforms []RegistryPlatform `json:"platforms"`
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

// DockerImageReferenceChange 描述一个镜像引用变更。Source 和 Target
// 都是传给 Docker CLI 的独立镜像引用，不经过 shell 拼接。
type DockerImageReferenceChange struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

type DockerImageOperationFailure struct {
	Image string `json:"image"`
	Error string `json:"error"`
}

type DockerImageBatchResult struct {
	Succeeded []string                      `json:"succeeded"`
	Failed    []DockerImageOperationFailure `json:"failed"`
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
	taskScheduler         *taskScheduler
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
	backgroundDetailSem   chan struct{}
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
	exportWG              sync.WaitGroup
	exportQueueMu         sync.Mutex
	importMutationSem     chan struct{}
}

func (s *ImageService) setTaskScheduler(scheduler *taskScheduler) {
	if s != nil {
		s.taskScheduler = scheduler
	}
}

func (s *ImageService) acquireTaskSlot(ctx context.Context, taskID string) bool {
	if s.taskScheduler == nil {
		return true
	}
	if err := s.taskScheduler.Acquire(ctx); err != nil {
		s.updateTask(taskID, func(task *imageTaskState) {
			task.Status, task.Stage, task.cancel = imageTaskCanceled, imageTaskCanceled, nil
		})
		return false
	}
	return true
}

func NewImageService(config *ConfigService) *ImageService {
	ctx, cancel := context.WithCancel(context.Background())
	service := &ImageService{config: config, ctx: ctx, cancel: cancel, cacheCalls: make(map[string]*imageCacheCall), inventory: make(map[string]imageInventory), prewarmGenerations: make(map[string]*prewarmGeneration)}
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
		return ImageSource{}, "", "", userError("errors.common.configNotInitialized")
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
			if source.Kind == "ssh" {
				if source.SSHProfileID != "" {
					var profile SSHProfile
					for _, candidate := range config.SSHProfiles {
						if candidate.ID == source.SSHProfileID {
							profile = candidate
							break
						}
					}
					if profile.ID == "" {
						return ImageSource{}, "", "", userError("errors.image.sshProfileMissing")
					}
					resolved := imageSourceFromSSHProfile(source, profile)
					return resolved, "docker", imageSourceFingerprint(resolved, "docker"), nil
				}
				if validSSHHost(source.SSHHost) {
					return source, "docker", imageSourceFingerprint(source, "docker"), nil
				}
			}
			if source.Kind == "registry" {
				if _, ok := normalizeRegistryURL(source.RegistryURL); ok {
					return source, "", imageSourceFingerprint(source, ""), nil
				}
			}
			return ImageSource{}, "", "", userError("errors.image.sourceInvalid")
		}
	}
	return ImageSource{}, "", "", userErrorParams("errors.image.sourceNotFound", map[string]any{"sourceID": sourceID})
}

func imageSourceFromSSHProfile(source ImageSource, profile SSHProfile) ImageSource {
	source.SSHHost = profile.Host
	source.SSHPort = profile.Port
	source.SSHUsername = profile.Username
	source.SSHPassword = profile.Password
	source.SSHPrivateKey = profile.PrivateKey
	source.SSHPrivateKeyPath = profile.PrivateKeyPath
	source.SSHKeyPassphrase = profile.KeyPassphrase
	return source
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

func buildImageCommand(source ImageSource, cliPath string, dockerArgs ...string) (string, []string, error) {
	if !validPathValue(cliPath, 4096) || strings.HasPrefix(cliPath, "-") {
		return "", nil, userError("errors.image.cliPathInvalid")
	}
	if source.Kind == "local" {
		return cliPath, append([]string(nil), dockerArgs...), nil
	}
	if source.Kind != "ssh" || !validSSHHost(source.SSHHost) {
		return "", nil, userError("errors.image.sourceInvalid")
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
		return runAuthenticatedSSH(ctx, source, cliPath, s.sshLanguage(), args...)
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

func (s *ImageService) sshLanguage() string {
	if s == nil || s.config == nil {
		return "zh-CN"
	}
	if s.config.Get().Language == "en-US" {
		return "en-US"
	}
	return "zh-CN"
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
		return userError("errors.common.configNotInitialized")
	}
	normalized, err := s.config.ValidateImageSource(source)
	if err != nil {
		return err
	}
	if normalized.Kind != "ssh" && normalized.Kind != "registry" {
		return userError("errors.image.testUnsupportedSource")
	}
	config := normalizeConfig(s.config.Get())
	if normalized.Kind == "ssh" && normalized.SSHProfileID != "" {
		var profile SSHProfile
		for _, candidate := range config.SSHProfiles {
			if candidate.ID == normalized.SSHProfileID {
				profile = candidate
				break
			}
		}
		if profile.ID == "" {
			return userError("errors.image.sshProfileMissing")
		}
		normalized = imageSourceFromSSHProfile(normalized, profile)
	}
	cliPath := config.DockerCLIPath
	if cliPath == "" {
		cliPath = "docker"
	}
	if _, err := s.probeSourceConnection(s.serviceContext(), normalized, cliPath); err != nil {
		return err
	}
	return nil
}

func (s *ImageService) sourceConnectionStatus(source ImageSource, cliPath string) DockerStatus {
	return s.sourceConnectionStatusContext(s.serviceContext(), source, cliPath)
}

// sourceConnectionStatusContext 从外部 ctx 派生连接探测（registry ping 与 CLI --version），
// 保证所有 CLI/registry 状态操作随调用方 ctx（watch 循环/shutdown）取消。
func (s *ImageService) sourceConnectionStatusContext(ctx context.Context, source ImageSource, cliPath string) DockerStatus {
	status, _ := s.probeSourceConnection(ctx, source, cliPath)
	return status
}

// probeSourceConnection 执行连接探测，并在不可用时保留原始错误，
// 供需要错误链的调用方直接返回；状态模型字段仍写入序列化后的错误文本。
func (s *ImageService) probeSourceConnection(ctx context.Context, source ImageSource, cliPath string) (DockerStatus, error) {
	status := DockerStatus{CLIPath: cliPath, LocalArchitecture: normalizeImageArchitecture(runtime.GOARCH)}
	if source.Kind == "registry" {
		itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
		defer cancel()
		if err := s.pingRegistry(itemCtx, source); err != nil {
			status.Error = err.Error()
			return status, err
		}
		status.Available = true
		status.Version = "Registry"
		return status, nil
	}
	itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	command, args := cliPath, []string{"--version"}
	if source.Kind == "ssh" {
		// 合并到一次 SSH 调用，避免为架构探测额外建立远程连接。
		command, args = "sh", []string{"-c", "uname -m && exec " + shellQuote(cliPath) + " --version"}
	}
	output, err := s.runDockerSnapshotContext(itemCtx, source, command, args)
	if err != nil {
		status.Error = err.Error()
		return status, err
	}
	version := strings.TrimSpace(string(output))
	if source.Kind == "ssh" {
		architecture, remainder, ok := strings.Cut(version, "\n")
		if !ok || strings.TrimSpace(remainder) == "" {
			err := userError("errors.image.sshArchitectureProbeInvalid")
			status.Error = err.Error()
			return status, err
		}
		status.Architecture, version = normalizeImageArchitecture(architecture), strings.TrimSpace(remainder)
	}
	status.Available = true
	status.Version = version
	return status, nil
}

func (s *ImageService) pingRegistry(ctx context.Context, source ImageSource) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	endpoint, ok := normalizeRegistryURL(source.RegistryURL)
	if !ok {
		return userError("errors.image.registryURLHTTPSOnly")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/v2/", nil)
	if err != nil {
		return userError("errors.image.registryRequestCreateFailed")
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
		return userErrorCause("errors.image.registryUnreachable", redactRegistryError(err, source))
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	if response.StatusCode == http.StatusUnauthorized {
		if source.RegistryUsername == "" {
			return userError("errors.image.registryAuthRequired")
		}
		return userError("errors.image.registryAuthFailed")
	}
	if response.StatusCode == http.StatusForbidden {
		return userError("errors.image.registryForbidden")
	}
	return userErrorParams("errors.image.registryProbeFailed", map[string]any{"status": response.StatusCode})
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
			return nil, userErrorCause("errors.image.dockerListParseFailed", err)
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
