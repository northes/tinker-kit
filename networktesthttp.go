package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type networkRequestTraceState struct {
	mu      sync.RWMutex
	stageID string
	request string
	meta    map[string]string
}

func newNetworkRequestTraceState(stageID string) *networkRequestTraceState {
	return &networkRequestTraceState{stageID: stageID}
}

func (s *networkRequestTraceState) set(stageID string, request *http.Request, targetResolution string, redirectCount int) {
	requestDump, _ := httpRequestSummary(request)
	meta := map[string]string{
		"method":           request.Method,
		"url":              request.URL.String(),
		"targetResolution": targetResolution,
	}
	if request.ContentLength > 0 {
		meta["bodyBytes"] = strconv.FormatInt(request.ContentLength, 10)
	}
	if redirectCount > 0 {
		meta["redirectCount"] = strconv.Itoa(redirectCount)
	}
	s.mu.Lock()
	s.stageID = stageID
	s.request = requestDump
	s.meta = meta
	s.mu.Unlock()
}

func (s *networkRequestTraceState) setCurrent(request *http.Request, targetResolution string) {
	s.mu.RLock()
	stageID := s.stageID
	redirectCount, _ := strconv.Atoi(s.meta["redirectCount"])
	s.mu.RUnlock()
	s.set(stageID, request, targetResolution, redirectCount)
}

func (s *networkRequestTraceState) snapshot() (string, string, map[string]string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	meta := make(map[string]string, len(s.meta))
	for key, value := range s.meta {
		meta[key] = value
	}
	return s.stageID, s.request, meta
}

func (s *networkRequestTraceState) redirectCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count, _ := strconv.Atoi(s.meta["redirectCount"])
	return count
}

func normalizeNetworkHTTPMethod(method string) (string, error) {
	method = strings.TrimSpace(method)
	if method == "" {
		return http.MethodGet, nil
	}
	if len(method) > 128 || !validHTTPToken(method) {
		return "", networkTestError("networkTestTool.backend.httpMethodInvalid")
	}
	return method, nil
}

func parseNetworkHTTPHeaders(raw string) (http.Header, string, error) {
	if len(raw) > 64<<10 {
		return nil, "", networkTestError("networkTestTool.backend.httpHeadersTooLarge")
	}
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	if strings.Contains(raw, "\r") {
		return nil, "", networkTestError("networkTestTool.backend.httpHeaderInvalid")
	}
	headers := make(http.Header)
	host := ""
	hostSet := false
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if !ok || !validHTTPToken(name) || !validHTTPHeaderValue(value) {
			return nil, "", networkTestErrorf("networkTestTool.backend.httpHeaderInvalidAt", "line", index+1)
		}
		if strings.EqualFold(name, "Host") {
			if hostSet || strings.ContainsAny(value, "/\\?#@ ") {
				return nil, "", networkTestErrorf("networkTestTool.backend.httpHeaderInvalidAt", "line", index+1)
			}
			host, hostSet = value, true
			continue
		}
		switch strings.ToLower(name) {
		case "content-length", "transfer-encoding", "connection", "proxy-connection", "keep-alive", "upgrade", "trailer":
			return nil, "", networkTestErrorf("networkTestTool.backend.httpHeaderManagedByClient", "line", index+1)
		}
		headers.Add(name, value)
	}
	return headers, host, nil
}

