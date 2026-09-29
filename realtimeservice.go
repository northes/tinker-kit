package main

import (
	"encoding/binary"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

const ntpUnixEpochOffset = 2208988800

const defaultNtpPort = 123

type RealTimeService struct{}

func NewRealTimeService() *RealTimeService { return &RealTimeService{} }

// defaultNtpServers 返回内置的默认 NTP 服务器。
func defaultNtpServers() []string {
	return []string{"time.cloudflare.com:123", "time.google.com:123", "pool.ntp.org:123"}
}

// validNtpHost 校验 NTP 主机名或 IP 字面量允许的字符；IPv6 的冒号与 zone 标识由本函数放行。
func validNtpHost(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '-', r == '_', r == ':', r == '%':
		default:
			return false
		}
	}
	return true
}

// normalizeNtpServer 校验并规范化单个 NTP 服务器地址；未写明端口时补默认端口 123。
// 非法地址返回 ok=false，调用方负责丢弃或回退默认值。
func normalizeNtpServer(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return "", false
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		switch {
		case strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]"):
			// 方括号 IPv6 但省略端口。
			host, port = value[1:len(value)-1], strconv.Itoa(defaultNtpPort)
		case strings.Contains(value, ":"):
			// 未加方括号的 IPv6 或多个冒号，无法判断主机与端口。
			return "", false
		default:
			// 纯主机名，补默认端口。
			host, port = value, strconv.Itoa(defaultNtpPort)
		}
	}
	if !validNtpHost(host) {
		return "", false
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", false
	}
	return net.JoinHostPort(host, strconv.Itoa(portNumber)), true
}

// normalizeNtpServers 规范化 NTP 服务器列表：丢弃非法项、按规范化结果去重并保持顺序；
// 结果为空时回退默认服务器，保证始终有可用服务器。
func normalizeNtpServers(servers []string) []string {
	result := make([]string, 0, len(servers))
	seen := make(map[string]struct{}, len(servers))
	for _, server := range servers {
		normalized, ok := normalizeNtpServer(server)
		if !ok {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	if len(result) == 0 {
		return defaultNtpServers()
	}
	return result
}

// GetRealTime 查询给定的 NTP 服务器，并返回按往返时延中点修正后的 Unix 毫秒。
// 服务器为空或全部非法时回退默认服务器；并行查询，任一成功即返回。
func (s *RealTimeService) GetRealTime(servers []string) (int64, error) {
	servers = normalizeNtpServers(servers)
	type result struct {
		nanos int64
		err   error
	}
	results := make(chan result, len(servers))
	for _, server := range servers {
		go func(server string) {
			nanos, err := queryNTP(server)
			results <- result{nanos: nanos, err: err}
		}(server)
	}
	var lastErr error
	for range servers {
		result := <-results
		if result.err == nil {
			return result.nanos / int64(time.Millisecond), nil
		}
		lastErr = result.err
	}
	return 0, lastErr
}

func queryNTP(server string) (int64, error) {
	conn, err := net.DialTimeout("udp", server, 2*time.Second)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return 0, err
	}
	request := make([]byte, 48)
	request[0] = 0x23 // LI 为 0、版本为 4，客户端模式。
	sent := time.Now()
	if _, err := conn.Write(request); err != nil {
		return 0, err
	}
	response := make([]byte, 48)
	if _, err := conn.Read(response); err != nil {
		return 0, err
	}
	received := time.Now()
	if len(response) < 48 || response[0]>>6 == 3 || response[0]&0x7 != 4 || response[1] == 0 {
		return 0, errors.New("invalid NTP response")
	}
	seconds := int64(binary.BigEndian.Uint32(response[40:44])) - ntpUnixEpochOffset
	fraction := int64(binary.BigEndian.Uint32(response[44:48]))
	serverNanos := seconds*int64(time.Second) + (fraction * int64(time.Second) >> 32)
	return serverNanos + received.Sub(sent).Nanoseconds()/2, nil
}
