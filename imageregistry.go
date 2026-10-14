package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
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
)

func registryEndpoint(source ImageSource) (name.Registry, error) {
	u, ok := normalizeRegistryURL(source.RegistryURL)
	if !ok {
		return name.Registry{}, userError("errors.image.registryURLHTTPSOnly")
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return name.Registry{}, userError("errors.image.registryURLInvalid")
	}
	registry, err := name.NewRegistry(parsed.Host)
	if err != nil {
		return name.Registry{}, userErrorCause("errors.image.registryAddressParseFailed", err)
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
	base        http.RoundTripper
	streamBlobs bool
}

// 仅导出 blob 的请求携带声明大小，其他元数据请求继续使用默认上限。
type registryBlobSizeKey struct{}

func (t *limitedRegistryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err == nil && response != nil && response.Body != nil {
		if t.streamBlobs && request.Method == http.MethodGet && response.StatusCode == http.StatusOK && strings.Contains(request.URL.Path, "/blobs/") {
			return response, nil
		}
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
		return name.Repository{}, userError("errors.image.registryRepositoryInvalid")
	}
	repo, err := name.NewRepository(registry.String()+"/"+repository, name.WeakValidation)
	if err != nil {
		return name.Repository{}, userErrorCause("errors.image.registryRepositoryParseFailed", err)
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
		return "", "", userError("errors.image.registryImageIDInvalid")
	}
	repository, digest := imageID[:separator], imageID[separator+1:]
	if _, err := v1.NewHash(digest); err != nil || !strings.HasPrefix(digest, "sha256:") || len(digest) != len("sha256:")+64 {
		return "", "", userError("errors.image.registryImageIDDigestInvalid")
	}
	if _, err := registryRepository(ImageSource{RegistryURL: "https://placeholder.invalid"}, repository); err != nil {
		// 这里只借助仓库解析器校验名称，不接受任意镜像引用。
		return "", "", userError("errors.image.registryRepositoryNameInvalid")
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
		return "", "", "", userError("errors.image.registryReferenceTagMissing")
	}
	repository, tag = imageID[:separator], imageID[separator+1:]
	if _, err := registryRepository(ImageSource{RegistryURL: "https://placeholder.invalid"}, repository); err != nil {
		return "", "", "", userError("errors.image.registryRepositoryNameInvalid")
	}
	if !validRegistryTag(tag) {
		return "", "", "", userError("errors.image.registryTagInvalid")
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
		return nil, userErrorCause("errors.image.registryClientCreateFailed", redactRegistryError(err, source))
	}
	const pageSize = 1000
	repositories := make([]string, 0)
	last := ""
	for len(repositories) < maxRegistryRepositories {
		page, err := remote.CatalogPage(registry, last, pageSize, options...)
		if err != nil {
			return nil, userErrorCause("errors.image.registryCatalogFailed", redactRegistryError(err, source))
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
			return nil, userError("errors.image.registryCatalogPageStuck")
		}
		last = next
	}
	if len(repositories) >= maxRegistryRepositories {
		return nil, userError("errors.image.registryRepositoryLimitExceeded")
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
			return nil, userErrorParamsCause("errors.image.registryTagListFailed", map[string]any{"repository": repositoryName}, redactRegistryError(err, source))
		}
		if len(tags) > maxRegistryTags {
			return nil, userErrorParams("errors.image.registryTagLimitExceeded", map[string]any{"repository": repositoryName})
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
		return "", userErrorCause("errors.image.registryClientCreateFailed", redactRegistryError(err, source))
	}
	descriptor, err := puller.Head(ctx, repository.Tag(tag))
	if err != nil {
		return "", redactRegistryError(err, source)
	}
	digest := descriptor.Digest.String()
	if !canonicalSHA256Digest(digest) {
		return "", userErrorParams("errors.image.registryDigestInvalid", map[string]any{"repository": repositoryName, "tag": tag})
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
		return registryImageMetadataEvent{}, userError("errors.image.registryManifestDigestInvalid")
	}
	if digest != "" && digest != resolvedDigest {
		return registryImageMetadataEvent{}, userError("errors.image.registryManifestDigestMismatch")
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
	platforms, err := registryImagePlatforms(itemCtx, descriptor)
	if err != nil {
		return registryImageMetadataEvent{}, redactRegistryError(err, source)
	}
	metadata.Platforms = platforms
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
			message = redactCredential(message, secret)
		}
	}
	return errors.New(message)
}

// redactCredential 只替换作为独立词出现的凭据。凭据（例如用户名 igc）常是主机名等
// 更长标识的子串，直接 ReplaceAll 会把 zot.igcexpertcloud.com 误伤成
// zot.[redacted]expertcloud.com。
func redactCredential(message, secret string) string {
	if secret == "" {
		return message
	}
	var builder strings.Builder
	for {
		index := strings.Index(message, secret)
		if index < 0 {
			builder.WriteString(message)
			return builder.String()
		}
		var left, right byte
		if index > 0 {
			left = message[index-1]
		}
		if end := index + len(secret); end < len(message) {
			right = message[end]
		}
		builder.WriteString(message[:index])
		if isCredentialBoundary(left) && isCredentialBoundary(right) {
			builder.WriteString("[redacted]")
		} else {
			builder.WriteString(secret)
		}
		message = message[index+len(secret):]
	}
}

func isCredentialBoundary(b byte) bool {
	return !((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9'))
}
