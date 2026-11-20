import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowsClockwise, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  GetColumnWidths,
  GetPortSources,
  ListPorts,
  SaveColumnWidths,
  SavePortSources,
} from '../../bindings/tinkerkit/portservice';
import type { PortColumnWidths, PortEntry, PortSource } from '../../bindings/tinkerkit/models';
import { useWorkspaceTabTitle } from '../app/workspace-tab-title';
import { formatBackendError } from '../lib/backend-error';
import { isLocalSource, sourceLabel } from '../lib/local-source';
import { createLastSourceMemory } from '../lib/last-source';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { SSHProfileFormField } from './SSHProfileFormField';
import { SourceCombobox } from './SourceCombobox';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import {
  ToolCanceledState,
  ToolEmptyState,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLoadingState,
  toolHeaderControlClassName,
  WheelText,
} from './shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import { Table, TableBody, TableCell, TableHeader, TableRow } from './ui/table';
import {
  FilterMenu,
  PortListFrame,
  SearchField,
  SortableHead,
  clampColumnWidth,
  resolveColumnWidths,
  type SortDirection,
} from './port-list-chrome';

// 本次运行内最近一次选中的来源：新建的端口占用标签沿用同一个来源。
// 只活在内存里，不写 localStorage，也不跨重启恢复。
const portsSourceMemory = createLastSourceMemory();

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
type PortSortKey = (typeof PORT_COLUMNS)[number];
type SortState = { key: PortSortKey; direction: SortDirection };

// 当天只显示时刻；跨日为 MM-DD HH:mm；跨年再带年份。时刻按界面语言、24 小时制格式化。
function formatPortScannedAt(timestamp: number, locale: string) {
  const date = new Date(timestamp);
  const now = new Date();
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return time;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const datePart = sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
  return `${datePart} ${time}`;
}

// 标签只收主机下拉的显示名。本机、或 SSH 配置已不在列表里时不加前缀。
function portUsageTabHostName(
  source: PortSource | undefined,
  profiles: readonly { id: string }[],
  localLabel: string,
) {
  if (!source || isLocalSource(source)) return null;
  if (source.kind === 'ssh' && !profiles.some((profile) => profile.id === source.sshProfileID)) {
    return null;
  }
  return sourceLabel(source, localLabel).trim() || null;
}

