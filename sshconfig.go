package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxSSHConfigFileSize = 1 << 20
	maxSSHConfigFiles    = 128
	maxSSHConfigDepth    = 8
)

// SSHConfigHost 是 ~/.ssh/config 中可以直接交给系统 ssh 的 Host 别名。
type SSHConfigHost struct {
	Alias string `json:"alias"`
}

func readSSHPrivateKeyFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 128<<10 {
		return "", userError("errors.image.privateKeyFileInvalid")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (s *ImageService) GetSSHConfigHosts() ([]SSHConfigHost, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return []SSHConfigHost{}, userErrorCause("errors.image.homeDirFailed", err)
	}
	return parseSSHConfigFileTree(filepath.Join(home, ".ssh", "config"))
}

type sshConfigParseState struct {
	home         string
	hosts        []SSHConfigHost
	seenHosts    map[string]bool
	seenFiles    map[string]bool
	fileCount    int
	totalBytes   int64
	currentHosts []string
}

func parseSSHConfigFileTree(path string) ([]SSHConfigHost, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return []SSHConfigHost{}, userErrorCause("errors.image.homeDirFailed", err)
	}
	state := &sshConfigParseState{home: home, hosts: []SSHConfigHost{}, seenHosts: map[string]bool{}, seenFiles: map[string]bool{}}
	if err := state.parseFile(path, 0); err != nil {
		return []SSHConfigHost{}, err
	}
	return state.hosts, nil
}

func parseSSHConfigHosts(reader io.Reader) []SSHConfigHost {
	data, err := io.ReadAll(io.LimitReader(reader, maxSSHConfigFileSize))
	if err != nil {
		return []SSHConfigHost{}
	}
	return parseSSHConfigHostData(data)
}

func parseSSHConfigHostData(data []byte) []SSHConfigHost {
	result := make([]SSHConfigHost, 0)
	seen := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		key, values := parseSSHConfigDirective(line)
		if key != "host" {
			continue
		}
		for _, alias := range values {
			if !isConcreteSSHHostAlias(alias) || seen[alias] {
				continue
			}
			seen[alias] = true
			result = append(result, SSHConfigHost{Alias: alias})
		}
	}
	return result
}

func parseSSHConfigDirective(line string) (string, []string) {
	if index := strings.IndexByte(line, '#'); index >= 0 {
		line = line[:index]
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return "", nil
	}
	key := strings.ToLower(fields[0])
	if strings.HasPrefix(key, "host=") {
		fields = append([]string{"host", fields[0][len("host="):]}, fields[1:]...)
		key = "host"
	}
	if strings.HasPrefix(key, "include=") {
		fields = append([]string{"include", fields[0][len("include="):]}, fields[1:]...)
		key = "include"
	}
	if len(fields) < 2 {
		return key, nil
	}
	return key, fields[1:]
}

func isConcreteSSHHostAlias(alias string) bool {
	return !strings.ContainsAny(alias, "*?![") && validSSHHost(alias)
}

func (s *sshConfigParseState) parseFile(path string, depth int) error {
	if depth > maxSSHConfigDepth {
		return userErrorParams("errors.image.sshConfigIncludeDepthExceeded", map[string]any{"max": maxSSHConfigDepth})
	}
	canonicalPath, err := canonicalSSHConfigPath(path)
	if err != nil {
		return userErrorParamsCause("errors.image.sshConfigParseFailed", map[string]any{"path": path}, err)
	}
	if s.seenFiles[canonicalPath] {
		return nil
	}
	if s.fileCount >= maxSSHConfigFiles {
		return userErrorParams("errors.image.sshConfigIncludeFileLimitExceeded", map[string]any{"max": maxSSHConfigFiles})
	}
	info, err := os.Stat(canonicalPath)
	if err != nil {
		return userErrorParamsCause("errors.image.sshConfigReadFailed", map[string]any{"path": canonicalPath}, err)
	}
	if !info.Mode().IsRegular() {
		return userErrorParams("errors.image.sshConfigNotRegular", map[string]any{"path": canonicalPath})
	}
	if info.Size() > maxSSHConfigFileSize {
		return userErrorParams("errors.image.sshConfigTooLarge", map[string]any{"path": canonicalPath})
	}
	file, err := os.Open(canonicalPath)
	if err != nil {
		return userErrorParamsCause("errors.image.sshConfigReadFailed", map[string]any{"path": canonicalPath}, err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSSHConfigFileSize+1))
	if err != nil {
		return userErrorParamsCause("errors.image.sshConfigReadFailed", map[string]any{"path": canonicalPath}, err)
	}
	if len(data) > maxSSHConfigFileSize {
		return userErrorParams("errors.image.sshConfigTooLarge", map[string]any{"path": canonicalPath})
	}
	s.totalBytes += int64(len(data))
	if s.totalBytes > int64(maxSSHConfigFileSize)*maxSSHConfigFiles {
		return userError("errors.image.sshConfigTotalSizeExceeded")
	}
	s.seenFiles[canonicalPath] = true
	s.fileCount++
	for _, line := range strings.Split(string(data), "\n") {
		key, values := parseSSHConfigDirective(line)
		switch key {
		case "host":
			s.currentHosts = nil
			for _, alias := range values {
				if !isConcreteSSHHostAlias(alias) {
					continue
				}
				s.currentHosts = append(s.currentHosts, alias)
				if !s.seenHosts[alias] {
					s.seenHosts[alias] = true
					s.hosts = append(s.hosts, SSHConfigHost{Alias: alias})
				}
			}
		case "include":
			for _, pattern := range values {
				matches, err := s.expandInclude(pattern, filepath.Dir(canonicalPath))
				if err != nil {
					return err
				}
				for _, match := range matches {
					if err := s.parseFile(match, depth+1); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

func canonicalSSHConfigPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}
	return filepath.Clean(abs), nil
}

func (s *sshConfigParseState) expandInclude(pattern string, baseDir string) ([]string, error) {
	if pattern == "" || len(pattern) > maxSSHConfigFileSize {
		return nil, userError("errors.image.sshIncludePathInvalid")
	}
	hosts := s.currentHosts
	if len(hosts) == 0 && strings.Contains(pattern, "%h") {
		hosts = []string{"*"}
	}
	if len(hosts) == 0 {
		hosts = []string{""}
	}
	matches := make([]string, 0)
	seen := make(map[string]bool)
	for _, host := range hosts {
		includePath := strings.ReplaceAll(pattern, "%d", s.home)
		includePath = strings.ReplaceAll(includePath, "%h", host)
		if includePath == "~" {
			includePath = s.home
		} else if strings.HasPrefix(includePath, "~/") {
			includePath = filepath.Join(s.home, includePath[2:])
		}
		if !filepath.IsAbs(includePath) {
			includePath = filepath.Join(baseDir, includePath)
		}
		if len(includePath) > maxSSHConfigFileSize {
			return nil, userError("errors.image.sshIncludePathTooLong")
		}
		globMatches, err := filepath.Glob(includePath)
		if err != nil {
			return nil, userErrorParamsCause("errors.image.sshIncludeParseFailed", map[string]any{"path": pattern}, err)
		}
		for _, match := range globMatches {
			canonical, err := canonicalSSHConfigPath(match)
			if err != nil {
				return nil, userErrorParamsCause("errors.image.sshIncludeFileParseFailed", map[string]any{"path": match}, err)
			}
			if !seen[canonical] {
				seen[canonical] = true
				matches = append(matches, match)
			}
		}
	}
	return matches, nil
}
