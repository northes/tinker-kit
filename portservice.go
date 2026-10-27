package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

type PortEntry struct {
	Port     int    `json:"port"`
	Address  string `json:"address"`
	Protocol string `json:"protocol"`
	PID      int    `json:"pid"`
	Name     string `json:"name"`
	User     string `json:"user"`
	Path     string `json:"path"`
	// CommandLine 是完整 argv。内核 comm 只有可执行名（pm2 托管的 node 应用统一是 node），
	// 脚本路径、启动参数和进程标题只存在于这里。
	CommandLine string `json:"commandLine"`
	ParentPID   int    `json:"parentPID"`
	ParentPath  string `json:"parentPath"`
}

type PortSource struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	SSHProfileID string `json:"sshProfileID"`
}

type PortForwardRequest struct {
	Name       string `json:"name"`
	SourceID   string `json:"sourceID"`
	Direction  string `json:"direction"`
	ListenHost string `json:"listenHost"`
	ListenPort int    `json:"listenPort"`
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
}

type PortForward struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	SourceID   string `json:"sourceID"`
	Direction  string `json:"direction"`
	ListenHost string `json:"listenHost"`
	ListenPort int    `json:"listenPort"`
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
	Status     string `json:"status"`
	Retries    int    `json:"retries"`
	Error      string `json:"error,omitempty"`
}

// PortForwardConfig 是转发定义（持久化部分）；运行态（状态、重试、错误）只存在于内存。
type PortForwardConfig struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	SourceID   string `json:"sourceID"`
	Direction  string `json:"direction"`
	ListenHost string `json:"listenHost"`
	ListenPort int    `json:"listenPort"`
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
}

type portTunnel struct {
	PortForward
	profile  SSHProfile
	ctx      context.Context
	cancel   context.CancelFunc
	listener net.Listener
	client   *ssh.Client
}

type PortService struct {
	config  *ConfigService
	mu      sync.Mutex
	tunnels map[string]*portTunnel
	counter atomic.Uint64
}

func NewPortService(config *ConfigService) *PortService {
	service := &PortService{config: config, tunnels: make(map[string]*portTunnel)}
	if config != nil {
		previous := config.Get()
		var snapshotMu sync.Mutex
		config.setOnChange(func(current Config) {
			snapshotMu.Lock()
			sourcesChanged := !reflect.DeepEqual(previous.SSHProfiles, current.SSHProfiles) ||
				!reflect.DeepEqual(previous.PortSources, current.PortSources)
			forwardsChanged := !reflect.DeepEqual(previous.PortForwards, current.PortForwards)
			previous = current
			snapshotMu.Unlock()
			if sourcesChanged {
				service.shutdown()
				return
			}
			if forwardsChanged {
				service.syncForwardTunnels(current.PortForwards)
			}
		})
	}
	return service
}
func (s *PortService) ServiceName() string { return "PortService" }

func normalizePortSources(sources []PortSource, profileNames map[string]string) []PortSource {
	result := make([]PortSource, 0, len(sources)+1)
	seen := make(map[string]bool, len(sources)+1)
	hasLocal := false
	for _, source := range sources {
		id := strings.TrimSpace(source.ID)
		kind := strings.ToLower(strings.TrimSpace(source.Kind))
		profileID := strings.TrimSpace(source.SSHProfileID)
		if id == "local" || kind == "local" {
			if !hasLocal {
				result = append(result, defaultPortSources()[0])
				seen["local"] = true
				hasLocal = true
			}
			continue
		}
		if id == "" || seen[id] || kind != "ssh" || profileID == "" {
			continue
		}
		name := strings.TrimSpace(source.Name)
		if name == "" || name == profileID {
			name = profileNames[profileID]
		}
		if name == "" {
			continue
		}
		seen[id] = true
		result = append(result, PortSource{ID: id, Name: name, Kind: "ssh", SSHProfileID: profileID})
	}
	if !hasLocal {
		result = append([]PortSource{defaultPortSources()[0]}, result...)
	}
	return result
}

func (s *PortService) GetPortSources() []PortSource {
	if s == nil || s.config == nil {
		return defaultPortSources()
	}
	return append([]PortSource(nil), s.config.Get().PortSources...)
}

