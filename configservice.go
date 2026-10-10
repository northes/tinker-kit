package main

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type Config struct {
	TrayMatchEnabled        bool                  `json:"trayMatchEnabled"`
	TrayMatchTools          []string              `json:"trayMatchTools"`
	AutoOverwrite           bool                  `json:"autoOverwrite"`
	AutoCheckUpdates        bool                  `json:"autoCheckUpdates"`
	TaskConcurrency         int                   `json:"taskConcurrency"`
	TaskChunkConcurrency    int                   `json:"taskChunkConcurrency"`
	TaskNotificationMode    string                `json:"taskNotificationMode"`
	Language                string                `json:"language"`
	SidebarMode             string                `json:"sidebarMode"`
	SidebarTools            []SidebarToolConfig   `json:"sidebarTools"`
	ThemeMode               string                `json:"themeMode"`
	LightTheme              string                `json:"lightTheme"`
	DarkTheme               string                `json:"darkTheme"`
	DiffClipboardTargetMode string                `json:"diffClipboardTargetMode"`
	CodeEditorFontSize      int                   `json:"codeEditorFontSize"`
	TimeResultOrder         []string              `json:"timeResultOrder"`
	HiddenTimeResults       []string              `json:"hiddenTimeResults"`
	TimeWeekStart           string                `json:"timeWeekStart"`
	NtpServers              []string              `json:"ntpServers"`
	NetworkTestSettings     NetworkTestSettings   `json:"networkTestSettings"`
	JsonAutoFormatOnFill    bool                  `json:"jsonAutoFormatOnFill"`
	TextAlwaysShowSearch    bool                  `json:"textAlwaysShowSearch"`
	TextGeneratorSources    []TextGeneratorSource `json:"textGeneratorSources"`
	DockerCLIPath           string                `json:"dockerCLIPath"`
	ImageSources            []ImageSource         `json:"imageSources"`
	SSHProfiles             []SSHProfile          `json:"sshProfiles"`
	FileSources             []FileSource          `json:"fileSources"`
	ServiceTargets          []ServiceTarget       `json:"serviceTargets"`
	PortSources             []PortSource          `json:"portSources"`
	PortForwards            []PortForwardConfig   `json:"portForwards"`
}

type SidebarToolConfig struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

// NetworkTestSettings 保存网络测试工具当前使用的超时和高级选项。
type NetworkTestSettings struct {
	Payload        string `json:"payload"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	SkipTLSVerify  bool   `json:"skipTLSVerify"`
	MaxRedirects   int    `json:"maxRedirects"`
	ProxyType      string `json:"proxyType"`
	ProxyAddress   string `json:"proxyAddress"`
	DNSMode        string `json:"dnsMode"`
	DNSAddress     string `json:"dnsAddress"`
	InterfaceName  string `json:"interfaceName"`
}

func defaultNetworkTestSettings() NetworkTestSettings {
	return NetworkTestSettings{
		Payload:        "ping",
		TimeoutSeconds: 30,
		MaxRedirects:   10,
		DNSMode:        "system",
	}
}

var defaultSidebarToolIDs = []string{"json", "time", "text", "base64", "jwt", "url", "qrcode", "image", "diff", "text-generator", "image-manager", "ssh-files", "service-manager", "ports", "network-test"}

type TextGeneratorSource struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Mode    string `json:"mode"`
}

type ImageSource struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Kind              string `json:"kind"`
	SSHProfileID      string `json:"sshProfileID"`
	SSHHost           string `json:"-"`
	SSHPort           int    `json:"-"`
	SSHUsername       string `json:"-"`
	SSHPassword       string `json:"-"`
	SSHPrivateKey     string `json:"-"`
	SSHPrivateKeyPath string `json:"-"`
	SSHKeyPassphrase  string `json:"-"`
	RegistryURL       string `json:"registryURL"`
	RegistryUsername  string `json:"registryUsername"`
	RegistryPassword  string `json:"registryPassword"`
}

// SSHProfile 是应用全局复用的 SSH 连接配置。
type SSHProfile struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Origin          string `json:"origin"`
	OriginAlias     string `json:"originAlias"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Username        string `json:"username"`
	Password        string `json:"password"`
	PrivateKey      string `json:"privateKey"`
	PrivateKeyPath  string `json:"privateKeyPath"`
	KeyPassphrase   string `json:"keyPassphrase"`
	OriginUpdatedAt string `json:"originUpdatedAt"`
}

