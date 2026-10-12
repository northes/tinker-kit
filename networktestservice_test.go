package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestParseNetworkTargetRTSP(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		wantErr  bool
		host     string
		port     string
		username string
		password string
	}{
		{name: "explicit port", input: "rtsp://camera.local:8554/stream", host: "camera.local", port: "8554"},
		{name: "default port", input: "rtsp://example.com/media", host: "example.com", port: "554"},
		{name: "secure default port", input: "rtsps://example.com/media", host: "example.com", port: "322"},
		{name: "bare host gets rtsp scheme", input: "example.com/media", host: "example.com", port: "554"},
		{name: "http scheme is rejected", input: "http://example.com/media", wantErr: true},
		{name: "missing host is rejected", input: "rtsp:///media", wantErr: true},
		{name: "embedded credentials are extracted", input: "rtsp://user:secret@example.com/media", host: "example.com", port: "554", username: "user", password: "secret"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			target, err := parseNetworkTarget("rtsp", testCase.input)
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("parseNetworkTarget(%q) = %+v, want error", testCase.input, target)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseNetworkTarget(%q) returned error: %v", testCase.input, err)
			}
			if target.Host != testCase.host || target.Port != testCase.port {
				t.Fatalf("parseNetworkTarget(%q) = %s:%s, want %s:%s", testCase.input, target.Host, target.Port, testCase.host, testCase.port)
			}
			if testCase.username != "" && (target.creds == nil || target.creds.username != testCase.username || target.creds.password != testCase.password) {
				t.Fatalf("parseNetworkTarget(%q) credentials = %+v", testCase.input, target.creds)
			}
			if testCase.password != "" && strings.Contains(target.URL.String(), testCase.password) {
				t.Fatalf("parsed URL kept the password: %q", target.URL.String())
			}
		})
	}
}

func TestParseNetworkTargetRejectsCredentialsForOtherProtocols(t *testing.T) {
	if _, err := parseNetworkTarget("http", "https://user:secret@example.com/"); err == nil {
		t.Fatal("HTTP targets must not accept embedded credentials")
	}
	if _, err := parseNetworkTarget("websocket", "wss://user:secret@example.com/socket"); err == nil {
		t.Fatal("WebSocket targets must not accept embedded credentials")
	}
}

func TestReadRTSPResponse(t *testing.T) {
	response, err := readRTSPResponse(bufio.NewReader(strings.NewReader("RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: 5\r\n\r\nv=0\r\n")))
	if err != nil {
		t.Fatalf("readRTSPResponse returned error: %v", err)
	}
	if response.statusCode != 200 || response.reason != "OK" || response.protocol != "RTSP/1.0" {
		t.Fatalf("unexpected status line: %s %s %s", response.protocol, strconv.Itoa(response.statusCode), response.reason)
	}
	if response.header.Get("Content-Type") != "application/sdp" {
		t.Fatalf("unexpected Content-Type: %q", response.header.Get("Content-Type"))
	}
	if string(response.body) != "v=0\r\n" {
		t.Fatalf("unexpected body: %q", response.body)
	}
	summary := rtspResponseSummary(response)
	for _, expected := range []string{"RTSP/1.0 200 OK", "Cseq: 2", "v=0"} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("summary %q does not contain %q", summary, expected)
		}
	}
}

func TestReadRTSPResponseTruncatesLargeBody(t *testing.T) {
	header := "RTSP/1.0 200 OK\r\nContent-Length: " + strconv.Itoa(maxRTSPResponseBytes+1024) + "\r\n\r\n"
	response, err := readRTSPResponse(bufio.NewReader(io.MultiReader(strings.NewReader(header), strings.NewReader(strings.Repeat("a", maxRTSPResponseBytes+1024)))))
	if err != nil {
		t.Fatalf("readRTSPResponse returned error: %v", err)
	}
	if len(response.body) != maxRTSPResponseBytes || !response.bodyTruncated {
		t.Fatalf("body length %d, truncated %v; want %d and true", len(response.body), response.bodyTruncated, maxRTSPResponseBytes)
	}
	if !strings.Contains(rtspResponseSummary(response), "truncated") {
		t.Fatal("summary should report the truncated body")
	}
}

func TestRTSPStatusErrorExplainsFailures(t *testing.T) {
	authRequired := &rtspResponse{statusCode: http.StatusUnauthorized, reason: "Unauthorized", statusLine: "401 Unauthorized", header: make(http.Header)}
	if message := rtspStatusError("DESCRIBE", authRequired); message == nil || !strings.Contains(message.Error(), "networkTestTool.backend.rtspStatus") {
		t.Fatalf("401 should be reported as a failure, got %v", message)
	}
	notice := &rtspResponse{statusCode: 404, reason: "Not Found", statusLine: "404 Not Found", header: make(http.Header)}
	notice.header.Add("Notice", "stream not found")
	message := rtspStatusError("DESCRIBE", notice)
	if message == nil || !strings.Contains(message.Error(), "networkTestTool.backend.rtspStatusWithNotice") || !strings.Contains(message.Error(), "stream not found") {
		t.Fatalf("Notice header should be surfaced, got %v", message)
	}
	if rtspStatusError("OPTIONS", &rtspResponse{statusCode: 204, statusLine: "204 No Content"}) != nil {
		t.Fatal("2xx responses should not be turned into errors")
	}
}

func TestRunRTSPProbesOptionsAndDescribe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go serveTestRTSP(listener)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	request := NetworkTestRequest{Protocol: "rtsp", Target: "rtsp://" + listener.Addr().String() + "/stream", TimeoutMillis: 5000, DNSMode: "system", RunID: "test"}
	if err := run.runRTSP(request); err != nil {
		t.Fatalf("runRTSP returned error: %v", err)
	}

	options := run.stages["rtsp-options"]
	if options.Status != "success" || options.StatusCode != http.StatusOK {
		t.Fatalf("rtsp-options stage = %+v", options)
	}
	if !strings.Contains(options.Response, "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN") || !strings.Contains(options.Response, "Server: SmokeRTSP/1.0") {
		t.Fatalf("options response dump misses server capabilities: %q", options.Response)
	}
	describe := run.stages["rtsp-describe"]
	if describe.Status != "success" || describe.StatusCode != http.StatusOK {
		t.Fatalf("rtsp-describe stage = %+v", describe)
	}
	if describe.Meta["mediaSections"] != "1" || describe.Meta["mediaTypes"] != "video" {
		t.Fatalf("describe media metadata = %v", describe.Meta)
	}
	if !strings.Contains(describe.Response, "m=video 0 RTP/AVP 96") {
		t.Fatalf("describe response misses the SDP body: %q", describe.Response)
	}
	if describe.Meta["requestURI"] != "rtsp://"+listener.Addr().String()+"/stream" {
		t.Fatalf("describe request URI = %q", describe.Meta["requestURI"])
	}
}

func TestRunRTSPReportsServerRejection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go serveRejectingTestRTSP(listener)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	err = run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: "rtsp://" + listener.Addr().String() + "/stream", TimeoutMillis: 5000, DNSMode: "system", RunID: "test"})
	if err == nil || !strings.Contains(err.Error(), "networkTestTool.backend.rtspStatus") || !strings.Contains(err.Error(), `"status":"401 Unauthorized"`) {
		t.Fatalf("expected the 401 failure to surface, got %v", err)
	}
	if auth := run.stages["rtsp-auth"]; auth.Status != "error" || !strings.Contains(auth.Error, "networkTestTool.backend.rtspAuthRequired") {
		t.Fatalf("rtsp-auth stage = %+v", auth)
	}
	if stage := run.stages["rtsp-options"]; stage.Status != "error" || stage.StatusCode != http.StatusUnauthorized {
		t.Fatalf("rtsp-options stage = %+v", stage)
	}
	authMeta := run.stages["rtsp-auth"].Meta
	if authMeta["challenge"] != `Digest realm="camera", nonce="nonce-value", algorithm=MD5` || authMeta["credentialsSent"] != "false" {
		t.Fatalf("authentication challenge should be visible in metadata: %v", authMeta)
	}
	if _, ok := run.stages["rtsp-describe"]; ok {
		t.Fatal("DESCRIBE should not run after a rejected OPTIONS")
	}
}

// serveTestRTSP 提供一个最小 RTSP 服务端，只处理本用例需要的 OPTIONS 与 DESCRIBE。
func serveTestRTSP(listener net.Listener) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	serveTestRTSPConn(conn)
}

// serveTestRTSPConn 在一条连接上完成 OPTIONS 与 DESCRIBE 的往返；明文与 TLS 之上都复用它。
func serveTestRTSPConn(conn net.Conn) {
	reader := bufio.NewReader(conn)
	method, cseq, err := readTestRTSPRequest(reader)
	if err != nil || method != "OPTIONS" {
		return
	}
	_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nServer: SmokeRTSP/1.0\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n")
	method, cseq, err = readTestRTSPRequest(reader)
	if err != nil || method != "DESCRIBE" {
		return
	}
	body := "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Smoke\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n"
	_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nContent-Type: application/sdp\r\nContent-Base: rtsp://127.0.0.1/stream/\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
}

// readTestRTSPRequest 解析请求起始行与头部，返回方法与 CSeq。
// 这里不使用 http.ReadRequest：它在 HTTP/1.1 下会拒绝 RTSP 的绝对 URI，而 RTSP 服务端应当接受。
func readTestRTSPRequest(reader *bufio.Reader) (string, string, error) {
	requestLine, err := reader.ReadString('\n')
	if err != nil {
		return "", "", err
	}
	fields := strings.Fields(strings.TrimSpace(requestLine))
	if len(fields) != 3 {
		return "", "", fmt.Errorf("unexpected request line %q", requestLine)
	}
	cseq := ""
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return "", "", err
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "" {
			break
		}
		if key, value, ok := strings.Cut(trimmed, ":"); ok && strings.EqualFold(strings.TrimSpace(key), "CSeq") {
			cseq = strings.TrimSpace(value)
		}
	}
	return fields[0], cseq, nil
}

