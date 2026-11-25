import type { WorkspaceTab } from '../app/workspace-tabs';

export type DiffCompareSide = 'before' | 'after';

export type DiffCompareSource =
  | { toolId: 'json' | 'text'; text: string }
  | { toolId: 'ssh-files'; text: string; editorOpen: boolean; ready: boolean; fileName: string };

export type DiffCompareSourceReporter = (source: DiffCompareSource) => void;

export type DiffCompareCandidate = {
  id: string;
  label: string;
};

export function isDiffCompareSourceTab(tab: WorkspaceTab) {
  return (
    tab.kind === 'tool' &&
    (tab.toolId === 'json' || tab.toolId === 'text' || tab.toolId === 'ssh-files')
  );
}

export function isDiffCompareSourceAvailable(source: DiffCompareSource | null | undefined) {
  if (!source) return false;
  if (source.toolId === 'ssh-files' && (!source.editorOpen || !source.ready)) return false;
  return source.text.trim() !== '';
}

export function getComparableDiffSource(
  tab: WorkspaceTab,
  source: DiffCompareSource | undefined,
) {
  return source &&
    isDiffCompareSourceTab(tab) &&
    tab.toolId === source.toolId &&
    isDiffCompareSourceAvailable(source)
    ? source
    : undefined;
}

// tabs 已按标签栏展示顺序排列，包含固定标签和拖动换序的结果。
export function listDiffCompareSources(
  tabs: readonly WorkspaceTab[],
  sources: ReadonlyMap<string, DiffCompareSource>,
) {
  return tabs.flatMap((tab) => {
    const source = getComparableDiffSource(tab, sources.get(tab.id));
    if (!source) return [];
    return [{ tab, fileName: source.toolId === 'ssh-files' ? source.fileName : undefined }];
  });
}
