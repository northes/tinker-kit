package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	serviceCommandTimeout = 20 * time.Second
	serviceSizeTimeout    = 2 * time.Minute
	serviceUpdateTimeout  = 10 * time.Minute
	serviceLogBufferBytes = 20 << 20
	serviceLogTotalBytes  = 64 << 20
	serviceLogMaxActive   = 16
	serviceLogTail        = 500
	remoteEnvProbeTimeout = 8 * time.Second
	remoteEnvTTL          = 10 * time.Minute
)

// remoteCommandNames 是需要通过远端环境解析的命令。这些命令可能只存在于
// 交互式登录 shell 的 PATH 中（典型是 nvm/volta 等版本管理器），非交互式
// SSH 会话默认 PATH 找不到它们。
var remoteCommandNames = []string{"docker", "docker-compose", "pm2", "systemctl", "journalctl"}

type ServiceTarget struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	SSHProfileID string `json:"sshProfileID,omitempty"`
}

type ServiceRuntimeStatus struct {
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
}

type DockerContainer struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Image          string            `json:"image"`
	Status         string            `json:"status"`
	Running        bool              `json:"running"`
	CreatedAt      string            `json:"createdAt"`
	Ports          []string          `json:"ports"`
	Labels         map[string]string `json:"labels"`
	ComposeProject string            `json:"composeProject,omitempty"`
	ComposeService string            `json:"composeService,omitempty"`
}

type DockerComposeGroup struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Containers []DockerContainer `json:"containers"`
}

type PM2Process struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	PID         int     `json:"pid"`
	Restarts    int     `json:"restarts"`
	Uptime      int64   `json:"uptime"`
	CPU         float64 `json:"cpu"`
	Memory      int64   `json:"memory"`
	Script      string  `json:"script"`
	CWD         string  `json:"cwd"`
	Interpreter string  `json:"interpreter"`
}

type SystemdUnit struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	LoadState   string `json:"loadState"`
	ActiveState string `json:"activeState"`
	SubState    string `json:"subState"`
	Scope       string `json:"scope"`
}

type ServiceInventory struct {
	Target       ServiceTarget        `json:"target"`
	Docker       ServiceRuntimeStatus `json:"docker"`
	PM2          ServiceRuntimeStatus `json:"pm2"`
	Systemd      ServiceRuntimeStatus `json:"systemd"`
	DockerGroups []DockerComposeGroup `json:"dockerGroups"`
	Containers   []DockerContainer    `json:"containers"`
	PM2Processes []PM2Process         `json:"pm2Processes"`
	SystemUnits  []SystemdUnit        `json:"systemUnits"`
}

type ServiceResourceRef struct {
	Runtime string `json:"runtime"`
	ID      string `json:"id"`
	Scope   string `json:"scope,omitempty"`
	Name    string `json:"name,omitempty"`
	Group   string `json:"group,omitempty"`
}

type ServiceActionRequest struct {
	TargetID string             `json:"targetID"`
	Resource ServiceResourceRef `json:"resource"`
	Action   string             `json:"action"`
}

type ServiceActionItemResult struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Error string `json:"error,omitempty"`
}

type ServiceActionResult struct {
	Succeeded []ServiceActionItemResult `json:"succeeded"`
	Failed    []ServiceActionItemResult `json:"failed"`
}

type DockerContainerDetail struct {
	Container     DockerContainer `json:"container"`
	Command       []string        `json:"command"`
	Entrypoint    []string        `json:"entrypoint"`
	Mounts        []string        `json:"mounts"`
	Networks      []string        `json:"networks"`
	RestartPolicy string          `json:"restartPolicy"`
}

