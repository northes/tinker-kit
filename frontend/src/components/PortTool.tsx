import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CaretUpDown,
  Copy,
  GearSix,
  MagnifyingGlass,
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
  GetForwards,
  GetPortSources,
  ListPorts,
  SavePortSources,
  StartForward,
  StopForward,
  UpdateForward,
} from '../../bindings/changeme/portservice';
import type {
  PortEntry,
  PortForward,
  PortForwardRequest,
  PortSource,
} from '../../bindings/changeme/models';
import { formatBackendError } from '../lib/backend-error';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { SSHProfileFormField } from './SSHProfileFormField';
import { ConfirmDialog } from './ConfirmDialog';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import {
  ToolActionBar,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutTabs,
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
  'parentPID',
  'parentPath',
] as const satisfies readonly (keyof PortEntry)[];
const PORT_COLUMN_WIDTHS: Record<(typeof PORT_COLUMNS)[number], string> = {
  port: 'w-[72px]',
  address: 'w-[180px]',
  protocol: 'w-[72px]',
  pid: 'w-[72px]',
  name: 'w-[160px]',
  user: 'w-[120px]',
  path: 'w-[260px]',
  parentPID: 'w-[88px]',
  parentPath: 'w-[260px]',
};
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
const FORWARD_COLUMN_WIDTHS: Record<ForwardSortKey, string> = {
  forwardName: 'w-[170px]',
  direction: 'w-[150px]',
  source: 'w-[120px]',
  listen: 'w-[200px]',
  target: 'w-[200px]',
  status: 'w-[100px]',
  retries: 'w-[84px]',
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

function SortableHead({
  label,
  active,
  direction,
  onSort,
  className = '',
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <TableHead
      className={className}
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
    </TableHead>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <ToolHeaderField label={label} htmlFor={id} className="min-w-32">
      <Select items={options} value={value} onValueChange={(next) => onChange(next || 'all')}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </ToolHeaderField>
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
    <ToolHeaderField label={label} htmlFor={id} className="min-w-48 flex-1">
      <div className="relative min-w-0">
        <MagnifyingGlass
          size={14}
          weight="duotone"
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing)
              onSearch(event.currentTarget.value.trim());
          }}
          placeholder={placeholder}
          className="pr-8 pl-8"
        />
        {draft ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
            aria-label={t('portTool.clearSearch')}
            onClick={() => {
              onDraftChange('');
              onSearch('');
            }}
          >
            <XCircle weight="duotone" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </ToolHeaderField>
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
  const [forwardSort, setForwardSort] = useState<SortState<ForwardSortKey>>({
    key: 'listen',
    direction: 'asc',
  });
  const [loading, setLoading] = useState(false);
  const scanRevision = useRef(0);
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
    setLoading(true);
    setPorts([]);
    setError('');
    try {
      const result = await ListPorts(source);
      if (revision === scanRevision.current) setPorts(result ?? []);
    } catch (cause) {
      if (revision === scanRevision.current) setError(formatBackendError(cause));
    } finally {
      if (revision === scanRevision.current) setLoading(false);
    }
  }, [source]);
  const refreshForwards = useCallback(async () => {
    try {
      setForwards((await GetForwards()) ?? []);
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  }, []);
  useEffect(() => {
    if (active) void refreshPorts();
  }, [active, refreshPorts]);
  useEffect(() => {
    if (!active) return;
    void refreshForwards();
    const timer = window.setInterval(() => void refreshForwards(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refreshForwards]);

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
    label: item.id === 'local' ? t('portTool.localMachine') : item.name,
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
  // 点击端口行时按当前来源推断转发方向并预填端口：来源为远程时做本地转发，
  // 来源为本机时做远程转发（把本机端口暴露到 SSH 主机）。
  const openForwardForPort = (entry: PortEntry) => {
    openForwardForm({
      editingId: null,
      request: {
        ...initialForward,
        sourceID:
          selectedSource?.kind === 'ssh'
            ? selectedSource.id
            : (forwardSourceOptions[0]?.value ?? ''),
        direction: source === 'local' ? 'remote' : 'local',
        listenHost: '127.0.0.1',
        listenPort: entry.port,
        targetHost: '127.0.0.1',
        targetPort: entry.port,
      },
    });
  };
  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  );
  const sourceNames = useMemo(
    () => new Map(sources.map((item) => [item.id, item.name])),
    [sources],
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
  const changeForwardSort = (key: ForwardSortKey) =>
    setForwardSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
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
  const forwardVirtualizer = useVirtualizer({
    count: visibleForwardData.length,
    getScrollElement: () => forwardViewport,
    estimateSize: () => 40,
    overscan: 12,
  });
  const visibleForwards = forwardVirtualizer.getVirtualItems();
  const forwardPaddingTop = visibleForwards.length ? visibleForwards[0].start : 0;
  const forwardPaddingBottom = visibleForwards.length
    ? forwardVirtualizer.getTotalSize() - visibleForwards[visibleForwards.length - 1].end
    : 0;

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
              <FilterSelect
                id="port-protocol"
                label={t('portTool.protocol')}
                value={protocolFilter}
                onChange={setProtocolFilter}
                options={[
                  { value: 'all', label: t('portTool.allProtocols') },
                  { value: 'TCP', label: 'TCP' },
                  { value: 'UDP', label: 'UDP' },
                ]}
              />
              <FilterSelect
                id="port-user"
                label={t('portTool.user')}
                value={userFilter}
                onChange={setUserFilter}
                options={[
                  { value: 'all', label: t('portTool.allUsers') },
                  ...users.map((user) => ({
                    value: `user:${user}`,
                    label: user || t('portTool.unknownUser'),
                  })),
                ]}
              />
              <Button
                variant="outline"
                className="ml-auto"
                disabled={loading}
                onClick={() => void refreshPorts()}
              >
                <ArrowsClockwise weight="duotone" />
                {t('portTool.refresh')}
              </Button>
            </div>
            <ScrollArea
              className="min-h-0 flex-1"
              options={{ overflow: { x: 'scroll' } }}
              onViewport={setPortViewport}
            >
              <Table className="min-w-[1284px] table-fixed" containerClassName="overflow-x-visible">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    {PORT_COLUMNS.map((key) => (
                      <SortableHead
                        key={key}
                        className={PORT_COLUMN_WIDTHS[key]}
                        label={t(`portTool.${key}`)}
                        active={portSort.key === key}
                        direction={portSort.direction}
                        onSort={() => changePortSort(key)}
                      />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paddingTop > 0 && (
                    <tr>
                      <td colSpan={9} style={{ height: paddingTop, padding: 0 }} />
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
                        <TableCell>
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto px-0"
                            onClick={() => openForwardForPort(entry)}
                          >
                            {entry.port}
                          </Button>
                        </TableCell>
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
                        <TableCell>{entry.parentPID || '—'}</TableCell>
                        <TableCell>
                          <WheelText>{entry.parentPath || '—'}</WheelText>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {paddingBottom > 0 && (
                    <tr>
                      <td colSpan={9} style={{ height: paddingBottom, padding: 0 }} />
                    </tr>
                  )}
                </TableBody>
              </Table>
              {loading && (
                <p className="py-8 text-center text-muted-foreground">{t('portTool.loading')}</p>
              )}
              {!loading && visiblePortData.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">
                  {t(ports.length ? 'portTool.noMatches' : 'portTool.emptyPorts')}
                </p>
              )}
            </ScrollArea>
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
              <FilterSelect
                id="forward-direction-filter"
                label={t('portTool.direction')}
                value={directionFilter}
                onChange={setDirectionFilter}
                options={[
                  { value: 'all', label: t('portTool.allDirections') },
                  { value: 'local', label: t('portTool.localForward') },
                  { value: 'remote', label: t('portTool.remoteForward') },
                ]}
              />
              <FilterSelect
                id="forward-status-filter"
                label={t('portTool.status')}
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'all', label: t('portTool.allStatuses') },
                  ...(['connecting', 'connected', 'reconnecting', 'failed'] as const).map(
                    (status) => ({ value: status, label: t(`portTool.${status}`) }),
                  ),
                ]}
              />
              <FilterSelect
                id="forward-source-filter"
                label={t('portTool.source')}
                value={sourceFilter}
                onChange={setSourceFilter}
                options={[
                  { value: 'all', label: t('portTool.allSources') },
                  ...forwardSourceIDs.map((id) => ({
                    value: id,
                    label: sourceNames.get(id) ?? t('portTool.missingSource'),
                  })),
                ]}
              />
            </div>
            <ScrollArea
              className="min-h-0 flex-1"
              options={{ overflow: { x: 'scroll' } }}
              onViewport={setForwardViewport}
            >
              <Table className="min-w-[1014px] table-fixed" containerClassName="overflow-x-visible">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    {FORWARD_COLUMNS.map((key) => (
                      <SortableHead
                        key={key}
                        className={FORWARD_COLUMN_WIDTHS[key]}
                        label={t(`portTool.${key}`)}
                        active={forwardSort.key === key}
                        direction={forwardSort.direction}
                        onSort={() => changeForwardSort(key)}
                      />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forwardPaddingTop > 0 && (
                    <tr>
                      <td colSpan={7} style={{ height: forwardPaddingTop, padding: 0 }} />
                    </tr>
                  )}
                  {visibleForwards.map((row) => {
                    const forward = visibleForwardData[row.index];
                    const running = isForwardRunning(forward);
                    return (
                      <ContextMenu key={row.key}>
                        <ContextMenuTrigger
                          render={
                            <TableRow
                              ref={forwardVirtualizer.measureElement}
                              data-index={row.index}
                              className={running ? undefined : 'text-muted-foreground'}
                            />
                          }
                        >
                          <TableCell>
                            <WheelText>{forwardLabel(forward)}</WheelText>
                          </TableCell>
                          <TableCell>{t(`portTool.${forward.direction}Forward`)}</TableCell>
                          <TableCell>
                            <WheelText>
                              {sourceNames.get(forward.sourceID) ?? t('portTool.missingSource')}
                            </WheelText>
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
                          <ContextMenuItem
                            disabled={busyForward !== ''}
                            onClick={() =>
                              running ? void stopForward(forward) : void startForward(forward)
                            }
                          >
                            {running ? <Stop weight="duotone" /> : <Play weight="duotone" />}
                            {t(running ? 'portTool.stop' : 'portTool.start')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              openForwardForm({
                                editingId: forward.id,
                                request: forwardRequest(forward),
                              })
                            }
                          >
                            <PencilSimple weight="duotone" />
                            {t('portTool.editForward')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              openForwardForm({
                                editingId: null,
                                request: forwardRequest(forward),
                              })
                            }
                          >
                            <Copy weight="duotone" />
                            {t('portTool.copyForward')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            onClick={() => {
                              setDeleteError('');
                              setDeleteTarget(forward);
                            }}
                          >
                            <Trash weight="duotone" />
                            {t('portTool.delete')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                  {forwardPaddingBottom > 0 && (
                    <tr>
                      <td colSpan={7} style={{ height: forwardPaddingBottom, padding: 0 }} />
                    </tr>
                  )}
                </TableBody>
              </Table>
              {visibleForwardData.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">
                  {t(forwards.length ? 'portTool.noMatches' : 'portTool.emptyForwards')}
                </p>
              )}
            </ScrollArea>
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
        itemName={(item) =>
          item.id === 'local' || item.kind === 'local' ? t('portTool.localMachine') : item.name
        }
        itemDisabled={(item) => item.id === 'local' || item.kind === 'local'}
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
          item.id === 'local' || item.kind === 'local' ? (
            <span>{t('portTool.localMachine')}</span>
          ) : (
            <>
              <span>{t('portTool.sourceKindSsh')}</span>
              {!profiles.some((profile) => profile.id === item.sshProfileID) ? (
                <Badge variant="destructive" className="h-4 text-[9px]">
                  {t('portTool.sshProfileMissing')}
                </Badge>
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
