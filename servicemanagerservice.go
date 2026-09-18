package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	serviceLogBufferBytes = 20 << 20
	serviceLogTail        = 500
)

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
	source ImageSource
	cancel context.CancelFunc
	lines  []ServiceLogLine
	bytes  int
	batch  []ServiceLogLine
}

type ServiceManagerService struct {
	config   *ConfigService
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	monitors map[string]*logMonitorState
	emit     func(string, any)
	sequence atomic.Uint64
}

func NewServiceManagerService(config *ConfigService) *ServiceManagerService {
	ctx, cancel := context.WithCancel(context.Background())
	return &ServiceManagerService{config: config, ctx: ctx, cancel: cancel, monitors: map[string]*logMonitorState{}}
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
		return errors.New("配置服务尚未初始化")
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
				return fmt.Errorf("目标主机（第 %d 项）类型无效", index+1)
			}
			profileID := strings.TrimSpace(target.SSHProfileID)
			if profileID == "" && strings.HasPrefix(strings.TrimSpace(target.ID), "ssh:") {
				profileID = strings.TrimPrefix(strings.TrimSpace(target.ID), "ssh:")
			}
			if profileID == "" {
				return fmt.Errorf("目标主机（第 %d 项）未选择 SSH 连接", index+1)
			}
			if _, ok := names[profileID]; !ok {
				known := make([]string, 0, len(names))
				for id := range names {
					known = append(known, id)
				}
				sort.Strings(known)
				return fmt.Errorf("目标主机（第 %d 项）引用的 SSH 连接 %q 不存在（当前可用：%s）", index+1, profileID, strings.Join(known, ", "))
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
				return fmt.Errorf("目标主机（第 %d 项）名称无效", index+1)
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
		return ServiceTarget{}, ImageSource{}, "", errors.New("服务目标不存在")
	}
	profileID := strings.TrimPrefix(id, "ssh:")
	for _, profile := range s.config.GetSSHProfiles() {
		if profile.ID != profileID {
			continue
		}
		source := imageSourceFromSSHProfile(ImageSource{ID: id, Name: profile.Name, Kind: "ssh", SSHProfileID: profile.ID}, profile)
		return ServiceTarget{ID: id, Name: profile.Name, Kind: "ssh", SSHProfileID: profile.ID}, source, "docker", nil
	}
	return ServiceTarget{}, ImageSource{}, "", errors.New("服务目标引用的 SSH 配置不存在")
}

