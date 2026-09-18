import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Events } from '@wailsio/runtime';
import {
  ArrowsClockwise,
  CaretDown,
  CircleNotch,
  ClockCounterClockwise,
  GearSix,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Power,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  ClearLogBuffer,
  GetDockerContainerDetail,
  GetLogMonitors,
  GetPM2ProcessDetail,
  GetServiceInventory,
  GetSystemdUnitDetail,
  GetServiceTargets,
  PerformServiceAction,
  QueryLogBuffer,
  SaveServiceTargets,
  StartLogMonitors,
  StopLogMonitor,
} from '../../bindings/changeme/servicemanagerservice';
import type {
  DockerComposeGroup,
  DockerContainer,
  LogMonitor,
  ServiceActionRequest,
  ServiceInventory,
  ServiceLogLine,
  ServiceResourceRef,
  ServiceTarget,
  SystemdUnit,
} from '../../bindings/changeme/models';
import {
  Reveal,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutHeader,
  ToolLayoutToolbar,
} from './shared';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { SSHProfileSelect } from './SSHProfileSelect';
import { ConfirmDialog } from './ConfirmDialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Spinner } from './ui/spinner';
import { toast } from './ui/toast';

const MANAGE_TARGETS_VALUE = '__manage-targets__';
const LOCAL_TARGET: ServiceTarget = { id: 'local', name: 'local', kind: 'local' };

type Runtime = 'docker' | 'pm2' | 'systemd';
type Selection = { resource: ServiceResourceRef; kind: 'container' | 'group' | 'pm2' | 'systemd' };
type LogEvent = { lines?: ServiceLogLine[] };

// 每个运行时支持的状态，作为状态筛选里的分组。
const STATUS_GROUPS: Array<{ runtime: Runtime; statuses: string[] }> = [
  {
    runtime: 'docker',
    statuses: ['running', 'exited', 'created', 'paused', 'restarting', 'removing', 'dead'],
  },
  {
    runtime: 'pm2',
    statuses: ['online', 'launching', 'stopping', 'stopped', 'errored', 'waiting restart'],
  },
  {
    runtime: 'systemd',
    statuses: ['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating'],
  },
];
function statusKey(runtime: Runtime, status: string) {
  return `${runtime}:${status}`;
}
function matchesStatusFilter(statuses: Set<string>, runtime: Runtime, status: string) {
  return statuses.size === 0 || statuses.has(statusKey(runtime, status));
}
function runtimeFiltered(statuses: Set<string>, runtime: Runtime) {
  if (statuses.size === 0) return true;
  for (const key of statuses) {
    if (key.startsWith(`${runtime}:`)) return true;
  }
  return false;
}