func TestRunNetworkTestRTSPResultPayload(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go serveTestRTSP(listener)

	service := NewNetworkTestService()
	result := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://" + listener.Addr().String() + "/stream",
		TimeoutMillis: 5000,
		DNSMode:       "system",
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v", result)
	}
	if result.Protocol != "rtsp" || result.Error != "" {
		t.Fatalf("unexpected result header: %+v", result)
	}
	stages := make(map[string]NetworkTestStage, len(result.Stages))
	for _, stage := range result.Stages {
		stages[stage.ID] = stage
	}
	for _, id := range []string{"dns-target", "tcp-connect", "rtsp-options", "rtsp-describe"} {
		stage, ok := stages[id]
		if !ok {
			t.Fatalf("stage %q missing from result: %+v", id, result.Stages)
		}
		if stage.Status != "success" || stage.RunID != result.RunID {
			t.Fatalf("stage %q = %+v", id, stage)
		}
	}
	if stages["rtsp-describe"].Meta["mediaSections"] != "1" {
		t.Fatalf("describe metadata = %v", stages["rtsp-describe"].Meta)
	}
}

func TestRTSPDigestAuthorizationHeader(t *testing.T) {
	credentials := &rtspCredentials{username: "user", password: "secret"}
	// 期望值按 RFC 2617 的 HA1/HA2 公式独立计算：
	// HA1 = MD5("user:realm:secret")，HA2 = MD5("DESCRIBE:rtsp://host/path")，
	// response = MD5(HA1:nonce:HA2)。
	md5Hex := func(value string) string {
		sum := md5.Sum([]byte(value))
		return hex.EncodeToString(sum[:])
	}
	expected := md5Hex(md5Hex("user:realm:secret") + ":nonce-value:" + md5Hex("DESCRIBE:rtsp://host/path"))
	tests := []struct {
		name      string
		challenge *rtspAuthChallenge
		address   string
		want      []string
	}{
		{
			name:      "md5 without qop",
			challenge: &rtspAuthChallenge{realm: "realm", nonce: "nonce-value", algorithm: "MD5", opaque: "opaque-value"},
			address:   "rtsp://host/path",
			want: []string{
				`username="user"`, `realm="realm"`, `nonce="nonce-value"`, `uri="rtsp://host/path"`,
				"algorithm=MD5", `opaque="opaque-value"`, `response="` + expected + `"`,
			},
		},
		{
			name:      "basic fallback",
			challenge: &rtspAuthChallenge{realm: "realm", basic: true},
			address:   "rtsp://host/path",
			want:      []string{"Basic " + base64.StdEncoding.EncodeToString([]byte("user:secret"))},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			header := credentials.authorizationHeader(testCase.challenge, "DESCRIBE", testCase.address, 1)
			for _, fragment := range testCase.want {
				if !strings.Contains(header, fragment) {
					t.Fatalf("Authorization %q does not contain %q", header, fragment)
				}
			}
		})
	}
	// qop=auth 时 response 依赖 cnonce/nc，这里只校验结构与独立计算一致的 nc。
	header := credentials.authorizationHeader(&rtspAuthChallenge{realm: "realm", nonce: "nonce-value", algorithm: "MD5", qop: "auth"}, "DESCRIBE", "rtsp://host/path", 1)
	for _, fragment := range []string{"qop=auth", "nc=00000001", "cnonce=", `uri="rtsp://host/path"`} {
		if !strings.Contains(header, fragment) {
			t.Fatalf("qop Authorization %q does not contain %q", header, fragment)
		}
	}
}

func TestParseRTSPAuthChallenge(t *testing.T) {
	digest := parseRTSPAuthChallenge([]string{`Digest realm="IP Camera", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41", algorithm=MD5`})
	if digest == nil || digest.algorithm != "MD5" || digest.realm != "IP Camera" || digest.nonce == "" || digest.qop != "auth" || digest.opaque == "" {
		t.Fatalf("digest challenge = %+v", digest)
	}
	if basic := parseRTSPAuthChallenge([]string{`Basic realm="camera"`}); basic == nil || !basic.basic || basic.realm != "camera" {
		t.Fatalf("basic challenge = %+v", basic)
	}
	mixed := parseRTSPAuthChallenge([]string{`Basic realm="camera"`, `Digest realm="camera", nonce="abc"`})
	if mixed == nil || mixed.basic || mixed.nonce != "abc" {
		t.Fatalf("mixed challenge should prefer Digest: %+v", mixed)
	}
	if unsupported := parseRTSPAuthChallenge([]string{`Digest realm="camera", nonce="abc", algorithm=SHA-512`}); unsupported != nil {
		t.Fatalf("unsupported Digest algorithm should be ignored, got %+v", unsupported)
	}
	if fallback := parseRTSPAuthChallenge([]string{`Digest realm="camera", nonce="abc", algorithm=SHA-512`, `Basic realm="camera"`}); fallback == nil || !fallback.basic {
		t.Fatalf("Basic should still be usable when Digest is unsupported: %+v", fallback)
	}
}

func TestRTSPAuthenticatedRequestsUseFreshSequenceNumbers(t *testing.T) {
	challenge := &rtspAuthChallenge{realm: "ipcam", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", algorithm: "MD5", qop: "auth"}
	credentials := &rtspCredentials{username: "test-user", password: "test-password"}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	failures := make(chan string, 4)
	go serveAuthenticatedTestRTSP(listener, challenge, credentials, failures)

	target := "rtsp://" + credentials.username + ":" + credentials.password + "@" + listener.Addr().String() + "/movie"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	if err := run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: target, TimeoutMillis: 5000, DNSMode: "system", RunID: "test"}); err != nil {
		select {
		case failure := <-failures:
			t.Fatalf("runRTSP returned error: %v; server said: %s", err, failure)
		default:
			t.Fatalf("runRTSP returned error: %v", err)
		}
	}
	select {
	case failure := <-failures:
		t.Fatal(failure)
	default:
	}
	// OPTIONS 用掉 CSeq 1/2（含认证重试）后，DESCRIBE 从 3 起，且它自己的认证重试用 4；
	// 阶段展示的是最终被接受的那次请求，必须与响应里的 Cseq 一致（服务端已校验无重复）。
	if got := run.stages["rtsp-describe"].Meta["cseq"]; got != "4" {
		t.Fatalf("describe CSeq = %q, want 4", got)
	}
	if response := run.stages["rtsp-describe"].Response; !strings.Contains(response, "Cseq: 4") {
		t.Fatalf("describe 响应与阶段记录的 CSeq 不一致：%q", response)
	}
	auth := run.stages["rtsp-auth"]
	if auth.Status != "success" || auth.StatusCode != http.StatusOK {
		select {
		case failure := <-failures:
			t.Fatalf("rtsp-auth stage = %+v; server said: %s", auth, failure)
		default:
			t.Fatalf("rtsp-auth stage = %+v", auth)
		}
	}
	if auth.Meta["credentialsSent"] != "true" || auth.Meta["challenge"] == "" {
		t.Fatalf("rtsp-auth metadata = %v", auth.Meta)
	}
	if strings.Contains(auth.Meta["target"], credentials.password) {
		t.Fatalf("stage metadata leaked the password: %v", auth.Meta)
	}
	if describe := run.stages["rtsp-describe"]; describe.Status != "success" || describe.Meta["mediaSections"] != "1" {
		t.Fatalf("rtsp-describe stage = %+v", describe)
	}
	if request := run.stages["rtsp-describe"].Request; strings.Contains(request, credentials.password) || strings.Contains(request, credentials.username) {
		t.Fatalf("request dump leaked credentials: %q", request)
	}
}

func TestRTSPRejectsWrongCredentials(t *testing.T) {
	challenge := &rtspAuthChallenge{realm: "ipcam", nonce: "nonce-value", algorithm: "MD5"}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go serveAuthenticatedTestRTSP(listener, challenge, &rtspCredentials{username: "user", password: "secret"}, make(chan string, 4))

	target := "rtsp://user:wrong@" + listener.Addr().String() + "/movie"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	err = run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: target, TimeoutMillis: 5000, DNSMode: "system", RunID: "test"})
	if err == nil || !strings.Contains(err.Error(), "networkTestTool.backend.rtspStatus") || !strings.Contains(err.Error(), `"status":"401 Unauthorized"`) {
		t.Fatalf("expected the 401 failure to surface, got %v", err)
	}
	auth := run.stages["rtsp-auth"]
	if auth.Status != "error" || auth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("rtsp-auth stage = %+v", auth)
	}
	if !strings.Contains(auth.Error, "networkTestTool.backend.rtspCredentialsRejected") || auth.Meta["credentialsSent"] != "true" {
		t.Fatalf("rejection detail missing: error=%q meta=%v", auth.Error, auth.Meta)
	}
}

func TestRTSPWithoutCredentialsHintsAtTargetFormat(t *testing.T) {
	challenge := &rtspAuthChallenge{realm: "ipcam", nonce: "nonce-value", algorithm: "MD5"}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go serveAuthenticatedTestRTSP(listener, challenge, &rtspCredentials{username: "user", password: "secret"}, make(chan string, 4))

	target := "rtsp://" + listener.Addr().String() + "/movie"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	err = run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: target, TimeoutMillis: 5000, DNSMode: "system", RunID: "test"})
	if err == nil || !strings.Contains(err.Error(), "networkTestTool.backend.rtspStatus") || !strings.Contains(err.Error(), `"status":"401 Unauthorized"`) {
		t.Fatalf("expected the 401 failure to surface, got %v", err)
	}
	auth := run.stages["rtsp-auth"]
	if auth.Status != "error" {
		t.Fatalf("rtsp-auth stage = %+v", auth)
	}
	if !strings.Contains(auth.Error, "networkTestTool.backend.rtspAuthRequired") || !strings.Contains(auth.Meta["challenge"], `realm="ipcam"`) {
		t.Fatalf("authentication guidance missing: error=%q meta=%v", auth.Error, auth.Meta)
	}
	if want := "rtsp://" + listener.Addr().String() + "/movie"; auth.Meta["target"] != want {
		t.Fatalf("metadata target = %q, want %q", auth.Meta["target"], want)
	}
	if auth.Meta["credentialsSent"] != "false" {
		t.Fatalf("credentialsSent = %q, want false", auth.Meta["credentialsSent"])
	}
}

