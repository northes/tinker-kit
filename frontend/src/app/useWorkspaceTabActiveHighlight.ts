import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export type WorkspaceTabActiveHighlight = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function measureActiveHighlight(
  list: HTMLElement,
  tab: HTMLElement,
): WorkspaceTabActiveHighlight {
  const listRect = list.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  return {
    x: tabRect.left - listRect.left,
    y: tabRect.top - listRect.top,
    width: tabRect.width,
    height: tabRect.height,
  };
}

function highlightEqual(a: WorkspaceTabActiveHighlight | null, b: WorkspaceTabActiveHighlight) {
  if (!a) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function useWorkspaceTabActiveHighlight({
  activeId,
  tabIds,
  tabNodes,
  listRef,
  viewportRef,
}: {
  activeId: string | null;
  tabIds: readonly string[];
  tabNodes: RefObject<Map<string, HTMLElement>>;
  listRef: RefObject<HTMLElement | null>;
  viewportRef: RefObject<HTMLElement | null>;
}) {
  const [highlight, setHighlight] = useState<WorkspaceTabActiveHighlight | null>(null);
  const idKey = tabIds.join('\0');

  useLayoutEffect(() => {
    const list = listRef.current;
    const nodes = tabNodes.current;
    if (!list || !nodes || !activeId) {
      setHighlight(null);
      return;
    }

    const sync = () => {
      const currentList = listRef.current;
      const currentNodes = tabNodes.current;
      if (!currentList || !currentNodes || !activeId) {
        setHighlight((current) => (current ? null : current));
        return;
      }
      const tab = currentNodes.get(activeId);
      if (!tab || !tab.offsetWidth) {
        setHighlight((current) => (current ? null : current));
        return;
      }
      const next = measureActiveHighlight(currentList, tab);
      setHighlight((previous) => (highlightEqual(previous, next) ? previous : next));
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(list);
    for (const id of tabIds) {
      const node = nodes.get(id);
      if (node) observer.observe(node);
    }
    const viewport = viewportRef.current;
    viewport?.addEventListener('scroll', sync, { passive: true });
    return () => {
      observer.disconnect();
      viewport?.removeEventListener('scroll', sync);
    };
  }, [activeId, idKey, listRef, tabNodes, tabIds, viewportRef]);

  return { highlight, reducedMotion: prefersReducedMotion() };
}
