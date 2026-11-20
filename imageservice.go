package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	imageCommandTimeout         = 15 * time.Second
	imagePushTimeout            = 5 * time.Minute
	maxImageCommandOutput       = 8 << 20
	maxDockerImageBatchSize     = 100
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

// ConnectionTestStep 是「测试连接」面板的一步结果。Key 对应 locale 中的步骤名，
// Error 为空表示该步通过，Skipped 表示上一步已失败、本步未执行。
type ConnectionTestStep struct {
	Key     string `json:"key"`
	Error   string `json:"error"`
	Skipped bool   `json:"skipped"`
}

const (
	imageConnectionStepConnect = "connect"
	imageConnectionStepDaemon  = "daemon"
)

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
	registryTLSCache      map[registryTransportCacheKey]*http.Transport
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
	remoteEnvMu           sync.Mutex
	remoteEnv             map[string]remoteCommandEnv
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
	service := &ImageService{config: config, ctx: ctx, cancel: cancel, cacheCalls: make(map[string]*imageCacheCall), inventory: make(map[string]imageInventory), prewarmGenerations: make(map[string]*prewarmGeneration), remoteEnv: make(map[string]remoteCommandEnv)}
	if config != nil {
		config.setOnChange(func(Config) { service.cleanupImageCache() })
	}
	service.ensurePrewarmWorkers()
	return service
}

func (s *ImageService) ServiceName() string { return "ImageService" }

// ImageBatchLimit 返回单次镜像批量操作（删除、推送、换 Tag）允许的最大条目数。
// 前端按该值拆批调用，避免超出上限后剩余条目被整批标记失败。
func (s *ImageService) ImageBatchLimit() int { return maxDockerImageBatchSize }

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

