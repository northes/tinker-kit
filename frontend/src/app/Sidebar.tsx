import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Command as CommandIcon,
  DotsSixVertical,
  Eye,
  EyeClosed,
  GearSix,
} from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SidebarToolConfig } from '../../bindings/tinkerkit/models';
import type { ToolDefinition } from '../components/SettingsPage';
import { type ToolId } from '../components/shared';
import { Button } from '../components/ui/button';
import { tools, type Page } from './definitions';
import { moveSidebarToolBy } from './navigation';

const sidebarItemClassName =
  'sidebar-item flex h-auto min-h-0 w-full items-center justify-start gap-2.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:text-primary-foreground aria-[current=page]:hover:bg-transparent aria-[current=page]:hover:text-primary-foreground [&_svg]:size-[17px]';

function SidebarManageRow({
  tool,
  enabled,
  index,
  count,
  onMove,
  onToggle,
}: {
  tool: ToolDefinition;
  enabled: boolean;
  index: number;
  count: number;
  onMove: (id: ToolId, delta: number) => void;
  onToggle: (id: ToolId) => void;
}) {
  const { t } = useTranslation();
  const name = t(tool.nameKey);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tool.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      aria-grabbed={isDragging}
      className={`flex select-none items-center gap-0.5 rounded-lg border-y-2 border-transparent ${enabled ? '' : 'opacity-40'}`}
    >
      <Button
        ref={setActivatorNodeRef}
        data-sidebar-drag-handle=""
        variant="ghost"
        size="icon-sm"
        className="flex-none cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label={t('sidebar.dragTool', { name })}
        aria-keyshortcuts="ArrowUp ArrowDown"
        aria-describedby="sidebar-manage-hint"
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            onMove(tool.id, -1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            onMove(tool.id, 1);
          } else {
            listeners?.onKeyDown?.(event);
          }
        }}
      >
        <DotsSixVertical size={16} weight="duotone" />
        <span className="sr-only">
          {t('sidebar.moveToolUp', { name })}. {t('sidebar.moveToolDown', { name })}
        </span>
      </Button>
      <div
        className={`${sidebarItemClassName} pointer-events-none min-w-0 flex-1 hover:bg-transparent`}
      >
        <tool.icon data-icon="inline-start" size={17} weight="duotone" />
        <span className="min-w-0 truncate">{name}</span>
      </div>
      <Button
        data-sidebar-control=""
        variant="ghost"
        size="icon-sm"
        className="flex-none"
        aria-pressed={enabled}
        aria-label={t(enabled ? 'sidebar.hideTool' : 'sidebar.showTool', { name })}
        onClick={() => onToggle(tool.id)}
      >
        {enabled ? <EyeClosed size={16} weight="duotone" /> : <Eye size={16} weight="duotone" />}
      </Button>
    </div>
  );
}

function SidebarManagePreview({ tool, enabled }: { tool: ToolDefinition; enabled: boolean }) {
  const { t } = useTranslation();
  const name = t(tool.nameKey);
  return (
    <div
      aria-hidden
      className={`pointer-events-none flex select-none items-center gap-0.5 rounded-lg border-y-2 border-transparent bg-muted shadow-sm ${enabled ? '' : 'opacity-40'}`}
    >
      <Button variant="ghost" size="icon-sm" tabIndex={-1} className="flex-none cursor-grabbing">
        <DotsSixVertical size={16} weight="duotone" />
      </Button>
      <div
        className={`${sidebarItemClassName} pointer-events-none min-w-0 flex-1 hover:bg-transparent`}
      >
        <tool.icon data-icon="inline-start" size={17} weight="duotone" />
        <span className="min-w-0 truncate">{name}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        tabIndex={-1}
        className="pointer-events-none flex-none"
      >
        {enabled ? <EyeClosed size={16} weight="duotone" /> : <Eye size={16} weight="duotone" />}
      </Button>
    </div>
  );
}

