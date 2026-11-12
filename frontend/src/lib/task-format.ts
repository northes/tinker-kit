const minimumEstimableSpeed = 1;

export { formatTaskBytes } from './byte-format.ts';

export type TaskMeasureUnit = 'bytes' | 'count' | 'files';

/** 任务进度只由当前值和总量决定。总量不大于 0 时界面显示不确定进度。 */
export type TaskMeasure = {
  current: number;
  total: number;
  unit: TaskMeasureUnit;
};

export function formatTaskDuration(seconds: number) {
  const duration = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const remainingSeconds = duration % 60;
  const pad = (value: number) => String(value).padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(remainingSeconds)}`
    : `${minutes}:${pad(remainingSeconds)}`;
}

export function imageTaskMeasure(task: {
  progressUnit: string;
  bytes: number;
  completed: number;
  total: number;
}): TaskMeasure {
  if (task.progressUnit === 'bytes') {
    return { current: task.bytes, total: task.total, unit: 'bytes' };
  }
  return { current: task.completed, total: task.total, unit: 'count' };
}

export function fileTaskMeasure(task: {
  completed: number;
  total: number;
  files: number;
  doneFiles: number;
}): TaskMeasure {
  if (task.total > 0) return { current: task.completed, total: task.total, unit: 'bytes' };
  if (task.files > 0) return { current: task.doneFiles, total: task.files, unit: 'files' };
  return { current: 0, total: 0, unit: 'bytes' };
}

export function taskMeasurePercent(measure: TaskMeasure, status: string) {
  if (status === 'success') return 100;
  if (!(measure.total > 0) || !Number.isFinite(measure.current) || !Number.isFinite(measure.total)) {
    return null;
  }
  return Math.min(100, (Math.max(0, measure.current) / measure.total) * 100);
}

export function taskMeasureFill(percent: number | null, active: boolean) {
  if (percent === null) return active ? 100 : 0;
  return percent;
}

export function taskMeasureRemainingSeconds(measure: TaskMeasure, speed: number, active: boolean) {
  if (!active || measure.unit !== 'bytes' || !(measure.total > 0)) return null;
  return estimateTaskRemainingSeconds(Math.max(0, measure.total - measure.current), speed);
}

export type TaskMeasureSummary = {
  percent: number | null;
  remainingBytes: number | null;
};

function measureKind(unit: TaskMeasureUnit) {
  return unit === 'bytes' ? 'bytes' : 'count';
}

/** 全部任务都有总量且单位同类时才汇总；字节和计数不能相加。 */
export function summarizeTaskMeasures(measures: TaskMeasure[]): TaskMeasureSummary {
  if (measures.length === 0 || measures.some((measure) => !(measure.total > 0))) {
    return { percent: null, remainingBytes: null };
  }
  const kinds = new Set(measures.map((measure) => measureKind(measure.unit)));
  if (kinds.size !== 1) return { percent: null, remainingBytes: null };
  const total = measures.reduce((sum, measure) => sum + measure.total, 0);
  const current = measures.reduce(
    (sum, measure) => sum + Math.min(Math.max(0, measure.current), measure.total),
    0,
  );
  if (!(total > 0)) return { percent: null, remainingBytes: null };
  return {
    percent: Math.min(100, (current / total) * 100),
    remainingBytes: kinds.has('bytes') ? Math.max(0, total - current) : null,
  };
}

export function estimateTaskRemainingSeconds(remainingBytes: number, speedBytesPerSecond: number) {
  if (
    !Number.isFinite(remainingBytes) ||
    !Number.isFinite(speedBytesPerSecond) ||
    remainingBytes < 0 ||
    speedBytesPerSecond < minimumEstimableSpeed
  ) {
    return null;
  }

  return Math.ceil(remainingBytes / speedBytesPerSecond);
}