// testRTSPChallengeHeader 按挑战参数生成 WWW-Authenticate 头，让服务端下发的 qop 与
// 校验逻辑保持一致。
func testRTSPChallengeHeader(challenge *rtspAuthChallenge) string {
	header := "Digest realm=\"" + challenge.realm + "\", nonce=\"" + challenge.nonce + "\", algorithm=" + challenge.algorithm
	if challenge.qop != "" {
		header += ", qop=\"" + challenge.qop + ",auth-int\""
	}
	if challenge.opaque != "" {
		header += ", opaque=\"" + challenge.opaque + "\""
	}
	return header
}

// serveRejectingTestRTSP 对所有请求都返回 401，用于验证缺凭据与服务端拒绝时的行为。
func serveRejectingTestRTSP(listener net.Listener) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for {
		method, _, cseq, _, err := readTestRTSPRequestWithAuth(reader)
		if err != nil || method != "OPTIONS" && method != "DESCRIBE" {
			return
		}
		_, _ = io.WriteString(conn, "RTSP/1.0 401 Unauthorized\r\nCSeq: "+cseq+"\r\nWWW-Authenticate: Digest realm=\"camera\", nonce=\"nonce-value\", algorithm=MD5\r\n\r\n")
	}
}

// serveAuthenticatedTestRTSP 提供一个要求 Digest 认证的最小 RTSP 服务端：OPTIONS 与
// DESCRIBE 在缺少合法 Authorization 时返回 401，认证通过后返回方法表与 SDP。
// 校验按 RFC 2617 独立计算，不调用被测代码。
func serveAuthenticatedTestRTSP(listener net.Listener, challenge *rtspAuthChallenge, credentials *rtspCredentials, failures chan<- string) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	seen := map[string]bool{}
	for {
		method, uri, cseq, authorization, err := readTestRTSPRequestWithAuth(reader)
		if err != nil {
			return
		}
		if seen[cseq] {
			failures <- "CSeq " + cseq + " was reused on one connection"
		}
		seen[cseq] = true
		if authorization == "" {
			_, _ = io.WriteString(conn, "RTSP/1.0 401 Unauthorized\r\nCSeq: "+cseq+"\r\nWWW-Authenticate: "+testRTSPChallengeHeader(challenge)+"\r\n\r\n")
			continue
		}
		if failure := verifyTestRTSPDigest(authorization, challenge, credentials, method, uri); failure != "" {
			failures <- failure
			_, _ = io.WriteString(conn, "RTSP/1.0 401 Unauthorized\r\nCSeq: "+cseq+"\r\nWWW-Authenticate: "+testRTSPChallengeHeader(challenge)+"\r\n\r\n")
			continue
		}
		if method == "DESCRIBE" {
			body := "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Movie\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n"
			_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nContent-Type: application/sdp\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
			continue
		}
		_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nServer: AuthRTSP/1.0\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n")
	}
}

func readTestRTSPRequestWithAuth(reader *bufio.Reader) (string, string, string, string, error) {
	requestLine, err := reader.ReadString('\n')
	if err != nil {
		return "", "", "", "", err
	}
	fields := strings.Fields(strings.TrimSpace(requestLine))
	if len(fields) != 3 {
		return "", "", "", "", fmt.Errorf("unexpected request line %q", requestLine)
	}
	cseq := ""
	authorization := ""
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return "", "", "", "", err
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "" {
			break
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "cseq":
			cseq = strings.TrimSpace(value)
		case "authorization":
			authorization = strings.TrimSpace(value)
		}
	}
	return fields[0], fields[1], cseq, authorization, nil
}

// verifyTestRTSPDigest 独立复算客户端摘要；返回空字符串表示校验通过。
func verifyTestRTSPDigest(header string, challenge *rtspAuthChallenge, credentials *rtspCredentials, method, uri string) string {
	value, ok := strings.CutPrefix(header, "Digest ")
	if !ok {
		return "Authorization header is not a Digest challenge response: " + header
	}
	fields := map[string]string{}
	for _, part := range splitAuthChallengeParts(value) {
		key, raw, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		fields[strings.ToLower(strings.TrimSpace(key))] = strings.Trim(strings.TrimSpace(raw), `"`)
	}
	if fields["username"] != credentials.username || fields["realm"] != challenge.realm || fields["nonce"] != challenge.nonce {
		return fmt.Sprintf("unexpected digest identity fields: %v", fields)
	}
	if fields["uri"] != uri && !(method == "OPTIONS" && fields["uri"] == "*") {
		return fmt.Sprintf("digest uri %q does not match request uri %q", fields["uri"], uri)
	}
	md5Hex := func(input string) string {
		sum := md5.Sum([]byte(input))
		return hex.EncodeToString(sum[:])
	}
	ha1 := md5Hex(credentials.username + ":" + challenge.realm + ":" + credentials.password)
	ha2 := md5Hex(method + ":" + uri)
	expected := ""
	if challenge.qop != "" {
		// RFC 2616 的 qop=auth 计算公式：MD5(HA1:nonce:nc:cnonce:qop:HA2)
		if fields["qop"] != "auth" || fields["cnonce"] == "" || fields["nc"] == "" {
			return fmt.Sprintf("qop parameters missing from digest response: %v", fields)
		}
		expected = md5Hex(ha1 + ":" + challenge.nonce + ":" + fields["nc"] + ":" + fields["cnonce"] + ":auth:" + ha2)
	} else {
		expected = md5Hex(ha1 + ":" + challenge.nonce + ":" + ha2)
	}
	if fields["response"] != expected {
		return fmt.Sprintf("digest response %q does not match independently computed %q", fields["response"], expected)
	}
	return ""
}

// 服务端同时下发 Digest 与 Basic 时，客户端应优先使用 Digest 而不是泄露明文密码。
func TestRTSPPrefersDigestOverBasicAndAuthenticates(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	basicUsed := make(chan string, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		for {
			method, _, cseq, authorization, readErr := readTestRTSPRequestWithAuth(reader)
			if readErr != nil {
				return
			}
			if strings.HasPrefix(authorization, "Basic ") {
				basicUsed <- authorization
			}
			if strings.HasPrefix(authorization, "Digest ") && method == "DESCRIBE" {
				body := "v=0\r\nm=video 0 RTP/AVP 96\r\n"
				_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nContent-Type: application/sdp\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
				continue
			}
			if strings.HasPrefix(authorization, "Digest ") {
				_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nServer: MultiChallengeRTSP\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n")
				continue
			}
			_, _ = io.WriteString(conn, "RTSP/1.0 401 Unauthorized\r\nCSeq: "+cseq+"\r\nWWW-Authenticate: Basic realm=\"camera\"\r\nWWW-Authenticate: Digest realm=\"camera\", nonce=\"nonce-value\", algorithm=MD5\r\n\r\n")
		}
	}()

	target := "rtsp://user:secret@" + listener.Addr().String() + "/movie"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	if err := run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: target, TimeoutMillis: 5000, DNSMode: "system", RunID: "test"}); err != nil {
		t.Fatalf("runRTSP returned error: %v", err)
	}
	select {
	case used := <-basicUsed:
		t.Fatalf("client must not fall back to Basic when Digest is available: %s", used)
	default:
	}
	if auth := run.stages["rtsp-auth"]; auth.Status != "success" {
		t.Fatalf("rtsp-auth stage = %+v", auth)
	}
	if describe := run.stages["rtsp-describe"]; describe.Status != "success" || describe.Meta["mediaSections"] != "1" {
		t.Fatalf("rtsp-describe stage = %+v", describe)
	}
}

// TestRTSPReportsRunningStageBeforeTimeout 复现「TCP 连接成功但服务端不回一个字节」：界面必须
// 在等待期间就拿到 running 阶段（含发出的请求报文并开始计时），而不是失败后才出现。
func TestRTSPReportsRunningStageBeforeTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		// 接受连接后既不回包也不关闭，直到测试结束。
		defer conn.Close()
		time.Sleep(4 * time.Second)
	}()

	service := NewNetworkTestService()
	var mu sync.Mutex
	var updates []NetworkTestStage
	service.setEventEmitter(func(name string, payload any) {
		if name != networkTestEvent {
			return
		}
		update, ok := payload.(NetworkTestUpdate)
		if !ok {
			return
		}
		mu.Lock()
		updates = append(updates, update.Stage)
		mu.Unlock()
	})

	result := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://" + listener.Addr().String() + "/playback?cameraid=1000000%245&type=2&recordType=1?token=1",
		TimeoutMillis: 1500,
		DNSMode:       "system",
	})
	if result.Status != "timeout" {
		t.Fatalf("result = %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()

	var running *NetworkTestStage
	var failure *NetworkTestStage
	for index := range updates {
		stage := &updates[index]
		if stage.ID != "rtsp-options" {
			continue
		}
		switch stage.Status {
		case "running":
			if running == nil {
				running = stage
			}
		case "timeout", "error":
			failure = stage
		}
	}
	if running == nil {
		t.Fatalf("rtsp-options 未先上报 running 阶段，事件序列：%+v", updates)
	}
	if !strings.Contains(running.Request, "OPTIONS rtsp://") || !strings.Contains(running.Request, "token=1") {
		t.Fatalf("running 阶段缺少请求报文：%q", running.Request)
	}
	if running.Meta["cseq"] != "1" {
		t.Fatalf("running 阶段元信息 = %v", running.Meta)
	}
	if failure == nil {
		t.Fatalf("rtsp-options 未上报失败阶段：%+v", updates)
	}
	if failure.StartedAt != running.StartedAt {
		t.Fatalf("失败阶段起始时间 %d 与 running 阶段 %d 不一致", failure.StartedAt, running.StartedAt)
	}
	if failure.DurationMillis < 1000 {
		t.Fatalf("失败阶段时长 %dms 未覆盖等待时间", failure.DurationMillis)
	}
	chain := localizedMessageChain(t, failure.Error)
	if !chainContainsKey(chain, "networkTestTool.backend.rtspNoResponse") {
		t.Fatalf("超时结论缺少关键 key：%q", failure.Error)
	}
	inner := chain[len(chain)-1]
	if params, ok := inner["params"].(map[string]any); !ok || params["method"] != "OPTIONS" {
		t.Fatalf("超时结论参数 = %v", inner["params"])
	}
	if !strings.Contains(failure.Request, "OPTIONS rtsp://") {
		t.Fatalf("失败阶段应保留已发出的请求：%q", failure.Request)
	}
}

// 服务端接受连接后立即关闭时，应给出「未发送响应即关闭」的结论，而不是笼统的超时。
func TestRTSPReportsConnectionClosedWithoutResponse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		_ = conn.Close()
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://" + listener.Addr().String() + "/movie",
		TimeoutMillis: 3000,
		DNSMode:       "system",
	})
	if result.Status != "error" {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Error, "networkTestTool.backend.rtspClosedWithoutResponse") {
		t.Fatalf("错误结论不够明确：%q", result.Error)
	}
}