func (s *PortService) SavePortSources(sources []PortSource) error {
	if s == nil || s.config == nil {
		return userError("errors.common.configNotInitialized")
	}
	return s.config.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		profiles := make(map[string]string, len(cfg.SSHProfiles))
		for _, profile := range cfg.SSHProfiles {
			profiles[profile.ID] = profile.Name
		}
		normalized := make([]PortSource, 0, len(sources)+1)
		seen := make(map[string]bool, len(sources)+1)
		hasLocal := false
		for index, source := range sources {
			if strings.TrimSpace(source.ID) == "local" || strings.EqualFold(strings.TrimSpace(source.Kind), "local") {
				if !hasLocal {
					normalized = append(normalized, defaultPortSources()[0])
					seen["local"] = true
					hasLocal = true
				}
				continue
			}
			id := strings.TrimSpace(source.ID)
			name := strings.TrimSpace(source.Name)
			profileID := strings.TrimSpace(source.SSHProfileID)
			if !validConfigValue(id, 128) || seen[id] || !validTextValue(name, 128) || !validConfigValue(profileID, 128) {
				return userErrorParams("errors.port.invalidSource", map[string]any{"index": index + 1})
			}
			if _, ok := profiles[profileID]; !ok {
				return userErrorParams("errors.port.sourceProfileNotFound", map[string]any{"index": index + 1})
			}
			seen[id] = true
			normalized = append(normalized, PortSource{ID: id, Name: name, Kind: "ssh", SSHProfileID: profileID})
		}
		if !hasLocal {
			normalized = append([]PortSource{defaultPortSources()[0]}, normalized...)
		}
		cfg.PortSources = normalized
		return nil
	})
}

// lsof 的字段模式保留进程与文件描述符边界，避免按空格拆解进程名或地址。
func parseLsofPorts(output []byte) []PortEntry {
	rows := make([]PortEntry, 0)
	var process PortEntry
	var socket PortEntry
	flush := func() {
		if socket.Port > 0 && socket.Protocol != "" && process.PID > 0 {
			socket.PID, socket.Name, socket.User, socket.ParentPID = process.PID, process.Name, process.User, process.ParentPID
			rows = append(rows, socket)
		}
		socket = PortEntry{}
	}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if len(line) < 2 {
			continue
		}
		value := string(line[1:])
		switch line[0] {
		case 'p':
			flush()
			process = PortEntry{}
			process.PID, _ = strconv.Atoi(value)
		case 'c':
			process.Name = value
		case 'L':
			process.User = value
		case 'R':
			process.ParentPID, _ = strconv.Atoi(value)
		case 'f':
			flush()
		case 'P':
			socket.Protocol = value
		case 'n':
			socket.Address = value
			endpoint := strings.SplitN(value, "->", 2)[0]
			colon := strings.LastIndexByte(endpoint, ':')
			if colon >= 0 {
				socket.Port, _ = strconv.Atoi(endpoint[colon+1:])
			}
		}
	}
	flush()
	return rows
}

var ssPIDPattern = regexp.MustCompile(`pid=(\d+)`)
var ssNamePattern = regexp.MustCompile(`\("([^"]+)"`)

func parseSSPorts(output []byte) []PortEntry {
	rows := make([]PortEntry, 0)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		protocol := strings.ToUpper(fields[0])
		if protocol != "TCP" && protocol != "UDP" {
			continue
		}
		address := fields[4]
		colon := strings.LastIndexByte(address, ':')
		if colon < 0 {
			continue
		}
		port, err := strconv.Atoi(address[colon+1:])
		if err != nil || port == 0 {
			continue
		}
		entry := PortEntry{Port: port, Address: address, Protocol: protocol}
		if match := ssPIDPattern.FindStringSubmatch(line); len(match) > 1 {
			entry.PID, _ = strconv.Atoi(match[1])
		}
		if match := ssNamePattern.FindStringSubmatch(line); len(match) > 1 {
			entry.Name = match[1]
		}
		rows = append(rows, entry)
	}
	return rows
}

type processDetail struct {
	parent int
	user   string
	path   string
}

// parseProcessCommands 解析 ps -eo pid=,args= 的输出；命令行保留全部参数，
// 作为搜索与展示进程真实身份的入口。
func parseProcessCommands(output []byte) map[int]string {
	commands := make(map[int]string)
	for _, line := range strings.Split(string(output), "\n") {
		pidText, command, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(pidText)
		command = strings.TrimSpace(command)
		if err != nil || command == "" {
			continue
		}
		commands[pid] = command
	}
	return commands
}

func enrichPorts(rows []PortEntry, output, commandOutput []byte) {
	commands := parseProcessCommands(commandOutput)
	processes := make(map[int]processDetail)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		parent, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		processes[pid] = processDetail{parent: parent, user: fields[2], path: strings.Join(fields[3:], " ")}
	}
	for i := range rows {
		info := processes[rows[i].PID]
		if info.path != "" {
			rows[i].Path, rows[i].ParentPID = info.path, info.parent
		}
		if rows[i].User == "" {
			rows[i].User = info.user
		}
		rows[i].ParentPath = processes[info.parent].path
		rows[i].CommandLine = commands[rows[i].PID]
	}
}

func (s *PortService) sourceProfile(id string) (SSHProfile, error) {
	if s == nil || s.config == nil {
		return SSHProfile{}, userError("errors.port.configUnavailable")
	}
	var profileID string
	for _, source := range s.config.Get().PortSources {
		if source.ID == id && source.Kind == "ssh" {
			profileID = source.SSHProfileID
			break
		}
	}
	if profileID == "" {
		return SSHProfile{}, userError("errors.port.sourceNotFound")
	}
	for _, profile := range s.config.GetSSHProfiles() {
		if profile.ID == profileID {
			return profile, nil
		}
	}
	return SSHProfile{}, userError("errors.port.profileNotFound")
}