func (s *ServiceManagerService) run(ctx context.Context, source ImageSource, command string, args ...string) ([]byte, error) {
	if source.Kind == "local" {
		out, err := exec.CommandContext(ctx, command, args...).CombinedOutput()
		if err != nil {
			return out, fmt.Errorf("%s 执行失败: %w", command, err)
		}
		return out, nil
	}
	return runAuthenticatedSSH(ctx, source, command, "zh-CN", args...)
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
	Mounts []struct {
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Type        string `json:"Type"`
	} `json:"Mounts"`
	HostConfig struct {
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
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
		return nil, errors.New("解析 Docker 容器信息失败")
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
		return nil, errors.New("解析 PM2 信息失败")
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
		return DockerContainerDetail{}, errors.New("容器 ID 无效")
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceCommandTimeout)
	defer cancel()
	out, err := s.run(ctx, source, cli, "container", "inspect", id)
	if err != nil {
		return DockerContainerDetail{}, err
	}
	var raw []dockerInspect
	if json.Unmarshal(out, &raw) != nil || len(raw) != 1 {
		return DockerContainerDetail{}, errors.New("解析 Docker 容器详情失败")
	}
	v := raw[0]
	detail := DockerContainerDetail{Container: dockerContainerFromInspect(v), Command: v.Config.Cmd, Entrypoint: v.Config.Entrypoint, Mounts: []string{}, Networks: []string{}, RestartPolicy: v.HostConfig.RestartPolicy.Name}
	for _, m := range v.Mounts {
		detail.Mounts = append(detail.Mounts, m.Type+": "+m.Source+" → "+m.Destination)
	}
	for n := range v.NetworkSettings.Networks {
		detail.Networks = append(detail.Networks, n)
	}
	sort.Strings(detail.Networks)
	return detail, nil
}
func (s *ServiceManagerService) GetPM2ProcessDetail(targetID, id string) (PM2ProcessDetail, error) {
	target, source, _, err := s.targetSnapshot(targetID)
	_ = target
	if err != nil {
		return PM2ProcessDetail{}, err
	}
	if _, err = strconv.Atoi(id); err != nil {
		return PM2ProcessDetail{}, errors.New("PM2 ID 无效")
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
	return PM2ProcessDetail{}, errors.New("PM2 进程不存在")
}
func (s *ServiceManagerService) GetSystemdUnitDetail(targetID, id, scope string) (SystemdUnitDetail, error) {
	_, source, _, err := s.targetSnapshot(targetID)
	if err != nil {
		return SystemdUnitDetail{}, err
	}
	if !validUnitName(id) {
		return SystemdUnitDetail{}, errors.New("Systemd unit 无效")
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
		return SystemdUnitDetail{}, errors.New("Systemd 服务不存在")
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
	_, source, cli, err := s.targetSnapshot(req.TargetID)
	if err != nil {
		return ServiceActionResult{Failed: []ServiceActionItemResult{{ID: req.Resource.ID, Name: req.Resource.Name, Error: err.Error()}}}
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceCommandTimeout)
	defer cancel()
	result := ServiceActionResult{Succeeded: []ServiceActionItemResult{}, Failed: []ServiceActionItemResult{}}
	resources := []ServiceResourceRef{req.Resource}
	if req.Resource.Runtime == "docker-compose" {
		containers, e := s.listContainers(ctx, source, cli)
		if e != nil {
			return ServiceActionResult{Failed: []ServiceActionItemResult{{ID: req.Resource.ID, Name: req.Resource.Name, Error: e.Error()}}}
		}
		resources = []ServiceResourceRef{}
		project := strings.TrimPrefix(req.Resource.ID, "compose:")
		for _, c := range containers {
			if c.ComposeProject == project {
				resources = append(resources, ServiceResourceRef{Runtime: "docker", ID: c.ID, Name: c.Name})
			}
		}
		if len(resources) == 0 {
			return ServiceActionResult{Failed: []ServiceActionItemResult{{ID: req.Resource.ID, Name: req.Resource.Name, Error: "Compose 项目不存在"}}}
		}
	}
	for _, resource := range resources {
		if e := s.performOne(ctx, source, cli, resource, req.Action); e != nil {
			result.Failed = append(result.Failed, ServiceActionItemResult{ID: resource.ID, Name: resource.Name, Error: e.Error()})
		} else {
			result.Succeeded = append(result.Succeeded, ServiceActionItemResult{ID: resource.ID, Name: resource.Name})
		}
	}
	return result
}
func (s *ServiceManagerService) performOne(ctx context.Context, source ImageSource, cli string, r ServiceResourceRef, action string) error {
	switch r.Runtime {
	case "docker":
		if !validContainerID(r.ID) {
			return errors.New("容器 ID 无效")
		}
		if action != "start" && action != "stop" && action != "restart" && action != "delete" {
			return errors.New("不支持的 Docker 操作")
		}
		if action == "delete" {
			out, err := s.run(ctx, source, cli, "container", "inspect", "--format", "{{.State.Running}}", r.ID)
			if err != nil {
				return err
			}
			if strings.TrimSpace(string(out)) == "true" {
				return errors.New("运行中的容器不能删除，请先停止容器")
			}
			_, err = s.run(ctx, source, cli, "container", "rm", r.ID)
			return err
		}
		_, err := s.run(ctx, source, cli, "container", action, r.ID)
		return err
	case "pm2":
		if _, err := strconv.Atoi(r.ID); err != nil {
			return errors.New("PM2 ID 无效")
		}
		if action != "start" && action != "stop" && action != "restart" && action != "delete" {
			return errors.New("不支持的 PM2 操作")
		}
		_, err := s.run(ctx, source, "pm2", action, r.ID)
		return err
	case "systemd":
		if !validUnitName(r.ID) {
			return errors.New("Systemd unit 无效")
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
			return errors.New("不支持的 Systemd 操作")
		}
		_, err := s.run(ctx, source, "systemctl", args...)
		return err
	}
	return errors.New("不支持的服务类型")
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
			out = append(out, LogMonitor{TargetID: req.TargetID, Resource: resource, State: "failed", Error: "日志资源无效"})
			continue
		}
		id := monitorID(req.TargetID, resource)
		s.mu.Lock()
		existing := s.monitors[id]
		if existing != nil {
			if existing.State != "monitoring" {
				ctx, cancel := context.WithCancel(s.ctx)
				existing.State = "monitoring"
				existing.Error = ""
				existing.source = source
				existing.cancel = cancel
				s.mu.Unlock()
				out = append(out, existing.LogMonitor)
				go s.runLogMonitor(ctx, existing, cli)
				continue
			}
			s.mu.Unlock()
			out = append(out, existing.LogMonitor)
			continue
		}
		ctx, cancel := context.WithCancel(s.ctx)
		state := &logMonitorState{LogMonitor: LogMonitor{ID: id, TargetID: req.TargetID, Resource: resource, State: "monitoring"}, source: source, cancel: cancel, lines: []ServiceLogLine{}, batch: []ServiceLogLine{}}
		s.monitors[id] = state
		s.mu.Unlock()
		out = append(out, state.LogMonitor)
		go s.runLogMonitor(ctx, state, cli)
	}
	return out, nil
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
func (s *ServiceManagerService) runLogMonitor(ctx context.Context, m *logMonitorState, dockerCLI string) {
	command, args := logCommand(m.Resource, dockerCLI)
	err := s.stream(ctx, m.source, command, args, func(stream, text string) { s.appendLogLine(m, stream, text) })
	s.mu.Lock()
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
		done <- runAuthenticatedSSHCombined(ctx, source, command, "zh-CN", writer, args...)
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
func (s *ServiceManagerService) appendLogLine(m *logMonitorState, stream, text string) {
	line := ServiceLogLine{Sequence: s.sequence.Add(1), MonitorID: m.ID, Runtime: m.Resource.Runtime, ResourceID: m.Resource.ID, Name: m.Resource.Name, ReceivedAt: time.Now().Format(time.RFC3339Nano), Stream: stream, Text: text}
	if m.Resource.Runtime == "docker" {
		if stamp, rest, ok := strings.Cut(text, " "); ok && strings.Contains(stamp, "T") {
			line.Timestamp = stamp
			line.Text = rest
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m.lines = append(m.lines, line)
	m.bytes += len(line.Text) + 128
	for m.bytes > serviceLogBufferBytes && len(m.lines) > 0 {
		m.bytes -= len(m.lines[0].Text) + 128
		m.lines = m.lines[1:]
		m.Truncated = true
	}
	m.batch = append(m.batch, line)
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
		return errors.New("日志监控不存在")
	}
	m.cancel()
	s.mu.Unlock()
	return nil
}
func (s *ServiceManagerService) ClearLogBuffer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.monitors[id]
	if m == nil {
		return errors.New("日志监控不存在")
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
			return nil, errors.New("日志正则表达式无效")
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
		if re != nil {
			return re.MatchString(line.Text)
		}
		text := line.Text
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
