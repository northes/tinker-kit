package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const networkTestEvent = "network-test:update"

type NetworkInterface struct {
	Name      string   `json:"name"`
	Index     int      `json:"index"`
	Addresses []string `json:"addresses"`
}

type NetworkTestRequest struct {
	RunID         string `json:"runID"`
	Protocol      string `json:"protocol"`
	Target        string `json:"target"`
	Payload       string `json:"payload"`
	TimeoutMillis int    `json:"timeoutMillis"`
	SkipTLSVerify bool   `json:"skipTLSVerify"`
	MaxRedirects  int    `json:"maxRedirects"`
	ProxyType     string `json:"proxyType"`
	ProxyAddress  string `json:"proxyAddress"`
	DNSAddress    string `json:"dnsAddress"`
	DNSMode       string `json:"dnsMode"`
	InterfaceName string `json:"interfaceName"`
}

type NetworkTestStage struct {
	RunID          string            `json:"runID"`
	ID             string            `json:"id"`
	Status         string            `json:"status"`
	StartedAt      int64             `json:"startedAt"`
	FinishedAt     int64             `json:"finishedAt"`
	DurationMillis int64             `json:"durationMillis"`
	Request        string            `json:"request"`
	Response       string            `json:"response"`
	StatusCode     int               `json:"statusCode"`
	Meta           map[string]string `json:"meta"`
	Error          string            `json:"error"`
}

type NetworkTestUpdate struct {
	RunID string           `json:"runID"`
	Stage NetworkTestStage `json:"stage"`
}

type NetworkTestResult struct {
	RunID          string             `json:"runID"`
	Protocol       string             `json:"protocol"`
	Target         string             `json:"target"`
	Status         string             `json:"status"`
	StartedAt      int64              `json:"startedAt"`
	FinishedAt     int64              `json:"finishedAt"`
	DurationMillis int64              `json:"durationMillis"`
	Error          string             `json:"error"`
	Stages         []NetworkTestStage `json:"stages"`
}

type NetworkTestService struct {
	mu       sync.Mutex
	cancels  map[string]context.CancelFunc
	emitMu   sync.RWMutex
	emitFunc func(string, any)
}

func NewNetworkTestService() *NetworkTestService {
	return &NetworkTestService{cancels: make(map[string]context.CancelFunc)}
}

func (s *NetworkTestService) ServiceName() string { return "NetworkTestService" }

func (s *NetworkTestService) setEventEmitter(emit func(string, any)) {
	s.emitMu.Lock()
	s.emitFunc = emit
	s.emitMu.Unlock()
}

func (s *NetworkTestService) emit(update NetworkTestUpdate) {
	s.emitMu.RLock()
	emit := s.emitFunc
	s.emitMu.RUnlock()
	if emit != nil {
		emit(networkTestEvent, update)
	}
}

func (s *NetworkTestService) ListNetworkInterfaces() []NetworkInterface {
	interfaces, err := net.Interfaces()
	if err != nil {
		return []NetworkInterface{}
	}
	result := make([]NetworkInterface, 0, len(interfaces))
	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 {
			continue
		}
		addresses, err := item.Addrs()
		if err != nil {
			continue
		}
		entry := NetworkInterface{Name: item.Name, Index: item.Index, Addresses: []string{}}
		for _, address := range addresses {
			if parsed, _, err := net.ParseCIDR(address.String()); err == nil {
				entry.Addresses = append(entry.Addresses, parsed.String())
			}
		}
		result = append(result, entry)
	}
	return result
}

func (s *NetworkTestService) CancelNetworkTest(runID string) {
	s.mu.Lock()
	cancel := s.cancels[runID]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *NetworkTestService) shutdown() {
	s.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.cancels))
	for _, cancel := range s.cancels {
		cancels = append(cancels, cancel)
	}
	s.cancels = make(map[string]context.CancelFunc)
	s.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

type networkTestRun struct {
	service *NetworkTestService
	runID   string
	ctx     context.Context
	request NetworkTestRequest
	mu      sync.Mutex
	stages  map[string]NetworkTestStage
	starts  map[string]time.Time
	// proxyHint 缓存「直连失败时用于提示的系统代理地址」，每次运行最多查询一次。
	proxyHint       string
	proxyHintLoaded bool
}

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

func mergeStageMeta(previous, next map[string]string) map[string]string {
	if len(previous) == 0 {
		return next
	}
	merged := make(map[string]string, len(previous)+len(next))
	for key, value := range previous {
		merged[key] = value
	}
	for key, value := range next {
		merged[key] = value
	}
	return merged
}

func (r *networkTestRun) stage(id string, status string, fields NetworkTestStage) {
	r.mu.Lock()
	previous := r.stages[id]
	now := time.Now()
	if status == "running" && previous.Status != "running" {
		r.starts[id] = now
	}
	if previous.StartedAt != 0 {
		fields.StartedAt = previous.StartedAt
	} else {
		fields.StartedAt = now.UnixMilli()
	}
	fields.RunID = r.runID
	fields.ID = id
	fields.Status = status
	fields.Meta = mergeStageMeta(previous.Meta, fields.Meta)
	if fields.Request == "" {
		fields.Request = previous.Request
	}
	if fields.Response == "" {
		fields.Response = previous.Response
	}
	if fields.StatusCode == 0 {
		fields.StatusCode = previous.StatusCode
	}
	if status == "running" {
		fields.FinishedAt = 0
		fields.DurationMillis = 0
	} else {
		fields.FinishedAt = now.UnixMilli()
		if started, ok := r.starts[id]; ok {
			fields.DurationMillis = max(0, now.Sub(started).Milliseconds())
			delete(r.starts, id)
		} else if previous.FinishedAt != 0 {
			fields.DurationMillis = previous.DurationMillis
		} else {
			fields.DurationMillis = max(0, fields.FinishedAt-fields.StartedAt)
		}
	}
	r.stages[id] = fields
	r.mu.Unlock()
	r.service.emit(NetworkTestUpdate{RunID: r.runID, Stage: fields})
}

func (r *networkTestRun) fail(id string, err error) {
	if err == nil {
		return
	}
	status := "error"
	if errors.Is(err, context.Canceled) || errors.Is(r.ctx.Err(), context.Canceled) {
		status = "canceled"
	} else if errors.Is(err, context.DeadlineExceeded) || errors.Is(r.ctx.Err(), context.DeadlineExceeded) {
		status = "timeout"
	} else {
		var timeoutError interface{ Timeout() bool }
		if errors.As(err, &timeoutError) && timeoutError.Timeout() {
			status = "timeout"
		}
	}
	// 阶段错误与页脚结论同源：都经过提示合成，避免只有一处带提示。
	r.stage(id, status, NetworkTestStage{Error: r.composeFailureHint(err).Error()})
}

func (r *networkTestRun) currentStage(fallback string) string {
	return r.currentStageForHop(fallback, 0)
}

func (r *networkTestRun) currentStageForHop(fallback string, redirectCount int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	stageID := func(id string) string { return networkRedirectStageID(id, redirectCount) }
	for _, baseID := range []string{"rtsp-describe", "http-response", "websocket-handshake", "http-request", "ntp-response", "udp-response", "ntp-request", "udp-send", "rtsp-auth", "rtsp-options", "tls", "proxy-tunnel", "tcp-connect", "dns-target", "dns-proxy", "proxy-resolve"} {
		id := stageID(baseID)
		stage, ok := r.stages[id]
		if ok && stage.Status == "running" {
			return id
		}
	}
	for _, baseID := range []string{"proxy-resolve", "dns-target", "dns-proxy", "tcp-connect", "proxy-tunnel", "tls", "http-request", "websocket-handshake", "http-response", "rtsp-options", "rtsp-auth", "rtsp-describe", "udp-send", "udp-response", "ntp-request", "ntp-response"} {
		id := stageID(baseID)
		stage, ok := r.stages[id]
		if ok && (stage.Status == "error" || stage.Status == "timeout" || stage.Status == "canceled") {
			return id
		}
	}
	if strings.Contains(fallback, "-redirect-") {
		if stage, ok := r.stages[fallback]; ok && (stage.Status == "running" || stage.Status == "error" || stage.Status == "timeout" || stage.Status == "canceled") {
			return fallback
		}
	}
	requestID := stageID("http-request")
	if request, ok := r.stages[requestID]; ok && request.Status == "success" {
		return stageID("http-response")
	}
	return fallback
}

