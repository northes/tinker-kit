//go:build !darwin && !linux

package main

import "context"

// networkRouteLookup 在未实现的平台上不做查询；调用方会退回本地地址判断是否经隧道。
func networkRouteLookup(context.Context, string) (networkRouteInfo, bool) {
	return networkRouteInfo{}, false
}
