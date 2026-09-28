package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

type PortEntry struct {
	Port       int    `json:"port"`
	Address    string `json:"address"`
	Protocol   string `json:"protocol"`
	PID        int    `json:"pid"`
	Name       string `json:"name"`
	User       string `json:"user"`
	Path       string `json:"path"`
	ParentPID  int    `json:"parentPID"`
	ParentPath string `json:"parentPath"`
}

type PortSource struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	SSHProfileID string `json:"sshProfileID"`
}

type PortForwardRequest struct {
	SourceID   string `json:"sourceID"`
	Direction  string `json:"direction"`
	ListenHost string `json:"listenHost"`
	ListenPort int    `json:"listenPort"`
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
}

type PortForward struct {
	ID         string `json:"id"`
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
	return &PortService{config: config, tunnels: make(map[string]*portTunnel)}
}
func (s *PortService) ServiceName() string { return "PortService" }

func normalizePortSources(sources []PortSource, profileNames map[string]string) []PortSource {
	result := defaultPortSources()
	seen := map[string]bool{"local": true}
	for _, source := range sources {
		id := strings.TrimSpace(source.ID)
		kind := strings.ToLower(strings.TrimSpace(source.Kind))
		profileID := strings.TrimSpace(source.SSHProfileID)
		if id == "" || id == "local" || seen[id] || kind != "ssh" || profileID == "" {
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
		normalized := defaultPortSources()
		seen := map[string]bool{"local": true}
		for index, source := range sources {
			if source.ID == "local" || source.Kind == "local" {
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

func enrichPorts(rows []PortEntry, output []byte) {
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

func (s *PortService) ListPorts(profileID string) ([]PortEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if (profileID == "" || profileID == "local") && runtime.GOOS == "windows" {
		return listWindowsPorts(ctx)
	}
	var portOutput, ps []byte
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
		output, err := session.Output("if command -v lsof >/dev/null 2>&1; then printf '__PORT_LSOF__\\n'; lsof -nP -iTCP -iUDP -FpcLfnPR || true; elif command -v ss >/dev/null 2>&1; then printf '__PORT_SS__\\n'; ss -H -tunap; else exit 127; fi; printf '__PORT_PS__\\n'; ps -eo pid=,ppid=,user=,comm=")
		if err != nil {
			return nil, userErrorCause("errors.port.scanFailed", err)
		}
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
		portOutput, ps = parts[0], parts[1]
	}
	var rows []PortEntry
	if mode == "ss" {
		rows = parseSSPorts(portOutput)
	} else {
		rows = parseLsofPorts(portOutput)
	}
	enrichPorts(rows, ps)
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
  $processes[[int]$process.ProcessId] = [pscustomobject]@{ Name=$process.Name; Path=$process.ExecutablePath; ParentPID=$process.ParentProcessId; User=$owner }
}
foreach ($row in $rows) {
  $process = $processes[[int]$row.PID]
  $row | Add-Member -NotePropertyName Name -NotePropertyValue $process.Name
  $row | Add-Member -NotePropertyName User -NotePropertyValue $process.User
  $row | Add-Member -NotePropertyName Path -NotePropertyValue $process.Path
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
	request.SourceID = strings.TrimSpace(request.SourceID)
	request.ListenHost = strings.TrimSpace(request.ListenHost)
	request.TargetHost = strings.TrimSpace(request.TargetHost)
	if request.ListenHost == "" {
		request.ListenHost = "127.0.0.1"
	}
	if request.TargetHost == "" {
		request.TargetHost = "127.0.0.1"
	}
	if request.SourceID == "" || request.SourceID == "local" || (request.Direction != "local" && request.Direction != "remote") || !validForwardHost(request.ListenHost) || !validForwardHost(request.TargetHost) || !validForwardPort(request.ListenPort) || !validForwardPort(request.TargetPort) {
		return request, userError("errors.port.invalidForward")
	}
	return request, nil
}

func (s *PortService) StartForward(request PortForwardRequest) (PortForward, error) {
	request, err := normalizeForward(request)
	if err != nil {
		return PortForward{}, err
	}
	profile, err := s.sourceProfile(request.SourceID)
	if err != nil {
		return PortForward{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	tunnel := &portTunnel{PortForward: PortForward{ID: fmt.Sprintf("port-forward-%d", s.counter.Add(1)), SourceID: request.SourceID, Direction: request.Direction, ListenHost: request.ListenHost, ListenPort: request.ListenPort, TargetHost: request.TargetHost, TargetPort: request.TargetPort, Status: "connecting"}, profile: profile, ctx: ctx, cancel: cancel}
	client, listener, err := s.openTunnel(ctx, tunnel)
	if err != nil {
		cancel()
		return PortForward{}, err
	}
	tunnel.client, tunnel.listener, tunnel.Status = client, listener, "connected"
	s.mu.Lock()
	s.tunnels[tunnel.ID] = tunnel
	s.mu.Unlock()
	snapshot := tunnel.PortForward
	go s.runTunnel(tunnel)
	return snapshot, nil
}

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
		return nil, nil, err
	}
	return client, listener, nil
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

func (s *PortService) GetForwards() []PortForward {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]PortForward, 0, len(s.tunnels))
	for _, tunnel := range s.tunnels {
		result = append(result, tunnel.PortForward)
	}
	return result
}
func (s *PortService) StopForward(id string) error {
	s.mu.Lock()
	tunnel := s.tunnels[id]
	if tunnel != nil {
		delete(s.tunnels, id)
	}
	s.mu.Unlock()
	if tunnel == nil {
		return userError("errors.port.forwardNotFound")
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
