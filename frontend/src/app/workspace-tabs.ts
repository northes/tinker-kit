// 工作区标签的打开、关闭、序号和命令面板过滤。组件只消费这些结果。
// 激活先后用单调序号，不用墙钟，避免同一时刻分不出先后。

export type TabOrientation = 'horizontal' | 'vertical';
export type TabCloseActivation = 'previous' | 'next' | 'recent';
export type TabCloseButton = 'always' | 'hover' | 'never';

export type WorkspaceTab = {
  id: string;
  kind: 'tool' | 'settings';
  toolId?: string;
  // 工具标签从 1 起计，展示时 1 不加序号。设置标签不使用序号。
  ordinal: number;
  activatedAt: number;
};

export type WorkspaceState = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  nextId: number;
  activationSeq: number;
  nextOrdinal: Record<string, number>;
};

export type PaletteScope =
  | { kind: 'empty' }
  | { kind: 'settings' }
  | { kind: 'tool'; toolId: string };

export type PaletteCommand = {
  page?: string;
  tool?: string;
  settingsAction?: string;
  context?: string;
};

export function emptyWorkspace(): WorkspaceState {
  return { tabs: [], activeId: null, nextId: 1, activationSeq: 0, nextOrdinal: {} };
}

export function parseTabOrientation(value: string | null | undefined): TabOrientation {
  return value === 'vertical' ? 'vertical' : 'horizontal';
}

export function parseTabCloseActivation(value: string | null | undefined): TabCloseActivation {
  return value === 'previous' || value === 'next' ? value : 'recent';
}

export function parseTabCloseButton(value: string | null | undefined): TabCloseButton {
  return value === 'hover' || value === 'never' ? value : 'always';
}

export function tabOrdinalLabel(name: string, ordinal: number) {
  return ordinal <= 1 ? name : `${name} ${ordinal}`;
}

export function activeTab(state: WorkspaceState): WorkspaceTab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

function touch(state: WorkspaceState, id: string): WorkspaceState {
  const activatedAt = state.activationSeq + 1;
  return {
    ...state,
    activeId: id,
    activationSeq: activatedAt,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, activatedAt } : tab)),
  };
}

export function openToolTab(state: WorkspaceState, toolId: string): { state: WorkspaceState; tab: WorkspaceTab } {
  const ordinal = state.nextOrdinal[toolId] ?? 1;
  const activatedAt = state.activationSeq + 1;
  const tab: WorkspaceTab = {
    id: `tab-${state.nextId}`,
    kind: 'tool',
    toolId,
    ordinal,
    activatedAt,
  };
  return {
    tab,
    state: {
      ...state,
      tabs: [...state.tabs, tab],
      activeId: tab.id,
      nextId: state.nextId + 1,
      activationSeq: activatedAt,
      nextOrdinal: { ...state.nextOrdinal, [toolId]: ordinal + 1 },
    },
  };
}

export function openOrFocusSettings(state: WorkspaceState): WorkspaceState {
  const existing = state.tabs.find((tab) => tab.kind === 'settings');
  if (existing) return existing.id === state.activeId ? state : touch(state, existing.id);
  const activatedAt = state.activationSeq + 1;
  const tab: WorkspaceTab = {
    id: `tab-${state.nextId}`,
    kind: 'settings',
    ordinal: 0,
    activatedAt,
  };
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    nextId: state.nextId + 1,
    activationSeq: activatedAt,
  };
}

export function activateTab(state: WorkspaceState, id: string): WorkspaceState {
  if (!state.tabs.some((tab) => tab.id === id) || state.activeId === id) return state;
  return touch(state, id);
}