// composeFailureHint 在「本次直连 + 失败属于连接被丢下 + 本机配置了系统代理」时，把提示合成进
// 同一条本地化结论；阶段错误与页脚结论共用它，因此两处文案完全一致。
func (r *networkTestRun) composeFailureHint(err error) error {
	if err == nil || strings.TrimSpace(r.request.ProxyType) != "" || !isConnectionLevelFailure(err) {
		return err
	}
	if !r.proxyHintLoaded {
		r.proxyHintLoaded = true
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if config, loadErr := loadSystemProxyConfig(ctx); loadErr == nil {
			r.proxyHint = directProxyHint(r.request.ProxyType, err, config, config.hasProxy())
		}
	}
	if r.proxyHint == "" {
		return err
	}
	// 以原错误作为 cause：detail 保留其完整文本（若本身已是本地化结论，前端会递归渲染），
	// 同时保住错误链，供超时/取消判定使用。
	return userErrorParamsCause("networkTestTool.backend.failure.directWithSystemProxy", map[string]any{"proxy": r.proxyHint}, err)
}

func newNetworkRunID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(bytes[:])
}

func (s *NetworkTestService) RunNetworkTest(request NetworkTestRequest) NetworkTestResult {
	started := time.Now()
	if request.RunID == "" {
		request.RunID = newNetworkRunID()
	}
	request.RunID = strings.TrimSpace(request.RunID)
	if request.TimeoutMillis < 1000 {
		request.TimeoutMillis = 30000
	}
	if request.TimeoutMillis > 300000 {
		request.TimeoutMillis = 300000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(request.TimeoutMillis)*time.Millisecond)
	s.mu.Lock()
	s.cancels[request.RunID] = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.cancels, request.RunID)
		s.mu.Unlock()
	}()

	run := &networkTestRun{service: s, runID: request.RunID, ctx: ctx, request: request, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
	result := NetworkTestResult{RunID: request.RunID, Protocol: request.Protocol, Target: strings.TrimSpace(request.Target), StartedAt: started.UnixMilli()}
	var err error
	switch strings.ToLower(strings.TrimSpace(request.Protocol)) {
	case "http":
		err = run.runHTTP(request)
	case "tcp":
		err = run.runTCP(request)
	case "websocket":
		err = run.runWebSocket(request)
	case "udp":
		err = run.runUDP(request)
	case "ntp":
		err = run.runNTP(request)
	case "rtsp":
		err = run.runRTSP(request)
	default:
		err = networkTestError("networkTestTool.backend.unsupportedProtocol")
	}
	result.FinishedAt = time.Now().UnixMilli()
	result.DurationMillis = max(0, result.FinishedAt-result.StartedAt)
	if err != nil {
		result.Status = "error"
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			result.Status = "canceled"
		} else if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.Status = "timeout"
		} else {
			var timeoutError interface{ Timeout() bool }
			if errors.As(err, &timeoutError) && timeoutError.Timeout() {
				result.Status = "timeout"
			}
		}
		// 阶段错误与页脚结论必须同源：这里用与 r.fail 相同的合成，避免只有一处带提示。
		result.Error = run.composeFailureHint(err).Error()
	} else {
		result.Status = "success"
	}
	run.mu.Lock()
	result.Stages = make([]NetworkTestStage, 0, len(run.stages))
	for _, stage := range run.stages {
		result.Stages = append(result.Stages, stage)
	}
	run.mu.Unlock()
	return result
}

type networkTarget struct {
	URL  *url.URL
	Host string
	Port string
	// creds 保存 URL 内嵌的凭据：凭据随 Authorization 头发送，不进入请求行与阶段元信息。
	creds *rtspCredentials
}

func parseNetworkTarget(protocol, raw string) (networkTarget, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return networkTarget{}, networkTestError("networkTestTool.backend.targetRequired")
	}
	if strings.ContainsAny(raw, "\r\n\x00") {
		return networkTarget{}, networkTestError("networkTestTool.backend.targetInvalidChars")
	}
	// TCP、UDP、NTP 目标形如 host:port；HTTP、WebSocket、RTSP 目标形如 URL。
	if protocol == "tcp" || protocol == "udp" || protocol == "ntp" {
		host, port, err := net.SplitHostPort(raw)
		if err != nil || host == "" {
			if protocol == "ntp" && err != nil && !strings.Contains(raw, ":") {
				host, port = raw, "123"
			} else {
				example := "example.com:443"
				protocolName := "TCP"
				if protocol == "udp" {
					protocolName = "UDP"
					example = "example.com:53"
				} else if protocol == "ntp" {
					protocolName = "NTP"
					example = "time.cloudflare.com:123"
				}
				return networkTarget{}, fmt.Errorf("%s target must include a host and port, such as %s", protocolName, example)
			}
		}
		if _, err := strconv.Atoi(port); err != nil {
			return networkTarget{}, fmt.Errorf("%s port must be a number between 1 and 65535", strings.ToUpper(protocol))
		}
		if n, _ := strconv.Atoi(port); n < 1 || n > 65535 {
			return networkTarget{}, fmt.Errorf("%s port must be a number between 1 and 65535", strings.ToUpper(protocol))
		}
		return networkTarget{Host: host, Port: port}, nil
	}
	if !strings.Contains(raw, "://") {
		scheme := "https"
		switch protocol {
		case "websocket":
			scheme = "wss"
		case "rtsp":
			scheme = "rtsp"
		default:
			scheme = "http"
		}
		raw = scheme + "://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return networkTarget{}, networkTestError("networkTestTool.backend.targetInvalidURL")
	}
	var credentials *rtspCredentials
	if u.User != nil {
		// RTSP 流媒体普遍用 Digest 认证，允许 rtsp://user:pass@host/path 形式；
		// 其余协议不在 URL 内传递凭据。
		if protocol != "rtsp" {
			return networkTarget{}, networkTestError("networkTestTool.backend.targetCredentials")
		}
		password, _ := u.User.Password()
		credentials = &rtspCredentials{username: u.User.Username(), password: password}
		u.User = nil
	}
	switch protocol {
	case "http":
		if u.Scheme != "http" && u.Scheme != "https" {
			return networkTarget{}, networkTestError("networkTestTool.backend.httpScheme")
		}
	case "websocket":
		if u.Scheme != "ws" && u.Scheme != "wss" {
			return networkTarget{}, networkTestError("networkTestTool.backend.websocketScheme")
		}
	case "rtsp":
		if u.Scheme != "rtsp" && u.Scheme != "rtsps" {
			return networkTarget{}, networkTestError("networkTestTool.backend.rtspScheme")
		}
	}
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https", "wss":
			port = "443"
		case "rtsp":
			port = "554"
		case "rtsps":
			port = "322"
		default:
			port = "80"
		}
	}
	return networkTarget{URL: u, Host: u.Hostname(), Port: port, creds: credentials}, nil
}

type networkRoute struct {
	run     *networkTestRun
	request NetworkTestRequest
	// hop 是当前重定向跳次：跟随重定向后重建连接时递增，使 dns/tcp/tls 等链路阶段
	// 各自成为独立的一项，而不是用同一个 ID 覆盖上一跳的时间。
	hop          int
	proxyType    string
	proxyURL     *url.URL
	resolver     *net.Resolver
	dnsServer    string
	iface        *net.Interface
	requestTrace *networkRequestTraceState
}

func (r *networkRoute) stage(id, status string, fields NetworkTestStage) {
	redirectCount := r.hop
	if r.requestTrace != nil {
		redirectCount = r.requestTrace.redirectCount()
	}
	id = networkRedirectStageID(id, redirectCount)
	if redirectCount > 0 {
		if fields.Meta == nil {
			fields.Meta = make(map[string]string)
		}
		fields.Meta["redirectCount"] = strconv.Itoa(redirectCount)
	}
	r.run.stage(id, status, fields)
}

func (r *networkRoute) fail(id string, err error) {
	if err == nil {
		return
	}
	redirectCount := r.hop
	if r.requestTrace != nil {
		redirectCount = r.requestTrace.redirectCount()
	}
	id = networkRedirectStageID(id, redirectCount)
	r.run.fail(id, err)
}

