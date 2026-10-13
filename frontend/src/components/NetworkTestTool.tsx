import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Events } from '@wailsio/runtime';
import { ArrowClockwise, Code, GearSix, Network, Stop } from '@phosphor-icons/react';
import type {
  NetworkInterface,
  NetworkTestSettings,
  NetworkTestSource,
  NetworkTestRequest,
  NetworkTestResult,
  NetworkTestStage as BackendNetworkTestStage,
} from '../../bindings/changeme/models';
import {
  CancelNetworkTest,
  ListNetworkInterfaces,
  RunNetworkTest,
} from '../../bindings/changeme/networktestservice';
import {
  GetNetworkTestSettings,
  GetNetworkTestSources,
  SaveNetworkTestSettings,
  SaveNetworkTestSources,
} from '../../bindings/changeme/configservice';
import { formatBackendError } from '../lib/backend-error';
import {
  automaticTarget,
  detectTargetProtocol,
  type NetworkTestProtocol,
} from '../lib/network-target';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import {
  Reveal,
  ToolActionBar,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
  type PendingAction,
  type ToolId,
} from './shared';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { toast } from './ui/toast';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import { SSHProfileFormField } from './SSHProfileFormField';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { parseCurlCommand, CurlCommandParseError } from '../lib/curl-command';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  presetUserAgent,
  selectedUserAgent,
  userAgentPresets,
  userAgentSelectionFor,
  USER_AGENT_CUSTOM_SELECTION as USER_AGENT_CUSTOM,
  USER_AGENT_DEFAULT_SELECTION as USER_AGENT_DEFAULT,
} from '../lib/network-test-user-agent';

type Protocol = NetworkTestProtocol;
type ProtocolSelection = Protocol | 'auto';
type ProxyType = '' | 'http' | 'socks5' | 'system';
type DNSMode = 'system' | 'custom' | 'proxy';
type NetworkTestStage = BackendNetworkTestStage;
type NetworkTestUpdate = { runID: string; stage: NetworkTestStage };
type DisplayResult = Omit<NetworkTestResult, 'stages'> & { stages: NetworkTestStage[] };
type NetworkTestOptions = Omit<NetworkTestSettings, 'timeoutSeconds' | 'maxRedirects'> & {
  timeoutSeconds: string;
  maxRedirects: string;
};
const defaultNetworkTestSettings: NetworkTestSettings = {
  payload: 'ping',
  timeoutSeconds: 30,
  skipTLSVerify: false,
  maxRedirects: 10,
  method: 'GET',
  headers: '',
  body: '',
  hasBody: false,
  sourceID: 'local',
  // 空值表示使用工具默认的 User-Agent（TinkerKit Network Test）；见后端 userAgent()。
  userAgent: '',
  proxyType: '',
  proxyAddress: '',
  dnsMode: 'system',
  dnsAddress: '',
  interfaceName: '',
};
const defaultNetworkTestSources: NetworkTestSource[] = [
  { id: 'local', name: '本机', kind: 'local', sshProfileID: '' },
];
const defaultNetworkTestOptions: NetworkTestOptions = {
  ...defaultNetworkTestSettings,
  timeoutSeconds: String(defaultNetworkTestSettings.timeoutSeconds),
  maxRedirects: String(defaultNetworkTestSettings.maxRedirects),
};

const protocolItems = [
  { value: 'http', labelKey: 'networkTestTool.protocol.http' },
  { value: 'tcp', labelKey: 'networkTestTool.protocol.tcp' },
  { value: 'websocket', labelKey: 'networkTestTool.protocol.websocket' },
  { value: 'udp', labelKey: 'networkTestTool.protocol.udp' },
  { value: 'ntp', labelKey: 'networkTestTool.protocol.ntp' },
  { value: 'rtsp', labelKey: 'networkTestTool.protocol.rtsp' },
] as const;
const stageOrder = [
  'validate',
  'proxy-resolve',
  'ssh-connect',
  'ssh-forward',
  'dns-proxy',
  'dns-target',
  'tcp-connect',
  'tunnel-route',
  'proxy-tunnel',
  'rtsp-options',
  'rtsp-auth',
  'rtsp-describe',
  'udp-send',
  'udp-response',
  'ntp-request',
  'ntp-response',
  'tls',
  'http-request',
  'websocket-handshake',
  'http-response',
  'tls-probe',
];
const NO_PROXY = '__network-test-no-proxy__';
const MANAGE_NETWORK_SOURCES = '__manage-network-test-sources__';
const AUTOMATIC_INTERFACE = '__network-test-automatic-interface__';
const HTTP_METHOD_PRESETS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function validIntegerInput(value: string, min: number, max: number) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function toPersistedNetworkTestSettings(
  options: NetworkTestOptions,
  fallback: NetworkTestSettings,
): NetworkTestSettings {
  return {
    payload: options.payload,
    timeoutSeconds: validIntegerInput(options.timeoutSeconds, 1, 300) ?? fallback.timeoutSeconds,
    skipTLSVerify: options.skipTLSVerify,
    maxRedirects: validIntegerInput(options.maxRedirects, 0, 10) ?? fallback.maxRedirects,
    method: options.method,
    headers: options.headers,
    body: options.body,
    hasBody: options.hasBody,
    sourceID: options.sourceID || 'local',
    userAgent: options.userAgent.trim(),
    proxyType: options.proxyType,
    proxyAddress: options.proxyAddress,
    dnsMode: options.dnsMode,
    dnsAddress: options.dnsAddress,
    interfaceName: options.interfaceName,
  };
}

function stageSortValue(stage: NetworkTestStage) {
  const redirectCount = Number(/-redirect-(\d+)$/.exec(stage.id)?.[1] ?? 0);
  const baseID = stage.id.replace(/-redirect-\d+$/, '');
  const index = stageOrder.indexOf(baseID);
  return {
    redirectCount,
    index: index < 0 ? stageOrder.length : index,
    startedAt: stage.startedAt,
  };
}

function httpResponseTone(statusCode: number) {
  if (statusCode >= 200 && statusCode < 300)
    return { text: 'text-emerald-500', bar: 'bg-emerald-500' };
  if (statusCode >= 500 && statusCode < 600)
    return { text: 'text-destructive', bar: 'bg-destructive' };
  return { text: 'text-warning', bar: 'bg-warning' };
}

// 带状态码的阶段取色：HTTP 响应阶段按状态码；RTSP 请求阶段的 3xx 是服务端要求的绕行，
// 用警示色表示，失败状态仍保留错误色。
function stageResponseTone(stageLabelID: string, status: string, statusCode: number) {
  if (statusCode <= 0) return null;
  if (stageLabelID === 'http-response') return httpResponseTone(statusCode);
  if ((stageLabelID === 'rtsp-options' || stageLabelID === 'rtsp-describe') && status !== 'error')
    return httpResponseTone(statusCode);
  return null;
}

