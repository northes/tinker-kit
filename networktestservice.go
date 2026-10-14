package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const networkTestEvent = "network-test:update"

type NetworkInterface struct {
	Name      string   `json:"name"`
	Index     int      `json:"index"`
	Addresses []string `json:"addresses"`
}

// defaultNetworkTestUserAgent 是用户没有自定义 User-Agent 时发送的标识。
const defaultNetworkTestUserAgent = "TinkerKit Network Test"

type NetworkTestRequest struct {
	RunID         string `json:"runID"`
	Protocol      string `json:"protocol"`
	Target        string `json:"target"`
	Payload       string `json:"payload"`
	Method        string `json:"method"`
	Headers       string `json:"headers"`
	Body          string `json:"body"`
	HasBody       bool   `json:"hasBody"`
	SourceID      string `json:"sourceID"`
	UserAgent     string `json:"userAgent"`
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
	config   *ConfigService
}

func NewNetworkTestService(config ...*ConfigService) *NetworkTestService {
	service := &NetworkTestService{cancels: make(map[string]context.CancelFunc)}
	if len(config) > 0 {
		service.config = config[0]
	}
	return service
}

func (s *NetworkTestService) resolveNetworkTestSource(sourceID string) (NetworkTestSource, *SSHProfile, error) {
	sourceID = strings.TrimSpace(sourceID)
	if sourceID == "" || sourceID == "local" {
		return defaultNetworkTestSources()[0], nil, nil
	}
	if s == nil || s.config == nil {
		return NetworkTestSource{}, nil, networkTestError("networkTestTool.backend.sourceMissing")
	}
	var source NetworkTestSource
	found := false
	for _, candidate := range s.config.GetNetworkTestSources() {
		if candidate.ID == sourceID {
			source = candidate
			found = true
			break
		}
	}
	if !found || source.Kind != "ssh" {
		return NetworkTestSource{}, nil, networkTestError("networkTestTool.backend.sourceMissing")
	}
	for _, profile := range s.config.GetSSHProfiles() {
		if profile.ID == source.SSHProfileID {
			return source, &profile, nil
		}
	}
	return source, nil, networkTestError("networkTestTool.backend.sourceProfileMissing")
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
	source  NetworkTestSource
	profile *SSHProfile
	mu      sync.Mutex
	stages  map[string]NetworkTestStage
	starts  map[string]time.Time
	// proxyHint 缓存「直连失败时用于提示的系统代理地址」，每次运行最多查询一次。
	proxyHint       string
	proxyHintLoaded bool
	// secureEndpointReported 记录是否已给出「该端口只接受加密连接」的结论：原因确定后不再把
	// 「可改用系统代理」这类通用建议叠加到同一句话里。
	secureEndpointReported bool
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
	phase := fields.Meta["phase"]
	fields.Meta = mergeStageMeta(previous.Meta, fields.Meta)
	// phase 只描述当前正在进行的操作；后续更新与终态不能继承旧的等待提示。
	if status != "running" || phase == "" {
		delete(fields.Meta, "phase")
	}
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
	for _, baseID := range []string{"rtsp-describe", "http-response", "websocket-handshake", "http-request", "ntp-response", "udp-response", "ntp-request", "udp-send", "rtsp-auth", "rtsp-options", "tls", "proxy-tunnel", "ssh-forward", "ssh-connect", "tcp-connect", "dns-target", "dns-proxy", "proxy-resolve"} {
		id := stageID(baseID)
		stage, ok := r.stages[id]
		if ok && stage.Status == "running" {
			return id
		}
	}
	for _, baseID := range []string{"proxy-resolve", "dns-target", "dns-proxy", "tcp-connect", "ssh-connect", "ssh-forward", "proxy-tunnel", "tls", "http-request", "websocket-handshake", "http-response", "rtsp-options", "rtsp-auth", "rtsp-describe", "udp-send", "udp-response", "ntp-request", "ntp-response"} {
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

// explainSilentFailure 在「请求已发出、响应一个字节都没收到」时探测该端口是否只接受加密连接。
// 确认后返回「该端口只接受加密连接」的结论与 true；明文 scheme 没有加密版本、或探测拿不到证据
// 时返回 false，由调用方沿用原结论。
func (r *networkTestRun) explainSilentFailure(route *networkRoute, target networkTarget, cause error) (error, bool) {
	// 运行期限已经用完或用户已经取消时不再探测：探测只补充结论，不能让失败结论继续等待，也不能
	// 把运行状态从「失败」改成「超时」。
	if r.ctx.Err() != nil {
		return cause, false
	}
	// 剩余时间不足时同样跳过：连接加握手需要一个往返，抢在期限前沿用最后几毫秒拿不到证据。
	// （等待类失败正好落在期限上，这一步同时避免了「期限与读超时几乎同时到期」的边界抖动。）
	if deadline, ok := r.ctx.Deadline(); ok && time.Until(deadline) < minimalSecureEndpointProbeBudget {
		return cause, false
	}
	probe, found := route.probeSecureEndpoint(r.ctx, target.URL, target.Port, r.userAgent())
	if !found {
		return cause, false
	}
	r.secureEndpointReported = true
	return secureEndpointError(target, probe, cause), true
}

// composeFailureHint 在「本次直连 + 失败属于连接被丢下 + 本机配置了系统代理」时，把提示合成进
// 同一条本地化结论；阶段错误与页脚结论共用它，因此两处文案完全一致。
func (r *networkTestRun) composeFailureHint(err error) error {
	if err == nil || r.source.Kind == "ssh" || r.secureEndpointReported || strings.TrimSpace(r.request.ProxyType) != "" || !isConnectionLevelFailure(err) {
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
	run.source, run.profile, err = s.resolveNetworkTestSource(request.SourceID)
	if err != nil {
		run.stage("validate", "error", NetworkTestStage{Error: err.Error()})
	} else if run.source.Kind == "ssh" && !strings.EqualFold(strings.TrimSpace(request.Protocol), "http") {
		err = networkTestError("networkTestTool.backend.sshProtocolUnsupported")
		run.stage("validate", "error", NetworkTestStage{Error: err.Error()})
	} else {
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

// userAgent 返回本次运行使用的 User-Agent：用户没设置时用 TinkerKit 默认值。HTTP、WebSocket 与
// RTSP 都用它；TCP、UDP、NTP 不发送这个头部。
func (r *networkTestRun) userAgent() string {
	agent := sanitizeHeaderValue(strings.TrimSpace(r.request.UserAgent))
	if agent == "" {
		return defaultNetworkTestUserAgent
	}
	return agent
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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
	conn, err := route.openStream(r.ctx, target.Host, target.Port)
	if err != nil {
		return err
	}
	defer conn.Close()
	return nil
}