export default function PortTool({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const sourceLabelId = useId();
  const { profiles } = useSSHProfiles();
  const [sources, setSources] = useState<PortSource[]>([]);
  const [source, setSource] = useState('local');
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [portViewport, setPortViewport] = useState<HTMLElement | null>(null);
  const [portSearchDraft, setPortSearchDraft] = useState('');
  const [portSearch, setPortSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState('all');
  const [userFilter, setUserFilter] = useState('all');
  const [portSort, setPortSort] = useState<SortState>({
    key: 'port',
    direction: 'asc',
  });
  // 列宽按主机保存。这里只持有占用表，保存时不提交转发列宽。
  const [portsColumnWidths, setPortsColumnWidths] = useState<
    NonNullable<PortColumnWidths['ports']>
  >({});
  const [loading, setLoading] = useState(false);
  const [portsCanceled, setPortsCanceled] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const scanRevision = useRef(0);
  const portsRequest = useRef<ReturnType<typeof ListPorts> | null>(null);
  // 空列表也是一次成功扫描，不能用条数判断有没有可用结果。
  const portsHaveResult = useRef(false);
  // null 表示还没有为当前这个主机启动过扫描。
  const scannedSource = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const [savingSources, setSavingSources] = useState(false);
  const sourcesLoadedRef = useRef(false);

  const refreshSources = useCallback(async () => {
    try {
      const next = (await GetPortSources()) ?? [];
      setSources(next);
      const initialLoad = !sourcesLoadedRef.current;
      sourcesLoadedRef.current = true;
      // 首次加载先看本工具上次选中的来源（仍在列表里才行），否则来源列表首项；
      // 之后当前来源仍存在时保持不变，来源被移除后回退到首项。
      const fallback = next[0]?.id ?? 'local';
      const ids = next.map((item) => item.id);
      setSource((current) =>
        initialLoad
          ? portsSourceMemory.resolve(ids, fallback)
          : ids.includes(current)
            ? current
            : fallback,
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
    // 保留上次结果，避免手动刷新时先清空再 loading 造成空表闪烁。换主机的清空在触发 effect 里做。
    setError('');
    const request = ListPorts(source);
    portsRequest.current = request;
    try {
      const result = await request;
      if (revision !== scanRevision.current) return;
      setPorts(result ?? []);
      portsHaveResult.current = true;
      setLastScannedAt(Date.now());
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
    // 已有结果时取消只是停掉这次刷新，表格仍留着上次结果，不能切到「已取消」空态。
    setPortsCanceled(!portsHaveResult.current);
    setError('');
  };
  // 切走不取消进行中的扫描。换主机清掉旧结果并重扫；同一主机只在还没有可用结果、且没有在途请求时补扫。
  useEffect(() => {
    if (scannedSource.current !== source) {
      scannedSource.current = source;
      portsHaveResult.current = false;
      setPorts([]);
      setLastScannedAt(null);
      void refreshPorts();
      return;
    }
    if (!active) return;
    if (portsHaveResult.current || portsRequest.current) return;
    void refreshPorts();
  }, [active, source, refreshPorts]);
  // 关闭标签卸载时才取消。同步抬高代次，避免取消后的错误或结果写回。
  useEffect(() => {
    return () => {
      const request = portsRequest.current;
      portsRequest.current = null;
      scanRevision.current++;
      void request?.cancel();
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const stored = await GetColumnWidths();
        if (canceled || !stored) return;
        setPortsColumnWidths(stored.ports ?? {});
      } catch (cause) {
        if (!canceled) setError(formatBackendError(cause));
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  const selectedSource = sources.find((item) => item.id === source);
  useWorkspaceTabTitle(portUsageTabHostName(selectedSource, profiles, t('portTool.localMachine')));
  const sourceOptions = sources.map((item) => ({
    value: item.id,
    label: sourceLabel(item, t('portTool.localMachine')),
  }));

  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
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
  const changePortSort = (key: PortSortKey) =>
    setPortSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  const columnWidths = useMemo(
    () => resolveColumnWidths(PORT_COLUMNS, PORT_COLUMN_WIDTHS, portsColumnWidths?.[source]),
    [portsColumnWidths, source],
  );
  const portTableMinWidth = columnWidths.reduce((total, width) => total + width, 0);
  const columnWidthsRef = useRef(portsColumnWidths);
  useEffect(() => {
    columnWidthsRef.current = portsColumnWidths;
  }, [portsColumnWidths]);
  const saveColumnWidths = async () => {
    try {
      // 空的 forwards 不会覆盖转发页已经保存的列宽。
      await SaveColumnWidths({ ports: columnWidthsRef.current, forwards: [] });
    } catch (cause) {
      setError(formatBackendError(cause));
    }
  };
  // 拖动只改本地宽度，松手或键盘抬起时一次性写回配置，避免每次移动都落库。
  const resizePortColumn = (index: number, width: number) => {
    setPortsColumnWidths((current) => {
      const next = resolveColumnWidths(PORT_COLUMNS, PORT_COLUMN_WIDTHS, current?.[source]);
      next[index] = clampColumnWidth(width);
      return { ...(current ?? {}), [source]: next };
    });
  };
  useEffect(() => {
    portViewport?.scrollTo({ top: 0 });
  }, [portViewport, portSearch, protocolFilter, userFilter, portSort]);
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

  // 已提交搜索或任一筛选离开默认值时显示「找到 N 项」；否则只显示可见条数。
  const portQueryActive =
    portSearch.trim() !== '' || protocolFilter !== 'all' || userFilter !== 'all';

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
        <PortListFrame>
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <ToolHeaderField
              label={t('portTool.source')}
              labelId={sourceLabelId}
              className="max-[700px]:w-full"
            >
              <SourceCombobox
                id="port-source"
                label={t('portTool.source')}
                labelId={sourceLabelId}
                className={toolHeaderControlClassName}
                items={sourceOptions}
                value={source}
                onValueChange={(value) => {
                  setSource(value || 'local');
                  portsSourceMemory.remember(value);
                  setUserFilter('all');
                }}
                manage={{ label: t('portTool.manageSources'), onClick: openSourceManager }}
              />
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
              <Button variant="secondary" className="ml-auto" onClick={cancelPorts}>
                <X data-icon="inline-start" weight="regular" />
                {t('common.cancel')}
              </Button>
            ) : (
              <Button variant="secondary" className="ml-auto" onClick={() => void refreshPorts()}>
                <ArrowsClockwise data-icon="inline-start" weight="regular" />
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
              edgeOverlay
              edgeOverlayTopClass="top-10"
              options={{ overflow: { x: 'scroll' } }}
              onViewport={setPortViewport}
            >
              <Table
                className="table-fixed"
                style={{ minWidth: portTableMinWidth }}
                containerClassName="overflow-x-visible"
              >
                <TableHeader className="sticky top-0 z-10 bg-background [&_tr]:border-b-0">
                  <TableRow className="hover:bg-transparent [&>th]:bg-[color-mix(in_oklch,var(--muted)_45%,var(--background))] [&>th]:text-muted-foreground [&>th:first-child]:rounded-l-md [&>th:last-child]:rounded-r-md">
                    {PORT_COLUMNS.map((key, index) => (
                      <SortableHead
                        key={key}
                        label={t(`portTool.${key}`)}
                        active={portSort.key === key}
                        direction={portSort.direction}
                        onSort={() => changePortSort(key)}
                        width={columnWidths[index]}
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
                        className={`border-b-0 hover:bg-transparent [&>td]:transition-colors hover:[&>td]:bg-muted/50 hover:[&>td:first-child]:rounded-l-md hover:[&>td:last-child]:rounded-r-md ${row.index % 2 === 1 ? '[&>td]:bg-muted/30 [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md' : ''}`}
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
              {portQueryActive
                ? t('common.foundCount', { total: visiblePortData.length })
                : ports.length
                  ? t('common.itemCount', { total: visiblePortData.length })
                  : ''}
            </span>
            {lastScannedAt != null ? (
              <span>
                {t('portTool.lastScannedAt', {
                  time: formatPortScannedAt(lastScannedAt, i18n.language),
                })}
              </span>
            ) : null}
          </div>
        </div>
      </ToolLayoutFooter>
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
