import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WarningCircle } from '@phosphor-icons/react';
import { enUS, zhCN } from 'date-fns/locale';
import type { ServiceMetricSample, ServiceResourceRef } from '../../bindings/changeme/models';
import { useServiceMetricTrend } from '../hooks/useServiceMetricTrend';
import DateTimePickerPopover from './DateTimePickerPopover';
import { MetricLineChart, type MetricKind } from './ServiceMetricChart';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Spinner } from './ui/spinner';

// 资源详情里的性能页展示 CPU、内存、网络与磁盘 I/O，按当前资源过滤监听点。
const RESOURCE_METRICS: MetricKind[] = ['cpu', 'memory', 'network', 'disk'];

type RangeValue = '5' | '10' | '30' | '60' | 'custom';
const RANGE_VALUES: RangeValue[] = ['5', '10', '30', '60', 'custom'];
const MINUTE_MS = 60_000;
// 自定义范围的时间选择器沿用资源详情里的紧凑输入外观。
const PICKER_TRIGGER_CLASS =
  'h-8 w-full justify-start gap-2 rounded-lg border border-input bg-transparent px-2.5 text-xs font-normal dark:bg-input/30';

function sampleKey(sample: ServiceMetricSample) {
  return `${sample.targetID}|${sample.kind}|${sample.runtime}|${sample.id}`;
}

// 日期时间选择器按本地时区拆出日期与 HH:mm:ss。
function datetimeParts(value: Date) {
  const pad = (part: number) => String(part).padStart(2, '0');
  return {
    date: new Date(value.getFullYear(), value.getMonth(), value.getDate()),
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  };
}

function parseDatetime(date: Date, time: string) {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(':').map(Number);
  const next = new Date(date);
  next.setHours(hours, minutes, seconds, 0);
  return Number.isNaN(next.getTime()) ? null : next;
}

export function ServiceResourcePerformance({
  enabled,
  targetID,
  resource,
  sampleKind = 'resource',
}: {
  enabled: boolean;
  targetID: string;
  resource: ServiceResourceRef;
  sampleKind?: 'resource' | 'source';
}) {
  const { t, i18n } = useTranslation();
  const pickerLocale = i18n.language === 'zh-CN' ? zhCN : enUS;
  const targetIDs = useMemo(() => [targetID], [targetID]);
  const { snapshots, history, loading, error, version } = useServiceMetricTrend({
    enabled,
    targetIDs,
  });
  const [range, setRange] = useState<RangeValue>('5');
  const [customStart, setCustomStart] = useState(() => new Date(Date.now() - 30 * MINUTE_MS));
  const [customEnd, setCustomEnd] = useState(() => new Date());

  const kind = resource.runtime === 'docker-compose' ? 'compose' : sampleKind;
  const key = `${targetID}|${kind}|${resource.runtime}|${resource.id}`;
  const availability = useMemo(() => {
    for (const snapshot of snapshots) {
      for (const sample of snapshot.samples ?? []) {
        if (sampleKey(sample) === key) return sample.availability;
      }
    }
    return null;
    // version 变化意味着有新采样，需要重新匹配可用性。
  }, [key, snapshots, version]);

  const points = history.get(key) ?? [];
  const lastTimestamp = points.at(-1)?.timestamp ?? Date.now();
  // 自定义范围最早只能选到内存中该资源的最早采样，最晚不超过当前时间。
  const earliestTimestamp = points.at(0)?.timestamp;
  const minDate = earliestTimestamp === undefined ? undefined : new Date(earliestTimestamp);
  const maxDate = new Date(Date.now());
  let start: number;
  let end: number;
  if (range === 'custom') {
    start = Math.max(customStart.getTime(), minDate?.getTime() ?? Number.NEGATIVE_INFINITY);
    end = Math.min(Math.max(customEnd.getTime(), start), maxDate.getTime());
  } else {
    end = lastTimestamp;
    start = end - Number(range) * MINUTE_MS;
  }
  const windowPoints = points.filter((point) => point.timestamp >= start && point.timestamp <= end);
  const axisEnd = Math.max(end, start + 1);
  const waiting = loading && !points.length;

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-end gap-3 border-b px-4 py-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[10px] font-medium text-muted-foreground">
            {t('serviceManagerTool.performance.rangeLabel')}
          </span>
          <Select
            items={RANGE_VALUES.map((value) => ({
              value,
              label: t(`serviceManagerTool.performance.ranges.${value}`),
            }))}
            value={range}
            onValueChange={(value) => {
              if (value) setRange(value as RangeValue);
            }}
          >
            <SelectTrigger className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RANGE_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`serviceManagerTool.performance.ranges.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        {range === 'custom' ? (
          <>
            <label className="flex w-52 min-w-0 flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                {t('serviceManagerTool.performance.startAt')}
              </span>
              <DateTimePickerPopover
                value={customStart}
                locale={pickerLocale}
                triggerLabel={t('serviceManagerTool.performance.startAt')}
                timeLabel={t('serviceManagerTool.performance.pickerTime')}
                cancelLabel={t('common.cancel')}
                applyLabel={t('serviceManagerTool.performance.pickerApply')}
                showValue
                triggerClassName={PICKER_TRIGGER_CLASS}
                minDate={minDate}
                maxDate={maxDate}
                getParts={datetimeParts}
                parse={parseDatetime}
                onChange={setCustomStart}
              />
            </label>
            <label className="flex w-52 min-w-0 flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                {t('serviceManagerTool.performance.endAt')}
              </span>
              <DateTimePickerPopover
                value={customEnd}
                locale={pickerLocale}
                triggerLabel={t('serviceManagerTool.performance.endAt')}
                timeLabel={t('serviceManagerTool.performance.pickerTime')}
                cancelLabel={t('common.cancel')}
                applyLabel={t('serviceManagerTool.performance.pickerApply')}
                showValue
                triggerClassName={PICKER_TRIGGER_CLASS}
                minDate={minDate}
                maxDate={maxDate}
                getParts={datetimeParts}
                parse={parseDatetime}
                onChange={setCustomEnd}
              />
            </label>
          </>
        ) : null}
      </div>
      {error ? (
        <div className="grid h-full min-h-0 place-items-center px-6 text-center text-xs text-destructive">
          <span className="flex items-center gap-2">
            <WarningCircle className="size-3.5" />
            {error}
          </span>
        </div>
      ) : !windowPoints.length ? (
        <div className="grid h-full min-h-0 place-items-center px-6 text-center text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {waiting ? <Spinner className="size-4" /> : null}
            {waiting
              ? t('serviceManagerTool.metrics.loading')
              : t('serviceManagerTool.performance.empty')}
          </span>
        </div>
      ) : (
        <ScrollArea className="h-full min-h-0">
          <div className="flex flex-col">
            {RESOURCE_METRICS.map((metric) => (
              <MetricLineChart
                key={metric}
                metric={metric}
                availability={availability?.[metric] ?? 'unavailable'}
                points={windowPoints}
                start={start}
                end={axisEnd}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
