package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestResetConfigStopsPortForwardsFromReplacedConfig(t *testing.T) {
	cfg := defaultConfig()
	cfg.SSHProfiles = []SSHProfile{{ID: "profile", Name: "Host", Origin: "manual", Host: "host", Username: "user", Password: "secret", Port: 22}}
	cfg.PortSources = []PortSource{{ID: "remote", Name: "Host", Kind: "ssh", SSHProfileID: "profile"}}
	cfg.PortForwards = []PortForwardConfig{{ID: "forward", SourceID: "remote", Direction: "local", ListenHost: "127.0.0.1", ListenPort: 8080, TargetHost: "127.0.0.1", TargetPort: 80}}
	config := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(cfg)}
	service := NewPortService(config)
	ctx, cancel := context.WithCancel(context.Background())
	service.tunnels["forward"] = &portTunnel{PortForward: PortForward{ID: "forward"}, ctx: ctx, cancel: cancel}

	if _, err := config.ResetConfig(); err != nil {
		t.Fatalf("ResetConfig() error = %v", err)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("reset left the old port-forward tunnel running")
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.tunnels) != 0 {
		t.Fatalf("reset retained stale tunnels: %+v", service.tunnels)
	}
}

func TestParseLsofPortsAndProcessDetails(t *testing.T) {
	output := []byte("p42\ncserver\nLalice\nR7\nf8\ntIPv4\nPTCP\nn127.0.0.1:8080->127.0.0.1:53000\nf9\ntIPv6\nPUDP\nn[::1]:5353\n")
	rows := parseLsofPorts(output)
	if len(rows) != 2 || rows[0].Port != 8080 || rows[0].Protocol != "TCP" || rows[1].Port != 5353 || rows[1].Protocol != "UDP" {
		t.Fatalf("unexpected port rows: %+v", rows)
	}
	enrichPorts(rows, []byte("42 7 alice /opt/my server\n7 1 root /sbin/parent\n"))
	if rows[0].PID != 42 || rows[0].User != "alice" || rows[0].Path != "/opt/my server" || rows[0].ParentPID != 7 || rows[0].ParentPath != "/sbin/parent" {
		t.Fatalf("unexpected process details: %+v", rows[0])
	}
}

func TestParseSSPorts(t *testing.T) {
	rows := parseSSPorts([]byte("tcp LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=123,fd=9))\nudp UNCONN 0 0 [::]:5353 [::]:*\n"))
	if len(rows) != 2 || rows[0].Port != 3000 || rows[0].PID != 123 || rows[0].Name != "node" || rows[1].Port != 5353 || rows[1].Protocol != "UDP" {
		t.Fatalf("unexpected ss rows: %+v", rows)
	}
}

// 重启后 counter 从 0 重新计数，生成的新 ID 必须避开配置里已持久化的定义，
// 否则新定义会被当成重复项丢弃，并把隧道状态挂到旧的同 ID 定义上。
func TestNextForwardIDSkipsPersistedAndRunningIDs(t *testing.T) {
	cfg := defaultConfig()
	cfg.PortForwards = []PortForwardConfig{
		{ID: "port-forward-1", SourceID: "remote", Direction: "local", ListenPort: 8080, TargetPort: 80},
		{ID: "port-forward-2", SourceID: "remote", Direction: "local", ListenPort: 8081, TargetPort: 80},
	}
	config := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(cfg)}
	service := NewPortService(config)

	if id := service.nextForwardID(); id != "port-forward-3" {
		t.Fatalf("nextForwardID() = %q, want port-forward-3", id)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.tunnels["port-forward-4"] = &portTunnel{PortForward: PortForward{ID: "port-forward-4"}, ctx: ctx, cancel: cancel}
	if id := service.nextForwardID(); id != "port-forward-5" {
		t.Fatalf("nextForwardID() = %q, want port-forward-5", id)
	}
}

func TestNormalizeForward(t *testing.T) {
	request, err := normalizeForward(PortForwardRequest{Name: "  web  ", SourceID: " source ", Direction: "local", ListenPort: 8080, TargetPort: 80})
	if err != nil || request.Name != "web" || request.SourceID != "source" || request.ListenHost != "127.0.0.1" || request.TargetHost != "127.0.0.1" {
		t.Fatalf("unexpected normalized request: %+v, %v", request, err)
	}
	_, err = normalizeForward(PortForwardRequest{SourceID: "source", Direction: "remote", ListenPort: 70000, TargetPort: 80})
	if err == nil {
		t.Fatal("expected invalid port rejection")
	}
	if _, err = normalizeForward(PortForwardRequest{Name: strings.Repeat("x", 65), SourceID: "source", Direction: "local", ListenPort: 8080, TargetPort: 80}); err == nil {
		t.Fatal("expected over-long name rejection")
	}
}

func TestNormalizePortForwardsDropsInvalidAndKeepsDanglingSource(t *testing.T) {
	forwards := []PortForwardConfig{
		{ID: "a", SourceID: "port:one", Direction: "local", ListenHost: "", ListenPort: 8080, TargetHost: "", TargetPort: 80},
		{ID: "a", SourceID: "port:dupe", Direction: "local", ListenPort: 8081, TargetPort: 80},
		{ID: "b", SourceID: "local", Direction: "local", ListenPort: 8082, TargetPort: 80},
		{ID: "", SourceID: "port:empty", Direction: "local", ListenPort: 8083, TargetPort: 80},
		{ID: "c", SourceID: "port:deleted", Direction: "remote", ListenPort: 70000, TargetPort: 80},
	}
	result := normalizePortForwards(forwards)
	if len(result) != 1 {
		t.Fatalf("expected only the first valid definition, got %+v", result)
	}
	if result[0].ID != "a" || result[0].SourceID != "port:one" || result[0].ListenHost != "127.0.0.1" || result[0].TargetHost != "127.0.0.1" {
		t.Fatalf("unexpected normalized definition: %+v", result[0])
	}
}

