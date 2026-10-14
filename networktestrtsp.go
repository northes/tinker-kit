package main

import (
	"bufio"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxRTSPResponseBytes = 64 * 1024

// runRTSP 执行一次 RTSP 1.0 探测：先 OPTIONS 查看服务端支持的方法，再 DESCRIBE 取回媒体
// 描述（SDP）。两个请求都不建立会话，因此不会触发 PLAY，也不会依赖 Transport 参数。目标
// URL 带凭据时自动应答 Digest（或 Basic）挑战；服务端用 3xx 指向新的流地址时按重定向次数
// 跟随，并在新地址上重建连接。
func (r *networkTestRun) runRTSP(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("rtsp", request.Target)
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
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	if err := route.resolveSystemProxy(target); err != nil {
		return err
	}
	client, err := r.newRTSPClient(route, target)
	if err != nil {
		return err
	}
	defer client.close()

	options := client.request("rtsp-options", "OPTIONS", 1, nil)
	if options.err != nil {
		r.fail(options.stageID, options.err)
		return options.err
	}
	optionsMeta := mergeStageMeta(redirectMeta(options.hops), rtspResponseMeta(options.response, route.targetResolution()))
	optionsMeta["cseq"] = strconv.Itoa(options.nextSeq - 1)
	if server := firstNonEmpty(options.response.header.Get("Server"), options.response.header.Get("Public")); server != "" {
		optionsMeta["server"] = server
	}
	if err := rtspStatusError("OPTIONS", options.response); err != nil {
		r.stage(options.stageID, "error", NetworkTestStage{Response: rtspResponseSummary(options.response), StatusCode: options.response.statusCode, Meta: optionsMeta, Error: err.Error()})
		return err
	}
	r.stage(options.stageID, "success", NetworkTestStage{Response: rtspResponseSummary(options.response), StatusCode: options.response.statusCode, Meta: optionsMeta})

	describeHeaders := map[string]string{"Accept": "application/sdp"}
	describe := client.request("rtsp-describe", "DESCRIBE", options.nextSeq, describeHeaders)
	if describe.err != nil {
		r.fail(describe.stageID, describe.err)
		return describe.err
	}
	// 重定向后请求实际发往新地址：这里取最终生效的流地址与序号。
	describeURI := rtspRequestURI(client.target.URL)
	describeRequest := formatRTSPRequest("DESCRIBE", describeURI, r.userAgent(), describeHeaders, describe.nextSeq-1)
	describeMeta := mergeStageMeta(redirectMeta(describe.hops), rtspResponseMeta(describe.response, route.targetResolution()))
	describeMeta["requestURI"] = describeURI
	describeMeta["cseq"] = strconv.Itoa(describe.nextSeq - 1)
	describeMeta = mergeStageMeta(describeMeta, describeMediaMeta(describe.response.body))
	if err := rtspStatusError("DESCRIBE", describe.response); err != nil {
		r.stage(describe.stageID, "error", NetworkTestStage{Request: describeRequest, Response: rtspResponseSummary(describe.response), StatusCode: describe.response.statusCode, Meta: describeMeta, Error: err.Error()})
		return err
	}
	r.stage(describe.stageID, "success", NetworkTestStage{Request: describeRequest, Response: rtspResponseSummary(describe.response), StatusCode: describe.response.statusCode, Meta: describeMeta})
	return nil
}

// rtspClient 持有到当前流地址的连接。RTSP 的重定向可能换主机或端口，因此每次跟随都会
// 重建连接，并把同一个请求重新发往新地址；CSeq 在同一连接内递增且不复用。
type rtspClient struct {
	run     *networkTestRun
	route   *networkRoute
	target  networkTarget
	conn    net.Conn
	session *rtspSession
	stop    func() bool
}

func (r *networkTestRun) newRTSPClient(route *networkRoute, target networkTarget) (*rtspClient, error) {
	conn, stop, err := r.dialRTSP(route, target)
	if err != nil {
		return nil, err
	}
	return &rtspClient{run: r, route: route, target: target, conn: conn, session: &rtspSession{conn: conn}, stop: stop}, nil
}

// dialRTSP 建立到目标的连接：包含代理隧道与 rtsps 的 TLS 阶段，并挂上运行超时与取消清理。
func (r *networkTestRun) dialRTSP(route *networkRoute, target networkTarget) (net.Conn, func() bool, error) {
	conn, err := route.openRTSPStream(r.ctx, target)
	if err != nil {
		return nil, nil, err
	}
	if deadline, ok := r.ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	stop := context.AfterFunc(r.ctx, func() { _ = conn.Close() })
	return conn, stop, nil
}

func (c *rtspClient) close() {
	if c == nil || c.conn == nil {
		return
	}
	if c.stop != nil {
		c.stop()
	}
	_ = c.conn.Close()
	c.conn = nil
}

// reconnect 关闭旧连接并连到重定向后的地址；接口、代理隧道与 TLS 阶段按新目标重新上报。
func (c *rtspClient) reconnect(target networkTarget) error {
	conn, stop, err := c.run.dialRTSP(c.route, target)
	if err != nil {
		return err
	}
	c.close()
	c.conn, c.stop, c.session, c.target = conn, stop, &rtspSession{conn: conn}, target
	return nil
}

// rtspRequestOutcome 是一次 RTSP 请求的最终结果。hops 只统计本次请求自身跟随的重定向次数，
// 因此跟随次数不同的请求各自使用自己的阶段后缀。
type rtspRequestOutcome struct {
	response *rtspResponse
	nextSeq  int
	stageID  string
	hops     int
	err      error
}

// request 发送一个请求：先按当前地址发送（401 时用凭据重试），收到带 Location 的 3xx 且
// 未超过上限时记录本跳、重建连接并把同一请求发往新地址。
func (c *rtspClient) request(baseStageID, method string, cseq int, headers map[string]string) rtspRequestOutcome {
	hops := 0
	for {
		// 阶段 ID 由 route.stage 按当前跳次加后缀：跟随重定向后重建的 dns/tcp/tls 与
		// 本阶段请求各自独立成项，不再覆盖上一跳的时间。
		c.route.hop = hops
		stageID := networkRedirectStageID(baseStageID, hops)
		uri := rtspRequestURI(c.target.URL)
		meta := map[string]string{
			"requestURI":       uri,
			"cseq":             strconv.Itoa(cseq),
			"targetResolution": c.route.targetResolution(),
		}
		c.route.stage(baseStageID, "running", NetworkTestStage{Request: formatRTSPRequest(method, uri, c.run.userAgent(), headers, cseq), Meta: meta})
		response, nextSeq, err := c.exchange(method, uri, headers, cseq)
		if err != nil {
			return rtspRequestOutcome{nextSeq: nextSeq, stageID: stageID, hops: hops, err: err}
		}
		if !isNetworkRedirectStatus(response.statusCode) {
			return rtspRequestOutcome{response: response, nextSeq: nextSeq, stageID: stageID, hops: hops}
		}
		location := response.header.Get("Location")
		if location == "" {
			return rtspRequestOutcome{response: response, nextSeq: nextSeq, stageID: stageID, hops: hops}
		}
		if hops >= c.route.request.MaxRedirects {
			limit := c.route.request.MaxRedirects
			meta["redirectTarget"] = location
			meta["redirectLimit"] = strconv.Itoa(limit)
			message := networkTestErrorf("networkTestTool.backend.rtspRedirectNotFollowed", "method", method, "status", response.statusLine, "target", location, "limit", limit).Error()
			c.route.stage(baseStageID, "error", NetworkTestStage{Response: rtspResponseSummary(response), StatusCode: response.statusCode, Meta: meta, Error: message})
			return rtspRequestOutcome{response: response, nextSeq: nextSeq, stageID: stageID, hops: hops, err: errors.New(message)}
		}
		next, droppedCredentials, err := resolveRTSPRedirect(c.target, location)
		if err != nil {
			meta["redirectTarget"] = location
			c.route.stage(baseStageID, "error", NetworkTestStage{Response: rtspResponseSummary(response), StatusCode: response.statusCode, Meta: meta, Error: err.Error()})
			return rtspRequestOutcome{response: response, nextSeq: nextSeq, stageID: stageID, hops: hops, err: err}
		}
		meta["redirectTarget"] = location
		meta["redirectFollowed"] = "true"
		if droppedCredentials {
			meta["credentialsDropped"] = networkTestText("networkTestTool.backend.rtspRedirectCredentialsDropped", nil)
		}
		c.route.stage(baseStageID, "success", NetworkTestStage{Response: rtspResponseSummary(response), StatusCode: response.statusCode, Meta: meta})
		// 新一跳的链路阶段使用新后缀：先切跳次再重连，dns/tcp/tls 才不会覆盖上一跳。
		c.route.hop = hops + 1
		if err := c.reconnect(next); err != nil {
			// 连不上跳转地址：错误记在下一跳上，具体失败原因在 tcp-connect / tls 阶段。
			return rtspRequestOutcome{nextSeq: nextSeq, stageID: networkRedirectStageID(baseStageID, hops+1), hops: hops, err: err}
		}
		cseq = nextSeq
		hops++
	}
}

// exchange 发送一次请求；服务端用 401 要求认证时，用当前地址的凭据应答挑战并重试一次，
// 认证过程单独记在 rtsp-auth 阶段。返回响应与下一个可用 CSeq。
func (c *rtspClient) exchange(method, uri string, headers map[string]string, cseq int) (*rtspResponse, int, error) {
	response, err := c.session.exchange(method, uri, c.run.userAgent(), headers, cseq)
	if err != nil {
		return nil, cseq + 1, c.classifyFailure(method, err)
	}
	if response.statusCode != http.StatusUnauthorized {
		return response, cseq + 1, nil
	}
	pictureURL := redactURLUserinfo(c.target.URL)
	if c.target.creds == nil || c.target.creds.username == "" {
		c.route.stage("rtsp-auth", "error", NetworkTestStage{
			Response:   rtspResponseSummary(response),
			StatusCode: response.statusCode,
			Meta:       rtspAuthMeta(response, pictureURL, false),
			Error:      rtspAuthRequiredError(response, pictureURL).Error(),
		})
		return response, cseq + 1, nil
	}
	challenge := parseRTSPAuthChallenge(response.header.Values("WWW-Authenticate"))
	if challenge == nil {
		return response, cseq + 1, nil
	}
	authenticated := cloneStringMap(headers)
	authenticated["Authorization"] = c.target.creds.authorizationHeader(challenge, method, uri, cseq)
	c.route.stage("rtsp-auth", "running", NetworkTestStage{
		Request: formatRTSPRequest(method, uri, c.run.userAgent(), map[string]string{"Authorization": "<credentials withheld>"}, cseq+1),
		Meta:    rtspAuthMeta(response, pictureURL, true),
	})
	retry, retryErr := c.session.exchange(method, uri, c.run.userAgent(), authenticated, cseq+1)
	if retryErr != nil {
		failure := c.classifyFailure(method, retryErr)
		c.route.fail("rtsp-auth", failure)
		return nil, cseq + 2, failure
	}
	if err := rtspStatusError(method, retry); err != nil {
		c.route.stage("rtsp-auth", "error", NetworkTestStage{
			Response:   rtspResponseSummary(retry),
			StatusCode: retry.statusCode,
			Meta:       rtspAuthMeta(retry, pictureURL, true),
			Error:      networkTestErrorf("networkTestTool.backend.rtspCredentialsRejected", "method", method, "status", retry.statusLine).Error(),
		})
		return retry, cseq + 2, nil
	}
	c.route.stage("rtsp-auth", "success", NetworkTestStage{
		Response:   rtspResponseSummary(retry),
		StatusCode: retry.statusCode,
		Meta:       rtspAuthMeta(retry, pictureURL, true),
	})
	return retry, cseq + 2, nil
}

// resolveRTSPRedirect 解析 3xx 的 Location：Location 可以是绝对地址，也可以只是路径。
// 只有重定向仍指向同一主机时才继续使用原凭据，跨主机跳转不再发送凭据，避免把密码交给
// 另一台设备。
func resolveRTSPRedirect(current networkTarget, location string) (networkTarget, bool, error) {
	if current.URL == nil {
		return networkTarget{}, false, errors.New("redirect target cannot be resolved without a base URL")
	}
	resolved, err := current.URL.Parse(strings.TrimSpace(location))
	if err != nil {
		return networkTarget{}, false, networkTestErrorParamsCause("networkTestTool.backend.rtspRedirectInvalid", map[string]any{"target": location}, err)
	}
	target, err := parseNetworkTarget("rtsp", resolved.String())
	if err != nil {
		// 外层说明是哪个 Location 无效，内层保留具体原因（例如协议不符）。
		return networkTarget{}, false, networkTestErrorParamsCause("networkTestTool.backend.rtspRedirectInvalid", map[string]any{"target": location}, err)
	}
	if current.creds == nil || current.creds.username == "" {
		return target, false, nil
	}
	if !strings.EqualFold(target.Host, current.Host) {
		return target, true, nil
	}
	target.creds = current.creds
	return target, false, nil
}

// rtspExchangeFailure 是一次 RTSP 收发失败的可读结论。noResponse 表示一个字节的响应都没收到：
// 只有这种情况才值得继续探测该端口是否只接受加密连接——收到过字节说明对端在按 RTSP 说话。
type rtspExchangeFailure struct {
	message    error
	raw        error
	noResponse bool
}

// classifyRTSPExchangeFailure 把网络层错误翻译成可读结论。TCP 连接成功但服务端不回一个字节是
// 这类设备与中间盒最常见的表现：设备、VPN 或防火墙可能对任意端口都接受连接，而原始
// 的 "i/o timeout" 无法说明这一点。
func classifyRTSPExchangeFailure(ctx context.Context, method string, err error) rtspExchangeFailure {
	failure := rtspExchangeFailure{raw: err}
	var responseError *rtspResponseError
	received := errors.As(err, &responseError) && responseError.received
	var timeoutError interface{ Timeout() bool }
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded),
		errors.Is(err, context.DeadlineExceeded),
		errors.As(err, &timeoutError) && timeoutError.Timeout():
		failure.message = networkTestErrorParamsCause("networkTestTool.backend.rtspNoResponse", map[string]any{"method": method}, err)
		// 收到过字节说明对端确实在按 RTSP 说话，只是响应没读完，无需再探测加密端点。
		failure.noResponse = !received
	case errors.Is(ctx.Err(), context.Canceled):
		// 超时或取消时运行上下文会主动关闭连接，读操作可能返回 net.ErrClosed
		// （use of closed network connection）；结论应取自上下文而不是错误文本。
		failure.message = networkTestErrorParamsCause("networkTestTool.backend.rtspStoppedWhileWaiting", map[string]any{"method": method}, err)
	case errors.As(err, &responseError) && !responseError.received:
		failure.message = networkTestErrorParamsCause("networkTestTool.backend.rtspClosedWithoutResponse", map[string]any{"method": method}, err)
		failure.noResponse = true
	case received && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)):
		failure.message = networkTestErrorParamsCause("networkTestTool.backend.rtspClosedMidResponse", map[string]any{"method": method}, err)
	}
	if failure.message == nil {
		failure.message = err
	}
	return failure
}

