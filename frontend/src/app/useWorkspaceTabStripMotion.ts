import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { RefObject } from 'react';

/** 与 foundation.css 的 --motion-slide-duration 对齐，多留一点再摘掉过渡。 */
const SLIDE_CLEAR_MS = 280;
const SHIFT_EPSILON = 0.5;

const EMPTY_SHIFTS: ReadonlyMap<string, number> = new Map();
const EMPTY_IDS: ReadonlySet<string> = new Set();

export type WorkspaceTabStripMotion = {
  /** from：停在旧位置且关掉过渡。arm：过渡已装上但仍停住。play：滑向新位置。 */
  phase: 'from' | 'arm' | 'play';
  shifts: ReadonlyMap<string, number>;
  entering: ReadonlySet<string>;
  sliding: ReadonlySet<string>;
};

type Point = { x: number; y: number };

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function sameIdSet(prev: readonly string[], next: readonly string[]) {
  if (prev.length !== next.length) return false;
  const seen = new Set(next);
  return prev.every((id) => seen.has(id));
}

function tabSurface(node: HTMLElement | undefined) {
  return node?.querySelector<HTMLElement>('[data-workspace-tab-surface]') ?? null;
}

function axisOfTransform(transform: string) {
  if (!transform || transform === 'none') return 0;
  const matrix3d = transform.startsWith('matrix3d(');
  const matrix = transform.startsWith('matrix(');
  if (!matrix3d && !matrix) return 0;
  const parts = transform
    .slice(transform.indexOf('(') + 1, -1)
    .split(',')
    .map((part) => Number(part.trim()));
  const value = matrix3d ? parts[12] : parts[4];
  return Number.isFinite(value) ? value : 0;
}

function measureTabs(ids: readonly string[], nodes: Map<string, HTMLElement>, list: HTMLElement) {
  const origin = list.getBoundingClientRect();
  const rects = new Map<string, Point>();
  for (const id of ids) {
    const node = nodes.get(id);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    rects.set(id, { x: rect.left - origin.left, y: rect.top - origin.top });
  }
  return rects;
}

function slidingIds(shifts: ReadonlyMap<string, number>, entering: ReadonlySet<string>) {
  const sliding = new Set<string>(entering);
  for (const id of shifts.keys()) sliding.add(id);
  return sliding;
}

export function useWorkspaceTabStripMotion({
  tabIds,
  tabNodes,
  listRef,
  viewportRef,
  draggingRef,
  dragging,
}: {
  tabIds: readonly string[];
  tabNodes: RefObject<Map<string, HTMLElement>>;
  listRef: RefObject<HTMLElement | null>;
  viewportRef: RefObject<HTMLElement | null>;
  draggingRef: RefObject<boolean>;
  dragging: boolean;
}) {
  const [motion, setMotion] = useState<WorkspaceTabStripMotion | null>(null);
  const prevIdsRef = useRef<string[] | null>(null);
  const prevRectsRef = useRef<Map<string, Point>>(new Map());
  const generationRef = useRef(0);
  const framesRef = useRef<number[]>([]);
  const clearTimerRef = useRef(0);
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  const idKey = tabIds.join('\0');

  const cancelScheduled = () => {
    for (const frame of framesRef.current) cancelAnimationFrame(frame);
    framesRef.current = [];
    window.clearTimeout(clearTimerRef.current);
  };

  useLayoutEffect(() => {
    // 下一次布局先停掉还没播完的补位，避免旧的 rAF 把新的 from 盖掉。
    cancelScheduled();
    const ids = tabIdsRef.current;
    const list = listRef.current;
    const nodes = tabNodes.current;
    if (list && nodes) {
      const currentRects = measureTabs(ids, nodes, list);
      const reduced = prefersReducedMotion();
      const prevIds = prevIdsRef.current;

      if (draggingRef.current || reduced || !prevIds) {
        prevIdsRef.current = ids.slice();
        prevRectsRef.current = currentRects;
        if (draggingRef.current || reduced) {
          generationRef.current += 1;
          setMotion((current) => (current ? null : current));
        }
      } else if (sameIdSet(prevIds, ids)) {
        prevIdsRef.current = ids.slice();
        prevRectsRef.current = currentRects;
        // 同一批标签换序不补位。拖拽换序交给 dnd-kit，并清掉还在播的开合。
        generationRef.current += 1;
        setMotion((current) => (current ? null : current));
      } else {
        const prevSet = new Set(prevIds);
        const nextSet = new Set(ids);
        const removed = prevIds.some((id) => !nextSet.has(id));
        const entering = new Set(ids.filter((id) => !prevSet.has(id)));
        const shifts = new Map<string, number>();

        if (removed) {
          for (const id of ids) {
            if (!prevSet.has(id)) continue;
            const prev = prevRectsRef.current.get(id);
            const next = currentRects.get(id);
            if (!prev || !next) continue;
            const surface = tabSurface(nodes.get(id));
            const held = surface ? axisOfTransform(getComputedStyle(surface).transform) : 0;
            const delta = prev.x - next.x + held;
            if (Math.abs(delta) >= SHIFT_EPSILON) shifts.set(id, delta);
          }
        }

        prevIdsRef.current = ids.slice();
        prevRectsRef.current = currentRects;
        const gen = ++generationRef.current;

        if (shifts.size === 0 && entering.size === 0) {
          setMotion((current) => (current ? null : current));
        } else {
          setMotion({
            phase: 'from',
            shifts,
            entering,
            sliding: EMPTY_IDS,
          });
          // rAF 链放在这次布局里，而不是依赖 motion 的 effect：flushSync 提交 arm 时不能把下一帧取消掉。
          const armFrame = requestAnimationFrame(() => {
            if (generationRef.current !== gen) return;
            const sliding = slidingIds(shifts, entering);
            // 先提交「过渡已装上、位移还在」这一帧，WebKit 才认随后的补位。
            flushSync(() => {
              setMotion({
                phase: 'arm',
                shifts,
                entering,
                sliding,
              });
            });
            const playFrame = requestAnimationFrame(() => {
              if (generationRef.current !== gen) return;
              flushSync(() => {
                setMotion({
                  phase: 'play',
                  shifts: EMPTY_SHIFTS,
                  entering: EMPTY_IDS,
                  sliding,
                });
              });
              clearTimerRef.current = window.setTimeout(() => {
                if (generationRef.current !== gen) return;
                setMotion((current) => (current?.phase === 'play' ? null : current));
              }, SLIDE_CLEAR_MS);
            });
            framesRef.current.push(playFrame);
          });
          framesRef.current = [armFrame];
        }
      }
    }
    return cancelScheduled;
  }, [draggingRef, idKey, listRef, tabNodes]);

  useLayoutEffect(() => {
    if (!dragging) return;
    generationRef.current += 1;
    cancelScheduled();
    setMotion((current) => (current ? null : current));
  }, [dragging]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const nodes = tabNodes.current;
    if (!list || !nodes) return;

    const refresh = () => {
      if (draggingRef.current) return;
      const currentList = listRef.current;
      const currentNodes = tabNodes.current;
      if (!currentList || !currentNodes) return;
      prevRectsRef.current = measureTabs(tabIdsRef.current, currentNodes, currentList);
    };

    const viewport = viewportRef.current;
    viewport?.addEventListener('scroll', refresh, { passive: true });
    const observer = new ResizeObserver(refresh);
    observer.observe(list);
    for (const node of nodes.values()) observer.observe(node);
    return () => {
      viewport?.removeEventListener('scroll', refresh);
      observer.disconnect();
    };
  }, [draggingRef, idKey, listRef, tabNodes, viewportRef]);

  return motion;
}
