package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
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
	mu      sync.Mutex
	stages  map[string]NetworkTestStage
	starts  map[string]time.Time
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
	r.stage(id, status, NetworkTestStage{Error: err.Error()})
}

func (r *networkTestRun) currentStage(fallback string) string {
	return r.currentStageForHop(fallback, 0)
}

func (r *networkTestRun) currentStageForHop(fallback string, redirectCount int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	stageID := func(id string) string { return networkRedirectStageID(id, redirectCount) }
	for _, baseID := range []string{"http-response", "websocket-handshake", "http-request", "ntp-response", "udp-response", "ntp-request", "udp-send", "tls", "proxy-tunnel", "tcp-connect", "dns-target", "dns-proxy", "proxy-resolve"} {
		id := stageID(baseID)
		stage, ok := r.stages[id]
		if ok && stage.Status == "running" {
			return id
		}
	}
	for _, baseID := range []string{"proxy-resolve", "dns-target", "dns-proxy", "tcp-connect", "proxy-tunnel", "tls", "http-request", "websocket-handshake", "http-response", "udp-send", "udp-response", "ntp-request", "ntp-response"} {
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
		request.TimeoutMillis = 10000
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

	run := &networkTestRun{service: s, runID: request.RunID, ctx: ctx, stages: make(map[string]NetworkTestStage), starts: make(map[string]time.Time)}
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
	default:
		err = errors.New("unsupported network test protocol")
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
		result.Error = err.Error()
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
}

func parseNetworkTarget(protocol, raw string) (networkTarget, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return networkTarget{}, errors.New("target address is required")
	}
	if strings.ContainsAny(raw, "\r\n\x00") {
		return networkTarget{}, errors.New("target address contains invalid characters")
	}
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
		if protocol == "websocket" {
			scheme = "wss"
		} else {
			scheme = "http"
		}
		raw = scheme + "://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return networkTarget{}, errors.New("target must be a valid URL without embedded credentials")
	}
	switch protocol {
	case "http":
		if u.Scheme != "http" && u.Scheme != "https" {
			return networkTarget{}, errors.New("HTTP target must use http:// or https://")
		}
	case "websocket":
		if u.Scheme != "ws" && u.Scheme != "wss" {
			return networkTarget{}, errors.New("WebSocket target must use ws:// or wss://")
		}
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" || u.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return networkTarget{URL: u, Host: u.Hostname(), Port: port}, nil
}

type networkRoute struct {
	run          *networkTestRun
	request      NetworkTestRequest
	proxyType    string
	proxyURL     *url.URL
	resolver     *net.Resolver
	dnsServer    string
	iface        *net.Interface
	requestTrace *networkRequestTraceState
}

func (r *networkRoute) stage(id, status string, fields NetworkTestStage) {
	redirectCount := 0
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
	redirectCount := 0
	if r.requestTrace != nil {
		redirectCount = r.requestTrace.redirectCount()
	}
	id = networkRedirectStageID(id, redirectCount)
	r.run.fail(id, err)
}

