package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// tlsProbeStageID 是「加密端点探测」阶段：明文请求一个字节的响应都没收到时，用它判定该端口是否
// 只接受加密连接。结论引用的证据（TLS 握手与状态行）必须能在时间线上核对，所以它是独立阶段。
const tlsProbeStageID = "tls-probe"

// secureEndpointProbeTimeout 是探测的期限上限：探测只补充结论，不能长时间拖住失败结论，也不能
// 走到运行期限之外（探测上下文由运行上下文派生，剩余时间更少时以运行期限为准）。
const secureEndpointProbeTimeout = 2 * time.Second

// minimalSecureEndpointProbeBudget 是探测需要的最小剩余时间：不足时直接跳过，失败结论保持原样。
const minimalSecureEndpointProbeBudget = 300 * time.Millisecond

// secureSchemeFor 返回明文 scheme 对应的加密 scheme；没有加密版本的协议返回空串。
func secureSchemeFor(scheme string) string {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "http":
		return "https"
	case "ws":
		return "wss"
	case "rtsp":
		return "rtsps"
	default:
		return ""
	}
}

// secureEndpointProbe 是一次加密端点探测的证据：TLS 握手参数与在 TLS 之上读到的该协议响应。
type secureEndpointProbe struct {
	secureScheme string
	serverName   string
	version      string
	cipher       string
	request      string
	statusLine   string
}

// secureEndpointReplay 在已完成的 TLS 连接上重放用户的请求，并读回该协议自己的状态行。
// 返回重放的请求文本与状态行。
type secureEndpointReplay func(secured net.Conn, secureURL *url.URL) (string, string, error)

// secureEndpointReplayFor 按目标 scheme 选择重放方式，并给出对应的加密 scheme。
func secureEndpointReplayFor(target *url.URL) (secureEndpointReplay, string) {
	if target == nil {
		return nil, ""
	}
	secure := secureSchemeFor(target.Scheme)
	if secure == "" {
		return nil, ""
	}
	switch strings.ToLower(target.Scheme) {
	case "rtsp":
		return replayRTSPOverTLS, secure
	case "http", "ws":
		return replayHTTPOverTLS, secure
	default:
		return nil, ""
	}
}

// probeSecureEndpoint 判断「明文请求没有拿到任何响应」是不是因为该端口只接受加密连接：走同一条
// 链路重新连接，完成 TLS 握手后重放同一份请求，只有读到该协议自己的状态行才算证据。
//
// 探测固定跳过证书校验：自签名证书正是摄像头、NVR 这类设备最常见的情况，而这一步要判断的只是
// 「端口是否提供 TLS」，不是信任关系。探测不发送凭据，重放的请求与用户刚以明文发往同一地址的请求
// 完全相同；真正访问目标时仍按用户的证书校验设置执行。
func (r *networkRoute) probeSecureEndpoint(ctx context.Context, target *url.URL, port string) (secureEndpointProbe, bool) {
	replay, secure := secureEndpointReplayFor(target)
	if replay == nil {
		return secureEndpointProbe{}, false
	}
	secureURL := *target
	secureURL.Scheme = secure
	secureURL.User = nil

	// 先上报 running：探测可能一直用到期限上限，时间线必须覆盖这段真实时间，而不是在末尾贴一个
	// 0 毫秒的项。探测成功与否都要在这里收尾，阶段不会停在 running。
	r.stage(tlsProbeStageID, "running", NetworkTestStage{Meta: map[string]string{"serverName": target.Hostname(), "secureScheme": secure}})
	probeCtx, cancel := context.WithTimeout(ctx, secureEndpointProbeTimeout)
	defer cancel()
	var probe secureEndpointProbe
	found := false
	// 探测连接不是用户请求的链路：quietly 期间不写链路阶段，避免覆盖真实链路的 tcp-connect、
	// tunnel-route 与 proxy-tunnel 记录。
	failure := r.quietly(func() error {
		conn, err := r.openStream(probeCtx, target.Hostname(), port)
		if err != nil {
			return err
		}
		defer conn.Close()
		if deadline, ok := probeCtx.Deadline(); ok {
			_ = conn.SetDeadline(deadline)
		}
		stop := context.AfterFunc(probeCtx, func() { _ = conn.Close() })
		defer stop()
		secured := tls.Client(conn, clientTLSConfig(target.Hostname(), true))
		if err := secured.HandshakeContext(probeCtx); err != nil {
			return err
		}
		state := secured.ConnectionState()
		request, statusLine, err := replay(secured, &secureURL)
		if err != nil {
			return err
		}
		probe = secureEndpointProbe{
			secureScheme: secure,
			serverName:   target.Hostname(),
			version:      tls.VersionName(state.Version),
			cipher:       tls.CipherSuiteName(state.CipherSuite),
			request:      request,
			statusLine:   statusLine,
		}
		found = true
		return nil
	})
	if !found {
		// 拿不到证据时也要收尾：这一项说明「探测做了什么、为什么没有结论」，避免阶段停在 running，
		// 也避免读者以为工具默认它需要 TLS。原始失败文本留在元信息里，不套多语言 key。
		meta := map[string]string{"serverName": target.Hostname(), "secureScheme": secure}
		if failure != nil {
			meta["handshakeError"] = failure.Error()
		}
		r.stage(tlsProbeStageID, "success", NetworkTestStage{
			Response: networkTestText("networkTestTool.backend.secureEndpointAbsent", nil),
			Meta:     meta,
		})
		return secureEndpointProbe{}, false
	}
	r.reportSecureEndpointProbe(probe)
	return probe, true
}

