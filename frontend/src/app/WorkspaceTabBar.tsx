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
import { GearSix, Plus, PushPin, X } from '@phosphor-icons/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { ScrollArea } from '../components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { tools } from './definitions';
import {
  nextDragOverId,
  reorderWorkspaceTabs,
  tabDragShift,
  workspaceTabLabel,
  type DragSlot,
  type TabCloseButton,
  type TabOrientation,
  type WorkspaceState,
  type WorkspaceTab,
} from './workspace-tabs';
import {
  useWorkspaceTabStripMotion,
  type WorkspaceTabStripMotion,
} from './useWorkspaceTabStripMotion';

// 锁的是碰撞用的位移，不只是画出来的位置。否则垂直抖动会让相邻标签反复成为 over。
const restrictToTabAxis = (horizontal: boolean): Modifier =>
  horizontal
    ? ({ transform }) => ({ ...transform, y: 0 })
    : ({ transform }) => ({ ...transform, x: 0 });

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

function scrollTabIntoView(viewport: HTMLElement, tab: HTMLElement, orientation: TabOrientation) {
  const view = viewport.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (orientation === 'horizontal') {
    if (rect.left < view.left) viewport.scrollLeft -= view.left - rect.left;
    else if (rect.right > view.right) viewport.scrollLeft += rect.right - view.right;
    return;
  }
  if (rect.top < view.top) viewport.scrollTop -= view.top - rect.top;
  else if (rect.bottom > view.bottom) viewport.scrollTop += rect.bottom - view.bottom;
}

