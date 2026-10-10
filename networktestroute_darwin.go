//go:build darwin

package main

import (
	"context"
	"os/exec"
	"strings"
)

// networkRouteLookup 用 /sbin/route -n get 查询本机到目标地址的出口接口与网关。
func networkRouteLookup(ctx context.Context, address string) (networkRouteInfo, bool) {
	output, err := exec.CommandContext(ctx, "/sbin/route", "-n", "get", address).Output()
	if err != nil {
		return networkRouteInfo{}, false
	}
	info := networkRouteInfo{}
	for _, line := range strings.Split(string(output), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "gateway":
			info.Gateway = strings.TrimSpace(value)
		case "interface":
			info.Interface = strings.TrimSpace(value)
		}
	}
	return info, info.Interface != ""
}