func newNetworkRoute(run *networkTestRun, request NetworkTestRequest) (*networkRoute, error) {
	route := &networkRoute{run: run, request: request, proxyType: strings.ToLower(strings.TrimSpace(request.ProxyType))}
	if (strings.EqualFold(strings.TrimSpace(request.Protocol), "udp") || strings.EqualFold(strings.TrimSpace(request.Protocol), "ntp")) && route.proxyType == "http" {
		return nil, networkTestError("networkTestTool.backend.udpProxyUnsupported")
	}
	if route.proxyType != "" && route.proxyType != "http" && route.proxyType != "socks5" && route.proxyType != "system" {
		return nil, networkTestError("networkTestTool.backend.proxyTypeInvalid")
	}
	if route.proxyType == "http" || route.proxyType == "socks5" {
		proxyValue := strings.TrimSpace(request.ProxyAddress)
		if route.proxyType == "http" && !strings.Contains(proxyValue, "://") {
			proxyValue = "http://" + proxyValue
		}
		if route.proxyType == "socks5" && !strings.Contains(proxyValue, "://") {
			proxyValue = "socks5://" + proxyValue
		}
		proxyURL, err := url.Parse(proxyValue)
		if err != nil || proxyURL.Hostname() == "" || proxyURL.User != nil || proxyURL.RawQuery != "" || proxyURL.Fragment != "" {
			return nil, networkTestError("networkTestTool.backend.proxyAddressInvalid")
		}
		if proxyURL.Port() == "" {
			return nil, networkTestError("networkTestTool.backend.proxyPortRequired")
		}
		if route.proxyType == "http" && proxyURL.Scheme != "http" {
			return nil, networkTestError("networkTestTool.backend.proxyHTTPScheme")
		}
		if route.proxyType == "socks5" && proxyURL.Scheme != "socks5" {
			return nil, networkTestError("networkTestTool.backend.proxySocks5Scheme")
		}
		route.proxyURL = proxyURL
	}
	if strings.TrimSpace(request.DNSAddress) != "" {
		dnsAddress := strings.TrimSpace(request.DNSAddress)
		if _, _, err := net.SplitHostPort(dnsAddress); err != nil {
			dnsAddress = net.JoinHostPort(strings.Trim(dnsAddress, "[]"), "53")
		}
		dnsHost, _, err := net.SplitHostPort(dnsAddress)
		if err != nil || net.ParseIP(strings.Trim(dnsHost, "[]")) == nil {
			return nil, networkTestError("networkTestTool.backend.dnsServerInvalid")
		}
		route.dnsServer = dnsAddress
		dialer := &net.Dialer{Timeout: 3 * time.Second}
		route.resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			dnsHost, _, _ := net.SplitHostPort(dnsAddress)
			local, err := route.localAddress(net.ParseIP(strings.Trim(dnsHost, "[]")))
			if err != nil {
				return nil, err
			}
			selected := *dialer
			if strings.HasPrefix(network, "udp") {
				if tcpAddress, ok := local.(*net.TCPAddr); ok {
					selected.LocalAddr = &net.UDPAddr{IP: tcpAddress.IP, Zone: tcpAddress.Zone}
				}
			} else {
				selected.LocalAddr = local
			}
			return selected.DialContext(ctx, network, dnsAddress)
		}}
	}
	if name := strings.TrimSpace(request.InterfaceName); name != "" {
		item, err := net.InterfaceByName(name)
		if err != nil {
			return nil, networkTestErrorParamsCause("networkTestTool.backend.interfaceUnavailable", map[string]any{"interface": name}, err)
		}
		route.iface = item
	}
	return route, nil
}

func (r *networkRoute) resolve(host string) ([]net.IPAddr, error) {
	stageID := "dns-target"
	if r.proxyURL != nil && strings.EqualFold(host, r.proxyURL.Hostname()) {
		stageID = "dns-proxy"
	}
	if ip := net.ParseIP(host); ip != nil {
		meta := r.resolverMetadata(host)
		meta["addresses"] = ip.String()
		r.stage(stageID, "success", NetworkTestStage{Meta: meta})
		return []net.IPAddr{{IP: ip}}, nil
	}
	r.stage(stageID, "running", NetworkTestStage{Meta: r.resolverMetadata(host)})
	resolver := r.resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addresses, err := resolver.LookupIPAddr(r.run.ctx, host)
	if err != nil {
		r.fail(stageID, err)
		return nil, err
	}
	values := make([]string, 0, len(addresses))
	for _, address := range addresses {
		values = append(values, address.IP.String())
	}
	meta := r.resolverMetadata(host)
	meta["addresses"] = strings.Join(values, ", ")
	r.stage(stageID, "success", NetworkTestStage{Meta: meta})
	return addresses, nil
}

func (r *networkRoute) resolverName() string {
	if r.dnsServer != "" {
		return r.dnsServer
	}
	return "system"
}

func (r *networkRoute) resolverMetadata(host string) map[string]string {
	if net.ParseIP(host) != nil {
		return map[string]string{
			"host":            host,
			"resolver":        "literal",
			"resolverType":    "literal",
			"cacheVisibility": "not-applicable",
		}
	}
	resolver := r.resolverName()
	resolverType := resolver
	cacheVisibility := "not-observable"
	switch resolver {
	case "system":
		resolverType = "system"
	default:
		resolverType = "custom"
	}
	return map[string]string{
		"host":            host,
		"resolver":        resolver,
		"resolverType":    resolverType,
		"cacheVisibility": cacheVisibility,
	}
}

func (r *networkRoute) localAddress(remote net.IP) (net.Addr, error) {
	if r.iface == nil {
		return nil, nil
	}
	addresses, err := r.iface.Addrs()
	if err != nil {
		return nil, fmt.Errorf("read network interface addresses: %w", err)
	}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err != nil || (remote.To4() != nil) != (ip.To4() != nil) {
			continue
		}
		if remote.To4() != nil {
			return &net.TCPAddr{IP: ip.To4()}, nil
		}
		return &net.TCPAddr{IP: ip}, nil
	}
	return nil, networkTestErrorf("networkTestTool.backend.interfaceNoAddress", "interface", r.iface.Name)
}

func (r *networkRoute) dialDirect(ctx context.Context, host, port string) (net.Conn, error) {
	addresses, err := r.resolve(host)
	if err != nil {
		return nil, err
	}
	r.stage("tcp-connect", "running", NetworkTestStage{Meta: map[string]string{"peer": net.JoinHostPort(host, port), "interface": r.interfaceName()}})
	var lastErr error
	for _, address := range addresses {
		local, err := r.localAddress(address.IP)
		if err != nil {
			lastErr = err
			break
		}
		dialer := net.Dialer{Timeout: time.Until(deadlineOr(ctx, time.Now().Add(10*time.Second))), LocalAddr: local}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(address.IP.String(), port))
		if err == nil {
			// localAddress 记录真实的本机出口地址：经 VPN/代理 TUN 的流量会显示 TUN 地址，
			// 据此可以判断连接是否真的走了物理网卡，而不是只看到「连接成功」。
			meta := map[string]string{
				"peer":          net.JoinHostPort(host, port),
				"remoteAddress": conn.RemoteAddr().String(),
				"localAddress":  conn.LocalAddr().String(),
				"interface":     r.interfaceName(),
			}
			if local != nil {
				meta["boundLocalAddress"] = local.String()
			}
			if r.proxyURL != nil && strings.EqualFold(r.proxyURL.Hostname(), host) && r.proxyURL.Port() == port {
				// 这次拨号连的是代理服务器：连接阶段本身就是「经代理」的记录项，
				// 否则用户只看到 peer 是代理地址，无法判断下一跳是谁。
				meta["outbound"] = "proxy"
				meta["proxy"] = net.JoinHostPort(host, port)
				meta["reachability"] = "unverified"
			}
			path, tunnel := probeTunnelOutbound(ctx, address.IP, conn.LocalAddr().String())
			if tunnel {
				// 握手对象是本机隧道端点，不是设备：不能让这一阶段只表达「连接成功」。
				meta["outbound"] = "tunnel"
				meta["reachability"] = "unverified"
				if path.Interface != "" {
					meta["tunnelInterface"] = path.Interface
				}
				if path.Gateway != "" {
					meta["tunnelGateway"] = path.Gateway
				}
			}
			stage := NetworkTestStage{Meta: meta}
			if r.request.Protocol == "tcp" {
				stage.Request = networkTestText("networkTestTool.backend.tcpConnectOnly", nil)
			}
			r.stage("tcp-connect", "success", stage)
			if tunnel {
				r.reportTunnelOutbound(net.JoinHostPort(host, port), conn.LocalAddr().String(), path)
			}
			return conn, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = networkTestError("networkTestTool.backend.noIPForTarget")
	}
	r.fail("tcp-connect", lastErr)
	return nil, lastErr
}

