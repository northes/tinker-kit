package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

const sshConfigResolveTimeout = 10 * time.Second

var sshProfileIDCounter atomic.Uint64

// SSHProfileService 是全局 SSH 配置的 Wails 服务门面。
// 实际持久化仍由 ConfigService 负责，避免产生第二套配置状态；保留
// ConfigService 上的方法也让内部调用和旧测试可以复用同一套原子实现。
type SSHProfileService struct {
	config *ConfigService
}

func NewSSHProfileService(config *ConfigService) *SSHProfileService {
	return &SSHProfileService{config: config}
}

func (s *SSHProfileService) ServiceName() string { return "SSHProfileService" }

func (s *SSHProfileService) configService() (*ConfigService, error) {
	if s == nil || s.config == nil {
		return nil, errors.New("配置服务尚未初始化")
	}
	return s.config, nil
}

func (s *SSHProfileService) GetSSHProfiles() []SSHProfile {
	if s == nil || s.config == nil {
		return []SSHProfile{}
	}
	return s.config.GetSSHProfiles()
}

func (s *SSHProfileService) SaveSSHProfile(profile SSHProfile) (SSHProfile, error) {
	config, err := s.configService()
	if err != nil {
		return SSHProfile{}, err
	}
	return config.SaveSSHProfile(profile)
}

func (s *SSHProfileService) DeleteSSHProfile(id string) error {
	config, err := s.configService()
	if err != nil {
		return err
	}
	return config.DeleteSSHProfile(id)
}

func (s *SSHProfileService) GetSSHConfigProfiles() ([]SSHProfile, error) {
	config, err := s.configService()
	if err != nil {
		return []SSHProfile{}, err
	}
	return config.GetSSHConfigProfiles()
}

func (s *SSHProfileService) ImportSSHConfigProfile(alias string) (SSHProfile, error) {
	config, err := s.configService()
	if err != nil {
		return SSHProfile{}, err
	}
	return config.ImportSSHConfigProfile(alias)
}

func (s *SSHProfileService) RefreshSSHConfigProfile(id string) (SSHProfile, error) {
	config, err := s.configService()
	if err != nil {
		return SSHProfile{}, err
	}
	return config.RefreshSSHConfigProfile(id)
}

func (s *SSHProfileService) TestSSHProfile(profile SSHProfile) error {
	config, err := s.configService()
	if err != nil {
		return err
	}
	return config.TestSSHProfile(profile)
}

// normalizeSSHProfile 应用默认值并校验连接字段，但不会静默改变已保存配置的认证语义。
// ID 是持久化身份，不属于连接参数：未保存的草稿允许为空，由保存和列表校验负责。
func normalizeSSHProfile(profile SSHProfile) (SSHProfile, error) {
	profile.ID = strings.TrimSpace(profile.ID)
	profile.Name = strings.TrimSpace(profile.Name)
	profile.Origin = strings.TrimSpace(strings.ToLower(profile.Origin))
	profile.OriginAlias = strings.TrimSpace(profile.OriginAlias)
	profile.Host = strings.TrimSpace(profile.Host)
	profile.Username = strings.TrimSpace(profile.Username)
	profile.PrivateKeyPath = strings.TrimSpace(profile.PrivateKeyPath)
	profile.OriginUpdatedAt = strings.TrimSpace(profile.OriginUpdatedAt)
	if profile.Origin == "" {
		profile.Origin = "manual"
	}
	if profile.Origin != "manual" && profile.Origin != "ssh-config" {
		return SSHProfile{}, errors.New("SSH 配置来源无效")
	}
	if profile.Name == "" {
		profile.Name = profile.OriginAlias
		if profile.Name == "" {
			profile.Name = profile.Host
		}
	}
	if !validTextValue(profile.Name, 256) {
		return SSHProfile{}, errors.New("SSH 配置名称无效")
	}
	if profile.Port == 0 {
		profile.Port = 22
	}
	if profile.Port < 1 || profile.Port > 65535 {
		return SSHProfile{}, errors.New("SSH 端口必须在 1-65535 之间")
	}
	if !validSSHHost(profile.Host) {
		return SSHProfile{}, errors.New("SSH 主机无效")
	}
	if profile.Origin == "ssh-config" {
		if !validSSHHost(profile.OriginAlias) {
			return SSHProfile{}, errors.New("本机 SSH config 别名无效")
		}
	} else {
		if profile.Username == "" || !validConfigValue(profile.Username, 256) || strings.HasPrefix(profile.Username, "-") {
			return SSHProfile{}, errors.New("SSH 用户名无效")
		}
		if profile.Password == "" && profile.PrivateKey == "" && profile.PrivateKeyPath == "" {
			return SSHProfile{}, errors.New("SSH 未配置密码或私钥")
		}
	}
	if !validSecretValue(profile.Password, 4096) || !validSecretValue(profile.PrivateKey, 128<<10) || !validSecretValue(profile.KeyPassphrase, 4096) {
		return SSHProfile{}, errors.New("SSH 认证信息无效")
	}
	if profile.PrivateKeyPath != "" && (!validPathValue(profile.PrivateKeyPath, 4096) || strings.HasPrefix(profile.PrivateKeyPath, "-")) {
		return SSHProfile{}, errors.New("SSH 私钥路径无效")
	}
	if profile.KeyPassphrase != "" && profile.PrivateKey == "" && profile.PrivateKeyPath == "" {
		return SSHProfile{}, errors.New("SSH 密钥口令未关联私钥")
	}
	return profile, nil
}

