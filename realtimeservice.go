package main

import (
	"encoding/binary"
	"errors"
	"net"
	"time"
)

const ntpUnixEpochOffset = 2208988800

type RealTimeService struct{}

func NewRealTimeService() *RealTimeService { return &RealTimeService{} }

// GetRealTime 查询多个公开 NTP 服务器，并返回按往返时延中点修正后的 Unix 毫秒。
func (s *RealTimeService) GetRealTime() (int64, error) {
	servers := []string{"time.cloudflare.com:123", "time.google.com:123", "pool.ntp.org:123"}
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
