package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestDefaultConfigTheme(t *testing.T) {
	cfg := defaultConfig()
	if cfg.ThemeMode != "dark" || cfg.LightTheme != "default-light" || cfg.DarkTheme != "default-dark" {
		t.Fatalf("默认主题配置为 %#v，期望暗色、default-light、default-dark", cfg)
	}
}

func TestServiceLogHighlightConfig(t *testing.T) {
	for _, data := range []string{`{}`, `{"serviceLogHighlightLevels":true}`, `{"serviceLogHighlightLevels":false}`} {
		cfg, err := decodeImportedConfig([]byte(data))
		if err != nil {
			t.Fatal(err)
		}
		want := data != `{"serviceLogHighlightLevels":false}`
		if cfg.ServiceLogHighlight != want {
			t.Fatalf("凸显着色默认值或显式选择未保留：%s", data)
		}
		path := filepath.Join(t.TempDir(), "config.json")
		service := &ConfigService{path: path, cfg: defaultConfig()}
		if err := service.Save(cfg); err != nil {
			t.Fatal(err)
		}
		persisted, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		reloaded := defaultConfig()
		if err := json.Unmarshal(persisted, &reloaded); err != nil {
			t.Fatal(err)
		}
		if reloaded.ServiceLogHighlight != want {
			t.Fatalf("凸显着色选择落盘后未保留：%s", data)
		}
	}
}

func TestServiceLogCollapseLinesConfig(t *testing.T) {
	cases := []struct {
		data string
		want int
	}{
		{`{}`, defaultServiceLogCollapseLines},
		{`{"serviceLogCollapseLines":20}`, 20},
		{`{"serviceLogCollapseLines":0}`, defaultServiceLogCollapseLines},
		{`{"serviceLogCollapseLines":-3}`, defaultServiceLogCollapseLines},
		{`{"serviceLogCollapseLines":1000}`, defaultServiceLogCollapseLines},
	}
	for _, c := range cases {
		cfg, err := decodeImportedConfig([]byte(c.data))
		if err != nil {
			t.Fatal(err)
		}
		if cfg.ServiceLogCollapseLines != c.want {
			t.Fatalf("折叠行数为 %d，期望 %d：%s", cfg.ServiceLogCollapseLines, c.want, c.data)
		}
	}
}

func TestDecodeImportedConfigFillsDefaultsAndKeepsCredentials(t *testing.T) {
	cfg, err := decodeImportedConfig([]byte(`{"language":"en-US","sshProfiles":[{"id":"profile-1","name":"prod","origin":"manual","host":"example.com","port":22,"username":"deploy","password":"secret"}]}`))
	if err != nil {
		t.Fatalf("decodeImportedConfig() error = %v", err)
	}
	if cfg.Language != "en-US" || cfg.ThemeMode != "dark" || cfg.ImageSources[0].ID != "local" {
		t.Fatalf("defaults were not filled: %#v", cfg)
	}
	if len(cfg.SSHProfiles) != 1 || cfg.SSHProfiles[0].Password != "secret" {
		t.Fatalf("credentials were not preserved: %#v", cfg.SSHProfiles)
	}
}

func TestExportConfigJSONContainsCurrentCredentials(t *testing.T) {
	cfg := defaultConfig()
	cfg.SSHProfiles = []SSHProfile{{ID: "profile-1", Name: "prod", Origin: "manual", Host: "example.com", Port: 22, Username: "deploy", Password: "secret"}}
	service := &ConfigService{cfg: normalizeConfig(cfg)}
	data, err := service.exportConfigJSON()
	if err != nil {
		t.Fatalf("exportConfigJSON() error = %v", err)
	}
	var exported Config
	if err := json.Unmarshal(data, &exported); err != nil {
		t.Fatalf("exported config is invalid JSON: %v", err)
	}
	if len(exported.SSHProfiles) != 1 || exported.SSHProfiles[0].Password != "secret" {
		t.Fatalf("export did not preserve credentials: %#v", exported.SSHProfiles)
	}
}