// classifyFailure 给出一次收发失败的结论。明文请求一个字节的响应都没收到时，先探测该端口是否
// 只接受加密连接：能证明时原因就是协议前缀（rtsp 应为 rtsps），而不是对端是否响应。
func (c *rtspClient) classifyFailure(method string, err error) error {
	failure := classifyRTSPExchangeFailure(c.run.ctx, method, err)
	if !failure.noResponse || c.target.URL == nil {
		return failure.message
	}
	if verdict, found := c.run.explainSilentFailure(c.route, c.target, failure.raw); found {
		return verdict
	}
	return failure.message
}

func rtspAuthMeta(response *rtspResponse, pictureURL string, sent bool) map[string]string {
	meta := rtspResponseMeta(response, "")
	delete(meta, "targetResolution")
	delete(meta, "statusLine")
	meta["method"] = response.statusLine
	if pictureURL != "" {
		meta["target"] = pictureURL
	}
	meta["credentialsSent"] = strconv.FormatBool(sent)
	if challenge := strings.Join(response.header.Values("WWW-Authenticate"), ", "); challenge != "" {
		meta["challenge"] = challenge
	}
	return meta
}

// rtspAuthRequiredError 说明服务端要求认证且目标 URL 没有提供凭据。提示使用脱敏后的
// 地址形态，避免把凭据写进错误信息。
func rtspAuthRequiredError(response *rtspResponse, pictureURL string) error {
	return networkTestErrorf("networkTestTool.backend.rtspAuthRequired", "status", response.statusLine, "example", credentialTargetHint(pictureURL))
}