func (s *PortService) dial(ctx context.Context, profile SSHProfile) (*ssh.Client, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	auth, err := sshAuthMethodsForProfile(profile)
	if err != nil {
		return nil, err
	}
	callback, err := newAppSSHHostKeyCallback(s.config.Get().Language)
	if err != nil {
		return nil, err
	}
	host := strings.TrimPrefix(strings.TrimSuffix(profile.Host, "]"), "[")
	address := net.JoinHostPort(host, strconv.Itoa(profile.Port))
	return dialSSHClient(dialCtx, address, &ssh.ClientConfig{User: profile.Username, Auth: auth, HostKeyCallback: callback, Timeout: 15 * time.Second})
}

// ListPorts 的 ctx 来自 Wails 绑定调用；前端取消时中断本地扫描或远端 SSH 会话。
func (s *PortService) ListPorts(ctx context.Context, profileID string) (entries []PortEntry, err error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	defer func() {
		if errors.Is(ctx.Err(), context.Canceled) {
			entries, err = nil, nil
		}
	}()
	if (profileID == "" || profileID == "local") && runtime.GOOS == "windows" {
		return listWindowsPorts(ctx)
	}
	var portOutput, ps, commands []byte
	mode := "lsof"
	if profileID == "" || profileID == "local" {
		command := "lsof"
		args := []string{"-nP", "-iTCP", "-iUDP", "-FpcLfnPR"}
		if _, err := exec.LookPath(command); err != nil {
			command, mode, args = "ss", "ss", []string{"-H", "-tunap"}
		}
		var err error
		portOutput, err = exec.CommandContext(ctx, command, args...).Output()
		// lsof 在没有匹配端口时返回 1；其余错误应展示给用户。
		if err != nil && !(mode == "lsof" && len(portOutput) == 0) {
			return nil, userErrorCause("errors.port.scanFailed", err)
		}
		ps, _ = exec.CommandContext(ctx, "ps", "-eo", "pid=,ppid=,user=,comm=").Output()
		// pm2 等守护进程派生的应用只有 argv 里能看出脚本和标题，comm 一律是可执行名。
		commands, _ = exec.CommandContext(ctx, "ps", "-eo", "pid=,args=").Output()
	} else {
		profile, err := s.sourceProfile(profileID)
		if err != nil {
			return nil, err
		}
		client, err := s.dial(ctx, profile)
		if err != nil {
			return nil, err
		}
		defer client.Close()
		session, err := client.NewSession()
		if err != nil {
			return nil, err
		}
		defer session.Close()
		// 固定命令，不拼接用户输入；标记用于区分扫描器和进程表。
		var stdout bytes.Buffer
		session.Stdout = &stdout
		const command = "if command -v lsof >/dev/null 2>&1; then printf '__PORT_LSOF__\\n'; lsof -nP -iTCP -iUDP -FpcLfnPR || true; elif command -v ss >/dev/null 2>&1; then printf '__PORT_SS__\\n'; ss -H -tunap; else exit 127; fi; printf '__PORT_PS__\\n'; ps -eo pid=,ppid=,user=,comm=; printf '__PORT_ARGS__\\n'; ps -eo pid=,args="
		if err := session.Start(command); err != nil {
			return nil, userErrorCause("errors.port.scanFailed", err)
		}
		wait := make(chan error, 1)
		go func() { wait <- session.Wait() }()
		select {
		case err := <-wait:
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, userErrorCause("errors.port.scanFailed", err)
			}
		case <-ctx.Done():
			_ = session.Close()
			return nil, ctx.Err()
		}
		output := stdout.Bytes()
		if bytes.HasPrefix(output, []byte("__PORT_SS__\n")) {
			mode = "ss"
			output = bytes.TrimPrefix(output, []byte("__PORT_SS__\n"))
		} else if bytes.HasPrefix(output, []byte("__PORT_LSOF__\n")) {
			output = bytes.TrimPrefix(output, []byte("__PORT_LSOF__\n"))
		} else {
			return nil, userError("errors.port.scanFailed")
		}
		parts := bytes.SplitN(output, []byte("__PORT_PS__\n"), 2)
		if len(parts) != 2 {
			return nil, userError("errors.port.scanFailed")
		}
		portOutput = parts[0]
		// 进程表与 argv 分两段采集：comm 可能是带空格的完整路径，不能与参数同段解析。
		tables := bytes.SplitN(parts[1], []byte("__PORT_ARGS__\n"), 2)
		if len(tables) != 2 {
			return nil, userError("errors.port.scanFailed")
		}
		ps, commands = tables[0], tables[1]
	}
	var rows []PortEntry
	if mode == "ss" {
		rows = parseSSPorts(portOutput)
	} else {
		rows = parseLsofPorts(portOutput)
	}
	enrichPorts(rows, ps, commands)
	return rows, nil
}

