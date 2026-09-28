package main

import "testing"

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