func TestDecodeImportedConfigRejectsMalformedDuplicateAndDanglingData(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{name: "malformed JSON", data: `{"language":`},
		{name: "duplicate image source", data: `{"imageSources":[{"id":"local","name":"Local","kind":"local"},{"id":"local","name":"Again","kind":"local"}]}`},
		{name: "duplicate SSH profile", data: `{"sshProfiles":[{"id":"p","name":"one","host":"host","username":"user","password":"secret"},{"id":"p","name":"two","host":"host","username":"user","password":"secret"}]}`},
		{name: "dangling image source profile", data: `{"imageSources":[{"id":"local","name":"Local","kind":"local"},{"id":"remote","name":"Remote","kind":"ssh","sshProfileID":"missing"}]}`},
		{name: "trailing JSON", data: `{} {}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeImportedConfig([]byte(test.data)); err == nil {
				t.Fatal("expected invalid configuration to be rejected")
			}
		})
	}
}

func TestReplaceConfigReplacesAllOwnedFieldsAndNotifiesSubscribers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	initial := defaultConfig()
	initial.Language = "en-US"
	initial.SSHProfiles = []SSHProfile{{ID: "old", Name: "old", Origin: "manual", Host: "old-host", Username: "user", Password: "old-secret", Port: 22}}
	service := &ConfigService{path: path, cfg: normalizeConfig(initial)}
	changes := 0
	service.setOnChange(func(Config) { changes++ })
	service.setOnChange(func(Config) { changes++ })

	cfg := defaultConfig()
	cfg.Language = "en-US"
	cfg.AutoOverwrite = true
	cfg.SSHProfiles = []SSHProfile{{ID: "new", Name: "new", Origin: "manual", Host: "new-host", Username: "user", Password: "new-secret", Port: 22}}
	if err := service.replaceConfig(cfg); err != nil {
		t.Fatalf("replaceConfig() error = %v", err)
	}
	got := service.Get()
	if len(got.SSHProfiles) != 1 || got.SSHProfiles[0].ID != "new" || got.SSHProfiles[0].Password != "new-secret" || got.AutoOverwrite != true {
		t.Fatalf("configuration was not replaced: %#v", got)
	}
	if changes != 2 {
		t.Fatalf("subscriber calls = %d, want 2", changes)
	}
	var persisted Config
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.SSHProfiles[0].Password != "new-secret" {
		t.Fatal("persisted config does not contain imported credential")
	}
}

func TestReplaceConfigRejectsInvalidConfigWithoutChangingState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	service := &ConfigService{path: path, cfg: normalizeConfig(defaultConfig())}
	if err := service.replaceConfig(defaultConfig()); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	invalid := defaultConfig()
	invalid.FileSources = []FileSource{{ID: "remote", Name: "Remote", SSHProfileID: "missing"}}
	if err := service.replaceConfig(invalid); err == nil {
		t.Fatal("expected dangling reference to be rejected")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) || len(service.Get().FileSources) != 0 {
		t.Fatal("invalid replacement changed persisted or in-memory configuration")
	}
}

func TestReplaceConfigWriteFailureKeepsCurrentConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	current := defaultConfig()
	current.Language = "en-US"
	service := &ConfigService{path: path, cfg: normalizeConfig(current)}
	next := defaultConfig()
	next.Language = "zh-CN"
	if err := service.replaceConfig(next); err == nil {
		t.Fatal("expected write failure")
	}
	if got := service.Get().Language; got != "en-US" {
		t.Fatalf("in-memory config changed after write failure: language = %q", got)
	}
}

func TestResetConfigRestoresDefaults(t *testing.T) {
	service := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(defaultConfig())}
	custom := defaultConfig()
	custom.Language = "en-US"
	custom.SSHProfiles = []SSHProfile{{ID: "custom", Name: "custom", Origin: "manual", Host: "host", Username: "user", Password: "secret", Port: 22}}
	if err := service.replaceConfig(custom); err != nil {
		t.Fatal(err)
	}
	got, err := service.ResetConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, normalizeConfig(defaultConfig())) {
		t.Fatalf("ResetConfig() = %#v, want defaults", got)
	}
}

func TestNormalizeConfigTheme(t *testing.T) {
	tests := []struct {
		name string
		in   Config
		want Config
	}{
		{name: "保留浅色模式", in: Config{ThemeMode: "light", LightTheme: "default-light", DarkTheme: "default-dark"}, want: Config{ThemeMode: "light", LightTheme: "default-light", DarkTheme: "default-dark"}},
		{name: "保留深色模式", in: Config{ThemeMode: "dark", LightTheme: "default-light", DarkTheme: "default-dark"}, want: Config{ThemeMode: "dark", LightTheme: "default-light", DarkTheme: "default-dark"}},
		{name: "保留系统模式", in: Config{ThemeMode: "system", LightTheme: "default-light", DarkTheme: "default-dark"}, want: Config{ThemeMode: "system", LightTheme: "default-light", DarkTheme: "default-dark"}},
		{name: "未知主题回退", in: Config{ThemeMode: "system", LightTheme: "custom-light", DarkTheme: "custom-dark"}, want: Config{ThemeMode: "system", LightTheme: "default-light", DarkTheme: "default-dark"}},
		{name: "未知模式回退为深色", in: Config{ThemeMode: "custom"}, want: Config{ThemeMode: "dark", LightTheme: "default-light", DarkTheme: "default-dark"}},
		{name: "非法浅色主题回退", in: Config{ThemeMode: "light", LightTheme: "default-dark", DarkTheme: "default-dark"}, want: Config{ThemeMode: "light", LightTheme: "default-light", DarkTheme: "default-dark"}},
		{name: "非法深色主题回退", in: Config{ThemeMode: "dark", LightTheme: "default-light", DarkTheme: "default-light"}, want: Config{ThemeMode: "dark", LightTheme: "default-light", DarkTheme: "default-dark"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := normalizeConfig(test.in)
			if got.ThemeMode != test.want.ThemeMode || got.LightTheme != test.want.LightTheme || got.DarkTheme != test.want.DarkTheme {
				t.Fatalf("主题规范化结果为 %#v，期望 %#v", got, test.want)
			}
		})
	}
}

func TestNormalizeConfigFavoritePaths(t *testing.T) {
	cfg := normalizeConfig(Config{
		FileSources: []FileSource{{
			FavoritePaths: []string{" /srv/app/../logs ", "/srv/logs", "", "bad\x00path"},
		}},
	})
	got := cfg.FileSources[0].FavoritePaths
	want := []string{"/srv/logs"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("收藏路径规范化结果为 %#v，期望 %#v", got, want)
	}
}

func TestNormalizeConfigTrayMatchTools(t *testing.T) {
	defaultTools := []string{"json", "time", "text", "base64", "diff", "jwt", "url"}
	tests := []struct {
		name string
		in   []string
		want []string
	}{
		{name: "保留有效工具并过滤无效项", in: []string{"json", "unknown", "json", "url"}, want: []string{"json", "url"}},
		{name: "无效项回退到默认工具", in: []string{"unknown", "image"}, want: defaultTools},
		{name: "空数组回退到默认工具", in: []string{}, want: defaultTools},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := defaultConfig()
			cfg.TrayMatchTools = test.in
			got := normalizeConfig(cfg).TrayMatchTools
			if len(got) != len(test.want) {
				t.Fatalf("规范化后的托盘工具为 %#v，期望 %#v", got, test.want)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("规范化后的托盘工具为 %#v，期望 %#v", got, test.want)
				}
			}
		})
	}
}

func TestNormalizeConfigEditorFontSize(t *testing.T) {
	tests := []struct {
		in   int
		want int
	}{
		{in: 12, want: 12},
		{in: 14, want: 14},
		{in: 16, want: 16},
		{in: 18, want: 18},
		{in: 10, want: 16},
		{in: 11, want: 16},
		{in: 13, want: 16},
		{in: 15, want: 16},
		{in: 17, want: 16},
		{in: 19, want: 16},
		{in: 24, want: 16},
	}
	for _, test := range tests {
		cfg := defaultConfig()
		cfg.CodeEditorFontSize = test.in
		if got := normalizeConfig(cfg).CodeEditorFontSize; got != test.want {
			t.Fatalf("字号 %d 规范化为 %d，期望 %d", test.in, got, test.want)
		}
	}
}

func TestNormalizeConfigTimeWeekStart(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{in: "monday", want: "monday"},
		{in: "sunday", want: "sunday"},
		{in: "", want: "monday"},
		{in: "saturday", want: "monday"},
	}
	for _, test := range tests {
		cfg := defaultConfig()
		cfg.TimeWeekStart = test.in
		if got := normalizeConfig(cfg).TimeWeekStart; got != test.want {
			t.Fatalf("周起始 %q 规范化为 %q，期望 %q", test.in, got, test.want)
		}
	}
}

func TestNormalizeConfigDoesNotAddTrayTools(t *testing.T) {
	cfg := defaultConfig()
	cfg.TrayMatchTools = []string{"json"}
	got := normalizeConfig(cfg)
	if len(got.TrayMatchTools) != 1 || got.TrayMatchTools[0] != "json" {
		t.Fatalf("规范化不应再向托盘工具列表补入其他项目，得到 %#v", got.TrayMatchTools)
	}
}

func TestConfigServiceRejectsUnsupportedThemeIDs(t *testing.T) {
	root := t.TempDir()
	service := &ConfigService{path: filepath.Join(root, "config.json"), cfg: normalizeConfig(defaultConfig())}
	cfg := defaultConfig()
	cfg.LightTheme = "custom-light"
	cfg.DarkTheme = "custom-dark"

	if err := service.Save(cfg); err != nil {
		t.Fatalf("保存配置失败: %v", err)
	}
	b, err := os.ReadFile(service.path)
	if err != nil {
		t.Fatalf("读取规范化后的配置失败: %v", err)
	}
	var saved Config
	if err := json.Unmarshal(b, &saved); err != nil {
		t.Fatalf("规范化后的配置不是有效 JSON: %v", err)
	}
	if saved.LightTheme != "default-light" || saved.DarkTheme != "default-dark" {
		t.Fatalf("保存后的主题 ID 为 %#v，期望 default-light 和 default-dark", saved)
	}
}

func TestConfigServiceDoesNotRewriteConfigOnLoad(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("创建配置目录失败: %v", err)
	}
	data := `{"language":"en-US","trayMatchTools":["invalid"],"codeEditorFontSize":13}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatalf("写入测试配置失败: %v", err)
	}

	service := NewConfigService()
	if got := service.Get(); got.Language != "en-US" || len(got.TrayMatchTools) == 0 || got.CodeEditorFontSize != 16 {
		t.Fatalf("加载后的内存配置仍需应用当前默认值与规范化: %#v", got)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取配置失败: %v", err)
	}
	if string(b) != data {
		t.Fatalf("启动读取不应改写配置文件，得到 %s", b)
	}
}

