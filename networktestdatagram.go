package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

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

func (c *directDatagramChannel) LocalAddr() string { return c.conn.LocalAddr().String() }

func (c *directDatagramChannel) RemoteAddr() string { return c.conn.RemoteAddr().String() }

func (c *directDatagramChannel) Close() error { return c.conn.Close() }

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

func (c *socks5DatagramChannel) LocalAddr() string { return c.conn.LocalAddr().String() }

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