func normalizeSSHProfiles(profiles []SSHProfile) []SSHProfile {
	result := make([]SSHProfile, 0, len(profiles))
	seen := make(map[string]struct{}, len(profiles))
	for _, profile := range profiles {
		normalized, err := normalizeSSHProfile(profile)
		if err != nil {
			continue
		}
		if !validConfigValue(normalized.ID, 128) {
			continue
		}
		if _, ok := seen[normalized.ID]; ok {
			continue
		}
		seen[normalized.ID] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func validateSSHProfiles(profiles []SSHProfile) error {
	seen := make(map[string]struct{}, len(profiles))
	for index, profile := range profiles {
		normalized, err := normalizeSSHProfile(profile)
		if err != nil {
			return fmt.Errorf("SSH 配置无效（第 %d 项）：%v", index+1, err)
		}
		if !validConfigValue(normalized.ID, 128) {
			return fmt.Errorf("SSH 配置 ID 无效（第 %d 项）", index+1)
		}
		if _, ok := seen[normalized.ID]; ok {
			return fmt.Errorf("SSH 配置 ID 重复: %q", normalized.ID)
		}
		seen[normalized.ID] = struct{}{}
	}
	return nil
}

func copySSHProfiles(profiles []SSHProfile) []SSHProfile {
	return append([]SSHProfile(nil), profiles...)
}

func newSSHProfileID() string {
	return fmt.Sprintf("ssh-profile-%d-%d", time.Now().UnixNano(), sshProfileIDCounter.Add(1))
}

func (s *ConfigService) GetSSHProfiles() []SSHProfile {
	return copySSHProfiles(s.Get().SSHProfiles)
}

// SaveSSHProfile 只保存一个配置，不要求调用方提交完整应用配置。本机导入配置的连接字段
// 只读；RefreshSSHConfigProfile 是从本机 SSH config 替换快照的唯一入口。
func (s *ConfigService) SaveSSHProfile(profile SSHProfile) (SSHProfile, error) {
	return s.saveSSHProfile(profile, false)
}

func (s *ConfigService) saveSSHProfile(profile SSHProfile, allowImportedUpdate bool) (SSHProfile, error) {
	profile.ID = strings.TrimSpace(profile.ID)
	if profile.ID == "" {
		profile.ID = newSSHProfileID()
	}
	var normalized SSHProfile
	if err := s.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		profiles := copySSHProfiles(cfg.SSHProfiles)
		found := false
		for index := range profiles {
			if profiles[index].ID == profile.ID {
				found = true
				if profiles[index].Origin == "ssh-config" && !allowImportedUpdate {
					// 本机导入配置只允许编辑显示名称。
					profile.Origin = profiles[index].Origin
					profile.OriginAlias = profiles[index].OriginAlias
					profile.Host = profiles[index].Host
					profile.Port = profiles[index].Port
					profile.Username = profiles[index].Username
					profile.Password = profiles[index].Password
					profile.PrivateKey = profiles[index].PrivateKey
					profile.PrivateKeyPath = profiles[index].PrivateKeyPath
					profile.KeyPassphrase = profiles[index].KeyPassphrase
					profile.OriginUpdatedAt = profiles[index].OriginUpdatedAt
				}
				break
			}
		}
		var err error
		normalized, err = normalizeSSHProfile(profile)
		if err != nil {
			return err
		}
		if !validConfigValue(normalized.ID, 128) {
			return errors.New("SSH 配置 ID 无效")
		}
		for index := range profiles {
			if profiles[index].ID == normalized.ID {
				profiles[index] = normalized
				break
			}
		}
		if !found {
			profiles = append(profiles, normalized)
		}
		cfg.SSHProfiles = profiles
		return nil
	}); err != nil {
		return SSHProfile{}, err
	}
	return normalized, nil
}