func TestDiffClipboardTargetOffNormalization(t *testing.T) {
	cfg := defaultConfig()
	cfg.DiffClipboardTargetMode = "off"
	cfg.TrayMatchTools = []string{"diff"}
	cfg = normalizeConfig(cfg)
	if cfg.DiffClipboardTargetMode != "off" {
		t.Fatalf("关闭模式被改写: %q", cfg.DiffClipboardTargetMode)
	}
	for _, id := range cfg.TrayMatchTools {
		if id == "diff" {
			t.Fatal("关闭差异对比后仍包含 diff 匹配项")
		}
	}
	if len(cfg.TrayMatchTools) == 0 {
		t.Fatal("关闭差异对比后至少应保留一个匹配工具")
	}

}

func TestExistingHistoryFilesAreLeftUntouched(t *testing.T) {
	root := t.TempDir()
	historyPath := filepath.Join(root, "history.json")
	historyDir := filepath.Join(root, "history-data")
	entryPath := filepath.Join(historyDir, "entry-old.json.gz")
	if err := os.MkdirAll(historyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(historyPath, []byte("legacy-index"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entryPath, []byte("legacy-entry"), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &ConfigService{path: filepath.Join(root, "config.json"), cfg: normalizeConfig(defaultConfig())}
	if err := service.Save(service.Get()); err != nil {
		t.Fatalf("保存配置失败: %v", err)
	}
	for path, want := range map[string]string{historyPath: "legacy-index", entryPath: "legacy-entry"} {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("旧历史文件 %s 不应被删除: %v", path, err)
		}
		if string(got) != want {
			t.Fatalf("旧历史文件 %s 内容被改写: %q", path, got)
		}
	}
}

func TestConfigServiceSaveConcurrentWrites(t *testing.T) {
	root := t.TempDir()
	service := &ConfigService{
		path: filepath.Join(root, "config.json"),
		cfg:  normalizeConfig(defaultConfig()),
	}

	const saveCount = 32
	configs := make([]Config, saveCount)
	for i := range configs {
		configs[i] = defaultConfig()
		configs[i].Language = fmt.Sprintf("test-language-%d", i)
	}

	var wg sync.WaitGroup
	errs := make(chan error, saveCount)
	for _, cfg := range configs {
		wg.Add(1)
		go func(cfg Config) {
			defer wg.Done()
			errs <- service.Save(cfg)
		}(cfg)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("并发保存配置失败: %v", err)
		}
	}

	b, err := os.ReadFile(service.path)
	if err != nil {
		t.Fatalf("读取保存后的配置失败: %v", err)
	}
	var saved Config
	if err := json.Unmarshal(b, &saved); err != nil {
		t.Fatalf("并发保存后的配置不是有效 JSON: %v", err)
	}
	for _, cfg := range configs {
		if saved.Language == cfg.Language {
			info, err := os.Stat(service.path)
			if err != nil {
				t.Fatalf("获取配置文件信息失败: %v", err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("配置文件权限为 %o，期望 600", info.Mode().Perm())
			}
			return
		}
	}
	t.Fatalf("保存后的配置不是任一完整快照: %#v", saved)
}

func TestConfigServiceSavePropagatesWriteError(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config-target")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatalf("创建保存错误测试目录失败: %v", err)
	}
	service := &ConfigService{path: path, cfg: normalizeConfig(defaultConfig())}

	if err := service.Save(defaultConfig()); err == nil {
		t.Fatal("保存到目录时应返回错误")
	}
}

func TestNormalizeImageSourceKeepsHistoricalIDs(t *testing.T) {
	cfg := normalizeConfig(Config{ImageSources: []ImageSource{
		{ID: "ssh:build-box", Name: "构建机", Kind: "ssh", SSHHost: "build-box"},
		{ID: "registry:550e8400-e29b-41d4-a716-446655440000", Name: "仓库", Kind: "registry", RegistryURL: "https://registry.example"},
	}})
	if len(cfg.ImageSources) != 3 {
		t.Fatalf("历史来源 ID 被丢弃: %#v", cfg.ImageSources)
	}
	if cfg.ImageSources[1].ID != "ssh:build-box" || cfg.ImageSources[2].ID != "registry:550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("历史来源 ID 未保持原值: %#v", cfg.ImageSources)
	}
}

