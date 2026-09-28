import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LogMonitor,
  ServiceMetricSample,
  ServiceTarget,
} from '../../bindings/changeme/models';
import { useServiceMetricTrend } from '../hooks/useServiceMetricTrend';
import { formatBytes } from './ServiceMetricChart';
import { ScrollArea } from './ui/scroll-area';
import { Spinner } from './ui/spinner';

function metricKey(monitor: LogMonitor) {
  return `${monitor.targetID}|resource|${monitor.resource.runtime}|${monitor.resource.id}`;
}

export function ServiceWorkspacePerformance({
  enabled,
  monitors,
  targets,
  onSelectResource,
}: {
  enabled: boolean;
  monitors: LogMonitor[];
  targets: ServiceTarget[];
  onSelectResource: (monitor: LogMonitor) => void;
}) {
  const { t } = useTranslation();
  const targetIDs = useMemo(() => [...new Set(monitors.map((item) => item.targetID))], [monitors]);
  const { snapshots, history, loading, error } = useServiceMetricTrend({ enabled, targetIDs });
  const samples = new Map<string, ServiceMetricSample>();
  for (const snapshot of snapshots) {
    for (const sample of snapshot.samples ?? []) {
      if (sample.kind === 'resource')
        samples.set(`${sample.targetID}|resource|${sample.runtime}|${sample.id}`, sample);
    }
  }
  const targetNames = new Map(
    targets.map((item) => [
      item.id,
      item.kind === 'local' ? t('serviceManagerTool.localTarget') : item.name,
    ]),
  );
  const cpu = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] gap-2 border-b px-4 py-2 text-[10px] font-medium text-muted-foreground">
        <span>{t('serviceManagerTool.metrics.name')}</span>
        <span className="text-right">{t('serviceManagerTool.metrics.metric.cpu')}</span>
        <span className="text-right">{t('serviceManagerTool.metrics.metric.memory')}</span>
      </div>
      {error ? (
        <p className="border-b px-4 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        {!monitors.length ? (
          <p className="px-4 py-5 text-center text-xs text-muted-foreground">
            {t('serviceManagerTool.workspaceEmpty')}
          </p>
        ) : null}
        {monitors.map((monitor) => {
          const key = metricKey(monitor);
          const sample = samples.get(key);
          const point = history.get(key)?.at(-1);
          return (
            <button
              key={monitor.id}
              type="button"
              className="grid w-full grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 border-b px-4 py-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectResource(monitor)}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {monitor.resource.name || monitor.resource.id}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {targetNames.get(monitor.targetID) ?? t('serviceManagerTool.targetUnavailable')}
                  {sample?.status ? ` · ${sample.status}` : ''}
                </span>
              </span>
              <span className="text-right tabular-nums">
                {cpu(point?.cpu ?? sample?.cpuPercent)}
              </span>
              <span className="text-right tabular-nums">
                {formatBytes(point?.memory ?? sample?.memoryBytes)}
              </span>
            </button>
          );
        })}
        {!snapshots.length && loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Spinner className="size-4" />
            {t('serviceManagerTool.metrics.loading')}
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