func (s *ImageService) runImageCommand(ctx context.Context, stdin io.Reader, name string, args ...string) ([]byte, string, error) {
	if s.runner != nil && stdin == nil {
		out, err := s.runner(ctx, name, args...)
		return out, "", err
	}
	command := execCommandContext(ctx, name, args...)
	command.Stdin = stdin
	stdout := &limitedBuffer{limit: maxImageCommandOutput}
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	stderrText := stderr.String()
	if ctx.Err() != nil {
		return stdout.Bytes(), stderrText, ctx.Err()
	}
	if detail := strings.TrimSpace(stderrText); err != nil && detail != "" {
		err = fmt.Errorf("%w: %s", err, detail)
	}
	return stdout.Bytes(), stderrText, err
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
					resolved, err := imageSourceFromSSHProfile(source, profile, config.SSHProfiles)
					if err != nil {
						return ImageSource{}, "", "", err
					}
					displayCLI := imageSourceDisplayCLI(resolved, config)
					return resolved, displayCLI, imageSourceFingerprint(resolved, displayCLI), nil
				}
				if validSSHHost(source.SSHHost) {
					displayCLI := imageSourceDisplayCLI(source, config)
					return source, displayCLI, imageSourceFingerprint(source, displayCLI), nil
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

func imageSourceFromSSHProfile(source ImageSource, profile SSHProfile, profiles []SSHProfile) (ImageSource, error) {
	source.SSHHost = profile.Host
	source.SSHPort = profile.Port
	source.SSHUsername = profile.Username
	source.SSHPassword = profile.Password
	source.SSHPrivateKey = profile.PrivateKey
	source.SSHPrivateKeyPath = profile.PrivateKeyPath
	source.SSHKeyPassphrase = profile.KeyPassphrase
	jumps, err := sshJumpConnections(profiles, sshProfileToConnection(profile))
	if err != nil {
		return ImageSource{}, err
	}
	source.SSHJump = jumps
	return source, nil
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
		Jump          string `json:"jump"`
		DockerCommand string `json:"dockerCommand,omitempty"`
		SudoPassword  string `json:"sudoPassword,omitempty"`
		Transport     string `json:"transport,omitempty"`
		CAPath        string `json:"caPath,omitempty"`
		CAPEM         string `json:"caPEM,omitempty"`
	}{Kind: source.Kind, CLI: cliPath}
	switch source.Kind {
	case "registry":
		value.Endpoint, value.Username, value.Password = source.RegistryURL, source.RegistryUsername, source.RegistryPassword
		mode, ok := registryTransportMode(source.RegistryTransport)
		if !ok {
			mode = strings.TrimSpace(source.RegistryTransport)
		}
		value.Transport = mode
		value.CAPath = source.RegistryCAPath
		value.CAPEM = source.RegistryCAPEM
	case "ssh":
		value.Host, value.Port, value.Username = source.SSHHost, source.SSHPort, source.SSHUsername
		value.Password, value.KeyPath = source.SSHPassword, source.SSHPrivateKeyPath
		value.PrivateKey, value.KeyPassphrase = source.SSHPrivateKey, source.SSHKeyPassphrase
		value.DockerCommand = source.DockerCommand
		value.SudoPassword = source.SudoPassword
		jumps := make([]string, 0, len(source.SSHJump))
		for _, jump := range source.SSHJump {
			jumps = append(jumps, fmt.Sprintf("%s@%s:%d", jump.Username, jump.Host, jump.Port))
		}
		value.Jump = strings.Join(jumps, ",")
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
	return buildImageCommandLine(source, shellJoin(append([]string{cliPath}, dockerArgs...)))
}

// buildImageCommandLine 用已拼接好的远端命令构造系统 ssh 调用。
func buildImageCommandLine(source ImageSource, remoteCommand string) (string, []string, error) {
	if source.Kind != "ssh" || !validSSHHost(source.SSHHost) {
		return "", nil, userError("errors.image.sourceInvalid")
	}
	sshArgs := []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"}
	if source.SudoPassword != "" {
		// 即使本机 SSH 配置请求终端，也只通过非 PTY 会话传输密码和镜像数据。
		sshArgs = append(sshArgs, "-T")
	}
	if source.SSHPort > 0 && source.SSHPort != 22 {
		sshArgs = append(sshArgs, "-p", strconv.Itoa(source.SSHPort))
	}
	if source.SSHUsername != "" {
		sshArgs = append(sshArgs, "-l", source.SSHUsername)
	}
	if source.SSHPrivateKeyPath != "" {
		sshArgs = append(sshArgs, "-i", source.SSHPrivateKeyPath)
	}
	sshArgs = append(sshArgs, "--", source.SSHHost, remoteCommand)
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
	if source.Kind == "ssh" && hasSSHCredentials(source) {
		return s.runImageSSH(ctx, source, args...)
	}
	name, commandArgs, err := s.buildImageInvocation(ctx, source, cliPath, args)
	if err != nil {
		return nil, err
	}
	out, _, err := s.runImageCommand(ctx, imageDockerStdin(source, nil), name, commandArgs...)
	return out, err
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

// TestImageSourceConnection 使用未持久化的来源配置测试 SSH 或 Registry 连接，
// 任一步失败即返回该步的原始错误。
func (s *ImageService) TestImageSourceConnection(source ImageSource) error {
	_, err := s.testImageSourceConnectionSteps(s.serviceContext(), source)
	return err
}

// TestImageSourceConnectionSteps 与 TestImageSourceConnection 同源，但逐步返回结果，
// 供编辑弹窗内的分步面板展示：SSH 为「连接 / daemon 探测」两步，Registry 只有「连接」。
// ctx 由 Wails 绑定传入，前端取消时会关闭当前 SSH 会话，已完成步骤保留、其余标为未执行。
func (s *ImageService) TestImageSourceConnectionSteps(ctx context.Context, source ImageSource) []ConnectionTestStep {
	steps, _ := s.testImageSourceConnectionSteps(ctx, source)
	return steps
}

// testImageSourceConnectionSteps 按执行顺序返回每一步；任一步失败或调用方取消后，
// 其后的步骤标记为未执行，面板因此始终能展示完整的步骤列表。
func (s *ImageService) testImageSourceConnectionSteps(ctx context.Context, source ImageSource) ([]ConnectionTestStep, error) {
	if ctx == nil {
		ctx = s.serviceContext()
	}
	failedBeforeDocker := func(err error) ([]ConnectionTestStep, error) {
		steps := []ConnectionTestStep{{Key: imageConnectionStepConnect, Error: err.Error()}}
		if isSSHImageSource(source) {
			steps = append(steps, ConnectionTestStep{Key: imageConnectionStepDaemon, Skipped: true})
		}
		return steps, err
	}
	normalized, cliPath, err := s.prepareConnectionTest(source)
	if err != nil {
		// 校验失败发生在任何连接之前，因此只完成「连接」一步。
		return failedBeforeDocker(err)
	}
	if normalized.Kind == "registry" {
		itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
		defer cancel()
		if err := s.pingRegistry(itemCtx, normalized); err != nil {
			return []ConnectionTestStep{{Key: imageConnectionStepConnect, Error: err.Error()}}, err
		}
		return []ConnectionTestStep{{Key: imageConnectionStepConnect}}, nil
	}
	probes := []struct {
		key  string
		args []string
	}{
		{imageConnectionStepConnect, imageConnectProbeArgs},
		{imageConnectionStepDaemon, imageDaemonProbeArgs},
	}
	steps := make([]ConnectionTestStep, 0, len(probes))
	skipRest := func(from int) []ConnectionTestStep {
		for _, rest := range probes[from:] {
			steps = append(steps, ConnectionTestStep{Key: rest.key, Skipped: true})
		}
		return steps
	}
	for index, probe := range probes {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return skipRest(index), ctxErr
		}
		itemCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
		output, stderrText, probeErr := s.runSourceProbe(itemCtx, normalized, cliPath, probe.args)
		cancel()
		if probeErr == nil {
			if _, _, parsed := splitImageProbeOutput(normalized, output); !parsed {
				probeErr = imageProbeError(output, stderrText)
			}
		}
		if probeErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return skipRest(index), ctxErr
			}
			steps = append(steps, ConnectionTestStep{Key: probe.key, Error: probeErr.Error()})
			return skipRest(index + 1), probeErr
		}
		steps = append(steps, ConnectionTestStep{Key: probe.key})
	}
	return steps, nil
}