function resourceKey(resource: ServiceResourceRef) {
  return `${resource.runtime}|${resource.scope ?? ''}|${resource.id}`;
}
function monitorResourceKey(monitor: LogMonitor) {
  return resourceKey(monitor.resource);
}
function statusVariant(value: string) {
  return /running|active|online/i.test(value)
    ? 'default'
    : /failed|dead|exited/i.test(value)
      ? 'destructive'
      : 'secondary';
}
function formatDate(value: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function targetLabel(target: ServiceTarget, t: ReturnType<typeof useTranslation>['t']) {
  return target.kind === 'local' ? t('serviceManagerTool.localTarget') : target.name;
}

export default function ServiceManagerTool({
  active,
  record,
}: {
  active: boolean;
  record: (
    tool: 'service-manager',
    action: string,
    detail: string,
    input: string,
    output?: string,
  ) => void;
}) {
  const { t } = useTranslation();
  const { profiles, reload } = useSSHProfiles();
  const [targets, setTargets] = useState<ServiceTarget[]>([]);
  const [targetID, setTargetID] = useState('local');
  const targetIDRef = useRef(targetID);
  targetIDRef.current = targetID;
  const [inventory, setInventory] = useState<ServiceInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState('');
  const [monitors, setMonitors] = useState<LogMonitor[]>([]);
  const [viewMode, setViewMode] = useState<'single' | 'merged'>('single');
  const [visibleMonitorIDs, setVisibleMonitorIDs] = useState<string[]>([]);
  const [logDraft, setLogDraft] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [lines, setLines] = useState<ServiceLogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<ServiceTarget | null>(null);
  const [draftTargets, setDraftTargets] = useState<ServiceTarget[]>([]);
  const [savingTargets, setSavingTargets] = useState(false);
  const [targetDraftError, setTargetDraftError] = useState('');
  const [targetSaveError, setTargetSaveError] = useState('');
  const [pendingRemove, setPendingRemove] = useState<ServiceTarget | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    resource: ServiceResourceRef;
    action: string;
  } | null>(null);
  const monitorsRef = useRef<LogMonitor[]>([]);
  monitorsRef.current = monitors;

  // syncTargets 用配置中的目标刷新下拉；当前目标被移除时停掉其日志监控并回到本机。
  const syncTargets = (next: ServiceTarget[]) => {
    setTargets(next);
    if (next.some((item) => item.id === targetIDRef.current)) return;
    const active = monitorsRef.current.filter((item) => item.state === 'monitoring');
    void Promise.all(active.map((item) => StopLogMonitor(item.id).catch(() => undefined)));
    setMonitors([]);
    setSelection(null);
    setVisibleMonitorIDs([]);
    setLines([]);
    setInventory(null);
    setTargetID('local');
  };

  const load = async (nextTarget = targetID) => {
    setLoading(true);
    try {
      const next = await GetServiceInventory(nextTarget);
      if (targetIDRef.current !== nextTarget) return;
      setInventory(next);
    } catch (error) {
      if (targetIDRef.current !== nextTarget) return;
      toast.add({
        title: t('serviceManagerTool.refreshFailed'),
        description: String(error),
        type: 'error',
      });
    } finally {
      if (targetIDRef.current === nextTarget) setLoading(false);
    }
  };
  const loadMonitors = async (nextTarget = targetID) => {
    const items = (await GetLogMonitors(nextTarget)) ?? [];
    if (targetIDRef.current !== nextTarget) return;
    setMonitors(items);
  };

  useEffect(() => {
    void GetServiceTargets()
      .then((items) => syncTargets(items ?? []))
      .catch(() => setTargets([]));
  }, [profiles]);
  useEffect(() => {
    void load(targetID);
    void loadMonitors(targetID);
  }, [targetID]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [active, targetID]);
  useEffect(() => {
    const off = Events.On('service-manager:logs', (event) => {
      const data = event.data as LogEvent;
      const incoming = data?.lines ?? [];
      if (!incoming.length) return;
      setLines((current) => {
        const visible = new Set(visibleMonitorIDs);
        const accepted = incoming.filter(
          (line) =>
            (!visible.size || visible.has(line.monitorID)) &&
            matchesLog(line, logQuery, regex, caseSensitive),
        );
        if (!accepted.length) return current;
        const ids = new Set(current.map((line) => line.sequence));
        return [...current, ...accepted.filter((line) => !ids.has(line.sequence))].sort(
          (a, b) => a.sequence - b.sequence,
        );
      });
    });
    const offState = Events.On('service-manager:log-state', () => void loadMonitors());
    return () => {
      off();
      offState();
    };
  }, [visibleMonitorIDs, logQuery, regex, caseSensitive, targetID]);
  useEffect(() => {
    const run = async () => {
      try {
        const snapshot = await QueryLogBuffer({
          monitorIDs: visibleMonitorIDs,
          filter: { query: logQuery, regex, caseSensitive, streams: [] },
        });
        setLines(snapshot.lines ?? []);
        setTruncated(snapshot.truncated);
      } catch (error) {
        toast.add({
          title: t('serviceManagerTool.filterFailed'),
          description: String(error),
          type: 'error',
        });
      }
    };
    void run();
  }, [visibleMonitorIDs, logQuery, regex, caseSensitive]);
  useEffect(() => {
    if (!selection || selection.kind === 'group') {
      setDetail(null);
      return;
    }
    const resource = selection.resource;
    const request =
      resource.runtime === 'docker'
        ? GetDockerContainerDetail(targetID, resource.id)
        : resource.runtime === 'pm2'
          ? GetPM2ProcessDetail(targetID, resource.id)
          : GetSystemdUnitDetail(targetID, resource.id, resource.scope ?? 'system');
    void request
      .then((value) => setDetail(value as unknown as Record<string, unknown>))
      .catch(() => setDetail(null));
  }, [selection, targetID]);

  const selectedTarget = targets.find((target) => target.id === targetID);
  const monitoredByResource = useMemo(
    () => new Map(monitors.map((item) => [monitorResourceKey(item), item])),
    [monitors],
  );
  const monitoredVisible = useMemo(
    () =>
      monitors.filter((item) => !visibleMonitorIDs.length || visibleMonitorIDs.includes(item.id)),
    [monitors, visibleMonitorIDs],
  );
  const selectedMonitor = selection
    ? monitoredByResource.get(resourceKey(selection.resource))
    : undefined;

  const selectTarget = (next: string | null) => {
    if (!next || next === targetID) return;
    const old = monitors.filter((item) => item.state === 'monitoring');
    if (
      old.length &&
      !window.confirm(t('serviceManagerTool.changeTargetConfirm', { total: old.length }))
    )
      return;
    setSelection(null);
    setVisibleMonitorIDs([]);
    setLines([]);
    // 立即清空旧主机列表并进入 loading，旧主机的日志监控在后台停止。
    setInventory(null);
    setTargetID(next);
    void Promise.all(old.map((item) => StopLogMonitor(item.id).catch(() => undefined)));
  };
  const act = (resource: ServiceResourceRef, action: string) => {
    if (action === 'delete' || action.startsWith('disable')) {
      setPendingAction({ resource, action });
      return;
    }
    void performAction(resource, action);
  };
  const confirmPendingAction = async () => {
    const pending = pendingAction;
    if (!pending) return;
    await performAction(pending.resource, pending.action);
    setPendingAction(null);
  };
  const performAction = async (resource: ServiceResourceRef, action: string) => {
    const key = `${resourceKey(resource)}:${action}`;
    setBusy(key);
    try {
      const result = await PerformServiceAction({
        targetID,
        resource,
        action,
      } as ServiceActionRequest);
      const failed = result.failed ?? [];
      const succeeded = result.succeeded ?? [];
      if (succeeded.length)
        record(
          'service-manager',
          action,
          `${selectedTarget ? targetLabel(selectedTarget, t) : targetID} · ${resource.name || resource.id}`,
          '',
          failed.map((item) => item.error).join('\n'),
        );
      if (failed.length)
        toast.add({
          title: t('serviceManagerTool.actionFailed'),
          description: failed.map((item) => item.error).join('；'),
          type: 'error',
        });
      else toast.add({ title: t('serviceManagerTool.actionSucceeded'), type: 'success' });
      await load();
    } catch (error) {
      toast.add({
        title: t('serviceManagerTool.actionFailed'),
        description: String(error),
        type: 'error',
      });
    } finally {
      setBusy('');
    }
  };
  const monitor = async (resources: ServiceResourceRef[]) => {
    try {
      const created = (await StartLogMonitors({ targetID, resources })) ?? [];
      const ids = created.map((item) => item.id);
      setMonitors((current) => {
        const all = new Map(current.map((item) => [item.id, item]));
        created.forEach((item) => all.set(item.id, item));
        return [...all.values()];
      });
      if (viewMode === 'single' && ids[0]) setVisibleMonitorIDs([ids[0]]);
      else setVisibleMonitorIDs((current) => [...new Set([...current, ...ids])]);
    } catch (error) {
      toast.add({
        title: t('serviceManagerTool.monitorFailed'),
        description: String(error),
        type: 'error',
      });
    }
  };
  const toggleVisible = (monitorID: string, enabled: boolean) =>
    setVisibleMonitorIDs((current) =>
      enabled ? [...new Set([...current, monitorID])] : current.filter((id) => id !== monitorID),
    );
  const stop = async (monitorID: string) => {
    await StopLogMonitor(monitorID);
    await loadMonitors();
  };
  const clear = async (monitorID: string) => {
    await ClearLogBuffer(monitorID);
    await loadMonitors();
  };
  const selectedTargetMissing =
    selectedTarget?.kind === 'ssh' &&
    !profiles.some((profile) => profile.id === selectedTarget.sshProfileID);
  const openManage = () => {
    void reload().catch(() => undefined);
    setEditingTarget(null);
    setDraftTargets(targets);
    setTargetDraftError('');
    setTargetSaveError('');
    setManageOpen(true);
  };
  const newTarget = () => {
    setTargetDraftError('');
    setEditingTarget({ id: '', name: '', kind: 'ssh', sshProfileID: profiles[0]?.id ?? '' });
  };
  const editTarget = (target: ServiceTarget) => {
    setTargetDraftError('');
    setEditingTarget({ ...target });
  };
  const updateTargetDraft = (patch: Partial<ServiceTarget>) => {
    setTargetDraftError('');
    setEditingTarget((current) => (current ? { ...current, ...patch } : current));
  };
  const removeTarget = (id: string) => {
    setDraftTargets((current) => current.filter((item) => item.id !== id));
  };
  const confirmRemoveTarget = () => {
    if (pendingRemove) removeTarget(pendingRemove.id);
    setPendingRemove(null);
  };
  const saveTarget = () => {
    if (!editingTarget) return;
    const profileID = editingTarget.sshProfileID?.trim() ?? '';
    const profile = profiles.find((item) => item.id === profileID);
    if (!profile) {
      setTargetDraftError(t('serviceManagerTool.sshProfileRequired'));
      return;
    }
    const next: ServiceTarget = {
      id: `ssh:${profileID}`,
      name: editingTarget.name.trim() || profile.name,
      kind: 'ssh',
      sshProfileID: profileID,
    };
    setDraftTargets((current) => [
      ...current.filter(
        (item) => item.kind !== 'ssh' || (item.id !== editingTarget.id && item.id !== next.id),
      ),
      next,
    ]);
    setTargetDraftError('');
    setEditingTarget(null);
  };
  const saveTargets = async () => {
    const sshTargets = draftTargets.filter((item) => item.kind === 'ssh');
    setSavingTargets(true);
    setTargetSaveError('');
    try {
      // 保存前以服务端为准刷新 SSH 配置，避免引用到已失效的列表快照。
      const latest = await reload().catch(() => profiles);
      const invalid = sshTargets.find(
        (item) => !item.sshProfileID || !latest.some((profile) => profile.id === item.sshProfileID),
      );
      if (invalid) {
        setTargetSaveError(t('serviceManagerTool.sshProfileRequired'));
        return;
      }
      await SaveServiceTargets([LOCAL_TARGET, ...sshTargets]);
      const next = (await GetServiceTargets()) ?? [];
      syncTargets(next);
      setManageOpen(false);
    } catch (error) {
      setTargetSaveError(String(error) || t('serviceManagerTool.targetSaveFailed'));
    } finally {
      setSavingTargets(false);
    }
  };
  const renderTargetForm = () => {
    if (!editingTarget) return null;
    const profile = profiles.find((item) => item.id === editingTarget.sshProfileID);
    return (
      <form
        className="mt-3 flex flex-col gap-3 border-t border-border pt-3"
        id="service-target-form"
        onSubmit={(event) => {
          event.preventDefault();
          saveTarget();
        }}
      >
        <h3 className="m-0 text-sm font-medium text-foreground">
          {editingTarget.id
            ? t('serviceManagerTool.editTarget')
            : t('serviceManagerTool.addTarget')}
        </h3>
        <div className="grid gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="service-target-name">{t('serviceManagerTool.targetName')}</Label>
            <Input
              id="service-target-name"
              value={editingTarget.name}
              placeholder={profile?.name}
              onChange={(event) => updateTargetDraft({ name: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="service-target-profile">
              {t('serviceManagerTool.targetSSHProfile')}
            </Label>
            <SSHProfileSelect
              id="service-target-profile"
              value={editingTarget.sshProfileID ?? ''}
              onValueChange={(value) => updateTargetDraft({ sshProfileID: value })}
              placeholder={t('serviceManagerTool.selectSSHProfile')}
            />
            {editingTarget.sshProfileID && !profile ? (
              <p className="m-0 text-[10px] leading-4 text-destructive" role="alert">
                {t('serviceManagerTool.sshProfileMissingHint')}
              </p>
            ) : null}
          </div>
        </div>
        {targetDraftError ? (
          <p className="m-0 text-sm text-destructive" role="alert">
            {targetDraftError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingTarget(null);
              setTargetDraftError('');
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm">
            {t('common.save')}
          </Button>
        </div>
      </form>
    );
  };
  const toggleStatus = (runtime: Runtime, status: string, checked: boolean) => {
    const key = statusKey(runtime, status);
    setStatusFilter((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const clearStatusFilter = () => setStatusFilter(new Set());

  return (
    <Reveal active={active} fill>
      <ToolLayout>
        <ToolLayoutHeader
          title={t('serviceManagerTool.title')}
          subtitle={t('serviceManagerTool.subtitle')}
        />
        <ToolLayoutToolbar
          left={
            <>
              <div className="flex min-w-0 flex-col gap-1 max-[700px]:w-full">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {t('serviceManagerTool.target')}
                </span>
                <Select
                  items={targets.map((item) => ({ value: item.id, label: targetLabel(item, t) }))}
                  value={targetID}
                  onValueChange={(value) => {
                    if (value === MANAGE_TARGETS_VALUE) {
                      openManage();
                      return;
                    }
                    selectTarget(value);
                  }}
                >
                  <SelectTrigger className="min-w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {targets.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {targetLabel(item, t)}
                        </SelectItem>
                      ))}
                      {targets.length > 0 ? <SelectSeparator /> : null}
                      <SelectItem value={MANAGE_TARGETS_VALUE}>
                        <span className="flex items-center gap-2">
                          <GearSix size={14} weight="duotone" />
                          {t('serviceManagerTool.manageTargets')}
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {selectedTargetMissing ? (
                  <Badge variant="destructive" className="h-5 text-[10px]">
                    {t('serviceManagerTool.sshProfileMissing')}
                  </Badge>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-1 max-[700px]:w-full">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {t('serviceManagerTool.status')}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" size="sm" className="min-w-48 justify-between" />
                    }
                  >
                    <span className="truncate">
                      {statusFilter.size === 0
                        ? t('serviceManagerTool.statusAll')
                        : t('serviceManagerTool.statusSelected', { count: statusFilter.size })}
                    </span>
                    <CaretDown data-icon="inline-end" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
                    {STATUS_GROUPS.map((group) => (
                      <DropdownMenuGroup key={group.runtime}>
                        <DropdownMenuLabel>
                          {t(`serviceManagerTool.runtimes.${group.runtime}`)}
                        </DropdownMenuLabel>
                        {group.statuses.map((status) => (
                          <DropdownMenuCheckboxItem
                            key={statusKey(group.runtime, status)}
                            checked={statusFilter.has(statusKey(group.runtime, status))}
                            closeOnClick={false}
                            onCheckedChange={(checked) =>
                              toggleStatus(group.runtime, status, checked === true)
                            }
                          >
                            {status}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuGroup>
                    ))}
                    {statusFilter.size > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={clearStatusFilter}>
                          {t('serviceManagerTool.clearStatusFilter')}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex min-w-0 flex-col gap-1 max-[700px]:w-full">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {t('serviceManagerTool.search')}
                </span>
                <Input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setSearch(searchDraft.trim().toLowerCase());
                  }}
                  placeholder={t('serviceManagerTool.searchPlaceholder')}
                />
              </div>
            </>
          }
          right={
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner /> : <ArrowsClockwise weight="duotone" />}
              {t('serviceManagerTool.refresh')}
            </Button>
          }
        />
        <ToolLayoutContent className="grid min-h-0 grid-cols-[minmax(230px,38%)_minmax(0,1fr)] border-t max-[800px]:grid-cols-1 max-[800px]:grid-rows-[minmax(180px,42%)_minmax(0,1fr)]">
          <ResourceList
            inventory={inventory}
            statuses={statusFilter}
            search={search}
            selection={selection}
            onSelect={setSelection}
            onMonitor={monitor}
            monitored={monitoredByResource}
            t={t}
          />
          <section className="min-h-0 overflow-hidden border-l max-[800px]:border-t max-[800px]:border-l-0">
            {selection ? (
              <ResourcePanel
                selection={selection}
                detail={detail}
                monitor={selectedMonitor}
                viewMode={viewMode}
                setViewMode={setViewMode}
                monitors={monitoredVisible}
                visibleMonitorIDs={visibleMonitorIDs}
                toggleVisible={toggleVisible}
                lines={lines}
                truncated={truncated}
                logDraft={logDraft}
                setLogDraft={setLogDraft}
                applyFilter={() => setLogQuery(logDraft)}
                regex={regex}
                setRegex={setRegex}
                caseSensitive={caseSensitive}
                setCaseSensitive={setCaseSensitive}
                onMonitor={monitor}
                onStop={stop}
                onClear={clear}
                onAction={act}
                busy={busy}
                t={t}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                {t('serviceManagerTool.selectHint')}
              </div>
            )}
          </section>
        </ToolLayoutContent>
      </ToolLayout>
      <Dialog
        open={manageOpen}
        onOpenChange={(open) => {
          setManageOpen(open);
          if (!open) {
            setEditingTarget(null);
            setTargetDraftError('');
          }
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col sm:max-w-lg"
          showCloseButton
        >
          <DialogHeader className="flex-none">
            <DialogTitle>{t('serviceManagerTool.manageTargetsTitle')}</DialogTitle>
            <DialogDescription>{t('serviceManagerTool.manageTargetsDesc')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [padding-inline-end:var(--overlay-scrollbar-hit-size)]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">
                {t('serviceManagerTool.targets')}
              </span>
              <Button variant="outline" size="sm" disabled={!profiles.length} onClick={newTarget}>
                <Plus data-icon="inline-start" /> {t('serviceManagerTool.addTarget')}
              </Button>
            </div>
            {draftTargets.filter((item) => item.kind === 'ssh').length > 0 ? (
              <div className="mt-2 divide-y divide-border">
                {draftTargets
                  .filter((item) => item.kind === 'ssh')
                  .map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-foreground">{item.name}</div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span>{t('serviceManagerTool.targetKindSsh')}</span>
                          {!profiles.some((profile) => profile.id === item.sshProfileID) ? (
                            <Badge variant="destructive" className="h-4 text-[9px]">
                              {t('serviceManagerTool.sshProfileMissing')}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-none gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('serviceManagerTool.editTarget')}
                          onClick={() => editTarget(item)}
                        >
                          <PencilSimple />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={t('serviceManagerTool.removeTarget')}
                          onClick={() => setPendingRemove(item)}
                        >
                          <Trash />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            ) : null}
            {renderTargetForm()}
            {targetSaveError ? (
              <p className="m-0 pt-3 text-sm text-destructive" role="alert">
                {targetSaveError}
              </p>
            ) : null}
          </div>
          <DialogFooter className="flex-none">
            <Button variant="outline" disabled={savingTargets} onClick={() => setManageOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={savingTargets} onClick={() => void saveTargets()}>
              {savingTargets ? <Spinner data-icon="inline-start" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={t('serviceManagerTool.removeTargetTitle')}
        description={t('serviceManagerTool.removeTargetBody', { name: pendingRemove?.name ?? '' })}
        confirmLabel={t('serviceManagerTool.removeTarget')}
        destructive
        onConfirm={confirmRemoveTarget}
      />
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title={pendingAction ? t(`serviceManagerTool.actions.${pendingAction.action}`) : ''}
        description={
          pendingAction
            ? t('serviceManagerTool.confirmAction', {
                action: t(`serviceManagerTool.actions.${pendingAction.action}`),
                name: pendingAction.resource.name || pendingAction.resource.id,
              })
            : ''
        }
        confirmLabel={pendingAction ? t(`serviceManagerTool.actions.${pendingAction.action}`) : ''}
        destructive
        busy={
          pendingAction !== null &&
          busy === `${resourceKey(pendingAction.resource)}:${pendingAction.action}`
        }
        onConfirm={() => void confirmPendingAction()}
      />
    </Reveal>
  );
}

function ResourceList({
  inventory,
  statuses,
  search,
  selection,
  onSelect,
  onMonitor,
  monitored,
  t,
}: {
  inventory: ServiceInventory | null;
  statuses: Set<string>;
  search: string;
  selection: Selection | null;
  onSelect: (next: Selection) => void;
  onMonitor: (items: ServiceResourceRef[]) => void;
  monitored: Map<string, LogMonitor>;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (!inventory)
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-2 text-center">
          <Spinner />
          <span className="text-sm text-muted-foreground">{t('serviceManagerTool.loading')}</span>
        </div>
      </div>
    );
  const match = (name: string) => !search || name.toLowerCase().includes(search);
  const row = (
    resource: ServiceResourceRef,
    kind: Selection['kind'],
    status: string,
    description = '',
  ) => {
    if (!match(resource.name || resource.id)) return null;
    if (!matchesStatusFilter(statuses, resource.runtime as Runtime, status)) return null;
    const active = selection && resourceKey(selection.resource) === resourceKey(resource);
    const monitor = monitored.get(resourceKey(resource));
    return (
      <button
        key={resourceKey(resource)}
        type="button"
        className={`flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted/50 ${active ? 'bg-muted' : ''}`}
        onClick={() => onSelect({ resource, kind })}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{resource.name || resource.id}</span>
          {description ? (
            <span className="block truncate text-xs text-muted-foreground">{description}</span>
          ) : null}
        </span>
        <Badge variant={statusVariant(status)}>{status || '—'}</Badge>
        {monitor?.state === 'monitoring' ? (
          <CircleNotch className="size-3.5 animate-spin text-primary" />
        ) : null}
      </button>
    );
  };
  const group = (item: DockerComposeGroup) => {
    const containers = item.containers ?? [];
    const visibleContainers = containers.filter((container) =>
      matchesStatusFilter(statuses, 'docker', container.status),
    );
    if (!visibleContainers.length) return null;
    const resource = { runtime: 'docker-compose', id: item.id, name: item.name };
    return (
      <div key={item.id}>
        <div
          role="button"
          tabIndex={0}
          className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/50"
          onClick={() => onSelect({ resource, kind: 'group' })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSelect({ resource, kind: 'group' });
          }}
        >
          <CaretDown weight="bold" />
          {t('serviceManagerTool.composeGroup', { name: item.name })}
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            title={t('serviceManagerTool.monitorGroup')}
            onClick={(event) => {
              event.stopPropagation();
              onMonitor(
                containers.map((container) => ({
                  runtime: 'docker',
                  id: container.id,
                  name: container.name,
                })),
              );
            }}
          >
            <ClockCounterClockwise weight="duotone" />
          </Button>
        </div>
        {visibleContainers.map((container) =>
          row(
            { runtime: 'docker', id: container.id, name: container.name },
            'container',
            container.status,
            container.image,
          ),
        )}
      </div>
    );
  };
  const standaloneContainers = (inventory.containers ?? []).filter((container) =>
    matchesStatusFilter(statuses, 'docker', container.status),
  );
  const pm2Processes = (inventory.pm2Processes ?? []).filter((process) =>
    matchesStatusFilter(statuses, 'pm2', process.status),
  );
  const systemUnits = (inventory.systemUnits ?? []).filter((unit) =>
    matchesStatusFilter(statuses, 'systemd', unit.activeState),
  );
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {runtimeFiltered(statuses, 'docker') ? (
        <>
          {inventory.docker.available ? (
            <>
              {(inventory.dockerGroups ?? []).map(group)}
              {standaloneContainers.length ? (
                <>
                  <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
                    {t('serviceManagerTool.standalone')}
                  </div>
                  {standaloneContainers.map((container: DockerContainer) =>
                    row(
                      { runtime: 'docker', id: container.id, name: container.name },
                      'container',
                      container.status,
                      container.image,
                    ),
                  )}
                </>
              ) : null}
            </>
          ) : (
            <RuntimeError name="Docker" error={inventory.docker.error} />
          )}
        </>
      ) : null}
      {runtimeFiltered(statuses, 'pm2') ? (
        <>
          {inventory.pm2.available ? (
            <>
              <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
                PM2
              </div>
              {pm2Processes.map((process) =>
                row(
                  { runtime: 'pm2', id: process.id, name: process.name },
                  'pm2',
                  process.status,
                  process.script,
                ),
              )}
            </>
          ) : (
            <RuntimeError name="PM2" error={inventory.pm2.error} />
          )}
        </>
      ) : null}
      {runtimeFiltered(statuses, 'systemd') ? (
        <>
          {inventory.systemd.available ? (
            <>
              <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
                Systemd
              </div>
              {systemUnits.map((unit: SystemdUnit) =>
                row(
                  { runtime: 'systemd', id: unit.id, scope: unit.scope, name: unit.name },
                  'systemd',
                  unit.activeState,
                  unit.description,
                ),
              )}
            </>
          ) : (
            <RuntimeError name="Systemd" error={inventory.systemd.error} />
          )}
        </>
      ) : null}
    </div>
  );
}
function RuntimeError({ name, error }: { name: string; error?: string }) {
  return (
    <div className="border-b px-3 py-3 text-xs text-muted-foreground">
      <WarningCircle className="mr-1 inline size-3.5" />
      {name}: {error || '—'}
    </div>
  );
}

function ResourcePanel({
  selection,
  detail,
  monitor,
  viewMode,
  setViewMode,
  monitors,
  visibleMonitorIDs,
  toggleVisible,
  lines,
  truncated,
  logDraft,
  setLogDraft,
  applyFilter,
  regex,
  setRegex,
  caseSensitive,
  setCaseSensitive,
  onMonitor,
  onStop,
  onClear,
  onAction,
  busy,
  t,
}: {
  selection: Selection;
  detail: Record<string, unknown> | null;
  monitor?: LogMonitor;
  viewMode: 'single' | 'merged';
  setViewMode: (value: 'single' | 'merged') => void;
  monitors: LogMonitor[];
  visibleMonitorIDs: string[];
  toggleVisible: (id: string, enabled: boolean) => void;
  lines: ServiceLogLine[];
  truncated: boolean;
  logDraft: string;
  setLogDraft: (value: string) => void;
  applyFilter: () => void;
  regex: boolean;
  setRegex: (value: boolean) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  onMonitor: (items: ServiceResourceRef[]) => void;
  onStop: (id: string) => void;
  onClear: (id: string) => void;
  onAction: (resource: ServiceResourceRef, action: string) => void;
  busy: string;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resource = selection.resource;
  const actions =
    resource.runtime === 'systemd'
      ? ['start', 'stop', 'restart', 'disable', 'disable-now']
      : ['start', 'stop', 'restart', 'delete'];
  const activeMonitorIDs = viewMode === 'merged' ? visibleMonitorIDs : monitor ? [monitor.id] : [];
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{resource.name || resource.id}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {resource.runtime}
              {resource.scope ? ` · ${resource.scope}` : ''}
            </p>
          </div>
          {actions.map((action) => (
            <Button
              key={action}
              variant={
                action === 'delete' || action.startsWith('disable') ? 'destructive' : 'outline'
              }
              size="icon-xs"
              disabled={busy === `${resourceKey(resource)}:${action}`}
              title={t(`serviceManagerTool.actions.${action}`)}
              onClick={() => onAction(resource, action)}
            >
              {action === 'start' ? (
                <Play weight="duotone" />
              ) : action === 'stop' ? (
                <Pause weight="duotone" />
              ) : action === 'restart' ? (
                <ArrowsClockwise weight="duotone" />
              ) : action === 'delete' ? (
                <Trash weight="duotone" />
              ) : (
                <Power weight="duotone" />
              )}
            </Button>
          ))}
        </div>
        {detail ? (
          <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
            {JSON.stringify(detail, null, 2)}
          </pre>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {selection.kind !== 'group' ? (
            monitor ? (
              <>
                <Button variant="outline" size="sm" onClick={() => void onStop(monitor.id)}>
                  {t('serviceManagerTool.stopMonitor')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void onClear(monitor.id)}>
                  {t('serviceManagerTool.clearLogs')}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => onMonitor([resource])}>
                {t('serviceManagerTool.monitor')}
              </Button>
            )
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setViewMode(viewMode === 'single' ? 'merged' : 'single')}
          >
            {t(
              viewMode === 'single'
                ? 'serviceManagerTool.mergedView'
                : 'serviceManagerTool.singleView',
            )}
          </Button>
        </div>
      </div>
      <div className="border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <Input
            className="h-8"
            value={logDraft}
            onChange={(event) => setLogDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyFilter();
            }}
            placeholder={t('serviceManagerTool.logFilter')}
          />
          <Button variant="outline" size="sm" onClick={applyFilter}>
            {t('serviceManagerTool.apply')}
          </Button>
          <Button
            variant={regex ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setRegex(!regex)}
          >
            {t('serviceManagerTool.regex')}
          </Button>
          <Button
            variant={caseSensitive ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setCaseSensitive(!caseSensitive)}
          >
            {t('serviceManagerTool.caseSensitive')}
          </Button>
        </div>
        {viewMode === 'merged' && monitors.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {monitors.map((item) => (
              <label key={item.id} className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={visibleMonitorIDs.includes(item.id)}
                  onCheckedChange={(checked) => toggleVisible(item.id, checked === true)}
                />
                {item.resource.name || item.resource.id}
              </label>
            ))}
          </div>
        ) : null}
        {truncated ? (
          <p className="mt-2 text-xs text-amber-600">{t('serviceManagerTool.logsTruncated')}</p>
        ) : null}
      </div>
      <LogList lines={lines.filter((line) => activeMonitorIDs.includes(line.monitorID))} />
    </div>
  );
}
function LogList({ lines }: { lines: ServiceLogLine[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });
  return (
    <div ref={parentRef} className="min-h-0 overflow-auto font-mono text-xs">
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const line = lines[row.index];
          return (
            <div
              key={line.sequence}
              ref={virtualizer.measureElement}
              data-index={row.index}
              className="absolute left-0 w-full border-b px-3 py-1 whitespace-pre"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <span className="mr-2 text-muted-foreground">
                {line.timestamp || formatDate(line.receivedAt)}
              </span>
              <span className="mr-2 text-primary">{line.name}</span>
              <span>{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function matchesLog(line: ServiceLogLine, query: string, regex: boolean, caseSensitive: boolean) {
  if (!query) return true;
  try {
    if (regex) return new RegExp(query, caseSensitive ? '' : 'i').test(line.text);
    return (caseSensitive ? line.text : line.text.toLowerCase()).includes(
      caseSensitive ? query : query.toLowerCase(),
    );
  } catch {
    return false;
  }
}
