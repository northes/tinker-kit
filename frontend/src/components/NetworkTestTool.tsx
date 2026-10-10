import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Events } from '@wailsio/runtime';
import { ArrowClockwise, Copy, GearSix, Network, Stop } from '@phosphor-icons/react';
import type {
  NetworkInterface,
  NetworkTestSettings,
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
  SaveNetworkTestSettings,
} from '../../bindings/changeme/configservice';
import { formatBackendError } from '../lib/backend-error';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

type Protocol = 'http' | 'tcp' | 'websocket' | 'udp' | 'ntp';
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
  timeoutSeconds: 10,
  skipTLSVerify: false,
  maxRedirects: 10,
  proxyType: '',
  proxyAddress: '',
  dnsMode: 'system',
  dnsAddress: '',
  interfaceName: '',
};
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
] as const;
const stageOrder = [
  'validate',
  'proxy-resolve',
  'dns-proxy',
  'dns-target',
  'tcp-connect',
  'proxy-tunnel',
  'udp-send',
  'udp-response',
  'ntp-request',
  'ntp-response',
  'tls',
  'http-request',
  'websocket-handshake',
  'http-response',
];
const NO_PROXY = '__network-test-no-proxy__';
const AUTOMATIC_INTERFACE = '__network-test-automatic-interface__';

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
    proxyType: options.proxyType,
    proxyAddress: options.proxyAddress,
    dnsMode: options.dnsMode,
    dnsAddress: options.dnsAddress,
    interfaceName: options.interfaceName,
  };
}

