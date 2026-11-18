import {
  closestCenter,
  DndContext,
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
import { DotsSixVertical, Eye, EyeClosed } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SidebarToolConfig } from '../../bindings/tinkerkit/models';
import type { ToolDefinition } from '../components/SettingsPage';
import { type ToolId } from '../components/shared';
import { Button } from '../components/ui/button';
import { moveSidebarToolBy } from './navigation';

function ToolOrderRow({
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
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: tool.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 20 : undefined,
      }}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      className={`flex select-none items-center gap-0.5 rounded-md ${enabled ? '' : 'opacity-40'} ${
        isDragging ? 'bg-accent shadow-md' : `even:bg-muted/30 ${enabled ? 'hover:bg-muted/50' : ''}`
      }`}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon-sm"
        className="flex-none cursor-grab touch-none active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label={t('sidebar.dragTool', { name })}
        aria-keyshortcuts="ArrowUp ArrowDown"
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
        <DotsSixVertical size={16} weight="regular" />
        <span className="sr-only">
          {t('sidebar.moveToolUp', { name })}. {t('sidebar.moveToolDown', { name })}
        </span>
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-xs text-foreground">
        <tool.icon size={16} weight="regular" aria-hidden="true" />
        <span className="min-w-0 truncate">{name}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="flex-none"
        aria-pressed={enabled}
        aria-label={t(enabled ? 'sidebar.hideTool' : 'sidebar.showTool', { name })}
        onClick={() => onToggle(tool.id)}
      >
        {enabled ? <Eye size={16} weight="regular" /> : <EyeClosed size={16} weight="regular" />}
      </Button>
    </div>
  );
}

export function ToolOrderList({
  sidebarTools,
  tools,
  onChange,
  onRequestDisable,
}: {
  sidebarTools: SidebarToolConfig[];
  tools: ToolDefinition[];
  onChange: (tools: SidebarToolConfig[]) => void;
  onRequestDisable: (id: ToolId) => void;
}) {
  const { t } = useTranslation();
  const [liveMessage, setLiveMessage] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const rows = sidebarTools.flatMap((item) => {
    const tool = tools.find((entry) => entry.id === item.id);
    return tool ? [{ tool, enabled: item.enabled }] : [];
  });
  const announce = (id: ToolId, next: SidebarToolConfig[]) => {
    const tool = tools.find((entry) => entry.id === id);
    const position = next.findIndex((item) => item.id === id);
    if (!tool || position < 0) return;
    setLiveMessage(
      t('sidebar.movedTool', {
        name: t(tool.nameKey),
        position: position + 1,
        total: next.length,
      }),
    );
  };
  const move = (id: ToolId, delta: number) => {
    const next = moveSidebarToolBy(sidebarTools, id, delta);
    if (next === sidebarTools) return;
    onChange(next);
    announce(id, next);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = sidebarTools.findIndex((item) => item.id === String(active.id));
    const to = sidebarTools.findIndex((item) => item.id === String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(sidebarTools, from, to);
    onChange(next);
    announce(String(active.id) as ToolId, next);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map(({ tool }) => tool.id)} strategy={verticalListSortingStrategy}>
        <div role="list" aria-label={t('settings.tools')} className="flex flex-col">
          {rows.map(({ tool, enabled }, index) => (
            <ToolOrderRow
              key={tool.id}
              tool={tool}
              enabled={enabled}
              index={index}
              count={rows.length}
              onMove={move}
              onToggle={(id) => {
                const current = sidebarTools.find((item) => item.id === id);
                if (!current) return;
                if (current.enabled) {
                  onRequestDisable(id);
                  return;
                }
                onChange(sidebarTools.map((item) => (item.id === id ? { ...item, enabled: true } : item)));
              }}
            />
          ))}
        </div>
      </SortableContext>
      <div aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
    </DndContext>
  );
}
