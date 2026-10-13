package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/layout"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// ImageImportEntry 是包内一条引用；Image 标识 manifest 或 OCI 根描述符的位置。
type ImageImportEntry struct {
	Path        string   `json:"path"`
	Image       int      `json:"image"`
	Reference   string   `json:"reference"`
	Target      string   `json:"target"`
	Fingerprint string   `json:"fingerprint"`
	Platforms   []string `json:"platforms"`
	Conflict    bool     `json:"conflict"`
}

type imageArchiveMember struct{ offset, size int64 }
type imageArchive struct {
	file        *os.File
	members     map[string]imageArchiveMember
	docker      tarball.Manifest
	index       v1.IndexManifest
	oci         bool
	fingerprint string
	entries     []ImageImportEntry
}

func importError(err error) error {
	return userErrorCause("errors.imageExport.readImportArchive", err)
}

func archiveMemberName(value string) (string, error) {
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || path.IsAbs(cleaned) || strings.ContainsAny(cleaned, "\\\x00") {
		return "", userErrorParams("errors.imageExport.importUnsafePath", map[string]any{"path": value})
	}
	return cleaned, nil
}

// 只保存文件偏移，跳过层内容；预检不会把大镜像读入内存或展开到磁盘。
func readImageArchive(ctx context.Context, filename string) (_ *imageArchive, retErr error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, importError(err)
	}
	defer func() {
		if retErr != nil {
			file.Close()
		}
	}()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = userErrorParams("errors.imageExport.importPathNotRegular", map[string]any{"path": filename})
		}
		return nil, importError(err)
	}
	a := &imageArchive{file: file, members: map[string]imageArchiveMember{}}
	reader := tar.NewReader(file)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, importError(err)
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return nil, userErrorParams("errors.imageExport.importUnsupportedMember", map[string]any{"path": header.Name})
		}
		member, err := archiveMemberName(header.Name)
		if err != nil {
			return nil, err
		}
		if _, exists := a.members[member]; exists {
			return nil, userErrorParams("errors.imageExport.importDuplicateMember", map[string]any{"path": member})
		}
		offset, err := file.Seek(0, io.SeekCurrent)
		if err != nil {
			return nil, err
		}
		a.members[member] = imageArchiveMember{offset, header.Size}
	}
	metadataName := "manifest.json"
	if _, exists := a.members["oci-layout"]; exists {
		a.oci, metadataName = true, "index.json"
		var version struct {
			Version string `json:"imageLayoutVersion"`
		}
		if err := a.readJSON("oci-layout", &version); err != nil {
			return nil, err
		}
		if version.Version != "1.0.0" {
			return nil, userError("errors.imageExport.importOCIVersion")
		}
	}
	metadata, err := a.readMetadata(metadataName)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	hash.Write(metadata)
	fmt.Fprintf(hash, ":%d:%d", info.Size(), info.ModTime().UnixNano())
	a.fingerprint = hex.EncodeToString(hash.Sum(nil))
	if a.oci {
		if err := json.Unmarshal(metadata, &a.index); err != nil {
			return nil, importError(err)
		}
		for i, descriptor := range a.index.Manifests {
			platforms, err := a.ociPlatforms(ctx, descriptor, map[string]bool{})
			if err != nil {
				return nil, err
			}
			// Docker/containerd 将完整镜像名与 OCI 引用标签分别保存在两个 annotation 中。
			// OCI ref.name 可以只有 tag，不能直接把它当作仓库名补 latest。
			reference := descriptor.Annotations["io.containerd.image.name"]
			target := suggestedImportTarget(reference)
			if reference == "" {
				reference = descriptor.Annotations["org.opencontainers.image.ref.name"]
				if strings.ContainsAny(reference, ":/") {
					target = suggestedImportTarget(reference)
				}
			}
			if reference == "" {
				reference = descriptor.Digest.String()
			}
			if target != "" {
				reference = familiarImportReference(reference)
			}
			a.entries = append(a.entries, ImageImportEntry{Path: filename, Image: i, Reference: reference, Target: target, Fingerprint: a.fingerprint, Platforms: platforms})
		}
	} else {
		if err := json.Unmarshal(metadata, &a.docker); err != nil {
			return nil, importError(err)
		}
		for i, image := range a.docker {
			var config v1.ConfigFile
			if err := a.readJSON(image.Config, &config); err != nil {
				return nil, err
			}
			for _, layer := range image.Layers {
				if _, exists := a.members[layer]; !exists {
					return nil, userErrorParams("errors.imageExport.importMissingMember", map[string]any{"path": layer})
				}
			}
			refs := image.RepoTags
			if len(refs) == 0 {
				refs = []string{image.Config}
			}
			for _, reference := range refs {
				target := suggestedImportTarget(reference)
				if target != "" {
					reference = familiarImportReference(reference)
				}
				a.entries = append(a.entries, ImageImportEntry{Path: filename, Image: i, Reference: reference, Target: target, Fingerprint: a.fingerprint, Platforms: []string{config.OS + "/" + config.Architecture + platformVariant(config.Variant)}})
			}
		}
	}
	if len(a.entries) == 0 {
		return nil, userError("errors.imageExport.importEmptyArchive")
	}
	return a, nil
}

