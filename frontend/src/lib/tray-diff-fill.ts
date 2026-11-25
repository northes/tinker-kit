export type DiffTrayFillMode = 'alternate' | 'before' | 'after';
export type DiffTrayFillSide = 'before' | 'after';

export function isDiffTrayFillMode(mode: string | null | undefined): mode is DiffTrayFillMode {
  return mode === 'alternate' || mode === 'before' || mode === 'after';
}

export function resolveTrayDiffFillTarget(
  mode: DiffTrayFillMode,
  tabId: string,
  nextByTabId: Map<string, DiffTrayFillSide>,
): { target: DiffTrayFillSide; nextByTabId: Map<string, DiffTrayFillSide> } {
  if (mode === 'before') {
    return { target: 'before', nextByTabId };
  }
  if (mode === 'after') {
    return { target: 'after', nextByTabId };
  }
  const target = nextByTabId.get(tabId) ?? 'before';
  const updated = new Map(nextByTabId);
  updated.set(tabId, target === 'before' ? 'after' : 'before');
  return { target, nextByTabId: updated };
}
