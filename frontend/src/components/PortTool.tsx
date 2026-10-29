import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CaretUpDown,
  Copy,
  DotsSixVertical,
  Funnel,
  GearSix,
  PencilSimple,
  Play,
  Plus,
  Stop,
  Trash,
  XCircle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  AddForward,
  DeleteForward,
  GetColumnWidths,
  GetForwards,
  GetPortSources,
  ListPorts,
  ReorderForwards,
  SaveColumnWidths,
  SavePortSources,
  StartForward,
  StopForward,
  UpdateForward,
} from '../../bindings/tinkerkit/portservice';
import type {
  PortColumnWidths,
  PortEntry,
  PortForward,
  PortForwardRequest,
  PortSource,
} from '../../bindings/tinkerkit/models';
import { formatBackendError } from '../lib/backend-error';
import { isLocalSource, sourceLabel } from '../lib/local-source';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { SSHProfileFormField } from './SSHProfileFormField';
import { ConfirmDialog } from './ConfirmDialog';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import {
  ToolActionBar,
  ToolCanceledState,
  ToolEmptyState,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutTabs,
  ToolLoadingState,
  ToolSearchField,
  WheelText,
} from './shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
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
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { TabsContent } from './ui/tabs';
import { toast } from './ui/toast';

const initialForward: PortForwardRequest = {
  name: '',
  sourceID: '',
  direction: 'local',
  listenHost: '127.0.0.1',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80,
};

const MANAGE_SOURCES_VALUE = '__manage-port-sources__';

const PORT_COLUMNS = [
  'port',
  'address',
  'protocol',
  'pid',
  'name',
  'user',
  'path',
  'commandLine',
  'parentPID',
  'parentPath',
] as const satisfies readonly (keyof PortEntry)[];
const PORT_COLUMN_WIDTHS: Record<(typeof PORT_COLUMNS)[number], number> = {
  port: 72,
  address: 180,
  protocol: 72,
  pid: 72,
  name: 160,
  user: 120,
  path: 260,
  commandLine: 320,
  parentPID: 88,
  parentPath: 260,
};
const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 800;
// 拖动列宽的把手宽度，固定不参与列宽持久化。
const FORWARD_HANDLE_COLUMN_WIDTH = 40;

const clampColumnWidth = (width: number) =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));

// 后端只保存宽度数组；列含义由前端列定义决定，越界或缺失时回退默认宽度。
function resolveColumnWidths<Key extends string>(
  columns: readonly Key[],
  defaults: Record<Key, number>,
  stored?: number[] | null,
) {
  return columns.map((column, index) => clampColumnWidth(stored?.[index] ?? defaults[column]));
}
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
type PortSortKey = (typeof PORT_COLUMNS)[number];
type SortDirection = 'asc' | 'desc';
type SortState<Key extends string> = { key: Key; direction: SortDirection };

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

// 表头同时承载列排序与列宽拖动：右侧把手用指针捕获拖动，也支持左右方向键微调，
// 松手或按键抬起时由父组件把列宽写回配置。
function SortableHead({
  label,
  active,
  direction,
  onSort,
  width,
  onResize,
  onResizeEnd,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
}) {
  const { t } = useTranslation();
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  return (
    <TableHead
      className="relative"
      style={{ width }}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 px-2 text-xs font-medium"
        aria-label={t('portTool.sortBy', {
          column: label,
          direction: active
            ? t(direction === 'asc' ? 'portTool.sortAscending' : 'portTool.sortDescending')
            : t('portTool.sortNotActive'),
        })}
        onClick={onSort}
      >
        {label}
        {active ? (
          direction === 'asc' ? (
            <CaretUp aria-hidden="true" />
          ) : (
            <CaretDown aria-hidden="true" />
          )
        ) : (
          <CaretUpDown aria-hidden="true" />
        )}
      </Button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={t('portTool.resizeColumn', { column: label })}
        aria-valuenow={width}
        aria-valuemin={MIN_COLUMN_WIDTH}
        aria-valuemax={MAX_COLUMN_WIDTH}
        aria-keyshortcuts="ArrowLeft ArrowRight"
        tabIndex={0}
        className="absolute inset-y-1 right-0 z-10 w-2 cursor-col-resize touch-none select-none rounded-full bg-transparent hover:bg-border focus-visible:bg-primary focus-visible:outline-none active:bg-primary"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          const start = dragStart.current;
          if (!start) return;
          onResize(clampColumnWidth(start.width + event.clientX - start.x));
        }}
        onPointerUp={(event) => {
          if (!dragStart.current) return;
          dragStart.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          onResizeEnd();
        }}
        onPointerCancel={() => {
          dragStart.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          onResize(clampColumnWidth(width + (event.key === 'ArrowRight' ? 16 : -16)));
        }}
        onKeyUp={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') onResizeEnd();
        }}
      />
    </TableHead>
  );
}

