import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileTask } from '../../../bindings/tinkerkit/models';
import {
  formatBytes,
  progressMaxCatchUpDuration,
  progressMinCatchUpDuration,
  taskPercent,
} from './model';

type ProgressAnimation = {
  from: number;
  to: number;
  startedAt: number;
  duration: number;
};

function progressCatchUpDuration(interval: number) {
  return Math.max(progressMinCatchUpDuration, Math.min(progressMaxCatchUpDuration, interval));
}

function useDisplayedTaskCompleted(task: FileTask) {
  const smooth = task.type === 'download';
  const [displayed, setDisplayed] = useState(task.completed);
  const displayedRef = useRef(task.completed);
  const animationRef = useRef<ProgressAnimation | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTargetAtRef = useRef<number | null>(null);

  const animate = useCallback((now: number) => {
    frameRef.current = null;
    const animation = animationRef.current;
    if (!animation) return;

    const elapsed = Math.max(0, now - animation.startedAt);
    const ratio = Math.min(1, elapsed / animation.duration);
    const next =
      ratio >= 1
        ? animation.to
        : Math.round(animation.from + (animation.to - animation.from) * ratio);
    if (next !== displayedRef.current) {
      displayedRef.current = next;
      setDisplayed(next);
    }

    if (ratio < 1) {
      frameRef.current = requestAnimationFrame(animate);
    } else {
      animationRef.current = null;
    }
  }, []);

  useEffect(() => {
    const target = task.completed;
    const current = displayedRef.current;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!smooth || reducedMotion || target <= current) {
      animationRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (target !== current) {
        displayedRef.current = target;
        setDisplayed(target);
      }
      return;
    }

    if (animationRef.current?.to === target) return;
    const now = performance.now();
    const lastTargetAt = lastTargetAtRef.current;
    lastTargetAtRef.current = now;
    animationRef.current = {
      from: current,
      to: target,
      startedAt: now,
      duration: progressCatchUpDuration(
        lastTargetAt === null ? progressMinCatchUpDuration : now - lastTargetAt,
      ),
    };
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(animate);
    }
  }, [animate, smooth, task.completed]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return displayed;
}

function taskUsesByteProgress(task: FileTask) {
  return task.type === 'download' || task.type === 'compress' || task.type === 'extract';
}

export function TaskProgressMeter({
  task,
  compact = false,
}: {
  task: FileTask;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const completed = useDisplayedTaskCompleted(task);
  const percent = taskPercent(task, completed);
  const running = ['queued', 'running', 'scanning'].includes(task.status);
  const progressWidth = percent ?? (task.status === 'success' ? 100 : 0);

  if (compact) {
    return (
      <span
        className={`relative h-1.5 w-20 overflow-hidden rounded-full bg-muted ${percent === null ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${progressWidth}%` }}
        />
      </span>
    );
  }

  const progressText =
    task.type === 'extract' && task.total <= 0
      ? t('sshFilesTool.taskExtractedUnknown', {
          completed: formatBytes(completed),
        })
      : taskUsesByteProgress(task)
        ? t('sshFilesTool.taskBytes', {
            completed: formatBytes(completed, task.type === 'download'),
            total: task.total ? formatBytes(task.total) : '—',
          })
        : task.files > 0
          ? t('sshFilesTool.taskFiles', {
              done: task.doneFiles,
              total: task.files,
            })
          : t('sshFilesTool.taskBytes', {
              completed: formatBytes(completed),
              total: task.total ? formatBytes(task.total) : '—',
            });

  return (
    <div className="mt-2 flex items-center gap-2">
      <div
        className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ${percent === null && running ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={progressText}
      >
        <div
          className={`h-full rounded-full ${task.status === 'success' ? 'bg-success' : task.status === 'failed' ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${progressWidth}%` }}
        />
      </div>
      <span className="flex-none font-mono text-[10px] text-muted-foreground">{progressText}</span>
    </div>
  );
}
