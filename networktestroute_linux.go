//go:build linux

package main

import (
	"context"
	"os/exec"
	"strings"
)

// networkRouteLookup 用 ip route get 查询本机到目标地址的出口接口与网关。
func networkRouteLookup(ctx context.Context, address string) (networkRouteInfo, bool) {
	output, err := exec.CommandContext(ctx, "ip", "route", "get", address).Output()
	if err != nil {
		return networkRouteInfo{}, false
	}
	fields := strings.Fields(string(output))
	info := networkRouteInfo{}
	for index, field := range fields {
		if index+1 >= len(fields) {
			break
		}
		switch field {
		case "dev":
			info.Interface = fields[index+1]
		case "via":
			info.Gateway = fields[index+1]
		}
	}
	return info, info.Interface != ""
}
