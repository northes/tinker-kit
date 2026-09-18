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
