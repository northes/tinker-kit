const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB'];

// 文件、镜像按 1024 换算，服务指标按 1000 换算；各自保留原来的精度与空值语义。
function scaleBytes(value: number, base: 1000 | 1024) {
  let amount = value;
  let unit = 0;
  while (amount >= base && unit < byteUnits.length - 1) {
    amount /= base;
    unit += 1;
  }
  return { amount, unit };
}

export function formatFileBytes(value: number, precise = false) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const { amount, unit } = scaleBytes(value, 1024);
  const fractionDigits = precise && unit > 1 ? 1 : amount >= 10 ? 0 : 1;
  const formatted = amount.toFixed(fractionDigits);
  return `${precise ? formatted.replace(/\.0$/, '') : formatted} ${byteUnits[unit]}`;
}

export function formatImageBytes(bytes: number, locale: string) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const { amount, unit } = scaleBytes(bytes, 1024);
  return `${amount.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${byteUnits[unit]}`;
}

export function formatMetricBytes(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const { amount, unit } = scaleBytes(Math.max(0, value), 1000);
  const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${byteUnits[unit]}`;
}

export function formatTaskBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1) return '<1 B';

  const unit = Math.min(
    byteUnits.length - 1,
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
  );
  const digits = unit === 0 ? 0 : 1;
  return `${(bytes / 1024 ** unit).toFixed(digits)} ${byteUnits[unit]}`;
}