// Windows 没有 lsof/ss；通过系统网络端点与进程信息查询相同的字段。
func listWindowsPorts(ctx context.Context) ([]PortEntry, error) {
	const script = `$ErrorActionPreference = 'Stop'
$tcp = @(Get-NetTCPConnection | Where-Object { $_.LocalPort -gt 0 } | ForEach-Object { [pscustomobject]@{ Port=$_.LocalPort; Address=$_.LocalAddress + ':' + $_.LocalPort; Protocol='TCP'; PID=$_.OwningProcess } })
$udp = @(Get-NetUDPEndpoint | Where-Object { $_.LocalPort -gt 0 } | ForEach-Object { [pscustomobject]@{ Port=$_.LocalPort; Address=$_.LocalAddress + ':' + $_.LocalPort; Protocol='UDP'; PID=$_.OwningProcess } })
$rows = @($tcp) + @($udp)
$needed = @{}
foreach ($row in $rows) { $needed[[int]$row.PID] = $true }
$processes = @{}
foreach ($process in (Get-CimInstance Win32_Process)) {
  if (-not $needed.ContainsKey([int]$process.ProcessId) -and -not $needed.ContainsKey([int]$process.ParentProcessId)) { continue }
  $owner = ''
  if ($needed.ContainsKey([int]$process.ProcessId)) {
    try { $owner = (Invoke-CimMethod -InputObject $process -MethodName GetOwner).User } catch {}
  }
  $processes[[int]$process.ProcessId] = [pscustomobject]@{ Name=$process.Name; Path=$process.ExecutablePath; CommandLine=$process.CommandLine; ParentPID=$process.ParentProcessId; User=$owner }
}
foreach ($row in $rows) {
  $process = $processes[[int]$row.PID]
  $row | Add-Member -NotePropertyName Name -NotePropertyValue $process.Name
  $row | Add-Member -NotePropertyName User -NotePropertyValue $process.User
  $row | Add-Member -NotePropertyName Path -NotePropertyValue $process.Path
  $row | Add-Member -NotePropertyName CommandLine -NotePropertyValue $process.CommandLine
  $row | Add-Member -NotePropertyName ParentPID -NotePropertyValue $process.ParentPID
  $parentPath = ''
  if ($process) { $parentPath = $processes[[int]$process.ParentPID].Path }
  $row | Add-Member -NotePropertyName ParentPath -NotePropertyValue $parentPath
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4`
	output, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return nil, userErrorCause("errors.port.scanFailed", err)
	}
	var rows []PortEntry
	if err := json.Unmarshal(output, &rows); err != nil {
		return nil, userErrorCause("errors.port.scanFailed", err)
	}
	return rows, nil
}

func validForwardPort(port int) bool { return port > 0 && port <= 65535 }
func validForwardHost(host string) bool {
	if host == "" || len(host) > 255 {
		return false
	}
	return !strings.ContainsAny(host, " \t\r\n/\\")
}
func normalizeForward(request PortForwardRequest) (PortForwardRequest, error) {
	request.Name = strings.TrimSpace(request.Name)
	request.SourceID = strings.TrimSpace(request.SourceID)
	request.ListenHost = strings.TrimSpace(request.ListenHost)
	request.TargetHost = strings.TrimSpace(request.TargetHost)
	if request.ListenHost == "" {
		request.ListenHost = "127.0.0.1"
	}
	if request.TargetHost == "" {
		request.TargetHost = "127.0.0.1"
	}
	// 名称可选；留空时界面回退到监听地址作为显示名。
	if request.Name != "" && !validTextValue(request.Name, 64) {
		return request, userError("errors.port.invalidForward")
	}
	if request.SourceID == "" || request.SourceID == "local" || (request.Direction != "local" && request.Direction != "remote") || !validForwardHost(request.ListenHost) || !validForwardHost(request.TargetHost) || !validForwardPort(request.ListenPort) || !validForwardPort(request.TargetPort) {
		return request, userError("errors.port.invalidForward")
	}
	return request, nil
}

// normalizePortForwards 通过 normalizeForward 统一校验转发定义，丢弃非法或重复项。
// 来源已失效（引用的 PortSource 被删除）的定义会保留，交由界面提示，不在此处静默删除。
func normalizePortForwards(forwards []PortForwardConfig) []PortForwardConfig {
	result := make([]PortForwardConfig, 0, len(forwards))
	seen := make(map[string]bool, len(forwards))
	for _, forward := range forwards {
		forward.ID = strings.TrimSpace(forward.ID)
		if forward.ID == "" || seen[forward.ID] {
			continue
		}
		request, err := normalizeForward(PortForwardRequest{
			Name:       forward.Name,
			SourceID:   forward.SourceID,
			Direction:  forward.Direction,
			ListenHost: forward.ListenHost,
			ListenPort: forward.ListenPort,
			TargetHost: forward.TargetHost,
			TargetPort: forward.TargetPort,
		})
		if err != nil {
			continue
		}
		seen[forward.ID] = true
		result = append(result, PortForwardConfig{
			ID:         forward.ID,
			Name:       request.Name,
			SourceID:   request.SourceID,
			Direction:  request.Direction,
			ListenHost: request.ListenHost,
			ListenPort: request.ListenPort,
			TargetHost: request.TargetHost,
			TargetPort: request.TargetPort,
		})
	}
	return result
}