func deadlineOr(ctx context.Context, fallback time.Time) time.Time {
	if deadline, ok := ctx.Deadline(); ok {
		return deadline
	}
	return fallback
}

func (r *networkRoute) interfaceName() string {
	if r.iface == nil {
		return "automatic"
	}
	return r.iface.Name
}

func (r *networkRoute) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	switch r.proxyType {
	case "socks5":
		return r.dialSOCKS5(ctx, host, port)
	case "http":
		if r.proxyURL == nil {
			return nil, errors.New("HTTP proxy is not configured")
		}
		return r.dialDirect(ctx, r.proxyURL.Hostname(), r.proxyURL.Port())
	default:
		return r.dialDirect(ctx, host, port)
	}
}

func (r *networkRoute) dialSOCKS5(ctx context.Context, targetHost, targetPort string) (net.Conn, error) {
	proxyHost, proxyPort := r.proxyURL.Hostname(), r.proxyURL.Port()
	conn, err := r.dialDirect(ctx, proxyHost, proxyPort)
	if err != nil {
		return nil, err
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = conn.Close()
		}
	}()
	stopOnCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopOnCancel()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	r.stage("proxy-tunnel", "running", NetworkTestStage{Request: networkTestText("networkTestTool.backend.socks5ConnectRequest", nil), Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort), "targetResolution": r.targetResolution()}})
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if greeting[0] != 5 || greeting[1] != 0 {
		err := errors.New("SOCKS5 proxy does not support unauthenticated connections")
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	var request []byte
	if strings.EqualFold(r.request.DNSMode, "proxy") && net.ParseIP(targetHost) == nil {
		if len(targetHost) > 255 {
			err := errors.New("SOCKS5 target host name is too long")
			r.fail("proxy-tunnel", err)
			return nil, err
		}
		request = append(request, 5, 1, 0, 3, byte(len(targetHost)))
		request = append(request, []byte(targetHost)...)
	} else {
		addresses, err := r.resolve(targetHost)
		if err != nil {
			r.fail("proxy-tunnel", err)
			return nil, err
		}
		ip := addresses[0].IP
		if ip4 := ip.To4(); ip4 != nil {
			request = append(request, 5, 1, 0, 1)
			request = append(request, ip4...)
		} else {
			request = append(request, 5, 1, 0, 4)
			request = append(request, ip.To16()...)
		}
	}
	portNumber, _ := strconv.Atoi(targetPort)
	request = append(request, byte(portNumber>>8), byte(portNumber))
	if _, err := conn.Write(request); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	var reply [4]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if reply[0] != 5 || reply[1] != 0 {
		err := fmt.Errorf("SOCKS5 proxy rejected the tunnel (reply code %d)", reply[1])
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	addressLength := 0
	switch reply[3] {
	case 1:
		addressLength = net.IPv4len
	case 4:
		addressLength = net.IPv6len
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			r.fail("proxy-tunnel", err)
			return nil, err
		}
		addressLength = int(length[0])
	default:
		err := errors.New("SOCKS5 proxy returned an invalid address type")
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if _, err := io.CopyN(io.Discard, conn, int64(addressLength+2)); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	closeOnError = false
	r.stage("proxy-tunnel", "success", NetworkTestStage{Response: networkTestText("networkTestTool.backend.socks5TunnelEstablished", nil), Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort), "target": net.JoinHostPort(targetHost, targetPort), "targetResolution": r.targetResolution()}})
	return conn, nil
}

type networkDatagramChannel interface {
	Send([]byte) error
	Receive() ([]byte, string, error)
	SetReadDeadline(time.Time) error
	LocalAddr() string
	RemoteAddr() string
	Close() error
}

type directDatagramChannel struct {
	conn *net.UDPConn
}

func (c *directDatagramChannel) Send(payload []byte) error {
	_, err := c.conn.Write(payload)
	return err
}

func (c *directDatagramChannel) Receive() ([]byte, string, error) {
	buffer := make([]byte, 65535)
	n, err := c.conn.Read(buffer)
	if err != nil {
		return nil, "", err
	}
	return buffer[:n], c.conn.RemoteAddr().String(), nil
}

func (c *directDatagramChannel) SetReadDeadline(deadline time.Time) error {
	return c.conn.SetReadDeadline(deadline)
}

func (c *directDatagramChannel) LocalAddr() string  { return c.conn.LocalAddr().String() }
func (c *directDatagramChannel) RemoteAddr() string { return c.conn.RemoteAddr().String() }
func (c *directDatagramChannel) Close() error       { return c.conn.Close() }

type socks5DatagramChannel struct {
	conn        *net.UDPConn
	control     net.Conn
	requestHead []byte
	targetHost  string
	targetPort  int
	targetIP    net.IP
	remote      string
}

func (c *socks5DatagramChannel) Send(payload []byte) error {
	datagram := make([]byte, 0, len(c.requestHead)+len(payload))
	datagram = append(datagram, c.requestHead...)
	datagram = append(datagram, payload...)
	_, err := c.conn.Write(datagram)
	return err
}

func (c *socks5DatagramChannel) Receive() ([]byte, string, error) {
	buffer := make([]byte, 65535)
	for {
		n, err := c.conn.Read(buffer)
		if err != nil {
			return nil, "", err
		}
		reader := bytes.NewReader(buffer[:n])
		var header [4]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return nil, "", fmt.Errorf("invalid SOCKS5 UDP response header: %w", err)
		}
		if header[0] != 0 || header[1] != 0 {
			return nil, "", errors.New("SOCKS5 UDP response has an invalid reserved field")
		}
		if header[2] != 0 {
			return nil, "", errors.New("fragmented SOCKS5 UDP responses are not supported")
		}
		host, err := readSOCKS5Address(reader, header[3])
		if err != nil {
			return nil, "", err
		}
		var portBytes [2]byte
		if _, err := io.ReadFull(reader, portBytes[:]); err != nil {
			return nil, "", fmt.Errorf("invalid SOCKS5 UDP response port: %w", err)
		}
		port := int(binary.BigEndian.Uint16(portBytes[:]))
		if port != c.targetPort {
			continue
		}
		if c.targetIP != nil && !c.targetIP.Equal(net.ParseIP(host)) {
			if !strings.EqualFold(host, c.targetHost) || net.ParseIP(host) != nil {
				continue
			}
		}
		payload, err := io.ReadAll(reader)
		if err != nil {
			return nil, "", err
		}
		return payload, net.JoinHostPort(host, strconv.Itoa(port)), nil
	}
}

func (c *socks5DatagramChannel) SetReadDeadline(deadline time.Time) error {
	return c.conn.SetReadDeadline(deadline)
}

func (c *socks5DatagramChannel) LocalAddr() string  { return c.conn.LocalAddr().String() }
func (c *socks5DatagramChannel) RemoteAddr() string { return c.remote }

func (c *socks5DatagramChannel) Close() error {
	udpErr := c.conn.Close()
	controlErr := c.control.Close()
	if udpErr != nil {
		return udpErr
	}
	return controlErr
}

func (r *networkRoute) openUDPChannel(target networkTarget) (networkDatagramChannel, error) {
	if r.proxyType == "http" {
		return nil, networkTestError("networkTestTool.backend.udpProxyUnsupported")
	}
	if r.proxyType == "socks5" {
		return r.openSOCKS5UDPChannel(target)
	}
	addresses, err := r.resolve(target.Host)
	if err != nil {
		return nil, err
	}
	port, _ := strconv.Atoi(target.Port)
	var lastErr error
	for _, address := range addresses {
		remote := &net.UDPAddr{IP: address.IP, Zone: address.Zone, Port: port}
		local, err := r.localUDPAddress(address.IP)
		if err != nil {
			lastErr = err
			break
		}
		network := "udp6"
		if address.IP.To4() != nil {
			network = "udp4"
		}
		conn, err := net.DialUDP(network, local, remote)
		if err == nil {
			return &directDatagramChannel{conn: conn}, nil
		}
		lastErr = err
		if r.run.ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = networkTestError("networkTestTool.backend.noIPForTarget")
	}
	return nil, lastErr
}

