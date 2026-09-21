package main

import (
	"path/filepath"
	"testing"
)

func TestGroupDockerContainersKeepsStandaloneAndCompose(t *testing.T) {
	groups, standalone := groupDockerContainers([]DockerContainer{
		{ID: "a", Name: "api", ComposeProject: "stack", ComposeService: "api"},
		{ID: "b", Name: "db", ComposeProject: "stack", ComposeService: "db"},
		{ID: "c", Name: "redis"},
	})
	if len(groups) != 1 || groups[0].ID != "compose:stack" || len(groups[0].Containers) != 2 {
		t.Fatalf("unexpected groups: %#v", groups)
	}
	if len(standalone) != 1 || standalone[0].Name != "redis" {
		t.Fatalf("unexpected standalone containers: %#v", standalone)
	}
}

func TestAppendLogLineKeepsAnsiSequences(t *testing.T) {
	service := &ServiceManagerService{}
	monitor := &logMonitorState{
		LogMonitor: LogMonitor{ID: "monitor-1", Resource: ServiceResourceRef{Runtime: "docker", ID: "0123456789abcdef"}},
		lines:      []ServiceLogLine{},
	}
	service.appendLogLine(monitor, "stdout", "2026-01-02T03:04:05.000000000Z \x1b[90msrvx 0.11.21\x1b[39m")
	if len(monitor.lines) != 1 {
		t.Fatalf("期望写入一行日志: %#v", monitor.lines)
	}
	line := monitor.lines[0]
	if line.Timestamp != "2026-01-02T03:04:05.000000000Z" {
		t.Fatalf("docker 时间戳解析被破坏: %q", line.Timestamp)
	}
	if line.Text != "\x1b[90msrvx 0.11.21\x1b[39m" {
		t.Fatalf("原始控制序列应保留给前端渲染: %q", line.Text)
	}
}

func TestServiceLogFilterMatchesVisibleText(t *testing.T) {
	filter, err := newLogFilter(ServiceLogFilter{Query: "srvx"})
	if err != nil {
		t.Fatalf("构造过滤器失败: %v", err)
	}
	if !filter(ServiceLogLine{Text: "\x1b[90msrvx\x1b[0m 0.11.21"}) {
		t.Fatal("查询应命中可见文本，而不是被控制序列隔断")
	}
	anchored, err := newLogFilter(ServiceLogFilter{Query: "^srvx", Regex: true})
	if err != nil {
		t.Fatalf("构造正则过滤器失败: %v", err)
	}
	if !anchored(ServiceLogLine{Text: "\x1b[90msrvx 0.11.21\x1b[0m"}) {
		t.Fatal("锚点应针对可见文本生效")
	}
}

func TestStripAnsiSequencesKeepsPlainText(t *testing.T) {
	cases := map[string]string{
		"plain log line":                                      "plain log line",
		"\x1b[2K\x1b[1;32mOK\x1b[0m":                          "OK",
		"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\": "link",
	}
	for input, want := range cases {
		if got := stripAnsiSequences(input); got != want {
			t.Fatalf("stripAnsiSequences(%q) = %q, 期望 %q", input, got, want)
		}
	}
}

func TestServiceLogFilterDoesNotMutateOriginalLine(t *testing.T) {
	line := ServiceLogLine{Text: "ERROR database timeout", Stream: "stderr"}
	filter, err := newLogFilter(ServiceLogFilter{Query: "timeout", Streams: []string{"stderr"}})
	if err != nil || !filter(line) {
		t.Fatalf("expected matching filter, err=%v", err)
	}
	if line.Text != "ERROR database timeout" {
		t.Fatalf("filter mutated raw log line: %#v", line)
	}
	regex, err := newLogFilter(ServiceLogFilter{Query: `^error`, Regex: true})
	if err != nil || !regex(line) {
		t.Fatalf("expected case-insensitive regex match, err=%v", err)
	}
	if _, err := newLogFilter(ServiceLogFilter{Query: "[", Regex: true}); err == nil {
		t.Fatal("invalid regex should fail")
	}
}

func TestServiceResourceValidationRejectsUnsafeValues(t *testing.T) {
	if validContainerID("abc; rm -rf /") || validUnitName("nginx.service;id") {
		t.Fatal("unsafe identifiers must be rejected")
	}
	if !validContainerID("0123456789abcdef") || !validUnitName("nginx.service") {
		t.Fatal("valid identifiers were rejected")
	}
}

func TestSaveServiceTargetsRequiresGlobalSSHProfile(t *testing.T) {
	profile := SSHProfile{ID: "profile-1", Name: "生产", Host: "prod.example.com", Username: "deploy", Password: "secret"}
	config := &ConfigService{
		path: filepath.Join(t.TempDir(), "config.json"),
		cfg:  normalizeConfig(Config{SSHProfiles: []SSHProfile{profile}}),
	}
	service := &ServiceManagerService{config: config}
	if err := service.SaveServiceTargets([]ServiceTarget{
		{ID: "local", Name: "本机", Kind: "local"},
		{ID: "ssh:profile-1", Kind: "ssh", SSHProfileID: profile.ID},
	}); err != nil {
		t.Fatalf("有效的全局 SSH 配置引用不应失败: %v", err)
	}
	targets := service.GetServiceTargets()
	if len(targets) != 2 || targets[1].ID != "ssh:profile-1" || targets[1].Name != "生产" {
		t.Fatalf("目标列表未按配置解析: %#v", targets)
	}
	if err := service.SaveServiceTargets([]ServiceTarget{{ID: "ssh:missing", Kind: "ssh", SSHProfileID: "does-not-exist"}}); err == nil {
		t.Fatal("目标引用不存在的全局 SSH 配置时应失败")
	}
}
