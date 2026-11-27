package main

import (
	"context"
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

func TestSaveSSHProfileAllowsEditingImportedConnectionFields(t *testing.T) {
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg: normalizeConfig(Config{SSHProfiles: []SSHProfile{{
			ID: "imported", Name: "旧名称", Origin: "ssh-config", OriginAlias: "prod",
			Host: "old.example.com", Port: 22, Username: "deploy",
			OriginUpdatedAt: "2020-01-01T00:00:00Z",
		}}}),
	}
	saved, err := service.SaveSSHProfile(SSHProfile{
		ID: "imported", Name: "新名称", Origin: "manual", OriginAlias: "other",
		Host: "changed.example.com", Port: 2022, Username: "other", Password: "password",
		PrivateKeyPath: "/tmp/imported-key", JumpProfileID: "jump-1",
		OriginUpdatedAt: "should-not-apply",
	})
	if err != nil {
		t.Fatalf("编辑导入配置的连接字段失败: %v", err)
	}
	if saved.Name != "新名称" || saved.Host != "changed.example.com" || saved.Port != 2022 || saved.Username != "other" || saved.Password != "password" || saved.PrivateKeyPath != "/tmp/imported-key" || saved.JumpProfileID != "jump-1" {
		t.Fatalf("导入配置的连接字段应可保存: %#v", saved)
	}
	if saved.Origin != "ssh-config" || saved.OriginAlias != "prod" || saved.OriginUpdatedAt != "2020-01-01T00:00:00Z" {
		t.Fatalf("普通保存不应改变导入来源身份: %#v", saved)
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

func TestSSHProfileJumpSelectionPersistsAcrossRefresh(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeSSHConfigTestFile(t, filepath.Join(home, ".ssh", "config"), "Host prod\n    HostName prod.example.com\n    User deploy\n")
	previous := sshConfigCommand
	t.Cleanup(func() { sshConfigCommand = previous })
	sshConfigCommand = func(ctx context.Context, alias string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "hostname prod.example.com\nport 22\nuser deploy\n")
	}
	service := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(defaultConfig())}
	jump, err := service.SaveSSHProfile(SSHProfile{Name: "跳板机", Host: "jump.example.com", Username: "deploy", Password: "secret"})
	if err != nil {
		t.Fatalf("保存跳板机配置失败: %v", err)
	}
	imported, err := service.ImportSSHConfigProfile("prod")
	if err != nil {
		t.Fatalf("导入本机 SSH 配置失败: %v", err)
	}
	saved, err := service.SaveSSHProfile(SSHProfile{
		ID: imported.ID, Name: imported.Name, Origin: imported.Origin, OriginAlias: imported.OriginAlias,
		Host: imported.Host, Port: imported.Port, Username: imported.Username,
		PrivateKeyPath: imported.PrivateKeyPath, JumpProfileID: jump.ID,
	})
	if err != nil {
		t.Fatalf("导入配置应允许设置跳板机: %v", err)
	}
	if saved.JumpProfileID != jump.ID {
		t.Fatalf("跳板机选择未保存: %#v", saved)
	}
	refreshed, err := service.RefreshSSHConfigProfile(imported.ID)
	if err != nil {
		t.Fatalf("刷新本机 SSH 配置失败: %v", err)
	}
	if refreshed.JumpProfileID != jump.ID {
		t.Fatalf("刷新本机 SSH 配置不应丢失跳板机选择: %#v", refreshed)
	}
	for _, profile := range service.GetSSHProfiles() {
		if profile.ID == imported.ID && profile.JumpProfileID != jump.ID {
			t.Fatalf("应用内配置未保留跳板机选择: %#v", profile)
		}
	}
}

func TestSaveSSHProfileRejectsJumpCycle(t *testing.T) {
	service := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(defaultConfig())}
	first, err := service.SaveSSHProfile(SSHProfile{Name: "A", Host: "a.example.com", Username: "deploy", Password: "secret"})
	if err != nil {
		t.Fatalf("保存第一条配置失败: %v", err)
	}
	second, err := service.SaveSSHProfile(SSHProfile{Name: "B", Host: "b.example.com", Username: "deploy", Password: "secret", JumpProfileID: first.ID})
	if err != nil {
		t.Fatalf("保存经跳板机的配置失败: %v", err)
	}
	if _, err := service.SaveSSHProfile(SSHProfile{
		ID: first.ID, Name: first.Name, Host: first.Host, Username: first.Username, Password: first.Password, JumpProfileID: second.ID,
	}); localizedErrorKey(err) != "errors.sshProfile.jumpCycle" {
		t.Fatalf("反向往回引用应形成循环并被拒绝，实际: %v", err)
	}
	if _, err := service.SaveSSHProfile(SSHProfile{
		ID: first.ID, Name: first.Name, Host: first.Host, Username: first.Username, Password: first.Password, JumpProfileID: first.ID,
	}); err == nil {
		t.Fatal("配置不应把自身设为跳板机")
	}
}

