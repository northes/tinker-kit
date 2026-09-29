const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB'];

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
