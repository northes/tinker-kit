package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

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
	remoteDial   func(context.Context, string, string) (net.Conn, error)
	closeRemote  func()
	// silent 在探测连接期间为 true：探测不是用户请求的链路，不能写链路阶段。
	silent bool
}

func (r *networkRoute) stage(id, status string, fields NetworkTestStage) {
	if r.silent {
		return
	}
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
	if err == nil || r.silent {
		return
	}
	redirectCount := r.hop
	if r.requestTrace != nil {
		redirectCount = r.requestTrace.redirectCount()
	}
	id = networkRedirectStageID(id, redirectCount)
	r.run.fail(id, err)
}

// quietly 在探测期间暂停链路阶段上报：探测连接与用户请求不是同一条链路，写进去会覆盖真实链路
// 的 tcp-connect、tunnel-route 与 proxy-tunnel 阶段。
func (r *networkRoute) quietly(action func() error) error {
	previous := r.silent
	r.silent = true
	defer func() { r.silent = previous }()
	return action()
}

// openStream 建立到目标的明文连接：HTTP 代理走 CONNECT 隧道，直连与 SOCKS5 走 dialContext。
func (r *networkRoute) openStream(ctx context.Context, host, port string) (net.Conn, error) {
	if r.proxyType == "http" {
		return r.openHTTPCONNECTTunnel(ctx, host, port)
	}
	return r.dialContext(ctx, "tcp", net.JoinHostPort(host, port))
}

func (r *networkRoute) close() {
	if r.closeRemote != nil {
		r.closeRemote()
	}
}

func newNetworkRoute(run *networkTestRun, request NetworkTestRequest) (*networkRoute, error) {
	if run.source.Kind == "ssh" {
		return newSSHNetworkRoute(run, request)
	}
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

func newSSHNetworkRoute(run *networkTestRun, request NetworkTestRequest) (*networkRoute, error) {
	if run.profile == nil {
		return nil, networkTestError("networkTestTool.backend.sourceProfileMissing")
	}
	route := &networkRoute{run: run, request: request}
	meta := map[string]string{"source": run.source.Name, "host": run.profile.Host, "outbound": "ssh"}
	route.stage("ssh-connect", "running", NetworkTestStage{Meta: meta})
	language := "zh-CN"
	if run.service != nil && run.service.config != nil {
		language = run.service.config.Get().Language
	}
	client, err := dialSSHProfileClient(run.ctx, *run.profile, language)
	if err != nil {
		failure := userErrorCause("networkTestTool.backend.sshConnectFailed", err)
		route.fail("ssh-connect", failure)
		return nil, failure
	}
	route.stage("ssh-connect", "success", NetworkTestStage{Meta: meta})
	route.closeRemote = func() { closeSSHClient(client) }
	route.remoteDial = func(ctx context.Context, network, address string) (net.Conn, error) {
		resolver := "ssh-remote"
		if host, _, err := net.SplitHostPort(address); err == nil && net.ParseIP(strings.Trim(host, "[]")) != nil {
			resolver = "literal"
		}
		stageMeta := map[string]string{
			"target":             address,
			"source":             run.source.Name,
			"resolver":           resolver,
			"resolverType":       resolver,
			"targetResolution":   "ssh-remote",
			"outbound":           "ssh",
			"reachability":       "unverified",
			"remoteSSHHost":      run.profile.Host,
			"remoteRouteAddress": address,
		}
		route.stage("ssh-forward", "running", NetworkTestStage{Request: network + " " + address, Meta: stageMeta})
		conn, err := client.DialContext(ctx, network, address)
		if err != nil {
			failure := networkTestErrorParamsCause("networkTestTool.backend.sshForwardFailed", map[string]any{"target": address}, err)
			route.fail("ssh-forward", failure)
			return nil, failure
		}
		stageMeta["remoteAddress"] = conn.RemoteAddr().String()
		route.stage("ssh-forward", "success", NetworkTestStage{Request: network + " " + address, Meta: stageMeta})
		return conn, nil
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
	if r.remoteDial != nil {
		return r.remoteDial(ctx, network, address)
	}
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
	if r.remoteDial != nil {
		return "ssh-remote"
	}
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

// openRTSPStream 建立可以直接读写 RTSP 报文的连接：目标为 rtsps:// 时，在直连或 HTTP
// CONNECT 隧道之上再完成 TLS 握手。
func (r *networkRoute) openRTSPStream(ctx context.Context, target networkTarget) (net.Conn, error) {
	conn, err := r.openStream(ctx, target.Host, target.Port)
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
	tlsConn := tls.Client(conn, clientTLSConfig(serverName, r.request.SkipTLSVerify))
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		failure := tlsHandshakeFailure(err)
		r.fail("tls", failure)
		return nil, failure
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
