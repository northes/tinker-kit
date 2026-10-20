package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

func (s *ImageService) inspectWithSnapshot(sourceID string, source ImageSource, cliPath, fingerprint, imageID, repository string) (DockerImageDetail, error) {
	return s.inspectWithGeneration(sourceID, source, cliPath, fingerprint, imageID, repository, s.serviceContext(), imageDetailForeground, 0)
}

func (s *ImageService) inspectWithGeneration(sourceID string, source ImageSource, cliPath, fingerprint, imageID, repository string, requestCtx context.Context, requestClass imageDetailRequestClass, generation uint64) (DockerImageDetail, error) {
	digest, repository, cacheable := cacheIdentity(source, imageID, repository)
	if !cacheable {
		release, err := s.detailPermit(requestCtx, requestClass)
		if err != nil {
			return DockerImageDetail{}, err
		}
		defer release()
		if source.Kind == "registry" {
			return s.inspectRegistryImage(requestCtx, source, imageID, repository)
		}
		return s.inspectDockerImage(requestCtx, source, cliPath, imageID)
	}
	// 本地索引摘要不随平台内容的下载/删除改变，不能复用其持久化可用性快照。
	if detail, ok := s.loadImageCache(sourceID, fingerprint, digest, repository, imageID); ok && (source.Kind == "registry" || detail.Index == nil) {
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
				return s.inspectWithGeneration(sourceID, source, cliPath, fingerprint, imageID, repository, requestCtx, requestClass, generation)
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
	if detail, ok := s.loadImageCache(sourceID, fingerprint, digest, repository, imageID); ok && (source.Kind == "registry" || detail.Index == nil) {
		call.detail = detail
		return detail, nil
	}
	release, err := s.detailPermit(requestCtx, requestClass)
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
		return DockerImageDetail{}, userError("errors.image.imageIDInvalid")
	}
	commandCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	output, err := s.runDockerSnapshotContext(commandCtx, source, cliPath, []string{"image", "inspect", imageID})
	if err != nil {
		return DockerImageDetail{}, err
	}
	var entries []dockerImageInspectJSON
	if err := json.Unmarshal(output, &entries); err != nil {
		return DockerImageDetail{}, userErrorCause("errors.image.dockerDetailParseFailed", err)
	}
	if len(entries) == 0 {
		return DockerImageDetail{}, userError("errors.image.dockerDetailEmpty")
	}
	item := entries[0]
	var index *RegistryIndex
	if item.Descriptor != nil && item.Descriptor.MediaType.IsIndex() {
		// CLI inspect 不请求 manifests；从同一 daemon 读取本地可用内容，不能查询远端索引代替。
		item, err = s.inspectDockerIndex(commandCtx, source, cliPath, imageID)
		if err != nil {
			return DockerImageDetail{}, err
		}
		index = &RegistryIndex{SchemaVersion: 2, MediaType: string(entries[0].Descriptor.MediaType)}
		// inspect.Size 仅属于默认平台；列表的磁盘占用包含所有本地内容和解包数据。
		// 未完整下载的平台和证明也可能占用空间，大小统计必须在平台过滤之前完成。
		item.Size = 0
		seen := map[RegistryPlatform]bool{}
		for _, manifest := range item.Manifests {
			item.Size += manifest.Size.Total
			if !manifest.Available || manifest.Kind != "image" || manifest.ImageData == nil {
				continue
			}
			platform := manifest.ImageData.Platform
			platform.Architecture = normalizeImageArchitecture(platform.Architecture)
			if platform.Architecture == "" || platform.OS == "" || platform.OS == "unknown" || seen[platform] {
				continue
			}
			seen[platform] = true
			descriptor := registryDescriptor(manifest.Descriptor)
			descriptor.Platform = &platform
			index.Manifests = append(index.Manifests, descriptor)
		}
		sort.Slice(index.Manifests, func(i, j int) bool {
			a, b := index.Manifests[i].Platform, index.Manifests[j].Platform
			return a.OS+"/"+a.Architecture+platformVariant(a.Variant) < b.OS+"/"+b.Architecture+platformVariant(b.Variant)
		})
	}
	tags := append([]string(nil), item.RepoTags...)
	nameValue := ""
	if len(tags) > 0 {
		nameValue = tags[0]
	}
	metadata := DockerImageMetadata{
		CreatedAt:    item.Created,
		Architecture: item.Architecture,
		Variant:      item.Variant,
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
		Index:        index,
		Metadata:     metadata,
		Layers:       dockerRootFSLayers(item.RootFS.Layers),
		Runtime:      dockerRuntimeConfig(item.Config),
	}, nil
}

