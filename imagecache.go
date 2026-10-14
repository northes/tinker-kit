package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type imageCacheCall struct {
	done   chan struct{}
	detail DockerImageDetail
	err    error
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