// DeleteSSHProfile 有意保留工具引用，让界面显示并修复失效配置，而不是静默删除来源。
func (s *ConfigService) DeleteSSHProfile(id string) error {
	id = strings.TrimSpace(id)
	if !validConfigValue(id, 128) {
		return errors.New("SSH 配置 ID 无效")
	}
	return s.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		profiles := make([]SSHProfile, 0, len(cfg.SSHProfiles))
		for _, profile := range cfg.SSHProfiles {
			if profile.ID != id {
				profiles = append(profiles, profile)
			}
		}
		cfg.SSHProfiles = profiles
		return nil
	})
}

// GetSSHConfigProfiles 返回机器 OpenSSH 配置展开后的连接参数。导入配置由应用直接建立
// SSH 连接，因此不会暴露无法映射到当前字段的高级指令。
func (s *ConfigService) GetSSHConfigProfiles() ([]SSHProfile, error) {
	hosts, err := s.getSSHConfigAliases()
	if err != nil {
		return []SSHProfile{}, err
	}
	profiles := make([]SSHProfile, 0, len(hosts))
	for _, alias := range hosts {
		profile, err := resolveSSHConfigProfile(alias)
		if err != nil {
			continue
		}
		profiles = append(profiles, profile)
	}
	return profiles, nil
}

func (s *ConfigService) getSSHConfigAliases() ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{}, fmt.Errorf("获取用户主目录失败: %w", err)
	}
	hosts, err := parseSSHConfigFileTree(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return []string{}, err
	}
	aliases := make([]string, 0, len(hosts))
	for _, host := range hosts {
		if host.Alias != "" {
			aliases = append(aliases, host.Alias)
		}
	}
	return aliases, nil
}

// ImportSSHConfigProfile 从一个本机 alias 创建参数快照。
func (s *ConfigService) ImportSSHConfigProfile(alias string) (SSHProfile, error) {
	if err := ensureSSHConfigAlias(alias); err != nil {
		return SSHProfile{}, err
	}
	profile, err := resolveSSHConfigProfile(alias)
	if err != nil {
		return SSHProfile{}, err
	}
	profile.ID = newSSHProfileID()
	return s.SaveSSHProfile(profile)
}

// RefreshSSHConfigProfile 只更新本机导入配置的连接字段，保留应用 ID 和显示名称。
func (s *ConfigService) RefreshSSHConfigProfile(id string) (SSHProfile, error) {
	id = strings.TrimSpace(id)
	var current SSHProfile
	for _, profile := range s.GetSSHProfiles() {
		if profile.ID == id {
			current = profile
			break
		}
	}
	if current.ID == "" || current.Origin != "ssh-config" || current.OriginAlias == "" {
		return SSHProfile{}, errors.New("找不到可更新的本机 SSH 配置")
	}
	if err := ensureSSHConfigAlias(current.OriginAlias); err != nil {
		return SSHProfile{}, err
	}
	updated, err := resolveSSHConfigProfile(current.OriginAlias)
	if err != nil {
		return SSHProfile{}, err
	}
	updated.ID = current.ID
	updated.Name = current.Name
	return s.saveSSHProfile(updated, true)
}