func (r *networkRoute) openSOCKS5UDPChannel(target networkTarget) (networkDatagramChannel, error) {
	requestHead, targetIP, err := r.socks5UDPTarget(target)
	if err != nil {
		return nil, err
	}
	portNumber := mustPortNumber(target.Port)
	requestHead = append(requestHead, byte(portNumber>>8), byte(portNumber))
	proxyHost, proxyPort := r.proxyURL.Hostname(), r.proxyURL.Port()
	control, err := r.dialDirect(r.run.ctx, proxyHost, proxyPort)
	if err != nil {
		return nil, err
	}
	closeControl := true
	defer func() {
		if closeControl {
			_ = control.Close()
		}
	}()
	stopOnCancel := context.AfterFunc(r.run.ctx, func() { _ = control.Close() })
	defer stopOnCancel()
	if deadline, ok := r.run.ctx.Deadline(); ok {
		_ = control.SetDeadline(deadline)
	}
	r.stage("proxy-tunnel", "running", NetworkTestStage{Request: networkTestText("networkTestTool.backend.socks5UdpAssociateRequest", nil), Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort)}})
	if _, err := control.Write([]byte{5, 1, 0}); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	var greeting [2]byte
	if _, err := io.ReadFull(control, greeting[:]); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if greeting[0] != 5 || greeting[1] != 0 {
		err := errors.New("SOCKS5 proxy does not support unauthenticated connections")
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if _, err := control.Write([]byte{5, 3, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	var reply [4]byte
	if _, err := io.ReadFull(control, reply[:]); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if reply[0] != 5 || reply[1] != 0 || reply[2] != 0 {
		err := fmt.Errorf("SOCKS5 proxy rejected UDP ASSOCIATE (reply code %d)", reply[1])
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	boundHost, boundPort, err := readSOCKS5Endpoint(control, reply[3])
	if err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if boundPort == 0 {
		err := errors.New("SOCKS5 proxy returned an invalid UDP relay port")
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	if ip := net.ParseIP(boundHost); ip == nil {
		addresses, resolveErr := r.resolve(boundHost)
		if resolveErr != nil {
			r.fail("proxy-tunnel", resolveErr)
			return nil, resolveErr
		}
		boundHost = addresses[0].IP.String()
	} else if ip.IsUnspecified() {
		remote, ok := control.RemoteAddr().(*net.TCPAddr)
		if !ok {
			err := errors.New("SOCKS5 proxy returned an unspecified UDP relay address")
			r.fail("proxy-tunnel", err)
			return nil, err
		}
		boundHost = remote.IP.String()
	}
	relayIP := net.ParseIP(boundHost)
	if relayIP == nil {
		err := errors.New("SOCKS5 proxy returned an invalid UDP relay address")
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	relay := &net.UDPAddr{IP: relayIP, Port: boundPort}
	local, err := r.localUDPAddress(relayIP)
	if err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	network := "udp6"
	if relayIP.To4() != nil {
		network = "udp4"
	}
	udpConn, err := net.DialUDP(network, local, relay)
	if err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	closeControl = false
	r.stage("proxy-tunnel", "success", NetworkTestStage{Response: networkTestText("networkTestTool.backend.socks5UdpRelayEstablished", nil), Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort), "relay": relay.String(), "target": net.JoinHostPort(target.Host, target.Port), "targetResolution": r.targetResolution()}})
	return &socks5DatagramChannel{conn: udpConn, control: control, requestHead: requestHead, targetHost: target.Host, targetPort: mustPortNumber(target.Port), targetIP: targetIP, remote: net.JoinHostPort(target.Host, target.Port)}, nil
}

func (r *networkRoute) socks5UDPTarget(target networkTarget) ([]byte, net.IP, error) {
	if strings.EqualFold(r.request.DNSMode, "proxy") && net.ParseIP(target.Host) == nil {
		if len(target.Host) > 255 {
			return nil, nil, errors.New("SOCKS5 target host name is too long")
		}
		return append([]byte{0, 0, 0, 3, byte(len(target.Host))}, []byte(target.Host)...), nil, nil
	}
	addresses, err := r.resolve(target.Host)
	if err != nil {
		return nil, nil, err
	}
	ip := addresses[0].IP
	if ipv4 := ip.To4(); ipv4 != nil {
		return append([]byte{0, 0, 0, 1}, ipv4...), ip, nil
	}
	return append([]byte{0, 0, 0, 4}, ip.To16()...), ip, nil
}

func (r *networkRoute) localUDPAddress(remote net.IP) (*net.UDPAddr, error) {
	local, err := r.localAddress(remote)
	if err != nil || local == nil {
		return nil, err
	}
	address, ok := local.(*net.TCPAddr)
	if !ok {
		return nil, fmt.Errorf("unsupported local address type %T", local)
	}
	return &net.UDPAddr{IP: address.IP, Zone: address.Zone, Port: address.Port}, nil
}

func mustPortNumber(port string) int {
	number, _ := strconv.Atoi(port)
	return number
}

func readSOCKS5Address(reader io.Reader, atyp byte) (string, error) {
	switch atyp {
	case 1:
		var address [net.IPv4len]byte
		if _, err := io.ReadFull(reader, address[:]); err != nil {
			return "", err
		}
		return net.IP(address[:]).String(), nil
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(reader, length[:]); err != nil {
			return "", err
		}
		address := make([]byte, int(length[0]))
		if _, err := io.ReadFull(reader, address); err != nil {
			return "", err
		}
		return string(address), nil
	case 4:
		var address [net.IPv6len]byte
		if _, err := io.ReadFull(reader, address[:]); err != nil {
			return "", err
		}
		return net.IP(address[:]).String(), nil
	default:
		return "", fmt.Errorf("SOCKS5 returned unsupported address type %d", atyp)
	}
}

func readSOCKS5Endpoint(reader io.Reader, atyp byte) (string, int, error) {
	address, err := readSOCKS5Address(reader, atyp)
	if err != nil {
		return "", 0, fmt.Errorf("read SOCKS5 UDP relay address: %w", err)
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(reader, portBytes[:]); err != nil {
		return "", 0, fmt.Errorf("read SOCKS5 UDP relay port: %w", err)
	}
	return address, int(binary.BigEndian.Uint16(portBytes[:])), nil
}

func (r *networkRoute) targetResolution() string {
	if r.proxyType == "http" || (r.proxyType == "socks5" && strings.EqualFold(r.request.DNSMode, "proxy")) {
		return "proxy"
	}
	return "local"
}

func (r *networkRoute) proxyFunc(*http.Request) (*url.URL, error) {
	if r.proxyType == "http" {
		return r.proxyURL, nil
	}
	return nil, nil
}

func (r *networkTestRun) runHTTP(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("http", request.Target)
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
	for redirectCount := 0; ; redirectCount++ {
		requestID := networkRedirectStageID("http-request", redirectCount)
		responseID := networkRedirectStageID("http-response", redirectCount)
		req, err := http.NewRequest(http.MethodGet, currentURL.String(), nil)
		if err != nil {
			r.stage(requestID, "error", NetworkTestStage{Error: err.Error(), Meta: redirectMeta(redirectCount)})
			return err
		}
		req.Header.Set("User-Agent", "TinkerKit Network Test")
		requestTrace.set(requestID, req, route.targetResolution(), redirectCount)

		requestURL := *currentURL
		requestHost := requestURL.Hostname()
		requestPort := requestURL.Port()
		if requestPort == "" {
			if requestURL.Scheme == "https" {
				requestPort = "443"
			} else {
				requestPort = "80"
			}
		}
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
					r.fail(stageID, err)
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
				r.stage(stageID, "success", NetworkTestStage{Request: requestDump, Meta: meta})
				// 请求写完即进入等待响应：response 阶段必须从这里开始计时，否则等待期
				// 没有任何阶段覆盖（失败时只在末尾补出一个 0 毫秒的错误项），时间线会
				// 出现无法解释的空白。首个字节到达、读取完成或失败都沿用这个起始时间。
				r.stage(responseID, "running", NetworkTestStage{Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"phase": networkTestText("networkTestTool.backend.phaseWaitingForResponse", nil)})})
			},
			GotFirstResponseByte: func() {
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

func (r *networkTestRun) runWebSocket(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("websocket", request.Target)
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
	transport := &http.Transport{Proxy: route.proxyFunc, DialContext: route.dialContext, TLSClientConfig: networkTLSConfig(request.SkipTLSVerify), DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	requestTrace := newNetworkRequestTraceState("websocket-handshake")
	route.requestTrace = requestTrace
	client := &http.Client{
		Transport: &captureNetworkRoundTripper{base: transport, onRequest: func(req *http.Request) {
			requestTrace.setCurrent(req, route.targetResolution())
		}},
		CheckRedirect: networkRedirectPolicy(request.MaxRedirects, func(next *http.Request, redirectCount int) {
			stageID := networkRedirectStageID("websocket-handshake", redirectCount)
			requestTrace.set(stageID, next, route.targetResolution(), redirectCount)
			_, requestDump, meta := requestTrace.snapshot()
			r.stage(stageID, "running", NetworkTestStage{Request: requestDump, Meta: meta})
		}),
	}
	trace := &httptrace.ClientTrace{
		TLSHandshakeStart: func() {
			_, _, meta := requestTrace.snapshot()
			requestURL, _ := url.Parse(meta["url"])
			if requestURL == nil {
				requestURL = target.URL
			}
			if route.proxyType == "http" && (requestURL.Scheme == "https" || requestURL.Scheme == "wss") {
				port := requestURL.Port()
				if port == "" {
					port = "443"
				}
				route.stage("proxy-tunnel", "success", NetworkTestStage{Request: "CONNECT " + net.JoinHostPort(requestURL.Hostname(), port), Response: networkTestText("networkTestTool.backend.connectTunnelEstablished", nil), Meta: map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}})
			}
			route.stage("tls", "running", NetworkTestStage{Meta: map[string]string{"serverName": requestURL.Hostname()}})
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			if err != nil {
				route.fail("tls", err)
			} else {
				_, _, meta := requestTrace.snapshot()
				requestURL, _ := url.Parse(meta["url"])
				if requestURL == nil {
					requestURL = target.URL
				}
				route.stage("tls", "success", NetworkTestStage{Meta: map[string]string{"serverName": requestURL.Hostname(), "version": tls.VersionName(state.Version), "cipher": tls.CipherSuiteName(state.CipherSuite), "alpn": state.NegotiatedProtocol}})
			}
		},
		WroteHeaders: func() {
			stageID, requestDump, meta := requestTrace.snapshot()
			r.stage(stageID, "running", NetworkTestStage{Request: requestDump, Meta: meta})
		},
	}
	ctx := httptrace.WithClientTrace(r.ctx, trace)
	if route.proxyType == "http" && (target.URL.Scheme == "https" || target.URL.Scheme == "wss") {
		// 与 HTTP 一致：CONNECT 的等待期必须有自己的阶段。
		requestHost := target.URL.Hostname()
		requestPort := target.URL.Port()
		if requestPort == "" {
			requestPort = "443"
		}
		route.stage("proxy-tunnel", "running", NetworkTestStage{
			Request: "CONNECT " + net.JoinHostPort(requestHost, requestPort) + " HTTP/1.1\r\nHost: " + net.JoinHostPort(requestHost, requestPort) + "\r\n\r\n",
			Meta:    mergeStageMeta(redirectMeta(requestTrace.redirectCount()), map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}),
		})
	}
	conn, response, err := websocket.Dial(ctx, target.URL.String(), &websocket.DialOptions{HTTPClient: client})
	if response != nil {
		var body []byte
		if response.Body != nil {
			body, _ = readLimited(response.Body, 4096)
		}
		responseDump, _ := httpResponseSummary(response, body)
		status := response.StatusCode
		stageStatus := "error"
		if err == nil && status == http.StatusSwitchingProtocols {
			stageStatus = "success"
		}
		stageID, _, meta := requestTrace.snapshot()
		meta["status"] = response.Status
		r.stage(stageID, stageStatus, NetworkTestStage{Response: responseDump, StatusCode: status, Meta: meta})
		if response.Body != nil {
			_ = response.Body.Close()
		}
	}
	if err != nil {
		if route.proxyType == "http" && strings.Contains(strings.ToLower(err.Error()), "proxyconnect") {
			_, _, meta := requestTrace.snapshot()
			requestURL, _ := url.Parse(meta["url"])
			if requestURL == nil {
				requestURL = target.URL
			}
			if requestURL.Scheme == "https" || requestURL.Scheme == "wss" {
				redirectCount, _ := strconv.Atoi(meta["redirectCount"])
				r.fail(networkRedirectStageID("proxy-tunnel", redirectCount), err)
				return err
			}
		}
		stageID, _, meta := requestTrace.snapshot()
		redirectCount, _ := strconv.Atoi(meta["redirectCount"])
		current := r.currentStageForHop(stageID, redirectCount)
		r.fail(current, err)
		return err
	}
	_ = conn.Close(websocket.StatusNormalClosure, "network test complete")
	return nil
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
	describeRequest := formatRTSPRequest("DESCRIBE", describeURI, describeHeaders, describe.nextSeq-1)
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
		c.route.stage(baseStageID, "running", NetworkTestStage{Request: formatRTSPRequest(method, uri, headers, cseq), Meta: meta})
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
	response, err := c.session.exchange(method, uri, headers, cseq)
	if err != nil {
		return nil, cseq + 1, rtspExchangeError(c.run.ctx, method, err)
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
		Request: formatRTSPRequest(method, uri, map[string]string{"Authorization": "<credentials withheld>"}, cseq+1),
		Meta:    rtspAuthMeta(response, pictureURL, true),
	})
	retry, retryErr := c.session.exchange(method, uri, authenticated, cseq+1)
	if retryErr != nil {
		wrapped := rtspExchangeError(c.run.ctx, method, retryErr)
		c.route.fail("rtsp-auth", wrapped)
		return nil, cseq + 2, wrapped
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

// rtspExchangeError 把网络层错误翻译成可读结论。TCP 连接成功但服务端不回一个字节是
// 这类设备与中间盒最常见的表现：设备、VPN 或防火墙可能对任意端口都接受连接，而原始
// 的 "i/o timeout" 无法说明这一点。
func rtspExchangeError(ctx context.Context, method string, err error) error {
	var timeoutError interface{ Timeout() bool }
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded),
		errors.Is(err, context.DeadlineExceeded),
		errors.As(err, &timeoutError) && timeoutError.Timeout():
		return networkTestErrorParamsCause("networkTestTool.backend.rtspNoResponse", map[string]any{"method": method}, err)
	case errors.Is(ctx.Err(), context.Canceled):
		// 超时或取消时运行上下文会主动关闭连接，读操作可能返回 net.ErrClosed
		// （use of closed network connection）；结论应取自上下文而不是错误文本。
		return networkTestErrorParamsCause("networkTestTool.backend.rtspStoppedWhileWaiting", map[string]any{"method": method}, err)
	}
	var responseError *rtspResponseError
	if errors.As(err, &responseError) {
		if !responseError.received {
			return networkTestErrorParamsCause("networkTestTool.backend.rtspClosedWithoutResponse", map[string]any{"method": method}, err)
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return networkTestErrorParamsCause("networkTestTool.backend.rtspClosedMidResponse", map[string]any{"method": method}, err)
		}
	}
	return err
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
func (s *rtspSession) exchange(method, uri string, extraHeaders map[string]string, cseq int) (*rtspResponse, error) {
	if s.reader == nil {
		s.reader = bufio.NewReader(s.conn)
	}
	if _, err := io.WriteString(s.conn, formatRTSPRequest(method, uri, extraHeaders, cseq)); err != nil {
		return nil, err
	}
	return readRTSPResponse(s.reader)
}

// formatRTSPRequest 生成 RTSP 请求文本。URI 中的 CR/LF 会被移除，避免请求拆分。
func formatRTSPRequest(method, uri string, extraHeaders map[string]string, cseq int) string {
	var builder strings.Builder
	builder.WriteString(method + " " + strings.NewReplacer("\r", "", "\n", "").Replace(uri) + " RTSP/1.0\r\n")
	builder.WriteString("CSeq: " + strconv.Itoa(cseq) + "\r\n")
	builder.WriteString("User-Agent: TinkerKit Network Test\r\n")
	keys := make([]string, 0, len(extraHeaders))
	for key := range extraHeaders {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		builder.WriteString(key + ": " + strings.NewReplacer("\r", "", "\n", "").Replace(extraHeaders[key]) + "\r\n")
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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

// openRTSPStream 建立可以直接读写 RTSP 报文的连接：目标为 rtsps:// 时，在直连或 HTTP
// CONNECT 隧道之上再完成 TLS 握手。
func (r *networkRoute) openRTSPStream(ctx context.Context, target networkTarget) (net.Conn, error) {
	var conn net.Conn
	var err error
	if r.proxyType == "http" {
		conn, err = r.openHTTPCONNECTTunnel(ctx, target.Host, target.Port)
	} else {
		conn, err = r.dialContext(ctx, "tcp", net.JoinHostPort(target.Host, target.Port))
	}
	if err != nil {
		return nil, err
	}
	secure := target.URL != nil && strings.EqualFold(target.URL.Scheme, "rtsps")
	if !secure {
		return conn, nil
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = conn.Close()
		}
	}()
	stopOnCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopOnCancel()
	serverName := target.Host
	r.stage("tls", "running", NetworkTestStage{Meta: map[string]string{"serverName": serverName}})
	tlsConn := tls.Client(conn, networkTLSConfig(r.request.SkipTLSVerify))
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		r.fail("tls", err)
		return nil, err
	}
	state := tlsConn.ConnectionState()
	r.stage("tls", "success", NetworkTestStage{Meta: map[string]string{"serverName": serverName, "version": tls.VersionName(state.Version), "cipher": tls.CipherSuiteName(state.CipherSuite), "alpn": state.NegotiatedProtocol}})
	closeOnError = false
	return tlsConn, nil
}

// openHTTPCONNECTTunnel 通过 HTTP 代理申请到目标的 CONNECT 隧道，并保留 runTCP 原有的
// proxy-tunnel 阶段语义。返回的是隧道建立后的原始连接，是否需要 TLS 由调用方决定。
func (r *networkRoute) openHTTPCONNECTTunnel(ctx context.Context, host, port string) (net.Conn, error) {
	conn, err := r.dialDirect(ctx, r.proxyURL.Hostname(), r.proxyURL.Port())
	if err != nil {
		return nil, err
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = conn.Close()
		}
	}()
	stopOnCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopOnCancel()
	peer := net.JoinHostPort(host, port)
	r.stage("proxy-tunnel", "running", NetworkTestStage{Request: "CONNECT " + peer + " HTTP/1.1\r\nHost: " + peer + "\r\n\r\n", Meta: map[string]string{"proxy": r.proxyURL.Host}})
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Connection: Keep-Alive\r\n\r\n", peer, peer); err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		r.fail("proxy-tunnel", err)
		return nil, err
	}
	responseDump, _ := httpResponseSummary(response, nil)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		err := fmt.Errorf("HTTP proxy rejected CONNECT with status %s", response.Status)
		r.stage("proxy-tunnel", "error", NetworkTestStage{Response: responseDump, StatusCode: response.StatusCode, Error: err.Error()})
		return nil, err
	}
	r.stage("proxy-tunnel", "success", NetworkTestStage{Response: responseDump, StatusCode: response.StatusCode, Meta: map[string]string{"proxy": r.proxyURL.Host, "targetResolution": "proxy"}})
	closeOnError = false
	return conn, nil
}

