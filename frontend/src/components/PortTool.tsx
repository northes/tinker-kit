import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowsClockwise,
  ArrowsDownUp,
  CaretDown,
  CaretUp,
  Plus,
  Stop,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  GetForwards,
  ListPorts,
  StartForward,
  StopForward,
} from '../../bindings/changeme/portservice';
import type { PortEntry, PortForward, PortForwardRequest } from '../../bindings/changeme/models';
import { formatBackendError } from '../lib/backend-error';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { ConfirmDialog } from './ConfirmDialog';
import {
  ToolActionBar,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
} from './shared';
import { Button } from './ui/button';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const initialForward: PortForwardRequest = {
  profileID: '',
  direction: 'local',
  listenHost: '127.0.0.1',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80,
};

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
const FORWARD_COLUMNS = ['direction', 'source', 'listen', 'target', 'status', 'retries'] as const;
type PortSortKey = (typeof PORT_COLUMNS)[number];
type ForwardSortKey = (typeof FORWARD_COLUMNS)[number];
type SortDirection = 'asc' | 'desc';
type SortState<Key extends string> = { key: Key; direction: SortDirection };

function SortableHead({
  label,
  active,
  direction,
  onSort,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TableHead aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
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
            <CaretUp weight="duotone" aria-hidden="true" />
          ) : (
            <CaretDown weight="duotone" aria-hidden="true" />
          )
        ) : (
          <ArrowsDownUp weight="duotone" aria-hidden="true" />
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
    <div className="min-w-32">
      <Label htmlFor={id}>{label}</Label>
      <Select items={options} value={value} onValueChange={(next) => onChange(next || 'all')}>
        <SelectTrigger id={id} className="mt-1 w-full">
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
    </div>
  );
}

