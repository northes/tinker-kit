package main

import (
	"context"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// sshChainHop 是连接链中的一跳：首跳直接拨号，后续跳经上一跳的 TCP 转发到达。
type sshChainHop struct {
	name    string
	address string
	config  *ssh.ClientConfig
}

// chainedSSHConn 承载下游连接；承认归属后关闭它会一并释放上游跳板机连接。
// 主机指纹重试会先建立后丢弃连接，因此只有确认握手成功的一跳才接管上游。
type chainedSSHConn struct {
	net.Conn
	upstream *ssh.Client
	owned    bool
}

func (c *chainedSSHConn) Close() error {
	err := c.Conn.Close()
	if c.owned {
		c.owned = false
		closeSSHClient(c.upstream)
	}
	return err
}

// dialSSHChain 依次认证连接链上的每台主机，返回最后一段客户端。
// 关闭最后一段客户端会级联释放全部跳板机连接；任一跳失败都会关闭已建立的上游。
func dialSSHChain(ctx context.Context, hops []sshChainHop) (client *ssh.Client, err error) {
	if len(hops) == 0 {
		return nil, userError("errors.sshProfile.jumpNotFound")
	}
	var upstream *ssh.Client
	defer func() {
		if err != nil {
			closeSSHClient(upstream)
		}
	}()
	dial := sshLocalDialer
	for index, hop := range hops {
		last := index == len(hops)-1
		var finalConn *chainedSSHConn
		if upstream != nil {
			jump := upstream
			dial = func(ctx context.Context, address string) (net.Conn, error) {
				conn, dialErr := jump.DialContext(ctx, "tcp", address)
				if dialErr != nil {
					return nil, dialErr
				}
				wrapped := &chainedSSHConn{Conn: conn, upstream: jump}
				if last {
					// 只有最后一段才接管上游：主机指纹重试会丢弃失败连接，
					// 中间跳的失败不能提前断开跳板机。
					finalConn = wrapped
				}
				return wrapped, nil
			}
		}
		hopClient, hopErr := dialSSHClientVia(ctx, dial, hop.address, hop.config)
		if hopErr != nil {
			if last {
				return nil, hopErr
			}
			return nil, userErrorParamsCause("errors.ssh.jumpConnectFailed", map[string]any{"name": hopName(hop)}, hopErr)
		}
		upstream = hopClient
		if finalConn != nil {
			finalConn.owned = true
		}
	}
	return upstream, nil
}

func hopName(hop sshChainHop) string {
	if hop.name != "" {
		return hop.name
	}
	return hop.address
}

// sshJumpConnections 沿 JumpProfileID 展开 target 的跳板机链，顺序为
// [最外层跳板机 ... 最近一跳]。悬空引用与循环引用都会返回用户可见错误。
func sshJumpConnections(profiles []SSHProfile, target SSHConnection) ([]SSHConnection, error) {
	byID := make(map[string]SSHProfile, len(profiles))
	for _, profile := range profiles {
		if profile.ID != "" {
			byID[profile.ID] = profile
		}
	}
	visited := make(map[string]struct{}, 2)
	if target.ID != "" {
		visited[target.ID] = struct{}{}
	}
	jumps := make([]SSHConnection, 0, 2)
	current := target
	for current.JumpProfileID != "" {
		if _, seen := visited[current.JumpProfileID]; seen {
			return nil, userErrorParams("errors.sshProfile.jumpCycle", map[string]any{"name": connectionName(current)})
		}
		profile, ok := byID[current.JumpProfileID]
		if !ok {
			return nil, userErrorParams("errors.sshProfile.jumpNotFound", map[string]any{"name": connectionName(current)})
		}
		visited[profile.ID] = struct{}{}
		conn := sshProfileToConnection(profile)
		jumps = append(jumps, conn)
		current = conn
	}
	// 展开顺序是 最近一跳 → 最外层，拨号顺序需要反过来。
	for left, right := 0, len(jumps)-1; left < right; left, right = left+1, right-1 {
		jumps[left], jumps[right] = jumps[right], jumps[left]
	}
	return jumps, nil
}

func connectionName(conn SSHConnection) string {
	if conn.Name != "" {
		return conn.Name
	}
	if conn.ID != "" {
		return conn.ID
	}
	return conn.Host
}

// sshConnectionHop 用一条连接配置生成一跳的握手参数。
func sshConnectionHop(conn SSHConnection, callback ssh.HostKeyCallback, timeout time.Duration) (sshChainHop, error) {
	auth, err := sshAuthMethodsForConnection(conn)
	if err != nil {
		return sshChainHop{}, err
	}
	port := conn.Port
	if port == 0 {
		port = 22
	}
	host := strings.TrimPrefix(strings.TrimSuffix(conn.Host, "]"), "[")
	return sshChainHop{
		name:    conn.Name,
		address: net.JoinHostPort(host, strconv.Itoa(port)),
		config:  &ssh.ClientConfig{User: conn.Username, Auth: auth, HostKeyCallback: callback, Timeout: timeout},
	}, nil
}

// sshJumpHops 把跳板机链展开成可以直接拨号的前置跳。
func sshJumpHops(jumps []SSHConnection, callback ssh.HostKeyCallback, timeout time.Duration) ([]sshChainHop, error) {
	hops := make([]sshChainHop, 0, len(jumps)+1)
	for _, jump := range jumps {
		hop, err := sshConnectionHop(jump, callback, timeout)
		if err != nil {
			return nil, err
		}
		hops = append(hops, hop)
	}
	return hops, nil
}

// sshConnectionChainHops 按 profiles 展开 target 的跳板机链，并附上 target 自身这一跳。
func sshConnectionChainHops(profiles []SSHProfile, target SSHConnection, callback ssh.HostKeyCallback) ([]sshChainHop, error) {
	jumps, err := sshJumpConnections(profiles, target)
	if err != nil {
		return nil, err
	}
	hops, err := sshJumpHops(jumps, callback, 15*time.Second)
	if err != nil {
		return nil, err
	}
	targetHop, err := sshConnectionHop(target, callback, 15*time.Second)
	if err != nil {
		return nil, err
	}
	return append(hops, targetHop), nil
}
