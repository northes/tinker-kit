package main

import (
	"context"
	"errors"
	"log"
	"strings"
)

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
		s.backgroundDetailSem = make(chan struct{}, backgroundDetailConcurrency)
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
			if _, err := s.inspectWithGeneration(job.sourceID, job.source, job.cliPath, job.fingerprint, job.imageID, job.repository, job.ctx, imageDetailBackground, job.generation); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
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

func (s *ImageService) detailPermit(ctx context.Context, requestClass imageDetailRequestClass) (func(), error) {
	s.ensurePrewarmWorkers()
	backgroundAcquired := false
	releaseBackground := func() {
		if backgroundAcquired {
			<-s.backgroundDetailSem
			backgroundAcquired = false
		}
	}
	if requestClass == imageDetailBackground {
		select {
		case s.backgroundDetailSem <- struct{}{}:
			backgroundAcquired = true
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	select {
	case s.detailSem <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-s.detailSem
			releaseBackground()
			return nil, err
		}
		return func() {
			<-s.detailSem
			releaseBackground()
		}, nil
	case <-ctx.Done():
		releaseBackground()
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