func TestImportSSHProfilesFromLocalCreatesAndUpdatesOnce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeSSHConfigTestFile(t, filepath.Join(home, ".ssh", "config"), "Host prod\n    HostName old.example.com\nHost broken\n    HostName broken.example.com\nHost staging\n    HostName staging.example.com\nHost *\n    User ignored\n")
	stubSSHConfigResolve(t, map[string]string{
		"prod":    "hostname prod.example.com\nport 2222\nuser deploy\nidentityfile ~/.ssh/prod_key\n",
		"staging": "hostname staging.example.com\nport 22\nuser stage\n",
	})
	manual := SSHProfile{ID: "manual", Name: "staging", Origin: "manual", Host: "manual.example.com", Username: "deploy", Password: "secret"}
	prod := SSHProfile{
		ID: "imported-prod", Name: "生产机", Origin: "ssh-config", OriginAlias: "prod",
		Host: "old.example.com", Port: 22, Username: "deploy", Password: "stale",
		JumpProfileID: "jump-1", OriginUpdatedAt: "2020-01-01T00:00:00Z",
	}
	legacy := SSHProfile{
		ID: "imported-legacy", Name: "旧机器", Origin: "ssh-config", OriginAlias: "legacy",
		Host: "legacy.example.com", Port: 22, Username: "deploy",
	}
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg:  normalizeConfig(Config{SSHProfiles: []SSHProfile{manual, prod, legacy}}),
	}
	writes := 0
	service.onChange = func(Config) { writes++ }
	result, err := NewSSHProfileService(service).ImportSSHProfilesFromLocal()
	if err != nil {
		t.Fatalf("批量导入失败: %v", err)
	}
	if result.Created != 1 || result.Updated != 1 {
		t.Fatalf("导入计数错误: created=%d updated=%d", result.Created, result.Updated)
	}
	if writes != 1 {
		t.Fatalf("批量导入应只持久化一次，实际 %d 次", writes)
	}
	if len(result.Profiles) != 4 {
		t.Fatalf("导入后配置数量错误: %#v", result.Profiles)
	}
	gotManual := sshProfileByID(t, result.Profiles, "manual")
	if gotManual.Host != manual.Host || gotManual.Origin != "manual" || gotManual.Password != manual.Password {
		t.Fatalf("手动配置不应被导入改动: %#v", gotManual)
	}
	gotProd := sshProfileByID(t, result.Profiles, "imported-prod")
	if gotProd.Name != "生产机" || gotProd.JumpProfileID != "jump-1" || gotProd.Host != "prod.example.com" || gotProd.Port != 2222 || gotProd.Username != "deploy" || gotProd.Password != "" || gotProd.PrivateKeyPath != filepath.Join(home, ".ssh", "prod_key") || gotProd.Origin != "ssh-config" || gotProd.OriginAlias != "prod" || gotProd.OriginUpdatedAt == prod.OriginUpdatedAt {
		t.Fatalf("已导入配置未按本机参数覆盖: %#v", gotProd)
	}
	gotLegacy := sshProfileByID(t, result.Profiles, "imported-legacy")
	if gotLegacy.Host != legacy.Host || gotLegacy.OriginAlias != "legacy" {
		t.Fatalf("本机已删除的历史配置不应被改动: %#v", gotLegacy)
	}
	created := result.Profiles[3]
	if created.Origin != "ssh-config" || created.OriginAlias != "staging" || created.Name != "staging" || created.Host != "staging.example.com" || created.ID == "" || created.ID == "staging" {
		t.Fatalf("新别名未建成独立配置: %#v", created)
	}
	persisted := service.GetSSHProfiles()
	if len(persisted) != len(result.Profiles) || persisted[3].ID != created.ID {
		t.Fatalf("返回列表与已保存配置不一致: %#v", persisted)
	}

	again, err := service.ImportSSHProfilesFromLocal()
	if err != nil {
		t.Fatalf("再次导入失败: %v", err)
	}
	if again.Created != 0 || again.Updated != 0 || len(again.Profiles) != 4 || writes != 2 {
		t.Fatalf("内容一致时再次导入不应计入更新: created=%d updated=%d len=%d writes=%d", again.Created, again.Updated, len(again.Profiles), writes)
	}
	if got := sshProfileByID(t, again.Profiles, "imported-prod"); got != gotProd {
		t.Fatalf("内容一致时不应改写配置: %#v", got)
	}
}

