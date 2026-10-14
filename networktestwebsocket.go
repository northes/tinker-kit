package main

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"

	"github.com/coder/websocket"
)

// websocketURL 把 WebSocket 拨号使用的 http(s) URL 还原成用户实际使用的 ws(s) URL：WebSocket
// 的结论要建议的是 wss://，而不是拨号器内部的 http:// 形式。
func websocketURL(u *url.URL) *url.URL {
	restored := *u
	switch strings.ToLower(u.Scheme) {
	case "http":
		restored.Scheme = "ws"
	case "https":
		restored.Scheme = "wss"
	}
	return &restored
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
	// 请求是否真的发出去了、响应是否有过一个字节：判断「对端没有任何反应」要用这两个事实。
	requestWritten := false
	responseByteSeen := false
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
					port = defaultPortForScheme(requestURL.Scheme)
				}
				route.stage("proxy-tunnel", "success", NetworkTestStage{Request: "CONNECT " + net.JoinHostPort(requestURL.Hostname(), port), Response: networkTestText("networkTestTool.backend.connectTunnelEstablished", nil), Meta: map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}})
			}
			route.stage("tls", "running", NetworkTestStage{Meta: map[string]string{"serverName": requestURL.Hostname()}})
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			if err != nil {
				route.fail("tls", tlsHandshakeFailure(err))
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
			requestWritten = true
			r.stage(stageID, "running", NetworkTestStage{Request: requestDump, Meta: meta})
		},
		GotFirstResponseByte: func() {
			responseByteSeen = true
		},
	}
	ctx := httptrace.WithClientTrace(r.ctx, trace)
	if route.proxyType == "http" && (target.URL.Scheme == "https" || target.URL.Scheme == "wss") {
		// 与 HTTP 一致：CONNECT 的等待期必须有自己的阶段。
		requestHost := target.URL.Hostname()
		requestPort := target.URL.Port()
		if requestPort == "" {
			requestPort = defaultPortForScheme(target.URL.Scheme)
		}
		route.stage("proxy-tunnel", "running", NetworkTestStage{
			Request: "CONNECT " + net.JoinHostPort(requestHost, requestPort) + " HTTP/1.1\r\nHost: " + net.JoinHostPort(requestHost, requestPort) + "\r\n\r\n",
			Meta:    mergeStageMeta(redirectMeta(requestTrace.redirectCount()), map[string]string{"proxy": route.proxyURL.Host, "targetResolution": "proxy"}),
		})
	}
	conn, response, err := websocket.Dial(ctx, target.URL.String(), &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"User-Agent": []string{r.userAgent()}},
	})
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
		err = tlsHandshakeFailure(err)
		if response == nil && requestWritten && !responseByteSeen {
			// 握手请求已发出、响应一个字节都没回来：先确认该端口是否只接受加密连接。
			requestURL, _ := url.Parse(meta["url"])
			if requestURL == nil {
				requestURL = target.URL
			}
			if verdict, found := r.explainSilentFailure(route, targetFromURL(websocketURL(requestURL)), err); found {
				err = verdict
			}
		}
		r.fail(current, err)
		return err
	}
	_ = conn.Close(websocket.StatusNormalClosure, "network test complete")
	return nil
}