const (
	portColumnMinWidth = 56
	portColumnMaxWidth = 800
	portColumnMaxCount = 32
)

// normalizeColumnWidths 把列宽收敛到可用范围；列顺序与含义由前端列定义决定，这里只做边界保护。
func normalizeColumnWidths(widths []int) []int {
	result := make([]int, 0, min(len(widths), portColumnMaxCount))
	for _, width := range widths {
		if len(result) == portColumnMaxCount {
			break
		}
		if width < portColumnMinWidth {
			width = portColumnMinWidth
		}
		if width > portColumnMaxWidth {
			width = portColumnMaxWidth
		}
		result = append(result, width)
	}
	return result
}

// normalizePortColumnWidths 丢弃已不存在主机的列宽，避免来源删除后留下孤儿配置。
func normalizePortColumnWidths(widths PortColumnWidths, sources []PortSource) PortColumnWidths {
	valid := make(map[string]bool, len(sources))
	for _, source := range sources {
		valid[source.ID] = true
	}
	ports := make(map[string][]int, len(widths.Ports))
	for host, value := range widths.Ports {
		host = strings.TrimSpace(host)
		if !valid[host] {
			continue
		}
		if normalized := normalizeColumnWidths(value); len(normalized) > 0 {
			ports[host] = normalized
		}
	}
	return PortColumnWidths{Ports: ports, Forwards: normalizeColumnWidths(widths.Forwards)}
}

// GetColumnWidths 返回端口工具的列宽配置；无配置服务时返回空布局。
func (s *PortService) GetColumnWidths() PortColumnWidths {
	if s == nil || s.config == nil {
		return PortColumnWidths{Ports: map[string][]int{}}
	}
	return s.config.Get().PortColumnWidths
}

// SaveColumnWidths 合并保存列宽：Ports 按主机 ID 覆盖，未提交的主机保留原值。
func (s *PortService) SaveColumnWidths(widths PortColumnWidths) error {
	if s == nil || s.config == nil {
		return userError("errors.common.configNotInitialized")
	}
	return s.config.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		ports := make(map[string][]int, len(cfg.PortColumnWidths.Ports)+len(widths.Ports))
		for host, value := range cfg.PortColumnWidths.Ports {
			ports[host] = value
		}
		for host, value := range widths.Ports {
			host = strings.TrimSpace(host)
			if host == "" {
				continue
			}
			ports[host] = append([]int(nil), value...)
		}
		if len(widths.Forwards) > 0 {
			cfg.PortColumnWidths.Forwards = append([]int(nil), widths.Forwards...)
		}
		cfg.PortColumnWidths.Ports = ports
		return nil
	})
}

func newPortTunnel(definition PortForwardConfig, profile SSHProfile) *portTunnel {
	ctx, cancel := context.WithCancel(context.Background())
	return &portTunnel{
		PortForward: PortForward{
			ID:         definition.ID,
			Name:       definition.Name,
			SourceID:   definition.SourceID,
			Direction:  definition.Direction,
			ListenHost: definition.ListenHost,
			ListenPort: definition.ListenPort,
			TargetHost: definition.TargetHost,
			TargetPort: definition.TargetPort,
			Status:     "connecting",
		},
		profile: profile,
		ctx:     ctx,
		cancel:  cancel,
	}
}

// matches 判断隧道是否仍对应当前持久化的转发定义。
func (t *portTunnel) matches(definition PortForwardConfig) bool {
	return t.ID == definition.ID && t.Name == definition.Name && t.SourceID == definition.SourceID &&
		t.Direction == definition.Direction && t.ListenHost == definition.ListenHost &&
		t.ListenPort == definition.ListenPort && t.TargetHost == definition.TargetHost &&
		t.TargetPort == definition.TargetPort
}

// persistForwards 在配置锁内改写转发定义并持久化，避免读取到过期快照。
func (s *PortService) persistForwards(mutate func([]PortForwardConfig) []PortForwardConfig) error {
	if s == nil || s.config == nil {
		return userError("errors.common.configNotInitialized")
	}
	return s.config.updateConfigAllowDanglingRefs(func(cfg *Config) error {
		cfg.PortForwards = normalizePortForwards(mutate(cfg.PortForwards))
		return nil
	})
}

func (s *PortService) forwardDefinition(id string) (PortForwardConfig, bool) {
	if s == nil || s.config == nil {
		return PortForwardConfig{}, false
	}
	for _, forward := range s.config.Get().PortForwards {
		if forward.ID == id {
			return forward, true
		}
	}
	return PortForwardConfig{}, false
}

