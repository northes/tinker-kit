package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	v1 "github.com/google/go-containerregistry/pkg/v1"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// 检查与写入共享取消感知的许可，避免排队时被同步锁阻塞取消。
func (s *ImageService) acquireImageImportMutation(ctx context.Context) (func(), error) {
	s.mu.Lock()
	if s.importMutationSem == nil {
		s.importMutationSem = make(chan struct{}, 1)
	}
	sem := s.importMutationSem
	s.mu.Unlock()
	select {
	case sem <- struct{}{}:
		return func() { <-sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// 元数据仍限制大小，层数据由库流式传输并验证 digest，不能套用元数据的 8 MiB 上限。
func (s *ImageService) registryTransferOptions(ctx context.Context, source ImageSource) []remote.Option {
	base := http.RoundTripper(remote.DefaultTransport)
	if s.registryTransport != nil {
		base = s.registryTransport
	}
	return append(registryOptions(ctx, source), remote.WithTransport(&limitedRegistryTransport{base: base, streamBlobs: true}))
}

func (s *ImageService) registryPullSource(reference name.Reference, target ImageSource) ImageSource {
	if endpoint, err := registryEndpoint(target); err == nil && endpoint.String() == reference.Context().RegistryStr() {
		return target
	}
	if s.config != nil {
		for _, source := range s.config.Get().ImageSources {
			if source.Kind != "registry" {
				continue
			}
			if endpoint, err := registryEndpoint(source); err == nil && endpoint.String() == reference.Context().RegistryStr() {
				return source
			}
		}
	}
	return ImageSource{Kind: "registry", RegistryURL: "https://" + reference.Context().RegistryStr()}
}

// StartRegistryImagePulls 按所选平台复制镜像到当前 Registry，Source 可以是 tag 或 digest。
func (s *ImageService) StartRegistryImagePulls(sourceID string, changes []DockerImageReferenceChange, options ImagePullOptions) (ImageExportResult, error) {
	source, _, _, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return ImageExportResult{}, err
	}
	if source.Kind != "registry" {
		return ImageExportResult{}, userError("errors.imageExport.registrySourceRequired")
	}
	if len(changes) == 0 {
		return ImageExportResult{}, userError("errors.imageExport.noImagesSelected")
	}
	entries := make([]ImageImportEntry, len(changes))
	for i := range changes {
		changes[i].Source, changes[i].Target = strings.TrimSpace(changes[i].Source), strings.TrimSpace(changes[i].Target)
		if _, err := name.ParseReference(changes[i].Source); err != nil || !validImageReference(changes[i].Source) {
			return ImageExportResult{}, userError("errors.imageExport.invalidImageReference")
		}
		entries[i].Target = changes[i].Target
	}
	if err := s.checkImportTargets(s.serviceContext(), source, "", entries); err != nil {
		return ImageExportResult{}, err
	}
	for _, change := range changes {
		s.enqueueRegistryImagePull(source, change, options)
	}
	return ImageExportResult{Started: len(changes), Snapshot: s.GetImageTasks()}, nil
}

func (s *ImageService) enqueueRegistryImagePull(source ImageSource, change DockerImageReferenceChange, options ImagePullOptions) {
	ctx, cancel := context.WithCancel(s.serviceContext())
	reference, _ := name.ParseReference(change.Source)
	origin := s.pullOrigin(reference, source, options)
	id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypePull, SourceID: source.ID, ImageID: change.Source, Path: change.Target, ProgressUnit: "bytes"}, pullOptions: options, cancel: cancel})
	s.exportWG.Add(1)
	go func() { defer s.exportWG.Done(); s.runRegistryImagePull(ctx, id, source, origin, change, options) }()
}

func (s *ImageService) runRegistryImagePull(ctx context.Context, taskID string, source, origin ImageSource, change DockerImageReferenceChange, options ImagePullOptions) {
	if !s.acquireTaskSlot(ctx, taskID) {
		return
	}
	if s.taskScheduler != nil {
		defer s.taskScheduler.Release()
	}
	s.updateTask(taskID, func(task *imageTaskState) { task.Status, task.Stage = imageTaskRunning, "pulling" })
	err := s.copyRegistryImage(ctx, taskID, source, origin, change, options)
	if err != nil {
		err = userErrorCause("errors.imageExport.registryTransferFailed", redactRegistryError(redactRegistryError(err, origin), source))
	}
	s.finishImageTransfer(taskID, source, ctx, err)
}