function explicitHostPort(value: string) {
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

function detectTargetProtocol(value: string): Protocol | null {
  const target = value.trim();
  if (!target) return null;

  if (target.includes('://')) {
    try {
      const parsed = new URL(target);
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      switch (parsed.protocol.toLowerCase()) {
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

function automaticTarget(value: string, protocol: Protocol) {
  const target = value.trim();
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase();
  if (scheme && ['tcp', 'udp', 'ntp'].includes(scheme))
    return target.slice(target.indexOf('://') + 3);
  if (scheme) return target;
  const port = explicitHostPort(target);
  if (protocol === 'http' && (port === 443 || port === 8443)) return `https://${target}`;
  return target;
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
  const copyFooterText = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      toast.add({ title: t('toast.copied', { value: label }) });
    } catch {
      toast.add({ title: t('networkTestTool.footer.copyFailed'), type: 'error' });
    }
  };
  const [protocolSelection, setProtocolSelection] = useState<ProtocolSelection>('auto');
  const [target, setTarget] = useState('');
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
  const supportsHTTPSettings = effectiveProtocol === 'http' || effectiveProtocol === 'websocket';
  const redirectLimit = Number(maxRedirects);
  const invalidRedirectLimit =
    supportsHTTPSettings &&
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
    void GetNetworkTestSettings()
      .then((savedSettings) => {
        const saved = { ...defaultNetworkTestSettings, ...savedSettings };
        persistedSettingsRef.current = saved;
        if (!settingsTouched.current) {
          const loadedOptions: NetworkTestOptions = {
            ...saved,
            timeoutSeconds: String(saved.timeoutSeconds),
            maxRedirects: String(saved.maxRedirects),
          };
          settingsRef.current = loadedOptions;
          setNetworkSettings(loadedOptions);
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
      updateNetworkSettings(
        {
          payload: restoredRequest.payload || 'ping',
          timeoutSeconds: String(Math.max(1, Math.round(restoredRequest.timeoutMillis / 1000))),
          skipTLSVerify: restoredRequest.skipTLSVerify ?? false,
          maxRedirects: String(restoredRequest.maxRedirects ?? 10),
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
      invalidRedirectLimit
    )
      return;
    if (effectiveProtocol === 'udp' && !payload.length) return;
    if ((proxyType === 'http' || proxyType === 'socks5') && !proxyAddress.trim()) return;
    if (dnsMode === 'custom' && !dnsAddress.trim()) return;
    const startedAt = Date.now();
    const request: NetworkTestRequest = {
      runID: crypto.randomUUID(),
      protocol: effectiveProtocol,
      target:
        protocolSelection === 'auto' ? automaticTarget(target, effectiveProtocol) : target.trim(),
      payload,
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
                            stageLabelID === 'websocket-handshake')
                            ? t('networkTestTool.redirects.request', { count: redirectCount })
                            : null;
                        const resolver = stage.meta?.resolver;
                        const resolutionKind =
                          resolver === 'system'
                            ? 'system'
                            : resolver === 'literal'
                              ? 'literal'
                              : resolver === 'proxy' || stage.meta?.targetResolution === 'proxy'
                                ? 'proxy'
                                : resolver
                                  ? 'custom'
                                  : null;
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
                        const duration =
                          stage.status === 'running'
                            ? Math.max(40, now - stage.startedAt)
                            : stage.durationMillis;
                        const left = Math.min(99, (start / timelineDuration) * 100);
                        const width = Math.min(
                          100 - left,
                          Math.max(0.6, (duration / timelineDuration) * 100),
                        );
                        const responseTone =
                          stageLabelID === 'http-response' && stage.statusCode > 0
                            ? httpResponseTone(stage.statusCode)
                            : null;
                        const statusTextColor =
                          responseTone?.text ??
                          (stage.status === 'success'
                            ? 'text-emerald-500'
                            : stage.status === 'running'
                              ? 'text-primary'
                              : 'text-destructive');
                        const color =
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
                                <div
                                  className="mt-0.5 truncate text-[10px] text-warning"
                                  title={redirectLabel}
                                >
                                  {redirectLabel}
                                </div>
                              ) : null}
                              {resolutionSummary ? (
                                <div
                                  className={`${redirectLabel ? 'mt-0' : 'mt-0.5'} truncate text-[10px] text-muted-foreground`}
                                  title={resolutionSummary}
                                >
                                  {resolutionSummary}
                                </div>
                              ) : null}
                              <div
                                className={`${resolutionSummary ? 'mt-0' : 'mt-0.5'} text-[10px] ${statusTextColor}`}
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
                                    {stage.response}
                                  </pre>
                                ) : null}
                                {stage.meta && Object.keys(stage.meta).length ? (
                                  <pre className="m-0 whitespace-pre-wrap break-all rounded-sm bg-muted/30 p-2 font-mono text-[10px]">
                                    {JSON.stringify(stage.meta, null, 2)}
                                  </pre>
                                ) : null}
                                {stage.error ? (
                                  <p className="m-0 break-all text-destructive">{stage.error}</p>
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
                  <button
                    type="button"
                    className="flex w-fit min-w-0 max-w-[min(45%,24rem)] flex-none cursor-default items-center gap-1 bg-transparent p-0 text-left font-mono text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    aria-label={t('networkTestTool.footer.copyTarget')}
                    title={t('networkTestTool.footer.copyTarget')}
                    onClick={() =>
                      void copyFooterText(result.target, t('networkTestTool.target.label'))
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{result.target}</span>
                    <Copy className="size-3 shrink-0" weight="duotone" />
                  </button>
                  <span className="shrink-0 text-muted-foreground">
                    {durationText(result.durationMillis)}
                  </span>
                  {result.error ? (
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-default items-center gap-1 bg-transparent p-0 text-left text-destructive/70 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      aria-label={t('networkTestTool.footer.copyError')}
                      title={t('networkTestTool.footer.copyError')}
                      onClick={() =>
                        void copyFooterText(result.error, t('networkTestTool.footer.errorLabel'))
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">{result.error}</span>
                      <Copy className="size-3 shrink-0" weight="duotone" />
                    </button>
                  ) : null}
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
                            ((proxyType === 'http' || proxyType === 'socks5') &&
                              !proxyAddress.trim()) ||
                            (dnsMode === 'custom' && !dnsAddress.trim()) ||
                            !Number.isFinite(Number(timeoutSeconds)) ||
                            Number(timeoutSeconds) < 1 ||
                            Number(timeoutSeconds) > 300 ||
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
                  disabled={running}
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
                  disabled={running}
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
                  disabled={running}
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
                  disabled={running}
                  placeholder={t('networkTestTool.dns.addressPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </ToolHeaderField>
            ) : null}
            {effectiveProtocol === 'http' || effectiveProtocol === 'websocket' ? (
              <>
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
                    onChange={(event) =>
                      updateNetworkSettings({ maxRedirects: event.target.value })
                    }
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
              </>
            ) : null}
            {effectiveProtocol === 'udp' ? (
              <>
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
              </>
            ) : null}
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
                  disabled={running}
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
            <p className="col-span-2 m-0 text-[10px] leading-relaxed text-muted-foreground max-[450px]:col-span-1">
              {t('networkTestTool.advanced.routingNote')}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
