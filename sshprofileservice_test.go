package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestNormalizeSSHProfileValidation(t *testing.T) {
	manual, err := normalizeSSHProfile(SSHProfile{
		ID:       "manual",
		Name:     "开发机",
		Host:     "dev.example.com",
		Username: "deploy",
		Password: "secret",
	})
	if err != nil {
		t.Fatalf("手动 SSH 配置不应失败: %v", err)
	}
	if manual.Port != 22 || manual.Origin != "manual" {
		t.Fatalf("手动 SSH 配置默认值错误: %#v", manual)
	}

	imported, err := normalizeSSHProfile(SSHProfile{
		ID:          "imported",
		Name:        "生产机",
		Origin:      "ssh-config",
		OriginAlias: "prod",
		Host:        "prod.example.com",
		Port:        2222,
	})
	if err != nil {
		t.Fatalf("没有 IdentityFile 的本机配置允许导入: %v", err)
	}
	if imported.Port != 2222 {
		t.Fatalf("导入配置端口被修改: %#v", imported)
	}

	if _, err := normalizeSSHProfile(SSHProfile{
		ID:       "missing-auth",
		Name:     "缺少认证",
		Host:     "dev.example.com",
		Username: "deploy",
	}); err == nil {
		t.Fatal("手动配置缺少认证信息时应失败")
	}
	if _, err := normalizeSSHProfile(SSHProfile{
		ID:          "bad-port",
		Name:        "坏端口",
		Origin:      "ssh-config",
		OriginAlias: "prod",
		Host:        "prod.example.com",
		Port:        65536,
	}); err == nil {
		t.Fatal("端口越界时应失败")
	}
}

func TestNormalizeSSHProfileAllowsEmptyID(t *testing.T) {
	draft, err := normalizeSSHProfile(SSHProfile{
		Host:     "dev.example.com",
		Username: "deploy",
		Password: "secret",
	})
	if err != nil {
		t.Fatalf("未保存的 SSH 配置草稿不应要求 ID: %v", err)
	}
	if draft.ID != "" || draft.Name != "dev.example.com" {
		t.Fatalf("草稿默认值错误: %#v", draft)
	}
}

func TestSSHProfileIDRequiredForPersistence(t *testing.T) {
	if err := validateSSHProfiles([]SSHProfile{{
		Host:     "dev.example.com",
		Username: "deploy",
		Password: "secret",
	}}); err == nil {
		t.Fatal("持久化列表缺少 SSH 配置 ID 时应失败")
	}
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg:  normalizeConfig(defaultConfig()),
	}
	saved, err := service.SaveSSHProfile(SSHProfile{Host: "dev.example.com", Username: "deploy", Password: "secret"})
	if err != nil {
		t.Fatalf("保存缺少 ID 的草稿应自动生成 ID: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("保存后应生成 SSH 配置 ID")
	}
}

func TestResolveSSHConfigProfileParsesExpandedOutput(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	previous := sshConfigCommand
	t.Cleanup(func() { sshConfigCommand = previous })
	sshConfigCommand = func(ctx context.Context, alias string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "hostname resolved.example.com\nport 2200\nuser deploy\nidentityfile ~/.ssh/id_ed25519\nidentityfile /tmp/second-key\n")
	}

	profile, err := resolveSSHConfigProfile("prod")
	if err != nil {
		t.Fatalf("解析 ssh -G 输出失败: %v", err)
	}
	if profile.Host != "resolved.example.com" || profile.Port != 2200 || profile.Username != "deploy" {
		t.Fatalf("展开后的连接参数错误: %#v", profile)
	}
	wantKey := filepath.Join(home, ".ssh", "id_ed25519")
	if profile.PrivateKeyPath != wantKey {
		t.Fatalf("IdentityFile 未展开或未取首项: %q, want %q", profile.PrivateKeyPath, wantKey)
	}
}