function sortedStages(stages: NetworkTestStage[]) {
  return [...stages].sort((a, b) => {
    const aOrder = stageSortValue(a);
    const bOrder = stageSortValue(b);
    return (
      aOrder.redirectCount - bOrder.redirectCount ||
      aOrder.index - bOrder.index ||
      aOrder.startedAt - bOrder.startedAt
    );
  });
}

function parseHistoryValue<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// 阶段行的说明文字可能长于行宽：横向可滚、不显示滚动条、两端按实际溢出量渐隐，不再截断成省略号。
// 这里不复用 ScrollArea：它会固定给内容加 4px 内边距（为边缘控件的焦点环预留），而用负 margin 抵消
// 会把文字压到裁切边缘并让左端出现假渐隐；这些提示行本身没有可聚焦控件，用 .no-scrollbar 隐藏滚动条
// 即可（与浮层、命令面板内部滚动同一做法）。完整内容同时保留在 title 与阶段详情里。
function StageHintLine({ text, className }: { text: string; className: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const sync = () => {
      element.style.setProperty('--scroll-area-overflow-x-start', `${element.scrollLeft}px`);
      element.style.setProperty(
        '--scroll-area-overflow-x-end',
        `${element.scrollWidth - element.clientWidth - element.scrollLeft}px`,
      );
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    element.addEventListener('scroll', sync, { passive: true });
    sync();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', sync);
    };
  }, [text]);
  return (
    <div
      ref={scrollerRef}
      className={`no-scrollbar scroll-fade-x overflow-x-auto overflow-y-hidden whitespace-nowrap ${className}`}
      title={text}
    >
      {text}
    </div>
  );
}

