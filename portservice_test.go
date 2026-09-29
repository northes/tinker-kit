package main

import (
	"context"
	"path/filepath"
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

func TestNormalizeForward(t *testing.T) {
	request, err := normalizeForward(PortForwardRequest{SourceID: " source ", Direction: "local", ListenPort: 8080, TargetPort: 80})
	if err != nil || request.SourceID != "source" || request.ListenHost != "127.0.0.1" || request.TargetHost != "127.0.0.1" {
		t.Fatalf("unexpected normalized request: %+v, %v", request, err)
	}
	_, err = normalizeForward(PortForwardRequest{SourceID: "source", Direction: "remote", ListenPort: 70000, TargetPort: 80})
	if err == nil {
		t.Fatal("expected invalid port rejection")
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