func TestConfigServiceSaveRejectsInvalidImageSource(t *testing.T) {
	root := t.TempDir()
	service := &ConfigService{path: filepath.Join(root, "config.json"), cfg: normalizeConfig(defaultConfig())}
	if err := service.Save(defaultConfig()); err != nil {
		t.Fatalf("保存初始配置失败: %v", err)
	}
	baseline, err := os.ReadFile(service.path)
	if err != nil {
		t.Fatalf("读取初始配置失败: %v", err)
	}
	before := service.Get()

	tests := []struct {
		name     string
		sources  []ImageSource
		wantKey  string
		wantName string
	}{
		{name: "空 registry 地址", sources: []ImageSource{{ID: "registry:repo-a", Name: "仓库A", Kind: "registry", RegistryURL: ""}}, wantKey: "errors.config.registryURLInvalid"},
		{name: "非 https registry 地址", sources: []ImageSource{{ID: "registry:repo-a", Name: "仓库A", Kind: "registry", RegistryURL: "http://registry.example"}}, wantKey: "errors.config.registryURLInvalid"},
		{name: "无用户名的 registry 密码", sources: []ImageSource{{ID: "registry:repo-a", Name: "仓库A", Kind: "registry", RegistryURL: "https://registry.example", RegistryPassword: "secret"}}, wantKey: "errors.config.registryPasswordWithoutUsername"},
		{name: "无私钥的密钥口令", sources: []ImageSource{{ID: "ssh:box-a", Name: "构建机A", Kind: "ssh", SSHHost: "box-a", SSHKeyPassphrase: "pass"}}, wantKey: "errors.config.sshKeyPassphraseWithoutKey"},
		{name: "非法 SSH 主机", sources: []ImageSource{{ID: "ssh:box-a", Name: "构建机A", Kind: "ssh", SSHHost: "bad host"}}, wantKey: "errors.config.sshHostInvalid"},
		{name: "非法 ID", sources: []ImageSource{{ID: "bad id", Name: "坏来源", Kind: "ssh", SSHHost: "box-a"}}, wantKey: "errors.config.sshImageSourceIDInvalid"},
		{name: "重复 ID 辨别第二项", sources: []ImageSource{
			{ID: "ssh:box-a", Name: "构建机A", Kind: "ssh", SSHHost: "box-a"},
			{ID: "ssh:box-a", Name: "构建机B", Kind: "ssh", SSHHost: "box-a"},
		}, wantKey: "errors.config.imageSourceIDDuplicate", wantName: "构建机B"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := defaultConfig()
			cfg.ImageSources = test.sources
			err := service.Save(cfg)
			if err == nil {
				t.Fatalf("保存含无效来源的配置应返回错误: %#v", test.sources)
			}
			if key := localizedErrorKey(err); key != "errors.config.imageSourceInvalid" {
				t.Fatalf("错误 key 为 %q，期望 errors.config.imageSourceInvalid", key)
			}
			if !strings.Contains(err.Error(), test.wantKey) {
				t.Fatalf("错误 %q 应包含内层 key %q", err.Error(), test.wantKey)
			}
			if test.wantName != "" && !strings.Contains(err.Error(), test.wantName) {
				t.Fatalf("错误 %q 应包含来源标识 %q", err.Error(), test.wantName)
			}
			if got := service.Get(); !imageSourcesEqual(got.ImageSources, before.ImageSources) {
				t.Fatalf("无效来源保存后内存配置不应变化: %#v", got.ImageSources)
			}
			b, err := os.ReadFile(service.path)
			if err != nil {
				t.Fatalf("读取配置文件失败: %v", err)
			}
			if string(b) != string(baseline) {
				t.Fatalf("无效来源保存后磁盘配置不应变化")
			}
		})
	}
}