// 等待响应期间取消测试：状态必须是 canceled，结论要说明是本次测试被停止，而不是服务端行为。
func TestRTSPCancelWhileWaitingReportsStopped(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		time.Sleep(4 * time.Second)
	}()

	service := NewNetworkTestService()
	running := make(chan struct{}, 1)
	service.setEventEmitter(func(name string, payload any) {
		update, ok := payload.(NetworkTestUpdate)
		if !ok || update.Stage.ID != "rtsp-options" || update.Stage.Status != "running" {
			return
		}
		select {
		case running <- struct{}{}:
		default:
		}
	})
	done := make(chan NetworkTestResult, 1)
	go func() {
		done <- service.RunNetworkTest(NetworkTestRequest{
			RunID:         "cancel-rtsp",
			Protocol:      "rtsp",
			Target:        "rtsp://" + listener.Addr().String() + "/movie",
			TimeoutMillis: 10000,
			DNSMode:       "system",
		})
	}()
	select {
	case <-running:
	case <-time.After(3 * time.Second):
		t.Fatal("rtsp-options 阶段未在等待期间开始")
	}
	service.CancelNetworkTest("cancel-rtsp")
	select {
	case result := <-done:
		if result.Status != "canceled" {
			t.Fatalf("result = %+v", result)
		}
		if !strings.Contains(result.Error, "networkTestTool.backend.rtspStoppedWhileWaiting") {
			t.Fatalf("取消结论不够明确：%q", result.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("取消后测试未结束")
	}
}

// tcp-connect 阶段必须给出真实的本机出口地址：经 VPN/代理 TUN 的连接会显示 TUN 地址，
// 只看「连接成功」无法判断流量是否真的走了物理网卡。
func TestTCPConnectReportsLocalSocketAddress(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			_ = conn.Close()
		}
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "tcp",
		Target:        listener.Addr().String(),
		TimeoutMillis: 3000,
		DNSMode:       "system",
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v", result)
	}
	var stage NetworkTestStage
	for _, item := range result.Stages {
		if item.ID == "tcp-connect" {
			stage = item
		}
	}
	host, port, err := net.SplitHostPort(stage.Meta["localAddress"])
	if err != nil || host == "" || port == "" {
		t.Fatalf("localAddress = %q（应为本机出口地址）", stage.Meta["localAddress"])
	}
	if stage.Meta["interface"] != "automatic" {
		t.Fatalf("interface = %q", stage.Meta["interface"])
	}
	if _, ok := stage.Meta["boundLocalAddress"]; ok {
		t.Fatal("未指定网卡时不应出现 boundLocalAddress")
	}
	if _, ok := result.Stages[0].Meta["reachability"]; ok {
		t.Fatal("直连不应标注 reachability")
	}
	for _, item := range result.Stages {
		if item.ID == tunnelRouteStageID {
			t.Fatal("环回直连不应上报经隧道出口阶段")
		}
	}
}

// 指定出站网卡时，同时给出被绑定的地址，便于与真实出口地址对照。
func TestTCPConnectReportsBoundLocalAddress(t *testing.T) {
	interfaceName := "lo0"
	if _, err := net.InterfaceByName(interfaceName); err != nil {
		interfaceName = "lo"
		if _, err := net.InterfaceByName(interfaceName); err != nil {
			t.Skip("没有可用的环回接口")
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			_ = conn.Close()
		}
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "tcp",
		Target:        listener.Addr().String(),
		TimeoutMillis: 3000,
		DNSMode:       "system",
		InterfaceName: interfaceName,
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v", result)
	}
	var stage NetworkTestStage
	for _, item := range result.Stages {
		if item.ID == "tcp-connect" {
			stage = item
		}
	}
	if stage.Meta["interface"] != interfaceName {
		t.Fatalf("interface = %q", stage.Meta["interface"])
	}
	if stage.Meta["boundLocalAddress"] == "" || stage.Meta["localAddress"] == "" {
		t.Fatalf("meta = %v", stage.Meta)
	}
}

// 本次拒绝「成功」误导的核心规则：识别本机是否把目标交给隧道接口转发。
func TestIsTunnelOutbound(t *testing.T) {
	cases := []struct {
		name      string
		iface     string
		local     string
		wantTunel bool
	}{
		{name: "Clash TUN 接口", iface: "utun4", local: "198.18.0.1:50999", wantTunel: true},
		{name: "Linux tun", iface: "tun0", local: "10.0.0.2:40000", wantTunel: true},
		{name: "WireGuard", iface: "wg0", local: "10.9.0.2:40000", wantTunel: true},
		{name: "Tailscale", iface: "tailscale0", local: "100.64.0.1:40000", wantTunel: true},
		{name: "接口名未知但地址是 TUN 网段", iface: "", local: "198.18.0.1:50999", wantTunel: true},
		{name: "物理网卡直连", iface: "en0", local: "192.168.31.34:50550", wantTunel: false},
		{name: "环回", iface: "lo0", local: "127.0.0.1:50550", wantTunel: false},
		{name: "没有查询结果", iface: "", local: "", wantTunel: false},
		{name: "IPv6 本地地址", iface: "en0", local: "[fe80::1%en0]:50550", wantTunel: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isTunnelOutbound(testCase.iface, testCase.local); got != testCase.wantTunel {
				t.Fatalf("isTunnelOutbound(%q, %q) = %v", testCase.iface, testCase.local, got)
			}
		})
	}
}

// 每条经隧道的连接都有自己的「经隧道出口」项：同一跳内重复上报只保留一条，
// 跟随重定向后的新一跳则必须另有一条（按跳次加后缀），不能只保留首次。
func TestReportTunnelOutboundPerHop(t *testing.T) {
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	route := &networkRoute{run: run, request: NetworkTestRequest{Protocol: "rtsp"}}
	info := networkRouteInfo{Interface: "utun4", Gateway: "198.18.0.1"}
	route.reportTunnelOutbound("[REDACTED]:9090", "198.18.0.1:50999", info)
	route.reportTunnelOutbound("[REDACTED]:9090", "198.18.0.1:50999", info)
	route.hop = 1
	route.reportTunnelOutbound("[REDACTED]:9320", "198.18.0.1:51000", info)

	stage := run.stages[tunnelRouteStageID]
	if stage.Status != "success" {
		t.Fatalf("tunnel-route 阶段 = %+v", stage)
	}
	if stage.Meta["outbound"] != "tunnel" || stage.Meta["reachability"] != "unverified" {
		t.Fatalf("tunnel-route 元信息 = %v", stage.Meta)
	}
	if stage.Meta["tunnelInterface"] != "utun4" || stage.Meta["tunnelGateway"] != "198.18.0.1" {
		t.Fatalf("tunnel-route 出口信息 = %v", stage.Meta)
	}
	for _, fragment := range []string{"networkTestTool.backend.tunnelOutbound", "[REDACTED]:9090", "utun4", "198.18.0.1"} {
		if !strings.Contains(stage.Response, fragment) {
			t.Fatalf("tunnel-route 说明缺少 %q：%q", fragment, stage.Response)
		}
	}
	if count := len(run.stages); count != 2 {
		t.Fatalf("同跳重复上报应合并、跨跳应各有一条，实际 %d 条：%+v", count, run.stages)
	}
	second, ok := run.stages["tunnel-route-redirect-1"]
	if !ok {
		t.Fatalf("跟随重定向后的隧道出口项缺失：%+v", run.stages)
	}
	if !strings.Contains(second.Response, "[REDACTED]:9320") {
		t.Fatalf("第二跳的说明未指向新地址：%q", second.Response)
	}
}

// 服务端用 302 指向新的流地址时，客户端必须跟随并在新地址上重建连接与请求。
func TestRTSPFollowsRedirectToNewEndpoint(t *testing.T) {
	media, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen media: %v", err)
	}
	defer media.Close()
	redirector, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen redirector: %v", err)
	}
	defer redirector.Close()
	go serveRedirectingTestRTSP(redirector, "rtsp://"+media.Addr().String()+"/playback/pu/1?token=123", 302)
	go serveMediaTestRTSP(media)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	request := NetworkTestRequest{Protocol: "rtsp", Target: "rtsp://" + redirector.Addr().String() + "/playback", TimeoutMillis: 5000, MaxRedirects: 3, DNSMode: "system", RunID: "test"}
	if err := run.runRTSP(request); err != nil {
		t.Fatalf("runRTSP returned error: %v", err)
	}

	origin := run.stages["rtsp-options"]
	if origin.Status != "success" || origin.StatusCode != http.StatusFound {
		t.Fatalf("rtsp-options = %+v", origin)
	}
	if origin.Meta["redirectFollowed"] != "true" || origin.Meta["redirectTarget"] != "rtsp://"+media.Addr().String()+"/playback/pu/1?token=123" {
		t.Fatalf("跳转元信息 = %v", origin.Meta)
	}
	hop := run.stages["rtsp-options-redirect-1"]
	if hop.Status != "success" || hop.StatusCode != http.StatusOK || hop.Meta["redirectCount"] != "1" {
		t.Fatalf("rtsp-options-redirect-1 = %+v", hop)
	}
	if !strings.Contains(hop.Request, "OPTIONS rtsp://"+media.Addr().String()) {
		t.Fatalf("跟随后的请求未发往新地址：%q", hop.Request)
	}
	describe := run.stages["rtsp-describe"]
	if describe.Status != "success" || describe.Meta["mediaSections"] != "1" {
		t.Fatalf("rtsp-describe = %+v", describe)
	}
	if want := "rtsp://" + media.Addr().String() + "/playback/pu/1?token=123"; describe.Meta["requestURI"] != want {
		t.Fatalf("DESCRIBE 未发往重定向后的地址：%q，期望 %q", describe.Meta["requestURI"], want)
	}
	if !strings.Contains(describe.Request, "token=123") {
		t.Fatalf("DESCRIBE 请求缺少重定向地址的查询参数：%q", describe.Request)
	}
}

