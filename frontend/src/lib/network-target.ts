// 网络测试工具的目标地址规则：协议自动识别与目标补全。
// 纯函数放在这里，便于用 node --experimental-strip-types 直接单测。

export type NetworkTestProtocol = 'http' | 'tcp' | 'websocket' | 'udp' | 'ntp' | 'rtsp';

export function explicitHostPort(value: string) {
  if (/[/?#]/.test(value)) return null;
  try {
    const parsed = new URL(`tcp://${value}`);
    if (!parsed.hostname || !parsed.port || parsed.username || parsed.password) {
      return null;
    }
    const port = Number(parsed.port);
    return port >= 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export function detectTargetProtocol(value: string): NetworkTestProtocol | null {
  const target = value.trim();
  if (!target) return null;

  if (target.includes('://')) {
    try {
      const parsed = new URL(target);
      if (!parsed.hostname) return null;
      const scheme = parsed.protocol.toLowerCase();
      // RTSP 允许在 URL 内嵌凭据（探测时会用它们应答 Digest/Basic 挑战）；
      // 其余协议不在 URL 内传凭据，带凭据视为无法识别。
      if (scheme === 'rtsp:' || scheme === 'rtsps:') return 'rtsp';
      if (parsed.username || parsed.password) return null;
      switch (scheme) {
        case 'http:':
        case 'https:':
          return 'http';
        case 'ws:':
        case 'wss:':
          return 'websocket';
        case 'tcp:':
          return explicitHostPort(target.slice(target.indexOf('://') + 3)) ? 'tcp' : null;
        case 'udp:':
          return explicitHostPort(target.slice(target.indexOf('://') + 3)) ? 'udp' : null;
        case 'ntp:':
          return !/[/?#]/.test(target.slice(target.indexOf('://') + 3)) ? 'ntp' : null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  const port = explicitHostPort(target);
  if (port === 0 || target.endsWith(':')) return null;
  if (port === 554 || port === 8554) return 'rtsp';
  if (port === 123) return 'ntp';
  if (port === 53) return 'udp';
  if (
    port === 80 ||
    port === 443 ||
    port === 8000 ||
    port === 8080 ||
    port === 8443 ||
    port === 8888
  )
    return 'http';
  if (port !== null) return 'tcp';

  try {
    const parsed = new URL(`http://${target}`);
    if (parsed.hostname && !parsed.username && !parsed.password) return 'http';
  } catch {
    return null;
  }
  return null;
}

export function automaticTarget(value: string, protocol: NetworkTestProtocol) {
  const target = value.trim();
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase();
  if (scheme && ['tcp', 'udp', 'ntp'].includes(scheme))
    return target.slice(target.indexOf('://') + 3);
  if (scheme) return target;
  const port = explicitHostPort(target);
  if (protocol === 'http' && (port === 443 || port === 8443)) return `https://${target}`;
  if (protocol === 'rtsp') {
    if (port === 322 || port === 3222) return `rtsps://${target}`;
    // 手动选择 RTSP 且只填了 host:port 时补全 rtsp:// 前缀，与后端补全规则一致。
    if (port === null) return `rtsp://${target}`;
  }
  return target;
}
