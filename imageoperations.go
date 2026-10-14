package main

import (
	"context"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

func (s *ImageService) PushDockerImage(sourceID string, image string) (DockerOperationResult, error) {
	result := DockerOperationResult{Image: image}
	if !validImageReference(image) {
		err := userError("errors.image.referenceInvalid")
		result.Error = err.Error()
		return result, err
	}
	source, cliPath, err := s.source(sourceID)
	if err != nil {
		result.Error = err.Error()
		return result, err
	}
	if source.Kind == "registry" {
		err := userError("errors.image.registryPushUnsupported")
		result.Error = err.Error()
		return result, err
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

const maxDockerImageOperations = 100

func emptyDockerImageBatchResult() DockerImageBatchResult {
	return DockerImageBatchResult{
		Succeeded: []string{},
		Failed:    []DockerImageOperationFailure{},
	}
}

func normalizeImageReferenceChanges(changes []DockerImageReferenceChange) []DockerImageReferenceChange {
	unique := make([]DockerImageReferenceChange, 0, len(changes))
	seen := make(map[string]struct{}, len(changes))
	for _, change := range changes {
		change.Source = strings.TrimSpace(change.Source)
		change.Target = strings.TrimSpace(change.Target)
		key := change.Source + "\x00" + change.Target
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, change)
	}
	return unique
}

func validMutableImageReference(reference string) bool {
	return validImageReference(reference) && !strings.Contains(reference, "<none>") && !strings.Contains(reference, "@")
}

func (s *ImageService) dockerMutationSource(sourceID string) (ImageSource, string, string, error) {
	source, cliPath, fingerprint, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return ImageSource{}, "", "", err
	}
	if source.Kind == "registry" {
		return ImageSource{}, "", "", userError("errors.image.registryMutationUnsupported")
	}
	return source, cliPath, fingerprint, nil
}

func appendDockerImageBatchFailure(result *DockerImageBatchResult, image, errText string) {
	result.Failed = append(result.Failed, DockerImageOperationFailure{Image: image, Error: errText})
}

// TagDockerImages 同步执行一批换 Tag；removeSource 为 true 表示重命名。
// 后台任务入口见 StartImageTagChanges；单条变更逻辑由 applyImageTagChange 承担。
func (s *ImageService) TagDockerImages(sourceID string, changes []DockerImageReferenceChange, removeSource bool) DockerImageBatchResult {
	result := emptyDockerImageBatchResult()
	changes = normalizeImageReferenceChanges(changes)
	if len(changes) == 0 {
		return result
	}
	s.watchDeleteMu.Lock()
	defer s.watchDeleteMu.Unlock()
	s.watchMutationMu.Lock()
	defer s.watchMutationMu.Unlock()
	source, cliPath, fingerprint, sourceErr := s.sourceSnapshot(sourceID)
	if sourceErr != nil {
		for _, change := range changes {
			appendDockerImageBatchFailure(&result, change.Source, sourceErr.Error())
		}
		return result
	}
	if len(changes) > maxDockerImageOperations {
		for _, change := range changes[maxDockerImageOperations:] {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.operationLimitExceeded").Error())
		}
		changes = changes[:maxDockerImageOperations]
	}
	ctx := s.serviceContext()
	for _, change := range changes {
		if !validMutableImageReference(change.Source) || !validMutableImageReference(change.Target) {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.referenceInvalid").Error())
			continue
		}
		if change.Source == change.Target {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.targetTagSameAsSource").Error())
			continue
		}
		if !s.sourceFingerprintCurrent(sourceID, fingerprint) {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.sourceChanged").Error())
			continue
		}
		if err := s.applyImageTagChange(ctx, source, cliPath, change, removeSource, nil); err != nil {
			appendDockerImageBatchFailure(&result, change.Source, err.Error())
			continue
		}
		result.Succeeded = append(result.Succeeded, change.Target)
	}
	return result
}

// applyImageTagChange 执行单条换 Tag 变更。Registry 走 registry API，其余来源走 Docker CLI；
// report 用于回传已完成的操作数与阶段，可为 nil。
func (s *ImageService) applyImageTagChange(ctx context.Context, source ImageSource, cliPath string, change DockerImageReferenceChange, removeSource bool, report func(completed, total int64, stage string)) error {
	if source.Kind == "registry" {
		itemCtx, cancel := context.WithTimeout(ctx, registryTagTimeout)
		defer cancel()
		release, err := s.registryPermit(itemCtx)
		if err != nil {
			return err
		}
		defer release()
		return s.tagRegistryImage(itemCtx, source, change, removeSource, s.registryOptions(itemCtx, source), report)
	}
	total := int64(1)
	if removeSource {
		total = 2
	}
	if report != nil {
		report(0, total, "retagging")
	}
	tagCtx, cancelTag := context.WithTimeout(ctx, imageCommandTimeout)
	_, err := s.runDockerSnapshotContext(tagCtx, source, cliPath, []string{"image", "tag", change.Source, change.Target})
	cancelTag()
	if err != nil {
		return err
	}
	if report != nil {
		report(1, total, "retagging")
	}
	if removeSource {
		rmCtx, cancelRm := context.WithTimeout(ctx, imageCommandTimeout)
		_, err = s.runDockerSnapshotContext(rmCtx, source, cliPath, []string{"image", "rm", change.Source})
		cancelRm()
		if err != nil {
			return userErrorCause("errors.image.oldTagDeleteFailed", err)
		}
		if report != nil {
			report(2, 2, "renaming")
		}
	}
	return nil
}

// tagRegistryImage 用 Registry API 换 Tag，仅支持同仓库；removeSource 时因标准 Registry
// 只能按 digest 删除 manifest，采用“删除后按幸存 Tag 重推”来只移除源 Tag。
func (s *ImageService) tagRegistryImage(ctx context.Context, source ImageSource, change DockerImageReferenceChange, removeSource bool, options []remote.Option, report func(completed, total int64, stage string)) error {
	sourceRepoName, sourceTag, sourceDigest, err := parseRegistryImageReference(change.Source)
	if err != nil {
		return err
	}
	if sourceDigest != "" || sourceTag == "" {
		return userError("errors.image.registryReferenceTagMissing")
	}
	targetRepoName, targetTag, targetDigest, err := parseRegistryImageReference(change.Target)
	if err != nil {
		return err
	}
	if targetDigest != "" || targetTag == "" {
		return userError("errors.image.registryReferenceTagMissing")
	}
	if targetRepoName != sourceRepoName {
		return userErrorParams("errors.image.registryCrossRepositoryUnsupported", map[string]any{"repository": sourceRepoName})
	}
	repo, err := registryRepository(source, sourceRepoName)
	if err != nil {
		return err
	}
	if report != nil {
		report(0, 1, "preparing")
	}
	descriptor, err := remote.Get(repo.Tag(sourceTag), options...)
	if err != nil {
		return userErrorCause("errors.image.registryTagReadFailed", redactRegistryError(err, source))
	}
	if !removeSource {
		if report != nil {
			report(0, 1, "retagging")
		}
		if err := remote.Put(repo.Tag(targetTag), descriptor, options...); err != nil {
			return userErrorCause("errors.image.registryTagCopyFailed", redactRegistryError(err, source))
		}
		if report != nil {
			report(1, 1, "retagging")
		}
		return nil
	}
	digest := descriptor.Digest.String()
	survivors, err := s.registrySurvivingTags(ctx, source, repo, digest, sourceTag, targetTag, options)
	if err != nil {
		return err
	}
	total := int64(2 + len(survivors))
	completed := int64(0)
	if report != nil {
		report(completed, total, "renaming")
	}
	if err := remote.Delete(repo.Digest(digest), options...); err != nil {
		return userErrorCause("errors.image.oldTagDeleteFailed", redactRegistryError(err, source))
	}
	completed++
	if report != nil {
		report(completed, total, "renaming")
	}
	if err := remote.Put(repo.Tag(targetTag), descriptor, options...); err != nil {
		return userErrorCause("errors.image.registryTagCopyFailed", redactRegistryError(err, source))
	}
	completed++
	if report != nil {
		report(completed, total, "renaming")
	}
	for _, tag := range survivors {
		if err := remote.Put(repo.Tag(tag), descriptor, options...); err != nil {
			return userErrorParamsCause("errors.image.registryTagRestoreFailed", map[string]any{"tag": tag}, redactRegistryError(err, source))
		}
		completed++
		if report != nil {
			report(completed, total, "renaming")
		}
	}
	return nil
}

// registrySurvivingTags 列出同一 manifest 上除源/目标外的其他 Tag，供删除后重推时保留。
func (s *ImageService) registrySurvivingTags(ctx context.Context, source ImageSource, repo name.Repository, digest, sourceTag, targetTag string, options []remote.Option) ([]string, error) {
	puller, err := remote.NewPuller(options...)
	if err != nil {
		return nil, userErrorCause("errors.image.registryClientCreateFailed", redactRegistryError(err, source))
	}
	tags, err := puller.List(ctx, repo)
	if err != nil {
		return nil, userErrorParamsCause("errors.image.registryTagListFailed", map[string]any{"repository": repo.RepositoryStr()}, redactRegistryError(err, source))
	}
	if len(tags) > maxRegistryTags {
		return nil, userErrorParams("errors.image.registryTagLimitExceeded", map[string]any{"repository": repo.RepositoryStr()})
	}
	survivors := make([]string, 0)
	for _, tag := range tags {
		if tag == sourceTag || tag == targetTag || !validRegistryTag(tag) {
			continue
		}
		descriptor, err := puller.Head(ctx, repo.Tag(tag))
		if err != nil {
			return nil, userErrorParamsCause("errors.image.registryTagListFailed", map[string]any{"repository": repo.RepositoryStr()}, redactRegistryError(err, source))
		}
		if descriptor.Digest.String() == digest {
			survivors = append(survivors, tag)
		}
	}
	return survivors, nil
}

// deleteRegistryTagPreservingSiblings 只删除一个 tag：标准 Registry 只能按 digest 删除
// manifest，因此先列出同一 manifest 的其他 tag，删除后再把它们重推回同一 digest。
func (s *ImageService) deleteRegistryTagPreservingSiblings(ctx context.Context, source ImageSource, repo name.Repository, digest, tag string, options []remote.Option) error {
	descriptor, err := remote.Get(repo.Tag(tag), options...)
	if err != nil {
		return userErrorCause("errors.image.registryTagReadFailed", redactRegistryError(err, source))
	}
	if descriptor.Digest.String() != digest {
		return userError("errors.image.registryDigestChanged")
	}
	survivors, err := s.registrySurvivingTags(ctx, source, repo, digest, tag, "", options)
	if err != nil {
		return err
	}
	if err := remote.Delete(repo.Digest(digest), options...); err != nil {
		return userErrorCause("errors.image.registryManifestDeleteFailed", redactRegistryError(err, source))
	}
	for _, survivor := range survivors {
		if err := remote.Put(repo.Tag(survivor), descriptor, options...); err != nil {
			return userErrorParamsCause("errors.image.registryTagRestoreFailed", map[string]any{"tag": survivor}, redactRegistryError(err, source))
		}
	}
	return nil
}

// PushDockerImages 推送镜像。Source 与 Target 不同时先创建目标 Tag，再推送目标 Tag。
// Source 与 Target 相同时直接推送当前镜像名称。
func (s *ImageService) PushDockerImages(sourceID string, changes []DockerImageReferenceChange) DockerImageBatchResult {
	result := emptyDockerImageBatchResult()
	changes = normalizeImageReferenceChanges(changes)
	if len(changes) == 0 {
		return result
	}
	s.watchDeleteMu.Lock()
	defer s.watchDeleteMu.Unlock()
	s.watchMutationMu.Lock()
	defer s.watchMutationMu.Unlock()
	source, cliPath, fingerprint, sourceErr := s.dockerMutationSource(sourceID)
	if sourceErr != nil {
		for _, change := range changes {
			appendDockerImageBatchFailure(&result, change.Source, sourceErr.Error())
		}
		return result
	}
	if len(changes) > maxDockerImageOperations {
		for _, change := range changes[maxDockerImageOperations:] {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.operationLimitExceeded").Error())
		}
		changes = changes[:maxDockerImageOperations]
	}
	for _, change := range changes {
		if !validMutableImageReference(change.Source) || !validMutableImageReference(change.Target) {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.referenceInvalid").Error())
			continue
		}
		if !s.sourceFingerprintCurrent(sourceID, fingerprint) {
			appendDockerImageBatchFailure(&result, change.Source, userError("errors.image.sourceChanged").Error())
			continue
		}
		if change.Source != change.Target {
			if _, err := s.runDockerSnapshot(source, cliPath, []string{"image", "tag", change.Source, change.Target}, imageCommandTimeout); err != nil {
				appendDockerImageBatchFailure(&result, change.Source, err.Error())
				continue
			}
		}
		if _, err := s.runDockerSnapshot(source, cliPath, []string{"image", "push", change.Target}, imagePushTimeout); err != nil {
			appendDockerImageBatchFailure(&result, change.Source, err.Error())
			continue
		}
		result.Succeeded = append(result.Succeeded, change.Target)
	}
	return result
}

// DeleteDockerImages 删除镜像。deleteManifest 仅对 Registry 生效：true 删除整个
// manifest（关联 tag 全部失效），false 只删除指定 tag 并重推同 manifest 的其他 tag。
func (s *ImageService) DeleteDockerImages(sourceID string, targets []DockerDeleteTarget, deleteManifest bool) DockerDeleteResult {
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
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: target.ImageID, Error: userError("errors.image.deleteLimitExceeded").Error()})
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
	var registryOpts []remote.Option
	if source.Kind == "registry" {
		deleteTimeout := registryListTimeout
		if !deleteManifest {
			deleteTimeout = registryTagTimeout
		}
		ctx, cancel = context.WithTimeout(ctx, deleteTimeout)
		defer cancel()
		release, err := s.registryPermit(ctx)
		if err != nil {
			for _, target := range uniqueTargets {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: target.ImageID, Error: err.Error()})
			}
			return result
		}
		defer release()
		registryOpts = s.registryOptions(ctx, source)
	}
	for _, target := range uniqueTargets {
		imageID := target.ImageID
		if !s.sourceFingerprintCurrent(sourceID, fingerprint) {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: userError("errors.image.sourceChangedDelete").Error()})
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
					result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: userErrorCause("errors.image.registryDigestResolveFailed", redactRegistryError(err, source)).Error()})
					continue
				}
			}
			if target.ExpectedDigest == "" {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: userError("errors.image.registryDigestMissing").Error()})
				continue
			}
			if digest != target.ExpectedDigest {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: userError("errors.image.registryDigestChanged").Error()})
				continue
			}
			repo, err := registryRepository(source, repository)
			if err != nil {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: err.Error()})
				continue
			}
			if !deleteManifest && tag != "" {
				if err := s.deleteRegistryTagPreservingSiblings(ctx, source, repo, digest, tag, registryOpts); err != nil {
					result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: err.Error()})
					continue
				}
				s.removeWatchSnapshotImages(sourceID, fingerprint, imageID, "", false)
				result.Deleted = append(result.Deleted, imageID)
				continue
			}
			if err := remote.Delete(repo.Digest(digest), registryOpts...); err != nil {
				result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: userErrorCause("errors.image.registryManifestDeleteFailed", redactRegistryError(err, source)).Error()})
				continue
			}
			s.removeImageCache(sourceID, fingerprint, digest, repository)
			s.removeWatchSnapshotImages(sourceID, fingerprint, digest, repository, true)
			result.Deleted = append(result.Deleted, imageID)
			continue
		}
		if !validImageReference(imageID) {
			result.Failed = append(result.Failed, DockerDeleteFailure{ImageID: imageID, Error: userError("errors.image.imageIDInvalid").Error()})
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