// 前一个 / 后一个只看打开顺序。目标一侧已经没有标签时，退到另一侧；
// 这是关掉首尾标签时「必须仍选出一个」的结果，不是另一条产品规则。
function neighborId(
  tabs: WorkspaceTab[],
  index: number,
  direction: -1 | 1,
  remaining: ReadonlySet<string>,
): string | null {
  for (let cursor = index + direction; cursor >= 0 && cursor < tabs.length; cursor += direction) {
    if (remaining.has(tabs[cursor].id)) return tabs[cursor].id;
  }
  const fallback = direction === -1 ? 1 : -1;
  for (let cursor = index + fallback; cursor >= 0 && cursor < tabs.length; cursor += fallback) {
    if (remaining.has(tabs[cursor].id)) return tabs[cursor].id;
  }
  return null;
}

function recentId(tabs: WorkspaceTab[], remaining: ReadonlySet<string>): string | null {
  let best: WorkspaceTab | null = null;
  for (const tab of tabs) {
    if (!remaining.has(tab.id)) continue;
    if (!best || tab.activatedAt > best.activatedAt) best = tab;
  }
  return best?.id ?? null;
}

export function closeTabs(
  state: WorkspaceState,
  ids: readonly string[],
  activation: TabCloseActivation,
): WorkspaceState {
  const closing = new Set(ids.filter((id) => state.tabs.some((tab) => tab.id === id)));
  if (closing.size === 0) return state;
  const remainingTabs = state.tabs.filter((tab) => !closing.has(tab.id));
  const remaining = new Set(remainingTabs.map((tab) => tab.id));
  const activeClosed = state.activeId != null && closing.has(state.activeId);
  if (!activeClosed) {
    return { ...state, tabs: remainingTabs };
  }
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const nextId =
    remainingTabs.length === 0
      ? null
      : activation === 'recent'
        ? recentId(state.tabs, remaining)
        : neighborId(state.tabs, index, activation === 'previous' ? -1 : 1, remaining);
  if (!nextId) return { ...state, tabs: [], activeId: null };
  const activatedAt = state.activationSeq + 1;
  return {
    ...state,
    tabs: remainingTabs.map((tab) => (tab.id === nextId ? { ...tab, activatedAt } : tab)),
    activeId: nextId,
    activationSeq: activatedAt,
  };
}

export function closeTab(state: WorkspaceState, id: string, activation: TabCloseActivation): WorkspaceState {
  return closeTabs(state, [id], activation);
}

export function cycleTabs(state: WorkspaceState, direction: -1 | 1): WorkspaceState {
  if (state.tabs.length < 2 || !state.activeId) return state;
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  if (index < 0) return state;
  const next = (index + direction + state.tabs.length) % state.tabs.length;
  return touch(state, state.tabs[next].id);
}

function isOpenTool(item: PaletteCommand) {
  return !!item.page && item.page !== 'settings' && !item.tool && !item.settingsAction;
}

export function visiblePaletteCommands<T extends PaletteCommand>(
  items: readonly T[],
  scope: PaletteScope,
  enabledToolIds: readonly string[],
  contexts: ReadonlySet<string>,
): T[] {
  const enabled = new Set(enabledToolIds);
  const visible = items.filter((item) => {
    if (isOpenTool(item)) return enabled.has(item.page!);
    if (item.page === 'settings') return true;
    if (item.settingsAction) return scope.kind === 'settings';
    if (item.tool) {
      if (scope.kind !== 'tool' || scope.toolId !== item.tool || !enabled.has(item.tool)) return false;
      return !item.context || contexts.has(item.context);
    }
    return false;
  });
  const order = new Map(enabledToolIds.map((id, index) => [id, index]));
  const positions: number[] = [];
  const openItems: T[] = [];
  visible.forEach((item, index) => {
    if (!isOpenTool(item)) return;
    positions.push(index);
    openItems.push(item);
  });
  openItems.sort((a, b) => (order.get(a.page!) ?? 0) - (order.get(b.page!) ?? 0));
  const next = visible.slice();
  positions.forEach((position, index) => {
    next[position] = openItems[index];
  });
  return next;
}
