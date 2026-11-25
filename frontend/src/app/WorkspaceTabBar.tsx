import {
  closestCenter,
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable, type SortingStrategy } from '@dnd-kit/sortable';
import { DotsNine, GearSix, Plus, PushPin, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { ScrollArea } from '../components/ui/scroll-area';
import { isDiffCompareSourceTab, type DiffCompareSide } from '../lib/diff-compare-source';
import { cn } from '@/lib/utils';
import { tools } from './definitions';
import {
  nextDragOverId,
  reorderWorkspaceTabs,
  tabDragShift,
  workspaceTabLabel,
  type DragSlot,
  type TabCloseButton,
  type WorkspaceState,
  type WorkspaceTab,
} from './workspace-tabs';
import { useWorkspaceTabActiveHighlight } from './useWorkspaceTabActiveHighlight';
import {
  useFlushWorkspaceTabFitWidth,
  useWorkspaceTabFitWidth,
} from './useWorkspaceTabFitWidth';
import {
  useWorkspaceTabStripMotion,
  type WorkspaceTabStripMotion,
} from './useWorkspaceTabStripMotion';
import { hostQualifiedName } from './workspace-tab-title';

// 锁的是碰撞用的位移，不只是画出来的位置。否则垂直抖动会让相邻标签反复成为 over。
const restrictToTabAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

function pointerPosition(event: Event) {
  if (!('clientX' in event) || !('clientY' in event)) return null;
  const { clientX, clientY } = event;
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  return { x: clientX, y: clientY };
}

function tabDragPreview(tabs: WorkspaceTab[], activeId: string, overId: string) {
  const probe: WorkspaceState = {
    tabs,
    activeId: null,
    nextId: 1,
    activationSeq: 0,
  };
  const next = reorderWorkspaceTabs(probe, activeId, overId);
  return next === probe ? null : next.tabs;
}

// 与 foundation.css 的 --motion-slide-duration / --motion-slide-ease 同一套节奏；
// 滚动容器禁用 scroll-behavior，这段缓动只能写在 rAF 里。
const REVEAL_SCROLL_MS = 200;
const REVEAL_SCROLL_EASE = [0.32, 0.72, 0, 1] as const;
// 亚像素差值不算裁切也不算位移，避免宽度观察器和补滚来回较劲。
const SCROLL_EPSILON = 0.5;

// 落点用滚动内容坐标。拖动过程中视口 scrollLeft 变了，屏幕坐标上的中线会和眼前的标签错开。
function contentX(viewport: HTMLElement | null, clientX: number) {
  if (!viewport) return clientX;
  return clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function tabClipped(viewport: HTMLElement, tab: HTMLElement) {
  const view = viewport.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  return rect.left < view.left - SCROLL_EPSILON || rect.right > view.right + SCROLL_EPSILON;
}

// 最小位移刚好露出：只补被裁掉的那一侧。
function tabRevealScrollLeft(viewport: HTMLElement, tab: HTMLElement) {
  const view = viewport.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (rect.left < view.left) return viewport.scrollLeft - (view.left - rect.left);
  if (rect.right > view.right) return viewport.scrollLeft + (rect.right - view.right);
  return viewport.scrollLeft;
}

// rAF 滚动用不了 CSS 缓动，按同一条 cubic-bezier(0.32, 0.72, 0, 1) 求值：
// 先牛顿迭代解 x(t)=progress，再取 y(t)。这条曲线的 x 单调，迭代必然收敛。
function revealEase(progress: number) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const [x1, y1, x2, y2] = REVEAL_SCROLL_EASE;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let t = progress;
  for (let i = 0; i < 8; i += 1) {
    const x = ((ax * t + bx) * t + cx) * t - progress;
    if (Math.abs(x) < 1e-5) break;
    const dx = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(dx) < 1e-6) break;
    t -= x / dx;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  return ((ay * t + by) * t + cy) * t;
}

function WorkspaceTabItem({
  tab,
  hostName,
  current,
  showIcons,
  closeButton,
  canCloseOthers,
  compareAvailable,
  onCompareContent,
  registerTab,
  suppressClickRef,
  motion,
  onActivate,
  onClose,
  onCloseOthers,
  onTogglePin,
  onRename,
}: {
  tab: WorkspaceTab;
  hostName?: string | null;
  current: boolean;
  showIcons: boolean;
  closeButton: TabCloseButton;
  canCloseOthers: boolean;
  compareAvailable?: boolean;
  onCompareContent: (id: string, side: DiffCompareSide) => void;
  registerTab: (id: string, node: HTMLElement | null) => void;
  suppressClickRef: { current: boolean };
  motion: WorkspaceTabStripMotion | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRename: (id: string) => void;
}) {
  const { t } = useTranslation();
  // 位移画在内层，避免外层测量跟着图层抖。拖拽让位仍由 dnd-kit 的 transform；关闭补位只在没在拖时叠到同一层。
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const setNodeRefLatest = useRef(setNodeRef);
  const registerTabLatest = useRef(registerTab);
  setNodeRefLatest.current = setNodeRef;
  registerTabLatest.current = registerTab;
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRefLatest.current(node);
      registerTabLatest.current(tab.id, node);
    },
    [tab.id],
  );
  const baseName = workspaceTabBaseName(tab, (key) => t(key), hostName);
  const label = workspaceTabLabel(tab, baseName);
  const Icon =
    tab.kind === 'settings'
      ? GearSix
      : tab.kind === 'blank'
        ? DotsNine
        : tools.find((item) => item.id === tab.toolId)?.icon;
  const canRename = tab.kind === 'tool';
  const dragDescriptionId = `workspace-tab-drag-${tab.id}`;
  const sortableShift =
    transform && (transform.x || transform.y)
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined;
  const holding = motion?.phase === 'from' || motion?.phase === 'arm';
  const fillDelta =
    !isDragging && sortableShift == null && holding ? motion?.shifts.get(tab.id) : undefined;
  const fillShift = fillDelta != null ? `translate3d(${fillDelta}px, 0, 0)` : undefined;
  const entering = Boolean(!isDragging && holding && motion?.entering.has(tab.id));
  const sliding = Boolean(
    !isDragging &&
    (motion?.phase === 'arm' || motion?.phase === 'play') &&
    motion.sliding.has(tab.id),
  );
  const surfaceTransition =
    sortableShift || isDragging
      ? transition
      : motion?.phase === 'from' && (fillShift || entering)
        ? 'none'
        : undefined;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setRef}
            role="tab"
            aria-selected={current}
            aria-describedby={dragDescriptionId}
            tabIndex={current ? 0 : -1}
            title={label}
            aria-label={tab.pinned ? t('workspaceTabs.pinnedTab', { name: label }) : label}
            data-current={current ? '' : undefined}
            data-pinned={tab.pinned ? '' : undefined}
            data-workspace-tab=""
            style={{ zIndex: isDragging ? 20 : undefined }}
            className={cn(
              // 外层只占布局盒，给 dnd-kit 测量。焦点环画在内侧，避免被 ScrollArea 裁切。
              // 不展开 useSortable 的 attributes：其中的 role=button 会盖掉 role=tab。
              'group/tab relative h-8 w-(--workspace-tab-width) shrink-0 touch-none outline-none select-none [--wails-draggable:no-drag] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
            )}
            {...listeners}
            onClick={() => {
              if (suppressClickRef.current) return;
              onActivate(tab.id);
            }}
            onMouseDown={(event) => {
              // 右键只打开菜单，不激活。中键沿用关闭。
              if (event.button === 2) return;
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(tab.id);
            }}
            onKeyDown={(event) => {
              listeners?.onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onActivate(tab.id);
            }}
          />
        }
      >
        <div
          data-workspace-tab-surface=""
          data-workspace-tab-enter={entering ? '' : undefined}
          data-workspace-tab-motion={sliding ? '' : undefined}
          className={cn(
            'absolute inset-0 flex cursor-default items-center gap-1.5 rounded-md px-2 text-left text-xs',
            current ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            isDragging && 'bg-accent text-foreground shadow-md',
          )}
          style={{
            transform: sortableShift ?? fillShift,
            // 补位第一帧关掉过渡，避免从新位置滑向旧位置。
            transition: surfaceTransition,
          }}
        >
          <span id={dragDescriptionId} className="sr-only">
            {t('workspaceTabs.dragTab', { name: label })}
          </span>
          {showIcons && Icon ? (
            <Icon size={14} weight="regular" className="shrink-0" aria-hidden="true" />
          ) : null}
          {tab.pinned ? (
            <PushPin size={12} weight="regular" className="shrink-0" aria-hidden="true" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {closeButton === 'never' ? null : (
            <div
              className={cn(
                'absolute inset-y-0 right-0 flex items-center rounded-r-md bg-linear-to-r from-transparent pl-6 pr-1',
                isDragging
                  ? 'via-accent to-accent'
                  : current
                    ? 'workspace-tab-fade-panel'
                    : 'workspace-tab-fade-chrome',
                closeButton === 'always' || current
                  ? 'pointer-events-auto opacity-100'
                  : 'pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100',
              )}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('workspaceTabs.closeTab', { name: label })}
                title={t('workspaceTabs.closeTab', { name: label })}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <X size={14} weight="regular" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44" side="bottom" align="start">
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onTogglePin(tab.id)}>
            {tab.pinned ? t('workspaceTabs.unpin') : t('workspaceTabs.pin')}
          </ContextMenuItem>
        </ContextMenuGroup>
        {compareAvailable !== undefined ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuSub>
                {/* 无可对比来源时保留二级菜单结构（含右侧箭头），由 Base UI disabled 同时挡住鼠标与键盘展开 */}
                <ContextMenuSubTrigger disabled={!compareAvailable}>
                  {t('workspaceTabs.compare')}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem onClick={() => onCompareContent(tab.id, 'before')}>
                    {t('workspaceTabs.compareToLeft')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onCompareContent(tab.id, 'after')}>
                    {t('workspaceTabs.compareToRight')}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuGroup>
          </>
        ) : null}
        {canCloseOthers || canRename ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              {canCloseOthers ? (
                <ContextMenuItem onClick={() => onCloseOthers(tab.id)}>
                  {t('workspaceTabs.closeOtherTabs')}
                </ContextMenuItem>
              ) : null}
              {canRename ? (
                <ContextMenuItem onClick={() => onRename(tab.id)}>
                  {t('workspaceTabs.rename')}
                </ContextMenuItem>
              ) : null}
            </ContextMenuGroup>
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onClose(tab.id)}>
            {t('workspaceTabs.close')}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function workspaceTabBaseName(
  tab: WorkspaceTab,
  translate: (key: string) => string,
  hostName?: string | null,
) {
  if (tab.kind === 'settings') return translate('settings.title');
  if (tab.kind === 'blank') return translate('workspaceTabs.blankTab');
  const tool = tab.kind === 'tool' ? tools.find((item) => item.id === tab.toolId) : undefined;
  const toolName = tool ? translate(tool.nameKey) : (tab.toolId ?? '');
  return hostQualifiedName(toolName, hostName);
}

export function WorkspaceTabBar({
  tabs,
  tabHostNames,
  activeId,
  showIcons,
  fitToContent,
  closeButton,
  diffSourceIds,
  onCompareContent,
  onActivate,
  onClose,
  onCloseOthers,
  onTogglePin,
  onReorder,
  onRename,
  onNewTab,
}: {
  tabs: WorkspaceTab[];
  tabHostNames: Record<string, string>;
  activeId: string | null;
  showIcons: boolean;
  fitToContent: boolean;
  closeButton: TabCloseButton;
  diffSourceIds: ReadonlySet<string>;
  onCompareContent: (id: string, side: DiffCompareSide) => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onTogglePin: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onRename: (id: string) => void;
  onNewTab: () => void;
}) {
  const { t, i18n } = useTranslation();
  const currentTab = tabs.find((tab) => tab.id === activeId);
  const compareActive = currentTab?.kind === 'tool' && currentTab.toolId === 'diff';
  const viewportRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const tabsRef = useRef(tabs);
  const tabHostNamesRef = useRef(tabHostNames);
  const suppressClickRef = useRef(false);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const slotsRef = useRef<DragSlot[]>([]);
  const overIdRef = useRef<string | null>(null);
  const grabOffsetRef = useRef(0);
  const pitchRef = useRef(0);
  const draggedTabIdRef = useRef<string | null>(null);
  // 被拖的是激活标签时置位，拖拽状态结束后的 layout effect 读它决定要不要补一次露出。
  const pendingRevealRef = useRef(false);
  // 「这次尺寸变化之前激活标签是否完全可见」；null 表示还没记过。
  const activeVisibleRef = useRef<boolean | null>(null);
  // 最近一次程序写入的 scrollLeft，scroll 监听凭它区分自己与用户。
  const programScrollValueRef = useRef<number | null>(null);
  const revealAnimRef = useRef<{ frame: number; beganAt: number } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // 刚开始观察的元素：ResizeObserver 第一次回调只记基线，不当成尺寸变化。
  const freshObserveRef = useRef(new Set<Element>());
  const observedTabRef = useRef<HTMLElement | null>(null);
  const activeIdRef = useRef(activeId);
  tabsRef.current = tabs;
  tabHostNamesRef.current = tabHostNames;
  activeIdRef.current = activeId;
  const [liveMessage, setLiveMessage] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // 默认公告会把内部 id 用英文念出来。结果改由下面的 polite 区域播报。
  const silentAnnouncements = useMemo(
    () => ({
      onDragStart: () => undefined,
      onDragOver: () => undefined,
      onDragEnd: () => undefined,
      onDragCancel: () => undefined,
    }),
    [],
  );
  // 用户滚动和每次程序滚动结束后都记一遍：宽度观察器凭它判断该不该把视口拉回。
  const noteActiveVisibility = useCallback(() => {
    const viewport = viewportRef.current;
    const tab = activeIdRef.current ? tabRefs.current.get(activeIdRef.current) : undefined;
    if (!viewport || !tab) return;
    activeVisibleRef.current = !tabClipped(viewport, tab);
  }, []);
  const writeProgramScroll = useCallback((viewport: HTMLElement, value: number) => {
    // 先记预期值再赋值：scrollLeft 赋值可能同步派发 scroll，监听此刻要能认出这是自己。
    // 夹到合法范围，避免浏览器钳制后与预期差出容差，把自己当用户滚动取消。
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const clamped = Math.min(max, Math.max(0, value));
    programScrollValueRef.current = clamped;
    viewport.scrollLeft = clamped;
  }, []);
  const cancelRevealAnimation = useCallback(() => {
    const anim = revealAnimRef.current;
    if (!anim) return;
    cancelAnimationFrame(anim.frame);
    revealAnimRef.current = null;
    // 取消就停在当前 scrollLeft，不补到目标；可见性按停下的位置记。
    noteActiveVisibility();
  }, [noteActiveVisibility]);
  // 拖拽松手后的补滚：唯一带动画的程序滚动。
  const revealTabAnimated = useCallback(
    (viewport: HTMLElement, tab: HTMLElement) => {
      const target = tabRevealScrollLeft(viewport, tab);
      // 已经露出、或目标与当前只差亚像素，不起动画。
      if (Math.abs(target - viewport.scrollLeft) < SCROLL_EPSILON) {
        noteActiveVisibility();
        return;
      }
      if (prefersReducedMotion()) {
        writeProgramScroll(viewport, target);
        noteActiveVisibility();
        return;
      }
      cancelRevealAnimation();
      const from = viewport.scrollLeft;
      const beganAt = performance.now();
      const step = () => {
        const anim = revealAnimRef.current;
        // ref 被取消（用户滚动、新拖拽、激活切换）就退出，不补滚。
        if (!anim || anim.beganAt !== beganAt) return;
        const progress = Math.min(1, (performance.now() - beganAt) / REVEAL_SCROLL_MS);
        writeProgramScroll(viewport, from + (target - from) * revealEase(progress));
        // 写入可能同步派发 scroll 并因此取消自己，登记下一帧前再确认一次 ref。
        const live = revealAnimRef.current;
        if (!live || live.beganAt !== beganAt) return;
        if (progress >= 1) {
          revealAnimRef.current = null;
          noteActiveVisibility();
          return;
        }
        live.frame = requestAnimationFrame(step);
      };
      revealAnimRef.current = { frame: requestAnimationFrame(step), beganAt };
    },
    [cancelRevealAnimation, noteActiveVisibility, writeProgramScroll],
  );
  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const expected = programScrollValueRef.current;
    // 自己写入引起的 scroll 不算用户输入，否则动画会把自己取消掉。
    if (expected != null && Math.abs(viewport.scrollLeft - expected) < SCROLL_EPSILON) return;
    programScrollValueRef.current = null;
    cancelRevealAnimation();
    noteActiveVisibility();
  }, [cancelRevealAnimation, noteActiveVisibility]);
  // 宽度变化只认视口 clientWidth 和标签自身宽度；换序、增减只是 x 位移，不会触发这里。
  const handleViewportResize = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const fresh = freshObserveRef.current;
      const baseline = entries.some((entry) => fresh.delete(entry.target));
      if (baseline) {
        noteActiveVisibility();
        return;
      }
      // 拖拽中或补滚在播时不抢滚动。
      if (draggingRef.current || revealAnimRef.current) return;
      // 用户自己把激活标签滚出过视口，就不借宽度变化拉回去。
      if (activeVisibleRef.current !== true) return;
      const viewport = viewportRef.current;
      const tab = activeIdRef.current ? tabRefs.current.get(activeIdRef.current) : undefined;
      if (!viewport || !tab) return;
      if (!tabClipped(viewport, tab)) return;
      writeProgramScroll(viewport, tabRevealScrollLeft(viewport, tab));
      noteActiveVisibility();
    },
    [noteActiveVisibility, writeProgramScroll],
  );
  // 激活标签换人时把宽度观察切到新元素上。
  const observeActiveTab = useCallback((observer: ResizeObserver) => {
    const tab = activeIdRef.current ? tabRefs.current.get(activeIdRef.current) : undefined;
    const previous = observedTabRef.current;
    if (previous === tab) return;
    if (previous) {
      observer.unobserve(previous);
      freshObserveRef.current.delete(previous);
    }
    if (tab) {
      freshObserveRef.current.add(tab);
      observer.observe(tab);
    }
    observedTabRef.current = tab ?? null;
  }, []);
  const clearDragGeometry = () => {
    slotsRef.current = [];
    overIdRef.current = null;
    grabOffsetRef.current = 0;
    pitchRef.current = 0;
  };
  // 落点只跟拖动开始时的中线比较。closestCenter 会读正在变换的矩形，越过相邻标签时来回翻转。
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointer = args.pointerCoordinates;
    const slots = slotsRef.current;
    if (!pointer || slots.length === 0) return closestCenter(args);
    const along = contentX(viewportRef.current, pointer.x);
    const next = nextDragOverId(slots, overIdRef.current, along - grabOffsetRef.current);
    if (!next) return [];
    overIdRef.current = next;
    return [{ id: next }];
  }, []);
  const sortingStrategy = useCallback<SortingStrategy>(({ activeIndex, overIndex, index }) => {
    const shift = tabDragShift(activeIndex, overIndex, index, pitchRef.current);
    if (!shift) return null;
    return { x: shift, y: 0, scaleX: 1, scaleY: 1 };
  }, []);
  const setDragActive = (active: boolean) => {
    draggingRef.current = active;
    setDragging(active);
  };
  const onDragStart = (event: DragStartEvent) => {
    // 新拖拽开始就放弃还在播的补滚，视口停在当前位置。
    cancelRevealAnimation();
    setDragActive(true);
    const dragId = String(event.active.id);
    draggedTabIdRef.current = dragId;
    const activeTab = tabsRef.current.find((tab) => tab.id === dragId);
    const slots: DragSlot[] = [];
    if (activeTab) {
      const pinned = Boolean(activeTab.pinned);
      for (const tab of tabsRef.current) {
        if (Boolean(tab.pinned) !== pinned) continue;
        const node = tabRefs.current.get(tab.id);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        slots.push({
          id: tab.id,
          mid: contentX(viewportRef.current, rect.left + rect.width / 2),
        });
      }
    }
    slotsRef.current = slots;
    overIdRef.current = dragId;
    pitchRef.current = slots.length >= 2 ? slots[1].mid - slots[0].mid : 0;
    const activator = event.activatorEvent;
    const origin = slots.find((slot) => slot.id === dragId);
    const point = pointerPosition(activator);
    grabOffsetRef.current =
      origin && point ? contentX(viewportRef.current, point.x) - origin.mid : 0;
  };
  const registerTab = useCallback((id: string, node: HTMLElement | null) => {
    if (node) tabRefs.current.set(id, node);
    else tabRefs.current.delete(id);
  }, []);
  const suppressClickAfterDrag = () => {
    suppressClickRef.current = true;
    requestAnimationFrame(() => {
      suppressClickRef.current = false;
    });
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragActive(false);
    clearDragGeometry();
    suppressClickAfterDrag();
    // 被拖的就是激活标签时，松手后可能停在视口外，交给拖拽状态结束后的 layout effect 测量。
    if (draggedTabIdRef.current === activeIdRef.current) pendingRevealRef.current = true;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeDragId = String(active.id);
    const overId = String(over.id);
    const nextTabs = tabDragPreview(tabsRef.current, activeDragId, overId);
    if (!nextTabs) return;
    const moved = tabsRef.current.find((tab) => tab.id === activeDragId);
    onReorder(activeDragId, overId);
    if (!moved) return;
    setLiveMessage(
      t('workspaceTabs.movedTab', {
        name: workspaceTabLabel(
          moved,
          workspaceTabBaseName(moved, (key) => t(key), tabHostNamesRef.current[moved.id]),
        ),
        position: nextTabs.findIndex((tab) => tab.id === activeDragId) + 1,
        total: nextTabs.length,
      }),
    );
  };
  const onViewport = useCallback(
    (viewport: HTMLElement | null) => {
      // 旧视口先卸干净：scroll 监听和宽度观察都挂在它身上。
      const previousViewport = viewportRef.current;
      if (previousViewport) {
        previousViewport.removeEventListener('scroll', handleViewportScroll);
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        observedTabRef.current = null;
        freshObserveRef.current.clear();
      }
      cancelRevealAnimation();
      viewportRef.current = viewport;
      if (!viewport) return;
      // 首次出现：瞬时把激活标签放进视口。
      const tab = activeIdRef.current ? tabRefs.current.get(activeIdRef.current) : undefined;
      if (tab) writeProgramScroll(viewport, tabRevealScrollLeft(viewport, tab));
      noteActiveVisibility();
      viewport.addEventListener('scroll', handleViewportScroll, { passive: true });
      const observer = new ResizeObserver(handleViewportResize);
      freshObserveRef.current.add(viewport);
      observer.observe(viewport);
      resizeObserverRef.current = observer;
      // 视口晚于激活标签到位（OverlayScrollbars defer 初始化），这里补挂当前的观察。
      observeActiveTab(observer);
    },
    [
      cancelRevealAnimation,
      handleViewportResize,
      handleViewportScroll,
      noteActiveVisibility,
      observeActiveTab,
      writeProgramScroll,
    ],
  );
  const fitLabels = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: workspaceTabLabel(
          tab,
          workspaceTabBaseName(tab, (key) => t(key), tabHostNames[tab.id]),
        ),
        pinned: tab.pinned === true,
      })),
    [i18n.language, t, tabHostNames, tabs],
  );
  const tabMotionHold = useRef<WorkspaceTabStripMotion | null>(null);
  // 先于补位注册，宽度写入后开合动画才测位置。
  const { probe: tabFitProbe, pendingWidthRef: tabFitWidthRef } = useWorkspaceTabFitWidth({
    enabled: fitToContent,
    labels: fitLabels,
    showIcons,
    closeButton,
    hold: tabMotionHold,
  });
  // 激活切换才拉视口；tabs 增减换序不再借这条路径把用户滚走的位置拉回。
  // 留在宽度写入之后，测量用的已经是这一帧的标签宽度。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const tab = activeId ? tabRefs.current.get(activeId) : undefined;
    if (!viewport || !tab) return;
    cancelRevealAnimation();
    writeProgramScroll(viewport, tabRevealScrollLeft(viewport, tab));
    noteActiveVisibility();
  }, [activeId, cancelRevealAnimation, noteActiveVisibility, writeProgramScroll]);
  // 拖拽状态结束（松手或取消）后的这一帧：dnd-kit 的 transform 已清、换序后的 DOM 已提交，
  // 在这里测激活标签是否停在视口外，只对这一次补滚。顺序没变也要测，取消和原地放下同样可能停在视口外。
  useLayoutEffect(() => {
    if (dragging) return;
    if (!pendingRevealRef.current) return;
    pendingRevealRef.current = false;
    const viewport = viewportRef.current;
    const tab = activeIdRef.current ? tabRefs.current.get(activeIdRef.current) : undefined;
    if (!viewport || !tab) return;
    if (!tabClipped(viewport, tab)) {
      noteActiveVisibility();
      return;
    }
    revealTabAnimated(viewport, tab);
  }, [dragging, noteActiveVisibility, revealTabAnimated]);
  useLayoutEffect(() => {
    // 视口还没挂上时，由 onViewport 回来后补挂当前的观察。
    const observer = resizeObserverRef.current;
    if (observer) observeActiveTab(observer);
  }, [activeId, observeActiveTab]);
  // 卸载时停掉还在播的补滚，避免 rAF 写已卸载的视口。
  useEffect(() => () => cancelRevealAnimation(), [cancelRevealAnimation]);

  const tabIds = tabs.map((tab) => tab.id);
  const tabMotion = useWorkspaceTabStripMotion({
    tabIds,
    tabNodes: tabRefs,
    listRef,
    viewportRef,
    draggingRef,
    dragging,
  });
  tabMotionHold.current = tabMotion;
  useFlushWorkspaceTabFitWidth(fitToContent, tabMotion, tabFitWidthRef);
  const { highlight: activeHighlight, reducedMotion: tabHighlightReduced } =
    useWorkspaceTabActiveHighlight({
      activeId,
      tabIds,
      tabNodes: tabRefs,
      listRef,
      viewportRef,
    });

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 items-center">
      {tabFitProbe}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToTabAxis]}
        // 拖动时只有 transform，布局盒不变。WhileDragging 会按帧重测并读 computed style，造成掉帧。
        measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
        // OverlayScrollbars 的 viewport 和 dnd-kit 自动滚动会抢标签条，拖动时不自动滚。
        autoScroll={false}
        accessibility={{
          announcements: silentAnnouncements,
          screenReaderInstructions: { draggable: '' },
        }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragActive(false);
          clearDragGeometry();
          suppressClickAfterDrag();
          // 取消拖拽同样可能让激活标签停在视口外，和正常松手走同一条补滚判定。
          if (draggedTabIdRef.current === activeIdRef.current) pendingRevealRef.current = true;
        }}
      >
        <ScrollArea
          data-workspace-tab-scroll=""
          className="h-full min-h-0 min-w-0 flex-1"
          scrollFade="x"
          options={{
            overflow: { y: 'hidden' },
            scrollbars: { visibility: 'hidden' },
          }}
          onViewport={onViewport}
        >
          <SortableContext items={tabs.map((tab) => tab.id)} strategy={sortingStrategy}>
            <div
              ref={listRef}
              role="tablist"
              aria-label={t('workspaceTabs.list')}
              className="relative isolate flex h-full items-center gap-1"
            >
              {activeHighlight ? (
                <div
                  aria-hidden
                  data-workspace-tab-highlight=""
                  data-workspace-tab-highlight-reduced={
                    tabHighlightReduced ? '' : undefined
                  }
                  className="workspace-tab-highlight pointer-events-none absolute top-0 left-0 -z-10 rounded-md"
                  style={{
                    width: activeHighlight.width,
                    height: activeHighlight.height,
                    transform: `translate3d(${activeHighlight.x}px, ${activeHighlight.y}px, 0)`,
                  }}
                />
              ) : null}
              {tabs.map((tab) => (
                <WorkspaceTabItem
                  key={tab.id}
                  tab={tab}
                  hostName={tabHostNames[tab.id]}
                  current={tab.id === activeId}
                  showIcons={showIcons}
                  closeButton={closeButton}
                  canCloseOthers={tabs.some((item) => item.id !== tab.id && !item.pinned)}
                  compareAvailable={
                    compareActive && isDiffCompareSourceTab(tab)
                      ? diffSourceIds.has(tab.id)
                      : undefined
                  }
                  onCompareContent={onCompareContent}
                  registerTab={registerTab}
                  suppressClickRef={suppressClickRef}
                  motion={tabMotion}
                  onActivate={onActivate}
                  onClose={onClose}
                  onCloseOthers={onCloseOthers}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                />
              ))}
            </div>
          </SortableContext>
        </ScrollArea>
      </DndContext>
      <div aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
      <div className="flex flex-none px-1.5 [--wails-draggable:no-drag]">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={onNewTab}
          aria-label={t('workspaceTabs.newTab')}
          title={t('workspaceTabs.newTab')}
        >
          <Plus size={16} weight="regular" />
        </Button>
      </div>
    </div>
  );
}
