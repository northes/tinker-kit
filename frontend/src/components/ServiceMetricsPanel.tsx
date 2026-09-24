import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, CaretDown, Pause, Play, WarningCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { GetServiceMetrics } from '../../bindings/changeme/servicemanagerservice';
import type {
  ServiceMetricAvailability,
  ServiceMetricSample,
  ServiceMetricSnapshot,
  ServiceTarget,
} from '../../bindings/changeme/models';
import { formatBackendError } from '../lib/backend-error';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

const METRIC_INTERVAL = 5000;
const ALL_TARGETS = '__all_targets__';

type GroupMode = 'resource' | 'compose' | 'source';
type MetricKind = 'cpu' | 'memory' | 'network' | 'disk';
type TimeRange = '60' | '300' | '900' | 'session';

type MetricPoint = {
  timestamp: number;
  cpu?: number;
  memory?: number;
  memoryLimit?: number;
  networkRx?: number;
  networkTx?: number;
  diskRead?: number;
  diskWrite?: number;
};

type MetricRow = {
  key: string;
  targetID: string;
  targetName: string;
  kind: string;
  runtime: string;
  id: string;
  name: string;
  group?: string;
  status?: string;
  availability: ServiceMetricAvailability;
  point: MetricPoint;
};

type RawPoint = { timestamp: number; sample: ServiceMetricSample };