func (r *networkTestRun) runTCP(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("tcp", request.Target)
	if err != nil {
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
	var conn net.Conn
	if route.proxyType == "http" {
		conn, err = route.openHTTPCONNECTTunnel(r.ctx, target.Host, target.Port)
	} else {
		conn, err = route.dialContext(r.ctx, "tcp", net.JoinHostPort(target.Host, target.Port))
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	return nil
}

func (r *networkTestRun) runUDP(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("udp", request.Target)
	if err != nil {
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	payload := []byte(request.Payload)
	if len(payload) == 0 {
		err := networkTestError("networkTestTool.backend.udpPayloadEmpty")
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	if len(payload) > 1200 {
		err := networkTestError("networkTestTool.backend.udpPayloadTooLarge")
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
	return r.exchangeDatagram(target, route, "udp-send", "udp-response",
		func() ([]byte, string, time.Time, error) {
			return payload, formatDatagramPayload(payload), time.Now(), nil
		},
		func(response []byte, _, _ time.Time) (string, map[string]string, error) {
			return formatDatagramPayload(response), map[string]string{"bytes": strconv.Itoa(len(response))}, nil
		},
	)
}

func (r *networkTestRun) runNTP(request NetworkTestRequest) error {
	target, err := parseNetworkTarget("ntp", request.Target)
	if err != nil {
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
	return r.exchangeDatagram(target, route, "ntp-request", "ntp-response",
		func() ([]byte, string, time.Time, error) {
			sentAt := time.Now()
			packet := makeNTPRequest(sentAt)
			return packet, networkTestText("networkTestTool.backend.ntpRequestSummary", map[string]any{"bytes": len(packet), "hex": hex.EncodeToString(packet)}), sentAt, nil
		},
		func(response []byte, sentAt, receivedAt time.Time) (string, map[string]string, error) {
			return parseNTPResponse(response, sentAt, receivedAt)
		},
	)
}

func (r *networkTestRun) exchangeDatagram(
	target networkTarget,
	route *networkRoute,
	requestStage string,
	responseStage string,
	makeRequest func() ([]byte, string, time.Time, error),
	parseResponse func([]byte, time.Time, time.Time) (string, map[string]string, error),
) error {
	channel, err := route.openUDPChannel(target)
	if err != nil {
		if r.currentStage(requestStage) == requestStage {
			r.fail(requestStage, err)
		}
		return err
	}
	defer channel.Close()
	stopOnCancel := context.AfterFunc(r.ctx, func() { _ = channel.Close() })
	defer stopOnCancel()

	requestMeta := map[string]string{
		"peer":             channel.RemoteAddr(),
		"localAddress":     channel.LocalAddr(),
		"interface":        route.interfaceName(),
		"transport":        "UDP",
		"targetResolution": route.targetResolution(),
	}
	var tunnelPath networkRouteInfo
	tunnel := false
	if remoteHost, _, err := net.SplitHostPort(channel.RemoteAddr()); err == nil {
		if remoteIP := net.ParseIP(remoteHost); remoteIP != nil {
			tunnelPath, tunnel = probeTunnelOutbound(r.ctx, remoteIP, channel.LocalAddr())
		}
	}
	if tunnel {
		requestMeta["outbound"] = "tunnel"
		requestMeta["reachability"] = "unverified"
		if tunnelPath.Interface != "" {
			requestMeta["tunnelInterface"] = tunnelPath.Interface
		}
		if tunnelPath.Gateway != "" {
			requestMeta["tunnelGateway"] = tunnelPath.Gateway
		}
	}
	r.stage(requestStage, "running", NetworkTestStage{Meta: requestMeta})
	payload, requestDump, sentAt, err := makeRequest()
	if err != nil {
		r.fail(requestStage, err)
		return err
	}
	if err := channel.Send(payload); err != nil {
		r.fail(requestStage, err)
		return err
	}
	requestSuccessMeta := cloneStringMap(requestMeta)
	requestSuccessMeta["bytes"] = strconv.Itoa(len(payload))
	requestSuccessMeta["delivery"] = networkTestText("networkTestTool.backend.datagramAccepted", nil)
	r.stage(requestStage, "success", NetworkTestStage{Request: requestDump, Meta: requestSuccessMeta})
	if tunnel {
		route.reportTunnelOutbound(channel.RemoteAddr(), channel.LocalAddr(), tunnelPath)
	}

	responseMeta := map[string]string{"peer": channel.RemoteAddr(), "transport": "UDP"}
	r.stage(responseStage, "running", NetworkTestStage{Meta: responseMeta})
	if deadline, ok := r.ctx.Deadline(); ok {
		if err := channel.SetReadDeadline(deadline); err != nil {
			r.fail(responseStage, err)
			return err
		}
	}
	response, source, err := channel.Receive()
	receivedAt := time.Now()
	if err != nil {
		var timeoutError interface{ Timeout() bool }
		if errors.Is(r.ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &timeoutError) && timeoutError.Timeout()) {
			err = networkTestErrorCause("networkTestTool.backend.udpNoReply", err)
		}
		r.fail(responseStage, err)
		return err
	}
	responseDump, parsedMeta, err := parseResponse(response, sentAt, receivedAt)
	if err != nil {
		responseErrorMeta := map[string]string{"source": source, "bytes": strconv.Itoa(len(response))}
		responseErrorMeta = mergeStageMeta(responseErrorMeta, parsedMeta)
		r.stage(responseStage, "error", NetworkTestStage{Response: formatDatagramPayload(response), Error: err.Error(), Meta: responseErrorMeta})
		return err
	}
	responseSuccessMeta := cloneStringMap(responseMeta)
	responseSuccessMeta["source"] = source
	responseSuccessMeta["bytes"] = strconv.Itoa(len(response))
	responseSuccessMeta = mergeStageMeta(responseSuccessMeta, parsedMeta)
	if !sentAt.IsZero() {
		responseSuccessMeta["roundTripTime"] = receivedAt.Sub(sentAt).String()
	}
	r.stage(responseStage, "success", NetworkTestStage{Response: responseDump, Meta: responseSuccessMeta})
	return nil
}

func cloneStringMap(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func formatDatagramPayload(payload []byte) string {
	const displayLimit = 4096
	shown := payload
	truncated := false
	if len(shown) > displayLimit {
		shown = shown[:displayLimit]
		truncated = true
	}
	text := strings.ToValidUTF8(string(shown), "�")
	if truncated {
		text += "\n[display truncated]"
	}
	return networkTestText("networkTestTool.backend.datagramPayload", map[string]any{"bytes": len(payload), "text": text, "hex": hex.EncodeToString(shown)})
}

const ntpEpochOffset = int64(2208988800)

func makeNTPRequest(sentAt time.Time) []byte {
	packet := make([]byte, 48)
	packet[0] = 4<<3 | 3 // NTP version 4, client mode.
	stamp := makeNTPTimestamp(sentAt)
	copy(packet[40:48], stamp[:])
	return packet
}

func makeNTPTimestamp(value time.Time) [8]byte {
	var stamp [8]byte
	seconds := uint32(value.Unix() + ntpEpochOffset)
	fraction := uint32((uint64(value.Nanosecond()) << 32) / 1_000_000_000)
	binary.BigEndian.PutUint32(stamp[0:4], seconds)
	binary.BigEndian.PutUint32(stamp[4:8], fraction)
	return stamp
}

func parseNTPTimestamp(stamp []byte, reference time.Time) (time.Time, error) {
	if len(stamp) < 8 {
		return time.Time{}, errors.New("NTP timestamp is incomplete")
	}
	seconds := int64(binary.BigEndian.Uint32(stamp[:4]))
	fraction := binary.BigEndian.Uint32(stamp[4:8])
	currentNTPSeconds := reference.Unix() + ntpEpochOffset
	currentEra := currentNTPSeconds >> 32
	bestUnixSeconds := int64(0)
	bestDistance := int64(^uint64(0) >> 1)
	for era := currentEra - 1; era <= currentEra+1; era++ {
		unixSeconds := (era << 32) + seconds - ntpEpochOffset
		distance := unixSeconds - reference.Unix()
		if distance < 0 {
			distance = -distance
		}
		if distance < bestDistance {
			bestUnixSeconds = unixSeconds
			bestDistance = distance
		}
	}
	nanoseconds := int64((uint64(fraction) * 1_000_000_000) >> 32)
	return time.Unix(bestUnixSeconds, nanoseconds).UTC(), nil
}

func parseNTPResponse(packet []byte, sentAt, receivedAt time.Time) (string, map[string]string, error) {
	if len(packet) < 48 {
		return "", nil, fmt.Errorf("NTP response is too short: expected at least 48 bytes, received %d", len(packet))
	}
	version := (packet[0] >> 3) & 7
	mode := packet[0] & 7
	if mode != 4 {
		return "", nil, fmt.Errorf("unexpected NTP response mode %d; expected server mode 4", mode)
	}
	if version < 3 || version > 4 {
		return "", nil, fmt.Errorf("unsupported NTP response version %d", version)
	}
	stratum := packet[1]
	referenceID := ntpReferenceID(packet[12:16])
	if stratum == 0 {
		return "", map[string]string{"referenceID": referenceID}, fmt.Errorf("NTP server returned a Kiss-o'-Death response: %s", referenceID)
	}
	if stratum > 15 {
		return "", nil, fmt.Errorf("invalid NTP stratum %d", stratum)
	}
	leapIndicator := packet[0] >> 6
	if leapIndicator == 3 {
		return "", map[string]string{"stratum": strconv.Itoa(int(stratum)), "referenceID": referenceID}, errors.New("NTP server reports that it is not synchronized")
	}
	expectedOrigin := makeNTPTimestamp(sentAt)
	if !equalBytes(packet[24:32], expectedOrigin[:]) {
		return "", nil, errors.New("NTP response origin timestamp does not match the request")
	}
	t1, err := parseNTPTimestamp(packet[24:32], receivedAt)
	if err != nil {
		return "", nil, err
	}
	t2, err := parseNTPTimestamp(packet[32:40], receivedAt)
	if err != nil {
		return "", nil, err
	}
	t3, err := parseNTPTimestamp(packet[40:48], receivedAt)
	if err != nil {
		return "", nil, err
	}
	t4 := receivedAt
	roundTripDelay := t4.Sub(t1) - t3.Sub(t2)
	clockOffset := (t2.Sub(t1) + t3.Sub(t4)) / 2
	referenceTime := "unknown"
	if !equalBytes(packet[16:24], make([]byte, 8)) {
		if value, err := parseNTPTimestamp(packet[16:24], receivedAt); err == nil {
			referenceTime = value.Format(time.RFC3339Nano)
		}
	}
	meta := map[string]string{
		"version":           strconv.Itoa(int(version)),
		"mode":              "server (4)",
		"leapIndicator":     strconv.Itoa(int(leapIndicator)),
		"stratum":           strconv.Itoa(int(stratum)),
		"pollExponent":      strconv.FormatInt(int64(int8(packet[2])), 10),
		"precisionExponent": strconv.FormatInt(int64(int8(packet[3])), 10),
		"referenceID":       referenceID,
		"referenceTime":     referenceTime,
		"clientSentAt":      t1.Format(time.RFC3339Nano),
		"serverReceivedAt":  t2.Format(time.RFC3339Nano),
		"serverSentAt":      t3.Format(time.RFC3339Nano),
		"clientReceivedAt":  t4.UTC().Format(time.RFC3339Nano),
		"roundTripDelay":    fmt.Sprintf("%.3f ms", float64(roundTripDelay)/float64(time.Millisecond)),
		"clockOffset":       fmt.Sprintf("%+.3f ms", float64(clockOffset)/float64(time.Millisecond)),
	}
	response := networkTestText("networkTestTool.backend.ntpResponseSummary", map[string]any{"version": version, "stratum": stratum, "delay": fmt.Sprintf("%.3f", float64(roundTripDelay)/float64(time.Millisecond)), "offset": fmt.Sprintf("%+.3f", float64(clockOffset)/float64(time.Millisecond)), "hex": hex.EncodeToString(packet)})
	return response, meta, nil
}

func ntpReferenceID(value []byte) string {
	printable := true
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			printable = false
			break
		}
	}
	if printable {
		return string(value)
	}
	return "0x" + hex.EncodeToString(value)
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}

func httpRequestSummary(request *http.Request) (string, error) {
	clone := request.Clone(request.Context())
	clone.Body = nil
	var builder strings.Builder
	if clone.URL != nil {
		builder.WriteString(clone.Method + " " + clone.URL.RequestURI() + " HTTP/1.1\r\n")
		builder.WriteString("Host: " + clone.URL.Host + "\r\n")
	}
	keys := make([]string, 0, len(clone.Header))
	for key := range clone.Header {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		values := clone.Header[key]
		for _, value := range values {
			builder.WriteString(key + ": " + value + "\r\n")
		}
	}
	builder.WriteString("\r\n")
	return builder.String(), nil
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