func ensureSSHConfigAlias(alias string) error {
	alias = strings.TrimSpace(alias)
	if !validSSHHost(alias) {
		return errors.New("本机 SSH config 别名无效")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("获取用户主目录失败: %w", err)
	}
	hosts, err := parseSSHConfigFileTree(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("本机 SSH config 中不存在别名 %q", alias)
		}
		return err
	}
	for _, host := range hosts {
		if host.Alias == alias {
			return nil
		}
	}
	return fmt.Errorf("本机 SSH config 中不存在别名 %q", alias)
}

// TestSSHProfile 使用 SSH 文件和镜像服务共用的直接客户端路径完成握手测试。
func (s *ConfigService) TestSSHProfile(profile SSHProfile) error {
	normalized, err := normalizeSSHProfile(profile)
	if err != nil {
		return err
	}
	return testSSHProfile(context.Background(), normalized, s.Get().Language)
}

func testSSHProfile(ctx context.Context, profile SSHProfile, language string) error {
	auth, err := sshAuthMethodsForProfile(profile)
	if err != nil {
		return err
	}
	hostKeyCallback, err := newAppSSHHostKeyCallback(language)
	if err != nil {
		return fmt.Errorf("读取应用 SSH known_hosts 失败: %w", err)
	}
	host := strings.TrimPrefix(strings.TrimSuffix(profile.Host, "]"), "[")
	address := net.JoinHostPort(host, strconv.Itoa(profile.Port))
	config := &ssh.ClientConfig{User: profile.Username, Auth: auth, HostKeyCallback: hostKeyCallback, Timeout: 15 * time.Second}
	client, err := dialSSHClient(ctx, address, config)
	if err != nil {
		return err
	}
	closeSSHClient(client)
	return nil
}

func sshAuthMethodsForProfile(profile SSHProfile) ([]ssh.AuthMethod, error) {
	methods := make([]ssh.AuthMethod, 0, 3)
	if profile.Password != "" {
		methods = append(methods, passwordAuthMethods(profile.Password)...)
	}
	keyData := profile.PrivateKey
	var err error
	if keyData == "" && profile.PrivateKeyPath != "" {
		keyData, err = readSSHPrivateKeyFile(profile.PrivateKeyPath)
		if err != nil {
			return nil, errors.New("读取 SSH 私钥文件失败")
		}
	}
	if keyData != "" {
		var signer ssh.Signer
		if profile.KeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyData), []byte(profile.KeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyData))
		}
		if err != nil {
			return nil, errors.New("解析 SSH 私钥失败")
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if len(methods) == 0 {
		return nil, errors.New("SSH 未配置认证凭据")
	}
	return methods, nil
}

var sshConfigCommand = func(ctx context.Context, alias string) *exec.Cmd {
	return exec.CommandContext(ctx, "ssh", "-G", alias)
}