func TestImportSSHProfilesFromLocalUpdatesEveryMatchingAlias(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeSSHConfigTestFile(t, filepath.Join(home, ".ssh", "config"), "Host prod\n    HostName prod.example.com\n")
	stubSSHConfigResolve(t, map[string]string{
		"prod": "hostname prod.example.com\nport 2200\nuser deploy\n",
	})
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg: normalizeConfig(Config{SSHProfiles: []SSHProfile{
			{ID: "one", Name: "甲", Origin: "ssh-config", OriginAlias: "prod", Host: "old-a.example.com", Username: "deploy"},
			{ID: "two", Name: "乙", Origin: "ssh-config", OriginAlias: "prod", Host: "old-b.example.com", Username: "deploy", JumpProfileID: "jump-2"},
			{ID: "manual", Name: "prod", Origin: "manual", OriginAlias: "prod", Host: "manual.example.com", Username: "deploy", Password: "secret"},
		}}),
	}
	result, err := service.ImportSSHProfilesFromLocal()
	if err != nil {
		t.Fatalf("批量导入失败: %v", err)
	}
	if result.Created != 0 || result.Updated != 2 || len(result.Profiles) != 3 {
		t.Fatalf("同一别名应更新全部 ssh-config 配置且不新建: %#v", result)
	}
	for _, id := range []string{"one", "two"} {
		profile := sshProfileByID(t, result.Profiles, id)
		if profile.Host != "prod.example.com" || profile.Port != 2200 {
			t.Fatalf("%s 未被本机参数覆盖: %#v", id, profile)
		}
	}
	if sshProfileByID(t, result.Profiles, "two").JumpProfileID != "jump-2" || sshProfileByID(t, result.Profiles, "two").Name != "乙" {
		t.Fatal("更新时应保留名称和跳板机")
	}
	manual := sshProfileByID(t, result.Profiles, "manual")
	if manual.Host != "manual.example.com" || manual.Origin != "manual" {
		t.Fatalf("手动配置即使别名相同也不应匹配: %#v", manual)
	}
}

func TestImportSSHProfilesFromLocalRejectsWhenNothingMappable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	existing := SSHProfile{ID: "manual", Name: "开发机", Host: "dev.example.com", Username: "deploy", Password: "secret"}
	service := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg:  normalizeConfig(Config{SSHProfiles: []SSHProfile{existing}}),
	}
	writes := 0
	service.onChange = func(Config) { writes++ }
	if _, err := service.ImportSSHProfilesFromLocal(); localizedErrorKey(err) != "errors.sshProfile.nothingToImport" || writes != 0 {
		t.Fatalf("没有本机配置时应失败且不写盘: %v writes=%d", err, writes)
	}

	writeSSHConfigTestFile(t, filepath.Join(home, ".ssh", "config"), "Host *\n    User ignored\nHost prod\n    HostName prod.example.com\n")
	stubSSHConfigResolve(t, map[string]string{})
	if _, err := service.ImportSSHProfilesFromLocal(); localizedErrorKey(err) != "errors.sshProfile.nothingToImport" || writes != 0 {
		t.Fatalf("全部别名都无法映射时应失败且不写盘: %v writes=%d", err, writes)
	}
	got := service.GetSSHProfiles()
	if len(got) != 1 || got[0].ID != existing.ID || got[0].Host != existing.Host {
		t.Fatalf("失败的导入不应改动已有配置: %#v", got)
	}
	if _, err := os.Stat(service.path); !os.IsNotExist(err) {
		t.Fatalf("没有可导入配置时不应创建配置文件: %v", err)
	}
}

func stubSSHConfigResolve(t *testing.T, outputs map[string]string) {
	t.Helper()
	previous := sshConfigCommand
	t.Cleanup(func() { sshConfigCommand = previous })
	sshConfigCommand = func(ctx context.Context, alias string) *exec.Cmd {
		output, ok := outputs[alias]
		if !ok {
			return exec.CommandContext(ctx, "sh", "-c", "exit 1")
		}
		return exec.CommandContext(ctx, "printf", "%s", output)
	}
}

func sshProfileByID(t *testing.T, profiles []SSHProfile, id string) SSHProfile {
	t.Helper()
	for _, profile := range profiles {
		if profile.ID == id {
			return profile
		}
	}
	t.Fatalf("未找到 SSH 配置 %s", id)
	return SSHProfile{}
}
