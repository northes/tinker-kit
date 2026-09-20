import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Events } from '@wailsio/runtime';
import {
  ArrowsClockwise,
  ArrowCounterClockwise,
  Asterisk,
  CaretDown,
  Eraser,
  GearSix,
  Info,
  Pause,
  Play,
  Power,
  Stop,
  TextAa,
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
import { ScrollArea } from './ui/scroll-area';
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
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { TargetHostManagerDialog } from './TargetHostManagerDialog';

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
function logDate(line: ServiceLogLine) {
  const date = new Date(line.timestamp || line.receivedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}
const pad2 = (value: number) => String(value).padStart(2, '0');
function dayKeyOf(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function logTime(line: ServiceLogLine) {
  const date = logDate(line);
  if (!date) return line.timestamp || line.receivedAt || '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
function logDayKey(line: ServiceLogLine) {
  const date = logDate(line);
  return date ? dayKeyOf(date) : '';
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
  const [logDraft, setLogDraft] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [lines, setLines] = useState<ServiceLogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
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
  const [monitorDialog, setMonitorDialog] = useState<{
    resource: ServiceResourceRef;
    containers: DockerContainer[];
  } | null>(null);
  const [monitorSelection, setMonitorSelection] = useState<Set<string>>(new Set());
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

  const monitoredByResource = useMemo(
    () => new Map(monitors.map((item) => [monitorResourceKey(item), item])),
    [monitors],
  );
  // Compose 组选中时聚合其所有容器的监控；单资源沿用资源键匹配。
  const selectedMonitors = useMemo(() => {
    if (!selection) return [] as LogMonitor[];
    if (selection.kind === 'group') {
      const group = inventory?.dockerGroups?.find((item) => item.id === selection.resource.id);
      const ids = new Set((group?.containers ?? []).map((item) => item.id));
      return monitors.filter(
        (item) => item.resource.runtime === 'docker' && ids.has(item.resource.id),
      );
    }
    const found = monitoredByResource.get(resourceKey(selection.resource));
    return found ? [found] : [];
  }, [selection, inventory, monitors, monitoredByResource]);
  const activeMonitorIDs = useMemo(
    () => selectedMonitors.map((item) => item.id),
    [selectedMonitors],
  );
  const activeMonitorKey = activeMonitorIDs.join(',');
  const monitoring = selectedMonitors.some((item) => item.state === 'monitoring');

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
      if (!incoming.length || !activeMonitorKey) return;
      setLines((current) => {
        const accepted = incoming.filter(
          (line) =>
            activeMonitorIDs.includes(line.monitorID) &&
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
  }, [activeMonitorKey, logQuery, regex, caseSensitive, targetID]);
  useEffect(() => {
    const run = async () => {
      try {
        const snapshot = await QueryLogBuffer({
          monitorIDs: activeMonitorIDs,
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
  }, [activeMonitorKey, logQuery, regex, caseSensitive]);

  const selectedTarget = targets.find((target) => target.id === targetID);

  const selectTarget = (next: string | null) => {
    if (!next || next === targetID) return;
    const old = monitors.filter((item) => item.state === 'monitoring');
    if (
      old.length &&
      !window.confirm(t('serviceManagerTool.changeTargetConfirm', { total: old.length }))
    )
      return;
    setSelection(null);
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
  const startMonitors = async (resources: ServiceResourceRef[]) => {
    if (!resources.length) {
      toast.add({ title: t('serviceManagerTool.monitorFailed'), type: 'error' });
      return;
    }
    try {
      const created = (await StartLogMonitors({ targetID, resources })) ?? [];
      setMonitors((current) => {
        const all = new Map(current.map((item) => [item.id, item]));
        created.forEach((item) => all.set(item.id, item));
        return [...all.values()];
      });
    } catch (error) {
      toast.add({
        title: t('serviceManagerTool.monitorFailed'),
        description: String(error),
        type: 'error',
      });
    }
  };
  const monitor = async (resource: ServiceResourceRef) => {
    const containers =
      resource.runtime === 'docker-compose'
        ? (inventory?.dockerGroups?.find((item) => item.id === resource.id)?.containers ?? [])
        : [];
    // Compose 组有多个容器时先让用户选择要监控哪些，默认全选。
    if (containers.length > 1) {
      setMonitorSelection(new Set(containers.map((item) => item.id)));
      setMonitorDialog({ resource, containers });
      return;
    }
    const resources =
      resource.runtime === 'docker-compose'
        ? containers.map(
            (item) => ({ runtime: 'docker', id: item.id, name: item.name }) as ServiceResourceRef,
          )
        : [resource];
    await startMonitors(resources);
  };
  const toggleMonitorContainer = (id: string, checked: boolean) =>
    setMonitorSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const confirmMonitorSelection = async () => {
    const dialog = monitorDialog;
    if (!dialog) return;
    const resources = dialog.containers
      .filter((item) => monitorSelection.has(item.id))
      .map((item) => ({ runtime: 'docker', id: item.id, name: item.name }) as ServiceResourceRef);
    setMonitorDialog(null);
    await startMonitors(resources);
  };
  const stop = async () => {
    await Promise.all(activeMonitorIDs.map((id) => StopLogMonitor(id).catch(() => undefined)));
    await loadMonitors();
  };
  const clear = async () => {
    await Promise.all(activeMonitorIDs.map((id) => ClearLogBuffer(id).catch(() => undefined)));
    setLines([]);
    setTruncated(false);
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
  void targetSaveError;
  void newTarget;
  void editTarget;
  void confirmRemoveTarget;
  void saveTargets;
  void renderTargetForm;
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
            monitored={monitoredByResource}
            t={t}
          />
          <section className="min-h-0 overflow-hidden border-l max-[800px]:border-t max-[800px]:border-l-0">
            {selection ? (
              <ResourcePanel
                selection={selection}
                targetID={targetID}
                monitorIDs={activeMonitorIDs}
                monitoring={monitoring}
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
      <TargetHostManagerDialog<ServiceTarget, ServiceTarget>
        open={manageOpen}
        onOpenChange={setManageOpen}
        items={targets.filter((item) => item.kind === 'ssh')}
        itemKey={(item) => item.id}
        itemName={(item) => item.name}
        createDraft={() =>
          ({ id: '', name: '', kind: 'ssh', sshProfileID: profiles[0]?.id ?? '' }) as ServiceTarget
        }
        toDraft={(item) => ({ ...item })}
        commitDraft={(draft, previous) => {
          const profile = profiles.find((item) => item.id === draft.sshProfileID);
          if (!profile) return t('serviceManagerTool.sshProfileRequired');
          const next = {
            id: draft.id || `ssh:${profile.id}`,
            name: draft.name.trim() || profile.name,
            kind: 'ssh',
            sshProfileID: profile.id,
          } as ServiceTarget;
          return [...previous.filter((item) => item.id !== draft.id && item.id !== next.id), next];
        }}
        saveItems={async (managed) => {
          setSavingTargets(true);
          try {
            await SaveServiceTargets([LOCAL_TARGET, ...managed]);
            syncTargets((await GetServiceTargets()) ?? []);
          } finally {
            setSavingTargets(false);
          }
        }}
        saving={savingTargets}
        renderMeta={(item) => (
          <>
            <span>{t('serviceManagerTool.targetKindSsh')}</span>
            {!profiles.some((profile) => profile.id === item.sshProfileID) ? (
              <Badge variant="destructive" className="h-4 text-[9px]">
                {t('serviceManagerTool.sshProfileMissing')}
              </Badge>
            ) : null}
          </>
        )}
        renderForm={({ draft, setDraft }) => (
          <>
            <div className="grid gap-1.5">
              <Label>{t('serviceManagerTool.targetName')}</Label>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('serviceManagerTool.targetSSHProfile')}</Label>
              <SSHProfileSelect
                value={draft.sshProfileID ?? ''}
                onValueChange={(sshProfileID) => setDraft({ ...draft, sshProfileID })}
                placeholder={t('serviceManagerTool.selectSSHProfile')}
              />
            </div>
          </>
        )}
        strings={{
          title: t('serviceManagerTool.manageTargetsTitle'),
          description: t('serviceManagerTool.manageTargetsDesc'),
          listTitle: t('serviceManagerTool.targets'),
          add: t('serviceManagerTool.addTarget'),
          edit: t('serviceManagerTool.editTarget'),
          remove: t('serviceManagerTool.removeTarget'),
          empty: t('serviceManagerTool.targetHostsEmpty'),
          emptyHint: t('serviceManagerTool.targetHostsEmptyHint'),
          save: t('common.save'),
          done: t('common.done'),
          back: t('common.cancel'),
          discardTitle: t('serviceManagerTool.discardTargetsTitle'),
          discardDescription: t('serviceManagerTool.discardTargetsDescription'),
          discardConfirm: t('serviceManagerTool.discardTargetsConfirm'),
          removeTitle: t('serviceManagerTool.removeTargetTitle'),
          removeDescription: (name) => t('serviceManagerTool.removeTargetBody', { name }),
          formTitle: (editing) =>
            editing ? t('serviceManagerTool.editTarget') : t('serviceManagerTool.addTarget'),
        }}
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
      <Dialog
        open={monitorDialog !== null}
        onOpenChange={(open) => {
          if (!open) setMonitorDialog(null);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col sm:max-w-md">
          <DialogHeader className="flex-none">
            <DialogTitle>{t('serviceManagerTool.monitorSelectTitle')}</DialogTitle>
            <DialogDescription>
              {monitorDialog
                ? t('serviceManagerTool.monitorSelectDesc', {
                    name: monitorDialog.resource.name || monitorDialog.resource.id,
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1 overscroll-contain [padding-inline-end:var(--overlay-scrollbar-size)]">
            <div className="divide-y divide-border">
              {(monitorDialog?.containers ?? []).map((container) => (
                <Label
                  key={container.id}
                  htmlFor={`monitor-container-${container.id}`}
                  className="cursor-pointer gap-2 py-2 font-normal"
                >
                  <Checkbox
                    id={`monitor-container-${container.id}`}
                    checked={monitorSelection.has(container.id)}
                    onCheckedChange={(checked) =>
                      toggleMonitorContainer(container.id, checked === true)
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{container.name || container.id}</span>
                  <Badge variant={statusVariant(container.status)}>{container.status || '—'}</Badge>
                </Label>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="flex-none">
            <Button variant="outline" onClick={() => setMonitorDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={monitorSelection.size === 0}
              onClick={() => void confirmMonitorSelection()}
            >
              {t('serviceManagerTool.monitor')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Reveal>
  );
}

function ResourceList({
  inventory,
  statuses,
  search,
  selection,
  onSelect,
  monitored,
  t,
}: {
  inventory: ServiceInventory | null;
  statuses: Set<string>;
  search: string;
  selection: Selection | null;
  onSelect: (next: Selection) => void;
  monitored: Map<string, LogMonitor>;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
        {monitor?.state === 'monitoring' ? <Spinner className="size-3.5 text-primary" /> : null}
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
    const collapsed = collapsedGroups.has(item.id);
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
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="flex-none"
            aria-expanded={!collapsed}
            aria-label={t(
              collapsed ? 'serviceManagerTool.expandGroup' : 'serviceManagerTool.collapseGroup',
            )}
            onClick={(event) => {
              event.stopPropagation();
              toggleGroup(item.id);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <CaretDown
              weight="bold"
              className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
            />
          </Button>
          <span className="min-w-0 flex-1 truncate">
            {t('serviceManagerTool.composeGroup', { name: item.name })}
          </span>
          {containers.some(
            (container) =>
              monitored.get(resourceKey({ runtime: 'docker', id: container.id }))?.state ===
              'monitoring',
          ) ? (
            <Spinner className="size-3.5 flex-none text-primary" />
          ) : null}
        </div>
        {collapsed
          ? null
          : visibleContainers.map((container) =>
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
    <ScrollArea className="h-full min-h-0">
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
    </ScrollArea>
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
  targetID,
  monitorIDs,
  monitoring,
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
  targetID: string;
  monitorIDs: string[];
  monitoring: boolean;
  lines: ServiceLogLine[];
  truncated: boolean;
  logDraft: string;
  setLogDraft: (value: string) => void;
  applyFilter: () => void;
  regex: boolean;
  setRegex: (value: boolean) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  onMonitor: (resource: ServiceResourceRef) => void;
  onStop: () => void;
  onClear: () => void;
  onAction: (resource: ServiceResourceRef, action: string) => void;
  busy: string;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resource = selection.resource;
  const actions =
    resource.runtime === 'systemd'
      ? ['start', 'stop', 'restart', 'disable', 'disable-now']
      : ['start', 'stop', 'restart', 'delete'];
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <>
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
                  <ArrowCounterClockwise weight="duotone" />
                ) : action === 'delete' ? (
                  <Trash weight="duotone" />
                ) : (
                  <Power weight="duotone" />
                )}
              </Button>
            ))}
            {selection.kind !== 'group' ? (
              <Button
                variant="outline"
                size="icon-xs"
                title={t('serviceManagerTool.info')}
                aria-label={t('serviceManagerTool.info')}
                onClick={() => setInfoOpen(true)}
              >
                <Info weight="duotone" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="border-b px-4 py-2">
          <div className="flex items-center gap-2">
            {monitoring ? (
              <Button
                variant="outline"
                size="icon-sm"
                className="flex-none"
                title={t('serviceManagerTool.stopMonitor')}
                aria-label={t('serviceManagerTool.stopMonitor')}
                onClick={() => void onStop()}
              >
                <Stop weight="duotone" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="icon-sm"
                className="flex-none"
                title={t('serviceManagerTool.monitor')}
                aria-label={t('serviceManagerTool.monitor')}
                onClick={() => onMonitor(resource)}
              >
                <Play weight="duotone" />
              </Button>
            )}
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
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              value={[regex ? 'regex' : '', caseSensitive ? 'case' : ''].filter(Boolean)}
              onValueChange={(value) => {
                setRegex(value.includes('regex'));
                setCaseSensitive(value.includes('case'));
              }}
            >
              <ToggleGroupItem
                value="regex"
                title={t('serviceManagerTool.regex')}
                aria-label={t('serviceManagerTool.regex')}
              >
                <Asterisk weight="duotone" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="case"
                title={t('serviceManagerTool.caseSensitive')}
                aria-label={t('serviceManagerTool.caseSensitive')}
              >
                <TextAa weight="duotone" />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto flex-none text-muted-foreground hover:text-destructive"
              disabled={!monitorIDs.length}
              title={t('serviceManagerTool.clearLogs')}
              aria-label={t('serviceManagerTool.clearLogs')}
              onClick={() => setConfirmingClear(true)}
            >
              <Eraser weight="duotone" />
            </Button>
          </div>
          {truncated ? (
            <p className="mt-2 text-xs text-amber-600">{t('serviceManagerTool.logsTruncated')}</p>
          ) : null}
        </div>
        <LogList
          key={monitorIDs.join(',') || 'none'}
          lines={lines.filter((line) => monitorIDs.includes(line.monitorID))}
        />
      </div>
      <ConfirmDialog
        open={confirmingClear}
        onOpenChange={setConfirmingClear}
        title={t('serviceManagerTool.clearLogsTitle')}
        description={t('serviceManagerTool.clearLogsConfirm')}
        confirmLabel={t('serviceManagerTool.clearLogs')}
        destructive
        onConfirm={() => {
          if (monitorIDs.length) void onClear();
          setConfirmingClear(false);
        }}
      />
      <ResourceInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        targetID={targetID}
        resource={resource}
      />
    </>
  );
}
function ResourceInfoDialog({
  open,
  onOpenChange,
  targetID,
  resource,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetID: string;
  resource: ServiceResourceRef;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setDetail(null);
    setError('');
    try {
      const value =
        resource.runtime === 'docker'
          ? await GetDockerContainerDetail(targetID, resource.id)
          : resource.runtime === 'pm2'
            ? await GetPM2ProcessDetail(targetID, resource.id)
            : await GetSystemdUnitDetail(targetID, resource.id, resource.scope ?? 'system');
      setDetail(value as unknown as Record<string, unknown>);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setLoading(true);
      setDetail(null);
      setError('');
      return;
    }
    void load();
  }, [open, targetID, resource.runtime, resource.id, resource.scope]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[75dvh] min-h-0 flex-col sm:max-w-lg">
        <DialogHeader className="flex-none">
          <DialogTitle>{resource.name || resource.id}</DialogTitle>
          <DialogDescription>{t('serviceManagerTool.info')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-muted/20 p-3">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              {t('common.loading')}
            </div>
          ) : error ? (
            <p className="m-0 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : (
            <pre className="m-0 font-mono text-[11px] break-all whitespace-pre-wrap text-foreground">
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </ScrollArea>
        <DialogFooter className="flex-none">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button disabled={loading} onClick={() => void load()}>
            {loading ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowsClockwise data-icon="inline-start" />
            )}
            {t('serviceManagerTool.refresh')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
const LOG_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,5fr)] items-start gap-3 px-3';
// 单元格内容超出宽度时，纵向滚轮转为横向滚动；未溢出时让事件冒泡给列表。
function WheelText({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const { deltaX, deltaY, deltaMode } = event;
      if (event.ctrlKey || (deltaX === 0 && deltaY === 0)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? el.clientWidth : 1;
      const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      el.scrollLeft += delta * scale;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <span ref={ref} className={`no-scrollbar block overflow-x-auto whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}
function LogList({ lines }: { lines: ServiceLogLine[] }) {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [activeDay, setActiveDay] = useState('');
  const dayKeys = useMemo(() => lines.map(logDayKey), [lines]);
  const multiDay = useMemo(() => dayKeys.some((key) => key !== dayKeys[0]), [dayKeys]);
  const showDate = multiDay || (dayKeys.length > 0 && dayKeys[0] !== dayKeyOf(new Date()));
  const dayKeysRef = useRef(dayKeys);
  const showDateRef = useRef(showDate);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport,
    estimateSize: () => 24,
    overscan: 20,
  });
  useEffect(() => {
    if (!viewport) return;
    const update = () => {
      const next = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 8;
      stickToBottom.current = next;
      setAtBottom(next);
      if (!showDateRef.current) {
        setActiveDay('');
        return;
      }
      const keys = dayKeysRef.current;
      const cache = virtualizer.measurementsCache;
      let lo = 0;
      let hi = cache.length - 1;
      let index = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cache[mid].start <= viewport.scrollTop) {
          index = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const day = keys[index] ?? '';
      setActiveDay((current) => (current === day ? current : day));
    };
    update();
    viewport.addEventListener('scroll', update, { passive: true });
    return () => viewport.removeEventListener('scroll', update);
  }, [viewport, virtualizer]);
  useEffect(() => {
    dayKeysRef.current = dayKeys;
    showDateRef.current = showDate;
    if (!showDate) setActiveDay('');
  }, [dayKeys, showDate]);
  const scrollToBottom = () => {
    stickToBottom.current = true;
    setAtBottom(true);
    if (!viewport) return;
    if (lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
  };
  const lastSequence = lines.length ? lines[lines.length - 1].sequence : 0;
  useEffect(() => {
    if (!viewport || !stickToBottom.current || lines.length === 0) return;
    virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    // 动态行高在测量后总高度还会增长，连续几帧贴底以跟上测量结果。
    let cancelled = false;
    let frame = 0;
    let raf = 0;
    const pin = () => {
      if (cancelled) return;
      viewport.scrollTop = viewport.scrollHeight;
      if (frame++ < 2) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [lastSequence, lines.length, viewport, virtualizer]);
  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div
        className={`${LOG_GRID} border-b py-1 text-[10px] font-medium tracking-[.04em] text-muted-foreground uppercase`}
      >
        <span>{t('serviceManagerTool.logTime')}</span>
        <span>{t('serviceManagerTool.logService')}</span>
        <span>{t('serviceManagerTool.logContent')}</span>
      </div>
      <div className="relative min-h-0">
        <ScrollArea
          className="h-full min-h-0 font-mono text-xs [padding-inline-end:var(--overlay-scrollbar-size)]"
          options={{ overflow: { x: 'hidden' } }}
          onViewport={setViewport}
        >
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const line = lines[row.index];
              return (
                <div
                  key={line.sequence}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  className={`absolute left-0 w-full border-b py-1 ${LOG_GRID}`}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <WheelText className="text-muted-foreground">{logTime(line)}</WheelText>
                  <WheelText className="text-primary">{line.name}</WheelText>
                  <span className="break-all whitespace-pre-wrap">{line.text}</span>
                </div>
              );
            })}
          </div>
        </ScrollArea>
        {showDate && activeDay ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-0.5">
            <span className="inline-block rounded bg-popover/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground ring-1 ring-border">
              {activeDay}
            </span>
          </div>
        ) : null}
        {!atBottom && lines.length ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="absolute right-3 bottom-3 z-10 rounded-full bg-card shadow-md hover:bg-muted dark:bg-card dark:hover:bg-muted"
            title={t('serviceManagerTool.scrollToBottom')}
            aria-label={t('serviceManagerTool.scrollToBottom')}
            onClick={scrollToBottom}
          >
            <CaretDown weight="duotone" />
          </Button>
        ) : null}
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