function WorkspaceTabItem({
  tab,
  current,
  horizontal,
  showIcons,
  closeButton,
  canCloseOthers,
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
  current: boolean;
  horizontal: boolean;
  showIcons: boolean;
  closeButton: TabCloseButton;
  canCloseOthers: boolean;
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
  const baseName = workspaceTabBaseName(tab, (key) => t(key));
  const label = workspaceTabLabel(tab, baseName);
  const Icon =
    tab.kind === 'settings'
      ? GearSix
      : tab.kind === 'blank'
        ? Plus
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
  const fillShift =
    fillDelta != null
      ? horizontal
        ? `translate3d(${fillDelta}px, 0, 0)`
        : `translate3d(0, ${fillDelta}px, 0)`
      : undefined;
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
              'group/tab relative h-7 w-(--workspace-tab-width) shrink-0 touch-none outline-none select-none [--wails-draggable:no-drag] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
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
          data-workspace-tab-axis={horizontal ? 'x' : 'y'}
          data-workspace-tab-enter={entering ? '' : undefined}
          data-workspace-tab-motion={sliding ? '' : undefined}
          className={cn(
            'absolute inset-0 flex cursor-default items-center gap-1.5 rounded-md px-2 text-left text-xs',
            current ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
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
                    ? 'via-muted to-muted'
                    : 'via-background to-background',
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
      <ContextMenuContent className="min-w-44" side={horizontal ? 'bottom' : 'right'} align="start">
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onTogglePin(tab.id)}>
            {tab.pinned ? t('workspaceTabs.unpin') : t('workspaceTabs.pin')}
          </ContextMenuItem>
        </ContextMenuGroup>
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

export function workspaceTabBaseName(tab: WorkspaceTab, translate: (key: string) => string) {
  if (tab.kind === 'settings') return translate('settings.title');
  if (tab.kind === 'blank') return translate('workspaceTabs.blankTab');
  const tool = tab.kind === 'tool' ? tools.find((item) => item.id === tab.toolId) : undefined;
  return tool ? translate(tool.nameKey) : (tab.toolId ?? '');
}

export function WorkspaceTabBar({
  orientation,
  tabs,
  activeId,
  showIcons,
  closeButton,
  onActivate,
  onClose,
  onCloseOthers,
  onTogglePin,
  onReorder,
  onRename,
  onNewTab,
}: {
  orientation: TabOrientation;
  tabs: WorkspaceTab[];
  activeId: string | null;
  showIcons: boolean;
  closeButton: TabCloseButton;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onTogglePin: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onRename: (id: string) => void;
  onNewTab: () => void;
}) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const tabsRef = useRef(tabs);
  const suppressClickRef = useRef(false);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const slotsRef = useRef<DragSlot[]>([]);
  const overIdRef = useRef<string | null>(null);
  const grabOffsetRef = useRef(0);
  const pitchRef = useRef(0);
  const activeIdRef = useRef(activeId);
  const orientationRef = useRef(orientation);
  tabsRef.current = tabs;
  activeIdRef.current = activeId;
  orientationRef.current = orientation;
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
    const along = orientationRef.current === 'horizontal' ? pointer.x : pointer.y;
    const next = nextDragOverId(slots, overIdRef.current, along - grabOffsetRef.current);
    if (!next) return [];
    overIdRef.current = next;
    return [{ id: next }];
  }, []);
  const sortingStrategy = useCallback<SortingStrategy>(({ activeIndex, overIndex, index }) => {
    const shift = tabDragShift(activeIndex, overIndex, index, pitchRef.current);
    if (!shift) return null;
    return orientationRef.current === 'horizontal'
      ? { x: shift, y: 0, scaleX: 1, scaleY: 1 }
      : { x: 0, y: shift, scaleX: 1, scaleY: 1 };
  }, []);
  const setDragActive = (active: boolean) => {
    draggingRef.current = active;
    setDragging(active);
  };
  const onDragStart = (event: DragStartEvent) => {
    setDragActive(true);
    const dragId = String(event.active.id);
    const horizontalNow = orientationRef.current === 'horizontal';
    const activeTab = tabsRef.current.find((tab) => tab.id === dragId);
    const slots: DragSlot[] = [];
    if (activeTab) {
      const pinned = Boolean(activeTab.pinned);
      for (const tab of tabsRef.current) {
        if (Boolean(tab.pinned) !== pinned) continue;
        const node = tabRefs.current.get(tab.id);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const start = horizontalNow ? rect.left : rect.top;
        const size = horizontalNow ? rect.width : rect.height;
        slots.push({ id: tab.id, mid: start + size / 2 });
      }
    }
    slotsRef.current = slots;
    overIdRef.current = dragId;
    pitchRef.current = slots.length >= 2 ? slots[1].mid - slots[0].mid : 0;
    const activator = event.activatorEvent;
    const origin = slots.find((slot) => slot.id === dragId);
    const point = pointerPosition(activator);
    grabOffsetRef.current = origin && point ? (horizontalNow ? point.x : point.y) - origin.mid : 0;
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
          workspaceTabBaseName(moved, (key) => t(key)),
        ),
        position: nextTabs.findIndex((tab) => tab.id === activeDragId) + 1,
        total: nextTabs.length,
      }),
    );
  };
  const onViewport = useCallback((viewport: HTMLElement | null) => {
    viewportRef.current = viewport;
    const id = activeIdRef.current;
    const tab = id ? tabRefs.current.get(id) : undefined;
    if (viewport && tab) scrollTabIntoView(viewport, tab, orientationRef.current);
  }, []);
  const horizontal = orientation === 'horizontal';
  const axisModifier = useMemo(() => restrictToTabAxis(horizontal), [horizontal]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const tab = activeId ? tabRefs.current.get(activeId) : undefined;
    if (!viewport || !tab) return;
    scrollTabIntoView(viewport, tab, orientation);
  }, [activeId, orientation, tabs]);

  const tabMotion = useWorkspaceTabStripMotion({
    tabIds: tabs.map((tab) => tab.id),
    orientation,
    tabNodes: tabRefs,
    listRef,
    viewportRef,
    draggingRef,
    dragging,
  });

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0',
        horizontal ? 'h-full flex-1 items-center' : 'min-h-0 flex-1 flex-col',
      )}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[axisModifier]}
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
        }}
      >
        <ScrollArea
          data-workspace-tab-scroll=""
          className={cn('min-h-0 min-w-0', horizontal ? 'h-full flex-1' : 'w-full flex-1')}
          scrollFade={horizontal ? 'x' : 'y'}
          options={{
            overflow: horizontal ? { y: 'hidden' } : { x: 'hidden' },
            scrollbars: horizontal ? { visibility: 'hidden' } : undefined,
          }}
          onViewport={onViewport}
        >
          <SortableContext items={tabs.map((tab) => tab.id)} strategy={sortingStrategy}>
            <div
              ref={listRef}
              role="tablist"
              aria-label={t('workspaceTabs.list')}
              className={cn('flex gap-1', horizontal ? 'h-full items-center' : 'flex-col')}
            >
              {tabs.map((tab) => (
                <WorkspaceTabItem
                  key={tab.id}
                  tab={tab}
                  current={tab.id === activeId}
                  horizontal={horizontal}
                  showIcons={showIcons}
                  closeButton={closeButton}
                  canCloseOthers={tabs.some((item) => item.id !== tab.id && !item.pinned)}
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
      <div
        className={cn(
          'flex flex-none [--wails-draggable:no-drag]',
          horizontal ? 'px-1' : 'justify-center py-1',
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
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
