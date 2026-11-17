// 工作区标签的打开、关闭、序号和命令面板过滤。组件只消费这些结果。
// 激活先后用单调序号，不用墙钟，避免同一时刻分不出先后。

export const BLANK_TAB_KEY = '__blank__';

export type TabCloseActivation = 'previous' | 'next' | 'recent';
export type TabCloseButton = 'always' | 'hover' | 'never';

export type WorkspaceTab = {
  id: string;
  kind: 'blank' | 'tool' | 'settings';
  toolId?: string;
  // 工具与空白标签从 1 起计，展示时 1 不加序号。设置标签不使用序号。
  // 新开取当前仍打开的同类最大序号加一；已分配的序号不因关闭、重排或固定而改变。
  ordinal: number;
  activatedAt: number;
  // 固定与自定义名称只活在本次运行，不写入配置。
  pinned?: boolean;
  customTitle?: string;
};

export type WorkspaceState = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  nextId: number;
  activationSeq: number;
};

export type PaletteScope =
  { kind: 'empty' } | { kind: 'blank' } | { kind: 'settings' } | { kind: 'tool'; toolId: string };

export type PaletteCommand = {
  page?: string;
  tool?: string;
  settingsAction?: string;
  workspaceAction?: string;
  context?: string;
};

export function emptyWorkspace(): WorkspaceState {
  return { tabs: [], activeId: null, nextId: 1, activationSeq: 0 };
}

export function startupWorkspace(): WorkspaceState {
  return openBlankTab(emptyWorkspace()).state;
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

// 有自定义名称时不再拼工具名和序号。只有工具标签会带 customTitle。
export function workspaceTabLabel(tab: WorkspaceTab, baseName: string) {
  if (tab.kind === 'tool' && tab.customTitle) return tab.customTitle;
  return tab.kind === 'settings' ? baseName : tabOrdinalLabel(baseName, tab.ordinal);
}

export type DragSlot = {
  id: string;
  // 拖动开始时的标签中心，之后不再跟布局变化。
  mid: number;
};

// 只有中心越过下一枚标签的中线才切换目标。停在两条中线之间保持当前目标，
// 这样边界上的轻微回摆不会让相邻标签反复成为落点。
export function nextDragOverId(
  slots: readonly DragSlot[],
  currentId: string | null,
  center: number,
): string | null {
  if (slots.length === 0 || !Number.isFinite(center)) return null;
  const index = currentId == null ? -1 : slots.findIndex((slot) => slot.id === currentId);
  if (index < 0) {
    let best = slots[0];
    let bestDistance = Math.abs(best.mid - center);
    for (let cursor = 1; cursor < slots.length; cursor += 1) {
      const distance = Math.abs(slots[cursor].mid - center);
      if (distance < bestDistance) {
        best = slots[cursor];
        bestDistance = distance;
      }
    }
    return best.id;
  }
  const next = slots[index + 1];
  const previous = slots[index - 1];
  if (next && center >= next.mid) return next.id;
  if (previous && center <= previous.mid) return previous.id;
  return slots[index].id;
}

// 被拖项自己跟指针走。中间这些标签只让出一格，间距用拖动开始时的固定值。
export function tabDragShift(
  activeIndex: number,
  overIndex: number,
  index: number,
  pitch: number,
): number {
  if (!Number.isFinite(pitch) || pitch === 0 || activeIndex < 0 || overIndex < 0) return 0;
  if (index > activeIndex && index <= overIndex) return -pitch;
  if (index < activeIndex && index >= overIndex) return pitch;
  return 0;
}

// 固定的在前，未固定的在后；各组内部保持原来的相对顺序。
export function sortTabsForDisplay(tabs: readonly WorkspaceTab[]): WorkspaceTab[] {
  const pinned: WorkspaceTab[] = [];
  const unpinned: WorkspaceTab[] = [];
  for (const tab of tabs) {
    if (tab.pinned) pinned.push(tab);
    else unpinned.push(tab);
  }
  return [...pinned, ...unpinned];
}

export function normalizeTabOrder(state: WorkspaceState): WorkspaceState {
  const tabs = sortTabsForDisplay(state.tabs);
  if (tabs.every((tab, index) => tab === state.tabs[index])) return state;
  return { ...state, tabs };
}

function withoutPin(tab: WorkspaceTab): WorkspaceTab {
  if (!tab.pinned) return tab;
  const next = { ...tab };
  delete next.pinned;
  return next;
}

function withoutCustomTitle(tab: WorkspaceTab): WorkspaceTab {
  if (!tab.customTitle) return tab;
  const next = { ...tab };
  delete next.customTitle;
  return next;
}

export function toggleTabPin(state: WorkspaceState, id: string): WorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const current = state.tabs[index];
  const tabs = state.tabs.slice();
  tabs[index] = current.pinned ? withoutPin(current) : { ...current, pinned: true };
  return normalizeTabOrder({ ...state, tabs });
}