// startForwardDefinition 持久化 definition 并尝试启动。
// 监听端口不可用（本地被占用或远端拒绝）时仍然保存定义，但保持停止状态，
// 并把失败原因写回返回值的 error，交由界面提示；其余失败仍按原错误返回且不落库。
func (s *PortService) startForwardDefinition(
	definition PortForwardConfig,
	profile SSHProfile,
	mutate func([]PortForwardConfig) []PortForwardConfig,
) (PortForward, error) {
	tunnel := newPortTunnel(definition, profile)
	client, listener, err := s.openTunnel(tunnel.ctx, tunnel)
	if err != nil {
		tunnel.cancel()
		if !listenUnavailable(definition.Direction, err) {
			return PortForward{}, err
		}
		if persistErr := s.persistForwards(mutate); persistErr != nil {
			return PortForward{}, persistErr
		}
		forward := tunnel.PortForward
		forward.Status = "stopped"
		forward.Error = listenUnavailableReason(definition, err).Error()
		return forward, nil
	}
	tunnel.client, tunnel.listener, tunnel.Status = client, listener, "connected"
	if err := s.persistForwards(mutate); err != nil {
		tunnel.cancel()
		_ = listener.Close()
		_ = client.Close()
		return PortForward{}, err
	}
	s.mu.Lock()
	s.tunnels[definition.ID] = tunnel
	s.mu.Unlock()
	go s.runTunnel(tunnel)
	return tunnel.PortForward, nil
}

// nextForwardID 生成未被占用的转发 ID。counter 只在当前进程内递增，而转发定义
// 会跨重启持久化；不跳过已存在的 ID，新定义会被 normalizePortForwards 当成重复项
// 静默丢弃，新隧道还会顶替同 ID 的已有定义状态。
func (s *PortService) nextForwardID() string {
	for {
		id := fmt.Sprintf("port-forward-%d", s.counter.Add(1))
		if _, exists := s.forwardDefinition(id); exists {
			continue
		}
		s.mu.Lock()
		_, running := s.tunnels[id]
		s.mu.Unlock()
		if !running {
			return id
		}
	}
}

// AddForward 创建一条转发定义并立即启动；监听端口已被占用时仍然创建，只是不启动。
func (s *PortService) AddForward(request PortForwardRequest) (PortForward, error) {
	request, err := normalizeForward(request)
	if err != nil {
		return PortForward{}, err
	}
	profile, err := s.sourceProfile(request.SourceID)
	if err != nil {
		return PortForward{}, err
	}
	definition := PortForwardConfig{
		ID:         s.nextForwardID(),
		Name:       request.Name,
		SourceID:   request.SourceID,
		Direction:  request.Direction,
		ListenHost: request.ListenHost,
		ListenPort: request.ListenPort,
		TargetHost: request.TargetHost,
		TargetPort: request.TargetPort,
	}
	return s.startForwardDefinition(definition, profile, func(defs []PortForwardConfig) []PortForwardConfig {
		return append(defs, definition)
	})
}

// UpdateForward 用新参数替换一条转发定义并按新参数重启；
// 监听端口已被占用时仍然保存新定义，只是不启动。
func (s *PortService) UpdateForward(id string, request PortForwardRequest) (PortForward, error) {
	id = strings.TrimSpace(id)
	if _, ok := s.forwardDefinition(id); !ok {
		return PortForward{}, userError("errors.port.forwardNotFound")
	}
	request, err := normalizeForward(request)
	if err != nil {
		return PortForward{}, err
	}
	profile, err := s.sourceProfile(request.SourceID)
	if err != nil {
		return PortForward{}, err
	}
	definition := PortForwardConfig{
		ID:         id,
		Name:       request.Name,
		SourceID:   request.SourceID,
		Direction:  request.Direction,
		ListenHost: request.ListenHost,
		ListenPort: request.ListenPort,
		TargetHost: request.TargetHost,
		TargetPort: request.TargetPort,
	}
	// 先停止旧隧道，避免旧监听占用新端口而被误判为端口已被占用。
	if err := s.StopForward(id); err != nil {
		return PortForward{}, err
	}
	return s.startForwardDefinition(definition, profile, func(defs []PortForwardConfig) []PortForwardConfig {
		result := make([]PortForwardConfig, len(defs))
		for index, forward := range defs {
			if forward.ID == id {
				result[index] = definition
			} else {
				result[index] = forward
			}
		}
		return result
	})
}