// 重定向次数为 0 或超限时不再跟随，并说明是被上限拦住。
func TestRTSPRedirectLimitStopsFollowing(t *testing.T) {
	redirector, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer redirector.Close()
	go func() {
		for {
			conn, acceptErr := redirector.Accept()
			if acceptErr != nil {
				return
			}
			go serveRedirectingTestRTSPConn(conn, "rtsp://127.0.0.1:1/moved", 302)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	err = run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: "rtsp://" + redirector.Addr().String() + "/stream", TimeoutMillis: 5000, MaxRedirects: 0, DNSMode: "system", RunID: "test"})
	if err == nil || !strings.Contains(err.Error(), "networkTestTool.backend.rtspRedirectNotFollowed") || !strings.Contains(err.Error(), `"limit":0`) {
		t.Fatalf("期望被上限拦住的错误，得到 %v", err)
	}
	if stage := run.stages["rtsp-options"]; stage.Status != "error" || stage.StatusCode != http.StatusFound {
		t.Fatalf("rtsp-options = %+v", stage)
	}
	if _, ok := run.stages["rtsp-options-redirect-1"]; ok {
		t.Fatal("上限为 0 时不应产生跳转阶段")
	}

	// 超出允许范围的重定向上限在校验阶段即失败。
	if err := validateNetworkRedirectLimit(11); err == nil {
		t.Fatal("重定向上限应限制在 0..10")
	}
}

// 跨主机跳转不得继续发送原凭据：重定向到别的主机时不再带 Authorization。
func TestRTSPRedirectDropsCredentialsAcrossHosts(t *testing.T) {
	media, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen media: %v", err)
	}
	defer media.Close()
	authorizationSeen := make(chan string, 4)
	go func() {
		conn, acceptErr := media.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		for {
			_, _, cseq, authorization, readErr := readTestRTSPRequestWithAuth(reader)
			if readErr != nil {
				return
			}
			authorizationSeen <- authorization
			_, _ = io.WriteString(conn, "RTSP/1.0 401 Unauthorized\r\nCSeq: "+cseq+"\r\nWWW-Authenticate: Digest realm=\"camera\", nonce=\"nonce-value\", algorithm=MD5\r\n\r\n")
		}
	}()

	redirector, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("listen redirector: %v", err)
	}
	defer redirector.Close()
	go serveRedirectingTestRTSP(redirector, "rtsp://"+media.Addr().String()+"/stream", 302)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	request := NetworkTestRequest{Protocol: "rtsp", Target: "rtsp://user:secret@localhost:" + portOf(t, redirector.Addr().String()) + "/stream", TimeoutMillis: 5000, MaxRedirects: 3, DNSMode: "system", RunID: "test"}
	err = run.runRTSP(request)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("跳转后缺少凭据时应报告认证失败，得到 %v", err)
	}
	if origin := run.stages["rtsp-options"]; origin.Meta["credentialsDropped"] == "" {
		t.Fatalf("跳转阶段应说明凭据未继续发送：%v", origin.Meta)
	}
	select {
	case authorization := <-authorizationSeen:
		if authorization != "" {
			t.Fatalf("跨主机跳转不应发送 Authorization：%q", authorization)
		}
	default:
		t.Fatal("重定向目标未收到请求")
	}
}

// Location 指向非 RTSP 协议时给出明确错误，而不是静默跟随。
func TestRTSPRedirectRejectsNonRTSPLocation(t *testing.T) {
	redirector, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer redirector.Close()
	go serveRedirectingTestRTSP(redirector, "http://127.0.0.1:1/stream", 302)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	err = run.runRTSP(NetworkTestRequest{Protocol: "rtsp", Target: "rtsp://" + redirector.Addr().String() + "/stream", TimeoutMillis: 5000, MaxRedirects: 3, DNSMode: "system", RunID: "test"})
	if err == nil {
		t.Fatal("期望明确的协议错误")
	}
	chain := localizedMessageChain(t, err.Error())
	if !chainContainsKey(chain, "networkTestTool.backend.rtspRedirectInvalid") || !chainContainsKey(chain, "networkTestTool.backend.rtspScheme") {
		t.Fatalf("期望外层与内层结论齐全，得到 %v", err)
	}
	if stage := run.stages["rtsp-options"]; stage.Status != "error" || !strings.Contains(stage.Error, "networkTestTool.backend.rtspRedirectInvalid") {
		t.Fatalf("rtsp-options = %+v", stage)
	}
}

func portOf(t *testing.T, address string) string {
	t.Helper()
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("split %q: %v", address, err)
	}
	return port
}

// serveRedirectingTestRTSP 接受一次连接并只回一个 3xx。
func serveRedirectingTestRTSP(listener net.Listener, location string, statusCode int) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	serveRedirectingTestRTSPConn(conn, location, statusCode)
}

func serveRedirectingTestRTSPConn(conn net.Conn, location string, statusCode int) {
	reader := bufio.NewReader(conn)
	if _, _, cseq, _, err := readTestRTSPRequestWithAuth(reader); err != nil {
		return
	} else {
		_, _ = io.WriteString(conn, fmt.Sprintf("RTSP/1.0 %d Moved Temporarily\r\nCSeq: %s\r\nLocation: %s\r\n\r\n", statusCode, cseq, location))
	}
}

// serveMediaTestRTSP 提供一个正常的 OPTIONS + DESCRIBE 服务端，并记住收到的 DESCRIBE 路径。
func serveMediaTestRTSP(listener net.Listener) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	if method, _, cseq, _, err := readTestRTSPRequestWithAuth(reader); err != nil || method != "OPTIONS" {
		return
	} else {
		_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nServer: RedirectedRTSP/1.0\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n")
	}
	method, uri, cseq, _, err := readTestRTSPRequestWithAuth(reader)
	if err != nil || method != "DESCRIBE" || !strings.Contains(uri, "token=123") {
		return
	}
	body := "v=0\r\ns=Redirected\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n"
	_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nContent-Type: application/sdp\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
}

// 复现真实 NVR 的行为：OPTIONS 在 9090 返回 200，DESCRIBE 才返回 302，并指向带 token 的
// 播放地址；客户端应跟随并在新地址上重新发送 DESCRIBE。
func TestRTSPFollowsDescribeRedirect(t *testing.T) {
	playback, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen playback: %v", err)
	}
	defer playback.Close()
	control, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen control: %v", err)
	}
	defer control.Close()
	location := "rtsp://" + playback.Addr().String() + "/playback/pu/2615?token=1237386936"
	go serveDescribeRedirectingTestRTSP(control, location)
	go serveDescribeOnlyTestRTSP(playback)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := &networkTestRun{service: NewNetworkTestService(), runID: "test", ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	request := NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://" + control.Addr().String() + "/playback?cameraid=1000000%245&type=2?token=1061460527",
		TimeoutMillis: 5000,
		MaxRedirects:  10,
		DNSMode:       "system",
		RunID:         "test",
	}
	if err := run.runRTSP(request); err != nil {
		t.Fatalf("runRTSP returned error: %v", err)
	}
	if options := run.stages["rtsp-options"]; options.Status != "success" || options.StatusCode != http.StatusOK {
		t.Fatalf("rtsp-options = %+v", options)
	}
	origin := run.stages["rtsp-describe"]
	if origin.Status != "success" || origin.StatusCode != http.StatusFound || origin.Meta["redirectTarget"] != location {
		t.Fatalf("rtsp-describe = %+v", origin)
	}
	hop := run.stages["rtsp-describe-redirect-1"]
	if hop.Status != "success" || hop.StatusCode != http.StatusOK {
		t.Fatalf("rtsp-describe-redirect-1 = %+v", hop)
	}
	if hop.Meta["redirectCount"] != "1" || hop.Meta["mediaSections"] != "1" {
		t.Fatalf("跳转后的阶段元信息 = %v", hop.Meta)
	}
	if !strings.Contains(hop.Request, "DESCRIBE rtsp://"+playback.Addr().String()) || !strings.Contains(hop.Request, "token=1237386936") {
		t.Fatalf("跳转后的 DESCRIBE 未发往新地址：%q", hop.Request)
	}
	// 重连后的请求必须使用新的 CSeq，且阶段展示与响应一致。
	if hop.Meta["cseq"] != "3" || !strings.Contains(hop.Response, "Cseq: 3") {
		t.Fatalf("跳转后的 CSeq 不一致：meta=%q response=%q", hop.Meta["cseq"], hop.Response)
	}

	// 时间线一致性：重连产生的链路阶段必须独立成项，且各自的时间窗与耗时自洽。
	for _, id := range []string{"dns-target-redirect-1", "tcp-connect-redirect-1"} {
		stage, ok := run.stages[id]
		if !ok {
			t.Fatalf("跟随重定向后的链路阶段 %q 缺失：%+v", id, run.stages)
		}
		if stage.StartedAt < run.stages["rtsp-describe"].FinishedAt {
			t.Fatalf("%q 的开始时间 %d 早于 302 响应时间 %d", id, stage.StartedAt, run.stages["rtsp-describe"].FinishedAt)
		}
	}
	// 第一跳的拨号时间窗不能延伸到跳转之后（此前两跳共用同一 ID 会被拉长）。
	if first, later := run.stages["tcp-connect"], run.stages["rtsp-describe-redirect-1"]; first.FinishedAt >= later.StartedAt {
		t.Fatalf("第一跳的 tcp-connect 时间窗未被限制在自己那一跳：%+v", first)
	}
	assertStageTimeline(t, stagesOf(run))
}

// serveDescribeRedirectingTestRTSP 在 9090 这类控制端口上：OPTIONS 正常，DESCRIBE 返回 302。
func serveDescribeRedirectingTestRTSP(listener net.Listener, location string) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	method, _, cseq, _, err := readTestRTSPRequestWithAuth(reader)
	if err != nil {
		return
	}
	if method != "OPTIONS" {
		return
	}
	_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nServer: ControlRTSP/1.0\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n")
	method, _, cseq, _, err = readTestRTSPRequestWithAuth(reader)
	if err != nil || method != "DESCRIBE" {
		return
	}
	_, _ = io.WriteString(conn, "RTSP/1.0 302 Moved Temporarily\r\nCSeq: "+cseq+"\r\nLocation: "+location+"\r\n\r\n")
}