func TestConfigServiceSaveAcceptsNormalizableImageSource(t *testing.T) {
	root := t.TempDir()
	profile := SSHProfile{ID: "profile-a", Name: "构建机A", Origin: "manual", Host: "box-a", Port: 22, Username: "dev"}
	initial := defaultConfig()
	initial.SSHProfiles = []SSHProfile{profile}
	service := &ConfigService{path: filepath.Join(root, "config.json"), cfg: normalizeConfig(initial)}

	cfg := defaultConfig()
	cfg.ImageSources = []ImageSource{
		{ID: "local", Kind: "local"},
		{ID: "ssh:box-a", Name: "构建机A", Kind: "ssh", SSHProfileID: profile.ID},
		{ID: "registry:repo-a", Name: "仓库A", Kind: "registry", RegistryURL: "https://REGISTRY.EXAMPLE/", RegistryUsername: "user", RegistryPassword: "pass"},
	}
	if err := service.Save(cfg); err != nil {
		t.Fatalf("保存可规范化来源失败: %v", err)
	}

	saved := service.Get()
	if len(saved.ImageSources) != 3 {
		t.Fatalf("保存后来源数量为 %d，期望 3: %#v", len(saved.ImageSources), saved.ImageSources)
	}
	if saved.ImageSources[0].Name != "本机" {
		t.Fatalf("本地来源名称未回填: %#v", saved.ImageSources[0])
	}
	if saved.ImageSources[1].SSHProfileID != profile.ID {
		t.Fatalf("SSH 来源未保留配置引用: %#v", saved.ImageSources[1])
	}
	if saved.ImageSources[2].RegistryURL != "https://registry.example" {
		t.Fatalf("registry 地址未标准化: %q", saved.ImageSources[2].RegistryURL)
	}
	if saved.ImageSources[1].RegistryURL != "" || saved.ImageSources[2].SSHHost != "" {
		t.Fatalf("无关字段未清空: %#v", saved.ImageSources)
	}

	b, err := os.ReadFile(service.path)
	if err != nil {
		t.Fatalf("读取保存后的配置失败: %v", err)
	}
	var disk Config
	if err := json.Unmarshal(b, &disk); err != nil {
		t.Fatalf("磁盘配置不是有效 JSON: %v", err)
	}
	if !imageSourcesEqual(disk.ImageSources, saved.ImageSources) {
		t.Fatalf("磁盘与内存来源不一致: %#v vs %#v", disk.ImageSources, saved.ImageSources)
	}
}