func TestResolveSSHConfigProfileKeepsErrorsExplicit(t *testing.T) {
	previous := sshConfigCommand
	t.Cleanup(func() { sshConfigCommand = previous })
	sshConfigCommand = func(ctx context.Context, alias string) *exec.Cmd {
		return exec.CommandContext(ctx, "sh", "-c", "printf 'invalid output' >&2; exit 1")
	}
	if _, err := resolveSSHConfigProfile("missing"); err == nil {
		t.Fatal("ssh -G 失败时应返回错误")
	}
}

func TestImportSSHConfigProfileRequiresDeclaredAlias(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeSSHConfigTestFile(t, filepath.Join(home, ".ssh", "config"), "Host prod\n    HostName prod.example.com\n    User deploy\n")
	previous := sshConfigCommand
	t.Cleanup(func() { sshConfigCommand = previous })
	sshConfigCommand = func(ctx context.Context, alias string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "hostname prod.example.com\nport 22\nuser deploy\n")
	}
	service := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(defaultConfig())}
	if _, err := service.ImportSSHConfigProfile("unknown"); err == nil {
		t.Fatal("未声明的本机 SSH config 别名不应导入")
	}
	profile, err := service.ImportSSHConfigProfile("prod")
	if err != nil {
		t.Fatalf("已声明别名导入失败: %v", err)
	}
	if profile.OriginAlias != "prod" || profile.Host != "prod.example.com" {
		t.Fatalf("导入的 SSH 配置错误: %#v", profile)
	}
}

func TestDeleteSSHProfileLeavesDanglingReferences(t *testing.T) {
	profile := SSHProfile{ID: "profile-1", Name: "生产", Host: "prod.example.com", Username: "deploy", Password: "secret"}
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg: normalizeConfig(Config{
			ImageSources: []ImageSource{
				{ID: localImageSourceID, Name: "本机", Kind: "local"},
				{ID: "images", Name: "生产镜像", Kind: "ssh", SSHProfileID: profile.ID},
			},
			SSHProfiles: []SSHProfile{profile},
			FileSources: []FileSource{{ID: "files", Name: "生产文件", SSHProfileID: profile.ID}},
		}),
	}
	if err := service.DeleteSSHProfile(profile.ID); err != nil {
		t.Fatalf("删除被引用的 SSH 配置不应失败: %v", err)
	}
	got := service.Get()
	if len(got.SSHProfiles) != 0 {
		t.Fatalf("SSH 配置未删除: %#v", got.SSHProfiles)
	}
	if got.ImageSources[1].SSHProfileID != profile.ID || got.FileSources[0].SSHProfileID != profile.ID {
		t.Fatalf("删除配置时不应清理工具引用: %#v %#v", got.ImageSources, got.FileSources)
	}
}

func TestSaveSSHProfileKeepsImportedConnectionFieldsReadOnly(t *testing.T) {
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg: normalizeConfig(Config{SSHProfiles: []SSHProfile{{
			ID: "imported", Name: "旧名称", Origin: "ssh-config", OriginAlias: "prod",
			Host: "old.example.com", Port: 22, Username: "deploy",
		}}}),
	}
	saved, err := service.SaveSSHProfile(SSHProfile{
		ID: "imported", Name: "新名称", Origin: "manual", Host: "changed.example.com",
		Port: 2022, Username: "other", Password: "password",
	})
	if err != nil {
		t.Fatalf("编辑导入配置名称失败: %v", err)
	}
	if saved.Name != "新名称" || saved.Host != "old.example.com" || saved.Port != 22 || saved.Username != "deploy" || saved.Origin != "ssh-config" {
		t.Fatalf("导入配置的连接字段不应被普通编辑覆盖: %#v", saved)
	}
}

