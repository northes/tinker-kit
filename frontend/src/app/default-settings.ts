import type { Config as Settings } from '../../bindings/tinkerkit/models';
import { DEFAULT_NTP_SERVERS, TIME_RESULT_IDS } from '../utils/time';

// 首帧占位配置：真实值由 Go ConfigService.GetConfig 提供（首次运行写的是
// configservice.go 的 defaultConfig），本文件不得成为第二个默认值来源。
//
// 约定：
// - 标量默认值与 Go defaultConfig 保持一致，加载完成前界面不应出现反向状态；
// - 工具独占的默认值（时间结果行、NTP 服务器等）从对应工具的模块导入，
//   不要在这里重新抄一份字面量；
// - 结构化占位（来源列表等）保留与 Go 相同的最小形态，展示层按 kind 走 i18n，
//   不依赖这里的 name。
export const defaultSettings: Settings = {
  trayMatchEnabled: true,
  trayMatchTools: ['json', 'time', 'text', 'base64', 'diff', 'jwt', 'url'],
  autoOverwrite: true,
  autoCheckUpdates: true,
  taskConcurrency: 4,
  taskChunkConcurrency: 4,
  taskNotificationMode: 'unfocused',
  language: 'zh-CN',
  sidebarMode: 'full',
  sidebarTools: [
    { id: 'json', enabled: true },
    { id: 'time', enabled: true },
    { id: 'text', enabled: true },
    { id: 'base64', enabled: true },
    { id: 'jwt', enabled: true },
    { id: 'url', enabled: true },
    { id: 'qrcode', enabled: true },
    { id: 'image', enabled: true },
    { id: 'diff', enabled: true },
    { id: 'text-generator', enabled: true },
    { id: 'image-manager', enabled: true },
    { id: 'ssh-files', enabled: true },
    { id: 'service-manager', enabled: true },
    { id: 'ports', enabled: true },
    { id: 'network-test', enabled: true },
  ],
  themeMode: 'dark',
  lightTheme: 'default-light',
  darkTheme: 'default-dark',
  diffClipboardTargetMode: 'alternate',
  codeEditorFontSize: 16,
  timeResultOrder: [...TIME_RESULT_IDS],
  hiddenTimeResults: [],
  timeWeekStart: 'monday',
  ntpServers: [...DEFAULT_NTP_SERVERS],
  networkTestSettings: {
    payload: 'ping',
    timeoutSeconds: 30,
    skipTLSVerify: false,
    maxRedirects: 10,
    method: 'GET',
    headers: '',
    body: '',
    hasBody: false,
    sourceID: 'local',
    // 空值表示使用工具默认的 User-Agent（TinkerKit Network Test）。
    userAgent: '',
    proxyType: '',
    proxyAddress: '',
    dnsMode: 'system',
    dnsAddress: '',
    interfaceName: '',
  },
  networkTestSources: [{ id: 'local', name: '本机', kind: 'local', sshProfileID: '' }],
  jsonAutoFormatOnFill: true,
  textAlwaysShowSearch: false,
  textGeneratorSources: [],
  dockerCLIPath: '',
  // 本地来源的 name 由 Go 端规范化为「本机」后持久化，这里保持同一形态；
  // 展示名一律走 lib/local-source 的 sourceLabel，不读 name。
  imageSources: [
    {
      id: 'local',
      name: '本机',
      kind: 'local',
      sshProfileID: '',
      registryURL: '',
      registryUsername: '',
      registryPassword: '',
    },
  ],
  sshProfiles: [],
  fileSources: [],
  serviceTargets: [{ id: 'local', name: '本机', kind: 'local', sshProfileID: '' }],
  portSources: [{ id: 'local', name: '本机', kind: 'local', sshProfileID: '' }],
  serviceLogHighlightLevels: true,
  serviceLogCollapseLines: 5,
  portForwards: [],
  portColumnWidths: { ports: {}, forwards: [] },
};