func credentialTargetHint(pictureURL string) string {
	scheme := "rtsp://"
	rest := pictureURL
	for _, prefix := range []string{"rtsp://", "rtsps://"} {
		if strings.HasPrefix(pictureURL, prefix) {
			scheme = prefix
			rest = strings.TrimPrefix(pictureURL, prefix)
			break
		}
	}
	return scheme + "user:password@" + rest
}

// rtspSession 在一条 TCP（或 rtsps 的 TLS）连接上按 CSeq 顺序收发 RTSP 报文。
type rtspSession struct {
	conn   net.Conn
	reader *bufio.Reader
}

type rtspResponse struct {
	protocol      string
	statusCode    int
	reason        string
	statusLine    string
	header        http.Header
	body          []byte
	bodyTruncated bool
}

// exchange 写入一个 RTSP 请求并读取对应响应；请求语法固定为 RTSP/1.0，不需要额外协商。
func (s *rtspSession) exchange(method, uri, userAgent string, extraHeaders map[string]string, cseq int) (*rtspResponse, error) {
	if s.reader == nil {
		s.reader = bufio.NewReader(s.conn)
	}
	if _, err := io.WriteString(s.conn, formatRTSPRequest(method, uri, userAgent, extraHeaders, cseq)); err != nil {
		return nil, err
	}
	return readRTSPResponse(s.reader)
}