func validHTTPToken(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range []byte(value) {
		if (character >= '0' && character <= '9') || (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') {
			continue
		}
		if strings.ContainsRune("!#$%&'*+-.^_`|~", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validHTTPHeaderValue(value string) bool {
	for _, character := range []byte(value) {
		if character == '\t' || (character >= 0x20 && character != 0x7f) {
			continue
		}
		return false
	}
	return true
}

func cloneNetworkHTTPHeaders(headers http.Header) http.Header {
	cloned := make(http.Header, len(headers))
	for key, values := range headers {
		cloned[key] = append([]string(nil), values...)
	}
	return cloned
}

func sameNetworkHTTPOrigin(left, right *url.URL) bool {
	if left == nil || right == nil || !strings.EqualFold(left.Scheme, right.Scheme) || !strings.EqualFold(left.Hostname(), right.Hostname()) {
		return false
	}
	leftPort, rightPort := left.Port(), right.Port()
	if leftPort == "" {
		leftPort = defaultPortForScheme(left.Scheme)
	}
	if rightPort == "" {
		rightPort = defaultPortForScheme(right.Scheme)
	}
	return leftPort == rightPort
}

func (r *networkTestRun) runHTTP(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("http", request.Target)
	if err != nil {
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	method, err := normalizeNetworkHTTPMethod(request.Method)
	if err != nil {
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	if len(request.Body) > 1<<20 {
		err := networkTestError("networkTestTool.backend.httpBodyTooLarge")
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	headers, hostHeader, err := parseNetworkHTTPHeaders(request.Headers)
	if err != nil {
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	if err := validateNetworkRedirectLimit(request.MaxRedirects); err != nil {
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	route, err := newNetworkRoute(r, request)
	if err != nil {
		if r.source.Kind != "ssh" {
			r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		}
		return err
	}
	defer route.close()
	if err := route.resolveSystemProxy(target); err != nil {
		return err
	}
	transport := &http.Transport{
		Proxy:                 route.proxyFunc,
		DialContext:           route.dialContext,
		TLSClientConfig:       networkTLSConfig(request.SkipTLSVerify),
		TLSHandshakeTimeout:   time.Until(deadlineOr(r.ctx, time.Now().Add(10*time.Second))),
		ResponseHeaderTimeout: time.Until(deadlineOr(r.ctx, time.Now().Add(10*time.Second))),
		DisableKeepAlives:     true,
	}
	defer transport.CloseIdleConnections()
	requestTrace := newNetworkRequestTraceState("http-request")
	route.requestTrace = requestTrace
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	currentURL := target.URL
	currentMethod := method
	currentBody := request.Body
	currentHasBody := request.HasBody || request.Body != ""
	currentHeaders := cloneNetworkHTTPHeaders(headers)
	currentHostHeader := hostHeader
	// User-Agent 在整条重定向链上保持不变：它标识的是本次测试使用的客户端身份。
	userAgent := r.userAgent()
	for redirectCount := 0; ; redirectCount++ {
		requestID := networkRedirectStageID("http-request", redirectCount)
		responseID := networkRedirectStageID("http-response", redirectCount)
		var requestBody io.Reader
		if currentHasBody {
			requestBody = strings.NewReader(currentBody)
		}
		req, err := http.NewRequest(currentMethod, currentURL.String(), requestBody)
		if err != nil {
			r.stage(requestID, "error", NetworkTestStage{Error: err.Error(), Meta: redirectMeta(redirectCount)})
			return err
		}
		req.Header = cloneNetworkHTTPHeaders(currentHeaders)
		req.Host = currentHostHeader
		if req.Header.Get("User-Agent") == "" {
			req.Header.Set("User-Agent", userAgent)
		}
		requestTrace.set(requestID, req, route.targetResolution(), redirectCount)

		requestURL := *currentURL
		requestHost := requestURL.Hostname()
		requestPort := requestURL.Port()
		if requestPort == "" {
			requestPort = defaultPortForScheme(requestURL.Scheme)
		}
		// 请求是否真的发出去了、响应是否有过一个字节：判断「对端没有任何反应」要用这两个事实，
		// 而不是从错误文本里推测。
		requestWritten := false
		responseByteSeen := false
		trace := &httptrace.ClientTrace{
			TLSHandshakeStart: func() {
				if route.proxyType == "http" && requestURL.Scheme == "https" {
					route.stage("proxy-tunnel", "success", NetworkTestStage{Request: "CONNECT " + net.JoinHostPort(requestHost, requestPort), Response: networkTestText("networkTestTool.backend.connectTunnelEstablished", nil), Meta: map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}})
				}
				r.stage(networkRedirectStageID("tls", redirectCount), "running", NetworkTestStage{Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"serverName": requestHost})})
			},
			TLSHandshakeDone: func(state tls.ConnectionState, err error) {
				stageID := networkRedirectStageID("tls", redirectCount)
				if err != nil {
					r.fail(stageID, tlsHandshakeFailure(err))
					return
				}
				r.stage(stageID, "success", NetworkTestStage{Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"serverName": requestHost, "version": tls.VersionName(state.Version), "cipher": tls.CipherSuiteName(state.CipherSuite), "alpn": state.NegotiatedProtocol})})
			},
			WroteHeaders: func() {
				stageID, requestDump, meta := requestTrace.snapshot()
				r.stage(stageID, "running", NetworkTestStage{Request: requestDump, Meta: meta})
			},
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				stageID, requestDump, meta := requestTrace.snapshot()
				if info.Err != nil {
					r.fail(stageID, info.Err)
					return
				}
				requestWritten = true
				r.stage(stageID, "success", NetworkTestStage{Request: requestDump, Meta: meta})
				// 请求写完即进入等待响应：response 阶段必须从这里开始计时，否则等待期
				// 没有任何阶段覆盖（失败时只在末尾补出一个 0 毫秒的错误项），时间线会
				// 出现无法解释的空白。首个字节到达、读取完成或失败都沿用这个起始时间。
				r.stage(responseID, "running", NetworkTestStage{Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"phase": networkTestText("networkTestTool.backend.phaseWaitingForResponse", nil)})})
			},
			GotFirstResponseByte: func() {
				responseByteSeen = true
				r.stage(responseID, "running", NetworkTestStage{Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"firstByteAt": strconv.FormatInt(time.Now().UnixMilli(), 10)})})
			},
		}
		req = req.WithContext(httptrace.WithClientTrace(r.ctx, trace))
		if route.proxyType == "http" && requestURL.Scheme == "https" {
			// transport 会先向代理发 CONNECT：先上报 running，CONNECT 的等待时间与失败
			// 才能落在这个阶段的时间窗里（否则只在失败时补出一个 0 毫秒的错误项）。
			route.stage("proxy-tunnel", "running", NetworkTestStage{
				Request: "CONNECT " + net.JoinHostPort(requestHost, requestPort) + " HTTP/1.1\r\nHost: " + net.JoinHostPort(requestHost, requestPort) + "\r\n\r\n",
				Meta:    mergeStageMeta(redirectMeta(redirectCount), map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}),
			})
		}
		response, err := client.Do(req)
		if err != nil {
			if route.proxyType == "http" && requestURL.Scheme == "https" && strings.Contains(strings.ToLower(err.Error()), "proxyconnect") {
				r.fail(networkRedirectStageID("proxy-tunnel", redirectCount), err)
				return err
			}
			current := r.currentStageForHop(requestID, redirectCount)
			if strings.Contains(strings.ToLower(err.Error()), "tls") {
				current = networkRedirectStageID("tls", redirectCount)
			}
			err = tlsHandshakeFailure(err)
			if requestWritten && !responseByteSeen {
				// 请求已发出、响应一个字节都没回来：先确认该端口是否只接受加密连接，
				// 再把结论交给通用失败处理。
				if verdict, found := r.explainSilentFailure(route, targetFromURL(currentURL), err); found {
					err = verdict
				}
			}
			r.fail(current, err)
			return err
		}

		r.stage(responseID, "running", NetworkTestStage{StatusCode: response.StatusCode, Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"status": response.Status})})
		body, readErr := readLimited(response.Body, 64*1024)
		responseDump, _ := httpResponseSummary(response, body)
		_ = response.Body.Close()
		if readErr != nil {
			r.fail(responseID, readErr)
			return readErr
		}
		r.stage(responseID, "success", NetworkTestStage{Response: responseDump, StatusCode: response.StatusCode, Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"status": response.Status, "contentType": response.Header.Get("Content-Type"), "contentLength": response.Header.Get("Content-Length")})})

		location := response.Header.Get("Location")
		if redirectCount >= request.MaxRedirects || location == "" || !isNetworkRedirectStatus(response.StatusCode) {
			return nil
		}
		nextURL, err := currentURL.Parse(location)
		if err == nil {
			var nextTarget networkTarget
			nextTarget, err = parseNetworkTarget("http", nextURL.String())
			if err == nil {
				nextURL = nextTarget.URL
			}
		}
		if err != nil {
			nextRequestID := networkRedirectStageID("http-request", redirectCount+1)
			r.stage(nextRequestID, "error", NetworkTestStage{Error: fmt.Sprintf("invalid redirect target %q: %v", location, err), Meta: redirectMeta(redirectCount + 1)})
			return err
		}
		if response.StatusCode == http.StatusMovedPermanently || response.StatusCode == http.StatusFound || response.StatusCode == http.StatusSeeOther {
			if currentMethod != http.MethodGet && currentMethod != http.MethodHead {
				currentMethod = http.MethodGet
				currentBody = ""
				currentHasBody = false
				for _, key := range []string{"Content-Type", "Content-Length", "Transfer-Encoding"} {
					currentHeaders.Del(key)
				}
			}
		}
		if !sameNetworkHTTPOrigin(currentURL, nextURL) {
			for _, key := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
				currentHeaders.Del(key)
			}
			currentHostHeader = ""
		}
		currentURL = nextURL
	}
}