// serveDescribeOnlyTestRTSP 在播放端口上只服务跳转后的 DESCRIBE。
func serveDescribeOnlyTestRTSP(listener net.Listener) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	method, _, cseq, _, err := readTestRTSPRequestWithAuth(reader)
	if err != nil || method != "DESCRIBE" {
		return
	}
	body := "v=0\r\ns=Playback\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n"
	_, _ = io.WriteString(conn, "RTSP/1.0 200 OK\r\nCSeq: "+cseq+"\r\nContent-Type: application/sdp\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
}

// HTTP 的等待响应阶段必须从请求写完就开始计时：否则等待期没有阶段覆盖（失败时只在末尾补出
// 一个 0 毫秒的错误项），链路时间线会出现无法解释的空白。
func TestHTTPResponseStageCoversWaitBeforeTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		if _, readErr := http.ReadRequest(reader); readErr != nil {
			return
		}
		// 读走请求后既不回包也不关闭：复现「请求已发出、正在等待响应」。
		time.Sleep(4 * time.Second)
	}()

	service := NewNetworkTestService()
	var mu sync.Mutex
	var updates []NetworkTestStage
	service.setEventEmitter(func(name string, payload any) {
		update, ok := payload.(NetworkTestUpdate)
		if !ok {
			return
		}
		mu.Lock()
		updates = append(updates, update.Stage)
		mu.Unlock()
	})
	result := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "http",
		Target:        "http://" + listener.Addr().String() + "/",
		TimeoutMillis: 1500,
		MaxRedirects:  0,
		DNSMode:       "system",
	})
	if result.Status != "timeout" {
		t.Fatalf("result = %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()

	var waiting *NetworkTestStage
	var request *NetworkTestStage
	for index := range updates {
		stage := &updates[index]
		switch {
		case stage.ID == "http-response" && stage.Status == "running" && waiting == nil:
			waiting = stage
		case stage.ID == "http-request" && stage.Status == "success" && request == nil:
			request = stage
		}
	}
	if request == nil {
		t.Fatalf("http-request 未上报成功：%+v", updates)
	}
	if waiting == nil {
		t.Fatalf("等待响应期间没有 http-response running 阶段：%+v", updates)
	}
	if !strings.Contains(waiting.Meta["phase"], "networkTestTool.backend.phaseWaitingForResponse") {
		t.Fatalf("waiting 阶段元信息 = %v", waiting.Meta)
	}
	if waiting.StartedAt < request.FinishedAt {
		t.Fatalf("等待阶段起点 %d 早于请求写完 %d", waiting.StartedAt, request.FinishedAt)
	}

	var failure *NetworkTestStage
	for _, stage := range result.Stages {
		if stage.ID == "http-response" {
			failure = &stage
		}
	}
	if failure == nil || failure.Status != "timeout" {
		t.Fatalf("http-response 阶段 = %+v", failure)
	}
	if failure.StartedAt != waiting.StartedAt {
		t.Fatalf("失败阶段起点 %d 与等待阶段 %d 不一致", failure.StartedAt, waiting.StartedAt)
	}
	if failure.DurationMillis < 1000 {
		t.Fatalf("失败阶段时长 %dms 未覆盖等待时间", failure.DurationMillis)
	}
	assertStageTimeline(t, result.Stages)
}

// HTTPS 经 HTTP 代理时，CONNECT 的等待期必须有阶段覆盖：失败/超时都要落在同一个时间窗里。
func TestHTTPSThroughConnectProxyCoversTunnelWait(t *testing.T) {
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen proxy: %v", err)
	}
	defer proxy.Close()
	go func() {
		conn, acceptErr := proxy.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		// 读走 CONNECT 请求后延迟返回失败：等待期必须由 proxy-tunnel 阶段覆盖。
		request, readErr := http.ReadRequest(reader)
		if readErr != nil || request.Method != http.MethodConnect {
			return
		}
		time.Sleep(900 * time.Millisecond)
		_, _ = io.WriteString(conn, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
	}()

	service := NewNetworkTestService()
	var mu sync.Mutex
	var updates []NetworkTestStage
	service.setEventEmitter(func(_ string, payload any) {
		update, ok := payload.(NetworkTestUpdate)
		if !ok {
			return
		}
		mu.Lock()
		updates = append(updates, update.Stage)
		mu.Unlock()
	})
	result := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "http",
		Target:        "https://example.com/",
		TimeoutMillis: 8000,
		MaxRedirects:  0,
		ProxyType:     "http",
		ProxyAddress:  proxy.Addr().String(),
		DNSMode:       "system",
	})
	if result.Status != "error" || !strings.Contains(result.Error, "Bad Gateway") {
		t.Fatalf("result = %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()

	var waiting *NetworkTestStage
	for index := range updates {
		stage := &updates[index]
		if stage.ID == "proxy-tunnel" && stage.Status == "running" && waiting == nil {
			waiting = stage
		}
	}
	if waiting == nil {
		t.Fatalf("CONNECT 等待期间没有 proxy-tunnel running 阶段：%+v", updates)
	}
	if waiting.Meta["proxy"] == "" || !strings.Contains(waiting.Request, "CONNECT example.com:443") {
		t.Fatalf("waiting 阶段内容 = %+v", waiting)
	}

	var failure *NetworkTestStage
	for _, stage := range result.Stages {
		if stage.ID == "proxy-tunnel" {
			failure = &stage
		}
	}
	if failure == nil || failure.Status != "error" {
		t.Fatalf("proxy-tunnel 阶段 = %+v", failure)
	}
	if !strings.Contains(failure.Error, "Bad Gateway") {
		t.Fatalf("失败结论缺少代理返回的内容：%q", failure.Error)
	}
	if failure.StartedAt != waiting.StartedAt {
		t.Fatalf("失败阶段起点 %d 与等待阶段 %d 不一致", failure.StartedAt, waiting.StartedAt)
	}
	if failure.DurationMillis < 800 {
		t.Fatalf("失败阶段时长 %dms 未覆盖 CONNECT 等待", failure.DurationMillis)
	}
	// 连到代理服务器的那次拨号也要说明下一跳是代理。
	var connect NetworkTestStage
	for _, stage := range result.Stages {
		if stage.ID == "tcp-connect" {
			connect = stage
		}
	}
	if connect.Meta["outbound"] != "proxy" || connect.Meta["proxy"] != proxy.Addr().String() {
		t.Fatalf("tcp-connect 未说明经代理：%v", connect.Meta)
	}
}

// 明文 HTTP 经 HTTP 代理时没有 CONNECT：连接阶段必须自己说明下一跳是代理，且不得虚报隧道。
func TestPlainHTTPThroughProxyMarksNextHop(t *testing.T) {
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen proxy: %v", err)
	}
	defer proxy.Close()
	go func() {
		conn, acceptErr := proxy.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		request, readErr := http.ReadRequest(reader)
		if readErr != nil {
			return
		}
		// 代理应收到绝对形式的请求行。
		if !strings.HasPrefix(request.RequestURI, "http://") {
			return
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok")
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "http",
		Target:        "http://example.invalid/",
		TimeoutMillis: 5000,
		MaxRedirects:  0,
		ProxyType:     "http",
		ProxyAddress:  proxy.Addr().String(),
		DNSMode:       "system",
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v", result)
	}
	var connect NetworkTestStage
	for _, stage := range result.Stages {
		if stage.ID == "tcp-connect" {
			connect = stage
		}
		if stage.ID == "proxy-tunnel" {
			t.Fatalf("明文 HTTP 经代理不应上报隧道阶段：%+v", stage)
		}
	}
	if connect.Meta["outbound"] != "proxy" || connect.Meta["proxy"] != proxy.Addr().String() {
		t.Fatalf("tcp-connect 未说明经代理：%v", connect.Meta)
	}
	if connect.Meta["reachability"] != "unverified" {
		t.Fatalf("经代理的连接应标注可达性未验证：%v", connect.Meta)
	}
}

// stagesOf 取出某次运行已上报的全部阶段，用于复核时间窗不变量。
func stagesOf(run *networkTestRun) []NetworkTestStage {
	run.mu.Lock()
	defer run.mu.Unlock()
	stages := make([]NetworkTestStage, 0, len(run.stages))
	for _, stage := range run.stages {
		stages = append(stages, stage)
	}
	return stages
}

// assertStageTimeline 校验每个已完成阶段的时间窗与耗时一致。各协议共用同一套阶段上报机制，
// 一旦出现「假时间条」（耗时与时间窗不符）或时间窗非法，会在这里统一暴露。
// localizedMessageChain 解析本地化消息并展开嵌套的 detail，返回由外到内的 payload 列表。
// 结论可能被提示合成包裹（外层是直连提示、内层是具体结论），断言必须按结构而不是原始字符串。
func localizedMessageChain(t *testing.T, message string) []map[string]any {
	t.Helper()
	chain := []map[string]any{}
	current := message
	for depth := 0; depth < 4 && current != ""; depth++ {
		var payload map[string]any
		if err := json.Unmarshal([]byte(current), &payload); err != nil {
			break
		}
		chain = append(chain, payload)
		detail, _ := payload["detail"].(string)
		current = detail
	}
	return chain
}

func chainContainsKey(chain []map[string]any, key string) bool {
	for _, payload := range chain {
		if payload["key"] == key {
			return true
		}
	}
	return false
}

func assertStageTimeline(t *testing.T, stages []NetworkTestStage) {
	t.Helper()
	for _, stage := range stages {
		if stage.Status == "running" {
			continue
		}
		if stage.StartedAt == 0 || stage.FinishedAt < stage.StartedAt {
			t.Fatalf("阶段 %q 的时间窗非法：%+v", stage.ID, stage)
		}
		if delta := stage.DurationMillis - (stage.FinishedAt - stage.StartedAt); delta > 2 || delta < -2 {
			t.Fatalf("阶段 %q 的耗时 %dms 与时间窗 %dms 不一致，时间线会出现假区间", stage.ID, stage.DurationMillis, stage.FinishedAt-stage.StartedAt)
		}
	}
}

// UDP 的发送与等待回包都必须有自己的时间窗，且等待阶段覆盖整个收包过程。
func TestUDPStagesCoverSendAndWait(t *testing.T) {
	server, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	defer server.Close()
	go func() {
		buffer := make([]byte, 1024)
		n, remote, readErr := server.ReadFromUDP(buffer)
		if readErr != nil {
			return
		}
		_, _ = server.WriteToUDP(append([]byte("echo:"), buffer[:n]...), remote)
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "udp",
		Target:        server.LocalAddr().String(),
		Payload:       "ping",
		TimeoutMillis: 3000,
		DNSMode:       "system",
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v", result)
	}
	assertStageTimeline(t, result.Stages)
	var send, receive NetworkTestStage
	for _, stage := range result.Stages {
		switch stage.ID {
		case "udp-send":
			send = stage
		case "udp-response":
			receive = stage
		}
	}
	if send.Status != "success" || receive.Status != "success" {
		t.Fatalf("udp 阶段 = %+v / %+v", send, receive)
	}
	if !strings.Contains(receive.Response, "echo:ping") {
		t.Fatalf("回包内容 = %q", receive.Response)
	}
	if receive.StartedAt < send.FinishedAt {
		t.Fatalf("等待回包阶段起点 %d 早于发送完成 %d", receive.StartedAt, send.FinishedAt)
	}
}

// NTP 的请求与校验阶段同样要各自覆盖自己的时间窗。
func TestNTPStagesCoverRequestAndValidation(t *testing.T) {
	server, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	defer server.Close()
	go func() {
		buffer := make([]byte, 1024)
		n, remote, readErr := server.ReadFromUDP(buffer)
		if readErr != nil || n < 48 {
			return
		}
		response := make([]byte, 48)
		response[0] = 4<<3 | 4 // version 4、server mode
		response[1] = 1        // stratum 1
		copy(response[12:16], "LOCL")
		copy(response[24:32], buffer[40:48]) // originate = 客户端发送时间
		now := makeNTPTimestamp(time.Now())
		copy(response[32:40], now[:])
		copy(response[40:48], now[:])
		_, _ = server.WriteToUDP(response, remote)
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "ntp",
		Target:        server.LocalAddr().String(),
		TimeoutMillis: 3000,
		DNSMode:       "system",
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v（%s）", result, result.Error)
	}
	assertStageTimeline(t, result.Stages)
	var request, response NetworkTestStage
	for _, stage := range result.Stages {
		switch stage.ID {
		case "ntp-request":
			request = stage
		case "ntp-response":
			response = stage
		}
	}
	if request.Status != "success" || response.Status != "success" {
		t.Fatalf("ntp 阶段 = %+v / %+v", request, response)
	}
	if response.StartedAt < request.FinishedAt {
		t.Fatalf("校验阶段起点 %d 早于请求完成 %d", response.StartedAt, request.FinishedAt)
	}
}

// WebSocket 握手完成后各阶段时间窗自洽，且不得出现隧道/代理等不存在的中间跳。
func TestWebSocketHandshakeStagesStayCoherent(t *testing.T) {
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, acceptErr := websocket.Accept(writer, request, nil)
		if acceptErr != nil {
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	})
	server := &http.Server{Handler: handler}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() { _ = server.Serve(listener) }()
	defer func() { _ = server.Close() }()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "websocket",
		Target:        "ws://" + listener.Addr().String() + "/socket",
		TimeoutMillis: 5000,
		MaxRedirects:  0,
		DNSMode:       "system",
	})
	if result.Status != "success" {
		t.Fatalf("result = %+v", result)
	}
	assertStageTimeline(t, result.Stages)
	for _, stage := range result.Stages {
		if stage.ID == "websocket-handshake" && stage.Status != "success" {
			t.Fatalf("websocket-handshake = %+v", stage)
		}
		if stage.ID == "proxy-tunnel" || stage.ID == tunnelRouteStageID {
			t.Fatalf("直连时不应出现中间跳阶段：%+v", stage)
		}
	}
}