// sanitizeHeaderValue 去掉头部值里的 CR/LF：这些值会直接写进（手写的）请求文本，不能让它切断报文
// 或插入新的头部行。
func sanitizeHeaderValue(value string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(value)
}

// formatRTSPRequest 生成 RTSP 请求文本。URI 与头部值里的 CR/LF 会被移除，避免请求拆分。
func formatRTSPRequest(method, uri, userAgent string, extraHeaders map[string]string, cseq int) string {
	var builder strings.Builder
	builder.WriteString(method + " " + sanitizeHeaderValue(uri) + " RTSP/1.0\r\n")
	builder.WriteString("CSeq: " + strconv.Itoa(cseq) + "\r\n")
	builder.WriteString("User-Agent: " + sanitizeHeaderValue(userAgent) + "\r\n")
	keys := make([]string, 0, len(extraHeaders))
	for key := range extraHeaders {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		builder.WriteString(key + ": " + sanitizeHeaderValue(extraHeaders[key]) + "\r\n")
	}
	builder.WriteString("\r\n")
	return builder.String()
}

// rtspRequestURI 返回 RTSP 请求行中的绝对 URI（RFC 2326 允许直接使用目标 URL）。
// 凭据通过 Authorization 头单独发送，不出现在请求行里。
func rtspRequestURI(target *url.URL) string {
	if target == nil {
		return "*"
	}
	clean := *target
	clean.User = nil
	uri := clean.String()
	if uri == "" {
		return "*"
	}
	return uri
}

