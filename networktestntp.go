package main

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"
)

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