type DockerContainerMountSize struct {
	Type        string `json:"type"`
	Name        string `json:"name,omitempty"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Size        int64  `json:"size"`
	Available   bool   `json:"available"`
}

type DockerContainerSize struct {
	Total     int64                      `json:"total"`
	Container int64                      `json:"container"`
	Mounts    []DockerContainerMountSize `json:"mounts"`
	Complete  bool                       `json:"complete"`
}

type PM2ProcessDetail struct {
	Process PM2Process `json:"process"`
}
type SystemdUnitDetail struct {
	Unit         SystemdUnit `json:"unit"`
	MainPID      int         `json:"mainPID"`
	ExecStart    string      `json:"execStart"`
	FragmentPath string      `json:"fragmentPath"`
}

type ServiceLogLine struct {
	Sequence   uint64 `json:"sequence"`
	MonitorID  string `json:"monitorID"`
	Runtime    string `json:"runtime"`
	ResourceID string `json:"resourceID"`
	Name       string `json:"name"`
	Timestamp  string `json:"timestamp,omitempty"`
	ReceivedAt string `json:"receivedAt"`
	Stream     string `json:"stream"`
	Text       string `json:"text"`
}

type LogMonitor struct {
	ID        string             `json:"id"`
	TargetID  string             `json:"targetID"`
	Resource  ServiceResourceRef `json:"resource"`
	State     string             `json:"state"`
	Error     string             `json:"error,omitempty"`
	Truncated bool               `json:"truncated"`
}

type StartLogMonitorsRequest struct {
	TargetID  string               `json:"targetID"`
	Resources []ServiceResourceRef `json:"resources"`
}

type ServiceLogFilter struct {
	Query         string   `json:"query"`
	Regex         bool     `json:"regex"`
	CaseSensitive bool     `json:"caseSensitive"`
	Streams       []string `json:"streams"`
}

type QueryLogBufferRequest struct {
	MonitorIDs []string         `json:"monitorIDs"`
	Filter     ServiceLogFilter `json:"filter"`
	Limit      int              `json:"limit,omitempty"`
}

type ServiceLogSnapshot struct {
	Lines       []ServiceLogLine `json:"lines"`
	MaxSequence uint64           `json:"maxSequence"`
	Truncated   bool             `json:"truncated"`
}

type serviceLogEvent struct {
	Lines []ServiceLogLine `json:"lines"`
}

type logMonitorState struct {
	LogMonitor
	ctx    context.Context
	cancel context.CancelFunc
	lines  []ServiceLogLine
	bytes  int
	batch  []ServiceLogLine
}

type ServiceManagerService struct {
	config      *ConfigService
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	monitors    map[string]*logMonitorState
	remoteEnvMu sync.Mutex
	remoteEnv   map[string]remoteCommandEnv
	emit        func(string, any)
	sequence    atomic.Uint64

	metricMu        sync.Mutex
	metricRunning   bool
	metricCtx       context.Context
	metricCancel    context.CancelFunc
	metricTargets   []string
	metricSequence  uint64
	metricPoints    []ServiceMetricTrendPoint
	metricRaw       map[string]serviceMetricRaw
	metricSnapshots map[string]ServiceMetricSnapshot

	composeMu    sync.Mutex
	composeCache map[string]composeCommand
}

// remoteCommandEnv 是远端登录 shell 解析出的执行环境：登录 PATH 与命令可解析状态。
type remoteCommandEnv struct {
	path       string
	commands   map[string]bool
	resolvedAt time.Time
}

func NewServiceManagerService(config *ConfigService) *ServiceManagerService {
	ctx, cancel := context.WithCancel(context.Background())
	return &ServiceManagerService{config: config, ctx: ctx, cancel: cancel, monitors: map[string]*logMonitorState{}, remoteEnv: map[string]remoteCommandEnv{}, metricRaw: map[string]serviceMetricRaw{}, metricSnapshots: map[string]ServiceMetricSnapshot{}, composeCache: map[string]composeCommand{}}
}
func (s *ServiceManagerService) ServiceName() string                    { return "ServiceManagerService" }
func (s *ServiceManagerService) setEventEmitter(emit func(string, any)) { s.emit = emit }
func (s *ServiceManagerService) shutdown() {
	if s != nil && s.cancel != nil {
		s.cancel()
	}
}

func copyServiceTargets(items []ServiceTarget) []ServiceTarget {
	return append([]ServiceTarget(nil), items...)
}

// GetServiceTargets 返回配置中选择的目标主机，而不是全部 SSH 配置。
func (s *ServiceManagerService) GetServiceTargets() []ServiceTarget {
	if s == nil || s.config == nil {
		return defaultServiceTargets()
	}
	return copyServiceTargets(s.config.Get().ServiceTargets)
}

// SaveServiceTargets 只持久化容器与服务工具选择的目标主机；SSH 凭据保存在
// ConfigService.SSHProfiles，目标仅引用配置 ID。
func (s *ServiceManagerService) SaveServiceTargets(targets []ServiceTarget) error {
	if s == nil || s.config == nil {
		return userError("errors.common.configNotInitialized")
	}
	targets = copyServiceTargets(targets)
	return s.config.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		names := make(map[string]string, len(cfg.SSHProfiles))
		for _, profile := range cfg.SSHProfiles {
			names[profile.ID] = profile.Name
		}
		normalized := defaultServiceTargets()
		seen := map[string]bool{"local": true}
		for index, target := range targets {
			kind := strings.TrimSpace(strings.ToLower(target.Kind))
			if kind == "" || kind == "local" {
				continue
			}
			if kind != "ssh" {
				return userErrorParams("errors.service.targetKindInvalid", map[string]any{"index": index + 1})
			}
			profileID := strings.TrimSpace(target.SSHProfileID)
			if profileID == "" && strings.HasPrefix(strings.TrimSpace(target.ID), "ssh:") {
				profileID = strings.TrimPrefix(strings.TrimSpace(target.ID), "ssh:")
			}
			if profileID == "" {
				return userErrorParams("errors.service.targetMissingSSH", map[string]any{"index": index + 1})
			}
			if _, ok := names[profileID]; !ok {
				known := make([]string, 0, len(names))
				for id := range names {
					known = append(known, id)
				}
				sort.Strings(known)
				return userErrorParams("errors.service.targetSSHProfileMissing", map[string]any{"index": index + 1, "profileID": profileID, "available": strings.Join(known, ", ")})
			}
			id := "ssh:" + profileID
			if seen[id] {
				continue
			}
			seen[id] = true
			name := strings.TrimSpace(target.Name)
			if name == "" {
				name = names[profileID]
			}
			if name == "" {
				name = profileID
			}
			if !validTextValue(name, 128) {
				return userErrorParams("errors.service.targetNameInvalid", map[string]any{"index": index + 1})
			}
			normalized = append(normalized, ServiceTarget{ID: id, Name: name, Kind: "ssh", SSHProfileID: profileID})
		}
		cfg.ServiceTargets = normalized
		return nil
	})
}

func (s *ServiceManagerService) targetSnapshot(id string) (ServiceTarget, ImageSource, string, error) {
	id = strings.TrimSpace(id)
	if id == "local" {
		cli := "docker"
		if s != nil && s.config != nil && s.config.Get().DockerCLIPath != "" {
			cli = s.config.Get().DockerCLIPath
		}
		return ServiceTarget{ID: "local", Name: "local", Kind: "local"}, ImageSource{ID: "local", Name: "本机", Kind: "local"}, cli, nil
	}
	if !strings.HasPrefix(id, "ssh:") || s == nil || s.config == nil {
		return ServiceTarget{}, ImageSource{}, "", userError("errors.service.targetNotFound")
	}
	profileID := strings.TrimPrefix(id, "ssh:")
	for _, profile := range s.config.GetSSHProfiles() {
		if profile.ID != profileID {
			continue
		}
		source := imageSourceFromSSHProfile(ImageSource{ID: id, Name: profile.Name, Kind: "ssh", SSHProfileID: profile.ID}, profile)
		return ServiceTarget{ID: id, Name: profile.Name, Kind: "ssh", SSHProfileID: profile.ID}, source, "docker", nil
	}
	return ServiceTarget{}, ImageSource{}, "", userError("errors.service.targetSSHProfileNotFound")
}

func (s *ServiceManagerService) run(ctx context.Context, source ImageSource, command string, args ...string) ([]byte, error) {
	if source.Kind == "local" {
		out, err := exec.CommandContext(ctx, command, args...).CombinedOutput()
		if err != nil {
			return out, userErrorParamsCause("errors.service.commandFailed", map[string]any{"command": command}, err)
		}
		return out, nil
	}
	name, label, err := s.remoteCommandLine(source, command, args)
	if err != nil {
		return nil, err
	}
	return runAuthenticatedSSHLine(ctx, source, label, "zh-CN", name)
}

// remoteCommandLine 返回远端命令的执行串与错误信息用的命令名。它会先用远端
// 登录 shell 解析出的 PATH 前置，使 nvm/volta 等仅存在于交互式 PATH 的命令
// 也能被找到；探测失败时退回裸命令，不因探测本身改变可用性。
func (s *ServiceManagerService) remoteCommandLine(source ImageSource, command string, args []string) (string, string, error) {
	env, ok := s.remoteCommandEnv(source)
	if !ok || env.path == "" {
		return shellJoin(append([]string{command}, args...)), command, nil
	}
	if found, checked := env.commands[command]; checked && !found {
		return "", "", userErrorParams("errors.service.remoteCommandMissing", map[string]any{"command": command})
	}
	return "PATH=" + shellQuote(env.path) + " " + shellJoin(append([]string{command}, args...)), command, nil
}

// remoteEnvKey 用连接信息标识一次远端环境解析，SSH 配置变化时自动重新探测。
func remoteEnvKey(source ImageSource) string {
	return source.ID + "|" + source.SSHHost + "|" + source.SSHUsername + "|" + strconv.Itoa(source.SSHPort)
}

func (s *ServiceManagerService) remoteCommandEnv(source ImageSource) (remoteCommandEnv, bool) {
	key := remoteEnvKey(source)
	s.remoteEnvMu.Lock()
	cached, ok := s.remoteEnv[key]
	s.remoteEnvMu.Unlock()
	if ok && time.Since(cached.resolvedAt) < remoteEnvTTL {
		return cached, true
	}
	probeCtx, cancel := context.WithTimeout(s.ctx, remoteEnvProbeTimeout)
	defer cancel()
	env, err := probeRemoteCommandEnv(probeCtx, source)
	if err != nil {
		return remoteCommandEnv{}, false
	}
	env.resolvedAt = time.Now()
	s.remoteEnvMu.Lock()
	s.remoteEnv[key] = env
	s.remoteEnvMu.Unlock()
	return env, true
}

// probeRemoteCommandEnv 通过远端登录 shell 解析 PATH：先取登录 shell 的 PATH，
// 再补上版本管理器与常见安装目录，最后逐条确认目标命令是否存在。
func probeRemoteCommandEnv(ctx context.Context, source ImageSource) (remoteCommandEnv, error) {
	script := buildRemoteEnvProbeScript(remoteCommandNames)
	var lastErr error
	for _, sh := range []string{"bash", "zsh", "sh"} {
		out, err := runAuthenticatedSSH(ctx, source, sh, "zh-CN", "-lc", script)
		if err != nil {
			lastErr = err
			continue
		}
		if ctx.Err() != nil {
			return remoteCommandEnv{}, ctx.Err()
		}
		env, err := parseRemoteEnvProbe(string(out))
		if err != nil {
			lastErr = err
			continue
		}
		return env, nil
	}
	if lastErr == nil {
		lastErr = errors.New("远端 shell 环境探测失败")
	}
	return remoteCommandEnv{}, lastErr
}

func buildRemoteEnvProbeScript(commands []string) string {
	var b strings.Builder
	b.WriteString("p=$PATH\n")
	b.WriteString(`for d in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.asdf/shims" "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.volta/bin" "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && p="$d:$p"; done` + "\n")
	b.WriteString("PATH=$p; export PATH\n")
	b.WriteString("printf '__TK_PATH__ %s\\n' \"$PATH\"\n")
	b.WriteString("for c in")
	for _, command := range commands {
		b.WriteString(" " + command)
	}
	b.WriteString("; do printf '__TK_CMD__ %s %s\\n' \"$c\" \"$(command -v \"$c\" 2>/dev/null)\"; done\n")
	return b.String()
}

func parseRemoteEnvProbe(out string) (remoteCommandEnv, error) {
	env := remoteCommandEnv{commands: map[string]bool{}}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "__TK_PATH__ "); ok {
			env.path = strings.TrimSpace(rest)
			continue
		}
		if rest, ok := strings.CutPrefix(line, "__TK_CMD__ "); ok {
			name, path, _ := strings.Cut(rest, " ")
			if name != "" {
				env.commands[name] = strings.TrimSpace(path) != ""
			}
		}
	}
	if env.path == "" {
		return remoteCommandEnv{}, errors.New("解析远端 shell 环境失败")
	}
	return env, nil
}

func (s *ServiceManagerService) GetServiceInventory(targetID string) ServiceInventory {
	target, source, dockerCLI, err := s.targetSnapshot(targetID)
	if err != nil {
		return ServiceInventory{Target: ServiceTarget{ID: targetID}, Docker: ServiceRuntimeStatus{Error: err.Error()}, PM2: ServiceRuntimeStatus{Error: err.Error()}, Systemd: ServiceRuntimeStatus{Error: err.Error()}}
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceCommandTimeout)
	defer cancel()
	result := ServiceInventory{Target: target, DockerGroups: []DockerComposeGroup{}, Containers: []DockerContainer{}, PM2Processes: []PM2Process{}, SystemUnits: []SystemdUnit{}}
	if containers, e := s.listContainers(ctx, source, dockerCLI); e != nil {
		result.Docker.Error = e.Error()
	} else {
		result.Docker.Available = true
		result.DockerGroups, result.Containers = groupDockerContainers(containers)
	}
	if processes, e := s.listPM2(ctx, source); e != nil {
		result.PM2.Error = e.Error()
	} else {
		result.PM2.Available = true
		result.PM2Processes = processes
	}
	if units, e := s.listSystemd(ctx, source, "system"); e != nil {
		result.Systemd.Error = e.Error()
	} else {
		result.Systemd.Available = true
		result.SystemUnits = append(result.SystemUnits, units...)
	}
	if units, e := s.listSystemd(ctx, source, "user"); e == nil {
		result.Systemd.Available = true
		result.SystemUnits = append(result.SystemUnits, units...)
	} else if !result.Systemd.Available && result.Systemd.Error == "" {
		result.Systemd.Error = e.Error()
	}
	return result
}

type dockerInspect struct {
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Created string `json:"Created"`
	SizeRw  int64  `json:"SizeRw"`
	Config  struct {
		Image      string            `json:"Image"`
		Labels     map[string]string `json:"Labels"`
		Cmd        []string          `json:"Cmd"`
		Entrypoint []string          `json:"Entrypoint"`
	} `json:"Config"`
	State struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
		Networks map[string]any `json:"Networks"`
	} `json:"NetworkSettings"`
	Mounts     []dockerMount `json:"Mounts"`
	HostConfig struct {
		Binds         []string `json:"Binds"`
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
}

type dockerMount struct {
	Name        string `json:"Name"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	Type        string `json:"Type"`
}