// readRTSPResponse 按 RFC 2326 的消息格式读取一个响应：状态行、头部（直到空行），
// 以及由 Content-Length 声明的消息体。
func readRTSPResponse(reader *bufio.Reader) (*rtspResponse, error) {
	statusLine, err := readRTSPLine(reader)
	if err != nil {
		return nil, &rtspResponseError{err: err}
	}
	line := strings.TrimRight(statusLine, "\r\n")
	fields := strings.SplitN(line, " ", 3)
	if len(fields) < 2 || !strings.HasPrefix(strings.ToUpper(fields[0]), "RTSP/") {
		return nil, fmt.Errorf("unexpected RTSP status line %q", line)
	}
	statusCode, err := strconv.Atoi(fields[1])
	if err != nil {
		return nil, fmt.Errorf("unexpected RTSP status line %q", line)
	}
	response := &rtspResponse{protocol: fields[0], statusCode: statusCode, header: make(http.Header)}
	if len(fields) == 3 {
		response.reason = fields[2]
	}
	response.statusLine = strings.TrimSpace(strconv.Itoa(response.statusCode) + " " + response.reason)
	for {
		headerLine, err := readRTSPLine(reader)
		if err != nil {
			return nil, &rtspResponseError{received: true, err: err}
		}
		trimmed := strings.TrimRight(headerLine, "\r\n")
		if trimmed == "" {
			break
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		response.header.Add(strings.TrimSpace(key), strings.TrimSpace(value))
	}
	contentLength := int64(0)
	if value := response.header.Get("Content-Length"); value != "" {
		contentLength, err = strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || contentLength < 0 {
			return nil, fmt.Errorf("invalid Content-Length %q in RTSP response", value)
		}
	}
	if contentLength > maxRTSPResponseBytes {
		response.bodyTruncated = true
		contentLength = maxRTSPResponseBytes
	}
	if contentLength == 0 {
		return response, nil
	}
	response.body, err = io.ReadAll(io.LimitReader(reader, contentLength))
	if err != nil {
		return nil, &rtspResponseError{received: true, err: err}
	}
	return response, nil
}

// rtspResponseError 记录读取 RTSP 响应失败时是否已经收到过字节。没有收到任何字节说明
// 服务端未响应；据此给出结论，而不是依赖不同平台各自的连接错误码（EOF 与
// ECONNRESET 会随关闭时机交替出现）。
type rtspResponseError struct {
	received bool
	err      error
}

func (e *rtspResponseError) Error() string { return e.err.Error() }

func (e *rtspResponseError) Unwrap() error { return e.err }

// readRTSPLine 读取一行，并在服务端行过长时返回明确错误，而不是无限缓冲。
func readRTSPLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	if len(line) > 8192 {
		return "", errors.New("RTSP header line exceeds 8192 bytes")
	}
	return line, nil
}

