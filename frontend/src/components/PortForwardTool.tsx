import { Browser } from '@wailsio/runtime';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ArrowCounterClockwise,
  Copy,
  DotsSixVertical,
  GearSix,
  PencilSimple,
  Play,
  Plus,
  Stop,
  Trash,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  AddForward,
  DeleteForward,
  GetColumnWidths,
  GetForwardSources,
  GetForwards,
  ReorderForwards,
  SaveColumnWidths,
  SaveForwardSources,
  StartForward,
  StopForward,
  UpdateForward,
} from '../../bindings/tinkerkit/portservice';
import type { PortForward, PortForwardRequest, PortSource } from '../../bindings/tinkerkit/models';
import { formatBackendError } from '../lib/backend-error';
import { selectAllOnFocus } from '../lib/select-all-on-focus';
import { isLocalSource, sourceLabel } from '../lib/local-source';
import { createLastSourceMemory } from '../lib/last-source';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { SSHProfileFormField } from './SSHProfileFormField';
import { ConfirmDialog } from './ConfirmDialog';
import { SourceCombobox } from './SourceCombobox';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import {
  ToolActionButton,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  WheelText,
} from './shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { toast } from './ui/toast';
import {
  FilterMenu,
  PortListFrame,
  SearchField,
  SortableHead,
  clampColumnWidth,
  resolveColumnWidths,
  type SortDirection,
} from './port-list-chrome';

const initialForward: PortForwardRequest = {
  name: '',
  sourceID: '',
  direction: 'local',
  listenHost: '127.0.0.1',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80,
};

// 本次运行内最近一次用过的转发来源：「新建转发」表单默认沿用同一个来源。
// 只活在内存里，不写 localStorage，也不跨重启恢复。
const forwardSourceMemory = createLastSourceMemory();

// 拖动列宽的把手宽度，固定不参与列宽持久化。
const FORWARD_HANDLE_COLUMN_WIDTH = 40;
const FORWARD_COLUMNS = [
  'forwardName',
  'direction',
  'source',
  'listen',
  'target',
  'status',
  'retries',
] as const;
type ForwardSortKey = (typeof FORWARD_COLUMNS)[number];
const FORWARD_COLUMN_WIDTHS: Record<ForwardSortKey, number> = {
  forwardName: 170,
  direction: 150,
  source: 120,
  listen: 200,
  target: 200,
  status: 100,
  retries: 84,
};
type SortState = { key: ForwardSortKey; direction: SortDirection };

// 转发处于活动状态（含连接中与重连中）；其余（已停止、失败）可再次启动。
function isForwardRunning(forward: PortForward) {
  return (
    forward.status === 'connecting' ||
    forward.status === 'connected' ||
    forward.status === 'reconnecting'
  );
}

// 显示名：命名优先，留空时回退到监听地址，与新增/编辑表单的 placeholder 一致。
function forwardLabel(forward: PortForward) {
  return forward.name || `${forward.listenHost}:${forward.listenPort}`;
}

// 地址只是 host:port，浏览器需要显式协议；通配监听地址改用本机回环地址访问。
function browserAddress(host: string, port: number) {
  const trimmed = host.trim().replace(/^\[(.*)\]$/, '$1');
  const normalized =
    !trimmed || trimmed === '*' || trimmed === '0.0.0.0' || trimmed === '::'
      ? '127.0.0.1'
      : trimmed;
  const address = normalized.includes(':') ? `[${normalized}]` : normalized;
  return `http://${address}:${port}`;
}

function ForwardAddressLink({ host, port }: { host: string; port: number }) {
  const { t } = useTranslation();
  const address = `${host}:${port}`;
  const url = browserAddress(host, port);
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto w-full cursor-pointer justify-start p-0 text-left font-normal text-inherit hover:text-primary"
      aria-label={t('portTool.openInBrowser', { url })}
      title={t('portTool.openInBrowser', { url })}
      onClick={() => void Browser.OpenURL(url)}
    >
      <WheelText>{address}</WheelText>
    </Button>
  );
}