func orderedDockerMounts(item dockerInspect) []dockerMount {
	if len(item.HostConfig.Binds) == 0 || len(item.Mounts) < 2 {
		return item.Mounts
	}
	ordered := make([]dockerMount, 0, len(item.Mounts))
	used := make([]bool, len(item.Mounts))
	for _, bind := range item.HostConfig.Binds {
		for index, mount := range item.Mounts {
			if used[index] || !dockerBindTargetsMount(bind, mount.Destination) {
				continue
			}
			ordered = append(ordered, mount)
			used[index] = true
			break
		}
	}
	for index, mount := range item.Mounts {
		if !used[index] {
			ordered = append(ordered, mount)
		}
	}
	return ordered
}

func dockerBindTargetsMount(bind, destination string) bool {
	return strings.HasSuffix(bind, ":"+destination) || strings.Contains(bind, ":"+destination+":")
}

func (s *ServiceManagerService) listContainers(ctx context.Context, source ImageSource, cli string) ([]DockerContainer, error) {
	idsOut, err := s.run(ctx, source, cli, "container", "ls", "-aq", "--no-trunc")
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(idsOut))
	if len(ids) == 0 {
		return []DockerContainer{}, nil
	}
	args := append([]string{"container", "inspect"}, ids...)
	out, err := s.run(ctx, source, cli, args...)
	if err != nil {
		return nil, err
	}
	var raw []dockerInspect
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, userError("errors.service.dockerInventoryParseFailed")
	}
	containers := make([]DockerContainer, 0, len(raw))
	for _, item := range raw {
		containers = append(containers, dockerContainerFromInspect(item))
	}
	sort.Slice(containers, func(i, j int) bool { return containers[i].Name < containers[j].Name })
	return containers, nil
}
func dockerContainerFromInspect(item dockerInspect) DockerContainer {
	ports := []string{}
	for internal, values := range item.NetworkSettings.Ports {
		for _, value := range values {
			ports = append(ports, value.HostIP+":"+value.HostPort+"→"+internal)
		}
	}
	sort.Strings(ports)
	labels := item.Config.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	return DockerContainer{ID: item.ID, Name: strings.TrimPrefix(item.Name, "/"), Image: item.Config.Image, Status: item.State.Status, Running: item.State.Running, CreatedAt: item.Created, Ports: ports, Labels: labels, ComposeProject: labels["com.docker.compose.project"], ComposeService: labels["com.docker.compose.service"]}
}
func groupDockerContainers(containers []DockerContainer) ([]DockerComposeGroup, []DockerContainer) {
	byProject := map[string][]DockerContainer{}
	standalone := []DockerContainer{}
	for _, c := range containers {
		if c.ComposeProject == "" {
			standalone = append(standalone, c)
		} else {
			byProject[c.ComposeProject] = append(byProject[c.ComposeProject], c)
		}
	}
	groups := make([]DockerComposeGroup, 0, len(byProject))
	for name, items := range byProject {
		sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
		groups = append(groups, DockerComposeGroup{ID: "compose:" + name, Name: name, Containers: items})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
	return groups, standalone
}

func (s *ServiceManagerService) listPM2(ctx context.Context, source ImageSource) ([]PM2Process, error) {
	out, err := s.run(ctx, source, "pm2", "jlist")
	if err != nil {
		return nil, err
	}
	var values []struct {
		Name   string `json:"name"`
		PMID   int    `json:"pm_id"`
		PID    int    `json:"pid"`
		PM2Env struct {
			Status      string `json:"status"`
			RestartTime int    `json:"restart_time"`
			PMUptime    int64  `json:"pm_uptime"`
			ExecPath    string `json:"pm_exec_path"`
			CWD         string `json:"pm_cwd"`
			Interpreter string `json:"exec_interpreter"`
		} `json:"pm2_env"`
		Monit struct {
			CPU    float64 `json:"cpu"`
			Memory int64   `json:"memory"`
		} `json:"monit"`
	}
	if err := json.Unmarshal(out, &values); err != nil {
		return nil, userError("errors.service.pm2ParseFailed")
	}
	result := make([]PM2Process, 0, len(values))
	for _, v := range values {
		result = append(result, PM2Process{ID: strconv.Itoa(v.PMID), Name: v.Name, Status: v.PM2Env.Status, PID: v.PID, Restarts: v.PM2Env.RestartTime, Uptime: v.PM2Env.PMUptime, CPU: v.Monit.CPU, Memory: v.Monit.Memory, Script: v.PM2Env.ExecPath, CWD: v.PM2Env.CWD, Interpreter: v.PM2Env.Interpreter})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (s *ServiceManagerService) listSystemd(ctx context.Context, source ImageSource, scope string) ([]SystemdUnit, error) {
	args := []string{"list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"}
	if scope == "user" {
		args = append([]string{"--user"}, args...)
	}
	out, err := s.run(ctx, source, "systemctl", args...)
	if err != nil {
		return nil, err
	}
	units := []SystemdUnit{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		desc := ""
		if len(fields) > 4 {
			desc = strings.Join(fields[4:], " ")
		}
		units = append(units, SystemdUnit{ID: fields[0], Name: fields[0], LoadState: fields[1], ActiveState: fields[2], SubState: fields[3], Description: desc, Scope: scope})
	}
	return units, nil
}

func (s *ServiceManagerService) GetDockerContainerDetail(targetID, id string) (DockerContainerDetail, error) {
	target, source, cli, err := s.targetSnapshot(targetID)
	_ = target
	if err != nil {
		return DockerContainerDetail{}, err
	}
	if !validContainerID(id) {
		return DockerContainerDetail{}, userError("errors.service.containerIDInvalid")
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceCommandTimeout)
	defer cancel()
	out, err := s.run(ctx, source, cli, "container", "inspect", id)
	if err != nil {
		return DockerContainerDetail{}, err
	}
	var raw []dockerInspect
	if json.Unmarshal(out, &raw) != nil || len(raw) != 1 {
		return DockerContainerDetail{}, userError("errors.service.dockerDetailParseFailed")
	}
	v := raw[0]
	detail := DockerContainerDetail{Container: dockerContainerFromInspect(v), Command: v.Config.Cmd, Entrypoint: v.Config.Entrypoint, Mounts: []string{}, Networks: []string{}, RestartPolicy: v.HostConfig.RestartPolicy.Name}
	for _, m := range orderedDockerMounts(v) {
		detail.Mounts = append(detail.Mounts, m.Type+": "+m.Source+" → "+m.Destination)
	}
	for n := range v.NetworkSettings.Networks {
		detail.Networks = append(detail.Networks, n)
	}
	sort.Strings(detail.Networks)
	return detail, nil
}

func (s *ServiceManagerService) GetDockerContainerSize(targetID, id string) (DockerContainerSize, error) {
	target, source, cli, err := s.targetSnapshot(targetID)
	_ = target
	if err != nil {
		return DockerContainerSize{}, err
	}
	if !validContainerID(id) {
		return DockerContainerSize{}, userError("errors.service.containerIDInvalid")
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceSizeTimeout)
	defer cancel()
	out, err := s.run(ctx, source, cli, "container", "inspect", "--size", id)
	if err != nil {
		return DockerContainerSize{}, err
	}
	var raw []dockerInspect
	if json.Unmarshal(out, &raw) != nil || len(raw) != 1 {
		return DockerContainerSize{}, userError("errors.service.dockerDetailParseFailed")
	}
	v := raw[0]
	result := DockerContainerSize{Container: v.SizeRw, Total: v.SizeRw, Mounts: []DockerContainerMountSize{}, Complete: true}
	needsVolumeFallback := false
	for _, mount := range orderedDockerMounts(v) {
		if mount.Type != "volume" && mount.Type != "bind" {
			continue
		}
		item := DockerContainerMountSize{Type: mount.Type, Name: mount.Name, Source: mount.Source, Destination: mount.Destination}
		if mount.Type == "bind" {
			item.Size, item.Available = s.hostPathSize(ctx, source, mount.Source)
		} else if v.State.Running {
			item.Size, item.Available = s.containerPathSize(ctx, source, cli, id, mount.Destination)
			needsVolumeFallback = needsVolumeFallback || !item.Available
		} else {
			needsVolumeFallback = true
		}
		result.Mounts = append(result.Mounts, item)
	}
	volumeSizes := map[string]int64{}
	volumeSizesAvailable := true
	if needsVolumeFallback {
		volumeSizes, volumeSizesAvailable = s.dockerVolumeSizes(ctx, source, cli)
	}
	for index := range result.Mounts {
		item := &result.Mounts[index]
		if item.Type == "volume" && !item.Available && volumeSizesAvailable {
			item.Size, item.Available = volumeSizes[item.Name]
		}
		if item.Available {
			result.Total += item.Size
		} else {
			result.Complete = false
		}
	}
	return result, nil
}

const dockerVolumeSizeFormat = `{{range .Volumes}}{{.Name}}:::{{.Size}};;;{{end}}`

func (s *ServiceManagerService) dockerVolumeSizes(ctx context.Context, source ImageSource, cli string) (map[string]int64, bool) {
	out, err := s.run(ctx, source, cli, "system", "df", "--verbose", "--format", dockerVolumeSizeFormat)
	if err != nil {
		return map[string]int64{}, false
	}
	return parseDockerVolumeSizes(string(out)), true
}

func parseDockerVolumeSizes(output string) map[string]int64 {
	result := map[string]int64{}
	for _, item := range strings.Split(output, ";;;") {
		name, value, ok := strings.Cut(strings.TrimSpace(item), ":::")
		if !ok || name == "" {
			continue
		}
		if size, valid := parseDockerDiskSize(value); valid {
			result[name] = size
		}
	}
	return result
}

func parseDockerDiskSize(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.EqualFold(trimmed, "N/A") {
		return 0, false
	}
	if trimmed == "0" || strings.EqualFold(trimmed, "0B") {
		return 0, true
	}
	size := parseDockerImageSize(trimmed)
	return size, size > 0
}

func (s *ServiceManagerService) hostPathSize(ctx context.Context, source ImageSource, path string) (int64, bool) {
	out, err := s.run(ctx, source, "du", "-sk", "--", path)
	if err != nil {
		return 0, false
	}
	return parseDUSize(out)
}

func (s *ServiceManagerService) containerPathSize(ctx context.Context, source ImageSource, cli, id, path string) (int64, bool) {
	out, err := s.run(ctx, source, cli, "exec", id, "du", "-sk", "--", path)
	if err != nil {
		return 0, false
	}
	return parseDUSize(out)
}

func parseDUSize(out []byte) (int64, bool) {
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return 0, false
	}
	blocks, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || blocks < 0 || blocks > (1<<63-1)/1024 {
		return 0, false
	}
	return blocks * 1024, true
}
func (s *ServiceManagerService) GetPM2ProcessDetail(targetID, id string) (PM2ProcessDetail, error) {
	target, source, _, err := s.targetSnapshot(targetID)
	_ = target
	if err != nil {
		return PM2ProcessDetail{}, err
	}
	if _, err = strconv.Atoi(id); err != nil {
		return PM2ProcessDetail{}, userError("errors.service.pm2IDInvalid")
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceCommandTimeout)
	defer cancel()
	items, err := s.listPM2(ctx, source)
	if err != nil {
		return PM2ProcessDetail{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return PM2ProcessDetail{Process: item}, nil
		}
	}
	return PM2ProcessDetail{}, userError("errors.service.pm2ProcessNotFound")
}
func (s *ServiceManagerService) GetSystemdUnitDetail(targetID, id, scope string) (SystemdUnitDetail, error) {
	_, source, _, err := s.targetSnapshot(targetID)
	if err != nil {
		return SystemdUnitDetail{}, err
	}
	if !validUnitName(id) {
		return SystemdUnitDetail{}, userError("errors.service.systemdUnitInvalid")
	}
	if scope != "user" {
		scope = "system"
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceCommandTimeout)
	defer cancel()
	units, err := s.listSystemd(ctx, source, scope)
	if err != nil {
		return SystemdUnitDetail{}, err
	}
	var unit SystemdUnit
	for _, v := range units {
		if v.ID == id {
			unit = v
			break
		}
	}
	if unit.ID == "" {
		return SystemdUnitDetail{}, userError("errors.service.systemdUnitNotFound")
	}
	args := []string{"show", id, "--property=MainPID,ExecStart,FragmentPath", "--no-pager"}
	if scope == "user" {
		args = append([]string{"--user"}, args...)
	}
	out, err := s.run(ctx, source, "systemctl", args...)
	if err != nil {
		return SystemdUnitDetail{}, err
	}
	d := SystemdUnitDetail{Unit: unit}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "MainPID":
			d.MainPID, _ = strconv.Atoi(v)
		case "ExecStart":
			d.ExecStart = v
		case "FragmentPath":
			d.FragmentPath = v
		}
	}
	return d, nil
}