// rtspResponseSummary 复用 HTTP 响应摘要的排版（状态行 + 排序后的头部 + 消息体）。
func rtspResponseSummary(response *rtspResponse) string {
	status := strings.TrimSpace(fmt.Sprintf("%d %s", response.statusCode, response.reason))
	summary, _ := httpResponseSummary(&http.Response{Proto: response.protocol, Status: status, Header: response.header}, response.body)
	if response.bodyTruncated {
		summary += "\n[response body truncated after 64 KiB]\n"
	}
	return summary
}

// rtspResponseMeta 记录状态行、原因短语与响应头部，供阶段详情展示。
func rtspResponseMeta(response *rtspResponse, targetResolution string) map[string]string {
	meta := map[string]string{
		"statusLine":       strings.TrimSpace(response.protocol + " " + response.statusLine),
		"protocol":         response.protocol,
		"statusCode":       strconv.Itoa(response.statusCode),
		"targetResolution": targetResolution,
		"bodyBytes":        strconv.Itoa(len(response.body)),
	}
	if response.reason != "" {
		meta["reason"] = response.reason
	}
	for key, values := range response.header {
		meta["header."+strings.ToLower(key)] = strings.Join(values, ", ")
	}
	return meta
}

// rtspStatusError 把非 2xx 状态转换为错误，并保留服务端给出的诊断信息。
func rtspStatusError(method string, response *rtspResponse) error {
	if response.statusCode >= 200 && response.statusCode < 300 {
		return nil
	}
	notice := ""
	for _, key := range []string{"Notice", "Warning"} {
		if value := response.header.Get(key); value != "" {
			notice = strings.TrimSpace(notice + "; " + key + ": " + value)
		}
	}
	notice = strings.TrimLeft(notice, "; ")
	if notice != "" {
		return networkTestErrorf("networkTestTool.backend.rtspStatusWithNotice", "method", method, "status", response.statusLine, "notice", strings.NewReplacer("\r", " ", "\n", " ").Replace(notice))
	}
	return networkTestErrorf("networkTestTool.backend.rtspStatus", "method", method, "status", response.statusLine)
}