// dial-stdio 复用 Docker CLI 的 context/连接配置，也适用于 SSH 上的 Docker。
// 使用结构化 Engine 响应，避免解析 image ls --tree 的终端展示文本。
func (s *ImageService) inspectDockerIndex(ctx context.Context, source ImageSource, cliPath, imageID string) (dockerImageInspectJSON, error) {
	var item dockerImageInspectJSON
	request := "GET /images/" + url.PathEscape(imageID) + "/json?manifests=true HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"
	stdout := &limitedBuffer{limit: maxImageCommandOutput}
	stderr := &limitedBuffer{limit: maxImageCommandOutput}
	args := []string{"system", "dial-stdio"}
	var err error
	if source.Kind == "ssh" && (source.SSHPassword != "" || source.SSHPrivateKey != "" || source.SSHPrivateKeyPath != "") {
		client, dialErr := dialAuthenticatedSSH(ctx, source, s.sshLanguage())
		if dialErr != nil {
			return item, dialErr
		}
		defer client.Close()
		err = runSSHCommandToWriters(ctx, client, cliPath, strings.NewReader(request), stdout, stderr, args...)
	} else {
		name, commandArgs, buildErr := buildImageCommand(source, cliPath, args...)
		if buildErr != nil {
			return item, buildErr
		}
		cmd := execCommandContext(ctx, name, commandArgs...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = strings.NewReader(request), stdout, stderr
		err = cmd.Run()
	}
	if ctx.Err() != nil {
		return item, ctx.Err()
	}
	if err != nil {
		if stderr.Len() > 0 {
			err = fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
		}
		return item, err
	}
	response, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(stdout.Bytes())), nil)
	if err != nil {
		return item, userErrorCause("errors.image.dockerDetailParseFailed", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(response.Body).Decode(&failure); err != nil {
			return item, userErrorCause("errors.image.dockerDetailParseFailed", err)
		}
		return item, fmt.Errorf("Docker API %s: %s", response.Status, failure.Message)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxImageCommandOutput)).Decode(&item); err != nil {
		return item, userErrorCause("errors.image.dockerDetailParseFailed", err)
	}
	return item, nil
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
		return DockerImageDetail{}, userError("errors.image.registryRepositoryMismatch")
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
		return DockerImageDetail{}, userErrorCause("errors.image.registryManifestReadFailed", redactRegistryError(err, source))
	}
	resolvedDigest := descriptor.Digest.String()
	if !canonicalSHA256Digest(resolvedDigest) {
		return DockerImageDetail{}, userError("errors.image.registryManifestDigestInvalid")
	}
	if digest != "" && resolvedDigest != digest {
		return DockerImageDetail{}, userError("errors.image.registryManifestDigestMismatch")
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
		return DockerImageDetail{}, userErrorCause("errors.image.registryManifestParseFailed", err)
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
	Descriptor *v1.Descriptor `json:"Descriptor"`
	Manifests  []struct {
		Descriptor v1.Descriptor `json:"Descriptor"`
		Available  bool          `json:"Available"`
		Size       struct {
			Total int64 `json:"Total"`
		} `json:"Size"`
		Kind      string `json:"Kind"`
		ImageData *struct {
			Platform RegistryPlatform `json:"Platform"`
		} `json:"ImageData"`
	} `json:"Manifests"`
	ID           string    `json:"Id"`
	RepoTags     []string  `json:"RepoTags"`
	Size         int64     `json:"Size"`
	Created      string    `json:"Created"`
	Architecture string    `json:"Architecture"`
	Variant      string    `json:"Variant"`
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
		return finish(DockerImageDetail{}, userError("errors.image.imageIDInvalid"))
	}
	return finish(s.inspectWithSnapshot(sourceID, source, cliPath, fingerprint, imageID, repository))
}
