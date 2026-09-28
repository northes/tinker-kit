package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestParseDockerVolumeSizes(t *testing.T) {
	sizes := parseDockerVolumeSizes("cache:::1.5MB;;;empty:::0B;;;unknown:::N/A;;;malformed;;;")
	if sizes["cache"] != 1_500_000 {
		t.Fatalf("卷大小解析错误: %#v", sizes)
	}
	if size, ok := sizes["empty"]; !ok || size != 0 {
		t.Fatalf("空卷应保留为可用的 0 字节: %#v", sizes)
	}
	if _, ok := sizes["unknown"]; ok {
		t.Fatalf("未知大小不应伪装为 0 字节: %#v", sizes)
	}
}

func TestOrderedDockerMountsUsesBindDeclarationOrder(t *testing.T) {
	item := dockerInspect{}
	item.Mounts = []dockerMount{
		{Type: "volume", Name: "data", Source: "/var/lib/docker/volumes/data/_data", Destination: "/var/lib/app"},
		{Type: "bind", Source: "/host/config", Destination: "/etc/app"},
		{Type: "tmpfs", Destination: "/run"},
	}
	item.HostConfig.Binds = []string{"/host/config:/etc/app:ro", "data:/var/lib/app:rw"}
	ordered := orderedDockerMounts(item)
	if len(ordered) != 3 || ordered[0].Destination != "/etc/app" || ordered[1].Destination != "/var/lib/app" || ordered[2].Destination != "/run" {
		t.Fatalf("挂载顺序错误: %#v", ordered)
	}
}

func TestParseDUSize(t *testing.T) {
	if size, ok := parseDUSize([]byte("13225536\t/var/lib/dagger\n")); !ok || size != 13_542_948_864 {
		t.Fatalf("du 大小解析错误: size=%d ok=%v", size, ok)
	}
	if _, ok := parseDUSize([]byte("invalid")); ok {
		t.Fatal("无效 du 输出不应被接受")
	}
}