function metricKey(sample: ServiceMetricSample) {
  return `${sample.targetID}|${sample.kind}|${sample.runtime}|${sample.id}`;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rate(
  current: number | null | undefined,
  previous: number | null | undefined,
  seconds: number,
) {
  if (!finite(current) || !finite(previous) || seconds <= 0 || current < previous) return undefined;
  return (current - previous) / seconds;
}

function pointFromSample(
  sample: ServiceMetricSample,
  timestamp: number,
  previous?: RawPoint,
): MetricPoint {
  const seconds = previous ? (timestamp - previous.timestamp) / 1000 : 0;
  let cpu = finite(sample.cpuPercent) ? sample.cpuPercent : undefined;
  if (!finite(cpu) && previous && finite(sample.cpuTimeNS) && finite(previous.sample.cpuTimeNS)) {
    const elapsed = sample.cpuTimeNS - previous.sample.cpuTimeNS;
    if (elapsed >= 0 && seconds > 0) {
      cpu = (elapsed / (seconds * 1_000_000_000 * Math.max(1, sample.cpuCores))) * 100;
    }
  }
  return {
    timestamp,
    cpu,
    memory: finite(sample.memoryBytes) ? sample.memoryBytes : undefined,
    memoryLimit: finite(sample.memoryLimit) ? sample.memoryLimit : undefined,
    networkRx: previous
      ? rate(sample.networkRxBytes, previous.sample.networkRxBytes, seconds)
      : undefined,
    networkTx: previous
      ? rate(sample.networkTxBytes, previous.sample.networkTxBytes, seconds)
      : undefined,
    diskRead: previous
      ? rate(sample.diskReadBytes, previous.sample.diskReadBytes, seconds)
      : undefined,
    diskWrite: previous
      ? rate(sample.diskWriteBytes, previous.sample.diskWriteBytes, seconds)
      : undefined,
  };
}

function metricValue(point: MetricPoint, metric: MetricKind) {
  if (metric === 'cpu') return point.cpu;
  if (metric === 'memory') return point.memory;
  if (metric === 'network') {
    if (!finite(point.networkRx) && !finite(point.networkTx)) return undefined;
    return (point.networkRx ?? 0) + (point.networkTx ?? 0);
  }
  if (!finite(point.diskRead) && !finite(point.diskWrite)) return undefined;
  return (point.diskRead ?? 0) + (point.diskWrite ?? 0);
}

function secondaryMetricValue(point: MetricPoint, metric: MetricKind) {
  if (metric === 'network') return point.networkTx;
  if (metric === 'disk') return point.diskWrite;
  return undefined;
}

function primaryMetricValue(point: MetricPoint, metric: MetricKind) {
  if (metric === 'network') return point.networkRx;
  if (metric === 'disk') return point.diskRead;
  return metricValue(point, metric);
}

function formatBytes(value: number | undefined) {
  if (!finite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = Math.max(0, value);
  let unit = 0;
  while (current >= 1000 && unit < units.length - 1) {
    current /= 1000;
    unit += 1;
  }
  const digits = current >= 100 || unit === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unit]}`;
}

function formatRate(value: number | undefined) {
  return finite(value) ? `${formatBytes(value)}/s` : '—';
}

function formatMetric(value: number | undefined, metric: MetricKind) {
  if (!finite(value)) return '—';
  if (metric === 'cpu') return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
  return metric === 'memory' ? formatBytes(value) : formatRate(value);
}

function targetLabel(target: ServiceTarget, localLabel: string) {
  return target.kind === 'local' ? localLabel : target.name;
}

function availabilityText(status: string, t: ReturnType<typeof useTranslation>['t']) {
  const known = ['unsupported', 'unavailable', 'stopped', 'partial', 'accounting-disabled'];
  const key = known.includes(status) ? status : 'unavailable';
  return t(`serviceManagerTool.metrics.availability.${key}`);
}

export function ServiceMetricsPanel({
  enabled,
  targets,
}: {
  enabled: boolean;
  targets: ServiceTarget[];
}) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [snapshots, setSnapshots] = useState<ServiceMetricSnapshot[]>([]);
  const [requestError, setRequestError] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [scope, setScope] = useState(ALL_TARGETS);
  const [group, setGroup] = useState<GroupMode>('resource');
  const [metric, setMetric] = useState<MetricKind>('cpu');
  const [range, setRange] = useState<TimeRange>('300');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const rawRef = useRef(new Map<string, RawPoint>());
  const historyRef = useRef(new Map<string, MetricPoint[]>());
  const requestVersion = useRef(0);

  const applySnapshots = useCallback((nextSnapshots: ServiceMetricSnapshot[]) => {
    const nextRows: MetricRow[] = [];
    for (const snapshot of nextSnapshots) {
      const timestamp = Date.parse(snapshot.timestamp) || Date.now();
      for (const sample of snapshot.samples ?? []) {
        const key = metricKey(sample);
        const point = pointFromSample(sample, timestamp, rawRef.current.get(key));
        rawRef.current.set(key, { timestamp, sample });
        const history = historyRef.current.get(key) ?? [];
        history.push(point);
        historyRef.current.set(key, history);
        nextRows.push({
          key,
          targetID: sample.targetID,
          targetName: sample.targetName,
          kind: sample.kind,
          runtime: sample.runtime,
          id: sample.id,
          name: sample.name,
          group: sample.group,
          status: sample.status,
          availability: sample.availability,
          point,
        });
      }
    }
    setSnapshots(nextSnapshots);
    setRows(nextRows);
    setHistoryVersion((value) => value + 1);
  }, []);

  const collect = useCallback(async () => {
    if (!targets.length) return;
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const result = (await GetServiceMetrics(targets.map((target) => target.id))) ?? [];
      if (version === requestVersion.current) {
        setRequestError('');
        applySnapshots(result);
      }
    } catch (error) {
      if (version === requestVersion.current) setRequestError(String(error));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [applySnapshots, targets]);

  useEffect(() => {
    if (!enabled || paused || !targets.length) return;
    let disposed = false;
    let timer = 0;
    const tick = async () => {
      await collect();
      if (!disposed) timer = window.setTimeout(tick, METRIC_INTERVAL);
    };
    void tick();
    return () => {
      disposed = true;
      requestVersion.current += 1;
      window.clearTimeout(timer);
    };
  }, [collect, enabled, paused, targets.length]);

  const targetNames = useMemo(
    () =>
      new Map(
        targets.map((target) => [
          target.id,
          targetLabel(target, t('serviceManagerTool.localTarget')),
        ]),
      ),
    [t, targets],
  );
  const effectiveScope = group === 'source' ? ALL_TARGETS : scope;
  const visibleRows = useMemo(() => {
    const query = search.toLowerCase();
    return rows
      .filter((row) => row.kind === group)
      .filter((row) => effectiveScope === ALL_TARGETS || row.targetID === effectiveScope)
      .filter(
        (row) =>
          !query ||
          row.name.toLowerCase().includes(query) ||
          row.targetName.toLowerCase().includes(query) ||
          (targetNames.get(row.targetID) ?? '').toLowerCase().includes(query),
      )
      .sort((left, right) => {
        const a = metricValue(left.point, metric);
        const b = metricValue(right.point, metric);
        if (!finite(a) && !finite(b)) return left.name.localeCompare(right.name);
        if (!finite(a)) return 1;
        if (!finite(b)) return -1;
        return b - a;
      });
  }, [effectiveScope, group, metric, rows, search, targetNames]);

  useEffect(() => {
    if (!visibleRows.some((row) => row.key === selectedKey)) {
      setSelectedKey(visibleRows[0]?.key ?? '');
    }
  }, [selectedKey, visibleRows]);

  const selected = visibleRows.find((row) => row.key === selectedKey) ?? null;
  const errors = snapshots.flatMap((snapshot) => {
    const name = targetNames.get(snapshot.target.id) ?? snapshot.target.name ?? snapshot.target.id;
    if (snapshot.error)
      return [{ key: `${snapshot.target.id}:target`, name, error: snapshot.error }];
    return Object.entries(snapshot.errors ?? {}).map(([runtime, error]) => ({
      key: `${snapshot.target.id}:${runtime}`,
      name: `${name} · ${runtime}`,
      error: error ?? '',
    }));
  });
  if (requestError) {
    errors.unshift({
      key: 'request',
      name: t('serviceManagerTool.metrics.collectionFailed'),
      error: requestError,
    });
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
        <ControlLabel label={t('serviceManagerTool.metrics.scope')}>
          <Select
            items={[
              { value: ALL_TARGETS, label: t('serviceManagerTool.metrics.allSources') },
              ...targets.map((target) => ({
                value: target.id,
                label: targetNames.get(target.id) ?? target.name,
              })),
            ]}
            value={effectiveScope}
            disabled={group === 'source'}
            onValueChange={(value) => {
              if (value) setScope(value);
            }}
          >
            <SelectTrigger className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL_TARGETS}>
                  {t('serviceManagerTool.metrics.allSources')}
                </SelectItem>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {targetNames.get(target.id) ?? target.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ControlLabel>
        <ControlLabel label={t('serviceManagerTool.metrics.groupBy')}>
          <div className="flex h-8 rounded-lg border border-input bg-background p-0.5 dark:bg-input/30">
            {(['resource', 'compose', 'source'] as GroupMode[]).map((value) => (
              <Button
                key={value}
                variant={group === value ? 'secondary' : 'ghost'}
                size="sm"
                className="h-[26px]"
                onClick={() => setGroup(value)}
              >
                {t(`serviceManagerTool.metrics.groups.${value}`)}
              </Button>
            ))}
          </div>
        </ControlLabel>
        <ControlLabel label={t('serviceManagerTool.search')} className="min-w-40 flex-1">
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearch(searchDraft.trim());
            }}
            placeholder={t('serviceManagerTool.searchPlaceholder')}
          />
        </ControlLabel>
        <ControlLabel label={t('serviceManagerTool.metrics.range')}>
          <Select
            items={(['60', '300', '900', 'session'] as TimeRange[]).map((value) => ({
              value,
              label: t(`serviceManagerTool.metrics.ranges.${value}`),
            }))}
            value={range}
            onValueChange={(value) => {
              if (value) setRange(value as TimeRange);
            }}
          >
            <SelectTrigger className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(['60', '300', '900', 'session'] as TimeRange[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`serviceManagerTool.metrics.ranges.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ControlLabel>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            className="flex-none"
            title={
              paused
                ? t('serviceManagerTool.metrics.resume')
                : t('serviceManagerTool.metrics.pause')
            }
            aria-label={
              paused
                ? t('serviceManagerTool.metrics.resume')
                : t('serviceManagerTool.metrics.pause')
            }
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play weight="duotone" /> : <Pause weight="duotone" />}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="flex-none"
            disabled={loading}
            title={t('serviceManagerTool.refresh')}
            aria-label={t('serviceManagerTool.refresh')}
            onClick={() => void collect()}
          >
            <ArrowsClockwise weight="duotone" className={loading ? 'animate-spin' : undefined} />
          </Button>
          <Badge variant={paused ? 'secondary' : 'success'}>
            {t(paused ? 'serviceManagerTool.metrics.paused' : 'serviceManagerTool.metrics.live')}
          </Badge>
        </div>
        {errors.length ? (
          <details className="w-full text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              <WarningCircle className="mr-1 inline size-3.5" />
              {t('serviceManagerTool.metrics.partialErrors', { total: errors.length })}
            </summary>
            <ul className="mt-2 space-y-1 pl-5">
              {errors.map((item) => (
                <li key={item.key}>
                  <span className="font-medium text-foreground">{item.name}</span> ·{' '}
                  {formatBackendError(item.error)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="grid min-h-0 grid-cols-[minmax(360px,44%)_minmax(0,1fr)] max-[800px]:grid-cols-1 max-[800px]:grid-rows-[minmax(220px,44%)_minmax(260px,1fr)]">
        <RankingTable
          rows={visibleRows}
          selectedKey={selectedKey}
          metric={metric}
          onMetricChange={setMetric}
          onSelect={setSelectedKey}
          targetNames={targetNames}
        />
        <TrendPanel
          key={`${selectedKey}:${historyVersion}`}
          row={selected}
          displayName={
            selected?.kind === 'source'
              ? (targetNames.get(selected.targetID) ?? selected.name)
              : (selected?.name ?? '')
          }
          targetName={selected ? (targetNames.get(selected.targetID) ?? selected.targetName) : ''}
          metric={metric}
          range={range}
          history={selected ? (historyRef.current.get(selected.key) ?? []) : []}
        />
      </div>
    </div>
  );
}

function ControlLabel({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function RankingTable({
  rows,
  selectedKey,
  metric,
  onMetricChange,
  onSelect,
  targetNames,
}: {
  rows: MetricRow[];
  selectedKey: string;
  metric: MetricKind;
  onMetricChange: (metric: MetricKind) => void;
  onSelect: (key: string) => void;
  targetNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const metricHeaders: MetricKind[] = ['cpu', 'memory', 'network', 'disk'];
  return (
    <section className="min-h-0 min-w-0 border-r max-[800px]:border-r-0 max-[800px]:border-b">
      <ScrollArea className="h-full min-h-0" options={{ overflow: { x: 'scroll' } }}>
        <table className="w-full min-w-[660px] table-fixed text-xs">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b">
              <th className="w-[31%] px-3 py-2 text-left font-medium">
                {t('serviceManagerTool.metrics.name')}
              </th>
              {metricHeaders.map((value) => (
                <th key={value} className="px-2 py-2 text-right font-medium">
                  <button
                    type="button"
                    className={
                      metric === value
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }
                    onClick={() => onMetricChange(value)}
                  >
                    {t(`serviceManagerTool.metrics.metric.${value}`)}
                    {metric === value ? (
                      <CaretDown className="ml-1 inline size-3" weight="bold" />
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                tabIndex={0}
                aria-selected={row.key === selectedKey}
                className="cursor-pointer border-b hover:bg-muted/50 aria-selected:bg-muted"
                onClick={() => onSelect(row.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(row.key);
                  }
                }}
              >
                <td className="px-3 py-2">
                  <span className="block truncate font-medium">
                    {row.kind === 'source' ? (targetNames.get(row.targetID) ?? row.name) : row.name}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {targetNames.get(row.targetID) ?? row.targetName} · {row.runtime}
                  </span>
                </td>
                <MetricCell row={row} metric="cpu" active={metric === 'cpu'} />
                <MetricCell row={row} metric="memory" active={metric === 'memory'} />
                <MetricCell row={row} metric="network" active={metric === 'network'} />
                <MetricCell row={row} metric="disk" active={metric === 'disk'} />
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? (
          <div className="grid min-h-48 place-items-center px-6 text-center text-sm text-muted-foreground">
            {t('serviceManagerTool.metrics.empty')}
          </div>
        ) : null}
      </ScrollArea>
    </section>
  );
}

function MetricCell({
  row,
  metric,
  active,
}: {
  row: MetricRow;
  metric: MetricKind;
  active: boolean;
}) {
  const { t } = useTranslation();
  const status = row.availability[metric];
  const primary = primaryMetricValue(row.point, metric);
  const secondary = secondaryMetricValue(row.point, metric);
  const missing = !finite(primary) && !finite(secondary);
  const hint = missing
    ? status === 'available'
      ? t('serviceManagerTool.metrics.collecting')
      : availabilityText(status, t)
    : status === 'partial'
      ? availabilityText('partial', t)
      : undefined;
  return (
    <td
      className={`px-2 py-2 text-right font-mono tabular-nums ${active ? 'bg-muted/40' : ''}`}
      title={hint}
    >
      {missing ? (
        <>
          <span className="block">—</span>
          <span className="block whitespace-normal text-[10px] leading-tight text-muted-foreground">
            {hint}
          </span>
        </>
      ) : metric === 'memory' ? (
        <>
          <span className="block">{formatBytes(primary)}</span>
          {finite(row.point.memoryLimit) && finite(primary) && row.point.memoryLimit > 0 ? (
            <span className="block text-[10px] text-muted-foreground">
              {((primary / row.point.memoryLimit) * 100).toFixed(1)}%
            </span>
          ) : null}
        </>
      ) : metric === 'network' || metric === 'disk' ? (
        <>
          <span className="block">
            {metric === 'network' ? '↓' : 'R'} {formatRate(primary)}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {metric === 'network' ? '↑' : 'W'} {formatRate(secondary)}
          </span>
        </>
      ) : (
        <span className="block">{formatMetric(primary, metric)}</span>
      )}
    </td>
  );
}

function TrendPanel({
  row,
  displayName,
  targetName,
  metric,
  range,
  history,
}: {
  row: MetricRow | null;
  displayName: string;
  targetName: string;
  metric: MetricKind;
  range: TimeRange;
  history: MetricPoint[];
}) {
  const { t } = useTranslation();
  if (!row) {
    return (
      <div className="grid min-h-0 place-items-center text-sm text-muted-foreground">
        {t('serviceManagerTool.metrics.selectHint')}
      </div>
    );
  }
  const now = history.at(-1)?.timestamp ?? Date.now();
  const start =
    range === 'session' ? (history[0]?.timestamp ?? now - 1) : now - Number(range) * 1000;
  const points = history.filter((point) => point.timestamp >= start);
  const totals = points.map((point) => metricValue(point, metric)).filter(finite);
  const current = totals.at(-1);
  const average = totals.length
    ? totals.reduce((sum, value) => sum + value, 0) / totals.length
    : undefined;
  const peak = totals.length ? Math.max(...totals) : undefined;
  const status = row.availability[metric];
  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="border-b px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-start gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{displayName}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {targetName} · {row.runtime} · {t(`serviceManagerTool.metrics.metric.${metric}`)}
            </p>
          </div>
          <SummaryValue
            label={t('serviceManagerTool.metrics.current')}
            value={formatMetric(current, metric)}
          />
          <SummaryValue
            label={t('serviceManagerTool.metrics.average')}
            value={formatMetric(average, metric)}
          />
          <SummaryValue
            label={t('serviceManagerTool.metrics.peak')}
            value={formatMetric(peak, metric)}
          />
        </div>
      </header>
      {totals.length ? (
        <MetricChart points={points} metric={metric} start={start} end={now} />
      ) : (
        <div className="grid min-h-0 place-items-center px-6 text-center">
          <div>
            <p className="text-sm font-medium">
              {status === 'available'
                ? t('serviceManagerTool.metrics.collecting')
                : availabilityText(status, t)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('serviceManagerTool.metrics.noTrend')}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <span className="block text-[10px] font-medium text-muted-foreground">{label}</span>
      <span className="block font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}

function MetricChart({
  points,
  metric,
  start,
  end,
}: {
  points: MetricPoint[];
  metric: MetricKind;
  start: number;
  end: number;
}) {
  const { t } = useTranslation();
  const width = 720;
  const height = 300;
  const padding = { left: 56, right: 18, top: 22, bottom: 34 };
  const first = points.map((point) => primaryMetricValue(point, metric)).filter(finite);
  const second = points.map((point) => secondaryMetricValue(point, metric)).filter(finite);
  const max = Math.max(1, ...first, ...second);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (timestamp: number) =>
    padding.left + ((timestamp - start) / Math.max(1, end - start)) * plotWidth;
  const y = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;
  const path = (accessor: (point: MetricPoint) => number | undefined) => {
    let value = '';
    let previousTimestamp = 0;
    for (const point of points) {
      const metricValue = accessor(point);
      if (!finite(metricValue)) {
        previousTimestamp = 0;
        continue;
      }
      const command =
        previousTimestamp && point.timestamp - previousTimestamp <= METRIC_INTERVAL * 2.5
          ? 'L'
          : 'M';
      value += `${command}${x(point.timestamp).toFixed(2)},${y(metricValue).toFixed(2)} `;
      previousTimestamp = point.timestamp;
    }
    return value.trim();
  };
  const primaryPath = path((point) => primaryMetricValue(point, metric));
  const secondaryPath = path((point) => secondaryMetricValue(point, metric));
  return (
    <div className="flex min-h-0 flex-col px-4 py-3">
      <div className="min-h-0 flex-1">
        <svg
          role="img"
          aria-label={t('serviceManagerTool.metrics.chartLabel', {
            metric: t(`serviceManagerTool.metrics.metric.${metric}`),
          })}
          viewBox={`0 0 ${width} ${height}`}
          className="h-full min-h-52 w-full text-foreground"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((step) => {
            const lineY = padding.top + plotHeight * step;
            const label = formatMetric(max * (1 - step), metric);
            return (
              <g key={step}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={lineY}
                  y2={lineY}
                  className="stroke-border"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={padding.left - 8}
                  y={lineY + 3}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {label}
                </text>
              </g>
            );
          })}
          <path
            d={primaryPath}
            fill="none"
            className="stroke-foreground"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          {secondaryPath ? (
            <path
              d={secondaryPath}
              fill="none"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          <text x={padding.left} y={height - 10} className="fill-muted-foreground text-[10px]">
            {new Date(start).toLocaleTimeString()}
          </text>
          <text
            x={width - padding.right}
            y={height - 10}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            {new Date(end).toLocaleTimeString()}
          </text>
        </svg>
      </div>
      {metric === 'network' || metric === 'disk' ? (
        <div className="flex justify-end gap-4 text-[10px] text-muted-foreground">
          <span>
            <span className="mr-1 inline-block w-4 border-t border-foreground align-middle" />
            {t(`serviceManagerTool.metrics.legend.${metric === 'network' ? 'received' : 'read'}`)}
          </span>
          <span>
            <span className="mr-1 inline-block w-4 border-t border-dashed border-muted-foreground align-middle" />
            {t(`serviceManagerTool.metrics.legend.${metric === 'network' ? 'sent' : 'written'}`)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
