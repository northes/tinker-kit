package main

import "strings"

func defaultNetworkTestSources() []NetworkTestSource {
	return []NetworkTestSource{{ID: "local", Name: "本机", Kind: "local"}}
}

func normalizeNetworkTestSources(sources []NetworkTestSource, profileNames map[string]string) []NetworkTestSource {
	result := make([]NetworkTestSource, 0, len(sources)+1)
	seen := make(map[string]struct{}, len(sources)+1)
	hasLocal := false
	for _, source := range sources {
		source.ID = strings.TrimSpace(source.ID)
		source.Name = strings.TrimSpace(source.Name)
		source.Kind = strings.ToLower(strings.TrimSpace(source.Kind))
		source.SSHProfileID = strings.TrimSpace(source.SSHProfileID)
		if source.ID == "local" || source.Kind == "local" {
			if !hasLocal {
				result = append(result, defaultNetworkTestSources()[0])
				seen["local"] = struct{}{}
				hasLocal = true
			}
			continue
		}
		if source.ID == "" || source.Kind != "ssh" || source.SSHProfileID == "" || !validConfigValue(source.ID, 128) {
			continue
		}
		if _, ok := seen[source.ID]; ok {
			continue
		}
		if source.Name == "" || source.Name == source.SSHProfileID {
			source.Name = profileNames[source.SSHProfileID]
		}
		if !validTextValue(source.Name, 128) {
			continue
		}
		seen[source.ID] = struct{}{}
		result = append(result, NetworkTestSource{
			ID: source.ID, Name: source.Name, Kind: "ssh", SSHProfileID: source.SSHProfileID,
		})
	}
	if !hasLocal {
		result = append([]NetworkTestSource{defaultNetworkTestSources()[0]}, result...)
	}
	return result
}

func networkTestSourceExists(sources []NetworkTestSource, id string) bool {
	for _, source := range sources {
		if source.ID == id {
			return true
		}
	}
	return false
}

func idsOfNetworkTestSources(sources []NetworkTestSource) []string {
	ids := make([]string, len(sources))
	for index, source := range sources {
		ids[index] = source.ID
	}
	return ids
}

// GetNetworkTestSources 返回网络测试工具自己的执行来源列表。
func (s *ConfigService) GetNetworkTestSources() []NetworkTestSource {
	if s == nil {
		return defaultNetworkTestSources()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]NetworkTestSource(nil), s.cfg.NetworkTestSources...)
}

// SaveNetworkTestSources 只更新网络测试工具的来源，并校验每个 SSH 来源引用的全局配置。
func (s *ConfigService) SaveNetworkTestSources(sources []NetworkTestSource) error {
	if s == nil {
		return userError("errors.common.configNotInitialized")
	}
	return s.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		profiles := make(map[string]struct{}, len(cfg.SSHProfiles))
		profileNames := make(map[string]string, len(cfg.SSHProfiles))
		for _, profile := range cfg.SSHProfiles {
			profiles[profile.ID] = struct{}{}
			profileNames[profile.ID] = profile.Name
		}

		normalized := make([]NetworkTestSource, 0, len(sources)+1)
		seen := make(map[string]struct{}, len(sources)+1)
		hasLocal := false
		for index, source := range sources {
			if strings.TrimSpace(source.ID) == "local" || strings.EqualFold(strings.TrimSpace(source.Kind), "local") {
				if !hasLocal {
					normalized = append(normalized, defaultNetworkTestSources()[0])
					seen["local"] = struct{}{}
					hasLocal = true
				}
				continue
			}
			id := strings.TrimSpace(source.ID)
			name := strings.TrimSpace(source.Name)
			profileID := strings.TrimSpace(source.SSHProfileID)
			if !validConfigValue(id, 128) || !validTextValue(name, 128) || !validConfigValue(profileID, 128) {
				return userErrorParams("errors.networkTest.sourceInvalid", map[string]any{"index": index + 1})
			}
			if _, exists := seen[id]; exists {
				return userErrorParams("errors.networkTest.sourceDuplicate", map[string]any{"index": index + 1})
			}
			if _, exists := profiles[profileID]; !exists {
				return userErrorParams("errors.networkTest.sourceProfileNotFound", map[string]any{"index": index + 1})
			}
			seen[id] = struct{}{}
			normalized = append(normalized, NetworkTestSource{ID: id, Name: name, Kind: "ssh", SSHProfileID: profileID})
		}
		if !hasLocal {
			normalized = append([]NetworkTestSource{defaultNetworkTestSources()[0]}, normalized...)
		}

		if !networkTestSourceExists(normalized, cfg.NetworkTestSettings.SourceID) {
			cfg.NetworkTestSettings.SourceID = "local"
		}
		cfg.NetworkTestSources = normalizeNetworkTestSources(normalized, profileNames)
		return nil
	})
}