func TestAppendLogLineKeepsAnsiSequences(t *testing.T) {
	ctx := context.Background()
	monitor := &logMonitorState{
		LogMonitor: LogMonitor{ID: "monitor-1", Resource: ServiceResourceRef{Runtime: "docker", ID: "0123456789abcdef"}},
		ctx:        ctx,
		lines:      []ServiceLogLine{},
	}
	service := &ServiceManagerService{monitors: map[string]*logMonitorState{monitor.ID: monitor}}
	service.appendLogLine(ctx, monitor, "stdout", "2026-01-02T03:04:05.000000000Z \x1b[90msrvx 0.11.21\x1b[39m")
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

func TestRemoveLogMonitorDiscardsLateLines(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	monitor := &logMonitorState{LogMonitor: LogMonitor{ID: "local|docker||container"}, ctx: ctx, cancel: cancel}
	service := &ServiceManagerService{monitors: map[string]*logMonitorState{monitor.ID: monitor}}
	if err := service.RemoveLogMonitor(monitor.ID); err != nil {
		t.Fatal(err)
	}
	service.appendLogLine(ctx, monitor, "stdout", "late line")
	if len(service.GetLogMonitors("")) != 0 || len(monitor.lines) != 0 {
		t.Fatal("移除后的监控不应重新出现或接收迟到日志")
	}
}

func TestQueryLogBufferMergesTargetsAndLimitsVisibleLines(t *testing.T) {
	service := &ServiceManagerService{monitors: map[string]*logMonitorState{
		"local":  {LogMonitor: LogMonitor{ID: "local", TargetID: "local"}, lines: []ServiceLogLine{{Sequence: 1, MonitorID: "local", Text: "first"}, {Sequence: 3, MonitorID: "local", Text: "third"}}},
		"remote": {LogMonitor: LogMonitor{ID: "remote", TargetID: "ssh:host"}, lines: []ServiceLogLine{{Sequence: 2, MonitorID: "remote", Text: "second"}}},
	}}
	snapshot, err := service.QueryLogBuffer(QueryLogBufferRequest{MonitorIDs: []string{"local", "remote"}, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Lines) != 2 || snapshot.Lines[0].Sequence != 2 || snapshot.Lines[1].Sequence != 3 {
		t.Fatalf("跨主机日志应按接收顺序合并并保留最近两行: %#v", snapshot.Lines)
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

func TestParseRemoteEnvProbeReadsPathAndCommands(t *testing.T) {
	out := "welcome to the box\n__TK_PATH__ /home/igcdc/.nvm/versions/node/v22.13.1/bin:/usr/bin\n__TK_CMD__ docker /usr/bin/docker\n__TK_CMD__ pm2 /home/igcdc/.nvm/versions/node/v22.13.1/bin/pm2\n__TK_CMD__ systemctl\n"
	env, err := parseRemoteEnvProbe(out)
	if err != nil {
		t.Fatalf("解析远端环境失败: %v", err)
	}
	if env.path != "/home/igcdc/.nvm/versions/node/v22.13.1/bin:/usr/bin" {
		t.Fatalf("PATH 解析错误: %q", env.path)
	}
	if !env.commands["docker"] || !env.commands["pm2"] {
		t.Fatalf("已存在的命令应被标记: %#v", env.commands)
	}
	if env.commands["systemctl"] {
		t.Fatalf("空路径不应被标记为存在: %#v", env.commands)
	}
}

func TestParseRemoteEnvProbeRejectsMissingPath(t *testing.T) {
	if _, err := parseRemoteEnvProbe("__TK_CMD__ pm2 /usr/bin/pm2\n"); err == nil {
		t.Fatal("缺少 PATH 时应报错")
	}
}

func TestRemoteCommandLinePrependsResolvedPath(t *testing.T) {
	service := &ServiceManagerService{ctx: context.Background(), remoteEnv: map[string]remoteCommandEnv{}}
	source := ImageSource{ID: "ssh:p1", Kind: "ssh", SSHHost: "box", SSHUsername: "igcdc", SSHPort: 22}
	service.remoteEnv[remoteEnvKey(source)] = remoteCommandEnv{
		path:       "/home/igcdc/.nvm/versions/node/v22.13.1/bin:/usr/bin",
		commands:   map[string]bool{"pm2": true},
		resolvedAt: time.Now(),
	}
	line, label, err := service.remoteCommandLine(source, "pm2", []string{"jlist"})
	if err != nil {
		t.Fatalf("解析命令失败: %v", err)
	}
	if label != "pm2" {
		t.Fatalf("错误信息命令名应为 pm2: %q", label)
	}
	if want := "PATH='/home/igcdc/.nvm/versions/node/v22.13.1/bin:/usr/bin' 'pm2' 'jlist'"; line != want {
		t.Fatalf("命令串 = %q, 期望 %q", line, want)
	}
}

func TestRemoteCommandLineReportsMissingCommand(t *testing.T) {
	service := &ServiceManagerService{ctx: context.Background(), remoteEnv: map[string]remoteCommandEnv{}}
	source := ImageSource{ID: "ssh:p1", Kind: "ssh", SSHHost: "box", SSHUsername: "igcdc", SSHPort: 22}
	service.remoteEnv[remoteEnvKey(source)] = remoteCommandEnv{
		path:       "/usr/bin",
		commands:   map[string]bool{"pm2": false},
		resolvedAt: time.Now(),
	}
	_, _, err := service.remoteCommandLine(source, "pm2", []string{"jlist"})
	if err == nil || localizedErrorKey(err) != "errors.service.remoteCommandMissing" {
		t.Fatalf("命令缺失时应给出明确错误: %v", err)
	}
}

func TestRemoteCommandLineFallsBackWhenProbeFails(t *testing.T) {
	service := &ServiceManagerService{ctx: context.Background(), remoteEnv: map[string]remoteCommandEnv{}}
	source := ImageSource{ID: "ssh:p1", Kind: "ssh", SSHHost: "box"}
	line, label, err := service.remoteCommandLine(source, "pm2", []string{"jlist"})
	if err != nil {
		t.Fatalf("探测失败不应阻断命令: %v", err)
	}
	if label != "pm2" || line != "'pm2' 'jlist'" {
		t.Fatalf("应退回裸命令: line=%q label=%q", line, label)
	}
}

func TestBuildRemoteEnvProbeScriptIncludesManagersAndCommands(t *testing.T) {
	script := buildRemoteEnvProbeScript(remoteCommandNames)
	for _, want := range []string{".nvm/versions/node/*/bin", ".volta/bin", ".asdf/shims", "__TK_PATH__", "docker", "pm2", "systemctl", "journalctl"} {
		if !strings.Contains(script, want) {
			t.Fatalf("探测脚本缺少 %q: %s", want, script)
		}
	}
}

func TestParseMetricBytesAndPair(t *testing.T) {
	for input, want := range map[string]float64{
		"0B":      0,
		"1.5kB":   1500,
		"2 MiB":   2 * 1024 * 1024,
		"1.25GiB": 1.25 * 1024 * 1024 * 1024,
	} {
		got := parseMetricBytes(input)
		if got == nil || *got != want {
			t.Fatalf("parseMetricBytes(%q) = %v, 期望 %v", input, got, want)
		}
	}
	left, right := parseMetricPair("12.5MB / 2GiB")
	if left == nil || right == nil || *left != 12.5e6 || *right != 2*1024*1024*1024 {
		t.Fatalf("指标对解析错误: left=%v right=%v", left, right)
	}
	if parseMetricBytes("unknown") != nil {
		t.Fatal("无效容量不应伪装为 0")
	}
}

func TestParseHostMetricOutputPreservesUnavailableDisk(t *testing.T) {
	value, err := parseHostMetricOutput("noise\n__TK_METRIC__\tdarwin\t8\t12.5\t1000\t2000\t3000\t4000\t\t\n")
	if err != nil {
		t.Fatalf("解析主机指标失败: %v", err)
	}
	if value.CPUCores != 8 || value.CPUPercent == nil || *value.CPUPercent != 12.5 {
		t.Fatalf("CPU 指标错误: %#v", value)
	}
	if value.NetworkRxBytes == nil || *value.NetworkRxBytes != 3000 || value.NetworkTxBytes == nil || *value.NetworkTxBytes != 4000 {
		t.Fatalf("网络指标错误: %#v", value)
	}
	if value.DiskReadBytes != nil || value.DiskWriteBytes != nil {
		t.Fatalf("不可用的磁盘指标不应伪装为 0: %#v", value)
	}
	availability := hostMetricSample(ServiceTarget{ID: "local", Name: "local"}, value).Availability
	if availability.Disk != "unsupported" {
		t.Fatalf("macOS 磁盘指标应明确标记不支持: %#v", availability)
	}
}

func TestHostMetricScriptReturnsParsableLocalSnapshot(t *testing.T) {
	out, err := exec.Command("sh", "-lc", hostMetricScript).CombinedOutput()
	if err != nil {
		t.Fatalf("本机性能脚本执行失败: %v\n%s", err, out)
	}
	value, err := parseHostMetricOutput(string(out))
	if err != nil {
		t.Fatalf("本机性能脚本输出无法解析: %v\n%s", err, out)
	}
	if value.System == "" || value.CPUCores < 1 {
		t.Fatalf("本机性能脚本缺少平台或核心数: %#v\n%s", value, out)
	}
}

func TestParseSystemdMetricOutputKeepsAccountingState(t *testing.T) {
	values := parseSystemdMetricOutput("Id=api.service\nActiveState=active\nCPUUsageNSec=1200000000\nMemoryCurrent=4096\nMemoryMax=infinity\nIOReadBytes=1024\nIOWriteBytes=2048\nIPIngressBytes=[not set]\nIPEgressBytes=[not set]\n\n")
	value, ok := values["api.service"]
	if !ok || value.CPUTimeNS == nil || value.MemoryBytes == nil {
		t.Fatalf("systemd 基础指标缺失: %#v", values)
	}
	if value.MemoryLimit != nil || value.NetworkRxBytes != nil || value.NetworkTxBytes != nil {
		t.Fatalf("未启用的 systemd accounting 不应产生数值: %#v", value)
	}
	if value.DiskReadBytes == nil || *value.DiskReadBytes != 1024 || value.DiskWriteBytes == nil || *value.DiskWriteBytes != 2048 {
		t.Fatalf("systemd 磁盘计数错误: %#v", value)
	}
}

func TestAggregateComposeMetricsMarksPartialValues(t *testing.T) {
	cpu := 10.0
	memory := 1024.0
	containers := []DockerContainer{
		{ID: "aaaaaaaaaaaa", Name: "api", ComposeProject: "demo", Running: true},
		{ID: "bbbbbbbbbbbb", Name: "worker", ComposeProject: "demo", Running: false},
	}
	groups, _ := groupDockerContainers(containers)
	resources := []ServiceMetricSample{
		{ID: containers[0].ID, CPUPercent: &cpu, MemoryBytes: &memory},
		{ID: containers[1].ID},
	}
	result := aggregateComposeMetrics(ServiceTarget{ID: "local"}, groups, resources, 8)
	if len(result) != 1 || !result[0].Partial {
		t.Fatalf("部分可用的 Compose 应标记 partial: %#v", result)
	}
	if result[0].Availability.CPU != "partial" || result[0].Availability.Network != "unavailable" {
		t.Fatalf("Compose 可用性聚合错误: %#v", result[0].Availability)
	}
}