func newNetworkRoute(run *networkTestRun, request NetworkTestRequest) (*networkRoute, error) {
	route := &networkRoute{run: run, request: request, proxyType: strings.ToLower(strings.TrimSpace(request.ProxyType))}
	if (strings.EqualFold(strings.TrimSpace(request.Protocol), "udp") || strings.EqualFold(strings.TrimSpace(request.Protocol), "ntp")) && route.proxyType == "http" {
		return nil, errors.New("UDP and NTP require a direct route or a SOCKS5 proxy with UDP ASSOCIATE; HTTP CONNECT does not relay UDP datagrams")
	}
	if route.proxyType != "" && route.proxyType != "http" && route.proxyType != "socks5" && route.proxyType != "system" {
		return nil, errors.New("proxy type must be system, HTTP CONNECT, or SOCKS5")
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
			return nil, errors.New("proxy address must be a host and port without credentials")
		}
		if proxyURL.Port() == "" {
			return nil, errors.New("proxy address must include a port")
		}
		if route.proxyType == "http" && proxyURL.Scheme != "http" {
			return nil, errors.New("HTTP proxy address must use http://")
		}
		if route.proxyType == "socks5" && proxyURL.Scheme != "socks5" {
			return nil, errors.New("SOCKS5 proxy address must use socks5://")
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
			return nil, errors.New("custom DNS server must be an IP address, optionally followed by :port")
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
			return nil, fmt.Errorf("network interface %q is unavailable: %w", name, err)
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
	return nil, fmt.Errorf("network interface %q has no address for the target IP family", r.iface.Name)
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
			localAddress := "automatic"
			if local != nil {
				localAddress = local.String()
			}
			stage := NetworkTestStage{Meta: map[string]string{"peer": net.JoinHostPort(host, port), "remoteAddress": conn.RemoteAddr().String(), "localAddress": localAddress, "interface": r.interfaceName()}}
			if r.request.Protocol == "tcp" {
				stage.Request = "TCP connect only; no application payload sent"
			}
			r.stage("tcp-connect", "success", stage)
			return conn, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no IP address was available for the target")
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
	r.stage("proxy-tunnel", "running", NetworkTestStage{Request: "SOCKS5: no-auth CONNECT", Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort), "targetResolution": r.targetResolution()}})
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
	r.stage("proxy-tunnel", "success", NetworkTestStage{Response: "SOCKS5: tunnel established", Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort), "target": net.JoinHostPort(targetHost, targetPort), "targetResolution": r.targetResolution()}})
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
		return nil, errors.New("UDP and NTP do not support HTTP CONNECT proxy; use SOCKS5 UDP ASSOCIATE or connect directly")
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
		lastErr = errors.New("no IP address was available for the UDP target")
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
	r.stage("proxy-tunnel", "running", NetworkTestStage{Request: "SOCKS5: no-auth UDP ASSOCIATE", Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort)}})
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
	r.stage("proxy-tunnel", "success", NetworkTestStage{Response: "SOCKS5 UDP relay established", Meta: map[string]string{"proxy": net.JoinHostPort(proxyHost, proxyPort), "relay": relay.String(), "target": net.JoinHostPort(target.Host, target.Port), "targetResolution": r.targetResolution()}})
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
					route.stage("proxy-tunnel", "success", NetworkTestStage{Request: "CONNECT " + net.JoinHostPort(requestHost, requestPort), Response: "HTTP CONNECT tunnel established", Meta: map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}})
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
			},
			GotFirstResponseByte: func() {
				r.stage(responseID, "running", NetworkTestStage{Meta: mergeStageMeta(redirectMeta(redirectCount), map[string]string{"firstByteAt": strconv.FormatInt(time.Now().UnixMilli(), 10)})})
			},
		}
		req = req.WithContext(httptrace.WithClientTrace(r.ctx, trace))
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
				route.stage("proxy-tunnel", "success", NetworkTestStage{Request: "CONNECT " + net.JoinHostPort(requestURL.Hostname(), port), Response: "HTTP CONNECT tunnel established", Meta: map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}})
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
		return fmt.Errorf("redirect limit must be between 0 and %d", maxNetworkRedirects)
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
	if route.proxyType == "http" {
		conn, err := route.dialDirect(r.ctx, route.proxyURL.Hostname(), route.proxyURL.Port())
		if err != nil {
			return err
		}
		defer conn.Close()
		stopOnCancel := context.AfterFunc(r.ctx, func() { _ = conn.Close() })
		defer stopOnCancel()
		r.stage("proxy-tunnel", "running", NetworkTestStage{Request: "CONNECT " + net.JoinHostPort(target.Host, target.Port) + " HTTP/1.1\r\nHost: " + net.JoinHostPort(target.Host, target.Port) + "\r\n\r\n", Meta: map[string]string{"proxy": route.proxyURL.Host}})
		if deadline, ok := r.ctx.Deadline(); ok {
			_ = conn.SetDeadline(deadline)
		}
		_, writeErr := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Connection: Keep-Alive\r\n\r\n", net.JoinHostPort(target.Host, target.Port), net.JoinHostPort(target.Host, target.Port))
		if writeErr != nil {
			r.fail("proxy-tunnel", writeErr)
			return writeErr
		}
		response, readErr := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
		if readErr != nil {
			r.fail("proxy-tunnel", readErr)
			return readErr
		}
		responseDump, _ := httpResponseSummary(response, nil)
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			err := fmt.Errorf("HTTP proxy rejected CONNECT with status %s", response.Status)
			r.stage("proxy-tunnel", "error", NetworkTestStage{Response: responseDump, StatusCode: response.StatusCode, Error: err.Error()})
			return err
		}
		r.stage("proxy-tunnel", "success", NetworkTestStage{Response: responseDump, StatusCode: response.StatusCode, Meta: map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}})
		return nil
	}
	conn, err := route.dialContext(r.ctx, "tcp", net.JoinHostPort(target.Host, target.Port))
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
		err := errors.New("UDP payload must not be empty")
		r.stage("validate", "error", NetworkTestStage{Error: err.Error()})
		return err
	}
	if len(payload) > 1200 {
		err := errors.New("UDP payload must be 1200 bytes or less to avoid IP fragmentation")
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
			return packet, fmt.Sprintf("NTPv4 client request (mode 3, %d bytes)\nhex: %s", len(packet), hex.EncodeToString(packet)), sentAt, nil
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
	requestSuccessMeta["delivery"] = "datagram accepted by the local network stack; this does not confirm remote delivery"
	r.stage(requestStage, "success", NetworkTestStage{Request: requestDump, Meta: requestSuccessMeta})

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
			err = fmt.Errorf("no UDP response was received before the timeout; because UDP does not guarantee a reply, this alone does not prove that the target is unreachable: %w", err)
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
	return fmt.Sprintf("%d bytes\nUTF-8:\n%s\n\nhex:\n%s", len(payload), text, hex.EncodeToString(shown))
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
	response := fmt.Sprintf("NTPv%d server response · stratum %d · delay %.3f ms · offset %+.3f ms\nhex: %s", version, stratum, float64(roundTripDelay)/float64(time.Millisecond), float64(clockOffset)/float64(time.Millisecond), hex.EncodeToString(packet))
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