// 服务端收下握手请求却不回应：等待期必须由 websocket-handshake 阶段覆盖，失败沿用其时间窗。
func TestWebSocketHandshakeCoversWait(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				return
			}
			if strings.TrimRight(line, "\r\n") == "" {
				break
			}
		}
		time.Sleep(4 * time.Second)
	}()

	service := NewNetworkTestService()
	var mu sync.Mutex
	var updates []NetworkTestStage
	service.setEventEmitter(func(_ string, payload any) {
		update, ok := payload.(NetworkTestUpdate)
		if !ok {
			return
		}
		mu.Lock()
		updates = append(updates, update.Stage)
		mu.Unlock()
	})
	result := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "websocket",
		Target:        "ws://" + listener.Addr().String() + "/socket",
		TimeoutMillis: 1500,
		MaxRedirects:  0,
		DNSMode:       "system",
	})
	if result.Status != "timeout" {
		t.Fatalf("result = %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()
	var waiting *NetworkTestStage
	for index := range updates {
		stage := &updates[index]
		if stage.ID == "websocket-handshake" && stage.Status == "running" && waiting == nil {
			waiting = stage
		}
	}
	if waiting == nil {
		t.Fatalf("握手等待期间没有 websocket-handshake running 阶段：%+v", updates)
	}
	var failure *NetworkTestStage
	for _, stage := range result.Stages {
		if stage.ID == "websocket-handshake" {
			failure = &stage
		}
	}
	if failure == nil || failure.Status != "timeout" {
		t.Fatalf("websocket-handshake 阶段 = %+v", failure)
	}
	if failure.StartedAt != waiting.StartedAt || failure.DurationMillis < 1000 {
		t.Fatalf("失败阶段未沿用等待时间窗：%+v（等待起点 %d）", failure, waiting.StartedAt)
	}
	assertStageTimeline(t, result.Stages)
}

// 连接被丢下这类失败要能识别出来，才能给出「检查代理路径」的提示。
func TestIsConnectionLevelFailure(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "EOF", err: io.EOF, want: true},
		{name: "unexpected EOF", err: io.ErrUnexpectedEOF, want: true},
		{name: "连接重置", err: syscall.ECONNRESET, want: true},
		{name: "上下文超时", err: context.DeadlineExceeded, want: true},
		{name: "解析超时", err: &net.DNSError{Err: "timeout", IsTimeout: true}, want: true},
		{name: "业务错误", err: errors.New("RTSP OPTIONS returned 404 Not Found"), want: false},
		{name: "证书错误", err: errors.New("tls: failed to verify certificate"), want: false},
		{name: "无错误", err: nil, want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isConnectionLevelFailure(testCase.err); got != testCase.want {
				t.Fatalf("isConnectionLevelFailure(%v) = %v", testCase.err, got)
			}
		})
	}
}

// 直连失败且本机配置了系统代理时，要给出可提示的代理地址；其它情况不得干扰结论。
func TestDirectProxyHint(t *testing.T) {
	proxy, err := url.Parse("http://proxy.example.com:8080")
	if err != nil {
		t.Fatalf("parse proxy: %v", err)
	}
	configured := systemProxyConfig{httpProxy: proxy, source: "macOS network settings"}
	if got := directProxyHint("", io.EOF, configured, true); got != "http://proxy.example.com:8080" {
		t.Fatalf("提示地址 = %q", got)
	}
	if directProxyHint("http", io.EOF, configured, true) != "" {
		t.Fatal("已指定代理时不应再提示系统代理")
	}
	if directProxyHint("", errors.New("RTSP DESCRIBE returned 404 Not Found"), configured, true) != "" {
		t.Fatal("非连接类失败不应提示系统代理")
	}
	if directProxyHint("", io.EOF, systemProxyConfig{}, true) != "" {
		t.Fatal("系统未配置代理时不应提示")
	}
	if directProxyHint("", io.EOF, configured, false) != "" {
		t.Fatal("没有读到系统代理配置时不应提示")
	}
	if got := directProxyHint("", io.EOF, systemProxyConfig{socksProxy: proxy}, true); got != "http://proxy.example.com:8080" {
		t.Fatalf("只有 SOCKS 代理时也应提示：%q", got)
	}
}

// 直连失败时的结论必须是「原始错误 + 提示」的同一条本地化消息：阶段错误与页脚结论共用它，
// 不能再出现「阶段里没有提示、只有页脚有」的不一致。
func TestFailureHintComposesLocalizedMessage(t *testing.T) {
	run := &networkTestRun{
		service:         NewNetworkTestService(),
		runID:           "test",
		ctx:             context.Background(),
		request:         NetworkTestRequest{Protocol: "http", Target: "http://example.com/"},
		proxyHint:       "http://proxy.example.com:8080",
		proxyHintLoaded: true,
		stages:          make(map[string]NetworkTestStage),
		starts:          make(map[string]time.Time),
	}
	composed := run.composeFailureHint(io.EOF)
	if key := localizedErrorKey(composed); key != "networkTestTool.backend.failure.directWithSystemProxy" {
		t.Fatalf("合成结论的 key = %q", key)
	}
	var payload *localizedError
	if !errors.As(composed, &payload) {
		t.Fatalf("合成结论不是本地化错误：%v", composed)
	}
	if payload.Params["proxy"] != "http://proxy.example.com:8080" {
		t.Fatalf("参数 = %v", payload.Params)
	}
	if payload.Detail != io.EOF.Error() {
		t.Fatalf("detail = %q", payload.Detail)
	}
	// 阶段失败与页脚结论必须完全一致。
	run.fail("tcp-connect", io.EOF)
	stageError := run.stages["tcp-connect"].Error
	if stageError != composed.Error() {
		t.Fatalf("阶段错误 %q 与页脚结论 %q 不一致", stageError, composed.Error())
	}
	// 已指定代理时不合成提示。
	withProxy := &networkTestRun{
		service:         NewNetworkTestService(),
		runID:           "test",
		ctx:             context.Background(),
		request:         NetworkTestRequest{Protocol: "http", Target: "http://example.com/", ProxyType: "http"},
		proxyHint:       "http://proxy.example.com:8080",
		proxyHintLoaded: true,
		stages:          make(map[string]NetworkTestStage),
		starts:          make(map[string]time.Time),
	}
	if got := withProxy.composeFailureHint(io.EOF); got.Error() != io.EOF.Error() {
		t.Fatalf("已指定代理时不应合成提示：%v", got)
	}
}