export function Sidebar({
  page,
  onNavigate,
  onOpenPalette,
  managing,
  sidebarTools,
  onSidebarToolsChange,
  onExitManage,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  onOpenPalette: () => void;
  managing: boolean;
  sidebarTools: SidebarToolConfig[];
  onSidebarToolsChange: (tools: SidebarToolConfig[]) => void;
  onExitManage: () => void;
}) {
  const { t } = useTranslation();
  const [liveMessage, setLiveMessage] = useState('');
  const [activeId, setActiveId] = useState<ToolId | null>(null);
  const [highlight, setHighlight] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const orderedTools = sidebarTools.flatMap((item) => {
    const tool = tools.find((entry) => entry.id === item.id);
    return tool ? [{ tool, enabled: item.enabled }] : [];
  });
  const visibleTools = managing ? orderedTools : orderedTools.filter((item) => item.enabled);
  const activeTool = activeId ? visibleTools.find(({ tool }) => tool.id === activeId) : undefined;
  // 选中高亮由滚动容器内的一块共享背景承担，位置取自当前 aria-current 项，
  // 切换页面时只改 transform，因此高亮会滑到新选中项而不是原地跳变。
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const sync = () => {
      const current = container.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current || !current.offsetWidth) {
        setHighlight(null);
        return;
      }
      const next = {
        left: current.offsetLeft,
        top: current.offsetTop,
        width: current.offsetWidth,
        height: current.offsetHeight,
      };
      setHighlight((previous) =>
        previous &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : next,
      );
    };
    sync();
    // 侧栏宽度（完整/图标模式）、字号和语言都会改变项的位置；尺寸变化即时生效，
    // 只有切换选中项时的位置变化才做位移过渡。
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    const current = container.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) observer.observe(current);
    return () => observer.disconnect();
  }, [page, managing, sidebarTools]);
  const announceMove = (id: ToolId, next: SidebarToolConfig[]) => {
    const tool = tools.find((entry) => entry.id === id);
    const position = next.findIndex((item) => item.id === id) + 1;
    if (!tool || position === 0) return;
    const message = t('sidebar.movedTool', {
      name: t(tool.nameKey),
      position,
      count: next.length,
    });
    setLiveMessage('');
    requestAnimationFrame(() => setLiveMessage(message));
  };
  return (
    <aside
      id="app-sidebar"
      className="sidebar flex min-h-0 flex-col overflow-hidden border-r border-border bg-background"
    >
      <div
        ref={scrollRef}
        className="no-scrollbar relative isolate flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3"
      >
        {highlight && (
          <div
            aria-hidden
            className="pointer-events-none absolute -z-10 rounded-lg bg-primary transition-transform motion-reduce:transition-none"
            style={{
              transform: `translate(${highlight.left}px, ${highlight.top}px)`,
              width: highlight.width,
              height: highlight.height,
            }}
          />
        )}
        {managing && (
          <div className="sticky top-0 z-10 mb-1 flex flex-none flex-col gap-2 border-b border-border bg-background py-3">
            <div className="px-2">
              <div className="text-xs font-semibold text-foreground">
                {t('sidebar.manageTitle')}
              </div>
              <p
                id="sidebar-manage-hint"
                className="m-0 text-[10px] leading-[1.5] text-muted-foreground"
              >
                {t('sidebar.manageHint')}
              </p>
            </div>
            <Button id="sidebar-manage-done" className="w-full text-[11px]" onClick={onExitManage}>
              {t('sidebar.done')}
            </Button>
            <div className="sr-only" aria-live="polite" aria-atomic="true">
              {liveMessage}
            </div>
          </div>
        )}
        {(managing || visibleTools.length > 0) && (
          <nav
            className="flex flex-col gap-0.5"
            aria-label={managing ? t('sidebar.manageTitle') : t('groups.tools')}
          >
            <div className="sidebar-heading my-4 mb-1 px-2 text-[9px] font-medium uppercase tracking-[.08em] text-muted-foreground">
              {t('groups.tools')}
            </div>
            {managing ? (
              <div role="list" className="flex flex-col gap-0.5">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={({ active }) => setActiveId(String(active.id) as ToolId)}
                  onDragCancel={() => setActiveId(null)}
                  onDragEnd={({ active, over }: DragEndEvent) => {
                    setActiveId(null);
                    if (!over || active.id === over.id) return;
                    const from = sidebarTools.findIndex((item) => item.id === String(active.id));
                    const to = sidebarTools.findIndex((item) => item.id === String(over.id));
                    if (from < 0 || to < 0) return;
                    const next = arrayMove(sidebarTools, from, to);
                    onSidebarToolsChange(next);
                    announceMove(String(active.id) as ToolId, next);
                  }}
                >
                  <SortableContext
                    items={visibleTools.map(({ tool }) => tool.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {visibleTools.map(({ tool, enabled }, index) => (
                      <SidebarManageRow
                        key={tool.id}
                        tool={tool}
                        enabled={enabled}
                        index={index}
                        count={visibleTools.length}
                        onMove={(id, delta) => {
                          const next = moveSidebarToolBy(sidebarTools, id, delta);
                          if (next === sidebarTools) return;
                          onSidebarToolsChange(next);
                          announceMove(id, next);
                        }}
                        onToggle={(id) =>
                          onSidebarToolsChange(
                            sidebarTools.map((item) =>
                              item.id === id ? { ...item, enabled: !item.enabled } : item,
                            ),
                          )
                        }
                      />
                    ))}
                  </SortableContext>
                  <DragOverlay dropAnimation={null}>
                    {activeTool ? (
                      <SidebarManagePreview tool={activeTool.tool} enabled={activeTool.enabled} />
                    ) : null}
                  </DragOverlay>
                </DndContext>
              </div>
            ) : (
              visibleTools.map(({ tool }) => (
                <Button
                  key={tool.id}
                  variant="ghost"
                  className={sidebarItemClassName}
                  aria-current={page === tool.id ? 'page' : undefined}
                  aria-label={t(tool.nameKey)}
                  title={t(tool.nameKey)}
                  onClick={() => onNavigate(tool.id)}
                >
                  <tool.icon data-icon="inline-start" size={17} weight="duotone" />
                  <span>{t(tool.nameKey)}</span>
                </Button>
              ))
            )}
          </nav>
        )}
        <nav className="mb-3 flex flex-col gap-0.5" aria-label={t('groups.system')}>
          <div className="sidebar-heading my-4 mb-1 px-2 text-[9px] font-medium uppercase tracking-[.08em] text-muted-foreground">
            {t('groups.system')}
          </div>
          <Button
            variant="ghost"
            className={sidebarItemClassName}
            aria-current={page === 'settings' ? 'page' : undefined}
            aria-label={t('titlebar.settings')}
            title={t('titlebar.settings')}
            onClick={() => onNavigate('settings')}
          >
            <GearSix data-icon="inline-start" size={17} weight="duotone" />
            <span>{t('titlebar.settings')}</span>
          </Button>
        </nav>
      </div>
      <div className="sidebar-footer mx-3 mt-0.5 flex-none border-t border-border pt-3 pb-4">
        <Button
          variant="ghost"
          className="sidebar-palette flex h-[30px] min-h-0 w-full items-center justify-start gap-2.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-[17px]"
          onClick={onOpenPalette}
          aria-label={t('statusbar.openPalette')}
          title={t('statusbar.openPalette')}
        >
          <CommandIcon data-icon="inline-start" size={17} weight="duotone" />
          <span className="min-w-0 flex-1 truncate">{t('statusbar.openPalette')}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <kbd className="rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}
            </kbd>
            <kbd className="rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
              K
            </kbd>
          </span>
        </Button>
      </div>
    </aside>
  );
}
