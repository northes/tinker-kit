const minimumEstimableSpeed = 1;

export { formatTaskBytes } from './byte-format.ts';

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