// describeMediaMeta 从 SDP 描述中提取媒体数量与类型，用于快速判断 DESCRIBE 是否返回了
// 可播放的会话描述。
func describeMediaMeta(body []byte) map[string]string {
	if len(body) == 0 {
		return nil
	}
	text := strings.ToValidUTF8(string(body), "�")
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	mediaTypes := make([]string, 0, 4)
	count := 0
	for _, line := range lines {
		if !strings.HasPrefix(line, "m=") {
			continue
		}
		count++
		if mediaType, _, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(line, "m=")), " "); ok && mediaType != "" {
			if !slices.Contains(mediaTypes, mediaType) {
				mediaTypes = append(mediaTypes, mediaType)
			}
		}
	}
	meta := map[string]string{"sdpLines": strconv.Itoa(len(lines))}
	if count > 0 {
		meta["mediaSections"] = strconv.Itoa(count)
	}
	if len(mediaTypes) > 0 {
		meta["mediaTypes"] = strings.Join(mediaTypes, ", ")
	}
	return meta
}

// rtspCredentials 保存从目标 URL 提取的凭据。凭据只在会话内存中使用，不会出现在
// 阶段展示的 URL、请求行或响应摘要里。
type rtspCredentials struct {
	username string
	password string
}

// rtspAuthChallenge 是 RFC 7616 Digest 挑战中本工具使用的参数。qop 只接受 auth：
// RTSP 没有请求体，auth-int 在这里没有意义。
type rtspAuthChallenge struct {
	realm     string
	nonce     string
	algorithm string
	qop       string
	opaque    string
	basic     bool
}

// authorizationHeader 生成应答挑战的 Authorization 值。nonceCount 是同一 challenge
// 下的第几次请求，用于 qop=auth 的 nc 参数。
func (c *rtspCredentials) authorizationHeader(challenge *rtspAuthChallenge, method, uri string, nonceCount int) string {
	if c == nil || challenge == nil || c.username == "" {
		return ""
	}
	if challenge.basic {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(c.username+":"+c.password))
	}
	digest := func(value string) string { return hashDigestValue(challenge.algorithm, value) }
	ha1 := digest(c.username + ":" + challenge.realm + ":" + c.password)
	ha2 := digest(method + ":" + uri)
	parts := []string{
		`username="` + c.username + `"`,
		`realm="` + challenge.realm + `"`,
		`nonce="` + challenge.nonce + `"`,
		`uri="` + uri + `"`,
	}
	if challenge.algorithm != "" {
		parts = append(parts, "algorithm="+challenge.algorithm)
	}
	if challenge.opaque != "" {
		parts = append(parts, `opaque="`+challenge.opaque+`"`)
	}
	var response string
	if challenge.qop != "" {
		cnonce := randomHexToken()
		nc := fmt.Sprintf("%08x", nonceCount)
		response = digest(ha1 + ":" + challenge.nonce + ":" + nc + ":" + cnonce + ":auth:" + ha2)
		parts = append(parts, "qop=auth", "nc="+nc, `cnonce="`+cnonce+`"`)
	} else {
		response = digest(ha1 + ":" + challenge.nonce + ":" + ha2)
	}
	parts = append(parts, `response="`+response+`"`)
	return "Digest " + strings.Join(parts, ", ")
}