export default function PortTool({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const { profiles, openManager } = useSSHProfiles();
  const [source, setSource] = useState('local');
  const [tab, setTab] = useState('ports');
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [portViewport, setPortViewport] = useState<HTMLElement | null>(null);
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
  const [profileFilter, setProfileFilter] = useState('all');
  const [forwardSort, setForwardSort] = useState<SortState<ForwardSortKey>>({
    key: 'listen',
    direction: 'asc',
  });
  const [loading, setLoading] = useState(false);
  const scanRevision = useRef(0);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);
  const [form, setForm] = useState<PortForwardRequest>(initialForward);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [stop, setStop] = useState<PortForward | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');

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

  const startForward = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError('');
    try {
      await StartForward(form);
      setDialog(false);
      setTab('forwards');
      await refreshForwards();
    } catch (cause) {
      setFormError(formatBackendError(cause));
    } finally {
      setSaving(false);
    }
  };
  const stopForward = async () => {
    if (!stop || stopping) return;
    setStopping(true);
    setStopError('');
    try {
      await StopForward(stop.id);
      setStop(null);
      await refreshForwards();
    } catch (cause) {
      setStopError(formatBackendError(cause));
    } finally {
      setStopping(false);
    }
  };
  const selectedProfile = profiles.find((profile) => profile.id === source);
  const sourceOptions = [
    { value: 'local', label: t('portTool.local') },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];
  const profileOptions = profiles.map((profile) => ({ value: profile.id, label: profile.name }));
  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  );
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
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
  const profileIDs = useMemo(
    () =>
      Array.from(
        new Set([
          ...forwards.map((forward) => forward.profileID),
          ...(profileFilter === 'all' ? [] : [profileFilter]),
        ]),
      ).sort((a, b) => collator.compare(profileNames.get(a) ?? a, profileNames.get(b) ?? b)),
    [forwards, profileFilter, profileNames, collator],
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
        case 'source':
          return profileNames.get(forward.profileID) ?? t('sshProfiles.missingProfile');
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
    [profileNames, t],
  );
  const visibleForwardData = useMemo(() => {
    const query = forwardSearch.toLocaleLowerCase(i18n.language);
    const result = forwards.filter(
      (forward) =>
        (directionFilter === 'all' || forward.direction === directionFilter) &&
        (statusFilter === 'all' || forward.status === statusFilter) &&
        (profileFilter === 'all' || forward.profileID === profileFilter) &&
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
    profileFilter,
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

  return (
    <ToolLayout>
      <ToolLayoutHeader title={t('portTool.title')} subtitle={t('portTool.subtitle')} />
      <ToolLayoutToolbar
        left={
          <div className="flex min-w-0 items-end gap-2">
            <div className="min-w-48">
              <Label htmlFor="port-source">{t('portTool.source')}</Label>
              <Select
                items={sourceOptions}
                value={source}
                onValueChange={(value) => {
                  setSource(value || 'local');
                  setUserFilter('all');
                }}
              >
                <SelectTrigger id="port-source" className="mt-1 min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sourceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={openManager}>
              {t('portTool.manageSSH')}
            </Button>
          </div>
        }
        right={
          <Button
            variant="outline"
            disabled={loading || tab !== 'ports'}
            onClick={() => void refreshPorts()}
          >
            <ArrowsClockwise weight="duotone" />
            {t('portTool.refresh')}
          </Button>
        }
      />
      <ToolLayoutContent>
        <Tabs value={tab} onValueChange={(value) => setTab(value)} className="h-full min-h-0">
          <TabsList variant="line">
            <TabsTrigger value="ports">{t('portTool.ports')}</TabsTrigger>
            <TabsTrigger value="forwards">{t('portTool.forwards')}</TabsTrigger>
          </TabsList>
          <TabsContent value="ports" className="flex min-h-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <Label htmlFor="port-search">{t('portTool.search')}</Label>
                <Input
                  id="port-search"
                  type="search"
                  className="mt-1"
                  value={portSearchDraft}
                  onChange={(event) => setPortSearchDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                      setPortSearch(event.currentTarget.value.trim());
                  }}
                  placeholder={t('portTool.searchPortsPlaceholder')}
                />
              </div>
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
              <span className="pb-2 text-xs text-muted-foreground">
                {t('portTool.results', { matched: visiblePortData.length, total: ports.length })}
              </span>
            </div>
            <ScrollArea
              className="min-h-0 flex-1"
              options={{ overflow: { x: 'scroll' } }}
              onViewport={setPortViewport}
            >
              <Table className="min-w-[1050px]" containerClassName="overflow-x-visible">
                <TableHeader>
                  <TableRow>
                    {PORT_COLUMNS.map((key) => (
                      <SortableHead
                        key={key}
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
                      <td colSpan={9} style={{ height: paddingTop }} />
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
                        <TableCell className="max-w-48 truncate" title={entry.address}>
                          {entry.address}
                        </TableCell>
                        <TableCell>{entry.protocol}</TableCell>
                        <TableCell>{entry.pid}</TableCell>
                        <TableCell>{entry.name}</TableCell>
                        <TableCell>{entry.user}</TableCell>
                        <TableCell className="max-w-64 truncate" title={entry.path}>
                          {entry.path || '—'}
                        </TableCell>
                        <TableCell>{entry.parentPID || '—'}</TableCell>
                        <TableCell className="max-w-64 truncate" title={entry.parentPath}>
                          {entry.parentPath || '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {paddingBottom > 0 && (
                    <tr>
                      <td colSpan={9} style={{ height: paddingBottom }} />
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
              <div className="min-w-48 flex-1">
                <Label htmlFor="forward-search">{t('portTool.search')}</Label>
                <Input
                  id="forward-search"
                  type="search"
                  className="mt-1"
                  value={forwardSearchDraft}
                  onChange={(event) => setForwardSearchDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                      setForwardSearch(event.currentTarget.value.trim());
                  }}
                  placeholder={t('portTool.searchForwardsPlaceholder')}
                />
              </div>
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
                id="forward-profile-filter"
                label={t('portTool.source')}
                value={profileFilter}
                onChange={setProfileFilter}
                options={[
                  { value: 'all', label: t('portTool.allHosts') },
                  ...profileIDs.map((id) => ({
                    value: id,
                    label: profileNames.get(id) ?? t('sshProfiles.missingProfile'),
                  })),
                ]}
              />
              <span className="pb-2 text-xs text-muted-foreground">
                {t('portTool.results', {
                  matched: visibleForwardData.length,
                  total: forwards.length,
                })}
              </span>
            </div>
            <ScrollArea className="min-h-0 flex-1" options={{ overflow: { x: 'scroll' } }}>
              <Table className="min-w-[750px]" containerClassName="overflow-x-visible">
                <TableHeader>
                  <TableRow>
                    {FORWARD_COLUMNS.map((key) => (
                      <SortableHead
                        key={key}
                        label={t(`portTool.${key}`)}
                        active={forwardSort.key === key}
                        direction={forwardSort.direction}
                        onSort={() => changeForwardSort(key)}
                      />
                    ))}
                    <TableHead>{t('portTool.action')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleForwardData.map((forward) => (
                    <TableRow key={forward.id}>
                      <TableCell>{t(`portTool.${forward.direction}Forward`)}</TableCell>
                      <TableCell>
                        {profiles.find((profile) => profile.id === forward.profileID)?.name ??
                          t('sshProfiles.missingProfile')}
                      </TableCell>
                      <TableCell>
                        {forward.listenHost}:{forward.listenPort}
                      </TableCell>
                      <TableCell>
                        {forward.targetHost}:{forward.targetPort}
                      </TableCell>
                      <TableCell>
                        {t(`portTool.${forward.status}`)}
                        {forward.error && (
                          <p
                            className="max-w-64 truncate text-xs text-destructive"
                            title={forward.error}
                          >
                            {formatBackendError(forward.error)}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>{forward.retries}/5</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setStopError('');
                            setStop(forward);
                          }}
                        >
                          <Stop weight="duotone" />
                          {t('portTool.stop')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {visibleForwardData.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">
                  {t(forwards.length ? 'portTool.noMatches' : 'portTool.emptyForwards')}
                </p>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </ToolLayoutContent>
      <ToolLayoutFooter>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <ToolActionBar
          label={t('portTool.actions')}
          actions={[
            {
              key: 'add',
              label: t('portTool.add'),
              icon: Plus,
              variant: 'primary',
              disabled: profiles.length === 0,
              onPress: () => {
                setForm({
                  ...initialForward,
                  profileID: selectedProfile?.id ?? profiles[0]?.id ?? '',
                });
                setError('');
                setDialog(true);
              },
            },
          ]}
        />
      </ToolLayoutFooter>
      <Dialog
        open={dialog}
        onOpenChange={(open) => {
          if (!saving) setDialog(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('portTool.add')}</DialogTitle>
            <DialogDescription>{t('portTool.forwardHint')}</DialogDescription>
          </DialogHeader>
          <form
            id="port-forward-form"
            className="grid gap-3"
            onSubmit={(event) => void startForward(event)}
          >
            <div>
              <Label htmlFor="forward-profile">{t('portTool.source')}</Label>
              <Select
                items={profileOptions}
                value={form.profileID || null}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, profileID: value || '' }))
                }
              >
                <SelectTrigger id="forward-profile" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {profileOptions.map((profile) => (
                      <SelectItem key={profile.value} value={profile.value}>
                        {profile.label}
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
                <Label htmlFor="forward-listen-host">{t('portTool.listenHost')}</Label>
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
                <Label htmlFor="forward-listen-port">{t('portTool.listenPort')}</Label>
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
                <Label htmlFor="forward-target-host">{t('portTool.targetHost')}</Label>
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
                <Label htmlFor="forward-target-port">{t('portTool.targetPort')}</Label>
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
            <Button variant="outline" onClick={() => setDialog(false)}>
              {t('portTool.cancel')}
            </Button>
            <Button type="submit" form="port-forward-form" disabled={saving || !form.profileID}>
              {t('portTool.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={stop !== null}
        onOpenChange={(open) => {
          if (!open) setStop(null);
        }}
        title={t('portTool.stopConfirmTitle')}
        description={t('portTool.stopConfirmDescription', {
          listen: stop ? `${stop.listenHost}:${stop.listenPort}` : '',
        })}
        confirmLabel={t('portTool.stop')}
        busy={stopping}
        error={stopError}
        onConfirm={() => void stopForward()}
      />
    </ToolLayout>
  );
}
