package main

import (
	"context"
	"net"
	"strings"
)

// networkRouteInfo 是本机到某个目标地址的下一跳信息，由各平台的路由查询填充。
type networkRouteInfo struct {
	Interface string
	Gateway   string
}

// tunnelInterfacePrefixes 是常见隧道接口前缀：utun/tun/tap 是 VPN 与代理 TUN，wg 是
// WireGuard，ppp/ipsec 是拨号与 IPsec，tailscale 是 Tailscale。
var tunnelInterfacePrefixes = []string{"utun", "tun", "tap", "wg", "ppp", "ipsec", "tailscale"}

// tunnelLocalNetworks 是无法识别接口名时用于兜底的本地地址网段。198.18.0.0/15 是
// RFC 2544 基准测试段，代理类工具的 TUN 模式普遍用它作为本机地址。
var tunnelLocalNetworks = []string{"198.18.0.0/15"}

// isTunnelOutbound 判断本机是否把目标交给隧道接口转发。接口名可信度最高；路由查询不可用
// 时（例如系统缺少命令）退回本地地址网段判断。
func isTunnelOutbound(interfaceName, localAddress string) bool {
	normalized := strings.ToLower(strings.TrimSpace(interfaceName))
	for _, prefix := range tunnelInterfacePrefixes {
		if strings.HasPrefix(normalized, prefix) {
			return true
		}
	}
	host := localAddress
	if parsedHost, _, err := net.SplitHostPort(localAddress); err == nil {
		host = parsedHost
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	for _, cidr := range tunnelLocalNetworks {
		if _, network, err := net.ParseCIDR(cidr); err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// probeTunnelOutbound 查询本机到目标地址的出口并判断是否为隧道。路由查询失败时仍会用
// 本地地址兜底判断，因此调用方总能得到「是否经隧道」的结论。
func probeTunnelOutbound(ctx context.Context, destination net.IP, localAddress string) (networkRouteInfo, bool) {
	var info networkRouteInfo
	if destination != nil {
		info, _ = networkRouteLookup(ctx, destination.String())
	}
	return info, isTunnelOutbound(info.Interface, localAddress)
}

// reportTunnelOutbound 把「经隧道出口」作为独立阶段列出。每条经隧道的连接都有自己的
// 一项：跟随重定向会重建连接，路线阶段按跳次加后缀，因此第二跳不会覆盖或缺失说明。
func (r *networkRoute) reportTunnelOutbound(peer, localAddress string, info networkRouteInfo) {
	meta := map[string]string{
		"outbound":     "tunnel",
		"reachability": "unverified",
		"peer":         peer,
	}
	// 键名与连接阶段（tcp-connect / udp-send）保持一致，便于界面统一识别隧道出口。
	if info.Interface != "" {
		meta["tunnelInterface"] = info.Interface
	}
	if info.Gateway != "" {
		meta["tunnelGateway"] = info.Gateway
	}
	if localAddress != "" {
		meta["localAddress"] = localAddress
	}
	switch {
	case info.Interface != "" && info.Gateway != "":
		r.stage(tunnelRouteStageID, "success", NetworkTestStage{
			Response: networkTestText("networkTestTool.backend.tunnelOutbound", map[string]any{"peer": peer, "interface": info.Interface, "gateway": info.Gateway}),
			Meta:     meta,
		})
	case info.Interface != "":
		r.stage(tunnelRouteStageID, "success", NetworkTestStage{
			Response: networkTestText("networkTestTool.backend.tunnelOutboundNoGateway", map[string]any{"peer": peer, "interface": info.Interface}),
			Meta:     meta,
		})
	default:
		r.stage(tunnelRouteStageID, "success", NetworkTestStage{
			Response: networkTestText("networkTestTool.backend.tunnelOutboundNoRoute", map[string]any{"peer": peer}),
			Meta:     meta,
		})
	}
}