func TestConfigServiceLoadsDropsInvalidImageSource(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("创建配置目录失败: %v", err)
	}
	data := `{"imageSources":[{"id":"local","name":"本机","kind":"local"},{"id":"registry:bad","name":"坏仓库","kind":"registry","registryURL":"not a url"}]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatalf("写入含无效来源的测试配置失败: %v", err)
	}

	service := NewConfigService()
	cfg := service.Get()
	if len(cfg.ImageSources) != 1 || cfg.ImageSources[0].ID != localImageSourceID {
		t.Fatalf("加载应静默丢弃无效来源并保留本地来源: %#v", cfg.ImageSources)
	}
}

func TestImageSidebarToolIsFirstClass(t *testing.T) {
	inDefaults := false
	for _, id := range defaultSidebarToolIDs {
		if id == "image" {
			inDefaults = true
		}
	}
	if !inDefaults {
		t.Fatal("默认侧边栏工具缺少 image")
	}

	cfg := normalizeConfig(Config{SidebarTools: []SidebarToolConfig{{ID: "image", Enabled: true}}})
	kept := false
	for _, tool := range cfg.SidebarTools {
		if tool.ID == "image" {
			kept = true
		}
	}
	if !kept {
		t.Fatalf("规范化丢弃了 image 侧边栏工具: %#v", cfg.SidebarTools)
	}
}

func TestNormalizeTextGeneratorSources(t *testing.T) {
	sources := normalizeTextGeneratorSources([]TextGeneratorSource{
		{ID: " first ", Name: " First ", Content: "abc", Mode: "character"},
		{ID: "first", Name: "duplicate", Content: "ignored", Mode: "line"},
		{ID: "second", Name: "Second", Content: "one\ntwo", Mode: "line"},
		{ID: "third", Name: "Third", Content: "xyz", Mode: "invalid"},
		{ID: "", Name: "Missing ID", Content: "abc", Mode: "character"},
		{ID: "empty", Name: "Empty", Content: "", Mode: "character"},
	})
	if len(sources) != 3 {
		t.Fatalf("文本生成源规范化数量为 %d，期望 3: %#v", len(sources), sources)
	}
	if sources[0].ID != "first" || sources[0].Name != "First" {
		t.Fatalf("文本生成源未清理 ID 或名称: %#v", sources[0])
	}
	if sources[1].Mode != "line" || sources[2].Mode != "character" {
		t.Fatalf("文本生成源模式规范化错误: %#v", sources)
	}
}

func TestNormalizeConfigIncludesTextGeneratorDefaults(t *testing.T) {
	cfg := normalizeConfig(Config{})
	if cfg.TextGeneratorSources == nil || len(cfg.TextGeneratorSources) != 0 {
		t.Fatalf("空文本生成源应规范化为空列表: %#v", cfg.TextGeneratorSources)
	}
	found := false
	for _, tool := range cfg.SidebarTools {
		if tool.ID == "text-generator" {
			found = tool.Enabled
		}
	}
	if !found {
		t.Fatalf("默认侧栏应启用文本生成工具: %#v", cfg.SidebarTools)
	}
}

func TestConfigServicePersistsTextGeneratorSources(t *testing.T) {
	root := t.TempDir()
	service := &ConfigService{path: filepath.Join(root, "config.json"), cfg: normalizeConfig(defaultConfig())}
	cfg := service.Get()
	cfg.TextGeneratorSources = []TextGeneratorSource{{
		ID: "words", Name: "常用词", Content: "alpha\nbeta", Mode: "line",
	}}
	if err := service.Save(cfg); err != nil {
		t.Fatalf("保存文本生成源失败: %v", err)
	}
	saved := service.Get()
	if !reflect.DeepEqual(saved.TextGeneratorSources, cfg.TextGeneratorSources) {
		t.Fatalf("文本生成源保存后不一致: got %#v want %#v", saved.TextGeneratorSources, cfg.TextGeneratorSources)
	}
}

func TestNormalizeTaskCenterSettingsDefaultsAndBounds(t *testing.T) {
	cfg := normalizeConfig(Config{})
	if cfg.TaskConcurrency != 4 || cfg.TaskChunkConcurrency != 4 || cfg.TaskNotificationMode != "unfocused" {
		t.Fatalf("task defaults = %d/%d/%q", cfg.TaskConcurrency, cfg.TaskChunkConcurrency, cfg.TaskNotificationMode)
	}
	cfg.TaskConcurrency = 17
	cfg.TaskChunkConcurrency = 0
	cfg.TaskNotificationMode = "invalid"
	cfg = normalizeConfig(cfg)
	if cfg.TaskConcurrency != 4 || cfg.TaskChunkConcurrency != 4 || cfg.TaskNotificationMode != "unfocused" {
		t.Fatalf("invalid task settings not normalized: %d/%d/%q", cfg.TaskConcurrency, cfg.TaskChunkConcurrency, cfg.TaskNotificationMode)
	}
	cfg.TaskConcurrency = 1
	cfg.TaskChunkConcurrency = 16
	cfg.TaskNotificationMode = "always"
	cfg = normalizeConfig(cfg)
	if cfg.TaskConcurrency != 1 || cfg.TaskChunkConcurrency != 16 || cfg.TaskNotificationMode != "always" {
		t.Fatalf("valid task settings changed: %d/%d/%q", cfg.TaskConcurrency, cfg.TaskChunkConcurrency, cfg.TaskNotificationMode)
	}
}

// User-Agent 会被原样写进请求报文：规范化只去掉首尾空白与 CR/LF，空值表示使用工具默认标识。
func TestNormalizeNetworkTestUserAgent(t *testing.T) {
	settings := normalizeNetworkTestSettings(NetworkTestSettings{UserAgent: "  Mozilla/5.0\r\nInjected: 1  "})
	if settings.UserAgent != "Mozilla/5.0Injected: 1" {
		t.Fatalf("规范化后的 User-Agent = %q", settings.UserAgent)
	}
	empty := normalizeNetworkTestSettings(NetworkTestSettings{UserAgent: "   "})
	if empty.UserAgent != "" {
		t.Fatalf("空白 User-Agent 应保持为空（表示默认）：%q", empty.UserAgent)
	}
}