// 同一固定组内按落点下标移动；跨过固定/未固定分界则原样返回。顺序只活在本次会话。
export function reorderWorkspaceTabs(
  state: WorkspaceState,
  activeId: string,
  overId: string,
): WorkspaceState {
  if (!activeId || activeId === overId) return state;
  const from = state.tabs.findIndex((tab) => tab.id === activeId);
  const to = state.tabs.findIndex((tab) => tab.id === overId);
  if (from < 0 || to < 0 || from === to) return state;
  if (Boolean(state.tabs[from].pinned) !== Boolean(state.tabs[to].pinned)) return state;
  const tabs = state.tabs.slice();
  const [moved] = tabs.splice(from, 1);
  if (!moved) return state;
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}

export function setTabCustomTitle(
  state: WorkspaceState,
  id: string,
  title: string | null,
): WorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const current = state.tabs[index];
  if (current.kind !== 'tool') return state;
  const trimmed = title?.trim() ?? '';
  const tabs = state.tabs.slice();
  if (!trimmed) {
    if (!current.customTitle) return state;
    tabs[index] = withoutCustomTitle(current);
  } else if (current.customTitle === trimmed) {
    return state;
  } else {
    tabs[index] = { ...current, customTitle: trimmed };
  }
  return { ...state, tabs };
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

// 序号按当前仍打开的同类标签计算：工具以 toolId 分组，空白标签共用 BLANK_TAB_KEY 这一组。
function maxOrdinalForTool(tabs: readonly WorkspaceTab[], toolId: string): number {
  let max = 0;
  for (const tab of tabs) {
    if (tab.kind === 'tool' && tab.toolId === toolId) max = Math.max(max, tab.ordinal);
  }
  return max;
}

function maxOrdinalForBlank(tabs: readonly WorkspaceTab[]): number {
  let max = 0;
  for (const tab of tabs) {
    if (tab.kind === 'blank') max = Math.max(max, tab.ordinal);
  }
  return max;
}

export function openBlankTab(state: WorkspaceState): { state: WorkspaceState; tab: WorkspaceTab } {
  const ordinal = maxOrdinalForBlank(state.tabs) + 1;
  const activatedAt = state.activationSeq + 1;
  const tab: WorkspaceTab = {
    id: `tab-${state.nextId}`,
    kind: 'blank',
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
    },
  };
}

export function convertBlankTabToTool(
  state: WorkspaceState,
  tabId: string,
  toolId: string,
): WorkspaceState {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target || target.kind !== 'blank') return state;
  const ordinal = maxOrdinalForTool(state.tabs, toolId) + 1;
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, kind: 'tool', toolId, ordinal } : tab,
    ),
  };
}

export function openToolTab(
  state: WorkspaceState,
  toolId: string,
): { state: WorkspaceState; tab: WorkspaceTab } {
  const ordinal = maxOrdinalForTool(state.tabs, toolId) + 1;
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

function withBlankWhenEmpty(state: WorkspaceState): WorkspaceState {
  if (state.tabs.length > 0) return state;
  return openBlankTab({ ...state, tabs: [], activeId: null }).state;
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
    return withBlankWhenEmpty({ ...state, tabs: remainingTabs });
  }
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const nextId =
    remainingTabs.length === 0
      ? null
      : activation === 'recent'
        ? recentId(state.tabs, remaining)
        : neighborId(state.tabs, index, activation === 'previous' ? -1 : 1, remaining);
  let nextState: WorkspaceState;
  if (!nextId) {
    nextState = { ...state, tabs: [], activeId: null };
  } else {
    const activatedAt = state.activationSeq + 1;
    nextState = {
      ...state,
      tabs: remainingTabs.map((tab) => (tab.id === nextId ? { ...tab, activatedAt } : tab)),
      activeId: nextId,
      activationSeq: activatedAt,
    };
  }
  return withBlankWhenEmpty(nextState);
}

export function closeTab(
  state: WorkspaceState,
  id: string,
  activation: TabCloseActivation,
): WorkspaceState {
  return closeTabs(state, [id], activation);
}

// 留下固定标签和被右键的标签，然后总是激活后者。activation 与单标签关闭同一调用形状，这里不采用。
export function closeOtherTabs(
  state: WorkspaceState,
  keepId: string,
  activation: TabCloseActivation,
): WorkspaceState {
  void activation;
  if (!state.tabs.some((tab) => tab.id === keepId)) return state;
  const remainingTabs = state.tabs.filter((tab) => tab.id === keepId || tab.pinned);
  const activatedAt = state.activationSeq + 1;
  return {
    ...state,
    tabs: remainingTabs.map((tab) => (tab.id === keepId ? { ...tab, activatedAt } : tab)),
    activeId: keepId,
    activationSeq: activatedAt,
  };
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
    if (item.workspaceAction === 'new-tab') return true;
    if (isOpenTool(item)) return enabled.has(item.page!);
    if (item.page === 'settings') return true;
    if (item.settingsAction) return scope.kind === 'settings';
    if (item.tool) {
      if (scope.kind !== 'tool' || scope.toolId !== item.tool || !enabled.has(item.tool))
        return false;
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
