package main

import (
	"context"
	"net/http"
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

// StartRegistryImagePulls 将远程镜像完整复制到当前 Registry，Source 可以是 tag 或 digest。
func (s *ImageService) StartRegistryImagePulls(sourceID string, changes []DockerImageReferenceChange) (ImageExportResult, error) {
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
		s.enqueueRegistryImagePull(source, change)
	}
	return ImageExportResult{Started: len(changes), Snapshot: s.GetImageTasks()}, nil
}

func (s *ImageService) enqueueRegistryImagePull(source ImageSource, change DockerImageReferenceChange) {
	ctx, cancel := context.WithCancel(s.serviceContext())
	reference, _ := name.ParseReference(change.Source)
	origin := s.registryPullSource(reference, source)
	id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypePull, SourceID: source.ID, ImageID: change.Source, Path: change.Target, ProgressUnit: "bytes"}, cancel: cancel})
	s.exportWG.Add(1)
	go func() { defer s.exportWG.Done(); s.runRegistryImagePull(ctx, id, source, origin, change) }()
}

func (s *ImageService) runRegistryImagePull(ctx context.Context, taskID string, source, origin ImageSource, change DockerImageReferenceChange) {
	if !s.acquireTaskSlot(ctx, taskID) {
		return
	}
	if s.taskScheduler != nil {
		defer s.taskScheduler.Release()
	}
	s.updateTask(taskID, func(task *imageTaskState) { task.Status, task.Stage = imageTaskRunning, "pulling" })
	err := s.copyRegistryImage(ctx, taskID, source, origin, change)
	if err != nil {
		err = userErrorCause("errors.imageExport.registryTransferFailed", redactRegistryError(redactRegistryError(err, origin), source))
	}
	s.finishImageTransfer(taskID, source, ctx, err)
}

func (s *ImageService) copyRegistryImage(ctx context.Context, taskID string, source, origin ImageSource, change DockerImageReferenceChange) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	reference, err := name.ParseReference(change.Source)
	if err != nil {
		return err
	}
	descriptor, err := remote.Get(reference, s.registryTransferOptions(ctx, origin)...)
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
	if descriptor.MediaType.IsIndex() {
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
	return s.withRegistryTransferProgress(ctx, taskID, source, func(options []remote.Option) error { return remote.Write(target, image, options...) })
}