func isSSHImageSource(source ImageSource) bool {
	return strings.EqualFold(strings.TrimSpace(source.Kind), "ssh")
}

// prepareConnectionTest 在发起任何连接前完成校验、SSH 配置解析与 CLI 解析。
func (s *ImageService) prepareConnectionTest(source ImageSource) (ImageSource, string, error) {
	if s == nil || s.config == nil {
		return ImageSource{}, "", userError("errors.common.configNotInitialized")
	}
	normalized, err := s.config.ValidateImageSource(source)
	if err != nil {
		return ImageSource{}, "", err
	}
	if normalized.Kind != "ssh" && normalized.Kind != "registry" {
		return ImageSource{}, "", userError("errors.image.testUnsupportedSource")
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
			return ImageSource{}, "", userError("errors.image.sshProfileMissing")
		}
		resolved, err := imageSourceFromSSHProfile(normalized, profile, config.SSHProfiles)
		if err != nil {
			return ImageSource{}, "", err
		}
		normalized = resolved
	}
	cliPath := imageSourceDisplayCLI(normalized, config)
	if cliPath == "" {
		cliPath = dockerCommandName
	}
	return normalized, cliPath, nil
}

func (s *ImageService) sourceConnectionStatus(source ImageSource, cliPath string) DockerStatus {
	return s.sourceConnectionStatusContext(s.serviceContext(), source, cliPath)
}