// SSHConnection 是文件工具复用的 SSH 连接配置。文件源只引用 ID，避免重复保存凭据。
type SSHConnection struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Mode           string `json:"mode"`
	Alias          string `json:"alias"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	PrivateKey     string `json:"privateKey"`
	PrivateKeyPath string `json:"privateKeyPath"`
	KeyPassphrase  string `json:"keyPassphrase"`
}

// FileSource 是 SSH 文件管理中的可浏览源；同一连接可被多个源引用。
type FileSource struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	SSHProfileID  string   `json:"sshProfileID"`
	DefaultPath   string   `json:"defaultPath"`
	FavoritePaths []string `json:"favoritePaths,omitempty"`
}

const localImageSourceID = "local"

func defaultImageSources() []ImageSource {
	return []ImageSource{{ID: localImageSourceID, Name: "本机", Kind: "local"}}
}

func defaultServiceTargets() []ServiceTarget {
	return []ServiceTarget{{ID: "local", Name: "本机", Kind: "local"}}
}

func defaultPortSources() []PortSource {
	return []PortSource{{ID: "local", Name: "本机", Kind: "local"}}
}

func defaultSidebarTools() []SidebarToolConfig {
	tools := make([]SidebarToolConfig, 0, len(defaultSidebarToolIDs))
	for _, id := range defaultSidebarToolIDs {
		tools = append(tools, SidebarToolConfig{ID: id, Enabled: true})
	}
	return tools
}

type HistoryItem struct {
	ID        int64  `json:"id"`
	Tool      string `json:"tool"`
	Action    string `json:"action"`
	Detail    string `json:"detail"`
	At        string `json:"at"`
	Mode      string `json:"mode"`
	MediaType string `json:"mediaType"`
	Name      string `json:"name"`
	Bytes     int64  `json:"bytes"`
}
type HistoryContent struct {
	Input  string `json:"input"`
	Output string `json:"output"`
}
type HistoryEntry struct {
	Tool      string `json:"tool"`
	Action    string `json:"action"`
	Detail    string `json:"detail"`
	Mode      string `json:"mode"`
	MediaType string `json:"mediaType"`
	Name      string `json:"name"`
	Bytes     int64  `json:"bytes"`
	Input     string `json:"input"`
	Output    string `json:"output"`
}
type historyStored struct {
	Item HistoryItem `json:"item"`
	File string      `json:"file"`
}

func defaultConfig() Config {
	return Config{TrayMatchEnabled: true, TrayMatchTools: []string{"json", "time", "text", "base64", "diff", "jwt", "url"}, AutoOverwrite: true, AutoCheckUpdates: true, TaskConcurrency: 4, TaskChunkConcurrency: 4, TaskNotificationMode: "unfocused", Language: "zh-CN", SidebarMode: "full", SidebarTools: defaultSidebarTools(), ThemeMode: "dark", LightTheme: "default-light", DarkTheme: "default-dark", DiffClipboardTargetMode: "alternate", CodeEditorFontSize: 16, TimeResultOrder: []string{"local", "dateTime", "dateOnly", "timeOnly", "zonedIso8601", "rfc3339", "utc", "compact", "underscore", "unixSeconds", "unixMilliseconds", "unixNanoseconds"}, TimeWeekStart: "monday", NtpServers: defaultNtpServers(), NetworkTestSettings: defaultNetworkTestSettings(), JsonAutoFormatOnFill: true, ImageSources: defaultImageSources(), SSHProfiles: []SSHProfile{}, FileSources: []FileSource{}, ServiceTargets: defaultServiceTargets(), PortSources: defaultPortSources(), PortForwards: []PortForwardConfig{}}
}

func normalizeThemeID(theme string, defaultID string) string {
	if theme != defaultID {
		return defaultID
	}
	return theme
}

func stringSlicesEqual(a []string, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func imageSourcesEqual(a []ImageSource, b []ImageSource) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func validConfigValue(value string, maxLength int) bool {
	if value == "" || len(value) > maxLength {
		return false
	}
	for _, r := range value {
		if r == '\x00' || r == '\n' || r == '\r' || r == '\t' || r == ' ' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validTextValue(value string, maxLength int) bool {
	if value == "" || len(value) > maxLength {
		return false
	}
	for _, r := range value {
		if r == '\x00' || r == '\n' || r == '\r' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validSecretValue(value string, maxLength int) bool {
	if len(value) > maxLength {
		return false
	}
	return !strings.ContainsRune(value, '\x00')
}

func normalizeRegistryURL(value string) (string, bool) {
	value = strings.TrimSpace(value)
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	if u.Path != "" && u.Path != "/" {
		return "", false
	}
	u.Path = ""
	u.RawPath = ""
	return "https://" + strings.ToLower(u.Host), true
}

func validImageSourceID(value string) bool {
	if prefix, suffix, ok := strings.Cut(value, ":"); ok {
		if suffix == "" || (prefix != "ssh" && prefix != "registry") {
			return false
		}
		if prefix == "ssh" {
			return validSSHHost(suffix)
		}
		return validSourceSuffix(suffix)
	}
	if !validConfigValue(value, 64) {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return false
	}
	return true
}

func validSourceSuffix(value string) bool {
	if !validConfigValue(value, 60) {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("-_.", r) {
			continue
		}
		return false
	}
	return true
}

// normalizeImageSource 规范化单个镜像来源并判断其合法性，是来源校验/规范化的唯一权威，
// 供批量 normalizeImageSources 与 Save 的提交验证共用。seen 用于跨来源去重（成功时写入），
// hasLocal 用于本地来源追踪（Save 校验时传 nil）。无法合法化的来源返回非 nil error。
func normalizeImageSource(
	source ImageSource,
	seen map[string]bool,
	hasLocal *bool,
	sshProfileNames map[string]string,
) (ImageSource, error) {
	source.ID = strings.TrimSpace(source.ID)
	source.Name = strings.TrimSpace(source.Name)
	source.Kind = strings.TrimSpace(strings.ToLower(source.Kind))
	source.SSHProfileID = strings.TrimSpace(source.SSHProfileID)
	source.SSHHost = strings.TrimSpace(source.SSHHost)
	source.SSHUsername = strings.TrimSpace(source.SSHUsername)
	source.RegistryURL = strings.TrimSpace(source.RegistryURL)
	source.RegistryUsername = strings.TrimSpace(source.RegistryUsername)
	if source.Kind == "" && (source.ID == "" || source.ID == localImageSourceID) {
		source.Kind = "local"
	}
	switch source.Kind {
	case "local":
		if source.ID != localImageSourceID {
			return ImageSource{}, userError("errors.config.localImageSourceIDInvalid")
		}
		if seen[source.ID] {
			return ImageSource{}, userErrorParams("errors.config.imageSourceIDDuplicate", map[string]any{"id": source.ID})
		}
		if source.Name == "" {
			source.Name = "本机"
		}
		if !validTextValue(source.Name, 128) {
			return ImageSource{}, userError("errors.config.localImageSourceNameInvalid")
		}
		source.SSHHost = ""
		source.SSHPort = 0
		source.SSHUsername = ""
		source.SSHPassword = ""
		source.SSHPrivateKey = ""
		source.SSHPrivateKeyPath = ""
		source.SSHKeyPassphrase = ""
		source.SSHProfileID = ""
		source.RegistryURL = ""
		source.RegistryUsername = ""
		source.RegistryPassword = ""
		if hasLocal != nil {
			*hasLocal = true
		}
	case "ssh":
		if source.ID == localImageSourceID {
			return ImageSource{}, userError("errors.config.sshImageSourceIDForbiddenLocal")
		}
		if !validImageSourceID(source.ID) {
			return ImageSource{}, userError("errors.config.sshImageSourceIDInvalid")
		}
		if seen[source.ID] {
			return ImageSource{}, userErrorParams("errors.config.imageSourceIDDuplicate", map[string]any{"id": source.ID})
		}
		if source.SSHProfileID != "" {
			if !validConfigValue(source.SSHProfileID, 128) {
				return ImageSource{}, userError("errors.config.sshProfileIDInvalid")
			}
			if source.Name == "" {
				if name := sshProfileNames[source.SSHProfileID]; name != "" {
					source.Name = name
				} else {
					source.Name = source.SSHProfileID
				}
			}
			if !validTextValue(source.Name, 128) {
				return ImageSource{}, userError("errors.config.sshImageSourceNameInvalid")
			}
			source.SSHHost = ""
			source.SSHPort = 0
			source.SSHUsername = ""
			source.SSHPassword = ""
			source.SSHPrivateKey = ""
			source.SSHPrivateKeyPath = ""
			source.SSHKeyPassphrase = ""
			source.RegistryURL = ""
			source.RegistryUsername = ""
			source.RegistryPassword = ""
			break
		}
		// SSH 来源必须引用 SSHProfiles；未绑定配置的来源不保留。
		if !validSSHHost(source.SSHHost) {
			return ImageSource{}, userError("errors.config.sshHostInvalid")
		}
		if source.SSHPort < 0 || source.SSHPort > 65535 {
			return ImageSource{}, userError("errors.config.sshPortOutOfRange")
		}
		if source.SSHUsername != "" && (!validConfigValue(source.SSHUsername, 256) || strings.HasPrefix(source.SSHUsername, "-")) {
			return ImageSource{}, userError("errors.config.sshUsernameInvalid")
		}
		if !validSecretValue(source.SSHPassword, 4096) {
			return ImageSource{}, userError("errors.config.sshPasswordInvalid")
		}
		if !validSecretValue(source.SSHPrivateKey, 128<<10) {
			return ImageSource{}, userError("errors.config.sshPrivateKeyInvalid")
		}
		if source.SSHPrivateKeyPath != "" && (!validPathValue(source.SSHPrivateKeyPath, 4096) || strings.HasPrefix(source.SSHPrivateKeyPath, "-")) {
			return ImageSource{}, userError("errors.config.sshPrivateKeyPathInvalid")
		}
		if !validSecretValue(source.SSHKeyPassphrase, 4096) {
			return ImageSource{}, userError("errors.config.sshKeyPassphraseInvalid")
		}
		if source.SSHKeyPassphrase != "" && source.SSHPrivateKey == "" && source.SSHPrivateKeyPath == "" {
			return ImageSource{}, userError("errors.config.sshKeyPassphraseWithoutKey")
		}
		if source.SSHPort == 0 {
			source.SSHPort = 22
		}
		if source.Name == "" {
			source.Name = source.SSHHost
		}
		if !validTextValue(source.Name, 128) {
			return ImageSource{}, userError("errors.config.sshImageSourceNameInvalid")
		}
		source.RegistryURL = ""
		source.RegistryUsername = ""
		source.RegistryPassword = ""
	case "registry":
		if source.ID == localImageSourceID {
			return ImageSource{}, userError("errors.config.registryImageSourceIDForbiddenLocal")
		}
		if !validImageSourceID(source.ID) {
			return ImageSource{}, userError("errors.config.registryImageSourceIDInvalid")
		}
		if seen[source.ID] {
			return ImageSource{}, userErrorParams("errors.config.imageSourceIDDuplicate", map[string]any{"id": source.ID})
		}
		var ok bool
		source.RegistryURL, ok = normalizeRegistryURL(source.RegistryURL)
		if !ok {
			return ImageSource{}, userError("errors.config.registryURLInvalid")
		}
		if !validSecretValue(source.RegistryPassword, 4096) {
			return ImageSource{}, userError("errors.config.registryPasswordInvalid")
		}
		if source.RegistryPassword != "" && source.RegistryUsername == "" {
			return ImageSource{}, userError("errors.config.registryPasswordWithoutUsername")
		}
		if source.RegistryUsername != "" && !validTextValue(source.RegistryUsername, 256) {
			return ImageSource{}, userError("errors.config.registryUsernameInvalid")
		}
		if source.Name == "" {
			source.Name = source.RegistryURL
		}
		if !validTextValue(source.Name, 128) {
			return ImageSource{}, userError("errors.config.registryImageSourceNameInvalid")
		}
		source.SSHHost = ""
		source.SSHPort = 0
		source.SSHUsername = ""
		source.SSHPassword = ""
		source.SSHPrivateKey = ""
		source.SSHPrivateKeyPath = ""
		source.SSHKeyPassphrase = ""
		source.SSHProfileID = ""
	default:
		return ImageSource{}, userErrorParams("errors.config.imageSourceKindUnknown", map[string]any{"kind": source.Kind})
	}
	seen[source.ID] = true
	return source, nil
}

// sshProfileNameMap 建立 SSH 配置 ID 到名称的映射，供镜像来源默认名称使用。
func sshProfileNameMap(profiles []SSHProfile) map[string]string {
	names := make(map[string]string, len(profiles))
	for _, profile := range profiles {
		if name := strings.TrimSpace(profile.Name); name != "" {
			names[profile.ID] = name
		}
	}
	return names
}

func normalizeImageSources(
	sources []ImageSource,
	sshProfileNames map[string]string,
) []ImageSource {
	result := make([]ImageSource, 0, len(sources)+1)
	seen := make(map[string]bool, len(sources)+1)
	hasLocal := false
	for _, source := range sources {
		if normalized, err := normalizeImageSource(source, seen, &hasLocal, sshProfileNames); err == nil {
			result = append(result, normalized)
		}
	}
	if !hasLocal {
		result = append([]ImageSource{{ID: localImageSourceID, Name: "本机", Kind: "local"}}, result...)
	}
	return result
}

// normalizeServiceTargets 保证本机目标始终存在，并清理重复或非法的目标；已失效的
// SSH 引用会被保留，交由界面展示并修复（与镜像/文件来源一致）。
func normalizeServiceTargets(
	targets []ServiceTarget,
	sshProfileNames map[string]string,
) []ServiceTarget {
	result := defaultServiceTargets()
	seen := map[string]bool{"local": true}
	for _, target := range targets {
		target.ID = strings.TrimSpace(target.ID)
		target.Name = strings.TrimSpace(target.Name)
		target.Kind = strings.TrimSpace(strings.ToLower(target.Kind))
		target.SSHProfileID = strings.TrimSpace(target.SSHProfileID)
		if target.Kind == "" && target.ID == "local" {
			target.Kind = "local"
		}
		if target.Kind != "ssh" {
			continue
		}
		if target.SSHProfileID == "" {
			continue
		}
		target.ID = "ssh:" + target.SSHProfileID
		target.Kind = "ssh"
		if seen[target.ID] {
			continue
		}
		seen[target.ID] = true
		if name := sshProfileNames[target.SSHProfileID]; name != "" && target.Name == "" {
			target.Name = name
		}
		if target.Name == "" {
			target.Name = target.SSHProfileID
		}
		result = append(result, target)
	}
	return result
}

// imageSourceIdentifier 返回用于错误提示的来源标识，优先 Name，其次 ID、Kind。
func imageSourceIdentifier(source ImageSource) string {
	if name := strings.TrimSpace(source.Name); name != "" {
		return name
	}
	if id := strings.TrimSpace(source.ID); id != "" {
		return id
	}
	return strings.TrimSpace(source.Kind)
}

// imageSourceValidationError 依据来源标识构造镜像来源校验错误。
// 标识缺失（来源字段全空）时使用不带名称的文案，避免在参数里出现未翻译的占位文本。
func imageSourceValidationError(index int, source ImageSource, cause error) error {
	if identifier := imageSourceIdentifier(source); identifier != "" {
		return userErrorParamsCause("errors.config.imageSourceInvalid", map[string]any{"index": index, "name": identifier}, cause)
	}
	return userErrorParamsCause("errors.config.imageSourceInvalidUnnamed", map[string]any{"index": index}, cause)
}

// validateImageSourcesForSave 严格校验客户端提交的镜像来源；任一来源无法合法规范化
// 即返回错误，并携带来源标识（优先 Name/ID）与序号。与 normalizeImageSources 共用
// normalizeImageSource 同一套校验规则，避免复制。
func validateImageSourcesForSave(sources []ImageSource) error {
	seen := make(map[string]bool, len(sources))
	for i, source := range sources {
		if _, err := normalizeImageSource(source, seen, nil, nil); err != nil {
			return imageSourceValidationError(i+1, source, err)
		}
	}
	return nil
}

// ValidateImageSource 校验并规范化单个镜像来源，但不会写入配置。
// 编辑镜像来源时用它尽早反馈输入错误，最终 Save 仍会校验完整列表。
func (s *ConfigService) ValidateImageSource(source ImageSource) (ImageSource, error) {
	profiles := s.GetSSHProfiles()
	normalized, err := normalizeImageSource(
		source,
		make(map[string]bool, 1),
		nil,
		sshProfileNameMap(profiles),
	)
	if err != nil || normalized.Kind != "ssh" || normalized.SSHProfileID == "" {
		return normalized, err
	}
	for _, profile := range profiles {
		if profile.ID == normalized.SSHProfileID {
			return normalized, nil
		}
	}
	return ImageSource{}, userErrorParams("errors.config.imageSourceSSHProfileNotFound", map[string]any{"name": imageSourceIdentifier(normalized)})
}

func normalizeDockerCLIPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || !validPathValue(path, 4096) || strings.HasPrefix(path, "-") {
		return ""
	}
	return path
}

func normalizeFavoritePaths(paths []string) []string {
	const maxFavoritePaths = 128
	normalized := make([]string, 0, min(len(paths), maxFavoritePaths))
	seen := make(map[string]struct{}, len(paths))
	for _, favoritePath := range paths {
		favoritePath = strings.TrimSpace(favoritePath)
		if favoritePath == "" || !validPathValue(favoritePath, 4096) {
			continue
		}
		favoritePath = normalizedRemotePath(favoritePath)
		if _, ok := seen[favoritePath]; ok {
			continue
		}
		seen[favoritePath] = struct{}{}
		normalized = append(normalized, favoritePath)
		if len(normalized) == maxFavoritePaths {
			break
		}
	}
	return normalized
}

func normalizeConfig(cfg Config) Config {
	if cfg.TaskConcurrency < 1 || cfg.TaskConcurrency > 16 {
		cfg.TaskConcurrency = 4
	}
	if cfg.TaskChunkConcurrency < 1 || cfg.TaskChunkConcurrency > 16 {
		cfg.TaskChunkConcurrency = 4
	}
	switch cfg.TaskNotificationMode {
	case "off", "always", "unfocused":
	default:
		cfg.TaskNotificationMode = "unfocused"
	}
	cfg.TextGeneratorSources = normalizeTextGeneratorSources(cfg.TextGeneratorSources)
	cfg.DockerCLIPath = normalizeDockerCLIPath(cfg.DockerCLIPath)
	cfg.SSHProfiles = normalizeSSHProfiles(cfg.SSHProfiles)
	cfg.ImageSources = normalizeImageSources(cfg.ImageSources, sshProfileNameMap(cfg.SSHProfiles))
	if cfg.FileSources == nil {
		cfg.FileSources = []FileSource{}
	}
	for index := range cfg.FileSources {
		cfg.FileSources[index].FavoritePaths = normalizeFavoritePaths(cfg.FileSources[index].FavoritePaths)
		cfg.FileSources[index].SSHProfileID = strings.TrimSpace(cfg.FileSources[index].SSHProfileID)
	}
	cfg.ServiceTargets = normalizeServiceTargets(cfg.ServiceTargets, sshProfileNameMap(cfg.SSHProfiles))
	cfg.PortSources = normalizePortSources(cfg.PortSources, sshProfileNameMap(cfg.SSHProfiles))
	cfg.PortForwards = normalizePortForwards(cfg.PortForwards)
	validSidebarTool := make(map[string]bool, len(defaultSidebarToolIDs))
	for _, id := range defaultSidebarToolIDs {
		validSidebarTool[id] = true
	}
	if cfg.SidebarTools == nil {
		cfg.SidebarTools = defaultSidebarTools()
	} else {
		tools := make([]SidebarToolConfig, 0, len(defaultSidebarToolIDs))
		seen := make(map[string]bool, len(defaultSidebarToolIDs))
		for _, tool := range cfg.SidebarTools {
			if validSidebarTool[tool.ID] && !seen[tool.ID] {
				tools = append(tools, tool)
				seen[tool.ID] = true
			}
		}
		for _, id := range defaultSidebarToolIDs {
			if !seen[id] {
				tools = append(tools, SidebarToolConfig{ID: id, Enabled: true})
			}
		}
		cfg.SidebarTools = tools
	}
	trayTools := []string{"json", "time", "text", "base64", "diff", "jwt", "url"}
	validTrayTool := make(map[string]bool, len(trayTools))
	for _, id := range trayTools {
		validTrayTool[id] = true
	}
	if cfg.TrayMatchTools == nil {
		cfg.TrayMatchTools = append([]string(nil), trayTools...)
	} else {
		matched := make([]string, 0, len(cfg.TrayMatchTools))
		seen := make(map[string]bool, len(trayTools))
		for _, id := range cfg.TrayMatchTools {
			if validTrayTool[id] && !seen[id] {
				matched = append(matched, id)
				seen[id] = true
			}
		}
		if len(matched) == 0 {
			matched = append([]string(nil), trayTools...)
		}
		cfg.TrayMatchTools = matched
	}
	if cfg.DiffClipboardTargetMode == "" {
		cfg.DiffClipboardTargetMode = "alternate"
	}
	if cfg.DiffClipboardTargetMode == "off" {
		matched := cfg.TrayMatchTools[:0]
		for _, id := range cfg.TrayMatchTools {
			if id != "diff" {
				matched = append(matched, id)
			}
		}
		if len(matched) == 0 {
			matched = []string{"json", "time", "text", "base64", "jwt", "url"}
		}
		cfg.TrayMatchTools = matched
	}
	switch cfg.ThemeMode {
	case "light", "dark", "system":
	default:
		cfg.ThemeMode = "dark"
	}
	cfg.LightTheme = normalizeThemeID(cfg.LightTheme, "default-light")
	cfg.DarkTheme = normalizeThemeID(cfg.DarkTheme, "default-dark")
	switch cfg.DiffClipboardTargetMode {
	case "off", "alternate", "before", "after":
	default:
		cfg.DiffClipboardTargetMode = "alternate"
	}
	switch cfg.CodeEditorFontSize {
	case 12, 14, 16, 18:
	default:
		cfg.CodeEditorFontSize = 16
	}
	timeResults := []string{"local", "dateTime", "dateOnly", "timeOnly", "zonedIso8601", "rfc3339", "utc", "compact", "underscore", "unixSeconds", "unixMilliseconds", "unixNanoseconds"}
	validTimeResult := make(map[string]bool, len(timeResults))
	for _, id := range timeResults {
		validTimeResult[id] = true
	}
	seenTimeResult := make(map[string]bool, len(timeResults))
	order := make([]string, 0, len(timeResults))
	for _, id := range cfg.TimeResultOrder {
		if validTimeResult[id] && !seenTimeResult[id] {
			order = append(order, id)
			seenTimeResult[id] = true
		}
	}
	for _, id := range timeResults {
		if !seenTimeResult[id] {
			order = append(order, id)
		}
	}
	cfg.TimeResultOrder = order
	hidden := make([]string, 0, len(cfg.HiddenTimeResults))
	seenHidden := make(map[string]bool, len(timeResults))
	for _, id := range cfg.HiddenTimeResults {
		if validTimeResult[id] && !seenHidden[id] {
			hidden = append(hidden, id)
			seenHidden[id] = true
		}
	}
	cfg.HiddenTimeResults = hidden
	switch cfg.TimeWeekStart {
	case "monday", "sunday":
	default:
		cfg.TimeWeekStart = "monday"
	}
	cfg.NtpServers = normalizeNtpServers(cfg.NtpServers)
	cfg.NetworkTestSettings = normalizeNetworkTestSettings(cfg.NetworkTestSettings)
	return cfg
}

func normalizeNetworkTestSettings(settings NetworkTestSettings) NetworkTestSettings {
	if settings.TimeoutSeconds < 1 || settings.TimeoutSeconds > 300 {
		settings.TimeoutSeconds = 30
	}
	if settings.MaxRedirects < 0 || settings.MaxRedirects > 10 {
		settings.MaxRedirects = 10
	}
	switch settings.ProxyType {
	case "", "system", "http", "socks5":
	default:
		settings.ProxyType = ""
		settings.ProxyAddress = ""
	}
	switch settings.DNSMode {
	case "system", "custom", "proxy":
	default:
		settings.DNSMode = "system"
		settings.DNSAddress = ""
	}
	if settings.DNSMode == "proxy" && settings.ProxyType != "socks5" && settings.ProxyType != "system" {
		settings.DNSMode = "system"
	}
	return settings
}

func normalizeTextGeneratorSources(sources []TextGeneratorSource) []TextGeneratorSource {
	if sources == nil {
		return []TextGeneratorSource{}
	}
	result := make([]TextGeneratorSource, 0, len(sources))
	seen := make(map[string]bool, len(sources))
	for _, source := range sources {
		source.ID = strings.TrimSpace(source.ID)
		source.Name = strings.TrimSpace(source.Name)
		if source.ID == "" || source.Name == "" || source.Content == "" || seen[source.ID] {
			continue
		}
		if source.Mode != "line" {
			source.Mode = "character"
		}
		seen[source.ID] = true
		result = append(result, source)
	}
	return result
}

const appDataDirName = "TinkerKit"

func userConfigBaseDir() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return dir
	}
	return os.TempDir()
}

func appDataDir() string { return filepath.Join(userConfigBaseDir(), appDataDirName) }

func configPath() string     { return filepath.Join(appDataDir(), "config.json") }
func historyPath() string    { return filepath.Join(appDataDir(), "history.json") }
func historyDataDir() string { return filepath.Join(appDataDir(), "history-data") }

type ConfigService struct {
	mu          sync.Mutex
	path        string
	historyPath string
	historyDir  string
	cfg         Config
	history     []historyStored
	onChange    func(Config)
}

func NewConfigService() *ConfigService {
	cfg := defaultConfig()
	path := configPath()
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	cfg = normalizeConfig(cfg)
	s := &ConfigService{path: path, historyPath: historyPath(), historyDir: historyDataDir(), cfg: cfg}
	if b, err := os.ReadFile(s.historyPath); err == nil {
		_ = json.Unmarshal(b, &s.history)
	}
	return s
}

func (s *ConfigService) ServiceName() string { return "ConfigService" }
func (s *ConfigService) GetAppName() string  { return appName }
func (s *ConfigService) Get() Config         { s.mu.Lock(); defer s.mu.Unlock(); return s.cfg }

// GetNetworkTestSettings 返回网络测试工具保存的配置。
func (s *ConfigService) GetNetworkTestSettings() NetworkTestSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.NetworkTestSettings
}

// SaveNetworkTestSettings 只更新网络测试工具拥有的配置项。
func (s *ConfigService) SaveNetworkTestSettings(settings NetworkTestSettings) error {
	return s.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		cfg.NetworkTestSettings = settings
		return nil
	})
}

// IsAutostartEnabled 返回当前平台是否已将 TinkerKit 登记为登录时启动。
func (s *ConfigService) IsAutostartEnabled() (bool, error) {
	app := application.Get()
	if app == nil || app.Autostart == nil {
		return false, userError("errors.common.notInitialized")
	}
	return app.Autostart.IsEnabled()
}

// SetAutostart 为当前用户登记或移除 TinkerKit 的登录启动项。
func (s *ConfigService) SetAutostart(enabled bool) error {
	app := application.Get()
	if app == nil || app.Autostart == nil {
		return userError("errors.common.notInitialized")
	}
	if enabled {
		return app.Autostart.Enable()
	}
	return app.Autostart.Disable()
}

// ExportConfig 将当前规范化配置写入用户选择的 JSON 文件。
func (s *ConfigService) ExportConfig() (string, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "", userError("errors.common.notInitialized")
	}
	dialog := app.Dialog.SaveFile().SetFilename("tinkerkit-config.json").CanCreateDirectories(true).AddFilter("JSON", "*.json")
	if window := app.Window.Current(); window != nil {
		dialog.AttachToWindow(window)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return "", userErrorCause("errors.config.exportFailed", err)
	}
	if path == "" {
		return "", nil
	}
	data, err := s.exportConfigJSON()
	if err != nil {
		return "", userErrorCause("errors.config.exportFailed", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", userErrorCause("errors.config.exportFailed", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", userErrorCause("errors.config.exportFailed", err)
	}
	return path, nil
}

func (s *ConfigService) exportConfigJSON() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return json.MarshalIndent(s.cfg, "", "  ")
}

// ImportConfig 选择、校验并整体替换应用配置；取消选择时返回当前配置且不产生写入。
func (s *ConfigService) ImportConfig() (*Config, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return nil, userError("errors.common.notInitialized")
	}
	dialog := app.Dialog.OpenFile().CanChooseFiles(true).CanChooseDirectories(false).AddFilter("JSON", "*.json")
	if window := app.Window.Current(); window != nil {
		dialog.AttachToWindow(window)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return nil, userErrorCause("errors.config.importFailed", err)
	}
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, userErrorCause("errors.config.importFailed", err)
	}
	defer file.Close()
	const maxConfigImportBytes = 10 << 20
	data, err := io.ReadAll(io.LimitReader(file, maxConfigImportBytes+1))
	if err != nil {
		return nil, userErrorCause("errors.config.importFailed", err)
	}
	if len(data) > maxConfigImportBytes {
		return nil, userError("errors.config.importTooLarge")
	}
	cfg, err := decodeImportedConfig(data)
	if err != nil {
		return nil, err
	}
	if err := s.replaceConfig(cfg); err != nil {
		return nil, err
	}
	current := s.Get()
	return &current, nil
}

// ResetConfig 恢复所有配置项的默认值并立即通知配置消费者。
func (s *ConfigService) ResetConfig() (Config, error) {
	cfg := defaultConfig()
	if err := s.replaceConfig(cfg); err != nil {
		return Config{}, err
	}
	return s.Get(), nil
}

func decodeImportedConfig(data []byte) (Config, error) {
	cfg := defaultConfig()
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, userErrorCause("errors.config.invalidImport", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("multiple JSON values")
		}
		return Config{}, userErrorCause("errors.config.invalidImport", err)
	}
	if err := validateImportedConfig(cfg); err != nil {
		return Config{}, userErrorCause("errors.config.invalidImport", err)
	}
	return normalizeConfig(cfg), nil
}

func validateImportedConfig(cfg Config) error {
	if err := validateConfigForSave(cfg); err != nil {
		return err
	}
	profiles := make(map[string]struct{}, len(cfg.SSHProfiles))
	for _, profile := range cfg.SSHProfiles {
		profiles[profile.ID] = struct{}{}
	}
	for _, source := range cfg.FileSources {
		if !validConfigValue(strings.TrimSpace(source.ID), 128) || !validTextValue(strings.TrimSpace(source.Name), 256) || !validConfigValue(strings.TrimSpace(source.SSHProfileID), 128) {
			return fmt.Errorf("invalid file source")
		}
		if source.DefaultPath != "" && !validPathValue(source.DefaultPath, 4096) {
			return fmt.Errorf("invalid file source default path")
		}
		if _, ok := profiles[strings.TrimSpace(source.SSHProfileID)]; !ok {
			return fmt.Errorf("file source references missing SSH profile")
		}
	}
	for _, target := range cfg.ServiceTargets {
		kind := strings.ToLower(strings.TrimSpace(target.Kind))
		if kind == "" && strings.TrimSpace(target.ID) == "local" {
			kind = "local"
		}
		if kind != "local" && kind != "ssh" {
			return fmt.Errorf("invalid service target kind")
		}
		if kind == "ssh" {
			profileID := strings.TrimSpace(target.SSHProfileID)
			if _, ok := profiles[profileID]; !ok {
				return fmt.Errorf("service target references missing SSH profile")
			}
		}
	}
	if err := validateUniqueConfigIDs("file source", idsOfFileSources(cfg.FileSources)); err != nil {
		return err
	}
	if err := validateUniqueConfigIDs("service target", idsOfServiceTargets(cfg.ServiceTargets)); err != nil {
		return err
	}
	if err := validateUniqueConfigIDs("port source", idsOfPortSources(cfg.PortSources)); err != nil {
		return err
	}
	portSources := make(map[string]struct{}, len(cfg.PortSources))
	for _, source := range cfg.PortSources {
		if source.Kind == "local" || source.ID == "local" {
			continue
		}
		portSources[strings.TrimSpace(source.ID)] = struct{}{}
	}
	forwardIDs := make([]string, len(cfg.PortForwards))
	for index, forward := range cfg.PortForwards {
		forwardIDs[index] = forward.ID
		if _, err := normalizeForward(PortForwardRequest{
			SourceID: forward.SourceID, Direction: forward.Direction,
			ListenHost: forward.ListenHost, ListenPort: forward.ListenPort,
			TargetHost: forward.TargetHost, TargetPort: forward.TargetPort,
		}); err != nil {
			return err
		}
		if _, ok := portSources[strings.TrimSpace(forward.SourceID)]; !ok {
			return fmt.Errorf("port forward references missing port source")
		}
	}
	if err := validateUniqueConfigIDs("port forward", forwardIDs); err != nil {
		return err
	}
	for _, source := range cfg.PortSources {
		kind := strings.ToLower(strings.TrimSpace(source.Kind))
		if strings.TrimSpace(source.ID) == "local" || kind == "local" {
			continue
		}
		if kind != "ssh" || !validConfigValue(strings.TrimSpace(source.ID), 128) || !validTextValue(strings.TrimSpace(source.Name), 128) {
			return fmt.Errorf("invalid port source")
		}
		if kind == "ssh" {
			if _, ok := profiles[strings.TrimSpace(source.SSHProfileID)]; !ok {
				return fmt.Errorf("port source references missing SSH profile")
			}
		}
	}
	return nil
}

func validateUniqueConfigIDs(kind string, ids []string) error {
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("duplicate %s ID %q", kind, id)
		}
		seen[id] = struct{}{}
	}
	return nil
}

func idsOfFileSources(items []FileSource) []string {
	ids := make([]string, len(items))
	for i, item := range items {
		ids[i] = item.ID
	}
	return ids
}

func idsOfServiceTargets(items []ServiceTarget) []string {
	ids := make([]string, len(items))
	for i, item := range items {
		ids[i] = item.ID
	}
	return ids
}

func idsOfPortSources(items []PortSource) []string {
	ids := make([]string, len(items))
	for i, item := range items {
		ids[i] = item.ID
	}
	return ids
}

func (s *ConfigService) replaceConfig(cfg Config) error {
	if err := validateImportedConfig(cfg); err != nil {
		return userErrorCause("errors.config.invalidImport", err)
	}
	cfg = normalizeConfig(cfg)
	b, err := marshalConfig(cfg)
	if err != nil {
		return userErrorCause("errors.config.saveFailed", err)
	}
	s.mu.Lock()
	if err := writeConfigAtomically(s.path, b); err != nil {
		s.mu.Unlock()
		return userErrorCause("errors.config.saveFailed", err)
	}
	s.cfg = cfg
	onChange := s.onChange
	s.mu.Unlock()
	if onChange != nil {
		onChange(cfg)
	}
	return nil
}

// SetTaskSettings 更新后台任务调度与通知设置，并返回规范化后的应用配置。
func (s *ConfigService) SetTaskSettings(taskConcurrency, chunkConcurrency int, notificationMode string) (Config, error) {
	s.mu.Lock()
	cfg := s.cfg
	cfg.TaskConcurrency = taskConcurrency
	cfg.TaskChunkConcurrency = chunkConcurrency
	cfg.TaskNotificationMode = notificationMode
	cfg = normalizeConfig(cfg)
	b, err := marshalConfig(cfg)
	if err == nil {
		err = writeConfigAtomically(s.path, b)
	}
	if err != nil {
		s.mu.Unlock()
		return Config{}, err
	}
	s.cfg = cfg
	onChange := s.onChange
	s.mu.Unlock()
	if onChange != nil {
		onChange(cfg)
	}
	return cfg, nil
}

// ResolveSSHHostKeyPrompt 响应前端显示的 SSH 主机指纹确认。
func (s *ConfigService) ResolveSSHHostKeyPrompt(promptID string, accepted bool) error {
	return resolveSSHHostKeyPrompt(promptID, accepted)
}

// GetSSHKnownHosts 返回应用内保存的 SSH 主机指纹记录。
func (s *ConfigService) GetSSHKnownHosts() ([]SSHKnownHost, error) {
	return applicationSSHKnownHostStore().list()
}

// UpdateSSHKnownHost 更新应用内保存的 SSH 主机指纹记录。
func (s *ConfigService) UpdateSSHKnownHost(entry SSHKnownHost) (SSHKnownHost, error) {
	return applicationSSHKnownHostStore().update(entry)
}

// DeleteSSHKnownHost 删除应用内保存的 SSH 主机指纹记录。
func (s *ConfigService) DeleteSSHKnownHost(id string) error {
	return applicationSSHKnownHostStore().delete(id)
}

func (s *ConfigService) setOnChange(callback func(Config)) {
	s.mu.Lock()
	previous := s.onChange
	if previous == nil {
		s.onChange = callback
	} else if callback != nil {
		s.onChange = func(cfg Config) {
			previous(cfg)
			callback(cfg)
		}
	}
	s.mu.Unlock()
}

func (s *ConfigService) Save(cfg Config) error {
	s.mu.Lock()
	// SSH 配置和文件来源由各自的定向服务负责；保留内存值，避免设置页旧快照
	// 覆盖其他入口刚刚修改的配置或来源。
	cfg.SSHProfiles = copySSHProfiles(s.cfg.SSHProfiles)
	cfg.FileSources = copyFileSources(s.cfg.FileSources)
	cfg.ServiceTargets = copyServiceTargets(s.cfg.ServiceTargets)
	cfg.PortSources = append([]PortSource(nil), s.cfg.PortSources...)
	cfg.PortForwards = append([]PortForwardConfig(nil), s.cfg.PortForwards...)
	// 网络测试工具通过定向接口维护设置，避免设置页旧快照覆盖新值。
	cfg.NetworkTestSettings = s.cfg.NetworkTestSettings
	// 删除 SSH 配置后，工具引用可以暂时悬空；镜像/文件来源定向接口会在写入新引用前
	// 校验配置，而设置页快照仍应能保存无关设置，交由界面修复悬空来源。
	if err := validateConfigForSave(cfg, true); err != nil {
		s.mu.Unlock()
		return err
	}
	cfg = normalizeConfig(cfg)
	b, err := marshalConfig(cfg)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if err := writeConfigAtomically(s.path, b); err != nil {
		s.mu.Unlock()
		return err
	}
	s.cfg = cfg
	onChange := s.onChange
	s.mu.Unlock()
	if onChange != nil {
		onChange(cfg)
	}
	return nil
}

// SaveImageSources 只持久化镜像管理拥有的设置。SSH 来源在原子写入时必须引用现有
// 全局 SSH 配置，凭据本身不会经过此接口。
func (s *ConfigService) SaveImageSources(dockerCLIPath string, imageSources []ImageSource) error {
	imageSources = append([]ImageSource(nil), imageSources...)
	return s.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		seen := make(map[string]bool, len(imageSources))
		normalized := make([]ImageSource, 0, len(imageSources))
		profiles := make(map[string]struct{}, len(cfg.SSHProfiles))
		for _, profile := range cfg.SSHProfiles {
			profiles[profile.ID] = struct{}{}
		}
		profileNames := sshProfileNameMap(cfg.SSHProfiles)
		for index, source := range imageSources {
			item, err := normalizeImageSource(source, seen, nil, profileNames)
			if err != nil {
				return imageSourceValidationError(index+1, source, err)
			}
			if item.Kind == "ssh" {
				if item.SSHProfileID == "" {
					return userErrorParams("errors.config.imageSourceMissingSSHProfile", map[string]any{"name": imageSourceIdentifier(item)})
				}
				if _, ok := profiles[item.SSHProfileID]; !ok {
					return userErrorParams("errors.config.imageSourceSSHProfileNotFound", map[string]any{"name": imageSourceIdentifier(item)})
				}
			}
			normalized = append(normalized, item)
		}
		cfg.DockerCLIPath = dockerCLIPath
		cfg.ImageSources = normalized
		return nil
	})
}

func writeConfigAtomically(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tinkerkit-config-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()
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
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return nil
}
func (s *ConfigService) writeIndexLocked() {
	b, err := json.Marshal(s.history)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.historyPath), 0o755)
	_ = os.WriteFile(s.historyPath, b, 0o600)
}
func (s *ConfigService) GetHistory() []HistoryItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabledHistoryItemsLocked()
}

type HistoryPage struct {
	Items []HistoryItem `json:"items"`
	Total int           `json:"total"`
}

func (s *ConfigService) GetHistoryPage(offset int, limit int) (HistoryPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if offset < 0 {
		offset = 0
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}
	items := s.enabledHistoryItemsLocked()
	total := len(items)
	if offset >= total {
		return HistoryPage{Items: []HistoryItem{}, Total: total}, nil
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return HistoryPage{Items: items[offset:end], Total: total}, nil
}

type HistoryFilter struct {
	Tool string `json:"tool"`
	From int64  `json:"from"`
	To   int64  `json:"to"`
}

func (s *ConfigService) sidebarToolEnabledLocked(toolID string) bool {
	for _, tool := range s.cfg.SidebarTools {
		if tool.ID == toolID {
			return tool.Enabled
		}
	}
	return false
}

func (s *ConfigService) enabledHistoryItemsLocked() []HistoryItem {
	items := make([]HistoryItem, 0, len(s.history))
	for _, entry := range s.history {
		if s.sidebarToolEnabledLocked(entry.Item.Tool) {
			items = append(items, entry.Item)
		}
	}
	return items
}

func (s *ConfigService) QueryHistory(offset int, limit int, filter HistoryFilter) (HistoryPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if offset < 0 {
		offset = 0
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}
	items := s.enabledHistoryItemsLocked()
	filtered := make([]HistoryItem, 0, len(items))
	for _, item := range items {
		if filter.Tool != "" && item.Tool != filter.Tool {
			continue
		}
		if filter.From != 0 || filter.To != 0 {
			t, err := time.Parse(time.RFC3339Nano, item.At)
			if err != nil {
				continue
			}
			ms := t.UnixMilli()
			if filter.From != 0 && ms < filter.From {
				continue
			}
			if filter.To != 0 && ms > filter.To {
				continue
			}
		}
		filtered = append(filtered, item)
	}
	total := len(filtered)
	if offset >= total {
		return HistoryPage{Items: []HistoryItem{}, Total: total}, nil
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return HistoryPage{Items: filtered[offset:end], Total: total}, nil
}
func (s *ConfigService) AppendHistory(entry HistoryEntry) (HistoryItem, error) {
	if entry.Tool == "" {
		return HistoryItem{}, errors.New("missing history tool")
	}
	if detail := []rune(entry.Detail); len(detail) > 120 {
		entry.Detail = string(detail[:120])
	}
	id := time.Now().UnixNano()
	item := HistoryItem{ID: id, Tool: entry.Tool, Action: entry.Action, Detail: entry.Detail, At: time.Now().UTC().Format(time.RFC3339Nano), Mode: entry.Mode, MediaType: entry.MediaType, Name: entry.Name, Bytes: entry.Bytes}
	file := filepath.Join(s.historyDir, "entry-"+time.Unix(0, id).UTC().Format("20060102150405.000000000")+".json.gz")
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeGzipJSON(file, HistoryContent{Input: entry.Input, Output: entry.Output}); err != nil {
		return HistoryItem{}, err
	}
	s.history = append([]historyStored{{Item: item, File: file}}, s.history...)
	sort.SliceStable(s.history, func(i, j int) bool { return s.history[i].Item.ID > s.history[j].Item.ID })
	s.writeIndexLocked()
	return item, nil
}
func (s *ConfigService) GetHistoryContent(id int64) (HistoryContent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.history {
		if entry.Item.ID == id {
			if !s.sidebarToolEnabledLocked(entry.Item.Tool) {
				return HistoryContent{}, userError("errors.config.historyEntryNotFound")
			}
			return readGzipJSON(entry.File)
		}
	}
	return HistoryContent{}, userError("errors.config.historyEntryNotFound")
}
func (s *ConfigService) DeleteHistory(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, entry := range s.history {
		if entry.Item.ID == id {
			_ = os.Remove(entry.File)
			s.history = append(s.history[:i], s.history[i+1:]...)
			s.writeIndexLocked()
			return
		}
	}
}
func (s *ConfigService) ClearHistory() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.history {
		_ = os.Remove(entry.File)
	}
	s.history = nil
	s.writeIndexLocked()
}
func (s *ConfigService) SaveBase64File(path string, data string) error {
	if path == "" {
		return errors.New("missing save path")
	}
	if comma := strings.IndexByte(data, ','); strings.HasPrefix(data, "data:") && comma >= 0 {
		data = data[comma+1:]
	}
	data = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\r', '\n':
			return -1
		case '-':
			return '+'
		case '_':
			return '/'
		default:
			return r
		}
	}, data)
	if rem := len(data) % 4; rem != 0 {
		data += strings.Repeat("=", 4-rem)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tinkerkit-save-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	reader := base64.NewDecoder(base64.StdEncoding, strings.NewReader(data))
	written, copyErr := io.Copy(tmp, io.LimitReader(reader, (100<<20)+1))
	closeErr := tmp.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written > 100<<20 {
		return userError("errors.config.decodedFileTooLarge")
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
func writeGzipJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	z := gzip.NewWriter(f)
	if err := json.NewEncoder(z).Encode(value); err != nil {
		_ = z.Close()
		return err
	}
	return z.Close()
}
func readGzipJSON(path string) (HistoryContent, error) {
	f, err := os.Open(path)
	if err != nil {
		return HistoryContent{}, err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return HistoryContent{}, err
	}
	defer z.Close()
	var content HistoryContent
	err = json.NewDecoder(io.LimitReader(z, 256<<20)).Decode(&content)
	return content, err
}