// ReorderForwards 按给定 ID 顺序保存转发定义，用于列表拖动排序。
// 未出现在 ids 中的定义（例如并发新增）保持原有相对顺序追加在末尾，不丢弃任何定义。
func (s *PortService) ReorderForwards(ids []string) error {
	if s == nil || s.config == nil {
		return userError("errors.common.configNotInitialized")
	}
	return s.persistForwards(func(defs []PortForwardConfig) []PortForwardConfig {
		byID := make(map[string]PortForwardConfig, len(defs))
		for _, definition := range defs {
			byID[definition.ID] = definition
		}
		result := make([]PortForwardConfig, 0, len(defs))
		placed := make(map[string]bool, len(defs))
		for _, id := range ids {
			id = strings.TrimSpace(id)
			definition, ok := byID[id]
			if !ok || placed[id] {
				continue
			}
			placed[id] = true
			result = append(result, definition)
		}
		for _, definition := range defs {
			if !placed[definition.ID] {
				result = append(result, definition)
			}
		}
		return result
	})
}

// StartForward 启动一条已持久化但未运行的转发（已停止或重连失败）。
func (s *PortService) StartForward(id string) error {
	id = strings.TrimSpace(id)
	definition, ok := s.forwardDefinition(id)
	if !ok {
		return userError("errors.port.forwardNotFound")
	}
	profile, err := s.sourceProfile(definition.SourceID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	existing := s.tunnels[id]
	if existing != nil && existing.Status != "failed" {
		s.mu.Unlock()
		return nil
	}
	if existing != nil {
		delete(s.tunnels, id)
	}
	s.mu.Unlock()
	if existing != nil {
		existing.cancel()
	}
	tunnel := newPortTunnel(definition, profile)
	client, listener, err := s.openTunnel(tunnel.ctx, tunnel)
	if err != nil {
		tunnel.cancel()
		return err
	}
	tunnel.client, tunnel.listener, tunnel.Status = client, listener, "connected"
	s.mu.Lock()
	s.tunnels[id] = tunnel
	s.mu.Unlock()
	go s.runTunnel(tunnel)
	return nil
}

// listenError 标记监听端口绑定失败，与 SSH 连接失败区分开：
// 绑定失败可以在保留转发定义的前提下不启动，连接失败则视为整体失败。
// 远端（SSH）只返回“拒绝监听”，无法进一步区分是否端口被占用。
type listenError struct{ err error }

func (e *listenError) Error() string { return e.err.Error() }
func (e *listenError) Unwrap() error { return e.err }

func (s *PortService) openTunnel(ctx context.Context, tunnel *portTunnel) (*ssh.Client, net.Listener, error) {
	client, err := s.dial(ctx, tunnel.profile)
	if err != nil {
		return nil, nil, err
	}
	address := net.JoinHostPort(tunnel.ListenHost, strconv.Itoa(tunnel.ListenPort))
	var listener net.Listener
	if tunnel.Direction == "local" {
		listener, err = net.Listen("tcp", address)
	} else {
		listener, err = client.Listen("tcp", address)
	}
	if err != nil {
		client.Close()
		return nil, nil, &listenError{err: err}
	}
	return client, listener, nil
}

// listenUnavailable 判断监听端口是否不可用：本地端口已被占用，或远端拒绝监听。
func listenUnavailable(direction string, err error) bool {
	var failed *listenError
	if !errors.As(err, &failed) {
		return false
	}
	if direction == "local" {
		return errors.Is(failed.err, syscall.EADDRINUSE)
	}
	// 远端仅返回“拒绝监听”，最常见原因是端口已被占用。
	return true
}

// listenUnavailableReason 把监听失败转换成用户可见的多语言错误。
func listenUnavailableReason(definition PortForwardConfig, err error) error {
	if errors.Is(err, syscall.EADDRINUSE) {
		return userErrorParams("errors.port.portInUse", map[string]any{
			"address": net.JoinHostPort(definition.ListenHost, strconv.Itoa(definition.ListenPort)),
		})
	}
	return userErrorCause("errors.port.listenDenied", err)
}

func relayPorts(inbound, outbound net.Conn) {
	defer inbound.Close()
	defer outbound.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	copyOne := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if tcp, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = tcp.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go copyOne(outbound, inbound)
	go copyOne(inbound, outbound)
	wg.Wait()
}

func (s *PortService) serveTunnel(tunnel *portTunnel, client *ssh.Client, listener net.Listener) {
	for {
		incoming, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			address := net.JoinHostPort(tunnel.TargetHost, strconv.Itoa(tunnel.TargetPort))
			var target net.Conn
			var dialErr error
			if tunnel.Direction == "local" {
				target, dialErr = client.Dial("tcp", address)
			} else {
				target, dialErr = (&net.Dialer{Timeout: 10 * time.Second}).DialContext(tunnel.ctx, "tcp", address)
			}
			if dialErr != nil {
				incoming.Close()
				return
			}
			relayPorts(incoming, target)
		}()
	}
}

func watchSSHAlive(ctx context.Context, client *ssh.Client, done <-chan struct{}) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			reply := make(chan error, 1)
			go func() { _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); reply <- err }()
			select {
			case err := <-reply:
				if err != nil {
					_ = client.Close()
					return
				}
			case <-time.After(10 * time.Second):
				_ = client.Close()
				return
			case <-ctx.Done():
				return
			case <-done:
				return
			}
		}
	}
}