// 转发行同时是 dnd-kit 的可排序项：首列是拖动手柄，键盘可用上下键调整顺序。
// 列排序是临时视图，定义顺序不可见，因此只有默认顺序下才提供拖动手柄。
function ForwardRow({
  forward,
  sourceName,
  sortable,
  busy,
  rowIndex,
  onToggle,
  onEdit,
  onCopy,
  onDelete,
  onMove,
}: {
  forward: PortForward;
  sourceName: string;
  sortable: boolean;
  busy: boolean;
  rowIndex: number;
  onToggle: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const name = forwardLabel(forward);
  const running = isForwardRunning(forward);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: forward.id,
    disabled: !sortable,
  });
  // 与 JSON 流水线一致：纵向列表只透传 y 位移，否则被拖动行会在横向滚动容器里撑出滚动条。
  // 提升到表头（z-10）之上，避免拖动时被吸顶表头盖住。
  const style = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <TableRow
            ref={setNodeRef}
            style={style}
            className={`border-b-0 hover:bg-transparent [&>td]:transition-colors hover:[&>td]:bg-muted/50 hover:[&>td:first-child]:rounded-l-md hover:[&>td:last-child]:rounded-r-md ${rowIndex % 2 === 1 ? '[&>td]:bg-muted/30 [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md' : ''} ${running ? '' : 'text-muted-foreground'} ${isDragging ? 'bg-accent' : ''}`}
          />
        }
      >
        <TableCell className="w-[40px]">
          {sortable ? (
            <Button
              ref={setActivatorNodeRef}
              variant="ghost"
              size="icon-xs"
              className="cursor-grab touch-none text-muted-foreground/60 active:cursor-grabbing"
              {...attributes}
              {...listeners}
              aria-label={t('portTool.dragForward', { name })}
              aria-keyshortcuts="ArrowUp ArrowDown"
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  onMove(-1);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  onMove(1);
                } else {
                  listeners?.onKeyDown?.(event);
                }
              }}
            >
              <DotsSixVertical weight="regular" />
              <span className="sr-only">
                {t('portTool.moveForwardUp', { name })}. {t('portTool.moveForwardDown', { name })}
              </span>
            </Button>
          ) : null}
        </TableCell>
        <TableCell>
          <WheelText>{name}</WheelText>
        </TableCell>
        <TableCell>{t(`portTool.${forward.direction}Forward`)}</TableCell>
        <TableCell>
          <WheelText>{sourceName}</WheelText>
        </TableCell>
        <TableCell>
          <ForwardAddressLink host={forward.listenHost} port={forward.listenPort} />
        </TableCell>
        <TableCell>
          <ForwardAddressLink host={forward.targetHost} port={forward.targetPort} />
        </TableCell>
        <TableCell>
          {t(`portTool.${forward.status}`)}
          {forward.error && (
            <WheelText className="text-xs text-destructive">
              {formatBackendError(forward.error)}
            </WheelText>
          )}
        </TableCell>
        <TableCell>{forward.retries}/5</TableCell>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem disabled={busy} onClick={onToggle}>
          {running ? <Stop weight="regular" /> : <Play weight="regular" />}
          {t(running ? 'portTool.stop' : 'portTool.start')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onEdit}>
          <PencilSimple weight="regular" />
          {t('portTool.editForward')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCopy}>
          <Copy weight="regular" />
          {t('portTool.copyForward')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash weight="regular" />
          {t('portTool.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default function PortForwardTool({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const { profiles } = useSSHProfiles();
  const [sources, setSources] = useState<PortSource[]>([]);
  const [forwardViewport, setForwardViewport] = useState<HTMLElement | null>(null);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [forwardSearchDraft, setForwardSearchDraft] = useState('');
  const [forwardSearch, setForwardSearch] = useState('');
  const [directionFilter, setDirectionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  // 转发列表默认按持久化的定义顺序展示，新增的规则追加在末尾；列排序是临时视图。
  const [forwardSort, setForwardSort] = useState<SortState | null>(null);
  const [forwardLiveMessage, setForwardLiveMessage] = useState('');
  const [forwardColumnWidths, setForwardColumnWidths] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PortForwardRequest>(initialForward);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [busyForward, setBusyForward] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PortForward | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const [savingSources, setSavingSources] = useState(false);

  const refreshSources = useCallback(async () => {
    try {
      setSources((await GetForwardSources()) ?? []);
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  }, []);

  useEffect(() => {
    if (active) void refreshSources();
  }, [active, refreshSources]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => void refreshSources();
    window.addEventListener('tinkerkit:config-replaced', refresh);
    return () => window.removeEventListener('tinkerkit:config-replaced', refresh);
  }, [active, refreshSources]);

  const refreshForwards = useCallback(async () => {
    try {
      setForwards((await GetForwards()) ?? []);
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  }, []);
  // 隐藏标签不轮询。关掉标签只卸载页面，不在这里停止隧道。
  useEffect(() => {
    if (!active) return;
    void refreshForwards();
    const timer = window.setInterval(() => void refreshForwards(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refreshForwards]);
  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const stored = await GetColumnWidths();
        if (canceled || !stored) return;
        setForwardColumnWidths(stored.forwards ?? []);
      } catch (cause) {
        if (!canceled) setError(formatBackendError(cause));
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  const submitForward = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !form.sourceID) return;
    setSaving(true);
    setFormError('');
    try {
      const saved = editingId ? await UpdateForward(editingId, form) : await AddForward(form);
      forwardSourceMemory.remember(form.sourceID);
      setDialog(false);
      setEditingId(null);
      await refreshForwards();
      // 监听端口被占用时后端仍会创建/更新定义，只是不启动；此处提示原因。
      if (saved && !isForwardRunning(saved) && saved.error) {
        toast.add({
          title: t('portTool.forwardNotStarted'),
          description: formatBackendError(saved.error),
          type: 'warning',
        });
      }
    } catch (cause) {
      setFormError(formatBackendError(cause));
    } finally {
      setSaving(false);
    }
  };
  const startForward = async (forward: PortForward) => {
    if (busyForward) return;
    setBusyForward(forward.id);
    setError('');
    try {
      await StartForward(forward.id);
      await refreshForwards();
    } catch (cause) {
      setError(formatBackendError(cause));
    } finally {
      setBusyForward('');
    }
  };
  const stopForward = async (forward: PortForward) => {
    if (busyForward) return;
    setBusyForward(forward.id);
    setError('');
    try {
      await StopForward(forward.id);
      await refreshForwards();
    } catch (cause) {
      setError(formatBackendError(cause));
    } finally {
      setBusyForward('');
    }
  };
  const deleteForward = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await DeleteForward(deleteTarget.id);
      setDeleteTarget(null);
      await refreshForwards();
    } catch (cause) {
      setDeleteError(formatBackendError(cause));
    } finally {
      setDeleting(false);
    }
  };
  const forwardSourceOptions = sources
    .filter((item) => item.kind === 'ssh' && !isLocalSource(item))
    .map((item) => ({ value: item.id, label: item.name }));
  // 弹窗同时承载新增、编辑与复制：editingId 为空时保存会创建新转发。
  const openForwardForm = (next: { editingId: string | null; request: PortForwardRequest }) => {
    setError('');
    setFormError('');
    setEditingId(next.editingId);
    setForm(next.request);
    setDialog(true);
  };
  const forwardRequest = (forward: PortForward): PortForwardRequest => ({
    name: forward.name,
    sourceID: forward.sourceID,
    direction: forward.direction,
    listenHost: forward.listenHost,
    listenPort: forward.listenPort,
    targetHost: forward.targetHost,
    targetPort: forward.targetPort,
  });
  const newForwardRequest = (): PortForwardRequest => ({
    ...initialForward,
    // 来源默认取本工具上次用过的那个（仍在选项里才行），否则回退到选项首项。
    sourceID: forwardSourceMemory.resolve(
      forwardSourceOptions.map((option) => option.value),
      forwardSourceOptions[0]?.value ?? '',
    ),
  });
  const openSourceManager = () => setManageOpen(true);

  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  );
  const sourceNames = useMemo(
    () => new Map(sources.map((item) => [item.id, sourceLabel(item, t('portTool.localMachine'))])),
    [sources, t],
  );
  const forwardSourceIDs = useMemo(
    () =>
      Array.from(
        new Set([
          ...forwards.map((forward) => forward.sourceID),
          ...(sourceFilter === 'all' ? [] : [sourceFilter]),
        ]),
      ).sort((a, b) => collator.compare(sourceNames.get(a) ?? a, sourceNames.get(b) ?? b)),
    [forwards, sourceFilter, sourceNames, collator],
  );
  const forwardField = useCallback(
    (forward: PortForward, key: ForwardSortKey): string | number => {
      switch (key) {
        case 'forwardName':
          return forwardLabel(forward);
        case 'source':
          return sourceNames.get(forward.sourceID) ?? t('portTool.missingSource');
        case 'listen':
          return `${forward.listenHost}:${forward.listenPort}`;
        case 'target':
          return `${forward.targetHost}:${forward.targetPort}`;
        case 'direction':
          return t(`portTool.${forward.direction}Forward`);
        case 'status':
          return t(`portTool.${forward.status}`);
        case 'retries':
          return forward.retries;
      }
    },
    [sourceNames, t],
  );
  const visibleForwardData = useMemo(() => {
    const query = forwardSearch.toLocaleLowerCase(i18n.language);
    const result = forwards.filter(
      (forward) =>
        (directionFilter === 'all' || forward.direction === directionFilter) &&
        (statusFilter === 'all' || forward.status === statusFilter) &&
        (sourceFilter === 'all' || forward.sourceID === sourceFilter) &&
        (!query ||
          [...FORWARD_COLUMNS.map((key) => forwardField(forward, key)), forward.error ?? ''].some(
            (value) => String(value).toLocaleLowerCase(i18n.language).includes(query),
          )),
    );
    if (!forwardSort) return result;
    const { key, direction } = forwardSort;
    result.sort((a, b) => {
      const left = forwardField(a, key);
      const right = forwardField(b, key);
      const compared =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right));
      return (direction === 'asc' ? compared : -compared) || collator.compare(a.id, b.id);
    });
    return result;
  }, [
    forwards,
    forwardSearch,
    directionFilter,
    statusFilter,
    sourceFilter,
    forwardSort,
    forwardField,
    collator,
    i18n.language,
  ]);
  const columnWidths = useMemo(
    () => resolveColumnWidths(FORWARD_COLUMNS, FORWARD_COLUMN_WIDTHS, forwardColumnWidths),
    [forwardColumnWidths],
  );
  const forwardTableMinWidth =
    FORWARD_HANDLE_COLUMN_WIDTH + columnWidths.reduce((total, width) => total + width, 0);
  const columnWidthsRef = useRef(forwardColumnWidths);
  useEffect(() => {
    columnWidthsRef.current = forwardColumnWidths;
  }, [forwardColumnWidths]);
  const saveColumnWidths = async () => {
    try {
      // 空的 ports 不会清掉占用页按主机保存的列宽。
      await SaveColumnWidths({ ports: {}, forwards: columnWidthsRef.current });
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  };
  // 拖动只改本地宽度，松手或键盘抬起时一次性写回配置，避免每次移动都落库。
  const resizeForwardColumn = (index: number, width: number) => {
    setForwardColumnWidths((current) => {
      const next = resolveColumnWidths(FORWARD_COLUMNS, FORWARD_COLUMN_WIDTHS, current);
      next[index] = clampColumnWidth(width);
      return next;
    });
  };
  const changeForwardSort = (key: ForwardSortKey) =>
    setForwardSort((current) => ({
      key,
      direction: current?.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  useEffect(() => {
    forwardViewport?.scrollTo({ top: 0 });
  }, [forwardViewport, forwardSearch, directionFilter, statusFilter, sourceFilter, forwardSort]);
  const forwardSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const announceForwardMove = (id: string, next: PortForward[]) => {
    const position = next.findIndex((forward) => forward.id === id);
    if (position < 0) return;
    const message = t('portTool.movedForward', {
      name: forwardLabel(next[position]),
      position: position + 1,
      total: next.length,
    });
    setForwardLiveMessage('');
    requestAnimationFrame(() => setForwardLiveMessage(message));
  };
  // 拖动和键盘排序都写回持久化的定义顺序，刷新后顺序保持一致。
  const reorderForward = async (activeID: string, overID: string) => {
    const from = forwards.findIndex((forward) => forward.id === activeID);
    const to = forwards.findIndex((forward) => forward.id === overID);
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(forwards, from, to);
    announceForwardMove(activeID, next);
    try {
      await ReorderForwards(next.map((forward) => forward.id));
      await refreshForwards();
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  };
  const moveForwardBy = (id: string, delta: number) => {
    const index = visibleForwardData.findIndex((forward) => forward.id === id);
    const target = index < 0 ? undefined : visibleForwardData[index + delta];
    if (target) void reorderForward(id, target.id);
  };

  // 已提交搜索或任一筛选离开默认值时显示「找到 N 项」；否则只显示可见条数。
  const forwardQueryActive =
    forwardSearch.trim() !== '' ||
    directionFilter !== 'all' ||
    statusFilter !== 'all' ||
    sourceFilter !== 'all';

  const saveSources = async (next: PortSource[]) => {
    if (savingSources) return;
    setSavingSources(true);
    try {
      await SaveForwardSources(next);
      await refreshSources();
    } finally {
      setSavingSources(false);
    }
  };
  const sourceName = (id: string) => sourceNames.get(id) ?? t('portTool.missingSource');

  return (
    <ToolLayout>
      <ToolLayoutContent>
        <PortListFrame>
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <SearchField
              id="forward-search"
              label={t('portTool.search')}
              placeholder={t('portTool.searchForwardsPlaceholder')}
              draft={forwardSearchDraft}
              onDraftChange={setForwardSearchDraft}
              onSearch={setForwardSearch}
            />
            <FilterMenu
              label={t('portTool.filters')}
              groups={[
                {
                  key: 'direction',
                  label: t('portTool.direction'),
                  value: directionFilter,
                  onChange: setDirectionFilter,
                  options: [
                    { value: 'all', label: t('portTool.allDirections') },
                    { value: 'local', label: t('portTool.localForward') },
                    { value: 'remote', label: t('portTool.remoteForward') },
                  ],
                },
                {
                  key: 'status',
                  label: t('portTool.status'),
                  value: statusFilter,
                  onChange: setStatusFilter,
                  options: [
                    { value: 'all', label: t('portTool.allStatuses') },
                    ...(['connecting', 'connected', 'reconnecting', 'failed'] as const).map(
                      (status) => ({ value: status, label: t(`portTool.${status}`) }),
                    ),
                  ],
                },
                {
                  key: 'source',
                  label: t('portTool.source'),
                  value: sourceFilter,
                  onChange: setSourceFilter,
                  options: [
                    { value: 'all', label: t('portTool.allSources') },
                    ...forwardSourceIDs.map((id) => ({
                      value: id,
                      label: sourceName(id),
                    })),
                  ],
                },
              ]}
            />
            {forwardSort !== null && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setForwardSort(null)}
              >
                <ArrowCounterClockwise weight="regular" data-icon="inline-start" size={14} />
                {t('portTool.defaultOrder')}
              </Button>
            )}
            <div className="ml-auto flex flex-none items-center gap-2">
              <ToolActionButton
                icon={GearSix}
                label={t('portTool.manageForwardSources')}
                onPress={openSourceManager}
              />
              <ToolActionButton
                variant="primary"
                icon={Plus}
                label={t('portTool.add')}
                onPress={() => openForwardForm({ editingId: null, request: newForwardRequest() })}
              />
            </div>
          </div>
          <DndContext
            sensors={forwardSensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active: dragged, over }) => {
              if (!over || dragged.id === over.id) return;
              void reorderForward(String(dragged.id), String(over.id));
            }}
          >
            <SortableContext
              items={visibleForwardData.map((forward) => forward.id)}
              strategy={verticalListSortingStrategy}
            >
              <ScrollArea
                className="min-h-0 flex-1"
                edgeOverlay
                edgeOverlayTopClass="top-10"
                options={{ overflow: { x: 'scroll' } }}
                onViewport={setForwardViewport}
              >
                <Table
                  className="table-fixed"
                  style={{ minWidth: forwardTableMinWidth }}
                  containerClassName="overflow-x-visible"
                >
                  <TableHeader className="sticky top-0 z-10 bg-background [&_tr]:border-b-0">
                    <TableRow className="hover:bg-transparent [&>th]:bg-[color-mix(in_oklch,var(--muted)_45%,var(--background))] [&>th]:text-muted-foreground [&>th:first-child]:rounded-l-md [&>th:last-child]:rounded-r-md">
                      <TableHead style={{ width: FORWARD_HANDLE_COLUMN_WIDTH }}>
                        <span className="sr-only">{t('portTool.order')}</span>
                      </TableHead>
                      {FORWARD_COLUMNS.map((key, index) => (
                        <SortableHead
                          key={key}
                          label={t(`portTool.${key}`)}
                          active={forwardSort?.key === key}
                          direction={forwardSort?.direction ?? 'asc'}
                          onSort={() => changeForwardSort(key)}
                          width={columnWidths[index]}
                          onResize={(width) => resizeForwardColumn(index, width)}
                          onResizeEnd={() => void saveColumnWidths()}
                        />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleForwardData.map((forward, index) => (
                      <ForwardRow
                        key={forward.id}
                        forward={forward}
                        sourceName={sourceName(forward.sourceID)}
                        sortable={forwardSort === null}
                        busy={busyForward !== ''}
                        rowIndex={index}
                        onToggle={() =>
                          isForwardRunning(forward)
                            ? void stopForward(forward)
                            : void startForward(forward)
                        }
                        onEdit={() =>
                          openForwardForm({
                            editingId: forward.id,
                            request: forwardRequest(forward),
                          })
                        }
                        onCopy={() =>
                          openForwardForm({
                            editingId: null,
                            request: forwardRequest(forward),
                          })
                        }
                        onDelete={() => {
                          setDeleteError('');
                          setDeleteTarget(forward);
                        }}
                        onMove={(delta) => moveForwardBy(forward.id, delta)}
                      />
                    ))}
                  </TableBody>
                </Table>
                {visibleForwardData.length === 0 && (
                  <p className="py-8 text-center text-muted-foreground">
                    {t(forwards.length ? 'portTool.noMatches' : 'portTool.emptyForwards')}
                  </p>
                )}
              </ScrollArea>
            </SortableContext>
          </DndContext>
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {forwardLiveMessage}
          </div>
        </PortListFrame>
      </ToolLayoutContent>
      <ToolLayoutFooter>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 pt-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              {forwardQueryActive
                ? t('common.foundCount', { total: visibleForwardData.length })
                : forwards.length
                  ? t('common.itemCount', { total: visibleForwardData.length })
                  : ''}
            </span>
          </div>
        </div>
      </ToolLayoutFooter>
      <Dialog
        open={dialog}
        onOpenChange={(open) => {
          if (saving) return;
          setDialog(open);
          if (!open) setEditingId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(editingId ? 'portTool.editForward' : 'portTool.add')}</DialogTitle>
            <DialogDescription>
              {t(
                form.direction === 'remote'
                  ? 'portTool.forwardHintRemote'
                  : 'portTool.forwardHintLocal',
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            id="port-forward-form"
            className="grid gap-3"
            onSubmit={(event) => void submitForward(event)}
          >
            <div>
              <Label htmlFor="forward-name">{t('portTool.forwardName')}</Label>
              <Input
                id="forward-name"
                className="mt-1"
                value={form.name}
                placeholder={`${form.listenHost}:${form.listenPort}`}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
            <div>
              <Label htmlFor="forward-source">{t('portTool.source')}</Label>
              <SourceCombobox
                id="forward-source"
                label={t('portTool.source')}
                className="mt-1 w-full"
                items={forwardSourceOptions}
                value={form.sourceID || null}
                onValueChange={(value) => {
                  setForm((current) => ({ ...current, sourceID: value }));
                  // 表单里改过的来源就是下次新建转发的默认来源。
                  forwardSourceMemory.remember(value);
                }}
                manage={{ label: t('portTool.manageSources'), onClick: openSourceManager }}
              />
            </div>
            <div>
              <Label htmlFor="forward-direction">{t('portTool.direction')}</Label>
              <Select
                items={[
                  { value: 'local', label: t('portTool.localForward') },
                  { value: 'remote', label: t('portTool.remoteForward') },
                ]}
                value={form.direction}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, direction: value || 'local' }))
                }
              >
                <SelectTrigger id="forward-direction" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="local">{t('portTool.localForward')}</SelectItem>
                    <SelectItem value="remote">{t('portTool.remoteForward')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="forward-listen-host">
                  {t(
                    form.direction === 'remote'
                      ? 'portTool.listenHostRemote'
                      : 'portTool.listenHostLocal',
                  )}
                </Label>
                <Input
                  id="forward-listen-host"
                  className="mt-1"
                  required
                  value={form.listenHost}
                  onFocus={selectAllOnFocus}
                  onMouseDown={selectAllOnFocus}
                  onMouseUp={selectAllOnFocus}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, listenHost: event.target.value }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="forward-listen-port">
                  {t(
                    form.direction === 'remote'
                      ? 'portTool.listenPortRemote'
                      : 'portTool.listenPortLocal',
                  )}
                </Label>
                <Input
                  id="forward-listen-port"
                  className="mt-1"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={form.listenPort}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, listenPort: Number(event.target.value) }))
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="forward-target-host">
                  {t(
                    form.direction === 'remote'
                      ? 'portTool.targetHostRemote'
                      : 'portTool.targetHostLocal',
                  )}
                </Label>
                <Input
                  id="forward-target-host"
                  className="mt-1"
                  required
                  value={form.targetHost}
                  onFocus={selectAllOnFocus}
                  onMouseDown={selectAllOnFocus}
                  onMouseUp={selectAllOnFocus}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, targetHost: event.target.value }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="forward-target-port">
                  {t(
                    form.direction === 'remote'
                      ? 'portTool.targetPortRemote'
                      : 'portTool.targetPortLocal',
                  )}
                </Label>
                <Input
                  id="forward-target-port"
                  className="mt-1"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={form.targetPort}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, targetPort: Number(event.target.value) }))
                  }
                />
              </div>
            </div>
          </form>
          {formError && (
            <p role="alert" className="text-xs leading-5 text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialog(false);
                setEditingId(null);
              }}
            >
              {t('portTool.cancel')}
            </Button>
            <Button type="submit" form="port-forward-form" disabled={saving || !form.sourceID}>
              {t(editingId ? 'common.save' : 'portTool.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('portTool.deleteConfirmTitle')}
        description={t('portTool.deleteConfirmDescription', {
          name: deleteTarget ? forwardLabel(deleteTarget) : '',
        })}
        confirmLabel={t('portTool.delete')}
        destructive
        busy={deleting}
        error={deleteError}
        onConfirm={() => void deleteForward()}
      />
      <TargetHostManagerDialog<PortSource, PortSource>
        open={manageOpen}
        onOpenChange={setManageOpen}
        items={sources}
        itemKey={(item) => item.id}
        itemName={(item) => sourceLabel(item, t('portTool.localMachine'))}
        activeKey={dialog ? form.sourceID || undefined : undefined}
        itemDisabled={isLocalSource}
        createDraft={() => ({
          id: '',
          name: '',
          kind: 'ssh',
          sshProfileID: profiles[0]?.id ?? '',
        })}
        toDraft={(item) => ({ ...item })}
        commitDraft={(draft, previous) => {
          const profile = profiles.find((item) => item.id === draft.sshProfileID);
          if (!profile) return t('portTool.sshProfileRequired');
          const next: PortSource = {
            id: draft.id || `forward:${crypto.randomUUID()}`,
            name: draft.name.trim() || profile.name,
            kind: 'ssh',
            sshProfileID: profile.id,
          };
          return upsertManagerItem(previous, next, (item) => item.id, draft.id || undefined);
        }}
        saveItems={saveSources}
        saving={savingSources}
        renderMeta={(item) =>
          isLocalSource(item) ? (
            <span>{t('portTool.localMachine')}</span>
          ) : (
            <>
              <span>{t('portTool.sourceKindSsh')}</span>
              {!profiles.some((profile) => profile.id === item.sshProfileID) ? (
                <Badge variant="destructive">{t('portTool.sshProfileMissing')}</Badge>
              ) : null}
            </>
          )
        }
        renderForm={({ draft, setDraft }) => (
          <>
            <div className="grid gap-1.5">
              <Label>{t('portTool.sourceName')}</Label>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('portTool.sshProfile')}</Label>
              <SSHProfileFormField
                value={draft.sshProfileID ?? ''}
                onSelect={(profile) =>
                  setDraft({
                    ...draft,
                    sshProfileID: profile?.id ?? '',
                    name: draft.name.trim() || profile?.name || draft.name,
                  })
                }
                placeholder={t('portTool.selectSSHProfile')}
              />
            </div>
          </>
        )}
        strings={{
          title: t('portTool.manageSourcesTitle'),
          edit: t('portTool.editSource'),
          remove: t('portTool.removeSource'),
          dragItem: (name) => t('sidebar.dragTool', { name }),
          empty: t('portTool.sourceHostsEmpty'),
          emptyHint: t('portTool.sourceHostsEmptyHint'),
          save: t('common.save'),
          back: t('common.cancel'),
          discardTitle: t('portTool.discardSourcesTitle'),
          discardDescription: t('portTool.discardSourcesDescription'),
          discardConfirm: t('portTool.discardSourcesConfirm'),
          removeTitle: t('portTool.removeSourceConfirmTitle'),
          removeDescription: (name) => t('portTool.removeSourceConfirmBody', { name }),
          formTitle: (editing) => (editing ? t('portTool.editSource') : t('portTool.addSource')),
        }}
      />
    </ToolLayout>
  );
}