// replayRTSPOverTLS 在 TLS 连接上重放一个未认证的 OPTIONS。凭据只在服务端要求认证时才发送，
// 而这里只需要状态行就可以确认对端说的是 RTSP。
func replayRTSPOverTLS(secured net.Conn, secureURL *url.URL) (string, string, error) {
	request := formatRTSPRequest("OPTIONS", rtspRequestURI(secureURL), nil, 1)
	if _, err := io.WriteString(secured, request); err != nil {
		return "", "", err
	}
	response, err := readRTSPResponse(bufio.NewReader(secured))
	if err != nil {
		return "", "", err
	}
	return request, strings.TrimSpace(response.protocol + " " + response.statusLine), nil
}

// replayHTTPOverTLS 在 TLS 连接上重放一次 GET：HTTP 与 WebSocket 都以 HTTP 状态行作为证据，
// WebSocket 只需要确认该端点提供 HTTP（不发送 Upgrade，也就不建立会话）。
func replayHTTPOverTLS(secured net.Conn, secureURL *url.URL) (string, string, error) {
	target := *secureURL
	if target.Path == "" {
		target.Path = "/"
	}
	request, err := http.NewRequest(http.MethodGet, target.String(), nil)
	if err != nil {
		return "", "", err
	}
	request.Header.Set("User-Agent", "TinkerKit Network Test")
	request.Header.Set("Connection", "close")
	var dump strings.Builder
	if err := request.Write(&dump); err != nil {
		return "", "", err
	}
	if _, err := io.WriteString(secured, dump.String()); err != nil {
		return "", "", err
	}
	response, err := http.ReadResponse(bufio.NewReader(secured), request)
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	return dump.String(), strings.TrimSpace(response.Proto + " " + response.Status), nil
}

// reportSecureEndpointProbe 把探测作为独立阶段列出。
func (r *networkRoute) reportSecureEndpointProbe(probe secureEndpointProbe) {
	r.stage(tlsProbeStageID, "success", NetworkTestStage{
		Request: probe.request,
		Response: networkTestText("networkTestTool.backend.secureEndpointProbe", map[string]any{
			"statusLine": probe.statusLine,
			"scheme":     probe.secureScheme,
		}),
		Meta: map[string]string{
			"serverName":   probe.serverName,
			"version":      probe.version,
			"cipher":       probe.cipher,
			"secureScheme": probe.secureScheme,
			"statusLine":   probe.statusLine,
		},
	})
}

// secureEndpointError 给出「该端口只接受加密连接」的结论：明文请求一个字节的响应都没收到，而加密
// 请求拿到了该协议的状态行，原因因此是协议前缀，而不是对端是否响应。
func secureEndpointError(target networkTarget, probe secureEndpointProbe, cause error) error {
	plain := ""
	if target.URL != nil {
		plain = strings.ToLower(target.URL.Scheme)
	}
	return networkTestErrorParamsCause("networkTestTool.backend.secureEndpointRequired", map[string]any{
		"plain":      plain,
		"secure":     probe.secureScheme,
		"statusLine": probe.statusLine,
		"target":     secureTargetExample(target, probe.secureScheme),
	}, cause)
}

// secureTargetExample 给出可直接替换的目标地址。端口必须显式保留：设备把 rtsps 绑在 554 这类
// 自定义端口上，换成加密 scheme 的默认端口反而连不上。密码只占位，不把用户输入复制进文案。
func secureTargetExample(target networkTarget, secure string) string {
	path := "/"
	if target.URL != nil {
		path = target.URL.EscapedPath()
		if path == "" {
			path = "/"
		}
		if target.URL.RawQuery != "" {
			path += "?" + target.URL.RawQuery
		}
	}
	hostPort := net.JoinHostPort(target.Host, target.Port)
	if target.creds != nil && target.creds.username != "" {
		return secure + "://" + url.UserPassword(target.creds.username, "password").String() + "@" + hostPort + path
	}
	return secure + "://" + hostPort + path
}