func resolveSSHConfigProfile(alias string) (SSHProfile, error) {
	alias = strings.TrimSpace(alias)
	if !validSSHHost(alias) {
		return SSHProfile{}, errors.New("本机 SSH config 别名无效")
	}
	ctx, cancel := context.WithTimeout(context.Background(), sshConfigResolveTimeout)
	defer cancel()
	output, err := sshConfigCommand(ctx, alias).Output()
	if err != nil {
		if ctx.Err() != nil {
			return SSHProfile{}, ctx.Err()
		}
		return SSHProfile{}, fmt.Errorf("读取本机 SSH config 失败: %w", err)
	}
	profile := SSHProfile{ID: alias, Name: alias, Origin: "ssh-config", OriginAlias: alias, Port: 22, Host: alias, OriginUpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	seenHost, seenPort, seenUser := false, false, false
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch strings.ToLower(fields[0]) {
		case "hostname":
			profile.Host = strings.TrimSpace(fields[1])
			seenHost = true
		case "port":
			port, parseErr := strconv.Atoi(fields[1])
			if parseErr != nil {
				return SSHProfile{}, errors.New("解析本机 SSH config 的端口失败")
			}
			profile.Port = port
			seenPort = true
		case "user":
			profile.Username = strings.TrimSpace(fields[1])
			seenUser = true
		case "identityfile":
			if profile.PrivateKeyPath == "" && fields[1] != "none" {
				profile.PrivateKeyPath = expandSSHConfigPath(fields[1])
			}
		}
	}
	if !seenHost || !seenPort || !seenUser {
		return SSHProfile{}, errors.New("本机 SSH config 输出缺少 HostName、Port 或 User")
	}
	if _, err := normalizeSSHProfile(profile); err != nil {
		return SSHProfile{}, err
	}
	return profile, nil
}

func expandSSHConfigPath(value string) string {
	if value == "~" {
		if home, err := userHomeDir(); err == nil {
			return home
		}
	}
	if strings.HasPrefix(value, "~/") {
		if home, err := userHomeDir(); err == nil {
			return filepath.Join(home, value[2:])
		}
	}
	return value
}

func userHomeDir() (string, error) {
	return os.UserHomeDir()
}

func sshProfileToConnection(profile SSHProfile) SSHConnection {
	return SSHConnection{
		ID: profile.ID, Name: profile.Name, Host: profile.Host, Port: profile.Port,
		Username: profile.Username, Password: profile.Password, PrivateKey: profile.PrivateKey,
		PrivateKeyPath: profile.PrivateKeyPath, KeyPassphrase: profile.KeyPassphrase,
		Mode: "manual", Alias: profile.OriginAlias,
	}
}

func (s *ConfigService) updateConfig(mutator func(*Config) error) error {
	return s.updateConfigInternal(mutator, false)
}

func (s *ConfigService) updateConfigAllowDanglingRefs(mutator func(*Config) error) error {
	return s.updateConfigInternal(mutator, true)
}

func (s *ConfigService) updateConfigInternal(mutator func(*Config) error, allowDanglingRefs bool) error {
	s.mu.Lock()
	cfg := s.cfg
	if err := mutator(&cfg); err != nil {
		s.mu.Unlock()
		return err
	}
	if err := validateConfigForSave(cfg, allowDanglingRefs); err != nil {
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

func validateConfigForSave(cfg Config, allowDanglingRefs ...bool) error {
	if err := validateImageSourcesForSave(cfg.ImageSources); err != nil {
		return err
	}
	if err := validateSSHProfiles(cfg.SSHProfiles); err != nil {
		return err
	}
	profiles := make(map[string]struct{}, len(cfg.SSHProfiles))
	for _, profile := range cfg.SSHProfiles {
		profiles[profile.ID] = struct{}{}
	}
	if len(allowDanglingRefs) > 0 && allowDanglingRefs[0] {
		return nil
	}
	for index, source := range cfg.ImageSources {
		if source.Kind == "ssh" && source.SSHProfileID != "" {
			if _, ok := profiles[source.SSHProfileID]; !ok {
				return fmt.Errorf("镜像来源（第 %d 项）引用的 SSH 配置不存在", index+1)
			}
		}
	}
	for index, source := range cfg.FileSources {
		if source.SSHProfileID != "" {
			if _, ok := profiles[source.SSHProfileID]; !ok {
				return fmt.Errorf("文件来源（第 %d 项）引用的 SSH 配置不存在", index+1)
			}
		}
	}
	for index, target := range cfg.ServiceTargets {
		if target.Kind == "ssh" && target.SSHProfileID != "" {
			if _, ok := profiles[target.SSHProfileID]; !ok {
				return fmt.Errorf("服务目标（第 %d 项）引用的 SSH 配置不存在", index+1)
			}
		}
	}
	return nil
}

func marshalConfig(cfg Config) ([]byte, error) {
	return json.Marshal(cfg)
}
