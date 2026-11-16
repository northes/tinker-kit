import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  clampTabStripWidth,
  DEFAULT_TAB_STRIP_WIDTH,
  MAX_TAB_STRIP_WIDTH,
  MIN_TAB_STRIP_WIDTH,
} from './workspace-tabs';

// 纵向标签条右侧的分隔线。拖动只改标签条宽度，松手才写回设置。
export function TabStripResizer({
  width,
  onPreview,
  onCommit,
}: {
  width: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const { t } = useTranslation();
  const origin = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;
  const commit = (next: number) => {
    onPreview(next);
    onCommit(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('workspaceTabs.resizeStrip')}
      aria-valuemin={MIN_TAB_STRIP_WIDTH}
      aria-valuemax={MAX_TAB_STRIP_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      data-workspace-tab-resizer=""
      className={cn(
        'absolute inset-y-0 -right-[3px] z-30 w-[6px] cursor-col-resize',
        '[--wails-draggable:no-drag] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        origin.current = { x: event.clientX, width: latest.current };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (!start) return;
        onPreview(clampTabStripWidth(start.width + (event.clientX - start.x)));
      }}
      onPointerUp={(event) => {
        if (!origin.current) return;
        origin.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        commit(latest.current);
      }}
      onPointerCancel={() => {
        origin.current = null;
      }}
      onDoubleClick={() => commit(DEFAULT_TAB_STRIP_WIDTH)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 8 : -8;
        commit(clampTabStripWidth(latest.current + delta));
      }}
    />
  );
}