func redirectMeta(redirectCount int) map[string]string {
	if redirectCount == 0 {
		return nil
	}
	return map[string]string{"redirectCount": strconv.Itoa(redirectCount)}
}

func isNetworkRedirectStatus(statusCode int) bool {
	switch statusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}

const maxNetworkRedirects = 10

func validateNetworkRedirectLimit(limit int) error {
	if limit < 0 || limit > maxNetworkRedirects {
		return networkTestErrorf("networkTestTool.backend.redirectLimit", "max", maxNetworkRedirects)
	}
	return nil
}

func networkRedirectStageID(stageID string, redirectCount int) string {
	if redirectCount == 0 {
		return stageID
	}
	return fmt.Sprintf("%s-redirect-%d", stageID, redirectCount)
}

func networkRedirectPolicy(limit int, onRedirect func(*http.Request, int)) func(*http.Request, []*http.Request) error {
	return func(request *http.Request, via []*http.Request) error {
		if len(via) > limit {
			return http.ErrUseLastResponse
		}
		if onRedirect != nil {
			onRedirect(request, len(via))
		}
		return nil
	}
}

func networkTLSConfig(skipVerification bool) *tls.Config {
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: skipVerification, // 用户明确启用时，跳过证书链与主机名校验。
	}
}

// tlsHandshakeFailure 把 TLS 握手失败翻译成结论。证书校验失败是可操作的：设备自签名证书可以在
// 高级选项里跳过校验；其余握手失败保留原始文本（协议层没有更多可说的）。
func tlsHandshakeFailure(err error) error {
	if !isCertificateVerificationFailure(err) || localizedErrorKey(err) == tlsCertificateUntrustedKey {
		return err
	}
	return networkTestErrorCause(tlsCertificateUntrustedKey, err)
}