func (s *PortService) runTunnel(tunnel *portTunnel) {
	for {
		s.mu.Lock()
		client, listener := tunnel.client, tunnel.listener
		s.mu.Unlock()
		go s.serveTunnel(tunnel, client, listener)
		watchDone := make(chan struct{})
		go watchSSHAlive(tunnel.ctx, client, watchDone)
		wait := make(chan error, 1)
		go func() { wait <- client.Wait() }()
		select {
		case <-tunnel.ctx.Done():
		case <-wait:
		}
		close(watchDone)
		_ = listener.Close()
		_ = client.Close()
		if tunnel.ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		tunnel.Status = "reconnecting"
		tunnel.Retries = 0
		tunnel.client = nil
		tunnel.listener = nil
		s.mu.Unlock()
		connected := false
		for retry := 1; retry <= 5; retry++ {
			delay := time.Second << (retry - 1)
			select {
			case <-tunnel.ctx.Done():
				return
			case <-time.After(delay):
			}
			s.mu.Lock()
			tunnel.Retries = retry
			s.mu.Unlock()
			newClient, newListener, err := s.openTunnel(tunnel.ctx, tunnel)
			if err != nil {
				s.mu.Lock()
				tunnel.Error = err.Error()
				s.mu.Unlock()
				continue
			}
			s.mu.Lock()
			tunnel.client, tunnel.listener, tunnel.Status, tunnel.Error = newClient, newListener, "connected", ""
			s.mu.Unlock()
			connected = true
			break
		}
		if !connected {
			s.mu.Lock()
			tunnel.Status = "failed"
			s.mu.Unlock()
			return
		}
	}
}

// configForwards 复制当前持久化的转发定义；无配置服务时返回空。
func (s *PortService) configForwards() []PortForwardConfig {
	if s == nil || s.config == nil {
		return nil
	}
	return append([]PortForwardConfig(nil), s.config.Get().PortForwards...)
}

// GetForwards 返回所有持久化定义及其运行态；未运行的转发状态为 stopped。
func (s *PortService) GetForwards() []PortForward {
	definitions := s.configForwards()
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]PortForward, 0, len(definitions))
	for _, definition := range definitions {
		forward := PortForward{
			ID:         definition.ID,
			Name:       definition.Name,
			SourceID:   definition.SourceID,
			Direction:  definition.Direction,
			ListenHost: definition.ListenHost,
			ListenPort: definition.ListenPort,
			TargetHost: definition.TargetHost,
			TargetPort: definition.TargetPort,
			Status:     "stopped",
		}
		if tunnel := s.tunnels[definition.ID]; tunnel != nil {
			forward.Status = tunnel.Status
			forward.Retries = tunnel.Retries
			forward.Error = tunnel.Error
		}
		result = append(result, forward)
	}
	return result
}

// StopForward 断开运行中的隧道但保留定义，之后可通过 StartForward 再次启动。
func (s *PortService) StopForward(id string) error {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	tunnel := s.tunnels[id]
	if tunnel != nil {
		delete(s.tunnels, id)
	}
	s.mu.Unlock()
	if tunnel == nil {
		if _, ok := s.forwardDefinition(id); !ok {
			return userError("errors.port.forwardNotFound")
		}
		return nil
	}
	tunnel.cancel()
	s.mu.Lock()
	listener, client := tunnel.listener, tunnel.client
	s.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	if client != nil {
		_ = client.Close()
	}
	return nil
}

// DeleteForward 先停止隧道，再从持久化定义中移除。
func (s *PortService) DeleteForward(id string) error {
	id = strings.TrimSpace(id)
	if _, ok := s.forwardDefinition(id); !ok {
		return userError("errors.port.forwardNotFound")
	}
	if err := s.StopForward(id); err != nil {
		return err
	}
	return s.persistForwards(func(defs []PortForwardConfig) []PortForwardConfig {
		result := make([]PortForwardConfig, 0, len(defs))
		for _, forward := range defs {
			if forward.ID != id {
				result = append(result, forward)
			}
		}
		return result
	})
}
func (s *PortService) shutdown() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.tunnels))
	for id := range s.tunnels {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		_ = s.StopForward(id)
	}
}

// syncForwardTunnels 停止定义已被外部删除或改写的隧道。转发自身的增删改由
// PortService 显式处理，配置变更回调不应因此停掉仍在使用的其它隧道。
func (s *PortService) syncForwardTunnels(definitions []PortForwardConfig) {
	byID := make(map[string]PortForwardConfig, len(definitions))
	for _, definition := range definitions {
		byID[definition.ID] = definition
	}
	s.mu.Lock()
	stale := make([]string, 0, len(s.tunnels))
	for id, tunnel := range s.tunnels {
		definition, ok := byID[id]
		if !ok || !tunnel.matches(definition) {
			stale = append(stale, id)
		}
	}
	s.mu.Unlock()
	for _, id := range stale {
		_ = s.StopForward(id)
	}
}