// sourceConnectionStatusContext 从外部 ctx 派生连接探测（registry ping 与 daemon 探测），
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
	// 一次命令同时拿架构与 daemon 版本：只问客户端版本时，socket 权限问题会被掩盖。
	output, stderrText, err := s.runSourceProbe(itemCtx, source, cliPath, imageDaemonProbeArgs)
	if err != nil {
		status.Error = err.Error()
		return status, err
	}
	architecture, version, parsed := splitImageProbeOutput(source, output)
	if !parsed {
		err := imageProbeError(output, stderrText)
		status.Error = err.Error()
		return status, err
	}
	status.Architecture = architecture
	status.Available = true
	status.Version = version
	return status, nil
}

// runSourceProbe 执行一次探测命令：有凭据的 SSH 来源走 Go 客户端，没凭据的走系统 ssh，
// 本机来源直接跑 CLI。SSH 探测总在命令前拼 uname -m，输出首行是架构。
// stderr 单独返回，供输出不足以解析时展示原始线索。
func (s *ImageService) runSourceProbe(ctx context.Context, source ImageSource, cliPath string, dockerArgs []string) ([]byte, string, error) {
	if source.Kind != "ssh" {
		out, err := s.runDockerSnapshotContext(ctx, source, cliPath, dockerArgs)
		return out, "", err
	}
	line, label, err := s.sshArchitectureProbeCommand(ctx, source, dockerArgs)
	if err != nil {
		return nil, "", err
	}
	stdin := imageDockerStdin(source, nil)
	if hasSSHCredentials(source) {
		out, stderrOut, captureErr := runAuthenticatedSSHLineCapture(ctx, source, label, s.sshLanguage(), line, stdin)
		return out, string(stderrOut), captureErr
	}
	name, commandArgs, err := buildImageCommand(source, "sh", "-c", line)
	if err != nil {
		return nil, "", err
	}
	return s.runImageCommand(ctx, stdin, name, commandArgs...)
}

// splitImageProbeOutput 拆分探测输出：SSH 首行是 uname -m，其余部分是 docker 输出；
// 本机来源没有架构行，整体就是 docker 输出。合并后为空时返回 false，由调用方给出原始输出。
func splitImageProbeOutput(source ImageSource, output []byte) (architecture string, version string, ok bool) {
	trimmed := strings.TrimSpace(string(output))
	if source.Kind != "ssh" {
		return "", trimmed, trimmed != ""
	}
	architecture, remainder, found := strings.Cut(trimmed, "\n")
	if !found || strings.TrimSpace(remainder) == "" {
		return "", "", false
	}
	return normalizeImageArchitecture(architecture), strings.TrimSpace(remainder), true
}

// imageProbeError 在输出不足以解析时给出远端原始内容（stdout 与 stderr 各一行），
// 避免用自定义提示掩盖真实失败原因。
func imageProbeError(stdout []byte, stderr string) error {
	parts := make([]string, 0, 2)
	if text := strings.TrimSpace(string(stdout)); text != "" {
		parts = append(parts, text)
	}
	if text := strings.TrimSpace(stderr); text != "" {
		parts = append(parts, text)
	}
	if len(parts) == 0 {
		return userError("errors.image.sshArchitectureProbeInvalid")
	}
	return errors.New(strings.Join(parts, "\n"))
}

func (s *ImageService) pingRegistry(ctx context.Context, source ImageSource) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	parsed, err := validatedRegistryURL(source)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String()+"/v2/", nil)
	if err != nil {
		return userError("errors.image.registryRequestCreateFailed")
	}
	if source.RegistryUsername != "" {
		request.SetBasicAuth(source.RegistryUsername, source.RegistryPassword)
	}
	transport, err := s.registryRoundTripper(source)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: &limitedRegistryTransport{base: transport}}
	response, err := client.Do(request)
	if err != nil {
		return registryTransportError(err, "errors.image.registryUnreachable", source)
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
