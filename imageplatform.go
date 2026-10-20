package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

// uname、Docker 和 OCI 使用的常见 CPU 名称统一为 OCI 架构名。
func normalizeImageArchitecture(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "x86_64", "x86-64", "x64":
		return "amd64"
	case "aarch64":
		return "arm64"
	case "i386", "i486", "i586", "i686", "x86":
		return "386"
	case "armv6l", "armv7l", "armv8l":
		return "arm"
	case "", "unknown":
		return ""
	default:
		for _, character := range value {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' && character != '-' {
				return ""
			}
		}
		return value
	}
}

func imageConfigPlatform(config *v1.ConfigFile) []RegistryPlatform {
	if config == nil {
		return nil
	}
	architecture := normalizeImageArchitecture(config.Architecture)
	if architecture == "" {
		return nil
	}
	return []RegistryPlatform{{Architecture: architecture, OS: config.OS, Variant: config.Variant}}
}

// 镜像索引必须遍历全部平台，不能使用 descriptor.Image() 选出的默认平台。
// 已声明平台的叶子直接复用描述符；只为缺少平台的叶子读取 config。
func registryImagePlatforms(ctx context.Context, descriptor *remote.Descriptor) ([]RegistryPlatform, error) {
	if !descriptor.MediaType.IsIndex() {
		image, err := descriptor.Image()
		if err != nil {
			return nil, err
		}
		config, err := image.ConfigFile()
		if err != nil {
			return nil, err
		}
		return imageConfigPlatform(config), nil
	}
	index, err := descriptor.ImageIndex()
	if err != nil {
		return nil, err
	}
	platforms := map[RegistryPlatform]bool{}
	if err := collectRegistryPlatforms(ctx, index, platforms, map[v1.Hash]bool{}); err != nil {
		return nil, err
	}
	result := make([]RegistryPlatform, 0, len(platforms))
	for platform := range platforms {
		result = append(result, platform)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Architecture != result[j].Architecture {
			return result[i].Architecture < result[j].Architecture
		}
		if result[i].OS != result[j].OS {
			return result[i].OS < result[j].OS
		}
		return result[i].Variant < result[j].Variant
	})
	return result, nil
}

func collectRegistryPlatforms(ctx context.Context, index v1.ImageIndex, platforms map[RegistryPlatform]bool, visited map[v1.Hash]bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	digest, err := index.Digest()
	if err != nil {
		return err
	}
	if visited[digest] {
		return userError("errors.image.registryPlatformCycle")
	}
	visited[digest] = true
	defer delete(visited, digest)
	manifest, err := index.IndexManifest()
	if err != nil {
		return err
	}
	for _, descriptor := range manifest.Manifests {
		if err := ctx.Err(); err != nil {
			return err
		}
		if descriptor.MediaType.IsIndex() {
			child, err := index.ImageIndex(descriptor.Digest)
			if err != nil {
				return err
			}
			if err := collectRegistryPlatforms(ctx, child, platforms, visited); err != nil {
				return err
			}
			continue
		}
		if descriptor.Annotations["vnd.docker.reference.type"] == "attestation-manifest" {
			continue
		}
		if descriptor.Platform != nil {
			platform := descriptor.Platform
			if platform.OS == "unknown" || platform.Architecture == "unknown" {
				continue
			}
			architecture := normalizeImageArchitecture(platform.Architecture)
			if architecture != "" && platform.OS != "" {
				platforms[RegistryPlatform{Architecture: architecture, OS: platform.OS, Variant: platform.Variant}] = true
				continue
			}
		}
		image, err := index.Image(descriptor.Digest)
		if err != nil {
			return err
		}
		config, err := image.ConfigFile()
		if err != nil {
			return err
		}
		for _, platform := range imageConfigPlatform(config) {
			platforms[platform] = true
		}
	}
	return nil
}

// CLI 来源读取原始索引，避免 manifest inspect 为每个平台请求 manifest 和 config。
// CLI 在来源主机上运行，继续使用该主机的认证和网络配置。
func (s *ImageService) resolveCLIImagePullPlatforms(ctx context.Context, source ImageSource, cliPath, image string, reference name.Reference) ([]string, error) {
	values := map[string]bool{}
	visited := map[string]bool{}
	completed := map[string]bool{}
	var collect func(string) error
	collectLeaf := func(ref string) error {
		if completed[ref] {
			return nil
		}
		data, err := s.runDockerSnapshotContext(ctx, source, cliPath, []string{"manifest", "inspect", "--verbose", ref})
		if err != nil {
			return err
		}
		platforms, err := cliManifestPlatforms(data)
		if err != nil {
			return err
		}
		for _, platform := range platforms {
			values[platform] = true
		}
		completed[ref] = true
		return nil
	}
	collect = func(ref string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if visited[ref] {
			return userError("errors.image.registryPlatformCycle")
		}
		if completed[ref] {
			return nil
		}
		visited[ref] = true
		defer delete(visited, ref)
		data, err := s.runDockerSnapshotContext(ctx, source, cliPath, []string{"buildx", "imagetools", "inspect", "--raw", ref})
		if err != nil {
			return err
		}
		var manifest struct {
			MediaType types.MediaType `json:"mediaType"`
			Manifests []v1.Descriptor `json:"manifests"`
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			return err
		}
		if !manifest.MediaType.IsIndex() && manifest.Manifests == nil {
			return collectLeaf(ref)
		}
		for _, descriptor := range manifest.Manifests {
			if err := ctx.Err(); err != nil {
				return err
			}
			if descriptor.Annotations["vnd.docker.reference.type"] == "attestation-manifest" {
				continue
			}
			child := reference.Context().Digest(descriptor.Digest.String()).Name()
			if descriptor.MediaType.IsIndex() {
				if err := collect(child); err != nil {
					return err
				}
				continue
			}
			if descriptor.Platform != nil {
				platform := descriptor.Platform
				architecture := normalizeImageArchitecture(platform.Architecture)
				// unknown/unknown 是证明等非运行内容，不能当成缺失信息补查。
				if platform.OS == "unknown" || platform.Architecture == "unknown" {
					continue
				}
				if platform.OS != "" && architecture != "" {
					values[platform.OS+"/"+architecture+platformVariant(platform.Variant)] = true
					continue
				}
			}
			if err := collectLeaf(child); err != nil {
				return err
			}
		}
		completed[ref] = true
		return nil
	}
	if err := collect(image); err != nil {
		return nil, err
	}
	return sortedPullPlatforms(values)
}
