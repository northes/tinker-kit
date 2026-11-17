import { GearSix, Plus, PushPin, X } from '@phosphor-icons/react';
import { useCallback, useLayoutEffect, useRef } from 'react';
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
  workspaceTabLabel,
  type TabCloseButton,
  type TabOrientation,
  type WorkspaceTab,
} from './workspace-tabs';

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
  onRename: (id: string) => void;
  onNewTab: () => void;
}) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const activeIdRef = useRef(activeId);
  const orientationRef = useRef(orientation);
  activeIdRef.current = activeId;
  orientationRef.current = orientation;
  const onViewport = useCallback((viewport: HTMLElement | null) => {
    viewportRef.current = viewport;
    const id = activeIdRef.current;
    const tab = id ? tabRefs.current.get(id) : undefined;
    if (viewport && tab) scrollTabIntoView(viewport, tab, orientationRef.current);
  }, []);
  const horizontal = orientation === 'horizontal';

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const tab = activeId ? tabRefs.current.get(activeId) : undefined;
    if (!viewport || !tab) return;
    scrollTabIntoView(viewport, tab, orientation);
  }, [activeId, orientation, tabs]);

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0',
        horizontal ? 'h-full flex-1 items-center' : 'min-h-0 flex-1 flex-col',
      )}
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
        <div
          role="tablist"
          aria-label={t('workspaceTabs.list')}
          className={cn('flex gap-1', horizontal ? 'h-full items-center' : 'flex-col')}
        >
          {tabs.map((tab) => {
            const baseName = workspaceTabBaseName(tab, (key) => t(key));
            const label = workspaceTabLabel(tab, baseName);
            const Icon =
              tab.kind === 'settings'
                ? GearSix
                : tab.kind === 'blank'
                  ? Plus
                  : tools.find((item) => item.id === tab.toolId)?.icon;
            const current = tab.id === activeId;
            const canCloseOthers = tabs.some((item) => item.id !== tab.id && !item.pinned);
            const canRename = tab.kind === 'tool';
            return (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger
                  render={
                    <div
                      ref={(node) => {
                        if (node) tabRefs.current.set(tab.id, node);
                        else tabRefs.current.delete(tab.id);
                      }}
                      role="tab"
                      aria-selected={current}
                      tabIndex={current ? 0 : -1}
                      title={label}
                      aria-label={
                        tab.pinned ? t('workspaceTabs.pinnedTab', { name: label }) : label
                      }
                      data-current={current ? '' : undefined}
                      data-pinned={tab.pinned ? '' : undefined}
                      data-workspace-tab=""
                      className={cn(
                        // 焦点环画在标签内侧，避免被 ScrollArea 边缘裁切
                        'group/tab relative flex h-7 w-(--workspace-tab-width) shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none select-none [--wails-draggable:no-drag] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                        current
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => onActivate(tab.id)}
                      onMouseDown={(event) => {
                        // 右键只打开菜单，不激活。中键沿用关闭。
                        if (event.button === 2) return;
                        if (event.button !== 1) return;
                        event.preventDefault();
                        onClose(tab.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        onActivate(tab.id);
                      }}
                    />
                  }
                >
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
                        current ? 'via-muted to-muted' : 'via-background to-background',
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
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(tab.id);
                        }}
                      >
                        <X size={14} weight="regular" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </ContextMenuTrigger>
                <ContextMenuContent
                  className="min-w-44"
                  side={horizontal ? 'bottom' : 'right'}
                  align="start"
                >
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
          })}
        </div>
      </ScrollArea>
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