func TestNormalizePortForwardsKeepsMissingSourceReference(t *testing.T) {
	result := normalizePortForwards([]PortForwardConfig{
		{ID: "d", SourceID: "port:deleted", Direction: "local", ListenPort: 9000, TargetPort: 8080},
	})
	if len(result) != 1 || result[0].SourceID != "port:deleted" {
		t.Fatalf("dangling source reference should be kept: %+v", result)
	}
}

func TestListenUnavailableClassification(t *testing.T) {
	occupied := &net.OpError{Op: "listen", Net: "tcp", Err: &os.SyscallError{Syscall: "bind", Err: syscall.EADDRINUSE}}
	if !listenUnavailable("local", &listenError{err: occupied}) {
		t.Fatal("an occupied local port should count as unavailable")
	}
	if listenUnavailable("local", &listenError{err: errors.New("bind: permission denied")}) {
		t.Fatal("non-EADDRINUSE local listen failures are not occupied ports")
	}
	if !listenUnavailable("remote", &listenError{err: errors.New("ssh: tcpip-forward request denied by peer")}) {
		t.Fatal("a denied remote listen should count as unavailable")
	}
	if listenUnavailable("local", errors.New("ssh: handshake failed")) {
		t.Fatal("connection failures must not be treated as listen failures")
	}

	definition := PortForwardConfig{ListenHost: "127.0.0.1", ListenPort: 8080, Direction: "local"}
	if key := localizedErrorKey(listenUnavailableReason(definition, occupied)); key != "errors.port.portInUse" {
		t.Fatalf("unexpected occupied-port reason key: %q", key)
	}
	if key := localizedErrorKey(listenUnavailableReason(definition, errors.New("denied"))); key != "errors.port.listenDenied" {
		t.Fatalf("unexpected listen-denied reason key: %q", key)
	}
}

// 转发自身的增删改由 PortService 显式处理；配置变更回调只应停掉定义被外部
// 删除或改写的隧道，不能牵连其它仍在使用的隧道。
func TestSyncForwardTunnelsStopsOnlyStaleDefinitions(t *testing.T) {
	cfg := defaultConfig()
	cfg.PortForwards = []PortForwardConfig{
		{ID: "keep", SourceID: "remote", Direction: "local", ListenPort: 8080, TargetPort: 80},
		{ID: "changed", SourceID: "remote", Direction: "local", ListenPort: 8081, TargetPort: 80},
	}
	config := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(cfg)}
	service := NewPortService(config)
	definitions := config.Get().PortForwards

	keep := newPortTunnel(definitions[0], SSHProfile{})
	changed := newPortTunnel(definitions[1], SSHProfile{})
	changed.ListenPort = 9999
	gone := newPortTunnel(PortForwardConfig{ID: "gone", SourceID: "remote", Direction: "local", ListenHost: "127.0.0.1", ListenPort: 9000, TargetHost: "127.0.0.1", TargetPort: 9000}, SSHProfile{})
	service.tunnels["keep"] = keep
	service.tunnels["changed"] = changed
	service.tunnels["gone"] = gone

	next := append(append([]PortForwardConfig(nil), definitions...), PortForwardConfig{ID: "added", SourceID: "remote", Direction: "local", ListenHost: "127.0.0.1", ListenPort: 8082, TargetHost: "127.0.0.1", TargetPort: 80})
	service.syncForwardTunnels(next)

	select {
	case <-keep.ctx.Done():
		t.Fatal("adding a forward must not stop an unrelated running tunnel")
	default:
	}
	for name, tunnel := range map[string]*portTunnel{"changed": changed, "gone": gone} {
		select {
		case <-tunnel.ctx.Done():
		default:
			t.Fatalf("%s tunnel with an outdated definition should be stopped", name)
		}
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.tunnels) != 1 {
		t.Fatalf("unexpected tunnels after sync: %+v", service.tunnels)
	}
}

// 拖动排序只改变定义顺序：未出现的 ID 不能丢，顺序要落库。
func TestReorderForwardsPersistsOrderWithoutDroppingDefinitions(t *testing.T) {
	cfg := defaultConfig()
	cfg.PortForwards = []PortForwardConfig{
		{ID: "a", SourceID: "remote", Direction: "local", ListenPort: 8080, TargetPort: 80},
		{ID: "b", SourceID: "remote", Direction: "local", ListenPort: 8081, TargetPort: 80},
		{ID: "c", SourceID: "remote", Direction: "local", ListenPort: 8082, TargetPort: 80},
	}
	config := &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: normalizeConfig(cfg)}
	service := NewPortService(config)

	if err := service.ReorderForwards([]string{"c", "unknown", "a"}); err != nil {
		t.Fatalf("ReorderForwards() error = %v", err)
	}
	ids := make([]string, 0, 3)
	for _, forward := range config.Get().PortForwards {
		ids = append(ids, forward.ID)
	}
	if got, want := strings.Join(ids, ","), "c,a,b"; got != want {
		t.Fatalf("forward order after reorder = %q, want %q", got, want)
	}
}