// stageByID 取结果中的一个阶段，缺失时直接失败。
func stageByID(t *testing.T, stages []NetworkTestStage, id string) NetworkTestStage {
	t.Helper()
	for _, stage := range stages {
		if stage.ID == id {
			return stage
		}
	}
	t.Fatalf("阶段 %q 缺失：%+v", id, stages)
	return NetworkTestStage{}
}

// testTLSCertificate 生成一份自签名证书：只提供 TLS 的设备（摄像头、NVR）普遍使用自签名证书。
func testTLSCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成测试密钥：%v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("生成测试证书：%v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// acceptTLSOnlyConnection 模拟只提供 TLS 的服务端入口：首个字节不是 TLS 握手记录时关闭连接
// （真实设备就是这样丢下明文请求的，客户端因此只读到 EOF）；hangPlaintext 为 true 时改为保持
// 沉默，用于覆盖「明文等待超时」这条路径。
func acceptTLSOnlyConnection(conn net.Conn, certificate tls.Certificate, hangPlaintext bool) (net.Conn, error) {
	first := make([]byte, 1)
	if _, err := io.ReadFull(conn, first); err != nil {
		return nil, err
	}
	if first[0] != 22 { // 22 是 TLS 握手记录类型；其余数据只提供 TLS 的服务端无法解析。
		if hangPlaintext {
			_, _ = io.Copy(io.Discard, conn)
		}
		return nil, errors.New("明文请求无法完成 TLS 握手")
	}
	secured := tls.Server(&prefixedConn{Conn: conn, prefix: first}, &tls.Config{Certificates: []tls.Certificate{certificate}})
	if err := secured.Handshake(); err != nil {
		return nil, err
	}
	return secured, nil
}

// prefixedConn 把已经读出的字节放回连接，供 TLS 层继续读取。
type prefixedConn struct {
	net.Conn
	prefix []byte
}

func (c *prefixedConn) Read(buffer []byte) (int, error) {
	if len(c.prefix) == 0 {
		return c.Conn.Read(buffer)
	}
	n := copy(buffer, c.prefix)
	c.prefix = c.prefix[n:]
	return n, nil
}

// serveTLSOnlyTestRTSP 模拟只提供 TLS 的 RTSP 设备：明文请求会被丢弃，TLS 之上才处理 RTSP。
func serveTLSOnlyTestRTSP(listener net.Listener, certificate tls.Certificate, hangPlaintext bool) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			secured, err := acceptTLSOnlyConnection(conn, certificate, hangPlaintext)
			if err != nil {
				return
			}
			serveTestRTSPConn(secured)
		}()
	}
}

// serveTLSOnlyTestHTTP 模拟只提供 TLS 的 HTTP 服务端：TLS 之上返回一个固定响应。
func serveTLSOnlyTestHTTP(listener net.Listener, certificate tls.Certificate) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			secured, err := acceptTLSOnlyConnection(conn, certificate, false)
			if err != nil {
				return
			}
			request, err := http.ReadRequest(bufio.NewReader(secured))
			if err != nil {
				return
			}
			_, _ = io.WriteString(secured, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
			_ = request.Body.Close()
		}()
	}
}

func newTLSOnlyListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

// 只提供 TLS 的 RTSP 设备：明文请求收不到任何响应，结论必须说明端口只接受加密连接，并给出可直接
// 使用的加密目标，而不是把原因留给对端。真实案例：摄像头把 rtsps 绑在 554，明文 OPTIONS 被丢弃。
func TestRTSPExplainsTLSOnlyEndpoint(t *testing.T) {
	listener := newTLSOnlyListener(t)
	go serveTLSOnlyTestRTSP(listener, testTLSCertificate(t), false)
	address := listener.Addr().String()
	service := NewNetworkTestService()

	result := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://admin:secret@" + address + "/stream",
		TimeoutMillis: 5000,
		DNSMode:       "system",
	})
	if result.Status != "error" {
		t.Fatalf("result = %+v", result)
	}
	chain := localizedMessageChain(t, result.Error)
	if !chainContainsKey(chain, "networkTestTool.backend.secureEndpointRequired") {
		t.Fatalf("结论应说明端口只接受加密连接：%q", result.Error)
	}
	params, _ := chain[0]["params"].(map[string]any)
	if params["target"] != "rtsps://admin:password@"+address+"/stream" {
		t.Fatalf("建议的目标 = %v", params)
	}
	if params["secure"] != "rtsps" || params["plain"] != "rtsp" {
		t.Fatalf("结论参数 = %v", params)
	}
	// 结论引用的证据必须能在时间线上核对：探测阶段带重放的加密请求与 TLS 之上的状态行。
	probe := stageByID(t, result.Stages, tlsProbeStageID)
	if probe.Status != "success" || !strings.Contains(probe.Meta["statusLine"], "RTSP/1.0 200 OK") {
		t.Fatalf("探测阶段 = %+v", probe)
	}
	if !strings.HasPrefix(probe.Request, "OPTIONS rtsps://") || !strings.Contains(probe.Meta["version"], "TLS") {
		t.Fatalf("探测阶段缺少证据：%+v", probe)
	}
	failure := stageByID(t, result.Stages, "rtsp-options")
	if failure.Status != "error" || !strings.Contains(failure.Error, "secureEndpointRequired") {
		t.Fatalf("失败阶段 = %+v", failure)
	}
	assertStageTimeline(t, result.Stages)

	// 建议必须真的可用：换成加密前缀后同一台设备应当探测成功。自签名证书会先撞上证书校验，结论
	// 要指出可以用「跳过证书校验」解决，而不是把 x509 的原始文本直接抛给用户。
	untrusted := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsps://admin:secret@" + address + "/stream",
		TimeoutMillis: 5000,
		DNSMode:       "system",
	})
	if untrusted.Status != "error" || !strings.Contains(untrusted.Error, "networkTestTool.backend.tlsCertificateUntrusted") {
		t.Fatalf("证书校验失败应给出可操作结论：%+v", untrusted)
	}
	secured := service.RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsps://admin:secret@" + address + "/stream",
		TimeoutMillis: 5000,
		SkipTLSVerify: true,
		DNSMode:       "system",
	})
	if secured.Status != "success" {
		t.Fatalf("跳过证书校验后加密目标应当成功：%+v", secured)
	}
}

// 对端在明文请求上保持沉默、一直等到运行期限用完时，不再追加加密探测：探测不能走到运行期限
// 之外，也不能把「超时」这个已经成立的结论改写成别的结论，更不该把运行状态改成「失败」。
func TestRTSPDoesNotProbeAfterRunDeadline(t *testing.T) {
	listener := newTLSOnlyListener(t)
	go serveTLSOnlyTestRTSP(listener, testTLSCertificate(t), true)
	address := listener.Addr().String()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://" + address + "/stream",
		TimeoutMillis: 1000,
		DNSMode:       "system",
	})
	if result.Status != "timeout" {
		t.Fatalf("result = %+v", result)
	}
	if !chainContainsKey(localizedMessageChain(t, result.Error), "networkTestTool.backend.rtspNoResponse") {
		t.Fatalf("超时结论应保持不变：%q", result.Error)
	}
	for _, stage := range result.Stages {
		if stage.ID == tlsProbeStageID {
			t.Fatalf("运行期限已用完时不应产生探测阶段：%+v", stage)
		}
	}
	assertStageTimeline(t, result.Stages)
}

// HTTP 与 WebSocket 的明文请求同样会撞上只提供 TLS 的端口，结论也必须落到加密前缀上。
func TestHTTPAndWebSocketExplainTLSOnlyEndpoint(t *testing.T) {
	for _, testCase := range []struct {
		protocol string
		target   string
		secured  string
	}{
		{protocol: "http", target: "http://%s/", secured: "https://%s/"},
		{protocol: "websocket", target: "ws://%s/socket", secured: "wss://%s/socket"},
	} {
		t.Run(testCase.protocol, func(t *testing.T) {
			listener := newTLSOnlyListener(t)
			go serveTLSOnlyTestHTTP(listener, testTLSCertificate(t))
			address := listener.Addr().String()

			result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
				Protocol:      testCase.protocol,
				Target:        fmt.Sprintf(testCase.target, address),
				TimeoutMillis: 5000,
				DNSMode:       "system",
			})
			if result.Status != "error" {
				t.Fatalf("result = %+v", result)
			}
			chain := localizedMessageChain(t, result.Error)
			if !chainContainsKey(chain, "networkTestTool.backend.secureEndpointRequired") {
				t.Fatalf("结论应说明端口只接受加密连接：%q", result.Error)
			}
			params, _ := chain[0]["params"].(map[string]any)
			if params["target"] != fmt.Sprintf(testCase.secured, address) {
				t.Fatalf("建议的目标 = %v", params)
			}
			probe := stageByID(t, result.Stages, tlsProbeStageID)
			if probe.Status != "success" || !strings.Contains(probe.Meta["statusLine"], "HTTP/1.1 200 OK") {
				t.Fatalf("探测阶段 = %+v", probe)
			}
			assertStageTimeline(t, result.Stages)
		})
	}
}

// 不接受 TLS 的对端关闭连接时不能凭空断言「只接受加密连接」：结论保持原样，探测阶段只记录
// 「拿不到证据」，不能停在进行中。
func TestSilentPeerWithoutTLSKeepsOriginalConclusion(t *testing.T) {
	listener := newTLSOnlyListener(t)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	result := NewNetworkTestService().RunNetworkTest(NetworkTestRequest{
		Protocol:      "rtsp",
		Target:        "rtsp://" + listener.Addr().String() + "/movie",
		TimeoutMillis: 3000,
		DNSMode:       "system",
	})
	if result.Status != "error" || !strings.Contains(result.Error, "networkTestTool.backend.rtspClosedWithoutResponse") {
		t.Fatalf("结论 = %+v", result)
	}
	probe := stageByID(t, result.Stages, tlsProbeStageID)
	if probe.Status != "success" || !strings.Contains(probe.Response, "networkTestTool.backend.secureEndpointAbsent") {
		t.Fatalf("探测阶段应记录「未取得证据」：%+v", probe)
	}
	if probe.Meta["handshakeError"] == "" {
		t.Fatalf("探测阶段应保留原始失败文本：%+v", probe.Meta)
	}
	for _, stage := range result.Stages {
		if stage.Status == "running" {
			t.Fatalf("阶段不能停在进行中：%+v", stage)
		}
	}
	assertStageTimeline(t, result.Stages)
}