// tlsCertificateUntrustedKey 是证书校验失败的结论 key；同一次握手可能在阶段上报与最终结论里各
// 经过一次翻译，tlsHandshakeFailure 据此保持幂等。
const tlsCertificateUntrustedKey = "networkTestTool.backend.tlsCertificateUntrusted"

// isCertificateVerificationFailure 判断握手失败是否由证书校验引起：自签名、主机名不匹配、链不完整
// 都会走到这里，它们的共同点是都可以由用户决定是否跳过校验。
func isCertificateVerificationFailure(err error) bool {
	var verificationError *tls.CertificateVerificationError
	if errors.As(err, &verificationError) {
		return true
	}
	var unknownAuthority x509.UnknownAuthorityError
	return errors.As(err, &unknownAuthority)
}

// clientTLSConfig 返回带 serverName 的 TLS 配置。http.Transport 会自己补 ServerName，而直接用
// tls.Client 的路径（rtsps、加密端点探测）必须显式给出：缺少它时启用证书校验会直接失败
// （tls: either ServerName or InsecureSkipVerify must be specified）。
func clientTLSConfig(serverName string, skipVerification bool) *tls.Config {
	config := networkTLSConfig(skipVerification)
	config.ServerName = serverName
	return config
}

type captureNetworkRoundTripper struct {
	base      http.RoundTripper
	onRequest func(*http.Request)
}

func (t *captureNetworkRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if t.onRequest != nil {
		t.onRequest(request)
	}
	return t.base.RoundTrip(request)
}

// tunnelRouteStageID 是「经隧道出口」阶段：本机把目标交给 VPN/代理 TUN 转发时列出。
const tunnelRouteStageID = "tunnel-route"

func httpRequestSummary(request *http.Request) (string, error) {
	clone := request.Clone(request.Context())
	clone.Body = nil
	var builder strings.Builder
	if clone.URL != nil {
		builder.WriteString(clone.Method + " " + clone.URL.RequestURI() + " HTTP/1.1\r\n")
		host := clone.Host
		if host == "" {
			host = clone.URL.Host
		}
		builder.WriteString("Host: " + host + "\r\n")
	}
	keys := make([]string, 0, len(clone.Header))
	for key := range clone.Header {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		values := clone.Header[key]
		for _, value := range values {
			if sensitiveNetworkHTTPHeader(key) {
				value = "[redacted]"
			}
			builder.WriteString(key + ": " + value + "\r\n")
		}
	}
	builder.WriteString("\r\n")
	return builder.String(), nil
}

func sensitiveNetworkHTTPHeader(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return name == "authorization" || name == "proxy-authorization" || name == "cookie" ||
		strings.Contains(name, "token") || strings.Contains(name, "secret") || strings.Contains(name, "api-key")
}

func httpResponseSummary(response *http.Response, body []byte) (string, error) {
	var builder strings.Builder
	builder.WriteString(response.Proto + " " + response.Status + "\r\n")
	keys := make([]string, 0, len(response.Header))
	for key := range response.Header {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		values := response.Header[key]
		for _, value := range values {
			builder.WriteString(key + ": " + value + "\r\n")
		}
	}
	builder.WriteString("\r\n")
	if len(body) > 0 {
		builder.Write(body)
		if body[len(body)-1] != '\n' {
			builder.WriteByte('\n')
		}
	}
	return builder.String(), nil
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	content, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return content, err
	}
	if int64(len(content)) > limit {
		content = append(content[:limit], []byte("\n[response body truncated after 64 KiB]")...)
	}
	return content, nil
}
