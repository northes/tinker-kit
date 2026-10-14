package main

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

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
		port = defaultPortForScheme(u.Scheme)
	}
	return networkTarget{URL: u, Host: u.Hostname(), Port: port, creds: credentials}, nil
}

// defaultPortForScheme 返回 scheme 的默认端口，供解析目标与重定向后的地址共用。
func defaultPortForScheme(scheme string) string {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "https", "wss":
		return "443"
	case "rtsp":
		return "554"
	case "rtsps":
		return "322"
	default:
		return "80"
	}
}

// targetFromURL 把当前生效的 URL 还原成探测与结论需要的目标：端口显式化，结论里给出的可替换
// 地址才不会丢掉设备实际监听的端口。
func targetFromURL(u *url.URL) networkTarget {
	target := networkTarget{Host: u.Hostname(), Port: u.Port()}
	if target.Port == "" {
		target.Port = defaultPortForScheme(u.Scheme)
	}
	clean := *u
	clean.User = nil
	target.URL = &clean
	return target
}