func (a *imageArchive) readMetadata(member string) ([]byte, error) {
	entry, exists := a.members[member]
	if !exists || entry.size < 0 || entry.size > maxRegistryBodySize {
		return nil, userErrorParams("errors.imageExport.importInvalidMetadata", map[string]any{"path": member})
	}
	data, err := io.ReadAll(io.NewSectionReader(a.file, entry.offset, entry.size))
	if err != nil {
		return nil, importError(err)
	}
	return data, nil
}
func (a *imageArchive) readJSON(member string, value any) error {
	data, err := a.readMetadata(member)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, value); err != nil {
		return importError(err)
	}
	return nil
}

func (a *imageArchive) ociPlatforms(ctx context.Context, descriptor v1.Descriptor, visited map[string]bool) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	digest := descriptor.Digest.String()
	if !canonicalSHA256Digest(digest) || visited[digest] {
		return nil, userError("errors.imageExport.importInvalidDescriptor")
	}
	visited[digest] = true
	defer delete(visited, digest)
	data, err := a.readMetadata("blobs/sha256/" + descriptor.Digest.Hex)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(data)
	if int64(len(data)) != descriptor.Size || hex.EncodeToString(hash[:]) != descriptor.Digest.Hex {
		return nil, userErrorParams("errors.imageExport.importDigestMismatch", map[string]any{"path": digest})
	}
	var manifest struct {
		Manifests []v1.Descriptor `json:"manifests"`
		Config    v1.Descriptor   `json:"config"`
		Layers    []v1.Descriptor `json:"layers"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, importError(err)
	}
	platforms := map[string]bool{}
	if descriptor.MediaType.IsIndex() {
		for _, child := range manifest.Manifests {
			items, err := a.ociPlatforms(ctx, child, visited)
			if err != nil {
				return nil, err
			}
			for _, item := range items {
				platforms[item] = true
			}
		}
	} else if descriptor.MediaType.IsImage() {
		for _, blob := range append(manifest.Layers, manifest.Config) {
			member, exists := a.members["blobs/sha256/"+blob.Digest.Hex]
			if !canonicalSHA256Digest(blob.Digest.String()) || !exists || member.size != blob.Size {
				return nil, userErrorParams("errors.imageExport.importMissingMember", map[string]any{"path": blob.Digest.String()})
			}
		}
		var config v1.ConfigFile
		if err := a.readJSON("blobs/sha256/"+manifest.Config.Digest.Hex, &config); err != nil {
			return nil, err
		}
		platforms[config.OS+"/"+config.Architecture+platformVariant(config.Variant)] = true
	} else {
		return nil, userErrorParams("errors.imageExport.importUnsupportedMediaType", map[string]any{"type": string(descriptor.MediaType)})
	}
	items := make([]string, 0, len(platforms))
	for item := range platforms {
		items = append(items, item)
	}
	sort.Strings(items)
	return items, nil
}

func suggestedImportTarget(reference string) string {
	if strings.Contains(reference, "@") || strings.HasPrefix(reference, "sha256:") || strings.HasSuffix(reference, ".json") {
		return ""
	}
	reference = familiarImportReference(reference)
	tag, err := name.NewTag(reference, name.WeakValidation)
	if err != nil {
		return ""
	}
	// 保留用户可读的短名称，只为省略 tag 的引用补 latest。
	if strings.LastIndexByte(reference, ':') <= strings.LastIndexByte(reference, '/') {
		return reference + ":" + tag.TagStr()
	}
	return reference
}

// Docker Hub 的默认域名和官方镜像命名空间使用 CLI 常见的短名称。
// 自定义 Registry 的域名与命名空间保持原样；冲突检测仍使用 name.Tag.Name() 规范化。
func familiarImportReference(value string) string {
	reference, err := name.ParseReference(value, name.WeakValidation)
	if err != nil || reference.Context().RegistryStr() != name.DefaultRegistry {
		return value
	}
	repository := strings.TrimPrefix(reference.Context().RepositoryStr(), "library/")
	switch reference := reference.(type) {
	case name.Tag:
		return repository + ":" + reference.TagStr()
	case name.Digest:
		return repository + "@" + reference.DigestStr()
	default:
		return value
	}
}

func platformVariant(variant string) string {
	if variant == "" {
		return ""
	}
	return "/" + variant
}

func importTarget(source ImageSource, value string) (name.Tag, error) {
	value = strings.TrimSpace(value)
	if !validMutableImageReference(value) {
		return name.Tag{}, userError("errors.imageExport.invalidImageReference")
	}
	if source.Kind == "registry" {
		endpoint, err := registryEndpoint(source)
		if err != nil {
			return name.Tag{}, err
		}
		value = strings.TrimPrefix(value, endpoint.String()+"/")
		repository, tag, digest, err := parseRegistryImageReference(value)
		if err != nil {
			return name.Tag{}, err
		}
		if digest != "" {
			return name.Tag{}, userError("errors.imageExport.invalidImageReference")
		}
		repo, err := registryRepository(source, repository)
		if err != nil {
			return name.Tag{}, err
		}
		return repo.Tag(tag), nil
	}
	tag, err := name.NewTag(value, name.WeakValidation)
	if err != nil {
		return name.Tag{}, userErrorCause("errors.imageExport.invalidImageReference", err)
	}
	return tag, nil
}

func (s *ImageService) importConflicts(ctx context.Context, source ImageSource, cliPath string, targets []string, published ...map[string]string) (map[string]bool, error) {
	conflicts := map[string]bool{}
	if source.Kind == "registry" {
		for _, value := range targets {
			if value == "" {
				continue
			}
			tag, err := importTarget(source, value)
			if err != nil {
				return nil, err
			}
			descriptor, headErr := remote.Head(tag, s.registryOptions(ctx, source)...)
			err = headErr
			var response *transport.Error
			if err != nil && (!errors.As(err, &response) || response.StatusCode != 404) {
				return nil, redactRegistryError(err, source)
			}
			conflicts[tag.Name()] = err == nil
			if err == nil && len(published) > 0 && published[0][tag.Name()] == descriptor.Digest.String() {
				conflicts[tag.Name()] = false
			}
		}
		return conflicts, nil
	}
	output, err := s.runDockerSnapshotContext(ctx, source, cliPath, []string{"image", "ls", "--format", "{{.Repository}}:{{.Tag}}"})
	if err != nil {
		return nil, err
	}
	for _, value := range strings.Split(string(output), "\n") {
		if tag, err := importTarget(source, value); err == nil {
			conflicts[tag.Name()] = true
		}
	}
	return conflicts, nil
}

// PrepareImageImports 只选择和检查文件，确认目标引用前不修改 Docker 或 Registry。
func (s *ImageService) PrepareImageImports(ctx context.Context, sourceID string) ([]ImageImportEntry, error) {
	if _, _, _, err := s.sourceSnapshot(sourceID); err != nil {
		return nil, err
	}
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return nil, userError("errors.common.notInitialized")
	}
	dialog := app.Dialog.OpenFile().CanChooseDirectories(false).CanChooseFiles(true).AddFilter("Docker / OCI tar", "*.tar")
	if window := app.Window.Current(); window != nil {
		dialog.AttachToWindow(window)
	}
	paths, err := dialog.PromptForMultipleSelection()
	if err != nil {
		return nil, userErrorCause("errors.imageExport.selectImportFiles", err)
	}
	return s.prepareImageImportPaths(ctx, sourceID, paths)
}

func (s *ImageService) prepareImageImportPaths(ctx context.Context, sourceID string, paths []string) ([]ImageImportEntry, error) {
	source, cliPath, _, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return nil, err
	}
	entries := []ImageImportEntry{}
	seen := map[string]bool{}
	for _, filename := range paths {
		if seen[filename] {
			continue
		}
		seen[filename] = true
		a, err := readImageArchive(ctx, filename)
		if err != nil {
			return nil, err
		}
		a.file.Close()
		for _, entry := range a.entries {
			if source.Kind == "registry" && entry.Target != "" {
				parts := strings.SplitN(entry.Target, "/", 2)
				if len(parts) == 2 && (strings.ContainsAny(parts[0], ".:") || parts[0] == "localhost") {
					entry.Target = parts[1]
				}
			}
			entries = append(entries, entry)
		}
	}
	targets := make([]string, len(entries))
	for i := range entries {
		targets[i] = entries[i].Target
	}
	checkCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	existing, err := s.importConflicts(checkCtx, source, cliPath, targets)
	if err != nil {
		return nil, err
	}
	for i := range entries {
		if entries[i].Target == "" {
			continue
		}
		tag, err := importTarget(source, entries[i].Target)
		if err != nil {
			return nil, err
		}
		entries[i].Conflict = existing[tag.Name()]
	}
	return entries, nil
}

func (s *ImageService) checkImportTargets(ctx context.Context, source ImageSource, cliPath string, entries []ImageImportEntry, published ...map[string]string) error {
	targets := make([]string, len(entries))
	seen := map[string]bool{}
	for i, entry := range entries {
		tag, err := importTarget(source, entry.Target)
		if err != nil {
			return err
		}
		if seen[tag.Name()] {
			return userErrorParams("errors.imageExport.importTargetDuplicate", map[string]any{"target": entry.Target})
		}
		seen[tag.Name()], targets[i] = true, entry.Target
	}
	checkCtx, cancel := context.WithTimeout(ctx, imageCommandTimeout)
	defer cancel()
	existing, err := s.importConflicts(checkCtx, source, cliPath, targets, published...)
	if err != nil {
		return err
	}
	for _, target := range targets {
		tag, _ := importTarget(source, target)
		if existing[tag.Name()] {
			return userErrorParams("errors.imageExport.importTargetExists", map[string]any{"target": target})
		}
	}
	return nil
}

func validateArchiveEntries(a *imageArchive, entries []ImageImportEntry) error {
	if len(a.entries) != len(entries) {
		return userError("errors.imageExport.importArchiveChanged")
	}
	for i, entry := range entries {
		original := a.entries[i]
		if entry.Fingerprint != a.fingerprint || entry.Image != original.Image || entry.Reference != original.Reference {
			return userError("errors.imageExport.importArchiveChanged")
		}
	}
	return nil
}

// StartImageImports 在用户确认目标名称后创建任务，每个文件保留其完整引用映射。
func (s *ImageService) StartImageImports(sourceID string, entries []ImageImportEntry) (ImageExportResult, error) {
	return s.startImageImports(sourceID, entries, nil)
}

func (s *ImageService) startImageImports(sourceID string, entries []ImageImportEntry, published map[string]string) (ImageExportResult, error) {
	source, cliPath, _, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return ImageExportResult{}, err
	}
	if len(entries) == 0 {
		return ImageExportResult{}, userError("errors.imageExport.noImportFilesSelected")
	}
	groups := groupImportEntries(entries)
	for _, group := range groups {
		a, err := readImageArchive(s.serviceContext(), group[0].Path)
		if err != nil {
			return ImageExportResult{}, err
		}
		err = validateArchiveEntries(a, group)
		a.file.Close()
		if err != nil {
			return ImageExportResult{}, err
		}
	}
	if err := s.checkImportTargets(s.serviceContext(), source, cliPath, entries, published); err != nil {
		return ImageExportResult{}, err
	}
	for _, group := range groups {
		s.enqueuePlannedImageImport(sourceID, group, source, cliPath, published)
	}
	return ImageExportResult{Started: len(groups), Snapshot: s.GetImageTasks()}, nil
}

func groupImportEntries(entries []ImageImportEntry) [][]ImageImportEntry {
	groups := [][]ImageImportEntry{}
	positions := map[string]int{}
	for _, entry := range entries {
		position, exists := positions[entry.Path]
		if !exists {
			position = len(groups)
			positions[entry.Path] = position
			groups = append(groups, nil)
		}
		groups[position] = append(groups[position], entry)
	}
	return groups
}

func (s *ImageService) enqueuePlannedImageImport(sourceID string, entries []ImageImportEntry, source ImageSource, cliPath string, published map[string]string) {
	ctx, cancel := context.WithCancel(s.serviceContext())
	entries = append([]ImageImportEntry(nil), entries...)
	filename := entries[0].Path
	taskID := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypeLoad, SourceID: sourceID, ImageID: filepath.Base(filename), Path: filename}, cancel: cancel, importEntries: entries, importPublished: cloneImportPublished(published)})
	s.exportWG.Add(1)
	go func() { defer s.exportWG.Done(); s.runPlannedImageImport(ctx, taskID, entries, source, cliPath) }()
}

func (s *ImageService) finishImageTransfer(taskID string, source ImageSource, ctx context.Context, err error) {
	s.updateTask(taskID, func(task *imageTaskState) {
		task.cancel = nil
		switch {
		case ctx.Err() != nil:
			task.Status, task.Stage, task.Error = imageTaskCanceled, "canceled", ""
		case err != nil:
			task.Status, task.Stage, task.Error = imageTaskFailed, "failed", err.Error()
		default:
			task.Status, task.Stage = imageTaskSuccess, "done"
			task.TotalEstimated = false
			task.Completed, task.Bytes = task.Total, task.Total
		}
	})
	if err == nil && ctx.Err() == nil {
		s.requestSourceRefresh(source.ID)
	}
}

func (s *ImageService) runPlannedImageImport(ctx context.Context, taskID string, entries []ImageImportEntry, source ImageSource, cliPath string) {
	if !s.acquireTaskSlot(ctx, taskID) {
		return
	}
	if s.taskScheduler != nil {
		defer s.taskScheduler.Release()
	}
	s.updateTask(taskID, func(task *imageTaskState) { task.Status, task.Stage = imageTaskRunning, "preparing" })
	err := s.importPlannedArchive(ctx, taskID, entries, source, cliPath)
	s.finishImageTransfer(taskID, source, ctx, err)
}

func (s *ImageService) importPlannedArchive(ctx context.Context, taskID string, entries []ImageImportEntry, source ImageSource, cliPath string) error {
	a, err := readImageArchive(ctx, entries[0].Path)
	if err != nil {
		return err
	}
	defer a.file.Close()
	if err := validateArchiveEntries(a, entries); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "tinker-image-import-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if source.Kind == "registry" {
		if a.oci {
			if err := a.extractOCI(ctx, dir); err != nil {
				return err
			}
			root, err := layout.FromPath(dir)
			if err != nil {
				return importError(err)
			}
			index, err := root.ImageIndex()
			if err != nil {
				return importError(err)
			}
			return s.uploadArchiveEntries(ctx, taskID, source, entries, func(entry ImageImportEntry, tag name.Tag, options []remote.Option) (string, error) {
				descriptor := a.index.Manifests[entry.Image]
				if descriptor.MediaType.IsIndex() {
					child, err := index.ImageIndex(descriptor.Digest)
					if err != nil {
						return "", err
					}
					return pushImportedIndex(tag, child, options)
				}
				image, err := index.Image(descriptor.Digest)
				if err != nil {
					return "", err
				}
				return pushImportedImage(tag, image, options)
			})
		}
		// 重写后的 Docker tar 给每个镜像分配确认后的引用，避免原 tar 的同名引用歧义。
	}
	filename := filepath.Join(dir, "images.tar")
	if err := a.writeRenamedTar(ctx, filename, entries); err != nil {
		return err
	}
	if source.Kind == "registry" {
		return s.uploadArchiveEntries(ctx, taskID, source, entries, func(entry ImageImportEntry, tag name.Tag, options []remote.Option) (string, error) {
			archiveTag, err := name.NewTag(entry.Target)
			if err != nil {
				return "", err
			}
			image, err := tarball.ImageFromPath(filename, &archiveTag)
			if err != nil {
				return "", err
			}
			return pushImportedImage(tag, image, options)
		})
	}
	// 将本应用的检查和写入串行化，防止两个导入任务同时抢占相同目标引用。
	releaseMutation, err := s.acquireImageImportMutation(ctx)
	if err != nil {
		return err
	}
	defer releaseMutation()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.checkImportTargets(ctx, source, cliPath, entries); err != nil {
		return err
	}
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	s.updateTask(taskID, func(task *imageTaskState) {
		task.Stage, task.Total, task.TotalEstimated = "loading", info.Size(), false
	})
	return s.streamDockerLoad(ctx, source, cliPath, &progressReader{reader: file, onRead: s.importProgress(taskID)})
}

func (a *imageArchive) renamedMetadata(entries []ImageImportEntry) (string, []byte, error) {
	if a.oci {
		index := a.index
		index.Manifests = append([]v1.Descriptor(nil), a.index.Manifests...)
		for _, entry := range entries {
			descriptor := &index.Manifests[entry.Image]
			annotations := map[string]string{}
			for key, value := range descriptor.Annotations {
				annotations[key] = value
			}
			annotations["org.opencontainers.image.ref.name"] = entry.Target
			// containerd 的导出包也会携带该引用，必须同步更新。
			if _, exists := annotations["io.containerd.image.name"]; exists {
				annotations["io.containerd.image.name"] = entry.Target
			}
			descriptor.Annotations = annotations
		}
		data, err := json.Marshal(index)
		return "index.json", data, err
	}
	data, err := a.readMetadata("manifest.json")
	if err != nil {
		return "", nil, err
	}
	var manifest []map[string]json.RawMessage
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", nil, err
	}
	refs := map[int][]string{}
	for _, entry := range entries {
		refs[entry.Image] = append(refs[entry.Image], entry.Target)
	}
	for i := range manifest {
		manifest[i]["RepoTags"], err = json.Marshal(refs[i])
		if err != nil {
			return "", nil, err
		}
	}
	data, err = json.Marshal(manifest)
	return "manifest.json", data, err
}

type imageContextReader struct {
	ctx context.Context
	io.Reader
}

func (r imageContextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(buffer)
}

func (a *imageArchive) writeRenamedTar(ctx context.Context, filename string, entries []ImageImportEntry) (retErr error) {
	metadataName, metadata, err := a.renamedMetadata(entries)
	if err != nil {
		return err
	}
	output, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { retErr = errors.Join(retErr, output.Close()) }()
	writer := tar.NewWriter(output)
	defer func() { retErr = errors.Join(retErr, writer.Close()) }()
	keys := make([]string, 0, len(a.members))
	for key := range a.members {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return err
		}
		// OCI 是权威入口；移除兼容 manifest，防止 Docker 再按旧引用加载。
		if key == "repositories" || (a.oci && key == "manifest.json") {
			continue
		}
		member := a.members[key]
		var reader io.Reader = io.NewSectionReader(a.file, member.offset, member.size)
		if key == metadataName {
			member.size, reader = int64(len(metadata)), strings.NewReader(string(metadata))
		}
		if err := writer.WriteHeader(&tar.Header{Name: key, Mode: 0o600, Size: member.size, Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		if _, err := io.Copy(writer, imageContextReader{ctx, reader}); err != nil {
			return err
		}
	}
	return nil
}

func (a *imageArchive) extractOCI(ctx context.Context, dir string) error {
	for member, entry := range a.members {
		if member != "oci-layout" && member != "index.json" && !strings.HasPrefix(member, "blobs/sha256/") {
			continue
		}
		filename := filepath.Join(dir, filepath.FromSlash(member))
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			return err
		}
		file, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(io.MultiWriter(file, hash), imageContextReader{ctx, io.NewSectionReader(a.file, entry.offset, entry.size)})
		if err := errors.Join(copyErr, file.Close()); err != nil {
			return err
		}
		if strings.HasPrefix(member, "blobs/") && hex.EncodeToString(hash.Sum(nil)) != path.Base(member) {
			return userErrorParams("errors.imageExport.importDigestMismatch", map[string]any{"path": member})
		}
	}
	return nil
}

func (s *ImageService) uploadArchiveEntries(ctx context.Context, taskID string, source ImageSource, entries []ImageImportEntry, write func(ImageImportEntry, name.Tag, []remote.Option) (string, error)) error {
	release, err := s.registryPermit(ctx)
	if err != nil {
		return err
	}
	defer release()
	releaseMutation, err := s.acquireImageImportMutation(ctx)
	if err != nil {
		return err
	}
	defer releaseMutation()
	s.taskMu.Lock()
	published := map[string]string{}
	if task := s.tasks[taskID]; task != nil {
		published = cloneImportPublished(task.importPublished)
	}
	s.taskMu.Unlock()
	if err := s.checkImportTargets(ctx, source, "", entries, published); err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		tag, err := importTarget(source, entry.Target)
		if err != nil {
			return err
		}
		if expected := published[tag.Name()]; expected != "" {
			descriptor, err := remote.Head(tag, s.registryOptions(ctx, source)...)
			if err == nil && descriptor.Digest.String() == expected {
				continue
			}
		}
		writtenDigest := ""
		err = s.withRegistryTransferProgress(ctx, taskID, source, func(options []remote.Option) error {
			var writeErr error
			writtenDigest, writeErr = write(entry, tag, options)
			return writeErr
		})
		if err != nil {
			return userErrorCause("errors.imageExport.registryTransferFailed", redactRegistryError(err, source))
		}
		s.updateTask(taskID, func(task *imageTaskState) {
			if task.importPublished == nil {
				task.importPublished = map[string]string{}
			}
			task.importPublished[tag.Name()] = writtenDigest
		})
	}
	return nil
}

// 完成消费后再提交任务终态；解析错误也能停止消费者，不依赖库关闭通道。
func (s *ImageService) withRegistryTransferProgress(ctx context.Context, taskID string, source ImageSource, write func([]remote.Option) error) error {
	s.taskMu.Lock()
	completed := int64(0)
	if task := s.tasks[taskID]; task != nil {
		completed = task.Bytes
	}
	s.taskMu.Unlock()
	updates := make(chan v1.Update, 16)
	done := make(chan struct{})
	stop := make(chan struct{})
	go func() {
		defer close(done)
		last := time.Time{}
		for {
			var update v1.Update
			select {
			case value, ok := <-updates:
				if !ok {
					return
				}
				update = value
			case <-stop:
				return
			}
			if update.Error != nil {
				continue
			}
			if time.Since(last) < 100*time.Millisecond && update.Complete != update.Total {
				continue
			}
			last = time.Now()
			s.updateTask(taskID, func(task *imageTaskState) {
				task.Stage, task.Bytes, task.Completed, task.Total, task.TotalEstimated = "pushing", completed+update.Complete, completed+update.Complete, completed+update.Total, true
			})
		}
	}()
	err := write(append(s.registryTransferOptions(ctx, source), remote.WithProgress(updates)))
	close(stop)
	<-done
	return err
}

func cloneImportPublished(published map[string]string) map[string]string {
	result := make(map[string]string, len(published))
	for reference, digest := range published {
		result[reference] = digest
	}
	return result
}

func pushImportedImage(tag name.Tag, image v1.Image, options []remote.Option) (string, error) {
	digest, err := image.Digest()
	if err != nil {
		return "", err
	}
	return digest.String(), remote.Write(tag, image, options...)
}
func pushImportedIndex(tag name.Tag, index v1.ImageIndex, options []remote.Option) (string, error) {
	digest, err := index.Digest()
	if err != nil {
		return "", err
	}
	return digest.String(), remote.WriteIndex(tag, index, options...)
}
