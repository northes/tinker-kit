import { PushPin, X } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '../components/ui/button';
import type { TabCloseButton } from './workspace-tabs';
import type { WorkspaceTabStripMotion } from './useWorkspaceTabStripMotion';

const BASE_WIDTH_VAR = '--workspace-tab-base-width';
const WIDTH_STEPS = [112, 128, 148, 168, 196] as const;
const BASE_MIN = 112;
const BASE_MAX = 240;
const BASE_DEFAULT = 128;

export type WorkspaceTabFitLabel = {
  id: string;
  label: string;
  pinned: boolean;
};

// 非数字回默认档。其余取最近档位；距离相同留更小的一档，与 Go normalizeTabWidth 一致。
export function normalizeWorkspaceTabWidth(value: number) {
  if (!Number.isFinite(value)) return BASE_DEFAULT;
  let nearest: number = WIDTH_STEPS[0];
  for (const step of WIDTH_STEPS) {
    if (Math.abs(value - step) < Math.abs(value - nearest)) nearest = step;
  }
  return nearest;
}

function clampBaseWidth(value: number) {
  return Math.min(BASE_MAX, Math.max(BASE_MIN, value));
}

let widthSnapGeneration = 0;
let widthSnapKey = '';

// 高亮的位移过渡会把宽度变化滑成动画。落地后两帧内关掉，给高亮跟上新位置。
function holdWorkspaceTabWidthSnap() {
  const root = document.documentElement;
  root.dataset.workspaceTabWidthSnap = '';
  const generation = ++widthSnapGeneration;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (generation !== widthSnapGeneration) return;
      delete root.dataset.workspaceTabWidthSnap;
    });
  });
}

// 图标开关会改实际宽度但不一定改基础宽度。只在这组输入变化时压住高亮过渡。
export function noteWorkspaceTabWidthInputs(key: string) {
  if (key === widthSnapKey) return;
  widthSnapKey = key;
  holdWorkspaceTabWidthSnap();
}

// 只在数值变化时写变量。
export function applyWorkspaceTabBaseWidth(px: number) {
  const root = document.documentElement;
  const next = `${px}px`;
  if (root.style.getPropertyValue(BASE_WIDTH_VAR).trim() === next) return;
  root.style.setProperty(BASE_WIDTH_VAR, next);
  holdWorkspaceTabWidthSnap();
}

function measureLongestTab(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>('[data-workspace-tab-measure]');
  let max = 0;
  for (const node of nodes) {
    const width = node.getBoundingClientRect().width;
    if (width > max) max = width;
  }
  if (max <= 0) return null;
  return clampBaseWidth(Math.ceil(max));
}

function WorkspaceTabMeasure({
  label,
  pinned,
  reserveClose,
}: {
  label: string;
  pinned: boolean;
  reserveClose: boolean;
}) {
  return (
    <div
      data-workspace-tab-measure=""
      className="flex h-7 w-max items-center text-left text-xs whitespace-nowrap"
    >
      {/* 与标签表面同一套间距。图标的 20px 由 data-show-tab-icons 加到基础宽度上，这里再画会算两次。 */}
      <span className="flex items-center gap-1.5 pl-2">
        {pinned ? (
          <PushPin size={12} weight="regular" className="shrink-0" aria-hidden />
        ) : null}
        <span className="shrink-0 whitespace-nowrap">{label}</span>
      </span>
      {reserveClose ? (
        <span className="flex shrink-0 items-center pl-6 pr-1">
          <Button variant="ghost" size="icon-xs" tabIndex={-1}>
            <X size={14} weight="regular" aria-hidden />
          </Button>
        </span>
      ) : (
        <span className="w-2 shrink-0" />
      )}
    </div>
  );
}

// 测量写在补位 effect 之前：同一帧里开合动画读到的是新宽度下的位置。
// hold 在渲染末尾更新，effect 运行时已经是这一帧的补位状态。
export function useWorkspaceTabFitWidth({
  enabled,
  labels,
  showIcons,
  closeButton,
  hold,
}: {
  enabled: boolean;
  labels: readonly WorkspaceTabFitLabel[];
  showIcons: boolean;
  closeButton: TabCloseButton;
  hold: RefObject<WorkspaceTabStripMotion | null>;
}) {
  const probeRef = useRef<HTMLDivElement>(null);
  const pendingWidthRef = useRef<number | null>(null);
  const [fontEpoch, setFontEpoch] = useState(0);

  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    let alive = true;
    const bump = () => {
      if (alive) setFontEpoch((value) => value + 1);
    };
    fonts.addEventListener('loadingdone', bump);
    void fonts.ready.then(bump);
    return () => {
      alive = false;
      fonts.removeEventListener('loadingdone', bump);
    };
  }, []);

  const contentKey = labels
    .map((item) => `${item.id}\u001f${item.pinned ? '1' : '0'}\u001f${item.label}`)
    .join('\u001e');
  const signature = `${contentKey}\u001d${closeButton}\u001d${showIcons ? '1' : '0'}\u001d${fontEpoch}`;

  useLayoutEffect(() => {
    if (!enabled) return;
    const probe = probeRef.current;
    if (!probe) return;
    const base = measureLongestTab(probe);
    if (base == null) return;
    pendingWidthRef.current = base;
    // 补位已经记下位移后再改宽度，会让那一帧的落点对不上。等动画结束再补写。
    if (hold.current) return;
    applyWorkspaceTabBaseWidth(base);
  }, [enabled, hold, signature]);

  const probe: ReactNode = (
    <div
      ref={probeRef}
      aria-hidden
      inert
      data-workspace-tab-probe=""
      className="pointer-events-none invisible fixed top-0 left-0 -z-10 flex flex-col items-start"
    >
      {enabled
        ? labels.map((item) => (
            <WorkspaceTabMeasure
              key={item.id}
              label={item.label}
              pinned={item.pinned}
              reserveClose={closeButton !== 'never'}
            />
          ))
        : null}
    </div>
  );

  return { probe, pendingWidthRef };
}

// 补位进行中跳过的那次宽度，在动画结束后一次性写上。
export function useFlushWorkspaceTabFitWidth(
  enabled: boolean,
  tabMotion: WorkspaceTabStripMotion | null,
  pendingWidthRef: RefObject<number | null>,
) {
  useLayoutEffect(() => {
    if (!enabled || tabMotion) return;
    const base = pendingWidthRef.current;
    if (base == null) return;
    applyWorkspaceTabBaseWidth(base);
  }, [enabled, pendingWidthRef, tabMotion]);
}
