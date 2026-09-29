const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB'];
const minimumEstimableSpeed = 1;

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
