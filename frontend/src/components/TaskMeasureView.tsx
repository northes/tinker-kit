import { useTranslation } from 'react-i18next';
import {
  formatTaskBytes,
  formatTaskDuration,
  taskMeasureFill,
  taskMeasurePercent,
  taskMeasureRemainingSeconds,
  type TaskMeasure,
} from '../lib/task-format';

export function TaskMeasureFill({
  measure,
  status,
  active,
}: {
  measure: TaskMeasure;
  status: string;
  active: boolean;
}) {
  const fill = taskMeasureFill(taskMeasurePercent(measure, status), active);
  return (
    <div
      aria-hidden="true"
      className="absolute inset-y-0 left-0 bg-primary/10 transition-[width] motion-reduce:transition-none"
      style={{ width: `${fill}%` }}
    />
  );
}

export function TaskMeasureReadout({
  measure,
  speed,
  status,
  active,
}: {
  measure: TaskMeasure;
  speed: number;
  status: string;
  active: boolean;
}) {
  const { t, i18n } = useTranslation();
  const percent = taskMeasurePercent(measure, status);
  const measureText =
    measure.unit === 'bytes' && measure.total > 0
      ? `${formatTaskBytes(measure.current)} / ${formatTaskBytes(measure.total)}`
      : measure.unit === 'files' && measure.total > 0
        ? t('taskCenter.filesProgress', { done: measure.current, total: measure.total })
        : measure.unit === 'count' && measure.total > 0
          ? t('imageManagerTool.taskProgressCount', {
              completed: measure.current,
              total: measure.total,
            })
          : '—';
  const speedText =
    active && speed > 0 && measure.unit === 'bytes' ? `${formatTaskBytes(speed)}/s` : '—';
  const remaining = taskMeasureRemainingSeconds(measure, speed, active);
  const remainingText = remaining === null ? '—' : formatTaskDuration(remaining);
  const percentText =
    percent === null
      ? '—'
      : `${percent.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 })}%`;

  return (
    <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:grid-cols-[10rem_3.5rem_5.5rem_5.5rem]">
      <span
        className="min-w-0 whitespace-normal sm:whitespace-nowrap"
        title={measureText}
        aria-label={t('taskCenter.itemProgress', { value: measureText })}
      >
        {measureText}
      </span>
      <span className="text-right" aria-label={t('taskCenter.itemPercent', { value: percentText })}>
        {percentText}
      </span>
      <span className="text-right" aria-label={t('taskCenter.itemSpeed', { value: speedText })}>
        {speedText}
      </span>
      <span
        className="text-right"
        aria-label={t('taskCenter.itemRemaining', { value: remainingText })}
      >
        {t('taskCenter.itemRemainingShort', { duration: remainingText })}
      </span>
    </div>
  );
}