// 转发行同时是 dnd-kit 的可排序项：首列是拖动手柄，键盘可用上下键调整顺序。
// 列排序是临时视图，定义顺序不可见，因此只有默认顺序下才提供拖动手柄。
function ForwardRow({
  forward,
  sourceName,
  sortable,
  busy,
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
            className={`${running ? '' : 'text-muted-foreground'} ${isDragging ? 'bg-accent' : ''}`}
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
              <DotsSixVertical weight="duotone" />
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
          <WheelText>{`${forward.listenHost}:${forward.listenPort}`}</WheelText>
        </TableCell>
        <TableCell>
          <WheelText>{`${forward.targetHost}:${forward.targetPort}`}</WheelText>
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
          {running ? <Stop weight="duotone" /> : <Play weight="duotone" />}
          {t(running ? 'portTool.stop' : 'portTool.start')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onEdit}>
          <PencilSimple weight="duotone" />
          {t('portTool.editForward')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCopy}>
          <Copy weight="duotone" />
          {t('portTool.copyForward')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash weight="duotone" />
          {t('portTool.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type FilterGroup = {
  key: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
};

// 次要筛选集中到一个下拉菜单，头部只保留来源、搜索、刷新等高频控件。
function FilterMenu({ label, groups }: { label: string; groups: FilterGroup[] }) {
  const { t } = useTranslation();
  // 每个分组的第一项是默认值（全部），其余取值计为已启用筛选。
  const activeCount = groups.filter(
    (group) => group.value !== (group.options[0]?.value ?? ''),
  ).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="flex-none"
            aria-label={activeCount ? t('portTool.filtersActive', { total: activeCount }) : label}
          />
        }
      >
        <Funnel data-icon="inline-start" weight="duotone" />
        {label}
        {activeCount ? <Badge variant="secondary">{activeCount}</Badge> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {groups.map((group, index) => (
          <Fragment key={group.key}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={group.value} onValueChange={group.onChange}>
                {group.options.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchField({
  id,
  label,
  placeholder,
  draft,
  onDraftChange,
  onSearch,
}: {
  id: string;
  label: string;
  placeholder: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSearch: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ToolSearchField
      id={id}
      label={label}
      placeholder={placeholder}
      value={draft}
      onValueChange={onDraftChange}
      onSubmit={onSearch}
      onClear={() => {
        onDraftChange('');
        onSearch('');
      }}
      clearLabel={t('portTool.clearSearch')}
      className="w-[220px] max-[700px]:w-full"
    />
  );
}

export default function PortTool({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const sourceLabelId = useId();
  const { profiles } = useSSHProfiles();
  const [sources, setSources] = useState<PortSource[]>([]);
  const [source, setSource] = useState('local');
  const [tab, setTab] = useState('ports');
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [portViewport, setPortViewport] = useState<HTMLElement | null>(null);
  const [forwardViewport, setForwardViewport] = useState<HTMLElement | null>(null);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [portSearchDraft, setPortSearchDraft] = useState('');
  const [portSearch, setPortSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState('all');
  const [userFilter, setUserFilter] = useState('all');
  const [portSort, setPortSort] = useState<SortState<PortSortKey>>({
    key: 'port',
    direction: 'asc',
  });
  const [forwardSearchDraft, setForwardSearchDraft] = useState('');
  const [forwardSearch, setForwardSearch] = useState('');
  const [directionFilter, setDirectionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  // 转发列表默认按持久化的定义顺序展示，新增的规则追加在末尾；列排序是临时视图。
  const [forwardSort, setForwardSort] = useState<SortState<ForwardSortKey> | null>(null);
  const [forwardLiveMessage, setForwardLiveMessage] = useState('');
  // 列宽按主机保存：端口表跟随当前来源，转发表不分主机。
  const [columnWidths, setColumnWidths] = useState<PortColumnWidths>({ ports: {}, forwards: [] });
  const [loading, setLoading] = useState(false);
  const [portsCanceled, setPortsCanceled] = useState(false);
  const scanRevision = useRef(0);
  const portsRequest = useRef<ReturnType<typeof ListPorts> | null>(null);
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
  const sourcesLoadedRef = useRef(false);

  const refreshSources = useCallback(async () => {
    try {
      const next = (await GetPortSources()) ?? [];
      setSources(next);
      const initialLoad = !sourcesLoadedRef.current;
      sourcesLoadedRef.current = true;
      // 默认加载来源列表首项；当前来源仍存在时保持不变，来源被移除后回退到首项。
      const fallback = next[0]?.id ?? 'local';
      setSource((current) =>
        initialLoad ? fallback : next.some((item) => item.id === current) ? current : fallback,
      );
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

  const refreshPorts = useCallback(async () => {
    const revision = ++scanRevision.current;
    portsRequest.current?.cancel();
    setPortsCanceled(false);
    setLoading(true);
    setPorts([]);
    setError('');
    const request = ListPorts(source);
    portsRequest.current = request;
    try {
      const result = await request;
      if (revision === scanRevision.current) setPorts(result ?? []);
    } catch (cause) {
      if (revision === scanRevision.current) setError(formatBackendError(cause));
    } finally {
      if (portsRequest.current === request) portsRequest.current = null;
      if (revision === scanRevision.current) setLoading(false);
    }
  }, [source]);
  const cancelPorts = () => {
    const request = portsRequest.current;
    if (!request) return;
    portsRequest.current = null;
    scanRevision.current++;
    void request.cancel();
    setLoading(false);
    setPortsCanceled(true);
    setError('');
  };
  const refreshForwards = useCallback(async () => {
    try {
      setForwards((await GetForwards()) ?? []);
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  }, []);
  useEffect(() => {
    if (!active) {
      scanRevision.current++;
      const request = portsRequest.current;
      portsRequest.current = null;
      void request?.cancel();
      return;
    }
    void refreshPorts();
  }, [active, refreshPorts]);
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
        setColumnWidths({ ports: stored.ports ?? {}, forwards: stored.forwards ?? [] });
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
    if (saving) return;
    setSaving(true);
    setFormError('');
    try {
      const saved = editingId ? await UpdateForward(editingId, form) : await AddForward(form);
      setDialog(false);
      setEditingId(null);
      setTab('forwards');
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
  const selectedSource = sources.find((item) => item.id === source);
  const sourceOptions = sources.map((item) => ({
    value: item.id,
    label: sourceLabel(item, t('portTool.localMachine')),
  }));
  const forwardSourceOptions = sources
    .filter((item) => item.kind === 'ssh')
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
    sourceID:
      selectedSource?.kind === 'ssh' ? selectedSource.id : (forwardSourceOptions[0]?.value ?? ''),
  });

  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  );
  const sourceNames = useMemo(
    () => new Map(sources.map((item) => [item.id, sourceLabel(item, t('portTool.localMachine'))])),
    [sources, t],
  );
  const users = useMemo(
    () =>
      Array.from(
        new Set([
          ...ports.map((port) => port.user),
          ...(userFilter === 'all' ? [] : [userFilter.slice(5)]),
        ]),
      ).sort(collator.compare),
    [ports, userFilter, collator],
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
  const visiblePortData = useMemo(() => {
    const query = portSearch.toLocaleLowerCase(i18n.language);
    const result = ports.filter(
      (entry) =>
        (protocolFilter === 'all' || entry.protocol === protocolFilter) &&
        (userFilter === 'all' || entry.user === userFilter.slice(5)) &&
        (!query ||
          Object.values(entry).some((value) =>
            String(value).toLocaleLowerCase(i18n.language).includes(query),
          )),
    );
    const { key, direction } = portSort;
    result.sort((a, b) => {
      const left = a[key];
      const right = b[key];
      const compared =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right));
      return (direction === 'asc' ? compared : -compared) || a.port - b.port || a.pid - b.pid;
    });
    return result;
  }, [ports, portSearch, protocolFilter, userFilter, portSort, collator, i18n.language]);
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
  const changePortSort = (key: PortSortKey) =>
    setPortSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  const portColumnWidths = useMemo(
    () => resolveColumnWidths(PORT_COLUMNS, PORT_COLUMN_WIDTHS, columnWidths.ports?.[source]),
    [columnWidths, source],
  );
  const forwardColumnWidths = useMemo(
    () => resolveColumnWidths(FORWARD_COLUMNS, FORWARD_COLUMN_WIDTHS, columnWidths.forwards),
    [columnWidths],
  );
  const portTableMinWidth = portColumnWidths.reduce((total, width) => total + width, 0);
  const forwardTableMinWidth =
    FORWARD_HANDLE_COLUMN_WIDTH + forwardColumnWidths.reduce((total, width) => total + width, 0);
  const columnWidthsRef = useRef(columnWidths);
  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);
  const saveColumnWidths = async () => {
    try {
      await SaveColumnWidths(columnWidthsRef.current);
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  };
  // 拖动只改本地宽度，松手或键盘抬起时一次性写回配置，避免每次移动都落库。
  const resizePortColumn = (index: number, width: number) => {
    setColumnWidths((current) => {
      const next = resolveColumnWidths(PORT_COLUMNS, PORT_COLUMN_WIDTHS, current.ports?.[source]);
      next[index] = clampColumnWidth(width);
      return { ...current, ports: { ...(current.ports ?? {}), [source]: next } };
    });
  };
  const resizeForwardColumn = (index: number, width: number) => {
    setColumnWidths((current) => {
      const next = resolveColumnWidths(FORWARD_COLUMNS, FORWARD_COLUMN_WIDTHS, current.forwards);
      next[index] = clampColumnWidth(width);
      return { ...current, forwards: next };
    });
  };
  const changeForwardSort = (key: ForwardSortKey) =>
    setForwardSort((current) => ({
      key,
      direction: current?.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  useEffect(() => {
    portViewport?.scrollTo({ top: 0 });
  }, [portViewport, portSearch, protocolFilter, userFilter, portSort]);
  useEffect(() => {
    forwardViewport?.scrollTo({ top: 0 });
  }, [forwardViewport, forwardSearch, directionFilter, statusFilter, sourceFilter, forwardSort]);
  const portVirtualizer = useVirtualizer({
    count: visiblePortData.length,
    getScrollElement: () => portViewport,
    estimateSize: () => 40,
    overscan: 12,
  });
  const visiblePorts = portVirtualizer.getVirtualItems();
  const paddingTop = visiblePorts.length ? visiblePorts[0].start : 0;
  const paddingBottom = visiblePorts.length
    ? portVirtualizer.getTotalSize() - visiblePorts[visiblePorts.length - 1].end
    : 0;
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

  const openSourceManager = () => setManageOpen(true);
  const saveSources = async (next: PortSource[]) => {
    if (savingSources) return;
    setSavingSources(true);
    try {
      await SavePortSources(next);
      await refreshSources();
    } finally {
      setSavingSources(false);
    }
  };

  return (
    <ToolLayout>
      <ToolLayoutContent>
        <ToolLayoutTabs
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'ports', label: t('portTool.ports') },
            { value: 'forwards', label: t('portTool.forwards') },
          ]}
        >
          <TabsContent value="ports" className="flex min-h-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <ToolHeaderField
                label={t('portTool.source')}
                labelId={sourceLabelId}
                className="max-[700px]:w-full"
              >
                <Select
                  items={sourceOptions}
                  value={source}
                  onValueChange={(value) => {
                    if (value === MANAGE_SOURCES_VALUE) {
                      openSourceManager();
                      return;
                    }
                    setSource(value || 'local');
                    setUserFilter('all');
                  }}
                >
                  <SelectTrigger
                    id="port-source"
                    aria-labelledby={sourceLabelId}
                    className="w-[220px] max-w-full max-[700px]:w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {sourceOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                      {sourceOptions.length > 0 ? <SelectSeparator /> : null}
                      <SelectItem value={MANAGE_SOURCES_VALUE}>
                        <span className="flex items-center gap-2">
                          <GearSix size={14} weight="duotone" />
                          {t('portTool.manageSources')}
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </ToolHeaderField>
              <SearchField
                id="port-search"
                label={t('portTool.search')}
                placeholder={t('portTool.searchPortsPlaceholder')}
                draft={portSearchDraft}
                onDraftChange={setPortSearchDraft}
                onSearch={setPortSearch}
              />
              <FilterMenu
                label={t('portTool.filters')}
                groups={[
                  {
                    key: 'protocol',
                    label: t('portTool.protocol'),
                    value: protocolFilter,
                    onChange: setProtocolFilter,
                    options: [
                      { value: 'all', label: t('portTool.allProtocols') },
                      { value: 'TCP', label: 'TCP' },
                      { value: 'UDP', label: 'UDP' },
                    ],
                  },
                  {
                    key: 'user',
                    label: t('portTool.user'),
                    value: userFilter,
                    onChange: setUserFilter,
                    options: [
                      { value: 'all', label: t('portTool.allUsers') },
                      ...users.map((user) => ({
                        value: `user:${user}`,
                        label: user || t('portTool.unknownUser'),
                      })),
                    ],
                  },
                ]}
              />
              {loading ? (
                <Button variant="outline" className="ml-auto" onClick={cancelPorts}>
                  <XCircle data-icon="inline-start" weight="duotone" />
                  {t('common.cancel')}
                </Button>
              ) : (
                <Button variant="outline" className="ml-auto" onClick={() => void refreshPorts()}>
                  <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                  {t('portTool.refresh')}
                </Button>
              )}
            </div>
            {visiblePortData.length === 0 ? (
              loading ? (
                <ToolLoadingState label={t('portTool.loading')} onCancel={cancelPorts} />
              ) : portsCanceled ? (
                <ToolCanceledState onRetry={() => void refreshPorts()} />
              ) : (
                <ToolEmptyState
                  title={t(ports.length ? 'portTool.noMatches' : 'portTool.emptyPorts')}
                />
              )
            ) : (
              <ScrollArea
                className="min-h-0 flex-1"
                options={{ overflow: { x: 'scroll' } }}
                onViewport={setPortViewport}
              >
                <Table
                  className="table-fixed"
                  style={{ minWidth: portTableMinWidth }}
                  containerClassName="overflow-x-visible"
                >
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      {PORT_COLUMNS.map((key, index) => (
                        <SortableHead
                          key={key}
                          label={t(`portTool.${key}`)}
                          active={portSort.key === key}
                          direction={portSort.direction}
                          onSort={() => changePortSort(key)}
                          width={portColumnWidths[index]}
                          onResize={(width) => resizePortColumn(index, width)}
                          onResizeEnd={() => void saveColumnWidths()}
                        />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paddingTop > 0 && (
                      <tr>
                        <td colSpan={10} style={{ height: paddingTop, padding: 0 }} />
                      </tr>
                    )}
                    {visiblePorts.map((row) => {
                      const entry = visiblePortData[row.index];
                      return (
                        <TableRow
                          key={row.key}
                          ref={portVirtualizer.measureElement}
                          data-index={row.index}
                        >
                          <TableCell>{entry.port}</TableCell>
                          <TableCell>
                            <WheelText>{entry.address}</WheelText>
                          </TableCell>
                          <TableCell>{entry.protocol}</TableCell>
                          <TableCell>{entry.pid}</TableCell>
                          <TableCell>
                            <WheelText>{entry.name}</WheelText>
                          </TableCell>
                          <TableCell>
                            <WheelText>{entry.user}</WheelText>
                          </TableCell>
                          <TableCell>
                            <WheelText>{entry.path || '—'}</WheelText>
                          </TableCell>
                          <TableCell>
                            <WheelText>{entry.commandLine || '—'}</WheelText>
                          </TableCell>
                          <TableCell>{entry.parentPID || '—'}</TableCell>
                          <TableCell>
                            <WheelText>{entry.parentPath || '—'}</WheelText>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {paddingBottom > 0 && (
                      <tr>
                        <td colSpan={10} style={{ height: paddingBottom, padding: 0 }} />
                      </tr>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </TabsContent>
          <TabsContent value="forwards" className="flex min-h-0 flex-col gap-2">
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
                        label: sourceNames.get(id) ?? t('portTool.missingSource'),
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
                  <ArrowCounterClockwise weight="duotone" data-icon="inline-start" size={14} />
                  {t('portTool.defaultOrder')}
                </Button>
              )}
            </div>
            <DndContext
              sensors={forwardSensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (!over || active.id === over.id) return;
                void reorderForward(String(active.id), String(over.id));
              }}
            >
              <SortableContext
                items={visibleForwardData.map((forward) => forward.id)}
                strategy={verticalListSortingStrategy}
              >
                <ScrollArea
                  className="min-h-0 flex-1"
                  options={{ overflow: { x: 'scroll' } }}
                  onViewport={setForwardViewport}
                >
                  <Table
                    className="table-fixed"
                    style={{ minWidth: forwardTableMinWidth }}
                    containerClassName="overflow-x-visible"
                  >
                    <TableHeader className="sticky top-0 z-10 bg-background">
                      <TableRow>
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
                            width={forwardColumnWidths[index]}
                            onResize={(width) => resizeForwardColumn(index, width)}
                            onResizeEnd={() => void saveColumnWidths()}
                          />
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleForwardData.map((forward) => (
                        <ForwardRow
                          key={forward.id}
                          forward={forward}
                          sourceName={
                            sourceNames.get(forward.sourceID) ?? t('portTool.missingSource')
                          }
                          sortable={forwardSort === null}
                          busy={busyForward !== ''}
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
          </TabsContent>
        </ToolLayoutTabs>
      </ToolLayoutContent>
      <ToolLayoutFooter>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <span className="pb-2 text-xs text-muted-foreground">
            {tab === 'ports'
              ? t('portTool.results', { matched: visiblePortData.length, total: ports.length })
              : t('portTool.results', {
                  matched: visibleForwardData.length,
                  total: forwards.length,
                })}
          </span>
          {tab === 'forwards' && (
            <ToolActionBar
              label={t('portTool.actions')}
              actions={[
                {
                  key: 'add',
                  label: t('portTool.add'),
                  icon: Plus,
                  variant: 'primary',
                  disabled: forwardSourceOptions.length === 0,
                  onPress: () => openForwardForm({ editingId: null, request: newForwardRequest() }),
                },
              ]}
            />
          )}
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
              <Select
                items={forwardSourceOptions}
                value={form.sourceID || null}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, sourceID: value || '' }))
                }
              >
                <SelectTrigger id="forward-source" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {forwardSourceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
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
            <p role="alert" className="text-sm text-destructive">
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
        activeKey={source}
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
            id: draft.id || `port:${crypto.randomUUID()}`,
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