func hashDigestValue(algorithm, value string) string {
	base := strings.TrimSuffix(strings.ToUpper(strings.TrimSpace(algorithm)), "-SESS")
	if base == "" || base == "MD5" {
		sum := md5.Sum([]byte(value))
		return hex.EncodeToString(sum[:])
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// parseRTSPAuthChallenge 解析 WWW-Authenticate 头。服务端可以下发多个挑战，按顺序取第一个
// 能识别的；Digest 优先于 Basic，避免凭据以明文形式发送。
func parseRTSPAuthChallenge(values []string) *rtspAuthChallenge {
	var basic *rtspAuthChallenge
	for _, value := range values {
		scheme, rest, ok := strings.Cut(strings.TrimSpace(value), " ")
		if !ok {
			continue
		}
		switch {
		case strings.EqualFold(scheme, "Digest"):
			challenge := &rtspAuthChallenge{}
			for _, part := range splitAuthChallengeParts(rest) {
				key, raw, ok := strings.Cut(part, "=")
				if !ok {
					continue
				}
				key = strings.ToLower(strings.TrimSpace(key))
				raw = strings.Trim(strings.TrimSpace(raw), `"`)
				switch key {
				case "realm":
					challenge.realm = raw
				case "nonce":
					challenge.nonce = raw
				case "algorithm":
					challenge.algorithm = strings.ToUpper(raw)
				case "qop":
					for _, option := range strings.Split(raw, ",") {
						if strings.EqualFold(strings.TrimSpace(option), "auth") {
							challenge.qop = "auth"
						}
					}
				case "opaque":
					challenge.opaque = raw
				}
			}
			if challenge.realm == "" || challenge.nonce == "" {
				continue
			}
			if challenge.algorithm == "" {
				challenge.algorithm = "MD5"
			}
			if !supportedDigestAlgorithm(challenge.algorithm) {
				continue
			}
			return challenge
		case strings.EqualFold(scheme, "Basic") && basic == nil:
			realm := ""
			if key, raw, ok := strings.Cut(strings.TrimSpace(rest), "="); ok && strings.EqualFold(strings.TrimSpace(key), "realm") {
				realm = strings.Trim(strings.TrimSpace(raw), `"`)
			}
			basic = &rtspAuthChallenge{realm: realm, basic: true}
		}
	}
	return basic
}

// splitAuthChallengeParts 按引号外的逗号切分挑战参数，例如
// `qop="auth,auth-int", nonce="..."`。
func splitAuthChallengeParts(value string) []string {
	var parts []string
	var builder strings.Builder
	quoted := false
	for _, symbol := range value {
		switch {
		case symbol == '"':
			quoted = !quoted
			builder.WriteRune(symbol)
		case symbol == ',' && !quoted:
			parts = append(parts, builder.String())
			builder.Reset()
		default:
			builder.WriteRune(symbol)
		}
	}
	parts = append(parts, builder.String())
	return parts
}

func supportedDigestAlgorithm(algorithm string) bool {
	switch strings.TrimSuffix(strings.ToUpper(strings.TrimSpace(algorithm)), "-SESS") {
	case "", "MD5", "SHA-256", "SHA-512-256":
		return true
	default:
		return false
	}
}

func randomHexToken() string {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(bytes[:])
}

// redactURLUserinfo 把 URL 中的凭据替换为 ***，用于阶段元信息与错误提示。
func redactURLUserinfo(target *url.URL) string {
	if target == nil {
		return ""
	}
	clean := *target
	if clean.User != nil {
		clean.User = url.UserPassword(clean.User.Username(), "***")
	}
	return clean.String()
}