func TestSaveFileSourcesRequiresGlobalSSHProfile(t *testing.T) {
	profile := SSHProfile{ID: "profile-1", Name: "生产", Host: "prod.example.com", Username: "deploy", Password: "secret"}
	config := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg:  normalizeConfig(Config{SSHProfiles: []SSHProfile{profile}}),
	}
	service := &FileService{config: config}
	if err := service.SaveFileSources([]FileSource{{ID: "files", Name: "生产文件", SSHProfileID: profile.ID}}); err != nil {
		t.Fatalf("有效的全局 SSH 配置引用不应失败: %v", err)
	}
	if err := service.SaveFileSources([]FileSource{{ID: "missing", Name: "失效文件", SSHProfileID: "does-not-exist"}}); err == nil {
		t.Fatal("文件源引用不存在的全局 SSH 配置时应失败")
	}
	if _, _, err := service.sourceSnapshot("files"); err != nil {
		t.Fatalf("文件源未能解析全局 SSH 配置快照: %v", err)
	}
	if _, err := os.Stat(config.path); err != nil {
		t.Fatalf("保存文件源后配置文件不存在: %v", err)
	}
}

func TestSaveImageSourcesUsesProfileReferencesAtomically(t *testing.T) {
	profile := SSHProfile{ID: "profile-1", Name: "生产", Host: "prod.example.com", Username: "deploy", Password: "secret"}
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg:  normalizeConfig(Config{SSHProfiles: []SSHProfile{profile}}),
	}
	if err := service.SaveImageSources("/custom/docker", []ImageSource{
		{ID: localImageSourceID, Name: "本机", Kind: "local"},
		{ID: "remote", Name: "生产", Kind: "ssh", SSHProfileID: profile.ID},
	}); err != nil {
		t.Fatalf("有效镜像来源保存失败: %v", err)
	}
	got := service.Get()
	if got.DockerCLIPath != "/custom/docker" || got.ImageSources[1].SSHProfileID != profile.ID {
		t.Fatalf("镜像来源未保存为全局 SSH 配置引用: %#v", got)
	}
	if got.ImageSources[1].SSHHost != "" || got.ImageSources[1].SSHPassword != "" {
		t.Fatalf("镜像来源不应保存内嵌 SSH 凭据: %#v", got.ImageSources[1])
	}
	if err := service.SaveImageSources("docker", []ImageSource{
		{ID: localImageSourceID, Name: "本机", Kind: "local"},
		{ID: "remote", Name: "失效", Kind: "ssh", SSHProfileID: "missing"},
	}); err == nil {
		t.Fatal("镜像来源引用不存在的全局 SSH 配置时应失败")
	}
}

func TestNewConfigServiceDropsLegacySSHDataOnce(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("创建配置目录失败: %v", err)
	}
	legacy := `{"imageSources":[{"id":"old-ssh","name":"旧 SSH","kind":"ssh","sshHost":"old.example.com"},{"id":"registry","name":"镜像仓库","kind":"registry","registryURL":"https://registry.example"}],"sshConnections":[{"id":"old","name":"旧连接"}],"fileSources":[{"id":"files","name":"旧文件源","sshConnectionID":"old"}]}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("写入旧 SSH 配置失败: %v", err)
	}

	service := NewConfigService()
	cfg := service.Get()
	if cfg.SSHProfilesVersion != currentSSHProfilesVersion || len(cfg.SSHProfiles) != 0 || len(cfg.SSHConnections) != 0 || len(cfg.FileSources) != 0 {
		t.Fatalf("旧 SSH 数据未一次性清理: %#v", cfg)
	}
	if len(cfg.ImageSources) != 2 || cfg.ImageSources[1].Kind != "registry" {
		t.Fatalf("本机和 Registry 来源保留结果错误: %#v", cfg.ImageSources)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取清理后的配置失败: %v", err)
	}
	var saved map[string]json.RawMessage
	if err := json.Unmarshal(b, &saved); err != nil {
		t.Fatalf("清理后的配置不是有效 JSON: %v", err)
	}
	if _, ok := saved["sshConnections"]; ok {
		t.Fatal("清理后的配置不应再保存旧 SSHConnections")
	}
	if _, ok := saved["sshProfilesVersion"]; !ok {
		t.Fatal("清理后的配置缺少 SSH 配置版本标记")
	}
}
