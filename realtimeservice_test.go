package main

import (
	"reflect"
	"testing"
)

func TestNormalizeNtpServer(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{name: "hostname without port", input: "pool.ntp.org", want: "pool.ntp.org:123", ok: true},
		{name: "hostname with port", input: "pool.ntp.org:1234", want: "pool.ntp.org:1234", ok: true},
		{name: "already normalized", input: "time.cloudflare.com:123", want: "time.cloudflare.com:123", ok: true},
		{name: "surrounding spaces", input: "  ntp.aliyun.com  ", want: "ntp.aliyun.com:123", ok: true},
		{name: "ipv4", input: "10.0.0.1:123", want: "10.0.0.1:123", ok: true},
		{name: "bracketed ipv6 with port", input: "[2606:4700::1111]:123", want: "[2606:4700::1111]:123", ok: true},
		{name: "bracketed ipv6 without port", input: "[2606:4700::1111]", want: "[2606:4700::1111]:123", ok: true},
		{name: "empty", input: "   ", ok: false},
		{name: "internal space", input: "pool ntp.org", ok: false},
		{name: "non numeric port", input: "pool.ntp.org:abc", ok: false},
		{name: "port out of range", input: "pool.ntp.org:70000", ok: false},
		{name: "zero port", input: "pool.ntp.org:0", ok: false},
		{name: "unbracketed ipv6", input: "2606:4700::1111", ok: false},
		{name: "path", input: "pool.ntp.org/ntp", ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := normalizeNtpServer(tc.input)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("normalizeNtpServer(%q) = (%q, %v), want (%q, %v)", tc.input, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestNormalizeNtpServersDropsInvalidAndDedupes(t *testing.T) {
	got := normalizeNtpServers([]string{"pool.ntp.org", "pool.ntp.org:123", "bad host", "time.google.com:123"})
	want := []string{"pool.ntp.org:123", "time.google.com:123"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeNtpServers() = %#v, want %#v", got, want)
	}
}

func TestNormalizeNtpServersFallsBackToDefaults(t *testing.T) {
	for _, input := range [][]string{nil, {}, {"", "  "}, {"bad host", "::: "}} {
		if got := normalizeNtpServers(input); !reflect.DeepEqual(got, defaultNtpServers()) {
			t.Fatalf("normalizeNtpServers(%#v) = %#v, want defaults", input, got)
		}
	}
}

func TestNormalizeConfigRepairsNtpServers(t *testing.T) {
	cfg := normalizeConfig(Config{NtpServers: []string{"ntp.aliyun.com", "bad host"}})
	if !reflect.DeepEqual(cfg.NtpServers, []string{"ntp.aliyun.com:123"}) {
		t.Fatalf("normalizeConfig().NtpServers = %#v", cfg.NtpServers)
	}
	empty := normalizeConfig(Config{})
	if !reflect.DeepEqual(empty.NtpServers, defaultNtpServers()) {
		t.Fatalf("normalizeConfig() empty NtpServers = %#v, want defaults", empty.NtpServers)
	}
}
