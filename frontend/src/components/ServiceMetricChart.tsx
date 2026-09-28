import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SERVICE_METRIC_INTERVAL, type ServiceMetricPoint } from '../hooks/useServiceMetricTrend';

export type MetricKind = 'cpu' | 'memory' | 'network' | 'disk';

type MetricPoint = ServiceMetricPoint;

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// 与 Go 端 serviceMetricInterval 对应；超过该间隔数倍的采样空档在图上断线显示。
const METRIC_GAP_MS = SERVICE_METRIC_INTERVAL * 12;

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

export function formatBytes(value: number | null | undefined) {
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

function formatRate(value: number | null | undefined) {
  return finite(value) ? `${formatBytes(value)}/s` : '—';
}

function formatMetric(value: number | null | undefined, metric: MetricKind) {
  if (!finite(value)) return '—';
  if (metric === 'cpu') return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
  return metric === 'memory' ? formatBytes(value) : formatRate(value);
}

function availabilityText(status: string, t: ReturnType<typeof useTranslation>['t']) {
  const known = ['unsupported', 'unavailable', 'stopped', 'partial', 'accounting-disabled'];
  const key = known.includes(status) ? status : 'unavailable';
  return t(`serviceManagerTool.metrics.availability.${key}`);
}

function MetricStat({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[10px] font-normal text-muted-foreground/70">{label}</span>
      <span className={emphasize ? 'text-foreground' : undefined}>{value}</span>
    </span>
  );
}

export function MetricLineChart({
  metric,
  availability,
  points,
  start,
  end,
}: {
  metric: MetricKind;
  availability: string;
  points: MetricPoint[];
  start: number;
  end: number;
}) {
  const { t } = useTranslation();
  const label = t(`serviceManagerTool.metrics.metric.${metric}`);
  const hasSecondary = metric === 'network' || metric === 'disk';
  const data = useMemo(() => {
    const rows: Array<{ timestamp: number; primary: number | null; secondary: number | null }> = [];
    let previous = 0;
    for (const point of points) {
      if (previous && point.timestamp - previous > METRIC_GAP_MS) {
        rows.push({ timestamp: previous + 1, primary: null, secondary: null });
      }
      rows.push({
        timestamp: point.timestamp,
        primary: primaryMetricValue(point, metric) ?? null,
        secondary: hasSecondary ? (secondaryMetricValue(point, metric) ?? null) : null,
      });
      previous = point.timestamp;
    }
    return rows;
  }, [hasSecondary, metric, points]);
  const values = useMemo(() => data.map((item) => item.primary).filter(finite), [data]);
  const current = values.at(-1);
  const max = values.length ? Math.max(...values) : undefined;
  const average = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
  const valueFormatter = (value: number | null | undefined) => formatMetric(value, metric);
  const timeFormatter = (value: number) => new Date(value).toLocaleTimeString();
  const legendPrimary = t(
    `serviceManagerTool.metrics.legend.${metric === 'network' ? 'received' : 'read'}`,
  );
  const legendSecondary = t(
    `serviceManagerTool.metrics.legend.${metric === 'network' ? 'sent' : 'written'}`,
  );
  const hasData = data.length > 0 && current !== undefined;
  const dot = data.length > 1 ? false : { r: 2.5, strokeWidth: 0 };
  const emptyText =
    availability === 'available'
      ? t('serviceManagerTool.metrics.collecting')
      : availabilityText(availability, t);
  return (
    <section className="border-b px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium">{label}</span>
        {hasData ? (
          <div className="flex items-baseline gap-3 font-mono text-xs tabular-nums text-muted-foreground">
            <MetricStat
              label={t('serviceManagerTool.performance.statCurrent')}
              value={valueFormatter(current)}
              emphasize
            />
            <MetricStat
              label={t('serviceManagerTool.performance.statMax')}
              value={valueFormatter(max)}
            />
            <MetricStat
              label={t('serviceManagerTool.performance.statAvg')}
              value={valueFormatter(average)}
            />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{emptyText}</span>
        )}
      </div>
      {hasData ? (
        <div
          role="img"
          aria-label={t('serviceManagerTool.metrics.chartLabel', { metric: label })}
          className="mt-2 h-36 w-full"
        >
          <ResponsiveContainer width="100%" height="100%">
            <RechartsLineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timestamp"
                domain={[start, end]}
                minTickGap={48}
                scale="time"
                stroke="var(--border)"
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickFormatter={timeFormatter}
                type="number"
              />
              <YAxis
                allowDecimals
                stroke="var(--border)"
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickFormatter={valueFormatter}
                width={56}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--popover)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value) => valueFormatter(Number(value))}
                isAnimationActive={false}
                labelFormatter={(value) => timeFormatter(Number(value))}
              />
              <Line
                connectNulls={false}
                dataKey="primary"
                dot={dot}
                isAnimationActive={false}
                name={hasSecondary ? legendPrimary : label}
                stroke="var(--chart-1)"
                strokeWidth={1.5}
                type="monotone"
              />
              {hasSecondary ? (
                <Line
                  connectNulls={false}
                  dataKey="secondary"
                  dot={dot}
                  isAnimationActive={false}
                  name={legendSecondary}
                  stroke="var(--chart-2)"
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  type="monotone"
                />
              ) : null}
            </RechartsLineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-2 grid h-36 place-items-center px-6 text-center text-xs text-muted-foreground">
          {emptyText}
        </div>
      )}
      {hasSecondary && hasData ? (
        <div className="mt-1 flex justify-end gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t border-chart-1" />
            {legendPrimary}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t border-dashed border-chart-2" />
            {legendSecondary}
          </span>
        </div>
      ) : null}
    </section>
  );
}