export default function NetworkTestTool({
  active,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  record: (
    tool: ToolId,
    action: string,
    detail: string,
    input: string,
    output?: string,
    meta?: { mode?: string; mediaType?: string; name?: string; bytes?: number },
  ) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const { profiles } = useSSHProfiles();
  const [protocolSelection, setProtocolSelection] = useState<ProtocolSelection>('auto');
  const [target, setTarget] = useState('');
  const [networkTestSources, setNetworkTestSources] = useState(defaultNetworkTestSources);
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false);
  const [savingSources, setSavingSources] = useState(false);
  const [requestSettingsOpen, setRequestSettingsOpen] = useState(false);
  const [curlCommand, setCurlCommand] = useState('');
  // User-Agent 下拉的当前选项：它不由保存值推导（「自定义」且内容为空时无法与默认区分），
  // 而是在加载设置与恢复历史时用 userAgentSelectionFor 同步一次。
  const [userAgentSelection, setUserAgentSelection] = useState<string>(USER_AGENT_DEFAULT);
  const [networkSettings, setNetworkSettings] =
    useState<NetworkTestOptions>(defaultNetworkTestOptions);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [stages, setStages] = useState<NetworkTestStage[]>([]);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [running, setRunning] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [testStartedAt, setTestStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const activeRunID = useRef('');
  const stageMap = useRef(new Map<string, NetworkTestStage>());
  const settingsRef = useRef(networkSettings);
  const persistedSettingsRef = useRef(defaultNetworkTestSettings);
  const settingsLoadStarted = useRef(false);
  const settingsReady = useRef(false);
  const settingsTouched = useRef(false);
  const settingsNeedSave = useRef(false);
  const pendingSettingsSave = useRef<NetworkTestSettings | null>(null);
  const settingsSaveRunning = useRef(false);
  const flushSettingsSave = () => {
    if (!settingsReady.current || settingsSaveRunning.current || !pendingSettingsSave.current)
      return;
    settingsSaveRunning.current = true;
    void (async () => {
      while (pendingSettingsSave.current) {
        const snapshot = pendingSettingsSave.current;
        pendingSettingsSave.current = null;
        try {
          await SaveNetworkTestSettings(snapshot);
        } catch (error) {
          console.error('保存网络测试设置失败', error);
        }
      }
      settingsSaveRunning.current = false;
      if (pendingSettingsSave.current) flushSettingsSave();
    })();
  };
  const updateNetworkSettings = (patch: Partial<NetworkTestOptions>, persist = true) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setNetworkSettings(next);
    settingsTouched.current = true;
    if (!persist) return;
    settingsNeedSave.current = true;
    const saved = toPersistedNetworkTestSettings(next, persistedSettingsRef.current);
    persistedSettingsRef.current = saved;
    pendingSettingsSave.current = saved;
    flushSettingsSave();
  };
  const {
    payload,
    timeoutSeconds,
    skipTLSVerify,
    maxRedirects,
    method,
    headers,
    body,
    hasBody,
    sourceID,
    userAgent,
    proxyType,
    proxyAddress,
    dnsMode,
    dnsAddress,
    interfaceName,
  } = networkSettings;
  const httpResponseStages = result
    ? sortedStages(result.stages).filter(
        (stage) =>
          stage.id.replace(/-redirect-\d+$/, '') === 'http-response' && stage.statusCode > 0,
      )
    : [];
  const lastHTTPResponseStatus = httpResponseStages[httpResponseStages.length - 1]?.statusCode;
  const footerHTTPResponseTone =
    lastHTTPResponseStatus !== undefined ? httpResponseTone(lastHTTPResponseStatus) : null;

  const interfaceItems = useMemo(
    () => [
      { value: AUTOMATIC_INTERFACE, label: t('networkTestTool.interface.automatic') },
      ...interfaces.map((item) => ({
        value: item.name,
        label: `${item.name}${item.addresses?.length ? ` · ${item.addresses.join(', ')}` : ''}`,
      })),
    ],
    [interfaces, t],
  );
  const proxyItems = useMemo(
    () => [
      { value: NO_PROXY, label: t('networkTestTool.proxy.none') },
      { value: 'system', label: t('networkTestTool.proxy.system') },
      { value: 'http', label: t('networkTestTool.proxy.http') },
      { value: 'socks5', label: t('networkTestTool.proxy.socks5') },
    ],
    [t],
  );
  const userAgentItems = useMemo(
    () => [
      { value: USER_AGENT_DEFAULT, label: t('networkTestTool.userAgent.option.default') },
      ...userAgentPresets.map((preset) => ({
        value: preset.id,
        label: t(preset.labelKey, { version: preset.version }),
      })),
      { value: USER_AGENT_CUSTOM, label: t('networkTestTool.userAgent.option.custom') },
    ],
    [t],
  );
  const dnsItems = useMemo(
    () => [
      { value: 'system', label: t('networkTestTool.dns.system') },
      { value: 'custom', label: t('networkTestTool.dns.custom') },
      ...(proxyType === 'socks5' || proxyType === 'system'
        ? [{ value: 'proxy', label: t('networkTestTool.dns.proxy') }]
        : []),
    ],
    [proxyType, t],
  );
  const detectedProtocol = detectTargetProtocol(target);
  const effectiveProtocol = protocolSelection === 'auto' ? detectedProtocol : protocolSelection;
  const selectedSource =
    networkTestSources.find((source) => source.id === sourceID) ?? defaultNetworkTestSources[0];
  const remoteSourceSelected = selectedSource.kind === 'ssh';
  const selectedSourceProfileMissing =
    remoteSourceSelected && !profiles.some((profile) => profile.id === selectedSource.sshProfileID);
  const unsupportedRemoteProtocol =
    remoteSourceSelected && effectiveProtocol !== null && effectiveProtocol !== 'http';
  const sourceLabel = useCallback(
    (source: NetworkTestSource) =>
      source.id === 'local'
        ? t('networkTestTool.source.local')
        : `${source.name}${
            source.kind === 'ssh' && !profiles.some((profile) => profile.id === source.sshProfileID)
              ? ` · ${t('networkTestTool.source.profileMissing')}`
              : ''
          }`,
    [profiles, t],
  );
  const sourceItems = useMemo(
    () => [
      ...networkTestSources.map((source) => ({
        value: source.id,
        label: sourceLabel(source),
      })),
      { value: MANAGE_NETWORK_SOURCES, label: t('networkTestTool.source.manage') },
    ],
    [networkTestSources, sourceLabel],
  );
  // 高级选项全部展示、不按协议过滤：字段是否生效只影响校验，不影响可见性。
  const supportsRedirectSettings =
    effectiveProtocol === 'http' ||
    effectiveProtocol === 'websocket' ||
    effectiveProtocol === 'rtsp';
  const redirectLimit = Number(maxRedirects);
  // 实际发送的 User-Agent：预设用生成的串，「自定义」用输入框文本，空值表示工具默认（后端填）。
  const effectiveUserAgent = selectedUserAgent(userAgentSelection, userAgent);
  const invalidRedirectLimit =
    supportsRedirectSettings &&
    (!maxRedirects.trim() ||
      !Number.isInteger(redirectLimit) ||
      redirectLimit < 0 ||
      redirectLimit > 10);
  const protocolOptions = [
    {
      value: 'auto',
      label: target.trim()
        ? t('networkTestTool.protocol.auto', {
            protocol: detectedProtocol
              ? t(`networkTestTool.protocol.${detectedProtocol}`)
              : t('networkTestTool.protocol.unrecognized'),
          })
        : t('networkTestTool.protocol.autoDefault'),
    },
    ...protocolItems.map((item) => ({
      value: item.value,
      label: t(item.labelKey),
    })),
  ];

  useEffect(() => {
    if (!active || settingsLoadStarted.current) return;
    settingsLoadStarted.current = true;
    void Promise.all([
      GetNetworkTestSettings(),
      GetNetworkTestSources().catch(() => defaultNetworkTestSources),
    ])
      .then(([savedSettings, savedSources]) => {
        const sources = savedSources?.length ? savedSources : defaultNetworkTestSources;
        setNetworkTestSources(sources);
        const storedSourceID = savedSettings?.sourceID || 'local';
        const sourceID = sources.some((source) => source.id === storedSourceID)
          ? storedSourceID
          : 'local';
        const saved = { ...defaultNetworkTestSettings, ...savedSettings, sourceID };
        persistedSettingsRef.current = saved;
        if (!settingsTouched.current) {
          const loadedOptions: NetworkTestOptions = {
            ...saved,
            timeoutSeconds: String(saved.timeoutSeconds),
            maxRedirects: String(saved.maxRedirects),
          };
          settingsRef.current = loadedOptions;
          setNetworkSettings(loadedOptions);
          setUserAgentSelection(userAgentSelectionFor(loadedOptions.userAgent));
        } else if (settingsNeedSave.current) {
          const latest = toPersistedNetworkTestSettings(settingsRef.current, saved);
          persistedSettingsRef.current = latest;
          pendingSettingsSave.current = latest;
        }
      })
      .catch((error) => {
        console.error('读取网络测试设置失败', error);
      })
      .finally(() => {
        settingsReady.current = true;
        flushSettingsSave();
      });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void ListNetworkInterfaces()
      .then((items) => setInterfaces(items ?? []))
      .catch(() => setInterfaces([]));
  }, [active]);

  useEffect(() => {
    const off = Events.On('network-test:update', (event) => {
      const update = event.data as NetworkTestUpdate;
      if (!update?.runID || update.runID !== activeRunID.current || !update.stage?.id) return;
      stageMap.current.set(update.stage.id, update.stage);
      setStages(sortedStages([...stageMap.current.values()]));
    });
    return () => off();
  }, []);

  useEffect(() => {
    if (!active || !running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 150);
    return () => window.clearInterval(timer);
  }, [active, running]);

  useEffect(() => {
    if (pending?.tool !== 'network-test' || pending.action !== 'restore') return;
    const restoredRequest = parseHistoryValue<NetworkTestRequest>(pending.input);
    const restoredResult = parseHistoryValue<DisplayResult>(pending.output ?? '');
    if (restoredRequest) {
      setProtocolSelection(restoredRequest.protocol as Protocol);
      setTarget(restoredRequest.target);
      setUserAgentSelection(userAgentSelectionFor(restoredRequest.userAgent ?? ''));
      updateNetworkSettings(
        {
          payload: restoredRequest.payload || 'ping',
          timeoutSeconds: String(Math.max(1, Math.round(restoredRequest.timeoutMillis / 1000))),
          skipTLSVerify: restoredRequest.skipTLSVerify ?? false,
          maxRedirects: String(restoredRequest.maxRedirects ?? 10),
          method: restoredRequest.method ?? 'GET',
          headers: restoredRequest.headers || '',
          body: restoredRequest.body || '',
          hasBody: restoredRequest.hasBody ?? Boolean(restoredRequest.body),
          sourceID: restoredRequest.sourceID || 'local',
          userAgent: restoredRequest.userAgent ?? '',
          proxyType: (restoredRequest.proxyType || '') as ProxyType,
          proxyAddress: restoredRequest.proxyAddress,
          dnsMode: (restoredRequest.dnsMode || 'system') as DNSMode,
          dnsAddress: restoredRequest.dnsAddress,
          interfaceName: restoredRequest.interfaceName,
        },
        false,
      );
    }
    if (restoredResult) {
      activeRunID.current = '';
      const restoredStages = restoredResult.stages ?? [];
      stageMap.current = new Map(restoredStages.map((stage) => [stage.id, stage]));
      setStages(sortedStages(restoredStages));
      setResult({ ...restoredResult, stages: restoredStages });
      setRunning(false);
      setTestStartedAt(restoredResult.startedAt);
    }
    clearPending();
  }, [pending, clearPending]);

  const startTest = async () => {
    const duration = Number(timeoutSeconds);
    if (
      !target.trim() ||
      !effectiveProtocol ||
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > 300 ||
      invalidRedirectLimit ||
      selectedSourceProfileMissing ||
      unsupportedRemoteProtocol
    )
      return;
    if (effectiveProtocol === 'udp' && !payload.length) return;
    if (
      !remoteSourceSelected &&
      (proxyType === 'http' || proxyType === 'socks5') &&
      !proxyAddress.trim()
    )
      return;
    if (!remoteSourceSelected && dnsMode === 'custom' && !dnsAddress.trim()) return;
    const startedAt = Date.now();
    const request: NetworkTestRequest = {
      runID: crypto.randomUUID(),
      protocol: effectiveProtocol,
      target:
        protocolSelection === 'auto' ? automaticTarget(target, effectiveProtocol) : target.trim(),
      payload,
      method,
      headers,
      body,
      hasBody,
      sourceID: selectedSource.id,
      userAgent: effectiveUserAgent,
      timeoutMillis: Math.round(duration * 1000),
      skipTLSVerify,
      maxRedirects: redirectLimit,
      proxyType,
      proxyAddress: proxyAddress.trim(),
      dnsAddress: dnsMode === 'custom' ? dnsAddress.trim() : '',
      dnsMode,
      interfaceName,
    };
    activeRunID.current = request.runID;
    stageMap.current = new Map();
    setStages([]);
    setResult(null);
    setTestStartedAt(startedAt);
    setNow(startedAt);
    setRunning(true);
    try {
      const finalResult = await RunNetworkTest(request);
      if (activeRunID.current !== request.runID) return;
      const complete: DisplayResult = {
        ...finalResult,
        stages: sortedStages(finalResult.stages ?? [...stageMap.current.values()]),
      };
      setResult(complete);
      setStages(complete.stages);
      setRunning(false);
      record(
        'network-test',
        t('networkTestTool.recordAction'),
        t('networkTestTool.historyDetail', {
          protocol: t(`networkTestTool.protocol.${effectiveProtocol}`),
          target: request.target,
        }),
        JSON.stringify(request),
        JSON.stringify(complete),
        { mode: effectiveProtocol },
      );
    } catch (error) {
      if (activeRunID.current !== request.runID) return;
      // footer 只显示状态与耗时：调用层失败（没有任何阶段）时用 toast 说明原因，
      // 避免出现「只有失败状态、看不到原因」的静默失败。
      const failureMessage = formatBackendError(error);
      toast.add({
        title: t('networkTestTool.runFailed', { error: failureMessage }),
        type: 'error',
      });
      const failed: DisplayResult = {
        runID: request.runID,
        protocol: effectiveProtocol,
        target: request.target,
        status: 'error',
        startedAt,
        finishedAt: Date.now(),
        durationMillis: Date.now() - startedAt,
        error: formatBackendError(error),
        stages: sortedStages([...stageMap.current.values()]),
      };
      setResult(failed);
      setRunning(false);
    }
  };

  const cancelTest = () => {
    if (activeRunID.current) void CancelNetworkTest(activeRunID.current).catch(() => {});
  };

  const openSourceManager = () => {
    setSourceManagerOpen(true);
  };

  const saveNetworkSources = async (nextSources: NetworkTestSource[]) => {
    if (savingSources) return;
    setSavingSources(true);
    try {
      await SaveNetworkTestSources(nextSources);
      const sources = (await GetNetworkTestSources()) ?? defaultNetworkTestSources;
      setNetworkTestSources(sources.length ? sources : defaultNetworkTestSources);
      const nextSourceID = sources.some((source) => source.id === sourceID) ? sourceID : 'local';
      updateNetworkSettings({ sourceID: nextSourceID });
    } finally {
      setSavingSources(false);
    }
  };

  const importCurlCommand = () => {
    try {
      const parsed = parseCurlCommand(curlCommand);
      setTarget(parsed.target);
      setProtocolSelection('http');
      updateNetworkSettings({
        method: parsed.method,
        headers: parsed.headers,
        body: parsed.body,
        hasBody: parsed.hasBody,
        maxRedirects: String(parsed.maxRedirects),
        skipTLSVerify: parsed.skipTLSVerify,
        ...(parsed.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: String(parsed.timeoutSeconds) }),
      });
      toast.add({ title: t('networkTestTool.curl.imported'), type: 'success' });
    } catch (error) {
      const parseError =
        error instanceof CurlCommandParseError ? error : new CurlCommandParseError('syntax');
      toast.add({
        title: t(`networkTestTool.curl.errors.${parseError.code}`, { option: parseError.option }),
        type: 'error',
      });
    }
  };

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || running) return;
    event.preventDefault();
    void startTest();
  };

  const elapsed =
    running && testStartedAt ? Math.max(0, now - testStartedAt) : (result?.durationMillis ?? 0);
  const timelineDuration = Math.max(
    1,
    elapsed,
    ...stages.map((stage) => stage.finishedAt - (testStartedAt || stage.startedAt)),
  );
  const durationText = (milliseconds: number) =>
    milliseconds < 1000
      ? t('networkTestTool.duration.milliseconds', { value: Math.max(0, milliseconds) })
      : t('networkTestTool.duration.seconds', { value: (milliseconds / 1000).toFixed(2) });

  return (
    <>
      <Reveal fill active={active}>
        <ToolLayout>
          <ToolLayoutHeader title={t('networkTestTool.title')} />
          <ToolLayoutToolbar
            left={
              <>
                <ToolHeaderField
                  label={t('networkTestTool.protocol.label')}
                  labelId="network-test-protocol-label"
                >
                  <Select
                    value={protocolSelection}
                    onValueChange={(value) =>
                      value && setProtocolSelection(value as ProtocolSelection)
                    }
                    items={protocolOptions}
                  >
                    <SelectTrigger
                      disabled={running}
                      aria-labelledby="network-test-protocol-label"
                      className="w-[184px] max-[700px]:w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {protocolOptions.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </ToolHeaderField>
                <ToolHeaderField
                  label={t('networkTestTool.source.label')}
                  labelId="network-test-source-label"
                >
                  <Select
                    value={sourceID || 'local'}
                    onValueChange={(value) => {
                      if (value === MANAGE_NETWORK_SOURCES) {
                        openSourceManager();
                        return;
                      }
                      if (value) updateNetworkSettings({ sourceID: value });
                    }}
                    items={sourceItems}
                  >
                    <SelectTrigger
                      disabled={running}
                      aria-labelledby="network-test-source-label"
                      className="w-[168px] max-w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {networkTestSources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {sourceLabel(source)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectItem value={MANAGE_NETWORK_SOURCES}>
                          <GearSix weight="duotone" />
                          {t('networkTestTool.source.manage')}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {selectedSourceProfileMissing ? (
                    <p className="m-0 text-[10px] leading-relaxed text-destructive">
                      {t('networkTestTool.source.profileMissing')}
                    </p>
                  ) : unsupportedRemoteProtocol ? (
                    <p className="m-0 text-[10px] leading-relaxed text-muted-foreground">
                      {t('networkTestTool.source.httpOnly')}
                    </p>
                  ) : null}
                </ToolHeaderField>
                <ToolHeaderField
                  label={t('networkTestTool.target.label')}
                  className="min-w-[280px] flex-1"
                >
                  <Input
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    onKeyDown={submitOnEnter}
                    disabled={running}
                    placeholder={t(
                      `networkTestTool.target.placeholder.${protocolSelection === 'auto' ? 'auto' : (effectiveProtocol ?? 'auto')}`,
                    )}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label={t('networkTestTool.target.label')}
                    className="font-mono text-xs"
                  />
                </ToolHeaderField>
                <ToolHeaderField label={t('networkTestTool.timeout.label')}>
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    step={1}
                    value={timeoutSeconds}
                    onChange={(event) =>
                      updateNetworkSettings({ timeoutSeconds: event.target.value })
                    }
                    onKeyDown={submitOnEnter}
                    disabled={running}
                    className="w-[88px] font-mono text-xs"
                    aria-label={t('networkTestTool.timeout.label')}
                  />
                </ToolHeaderField>
              </>
            }
            right={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('networkTestTool.requestSettings.title')}
                  title={t('networkTestTool.requestSettings.title')}
                  onClick={() => setRequestSettingsOpen(true)}
                >
                  <Code size={16} weight="duotone" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('networkTestTool.advanced.title')}
                  title={t('networkTestTool.advanced.title')}
                  onClick={() => setAdvancedSettingsOpen(true)}
                >
                  <GearSix size={16} weight="duotone" />
                </Button>
              </>
            }
          />
          <ToolLayoutContent className="px-2">
            <div className="flex h-full min-h-0 flex-col">
              {stages.length ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="grid shrink-0 grid-cols-[150px_minmax(0,1fr)_88px] gap-3 border-b border-border py-2 text-[10px] font-medium text-muted-foreground max-[700px]:grid-cols-[112px_minmax(0,1fr)_74px]">
                    <span>{t('networkTestTool.waterfall.stage')}</span>
                    <span>{t('networkTestTool.waterfall.timeline')}</span>
                    <span className="text-right">{t('networkTestTool.waterfall.duration')}</span>
                  </div>
                  <ScrollArea
                    className="min-h-0 flex-1 [padding-inline-end:var(--overlay-scrollbar-size)]"
                    scrollFade="y"
                    options={{ overflow: { x: 'hidden' } }}
                  >
                    <div className="pb-3">
                      {stages.map((stage) => {
                        const redirectMatch = /^(.+)-redirect-(\d+)$/.exec(stage.id);
                        const stageLabelID = redirectMatch?.[1] ?? stage.id;
                        const redirectCount = stage.meta?.redirectCount ?? redirectMatch?.[2];
                        const redirectLabel =
                          redirectCount &&
                          (stageLabelID === 'http-request' ||
                            stageLabelID === 'websocket-handshake' ||
                            stageLabelID === 'rtsp-options' ||
                            stageLabelID === 'rtsp-describe')
                            ? t('networkTestTool.redirects.request', { count: redirectCount })
                            : null;
                        const resolver = stage.meta?.resolver;
                        let resolutionKind: string | null = null;
                        if (resolver === 'ssh-remote') resolutionKind = 'sshRemote';
                        else if (resolver === 'system') resolutionKind = 'system';
                        else if (resolver === 'literal') resolutionKind = 'literal';
                        else if (resolver === 'proxy' || stage.meta?.targetResolution === 'proxy') {
                          resolutionKind = 'proxy';
                        } else if (resolver) resolutionKind = 'custom';
                        const resolutionSummary =
                          resolutionKind === 'custom'
                            ? t('networkTestTool.dns.resolution.custom.summary', {
                                server: resolver,
                              })
                            : resolutionKind
                              ? t(`networkTestTool.dns.resolution.${resolutionKind}.summary`)
                              : null;
                        const resolutionDetail =
                          resolutionKind === 'custom'
                            ? t('networkTestTool.dns.resolution.custom.detail', {
                                server: resolver,
                              })
                            : resolutionKind
                              ? t(`networkTestTool.dns.resolution.${resolutionKind}.detail`)
                              : null;
                        const start = Math.max(
                          0,
                          stage.startedAt - (testStartedAt || stage.startedAt),
                        );
                        const firstByteAt = Number(stage.meta?.firstByteAt);
                        const firstByteDuration =
                          stageLabelID === 'http-response' &&
                          stage.meta?.firstByteAt &&
                          Number.isFinite(firstByteAt) &&
                          firstByteAt >= stage.startedAt
                            ? firstByteAt - stage.startedAt
                            : null;
                        const duration =
                          stage.status === 'running'
                            ? Math.max(40, now - stage.startedAt)
                            : stage.durationMillis;
                        const left = Math.min(99, (start / timelineDuration) * 100);
                        const width = Math.min(
                          100 - left,
                          Math.max(0.6, (duration / timelineDuration) * 100),
                        );
                        const responseTone = stageResponseTone(
                          stageLabelID,
                          stage.status,
                          stage.statusCode,
                        );
                        // 经隧道出口时握手对象是本机隧道端点，用警示色并补充说明，
                        // 避免把 tcp-connect 的「成功」读成设备可达。
                        const reachabilityTone =
                          stage.meta?.reachability === 'unverified' &&
                          (stage.status === 'success' || stage.status === 'running')
                            ? { text: 'text-warning', bar: 'bg-warning' }
                            : null;
                        // 经隧道或经代理的连接都要说明下一跳是什么，避免把「连接成功」
                        // 读成目标设备可达。
                        let outboundHint: string | null = null;
                        if (
                          stageLabelID !== 'tunnel-route' &&
                          stage.meta?.reachability === 'unverified'
                        ) {
                          if (stage.meta.outbound === 'ssh') {
                            outboundHint = t('networkTestTool.outbound.ssh.summary', {
                              source: stage.meta.source ?? '',
                            });
                          } else if (stage.meta.outbound === 'proxy') {
                            outboundHint = t('networkTestTool.outbound.proxy.summary', {
                              proxy: stage.meta.proxy ?? '',
                            });
                          } else if (stage.meta.tunnelInterface) {
                            outboundHint = t('networkTestTool.outbound.tunnel.withInterface', {
                              interface: stage.meta.tunnelInterface,
                            });
                          } else {
                            outboundHint = t('networkTestTool.outbound.tunnel.withoutInterface');
                          }
                        }
                        const statusTextColor =
                          reachabilityTone?.text ??
                          responseTone?.text ??
                          (stage.status === 'success'
                            ? 'text-emerald-500'
                            : stage.status === 'running'
                              ? 'text-primary'
                              : 'text-destructive');
                        const color =
                          reachabilityTone?.bar ??
                          responseTone?.bar ??
                          (stage.status === 'success'
                            ? 'bg-emerald-500'
                            : stage.status === 'running'
                              ? 'bg-primary'
                              : 'bg-destructive');
                        return (
                          <div
                            key={stage.id}
                            className="grid grid-cols-[150px_minmax(0,1fr)_88px] gap-3 border-b border-border/60 py-2.5 text-xs max-[700px]:grid-cols-[112px_minmax(0,1fr)_74px]"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {t(`networkTestTool.stages.${stageLabelID}`)}
                              </div>
                              {redirectLabel ? (
                                <StageHintLine
                                  text={redirectLabel}
                                  className="mt-0.5 text-[10px] text-warning"
                                />
                              ) : null}
                              {resolutionSummary ? (
                                <StageHintLine
                                  text={resolutionSummary}
                                  className={`${redirectLabel ? 'mt-0' : 'mt-0.5'} text-[10px] text-muted-foreground`}
                                />
                              ) : null}
                              {outboundHint ? (
                                <StageHintLine
                                  text={outboundHint}
                                  className={`${resolutionSummary ? 'mt-0' : 'mt-0.5'} text-[10px] text-warning`}
                                />
                              ) : null}
                              <div
                                className={`${resolutionSummary || outboundHint ? 'mt-0' : 'mt-0.5'} text-[10px] ${statusTextColor}`}
                              >
                                {stage.statusCode ? `${stage.statusCode} · ` : ''}
                                {t(`networkTestTool.status.${stage.status}`)}
                              </div>
                            </div>
                            <div className="relative mx-1.5 min-h-8 self-center rounded-sm bg-muted/35">
                              <div className="absolute inset-x-2 inset-y-0">
                                <div
                                  className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-sm ${color} ${stage.status === 'running' ? 'animate-pulse' : ''}`}
                                  style={{ left: `${left}%`, width: `${width}%` }}
                                />
                              </div>
                            </div>
                            <div className="self-center text-right font-mono text-[10px] text-muted-foreground">
                              {stage.status === 'running'
                                ? durationText(Math.max(0, now - stage.startedAt))
                                : durationText(stage.durationMillis)}
                            </div>
                            <details className="col-span-full -mt-1 min-w-0 text-[11px]">
                              <summary className="w-fit cursor-pointer select-none text-muted-foreground">
                                {t('networkTestTool.waterfall.details')}
                              </summary>
                              <div className="grid gap-2 py-2">
                                {resolutionDetail ? (
                                  <p className="m-0 text-muted-foreground">{resolutionDetail}</p>
                                ) : null}
                                {stage.request ? (
                                  <pre className="m-0 whitespace-pre-wrap break-all rounded-sm bg-muted/30 p-2 font-mono text-[10px]">
                                    {stage.request}
                                  </pre>
                                ) : null}
                                {stage.response ? (
                                  <pre className="m-0 whitespace-pre-wrap break-all rounded-sm bg-muted/30 p-2 font-mono text-[10px]">
                                    {formatBackendError(stage.response)}
                                  </pre>
                                ) : null}
                                {stageLabelID === 'http-response' &&
                                stage.status === 'running' &&
                                !stage.meta?.firstByteAt &&
                                stage.meta?.phase ? (
                                  <p className="m-0 text-muted-foreground">
                                    {formatBackendError(stage.meta.phase)}
                                  </p>
                                ) : null}
                                {firstByteDuration !== null ? (
                                  <p className="m-0 text-muted-foreground">
                                    {t('networkTestTool.waterfall.firstByteLatency', {
                                      duration: durationText(firstByteDuration),
                                    })}
                                  </p>
                                ) : null}
                                {stageLabelID !== 'http-response' &&
                                stage.meta &&
                                Object.keys(stage.meta).length ? (
                                  <pre className="m-0 whitespace-pre-wrap break-all rounded-sm bg-muted/30 p-2 font-mono text-[10px]">
                                    {JSON.stringify(
                                      Object.fromEntries(
                                        Object.entries(stage.meta).map(([key, value]) => [
                                          key,
                                          formatBackendError(value),
                                        ]),
                                      ),
                                      null,
                                      2,
                                    )}
                                  </pre>
                                ) : null}
                                {stage.error ? (
                                  <p className="m-0 break-all text-destructive">
                                    {formatBackendError(stage.error)}
                                  </p>
                                ) : null}
                              </div>
                            </details>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              ) : !result && !running ? (
                <div className="grid min-h-48 flex-1 place-items-center text-center text-xs text-muted-foreground">
                  <div>
                    <Network className="mx-auto mb-2 size-6" weight="duotone" />
                    <p className="m-0">{t('networkTestTool.empty')}</p>
                  </div>
                </div>
              ) : null}
            </div>
          </ToolLayoutContent>
          <ToolLayoutFooter>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              {result ? (
                <div className="flex min-w-0 flex-1 items-center gap-x-3 text-xs">
                  <span
                    className={`shrink-0 font-medium ${result.status === 'success' ? (footerHTTPResponseTone?.text ?? 'text-emerald-500') : result.status === 'canceled' ? 'text-muted-foreground' : 'text-destructive'}`}
                  >
                    {t(`networkTestTool.status.${result.status}`)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {durationText(result.durationMillis)}
                  </span>
                </div>
              ) : running ? (
                <div
                  className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                  <span>{t('networkTestTool.running', { elapsed: durationText(elapsed) })}</span>
                </div>
              ) : null}
              <ToolActionBar
                className="mt-0 ml-auto shrink-0"
                label={t('networkTestTool.actions.label')}
                actions={
                  running
                    ? [
                        {
                          key: 'cancel',
                          label: t('networkTestTool.actions.cancel'),
                          icon: Stop,
                          variant: 'danger',
                          onPress: cancelTest,
                        },
                      ]
                    : [
                        {
                          key: 'run',
                          label: t('networkTestTool.actions.run'),
                          icon: ArrowClockwise,
                          variant: 'primary',
                          disabled:
                            !target.trim() ||
                            !effectiveProtocol ||
                            (effectiveProtocol === 'udp' && !payload.length) ||
                            (!remoteSourceSelected &&
                              (proxyType === 'http' || proxyType === 'socks5') &&
                              !proxyAddress.trim()) ||
                            (!remoteSourceSelected && dnsMode === 'custom' && !dnsAddress.trim()) ||
                            !Number.isFinite(Number(timeoutSeconds)) ||
                            Number(timeoutSeconds) < 1 ||
                            Number(timeoutSeconds) > 300 ||
                            selectedSourceProfileMissing ||
                            unsupportedRemoteProtocol ||
                            invalidRedirectLimit,
                          onPress: () => void startTest(),
                        },
                      ]
                }
              />
            </div>
          </ToolLayoutFooter>
        </ToolLayout>
      </Reveal>
      <Dialog open={advancedSettingsOpen} onOpenChange={setAdvancedSettingsOpen}>
        <DialogContent className="grid max-h-[min(680px,calc(100dvh-2rem))] min-h-0 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('networkTestTool.advanced.title')}</DialogTitle>
          </DialogHeader>
          <div className="-m-1 grid min-h-0 grid-cols-2 gap-x-5 gap-y-3 overflow-y-auto p-1 max-[450px]:grid-cols-1">
            {remoteSourceSelected ? (
              <p className="col-span-2 m-0 text-[10px] leading-relaxed text-muted-foreground max-[450px]:col-span-1">
                {t('networkTestTool.source.remoteRoutingNote')}
              </p>
            ) : null}
            <ToolHeaderField
              label={t('networkTestTool.proxy.label')}
              labelId="network-test-proxy-label"
            >
              <Select
                value={proxyType || NO_PROXY}
                onValueChange={(value) => {
                  const nextProxyType = value === NO_PROXY ? '' : ((value ?? '') as ProxyType);
                  updateNetworkSettings({
                    proxyType: nextProxyType,
                    ...(nextProxyType !== 'socks5' &&
                    nextProxyType !== 'system' &&
                    dnsMode === 'proxy'
                      ? { dnsMode: 'system' }
                      : {}),
                  });
                }}
                items={proxyItems}
              >
                <SelectTrigger
                  disabled={running || remoteSourceSelected}
                  aria-labelledby="network-test-proxy-label"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {proxyItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ToolHeaderField>
            {proxyType === 'http' || proxyType === 'socks5' ? (
              <ToolHeaderField
                label={t('networkTestTool.proxy.address')}
                htmlFor="network-test-proxy-address"
              >
                <Input
                  id="network-test-proxy-address"
                  value={proxyAddress}
                  onChange={(event) => updateNetworkSettings({ proxyAddress: event.target.value })}
                  onKeyDown={submitOnEnter}
                  disabled={running || remoteSourceSelected}
                  placeholder={t('networkTestTool.proxy.addressPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </ToolHeaderField>
            ) : null}
            <ToolHeaderField
              label={t('networkTestTool.dns.label')}
              labelId="network-test-dns-label"
            >
              <Select
                value={dnsMode}
                onValueChange={(value) =>
                  value && updateNetworkSettings({ dnsMode: value as DNSMode })
                }
                items={dnsItems}
              >
                <SelectTrigger
                  disabled={running || remoteSourceSelected}
                  aria-labelledby="network-test-dns-label"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {dnsItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ToolHeaderField>
            {dnsMode === 'custom' ? (
              <ToolHeaderField
                label={t('networkTestTool.dns.address')}
                htmlFor="network-test-dns-address"
              >
                <Input
                  id="network-test-dns-address"
                  value={dnsAddress}
                  onChange={(event) => updateNetworkSettings({ dnsAddress: event.target.value })}
                  onKeyDown={submitOnEnter}
                  disabled={running || remoteSourceSelected}
                  placeholder={t('networkTestTool.dns.addressPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </ToolHeaderField>
            ) : null}
            <ToolHeaderField
              label={t('networkTestTool.tls.skipVerification')}
              labelId="network-test-skip-tls-verify-label"
            >
              <div className="flex min-h-8 items-center justify-between gap-3">
                <span
                  id="network-test-skip-tls-verify-description"
                  className="text-[10px] leading-relaxed text-muted-foreground"
                >
                  {t('networkTestTool.tls.skipVerificationNote')}
                </span>
                <Switch
                  checked={skipTLSVerify}
                  onCheckedChange={(checked) =>
                    updateNetworkSettings({ skipTLSVerify: checked === true })
                  }
                  disabled={running}
                  size="sm"
                  aria-labelledby="network-test-skip-tls-verify-label"
                  aria-describedby="network-test-skip-tls-verify-description"
                />
              </div>
            </ToolHeaderField>
            <ToolHeaderField
              label={t('networkTestTool.redirects.label')}
              htmlFor="network-test-max-redirects"
            >
              <Input
                id="network-test-max-redirects"
                type="number"
                min={0}
                max={10}
                step={1}
                value={maxRedirects}
                onChange={(event) => updateNetworkSettings({ maxRedirects: event.target.value })}
                onKeyDown={submitOnEnter}
                disabled={running}
                aria-describedby="network-test-max-redirects-note"
                className="font-mono text-xs"
              />
              <p
                id="network-test-max-redirects-note"
                className="m-0 text-[10px] leading-relaxed text-muted-foreground"
              >
                {t('networkTestTool.redirects.note')}
              </p>
            </ToolHeaderField>
            <ToolHeaderField
              label={t('networkTestTool.userAgent.label')}
              labelId="network-test-user-agent-label"
              className="col-span-2 max-[450px]:col-span-1"
            >
              <div className="grid gap-2">
                <Select
                  value={userAgentSelection}
                  onValueChange={(value) => {
                    if (!value) return;
                    setUserAgentSelection(value);
                    const preset = userAgentPresets.find((item) => item.id === value);
                    if (preset) {
                      updateNetworkSettings({ userAgent: presetUserAgent(preset) });
                    } else if (value === USER_AGENT_DEFAULT) {
                      updateNetworkSettings({ userAgent: '' });
                    }
                  }}
                  items={userAgentItems}
                >
                  <SelectTrigger
                    disabled={running}
                    aria-labelledby="network-test-user-agent-label"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {userAgentItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {userAgentSelection === USER_AGENT_CUSTOM ? (
                  <Input
                    id="network-test-user-agent"
                    aria-label={t('networkTestTool.userAgent.customLabel')}
                    value={userAgent}
                    onChange={(event) => updateNetworkSettings({ userAgent: event.target.value })}
                    onKeyDown={submitOnEnter}
                    disabled={running}
                    placeholder={t('networkTestTool.userAgent.customPlaceholder')}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                ) : null}
              </div>
            </ToolHeaderField>
            <p className="col-span-2 m-0 text-[10px] leading-relaxed text-muted-foreground max-[450px]:col-span-1">
              {t('networkTestTool.userAgent.note')}
            </p>
            <ToolHeaderField
              label={t('networkTestTool.udp.payload')}
              htmlFor="network-test-udp-payload"
              className="col-span-2 max-[450px]:col-span-1"
            >
              <Input
                id="network-test-udp-payload"
                value={payload}
                onChange={(event) => updateNetworkSettings({ payload: event.target.value })}
                onKeyDown={submitOnEnter}
                disabled={running}
                placeholder={t('networkTestTool.udp.payloadPlaceholder')}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </ToolHeaderField>
            <p className="col-span-2 m-0 text-[10px] leading-relaxed text-muted-foreground max-[450px]:col-span-1">
              {t('networkTestTool.udp.payloadNote')}
            </p>
            <ToolHeaderField
              label={t('networkTestTool.interface.label')}
              labelId="network-test-interface-label"
              className="col-span-2 max-[450px]:col-span-1"
            >
              <Select
                value={interfaceName || AUTOMATIC_INTERFACE}
                onValueChange={(value) =>
                  updateNetworkSettings({
                    interfaceName: value === AUTOMATIC_INTERFACE ? '' : (value ?? ''),
                  })
                }
                items={interfaceItems}
              >
                <SelectTrigger
                  disabled={running || remoteSourceSelected}
                  aria-labelledby="network-test-interface-label"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {interfaceItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ToolHeaderField>
            {!remoteSourceSelected ? (
              <p className="col-span-2 m-0 text-[10px] leading-relaxed text-muted-foreground max-[450px]:col-span-1">
                {t('networkTestTool.advanced.routingNote')}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={requestSettingsOpen} onOpenChange={setRequestSettingsOpen}>
        <DialogContent className="grid max-h-[min(720px,calc(100dvh-2rem))] min-h-0 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('networkTestTool.requestSettings.title')}</DialogTitle>
            <DialogDescription>
              {t('networkTestTool.requestSettings.description')}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 -m-1 p-1">
            <div className="grid gap-4">
              <ToolHeaderField
                label={t('networkTestTool.curl.label')}
                htmlFor="network-test-curl-command"
              >
                <Textarea
                  id="network-test-curl-command"
                  value={curlCommand}
                  onChange={(event) => setCurlCommand(event.target.value)}
                  disabled={running}
                  placeholder={t('networkTestTool.curl.placeholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  rows={4}
                  className="max-h-40 min-h-24 resize-y overflow-auto font-mono text-xs"
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={importCurlCommand}
                    disabled={running || !curlCommand.trim()}
                  >
                    <Code weight="duotone" />
                    {t('networkTestTool.curl.parse')}
                  </Button>
                </div>
              </ToolHeaderField>
              <ToolHeaderField
                label={t('networkTestTool.requestSettings.method')}
                htmlFor="network-test-http-method"
              >
                <Input
                  id="network-test-http-method"
                  list="network-test-http-method-options"
                  value={method}
                  onChange={(event) => updateNetworkSettings({ method: event.target.value })}
                  disabled={running}
                  placeholder={t('networkTestTool.requestSettings.methodPlaceholder')}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <datalist id="network-test-http-method-options">
                  {HTTP_METHOD_PRESETS.map((httpMethod) => (
                    <option key={httpMethod} value={httpMethod} />
                  ))}
                </datalist>
              </ToolHeaderField>
              <ToolHeaderField
                label={t('networkTestTool.requestSettings.headers')}
                htmlFor="network-test-http-headers"
              >
                <Textarea
                  id="network-test-http-headers"
                  value={headers}
                  onChange={(event) => updateNetworkSettings({ headers: event.target.value })}
                  disabled={running}
                  placeholder={t('networkTestTool.requestSettings.headersPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  rows={5}
                  className="max-h-40 min-h-28 resize-y overflow-auto font-mono text-xs"
                />
              </ToolHeaderField>
              <ToolHeaderField
                label={t('networkTestTool.requestSettings.sendBody')}
                labelId="network-test-http-has-body-label"
              >
                <div className="flex min-h-8 items-center justify-between gap-3">
                  <span className="text-[10px] leading-relaxed text-muted-foreground">
                    {t('networkTestTool.requestSettings.sendBodyNote')}
                  </span>
                  <Switch
                    checked={hasBody}
                    onCheckedChange={(checked) =>
                      updateNetworkSettings({ hasBody: checked === true })
                    }
                    disabled={running}
                    size="sm"
                    aria-labelledby="network-test-http-has-body-label"
                  />
                </div>
              </ToolHeaderField>
              <ToolHeaderField
                label={t('networkTestTool.requestSettings.body')}
                htmlFor="network-test-http-body"
              >
                <Textarea
                  id="network-test-http-body"
                  value={body}
                  onChange={(event) =>
                    updateNetworkSettings({ body: event.target.value, hasBody: true })
                  }
                  disabled={running || !hasBody}
                  placeholder={t('networkTestTool.requestSettings.bodyPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  rows={5}
                  className="max-h-40 min-h-28 resize-y overflow-auto font-mono text-xs"
                />
              </ToolHeaderField>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <TargetHostManagerDialog<NetworkTestSource, NetworkTestSource>
        open={sourceManagerOpen}
        onOpenChange={setSourceManagerOpen}
        items={networkTestSources}
        itemKey={(item) => item.id}
        itemName={(item) =>
          item.id === 'local' || item.kind === 'local'
            ? t('networkTestTool.source.local')
            : item.name
        }
        itemDisabled={(item) => item.id === 'local' || item.kind === 'local'}
        createDraft={() => ({
          id: '',
          name: '',
          kind: 'ssh',
          sshProfileID: profiles[0]?.id ?? '',
        })}
        toDraft={(item) => ({ ...item })}
        commitDraft={(draft, previous) => {
          const profile = profiles.find((item) => item.id === draft.sshProfileID);
          if (!profile) return t('networkTestTool.source.sshProfileRequired');
          const next: NetworkTestSource = {
            id: draft.id || `network-test:${crypto.randomUUID()}`,
            name: draft.name.trim() || profile.name,
            kind: 'ssh',
            sshProfileID: profile.id,
          };
          return upsertManagerItem(previous, next, (item) => item.id, draft.id || undefined);
        }}
        saveItems={saveNetworkSources}
        saving={savingSources}
        renderMeta={(item) =>
          item.id === 'local' || item.kind === 'local' ? (
            <span>{t('networkTestTool.source.local')}</span>
          ) : (
            <>
              <span>{t('networkTestTool.source.kindSSH')}</span>
              {!profiles.some((profile) => profile.id === item.sshProfileID) ? (
                <Badge variant="destructive" className="h-4 text-[9px]">
                  {t('networkTestTool.source.profileMissing')}
                </Badge>
              ) : null}
            </>
          )
        }
        renderForm={({ draft, setDraft }) => (
          <>
            <ToolHeaderField label={t('networkTestTool.source.name')}>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={t('networkTestTool.source.namePlaceholder')}
              />
            </ToolHeaderField>
            <ToolHeaderField label={t('networkTestTool.source.sshProfile')}>
              <SSHProfileFormField
                value={draft.sshProfileID}
                onSelect={(profile) =>
                  setDraft({
                    ...draft,
                    sshProfileID: profile?.id ?? '',
                    name: draft.name.trim() || profile?.name || draft.name,
                  })
                }
                placeholder={t('networkTestTool.source.selectSSHProfile')}
              />
            </ToolHeaderField>
          </>
        )}
        strings={{
          title: t('networkTestTool.source.managerTitle'),
          edit: t('networkTestTool.source.edit'),
          remove: t('networkTestTool.source.remove'),
          dragItem: (name) => t('sidebar.dragTool', { name }),
          empty: t('networkTestTool.source.empty'),
          emptyHint: t('networkTestTool.source.emptyHint'),
          save: t('common.save'),
          back: t('common.cancel'),
          discardTitle: t('networkTestTool.source.discardTitle'),
          discardDescription: t('networkTestTool.source.discardDescription'),
          discardConfirm: t('networkTestTool.source.discardConfirm'),
          removeTitle: t('networkTestTool.source.removeConfirmTitle'),
          removeDescription: (name) =>
            t('networkTestTool.source.removeConfirmDescription', { name }),
          formTitle: (editing) =>
            t(editing ? 'networkTestTool.source.edit' : 'networkTestTool.source.add'),
        }}
      />
    </>
  );
}