func (s *ImageService) copyRegistryImage(ctx context.Context, taskID string, source, origin ImageSource, change DockerImageReferenceChange, options ImagePullOptions) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	reference, err := name.ParseReference(change.Source)
	if err != nil {
		return err
	}
	remoteOptions := s.registryTransferOptions(ctx, origin)
	if options.Platform != "" && options.Platform != "all" {
		platform, err := v1.ParsePlatform(options.Platform)
		if err != nil {
			return err
		}
		remoteOptions = append(remoteOptions, remote.WithPlatform(*platform))
	}
	descriptor, err := remote.Get(reference, remoteOptions...)
	if err != nil {
		return err
	}
	target, err := importTarget(source, change.Target)
	if err != nil {
		return err
	}
	releaseMutation, err := s.acquireImageImportMutation(ctx)
	if err != nil {
		return err
	}
	defer releaseMutation()
	if err := s.checkImportTargets(ctx, source, "", []ImageImportEntry{{Target: change.Target}}); err != nil {
		return err
	}
	if descriptor.MediaType.IsIndex() && (options.Platform == "" || options.Platform == "all") {
		index, err := descriptor.ImageIndex()
		if err != nil {
			return err
		}
		return s.withRegistryTransferProgress(ctx, taskID, source, func(options []remote.Option) error { return remote.WriteIndex(target, index, options...) })
	}
	image, err := descriptor.Image()
	if err != nil {
		return err
	}
	if !descriptor.MediaType.IsIndex() && options.Platform != "" && options.Platform != "all" {
		requested, err := v1.ParsePlatform(options.Platform)
		if err != nil {
			return err
		}
		config, err := image.ConfigFile()
		if err != nil {
			return err
		}
		actual := v1.Platform{OS: config.OS, Architecture: config.Architecture, Variant: config.Variant}
		if !actual.Satisfies(*requested) {
			return userErrorParams("errors.imageExport.pullPlatformUnavailable", map[string]any{"platform": options.Platform})
		}
	}
	return s.withRegistryTransferProgress(ctx, taskID, source, func(options []remote.Option) error { return remote.Write(target, image, options...) })
}

// 拉取凭据仅用于当前任务，不写入来源配置或任务快照。
type ImagePullOptions struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Platform string `json:"platform"`
}

func (s *ImageService) pullOrigin(reference name.Reference, target ImageSource, options ImagePullOptions) ImageSource {
	origin := s.registryPullSource(reference, target)
	if options.Username != "" || options.Password != "" {
		origin.RegistryUsername, origin.RegistryPassword = options.Username, options.Password
	}
	return origin
}

// ResolveImagePullPlatforms 仅由显式操作调用；SSH 使用远端 CLI 的认证配置。
func (s *ImageService) ResolveImagePullPlatforms(ctx context.Context, sourceID, image string, options ImagePullOptions) (result []string, err error) {
	defer func() {
		if errors.Is(ctx.Err(), context.Canceled) {
			result, err = nil, nil
		}
	}()
	source, cliPath, _, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return nil, err
	}
	return s.resolveImagePullPlatforms(ctx, source, cliPath, image, options)
}

func (s *ImageService) resolveImagePullPlatforms(ctx context.Context, source ImageSource, cliPath, image string, options ImagePullOptions) ([]string, error) {
	reference, err := name.ParseReference(strings.TrimSpace(image))
	if err != nil || !validImageReference(strings.TrimSpace(image)) {
		return nil, userError("errors.imageExport.invalidImageReference")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var platforms []RegistryPlatform
	if source.Kind == "registry" {
		origin := s.pullOrigin(reference, source, options)
		release, err := s.registryPermit(ctx)
		if err != nil {
			return nil, err
		}
		defer release()
		descriptor, err := remote.Get(reference, s.registryOptions(ctx, origin)...)
		if err != nil {
			return nil, redactRegistryError(err, origin)
		}
		platforms, err = registryImagePlatforms(ctx, descriptor)
		if err != nil {
			return nil, redactRegistryError(err, origin)
		}
	} else {
		return s.resolveCLIImagePullPlatforms(ctx, source, cliPath, strings.TrimSpace(image), reference)
	}
	values := map[string]bool{}
	for _, platform := range platforms {
		if platform.OS != "" && platform.Architecture != "" {
			values[platform.OS+"/"+platform.Architecture+platformVariant(platform.Variant)] = true
		}
	}
	return sortedPullPlatforms(values)
}

func sortedPullPlatforms(values map[string]bool) ([]string, error) {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	if len(result) == 0 {
		return nil, userError("errors.imageExport.pullPlatformsEmpty")
	}
	return result, nil
}

func cliManifestPlatforms(data []byte) ([]string, error) {
	type manifest struct {
		Descriptor struct {
			Platform    *v1.Platform      `json:"platform"`
			Annotations map[string]string `json:"annotations"`
		} `json:"Descriptor"`
	}
	var entries []manifest
	if err := json.Unmarshal(data, &entries); err != nil {
		var entry manifest
		if err := json.Unmarshal(data, &entry); err != nil {
			return nil, err
		}
		entries = []manifest{entry}
	}
	values := map[string]bool{}
	for _, entry := range entries {
		platform := entry.Descriptor.Platform
		if platform != nil && platform.OS != "" && normalizeImageArchitecture(platform.Architecture) != "" && entry.Descriptor.Annotations["vnd.docker.reference.type"] != "attestation-manifest" {
			values[platform.OS+"/"+normalizeImageArchitecture(platform.Architecture)+platformVariant(platform.Variant)] = true
		}
	}
	return sortedPullPlatforms(values)
}