func validContainerID(id string) bool {
	return regexp.MustCompile(`^[a-fA-F0-9]{12,64}$`).MatchString(id)
}
func validUnitName(id string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9_.@:-]+\.service$`).MatchString(id)
}

func (s *ServiceManagerService) PerformServiceAction(req ServiceActionRequest) ServiceActionResult {
	if strings.HasPrefix(req.Action, "update-") && req.Action != "update-pull" && req.Action != "update-start" {
		return serviceActionFailure(req.Resource, userError("errors.service.dockerActionUnsupported"))
	}
	_, source, cli, err := s.targetSnapshot(req.TargetID)
	if err != nil {
		return serviceActionFailure(req.Resource, err)
	}
	timeout := serviceCommandTimeout
	if strings.HasPrefix(req.Action, "update-") {
		timeout = serviceUpdateTimeout
	}
	ctx, cancel := context.WithTimeout(s.ctx, timeout)
	defer cancel()

	// Compose 管理的资源（分组或分组内容器）统一走 compose 命令，不再逐容器调用
	// docker container，避免重启等操作与 compose 的编排状态脱节。
	if isComposeResource(req.Resource) {
		return s.performComposeAction(ctx, source, cli, req)
	}
	if err := s.performOne(ctx, source, cli, req.Resource, req.Action); err != nil {
		return serviceActionFailure(req.Resource, err)
	}
	return ServiceActionResult{Succeeded: []ServiceActionItemResult{{ID: req.Resource.ID, Name: req.Resource.Name}}, Failed: []ServiceActionItemResult{}}
}

func serviceActionFailure(resource ServiceResourceRef, err error) ServiceActionResult {
	return ServiceActionResult{Succeeded: []ServiceActionItemResult{}, Failed: []ServiceActionItemResult{{ID: resource.ID, Name: resource.Name, Error: err.Error()}}}
}

func isComposeResource(resource ServiceResourceRef) bool {
	return resource.Runtime == "docker-compose" || (resource.Runtime == "docker" && resource.Group != "")
}

// performComposeAction 把分组或其成员的操作折叠成一次 compose 调用：先按项目解析出
// 目标容器与服务名，再复用 compose 的项目目录与配置文件信息执行。
func (s *ServiceManagerService) performComposeAction(ctx context.Context, source ImageSource, cli string, req ServiceActionRequest) ServiceActionResult {
	containers, err := s.listContainers(ctx, source, cli)
	if err != nil {
		return serviceActionFailure(req.Resource, err)
	}
	project := req.Resource.Group
	if req.Resource.Runtime == "docker-compose" {
		project = strings.TrimPrefix(req.Resource.ID, "compose:")
	}
	if project == "" {
		return serviceActionFailure(req.Resource, userError("errors.service.composeProjectNotFound"))
	}
	selected := make([]DockerContainer, 0, len(containers))
	found := false
	for _, container := range containers {
		if container.ComposeProject != project {
			continue
		}
		if req.Resource.Runtime == "docker" && container.ID != req.Resource.ID {
			continue
		}
		if container.ID == req.Resource.ID {
			found = true
		}
		selected = append(selected, container)
	}
	if len(selected) == 0 || (req.Resource.Runtime == "docker" && !found) {
		return serviceActionFailure(req.Resource, userError("errors.service.composeProjectNotFound"))
	}
	if err := s.runComposeAction(ctx, source, cli, project, selected, req.Action); err != nil {
		return serviceActionFailure(req.Resource, err)
	}
	return ServiceActionResult{Succeeded: []ServiceActionItemResult{{ID: req.Resource.ID, Name: req.Resource.Name}}, Failed: []ServiceActionItemResult{}}
}

func (s *ServiceManagerService) runComposeAction(ctx context.Context, source ImageSource, cli, project string, selected []DockerContainer, action string) error {
	labels := selected[0].Labels
	if labels == nil {
		return userError("errors.service.composeMetadataMissing")
	}
	services := make([]string, 0, len(selected))
	seen := map[string]bool{}
	for _, container := range selected {
		if container.ComposeService == "" {
			return userError("errors.service.composeMetadataMissing")
		}
		if seen[container.ComposeService] {
			continue
		}
		seen[container.ComposeService] = true
		services = append(services, container.ComposeService)
	}
	sort.Strings(services)
	command, err := s.resolveComposeCommand(ctx, source, cli)
	if err != nil {
		return err
	}
	base, err := composeCommandArgs(command, labels, project)
	if err != nil {
		return err
	}
	runComposeServices := func(parts ...string) error {
		args := append(composeArgs(base, parts...), services...)
		_, runErr := s.run(ctx, source, command.command, args...)
		return runErr
	}
	switch action {
	case "start", "stop", "restart":
		return runComposeServices(action)
	case "delete":
		for _, container := range selected {
			if container.Running {
				return userError("errors.service.containerRunningDelete")
			}
		}
		return runComposeServices("rm", "-f")
	case "update-pull":
		return runComposeServices("pull")
	case "update-start":
		if err := runComposeServices("pull"); err != nil {
			return err
		}
		return runComposeServices("up", "-d", "--no-deps")
	default:
		return userError("errors.service.dockerActionUnsupported")
	}
}

// composeCommand 表示目标主机上可用的 compose 调用方式：docker compose 插件或独立的
// docker-compose 命令。
type composeCommand struct {
	command string
	prefix  []string
}

// composeCommand 探测 compose 的调用方式并缓存结果。优先使用 `<docker> compose` 插件，
// 不可用时回退到独立的 docker-compose。
func (s *ServiceManagerService) resolveComposeCommand(ctx context.Context, source ImageSource, cli string) (composeCommand, error) {
	key := remoteEnvKey(source) + "|" + cli
	s.composeMu.Lock()
	cached, ok := s.composeCache[key]
	s.composeMu.Unlock()
	if ok {
		return cached, nil
	}
	candidates := []composeCommand{{command: cli, prefix: []string{"compose"}}}
	if cli != "docker-compose" {
		candidates = append(candidates, composeCommand{command: "docker-compose"})
	}
	for _, candidate := range candidates {
		args := append(append([]string(nil), candidate.prefix...), "version")
		if _, err := s.run(ctx, source, candidate.command, args...); err != nil {
			continue
		}
		s.composeMu.Lock()
		s.composeCache[key] = candidate
		s.composeMu.Unlock()
		return candidate, nil
	}
	return composeCommand{}, userError("errors.service.composeUnavailable")
}

func composeCommandArgs(command composeCommand, labels map[string]string, project string) ([]string, error) {
	args := append([]string(nil), command.prefix...)
	if dir := labels["com.docker.compose.project.working_dir"]; dir != "" {
		args = append(args, "--project-directory", dir)
	}
	fileCount := 0
	for _, file := range strings.Split(labels["com.docker.compose.project.config_files"], ",") {
		file = strings.TrimSpace(file)
		if file == "" {
			continue
		}
		args = append(args, "-f", file)
		fileCount++
	}
	if fileCount == 0 {
		return nil, userError("errors.service.composeMetadataMissing")
	}
	return append(args, "-p", project), nil
}

func composeArgs(base []string, tail ...string) []string {
	args := make([]string, 0, len(base)+len(tail))
	args = append(args, base...)
	return append(args, tail...)
}

func (s *ServiceManagerService) performOne(ctx context.Context, source ImageSource, cli string, r ServiceResourceRef, action string) error {
	switch r.Runtime {
	case "docker":
		if !validContainerID(r.ID) {
			return userError("errors.service.containerIDInvalid")
		}
		if action != "start" && action != "stop" && action != "restart" && action != "delete" {
			return userError("errors.service.dockerActionUnsupported")
		}
		if action == "delete" {
			out, err := s.run(ctx, source, cli, "container", "inspect", "--format", "{{.State.Running}}", r.ID)
			if err != nil {
				return err
			}
			if strings.TrimSpace(string(out)) == "true" {
				return userError("errors.service.containerRunningDelete")
			}
			_, err = s.run(ctx, source, cli, "container", "rm", r.ID)
			return err
		}
		_, err := s.run(ctx, source, cli, "container", action, r.ID)
		return err
	case "pm2":
		if _, err := strconv.Atoi(r.ID); err != nil {
			return userError("errors.service.pm2IDInvalid")
		}
		if action != "start" && action != "stop" && action != "restart" && action != "delete" {
			return userError("errors.service.pm2ActionUnsupported")
		}
		_, err := s.run(ctx, source, "pm2", action, r.ID)
		return err
	case "systemd":
		if !validUnitName(r.ID) {
			return userError("errors.service.systemdUnitInvalid")
		}
		args := []string{}
		if r.Scope == "user" {
			args = append(args, "--user")
		}
		switch action {
		case "start", "stop", "restart", "disable":
			args = append(args, action, r.ID)
		case "disable-now":
			args = append(args, "disable", "--now", r.ID)
		default:
			return userError("errors.service.systemdActionUnsupported")
		}
		_, err := s.run(ctx, source, "systemctl", args...)
		return err
	}
	return userError("errors.service.runtimeUnsupported")
}

func monitorID(target string, r ServiceResourceRef) string {
	return target + "|" + r.Runtime + "|" + r.Scope + "|" + r.ID
}
func (s *ServiceManagerService) StartLogMonitors(req StartLogMonitorsRequest) ([]LogMonitor, error) {
	_, source, cli, err := s.targetSnapshot(req.TargetID)
	if err != nil {
		return []LogMonitor{}, err
	}
	out := []LogMonitor{}
	for _, resource := range req.Resources {
		if !validLogResource(resource) {
			out = append(out, LogMonitor{TargetID: req.TargetID, Resource: resource, State: "failed", Error: userError("errors.service.logResourceInvalid").Error()})
			continue
		}
		id := monitorID(req.TargetID, resource)
		s.mu.Lock()
		existing := s.monitors[id]
		if existing != nil {
			if existing.State == "stopping" {
				s.mu.Unlock()
				out = append(out, LogMonitor{ID: id, TargetID: req.TargetID, Resource: resource, State: "failed", Error: userError("errors.service.logMonitorStopping").Error()})
				continue
			}
			if existing.State != "monitoring" {
				if s.activeMonitorCountLocked() >= serviceLogMaxActive {
					s.mu.Unlock()
					out = append(out, LogMonitor{ID: id, TargetID: req.TargetID, Resource: resource, State: "failed", Error: userErrorParams("errors.service.logMonitorLimitReached", map[string]any{"max": serviceLogMaxActive}).Error()})
					continue
				}
				ctx, cancel := context.WithCancel(s.ctx)
				existing.State = "monitoring"
				existing.Error = ""
				existing.ctx = ctx
				existing.cancel = cancel
				s.mu.Unlock()
				out = append(out, existing.LogMonitor)
				go s.runLogMonitor(ctx, existing, source, cli)
				continue
			}
			s.mu.Unlock()
			out = append(out, existing.LogMonitor)
			continue
		}
		if s.activeMonitorCountLocked() >= serviceLogMaxActive {
			s.mu.Unlock()
			out = append(out, LogMonitor{ID: id, TargetID: req.TargetID, Resource: resource, State: "failed", Error: userErrorParams("errors.service.logMonitorLimitReached", map[string]any{"max": serviceLogMaxActive}).Error()})
			continue
		}
		ctx, cancel := context.WithCancel(s.ctx)
		state := &logMonitorState{LogMonitor: LogMonitor{ID: id, TargetID: req.TargetID, Resource: resource, State: "monitoring"}, ctx: ctx, cancel: cancel, lines: []ServiceLogLine{}, batch: []ServiceLogLine{}}
		s.monitors[id] = state
		s.mu.Unlock()
		out = append(out, state.LogMonitor)
		go s.runLogMonitor(ctx, state, source, cli)
	}
	return out, nil
}
func (s *ServiceManagerService) activeMonitorCountLocked() int {
	count := 0
	for _, monitor := range s.monitors {
		if monitor.State == "monitoring" || monitor.State == "stopping" {
			count++
		}
	}
	return count
}
func validLogResource(r ServiceResourceRef) bool {
	if r.Runtime == "docker" {
		return validContainerID(r.ID)
	}
	if r.Runtime == "pm2" {
		_, e := strconv.Atoi(r.ID)
		return e == nil
	}
	return r.Runtime == "systemd" && validUnitName(r.ID)
}
func (s *ServiceManagerService) runLogMonitor(ctx context.Context, m *logMonitorState, source ImageSource, dockerCLI string) {
	command, args := logCommand(m.Resource, dockerCLI)
	err := s.stream(ctx, source, command, args, func(stream, text string) { s.appendLogLine(ctx, m, stream, text) })
	s.mu.Lock()
	if s.monitors[m.ID] != m || m.ctx != ctx {
		s.mu.Unlock()
		return
	}
	if ctx.Err() != nil {
		m.State = "stopped"
	} else if err != nil {
		m.State = "disconnected"
		m.Error = err.Error()
	} else {
		m.State = "stopped"
	}
	snapshot := m.LogMonitor
	s.mu.Unlock()
	s.emitState(snapshot)
}
func logCommand(r ServiceResourceRef, dockerCLI string) (string, []string) {
	switch r.Runtime {
	case "docker":
		return dockerCLI, []string{"container", "logs", "--follow", "--timestamps", "--tail", strconv.Itoa(serviceLogTail), r.ID}
	case "pm2":
		return "pm2", []string{"logs", r.ID, "--raw", "--lines", strconv.Itoa(serviceLogTail)}
	default:
		args := []string{"-u", r.ID, "-f", "-n", strconv.Itoa(serviceLogTail), "--no-pager", "-o", "cat"}
		if r.Scope == "user" {
			args = append([]string{"--user"}, args...)
		}
		return "journalctl", args
	}
}
func (s *ServiceManagerService) stream(ctx context.Context, source ImageSource, command string, args []string, onLine func(string, string)) error {
	if source.Kind == "local" {
		cmd := exec.CommandContext(ctx, command, args...)
		stdout, _ := cmd.StdoutPipe()
		stderr, _ := cmd.StderrPipe()
		if err := cmd.Start(); err != nil {
			return err
		}
		var wg sync.WaitGroup
		read := func(r io.Reader, stream string) {
			defer wg.Done()
			scan := bufio.NewScanner(r)
			scan.Buffer(make([]byte, 64*1024), 1<<20)
			for scan.Scan() {
				onLine(stream, scan.Text())
			}
		}
		wg.Add(2)
		go read(stdout, "stdout")
		go read(stderr, "stderr")
		err := cmd.Wait()
		wg.Wait()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		commandLine, label, err := s.remoteCommandLine(source, command, args)
		if err != nil {
			done <- err
			_ = writer.Close()
			return
		}
		done <- runAuthenticatedSSHCombinedLine(ctx, source, label, "zh-CN", commandLine, writer)
		_ = writer.Close()
	}()
	scan := bufio.NewScanner(reader)
	scan.Buffer(make([]byte, 64*1024), 1<<20)
	for scan.Scan() {
		onLine("stdout", scan.Text())
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return <-done
}

// 日志流会带 ANSI 控制序列（颜色、光标等），前端按 SGR 渲染颜色；过滤只应针对可见文本。
var ansiSequencePattern = regexp.MustCompile("\x1b\\[[0-?]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|\x1b[@-Z\\\\-_]")

func stripAnsiSequences(text string) string {
	if !strings.ContainsRune(text, '\x1b') {
		return text
	}
	return ansiSequencePattern.ReplaceAllString(text, "")
}
func (s *ServiceManagerService) appendLogLine(ctx context.Context, m *logMonitorState, stream, text string) {
	line := ServiceLogLine{Sequence: s.sequence.Add(1), MonitorID: m.ID, Runtime: m.Resource.Runtime, ResourceID: m.Resource.ID, Name: m.Resource.Name, ReceivedAt: time.Now().Format(time.RFC3339Nano), Stream: stream, Text: text}
	if m.Resource.Runtime == "docker" {
		if stamp, rest, ok := strings.Cut(text, " "); ok && strings.Contains(stamp, "T") {
			line.Timestamp = stamp
			line.Text = rest
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.monitors[m.ID] != m || m.ctx != ctx || ctx.Err() != nil {
		return
	}
	m.lines = append(m.lines, line)
	m.bytes += len(line.Text) + 128
	for m.bytes > serviceLogBufferBytes && len(m.lines) > 0 {
		m.bytes -= len(m.lines[0].Text) + 128
		m.lines = m.lines[1:]
		m.Truncated = true
	}
	for s.totalLogBytesLocked() > serviceLogTotalBytes {
		var oldest *logMonitorState
		for _, candidate := range s.monitors {
			if len(candidate.lines) > 0 && (oldest == nil || candidate.lines[0].Sequence < oldest.lines[0].Sequence) {
				oldest = candidate
			}
		}
		if oldest == nil {
			break
		}
		oldest.bytes -= len(oldest.lines[0].Text) + 128
		oldest.lines = oldest.lines[1:]
		oldest.Truncated = true
	}
	m.batch = append(m.batch, line)
}
func (s *ServiceManagerService) totalLogBytesLocked() int {
	total := 0
	for _, monitor := range s.monitors {
		total += monitor.bytes
	}
	return total
}
func (s *ServiceManagerService) emitState(m LogMonitor) {
	if s.emit != nil {
		s.emit("service-manager:log-state", m)
	}
}
func (s *ServiceManagerService) flushLogBatches() {
	s.mu.Lock()
	batches := []ServiceLogLine{}
	for _, m := range s.monitors {
		if len(m.batch) > 0 {
			batches = append(batches, m.batch...)
			m.batch = nil
		}
	}
	s.mu.Unlock()
	if len(batches) > 0 && s.emit != nil {
		s.emit("service-manager:logs", serviceLogEvent{Lines: batches})
	}
}
func (s *ServiceManagerService) StopLogMonitor(id string) error {
	s.mu.Lock()
	m := s.monitors[id]
	if m == nil {
		s.mu.Unlock()
		return userError("errors.service.logMonitorNotFound")
	}
	if m.State != "monitoring" {
		s.mu.Unlock()
		return nil
	}
	m.State = "stopping"
	snapshot := m.LogMonitor
	m.cancel()
	s.mu.Unlock()
	s.emitState(snapshot)
	return nil
}
func (s *ServiceManagerService) RemoveLogMonitor(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.monitors[id]
	if m == nil {
		return userError("errors.service.logMonitorNotFound")
	}
	m.cancel()
	delete(s.monitors, id)
	return nil
}
func (s *ServiceManagerService) ClearLogBuffer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.monitors[id]
	if m == nil {
		return userError("errors.service.logMonitorNotFound")
	}
	m.lines = []ServiceLogLine{}
	m.batch = nil
	m.bytes = 0
	m.Truncated = false
	return nil
}
func (s *ServiceManagerService) GetLogMonitors(targetID string) []LogMonitor {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []LogMonitor{}
	for _, m := range s.monitors {
		if targetID == "" || m.TargetID == targetID {
			result = append(result, m.LogMonitor)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
func (s *ServiceManagerService) QueryLogBuffer(req QueryLogBufferRequest) (ServiceLogSnapshot, error) {
	filter, err := newLogFilter(req.Filter)
	if err != nil {
		return ServiceLogSnapshot{}, err
	}
	wanted := map[string]bool{}
	for _, id := range req.MonitorIDs {
		wanted[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot := ServiceLogSnapshot{Lines: []ServiceLogLine{}}
	for id, m := range s.monitors {
		if len(wanted) > 0 && !wanted[id] {
			continue
		}
		snapshot.Truncated = snapshot.Truncated || m.Truncated
		for _, line := range m.lines {
			if line.Sequence > snapshot.MaxSequence {
				snapshot.MaxSequence = line.Sequence
			}
			if filter(line) {
				snapshot.Lines = append(snapshot.Lines, line)
			}
		}
	}
	sort.Slice(snapshot.Lines, func(i, j int) bool { return snapshot.Lines[i].Sequence < snapshot.Lines[j].Sequence })
	if req.Limit > 0 && len(snapshot.Lines) > req.Limit {
		snapshot.Lines = snapshot.Lines[len(snapshot.Lines)-req.Limit:]
	}
	return snapshot, nil
}
func newLogFilter(f ServiceLogFilter) (func(ServiceLogLine) bool, error) {
	query := f.Query
	var re *regexp.Regexp
	var err error
	if f.Regex && query != "" {
		if !f.CaseSensitive {
			query = "(?i)" + query
		}
		re, err = regexp.Compile(query)
		if err != nil {
			return nil, userError("errors.service.logRegexInvalid")
		}
	}
	needle := query
	if !f.CaseSensitive {
		needle = strings.ToLower(needle)
	}
	streams := map[string]bool{}
	for _, v := range f.Streams {
		streams[v] = true
	}
	return func(line ServiceLogLine) bool {
		if len(streams) > 0 && !streams[line.Stream] {
			return false
		}
		if query == "" {
			return true
		}
		plain := stripAnsiSequences(line.Text)
		if re != nil {
			return re.MatchString(plain)
		}
		text := plain
		if !f.CaseSensitive {
			text = strings.ToLower(text)
		}
		return strings.Contains(text, needle)
	}, nil
}

func (s *ServiceManagerService) start() {
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				s.flushLogBatches()
				return
			case <-ticker.C:
				s.flushLogBatches()
			}
		}
	}()
}
