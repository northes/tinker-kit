import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Events } from '@wailsio/runtime';
import {
  ArrowsClockwise,
  ArrowCounterClockwise,
  Asterisk,
  CaretDown,
  CodeSimple,
  Copy,
  Eraser,
  GearSix,
  ListBullets,
  Pause,
  Play,
  Power,
  Queue,
  Plus,
  TextAa,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { ansiPlainText, parseAnsi, type AnsiSpan } from '../lib/ansi';
import {
  ClearLogBuffer,
  GetDockerContainerDetail,
  GetDockerContainerSize,
  GetLogMonitors,
  GetPM2ProcessDetail,
  GetServiceInventory,
  GetSystemdUnitDetail,
  GetServiceTargets,
  PerformServiceAction,
  QueryLogBuffer,
  RemoveLogMonitor,
  SaveServiceTargets,
  StartLogMonitors,
} from '../../bindings/changeme/servicemanagerservice';
import type {
  DockerComposeGroup,
  DockerContainer,
  DockerContainerDetail,
  DockerContainerSize,
  LogMonitor,
  PM2ProcessDetail,
  ServiceActionRequest,
  ServiceInventory,
  ServiceLogLine,
  ServiceResourceRef,
  ServiceTarget,
  SystemdUnit,
  SystemdUnitDetail,
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { ScrollArea } from './ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
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
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover';
import { toast } from './ui/toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { TargetHostManagerDialog } from './TargetHostManagerDialog';
import { backendErrorKey, formatBackendError } from '../lib/backend-error';
import { formatBytes } from './ServiceMetricChart';
import { ServiceResourcePerformance } from './ServiceResourcePerformance';
import { ServiceWorkspacePerformance } from './ServiceWorkspacePerformance';

const MANAGE_TARGETS_VALUE = '__manage-targets__';
const WORKSPACE_TARGET_VALUE = '__workspace-targets__';
const VISIBLE_LOG_LIMIT = 5000;
const LOG_LIMIT_ERROR_KEY = 'errors.service.logMonitorLimitReached';
const LOCAL_TARGET: ServiceTarget = { id: 'local', name: 'local', kind: 'local' };

type Runtime = 'docker' | 'pm2' | 'systemd';
type Selection = {
  targetID: string;
  resource: ServiceResourceRef;
  kind: 'container' | 'group' | 'pm2' | 'systemd' | 'host' | 'workspace';
};
// 工作台成员：用户显式加入的容器或服务，与自动采集的日志监控相互独立。
type WorkspaceMember = { targetID: string; resource: ServiceResourceRef };
const WORKSPACE_SELECTION: Selection = {
  targetID: '',
  resource: { runtime: 'workspace', id: 'workspace' },
  kind: 'workspace',
};
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
function workspaceMemberKey(member: WorkspaceMember) {
  return `${member.targetID}|${resourceKey(member.resource)}`;
}
function monitorResourceKey(monitor: LogMonitor) {
  return resourceKey(monitor.resource);
}
// Compose 组对应的容器列表。
function composeGroupContainers(resource: ServiceResourceRef, inventory: ServiceInventory | null) {
  return inventory?.dockerGroups?.find((item) => item.id === resource.id)?.containers ?? [];
}
// 容器所属 Compose 组的名称；非 Compose 容器返回空串。
function dockerGroupName(resource: ServiceResourceRef, inventory: ServiceInventory | null) {
  return (
    inventory?.dockerGroups?.find((item) =>
      (item.containers ?? []).some((container) => container.id === resource.id),
    )?.name ?? ''
  );
}
// 把容器列表转换为日志监控使用的资源引用。
function containerRefs(containers: DockerContainer[], groupName: string): ServiceResourceRef[] {
  return containers.map((container) => ({
    runtime: 'docker',
    id: container.id,
    name: container.name,
    group: groupName,
  }));
}
// 把一个列表项（可能是 Compose 组）解析为具体的资源引用。
function resourceRefsFor(
  resource: ServiceResourceRef,
  inventory: ServiceInventory | null,
): ServiceResourceRef[] {
  if (resource.runtime === 'docker-compose')
    return containerRefs(composeGroupContainers(resource, inventory), resource.name ?? '');
  if (resource.runtime === 'docker')
    return [{ ...resource, group: dockerGroupName(resource, inventory) }];
  return [resource];
}
// 后端因并发日志源达到上限而拒绝启动监控。
function isLogLimitFailure(monitor: LogMonitor) {
  return monitor.state === 'failed' && backendErrorKey(monitor.error) === LOG_LIMIT_ERROR_KEY;
}
function statusVariant(value: string) {
  return /running|active|online/i.test(value)
    ? 'success'
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
  const [detailRefreshVersion, setDetailRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState('');
  const [monitors, setMonitors] = useState<LogMonitor[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [view, setView] = useState<'resource' | 'workspace'>('resource');
  const [detailTab, setDetailTab] = useState('info');
  const [panelOrientation, setPanelOrientation] = useState<'horizontal' | 'vertical'>(() =>
    window.matchMedia('(max-width: 800px)').matches ? 'vertical' : 'horizontal',
  );
  const [workspaceInventories, setWorkspaceInventories] = useState<
    Record<string, ServiceInventory>
  >({});
  const [workspaceErrors, setWorkspaceErrors] = useState<Record<string, string>>({});
  const [pendingWorkspaceRemove, setPendingWorkspaceRemove] = useState<{
    members: WorkspaceMember[];
    name: string;
    all: boolean;
  } | null>(null);
  const [workspaceRemoving, setWorkspaceRemoving] = useState(false);
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
    targetID: string;
  } | null>(null);
  const [updateDialog, setUpdateDialog] = useState<{
    resource: ServiceResourceRef;
    targetID: string;
  } | null>(null);
  const [monitorDialog, setMonitorDialog] = useState<{
    resource: ServiceResourceRef;
    targetID: string;
    containers: DockerContainer[];
  } | null>(null);
  const [monitorSelection, setMonitorSelection] = useState<Set<string>>(new Set());
  const monitorLoadVersion = useRef(0);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const update = () => setPanelOrientation(media.matches ? 'vertical' : 'horizontal');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  // 记录资源视图的目标主机；工作台内的主机筛选不影响它，返回时按此恢复。
  const resourceTargetRef = useRef(targetID);
  useEffect(() => {
    if (view === 'resource') resourceTargetRef.current = targetID;
  }, [view, targetID]);
  // 浏览位置与监控会话独立；移除当前浏览的主机时返回本机。
  const syncTargets = (next: ServiceTarget[]) => {
    setTargets(next);
    if (next.some((item) => item.id === targetIDRef.current)) return;
    setSelection(null);
    setInventory(null);
    setTargetID('local');
  };

  const load = async (nextTarget = targetID, refreshDetails = false) => {
    setLoading(true);
    try {
      const next = await GetServiceInventory(nextTarget);
      if (targetIDRef.current !== nextTarget) return;
      setInventory(next);
      if (refreshDetails) setDetailRefreshVersion((value) => value + 1);
    } catch (error) {
      if (targetIDRef.current !== nextTarget) return;
      toast.add({
        title: t('serviceManagerTool.refreshFailed'),
        description: formatBackendError(error),
        type: 'error',
      });
    } finally {
      if (targetIDRef.current === nextTarget) setLoading(false);
    }
  };
  const loadMonitors = async () => {
    const version = ++monitorLoadVersion.current;
    const items = (await GetLogMonitors('')) ?? [];
    if (version === monitorLoadVersion.current) setMonitors(items);
  };

  const selectedTargetID =
    view === 'workspace' && selection?.kind !== 'workspace'
      ? (selection?.targetID ?? targetID)
      : targetID;
  const selectedInventory =
    selectedTargetID === targetID ? inventory : workspaceInventories[selectedTargetID];
  const currentTargetMonitors = useMemo(
    () => monitors.filter((item) => item.targetID === selectedTargetID),
    [monitors, selectedTargetID],
  );
  const monitoredByResource = useMemo(
    () => new Map(monitors.map((item) => [`${item.targetID}|${monitorResourceKey(item)}`, item])),
    [monitors],
  );
  const workspaceMemberKeys = useMemo(
    () => new Set(workspaceMembers.map(workspaceMemberKey)),
    [workspaceMembers],
  );
  const workspaceTargetIDs = useMemo(
    () => [...new Set(workspaceMembers.map((member) => member.targetID))],
    [workspaceMembers],
  );
  // 仅工作台成员的日志监控；自动采集但未加入工作台的资源不在其中。
  const memberMonitors = useMemo(
    () =>
      monitors.filter((item) =>
        workspaceMemberKeys.has(`${item.targetID}|${resourceKey(item.resource)}`),
      ),
    [monitors, workspaceMemberKeys],
  );
  // Compose 组选中时聚合其所有容器的监控；单资源沿用资源键匹配。
  const selectedMonitors = useMemo(() => {
    if (!selection) return [] as LogMonitor[];
    if (view === 'workspace' && selection.kind === 'workspace') return memberMonitors;
    if (view === 'workspace' && selection.kind === 'host')
      return memberMonitors.filter((item) => item.targetID === selection.targetID);
    if (selection.kind === 'group') {
      const group = selectedInventory?.dockerGroups?.find(
        (item) => item.id === selection.resource.id,
      );
      const ids = new Set((group?.containers ?? []).map((item) => item.id));
      return currentTargetMonitors.filter(
        (item) => item.resource.runtime === 'docker' && ids.has(item.resource.id),
      );
    }
    const found = monitoredByResource.get(
      `${selection.targetID}|${resourceKey(selection.resource)}`,
    );
    return found ? [found] : [];
  }, [
    view,
    selection,
    monitors,
    selectedInventory,
    currentTargetMonitors,
    monitoredByResource,
    memberMonitors,
  ]);
  const activeMonitorIDs = useMemo(
    () => selectedMonitors.map((item) => item.id),
    [selectedMonitors],
  );
  const activeMonitorKey = activeMonitorIDs.join(',');
  // 选中 Compose 组时，信息页展示组内容器列表。
  const selectedGroupContainers = useMemo(() => {
    if (!selection || selection.kind !== 'group') return [] as DockerContainer[];
    const group = selectedInventory?.dockerGroups?.find(
      (item) => item.id === selection.resource.id,
    );
    return group?.containers ?? [];
  }, [selection, selectedInventory]);

  useEffect(() => {
    void GetServiceTargets()
      .then((items) => syncTargets(items ?? []))
      .catch(() => setTargets([]));
  }, [profiles]);
  useEffect(() => {
    void load(targetID);
    void loadMonitors();
  }, [targetID]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [active, targetID]);
  useEffect(() => {
    if (view !== 'workspace') return;
    const hostIDs = workspaceTargetIDs;
    if (!hostIDs.length) return;
    let cancelled = false;
    const refresh = async () => {
      const results = await Promise.allSettled(hostIDs.map((id) => GetServiceInventory(id)));
      if (cancelled) return;
      setWorkspaceInventories((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') next[hostIDs[index]] = result.value;
        });
        return next;
      });
      setWorkspaceErrors((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          if (result.status === 'rejected')
            next[hostIDs[index]] = formatBackendError(result.reason);
          else delete next[hostIDs[index]];
        });
        return next;
      });
    };
    void refresh();
    if (!active)
      return () => {
        cancelled = true;
      };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [view, active, workspaceTargetIDs.join('|')]);
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
        return [...current, ...accepted.filter((line) => !ids.has(line.sequence))]
          .sort((a, b) => a.sequence - b.sequence)
          .slice(-VISIBLE_LOG_LIMIT);
      });
    });
    const offState = Events.On('service-manager:log-state', () => void loadMonitors());
    return () => {
      off();
      offState();
    };
  }, [activeMonitorKey, logQuery, regex, caseSensitive, targetID]);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeMonitorIDs.length) {
        setLines([]);
        setTruncated(false);
        return;
      }
      try {
        const snapshot = await QueryLogBuffer({
          monitorIDs: activeMonitorIDs,
          filter: { query: logQuery, regex, caseSensitive, streams: [] },
          limit: VISIBLE_LOG_LIMIT,
        });
        if (!cancelled) {
          setLines((current) =>
            [
              ...(snapshot.lines ?? []),
              ...current.filter(
                (line) =>
                  line.sequence > snapshot.maxSequence &&
                  activeMonitorIDs.includes(line.monitorID) &&
                  matchesLog(line, logQuery, regex, caseSensitive),
              ),
            ]
              .sort((a, b) => a.sequence - b.sequence)
              .slice(-VISIBLE_LOG_LIMIT),
          );
          setTruncated(snapshot.truncated);
        }
      } catch (error) {
        if (cancelled) return;
        toast.add({
          title: t('serviceManagerTool.filterFailed'),
          description: formatBackendError(error),
          type: 'error',
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeMonitorKey, logQuery, regex, caseSensitive]);

  const selectedTarget = targets.find((target) => target.id === selectedTargetID);

  const selectTarget = (next: string | null) => {
    if (!next || next === targetID) return;
    setSelection(null);
    setInventory(null);
    setTargetID(next);
  };
  const openWorkspace = () => {
    resourceTargetRef.current = targetID;
    setView('workspace');
    setSelection(WORKSPACE_SELECTION);
  };
  const showResources = () => {
    setView('resource');
    // 工作台内可能切换过浏览主机，返回资源视图时恢复进入前的目标主机。
    if (targetID !== resourceTargetRef.current) {
      setSelection(null);
      setInventory(null);
      setTargetID(resourceTargetRef.current);
      return;
    }
    if (
      selection?.kind === 'workspace' ||
      selection?.kind === 'host' ||
      selection?.targetID !== targetID
    ) {
      setSelection(null);
    }
  };
  const act = (target: string, resource: ServiceResourceRef, action: string) => {
    if (action === 'update') {
      setUpdateDialog({ resource, targetID: target });
      return;
    }
    if (action === 'delete' || action.startsWith('disable')) {
      setPendingAction({ resource, action, targetID: target });
      return;
    }
    void performAction(target, resource, action);
  };
  const confirmPendingAction = async () => {
    const pending = pendingAction;
    if (!pending) return;
    await performAction(pending.targetID, pending.resource, pending.action);
    setPendingAction(null);
  };
  const performAction = async (target: string, resource: ServiceResourceRef, action: string) => {
    const key = `${target}|${resourceKey(resource)}:${action}`;
    setBusy(key);
    try {
      const result = await PerformServiceAction({
        targetID: target,
        resource,
        action,
      } as ServiceActionRequest);
      const failed = result.failed ?? [];
      const succeeded = result.succeeded ?? [];
      if (succeeded.length)
        record(
          'service-manager',
          action,
          `${targets.find((item) => item.id === target)?.name ?? target} · ${resource.name || resource.id}`,
          '',
          failed.map((item) => formatBackendError(item.error)).join('\n'),
        );
      if (failed.length)
        toast.add({
          title: t('serviceManagerTool.actionFailed'),
          description: failed.map((item) => formatBackendError(item.error)).join('；'),
          type: 'error',
        });
      else toast.add({ title: t('serviceManagerTool.actionSucceeded'), type: 'success' });
      if (target === targetID) await load(target, view !== 'workspace');
      if (view === 'workspace') {
        const updated = await GetServiceInventory(target);
        setWorkspaceInventories((current) => ({ ...current, [target]: updated }));
        setDetailRefreshVersion((value) => value + 1);
      }
    } catch (error) {
      toast.add({
        title: t('serviceManagerTool.actionFailed'),
        description: formatBackendError(error),
        type: 'error',
      });
    } finally {
      setBusy('');
    }
  };
  const startMonitors = async (
    target: string,
    resources: ServiceResourceRef[],
    notify = true,
  ): Promise<LogMonitor[]> => {
    if (!resources.length) {
      if (notify) toast.add({ title: t('serviceManagerTool.monitorFailed'), type: 'error' });
      return [];
    }
    try {
      const created = (await StartLogMonitors({ targetID: target, resources })) ?? [];
      const failed = created.filter((item) => item.state === 'failed');
      if (notify && failed.length)
        toast.add({
          title: t('serviceManagerTool.monitorFailed'),
          description: failed.map((item) => formatBackendError(item.error)).join('\n'),
          type: 'error',
        });
      ++monitorLoadVersion.current;
      setMonitors((current) => {
        const all = new Map(current.map((item) => [item.id, item]));
        created.filter((item) => item.state !== 'failed').forEach((item) => all.set(item.id, item));
        return [...all.values()];
      });
      return created;
    } catch (error) {
      if (notify)
        toast.add({
          title: t('serviceManagerTool.monitorFailed'),
          description: formatBackendError(error),
          type: 'error',
        });
      return [];
    }
  };
  const toggleMonitorContainer = (id: string, checked: boolean) =>
    setMonitorSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  // 加入工作台只更新成员集合；日志监控由成员同步 effect 启动，已存在的直接复用。
  const addWorkspaceMembers = (members: WorkspaceMember[]) => {
    setWorkspaceMembers((current) => {
      const all = new Map(current.map((member) => [workspaceMemberKey(member), member]));
      members.forEach((member) => all.set(workspaceMemberKey(member), member));
      return [...all.values()];
    });
  };
  const confirmMonitorSelection = () => {
    const dialog = monitorDialog;
    if (!dialog) return;
    const refs = dialog.containers
      .filter((item) => monitorSelection.has(item.id))
      .map(
        (item) =>
          ({
            runtime: 'docker',
            id: item.id,
            name: item.name,
            group: dialog.resource.name,
          }) as ServiceResourceRef,
      );
    setMonitorDialog(null);
    addWorkspaceMembers(refs.map((resource) => ({ targetID: dialog.targetID, resource })));
  };
  // 自动启动所选资源/Compose 组的日志监控并保留在后台；达到并发上限时淘汰最久未查看的一路后重试。
  const autoMonitorsRef = useRef(new Map<string, number>());
  const autoSequenceRef = useRef(0);
  // 达到并发上限时，淘汰最久未查看、且不属于工作台的自动采集监控，为新的监控让位。
  const evictAutoMonitor = async (exclude: Set<string>) => {
    const tracked = autoMonitorsRef.current;
    const oldest = [...tracked.keys()].find((id) => {
      const item = monitors.find((candidate) => candidate.id === id);
      if (!item) return false;
      const key = `${item.targetID}|${resourceKey(item.resource)}`;
      return (
        !exclude.has(key) &&
        !workspaceMemberKeys.has(key) &&
        (item.state === 'monitoring' || item.state === 'stopping')
      );
    });
    if (!oldest) return false;
    tracked.delete(oldest);
    await RemoveLogMonitor(oldest).catch(() => undefined);
    return true;
  };
  const ensureSelectionMonitors = async (sel: Selection) => {
    const sourceInventory =
      sel.targetID === targetID ? inventory : workspaceInventories[sel.targetID];
    const resources = resourceRefsFor(sel.resource, sourceInventory);
    if (!resources.length) return;
    const sequence = ++autoSequenceRef.current;
    const tracked = autoMonitorsRef.current;
    const monitorOf = (resource: ServiceResourceRef) =>
      monitoredByResource.get(`${sel.targetID}|${resourceKey(resource)}`);
    resources.forEach((resource) => {
      const existing = monitorOf(resource);
      // 浏览过的资源记为自动采集，可在达到并发上限时淘汰；工作台成员另行保护。
      if (!existing) return;
      tracked.delete(existing.id);
      tracked.set(existing.id, sequence);
    });
    const missing = resources.filter((resource) => monitorOf(resource)?.state !== 'monitoring');
    if (!missing.length) return;
    let created = await startMonitors(sel.targetID, missing, false);
    if (created.some(isLogLimitFailure)) {
      const currentKeys = new Set(
        resources.map((resource) => `${sel.targetID}|${resourceKey(resource)}`),
      );
      if (await evictAutoMonitor(currentKeys))
        created = await startMonitors(sel.targetID, missing, false);
    }
    created
      .filter((item) => item.state !== 'failed')
      .forEach((item) => {
        tracked.delete(item.id);
        tracked.set(item.id, sequence);
      });
    const failed = created.filter((item) => item.state === 'failed');
    if (failed.length)
      toast.add({
        title: t('serviceManagerTool.monitorFailed'),
        description: failed.map((item) => formatBackendError(item.error)).join('\n'),
        type: 'error',
      });
  };
  // 浏览资源时自动开始采集日志，无需手动启动；选择变化即触发一次，不随监控列表刷新重复触发。
  useEffect(() => {
    if (!active || view !== 'resource' || !selection) return;
    if (selection.kind === 'workspace' || selection.kind === 'host') return;
    void ensureSelectionMonitors(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, view, selection]);
  // 工作台成员始终保留日志监控；与浏览自动采集复用同一路监控。
  useEffect(() => {
    if (!active) return;
    const byTarget = new Map<string, ServiceResourceRef[]>();
    workspaceMembers.forEach((member) => {
      const list = byTarget.get(member.targetID) ?? [];
      list.push(member.resource);
      byTarget.set(member.targetID, list);
    });
    void (async () => {
      for (const [target, resources] of byTarget) {
        const memberKeys = new Set(
          resources.map((resource) => `${target}|${resourceKey(resource)}`),
        );
        let created = await startMonitors(target, resources, false);
        if (created.some(isLogLimitFailure) && (await evictAutoMonitor(memberKeys)))
          created = await startMonitors(target, resources, false);
        const failed = created.filter((item) => item.state === 'failed');
        if (failed.length)
          toast.add({
            title: t('serviceManagerTool.monitorFailed'),
            description: failed.map((item) => formatBackendError(item.error)).join('\n'),
            type: 'error',
          });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceMembers]);
  const clear = async () => {
    await Promise.all(activeMonitorIDs.map((id) => ClearLogBuffer(id).catch(() => undefined)));
    setLines([]);
    setTruncated(false);
    await loadMonitors();
  };
  const changeWorkspace = (target: string, resource: ServiceResourceRef) => {
    const sourceInventory = target === targetID ? inventory : workspaceInventories[target];
    const refs = resourceRefsFor(resource, sourceInventory);
    const keys = new Set(refs.map((ref) => `${target}|${resourceKey(ref)}`));
    const existing = workspaceMembers.filter((member) => keys.has(workspaceMemberKey(member)));
    if (existing.length) {
      setPendingWorkspaceRemove({
        members: existing,
        name: resource.name || resource.id,
        all: false,
      });
      return;
    }
    // Compose 组多容器时先让用户选择要加入的容器，默认全选。
    if (resource.runtime === 'docker-compose' && refs.length > 1) {
      setMonitorSelection(new Set(refs.map((ref) => ref.id)));
      setMonitorDialog({
        resource,
        targetID: target,
        containers: composeGroupContainers(resource, sourceInventory),
      });
      return;
    }
    addWorkspaceMembers(refs.map((ref) => ({ targetID: target, resource: ref })));
  };
  const confirmWorkspaceRemove = async () => {
    if (!pendingWorkspaceRemove || workspaceRemoving) return;
    setWorkspaceRemoving(true);
    const removed = pendingWorkspaceRemove.members;
    const removedKeys = new Set(removed.map(workspaceMemberKey));
    try {
      // 仅停止不再被自动采集复用的日志监控；浏览中的监控保留。
      const results = await Promise.allSettled(
        removed.map(async (member) => {
          const monitor = monitoredByResource.get(
            `${member.targetID}|${resourceKey(member.resource)}`,
          );
          if (!monitor || autoMonitorsRef.current.has(monitor.id)) return;
          await RemoveLogMonitor(monitor.id);
        }),
      );
      ++monitorLoadVersion.current;
      setWorkspaceMembers((current) =>
        current.filter((member) => !removedKeys.has(workspaceMemberKey(member))),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected')
        toast.add({
          title: t('serviceManagerTool.workspaceRemoveFailed'),
          description: formatBackendError(failed.reason),
          type: 'error',
        });
      if (view === 'workspace') {
        if (workspaceMembers.every((member) => removedKeys.has(workspaceMemberKey(member))))
          showResources();
        else if (
          selection?.kind !== 'workspace' &&
          selectedMonitors.length > 0 &&
          selectedMonitors.every((monitor) =>
            removedKeys.has(`${monitor.targetID}|${resourceKey(monitor.resource)}`),
          )
        ) {
          setSelection(WORKSPACE_SELECTION);
        }
      }
      setPendingWorkspaceRemove(null);
    } finally {
      setWorkspaceRemoving(false);
    }
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
      setTargetSaveError(formatBackendError(error) || t('serviceManagerTool.targetSaveFailed'));
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
                  disabled={view === 'workspace'}
                  items={[
                    ...(view === 'workspace' && selection?.kind === 'workspace'
                      ? [
                          {
                            value: WORKSPACE_TARGET_VALUE,
                            label: t('serviceManagerTool.allTargets'),
                          },
                        ]
                      : []),
                    ...targets.map((item) => ({ value: item.id, label: targetLabel(item, t) })),
                  ]}
                  value={
                    view === 'workspace' && selection?.kind === 'workspace'
                      ? WORKSPACE_TARGET_VALUE
                      : selectedTargetID
                  }
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
                      {view === 'workspace' && selection?.kind === 'workspace' ? (
                        <SelectItem value={WORKSPACE_TARGET_VALUE}>
                          {t('serviceManagerTool.allTargets')}
                        </SelectItem>
                      ) : null}
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
            <div className="flex items-center gap-2">
              <Button
                variant={view === 'resource' ? 'secondary' : 'outline'}
                size="sm"
                onClick={showResources}
              >
                <ListBullets weight="duotone" />
                {t('serviceManagerTool.resources')}
              </Button>
              <Button
                variant={view === 'workspace' ? 'secondary' : 'outline'}
                size="sm"
                onClick={openWorkspace}
              >
                <Queue weight="duotone" />
                {t('serviceManagerTool.workspace')}
                <Badge variant={workspaceMembers.length > 0 ? 'warning' : 'secondary'}>
                  {workspaceMembers.length}
                </Badge>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void (
                    view === 'workspace'
                      ? Promise.allSettled(
                          workspaceTargetIDs.map(async (id) => {
                            try {
                              const next = await GetServiceInventory(id);
                              setWorkspaceInventories((current) => ({ ...current, [id]: next }));
                              setWorkspaceErrors((current) => {
                                const nextErrors = { ...current };
                                delete nextErrors[id];
                                return nextErrors;
                              });
                            } catch (error) {
                              setWorkspaceErrors((current) => ({
                                ...current,
                                [id]: formatBackendError(error),
                              }));
                            }
                          }),
                        )
                      : load(targetID, true)
                  ).then(() => {
                    if (view === 'workspace') setDetailRefreshVersion((value) => value + 1);
                  })
                }
                disabled={loading}
              >
                {loading ? <Spinner className="size-3.5" /> : <ArrowsClockwise weight="duotone" />}
                {t('serviceManagerTool.refresh')}
              </Button>
            </div>
          }
        />
        <ToolLayoutContent className="relative min-h-0 border-t">
          <ResizablePanelGroup orientation={panelOrientation} className="min-h-0 min-w-0">
            <ResizablePanel
              id="resources"
              defaultSize={panelOrientation === 'horizontal' ? '38%' : '42%'}
              minSize={panelOrientation === 'horizontal' ? 230 : '20%'}
              collapsible
              collapsedSize={0}
              className="min-h-0 min-w-0"
            >
              {view === 'workspace' ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex h-11 flex-none items-center justify-between gap-2 border-b px-3 has-[>[data-workspace-select]:hover]:bg-muted/50">
                    <button
                      type="button"
                      data-workspace-select
                      aria-pressed={selection?.kind === 'workspace'}
                      className={`-ml-3 flex h-11 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selection?.kind === 'workspace' ? 'bg-muted' : ''}`}
                      onClick={() => setSelection(WORKSPACE_SELECTION)}
                    >
                      <span className="font-semibold">{t('serviceManagerTool.workspace')}</span>
                      <span className="truncate text-muted-foreground">
                        {t('serviceManagerTool.workspaceMembers', {
                          total: workspaceMembers.length,
                        })}
                      </span>
                    </button>
                    {workspaceMembers.length ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mr-3 h-11 rounded-none px-3"
                        onClick={() => {
                          setPendingWorkspaceRemove({
                            members: [...workspaceMembers],
                            name: '',
                            all: true,
                          });
                        }}
                      >
                        <Trash weight="duotone" />
                        {t('serviceManagerTool.removeAllFromWorkspace')}
                      </Button>
                    ) : null}
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    {workspaceMembers.length ? (
                      workspaceTargetIDs.map((hostID) => (
                        <div key={hostID}>
                          <button
                            type="button"
                            aria-pressed={
                              selection?.kind === 'host' && selection.targetID === hostID
                            }
                            className={`flex h-11 w-full min-w-0 items-center border-b px-3 text-left text-xs font-semibold hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selection?.kind === 'host' && selection.targetID === hostID ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                            onClick={() => {
                              const host = targets.find((item) => item.id === hostID);
                              setSelection({
                                targetID: hostID,
                                resource: {
                                  runtime: 'host',
                                  id: hostID,
                                  name: host
                                    ? targetLabel(host, t)
                                    : t('serviceManagerTool.targetUnavailable'),
                                },
                                kind: 'host',
                              });
                            }}
                          >
                            <span className="truncate">
                              {targets.find((item) => item.id === hostID)
                                ? targetLabel(
                                    targets.find((item) => item.id === hostID)!,
                                    t,
                                  )
                                : t('serviceManagerTool.targetUnavailable')}
                            </span>
                          </button>
                          {workspaceErrors[hostID] ? (
                            <RuntimeError
                              name={t('serviceManagerTool.target')}
                              error={workspaceErrors[hostID]}
                            />
                          ) : null}
                          <ResourceList
                            targetID={hostID}
                            inventory={
                              workspaceErrors[hostID]
                                ? null
                                : (workspaceInventories[hostID] ?? null)
                            }
                            workspaceResources={workspaceMembers
                              .filter((member) => member.targetID === hostID)
                              .map((member) => member.resource)}
                            allowed={
                              new Set(
                                workspaceMembers
                                  .filter((member) => member.targetID === hostID)
                                  .map((member) => resourceKey(member.resource)),
                              )
                            }
                            embedded
                            statuses={statusFilter}
                            search={search}
                            selection={selection}
                            onSelect={(next) => {
                              setSelection(next);
                            }}
                            workspaceKeys={workspaceMemberKeys}
                            onAction={act}
                            onWorkspaceChange={changeWorkspace}
                            busy={busy}
                            t={t}
                          />
                        </div>
                      ))
                    ) : (
                      <p className="px-4 py-5 text-center text-xs text-muted-foreground">
                        {t('serviceManagerTool.workspaceEmpty')}
                      </p>
                    )}
                  </ScrollArea>
                </div>
              ) : (
                <ResourceList
                  targetID={targetID}
                  inventory={inventory}
                  statuses={statusFilter}
                  search={search}
                  selection={selection}
                  onSelect={(next) => {
                    setSelection(next);
                  }}
                  workspaceKeys={workspaceMemberKeys}
                  onAction={act}
                  onWorkspaceChange={changeWorkspace}
                  busy={busy}
                  t={t}
                />
              )}
            </ResizablePanel>
            <ResizableHandle withHandle aria-label={t('serviceManagerTool.resizeMainPanels')} />
            <ResizablePanel
              id="details"
              minSize={panelOrientation === 'horizontal' ? 300 : '30%'}
              className="min-h-0 min-w-0"
            >
              <section className="h-full min-h-0 overflow-hidden">
                {selection &&
                (view === 'resource' ||
                  selection.kind === 'workspace' ||
                  selectedMonitors.length > 0) ? (
                  <ResourcePanel
                    selection={selection}
                    targetID={selectedTargetID}
                    metricsActive={active}
                    groupContainers={selectedGroupContainers}
                    refreshToken={detailRefreshVersion}
                    tab={detailTab}
                    onTabChange={setDetailTab}
                    monitorIDs={activeMonitorIDs}
                    lines={lines}
                    truncated={truncated}
                    logDraft={logDraft}
                    setLogDraft={setLogDraft}
                    applyFilter={() => setLogQuery(logDraft)}
                    query={logQuery}
                    regex={regex}
                    setRegex={setRegex}
                    caseSensitive={caseSensitive}
                    setCaseSensitive={setCaseSensitive}
                    onClear={clear}
                    monitors={selectedMonitors}
                    targets={targets}
                    onSelectResource={(item) => {
                      setSelection({
                        targetID: item.targetID,
                        resource: item.resource,
                        kind:
                          item.resource.runtime === 'docker'
                            ? 'container'
                            : item.resource.runtime === 'pm2'
                              ? 'pm2'
                              : 'systemd',
                      });
                    }}
                    t={t}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">
                    {t('serviceManagerTool.selectHint')}
                  </div>
                )}
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
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
          busy ===
            `${pendingAction.targetID}|${resourceKey(pendingAction.resource)}:${pendingAction.action}`
        }
        onConfirm={() => void confirmPendingAction()}
      />
      <ConfirmDialog
        open={pendingWorkspaceRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingWorkspaceRemove(null);
        }}
        title={t(
          pendingWorkspaceRemove?.all
            ? 'serviceManagerTool.removeAllFromWorkspaceTitle'
            : 'serviceManagerTool.removeFromWorkspaceTitle',
        )}
        description={
          pendingWorkspaceRemove?.all
            ? t('serviceManagerTool.removeAllFromWorkspaceConfirm', {
                total: pendingWorkspaceRemove.members.length,
              })
            : t('serviceManagerTool.removeFromWorkspaceConfirm', {
                name: pendingWorkspaceRemove?.name ?? '',
              })
        }
        confirmLabel={t(
          pendingWorkspaceRemove?.all
            ? 'serviceManagerTool.removeAllFromWorkspace'
            : 'serviceManagerTool.removeFromWorkspace',
        )}
        destructive
        busy={workspaceRemoving}
        onConfirm={() => void confirmWorkspaceRemove()}
      />
      <Dialog open={updateDialog !== null} onOpenChange={(open) => !open && setUpdateDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('serviceManagerTool.updateTitle')}</DialogTitle>
            <DialogDescription>
              {t('serviceManagerTool.updateDescription', {
                name: updateDialog?.resource.name || updateDialog?.resource.id || '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              disabled={busy !== ''}
              onClick={() => {
                const pending = updateDialog;
                setUpdateDialog(null);
                if (pending) void performAction(pending.targetID, pending.resource, 'update-pull');
              }}
            >
              {t('serviceManagerTool.pullOnly')}
            </Button>
            <Button
              disabled={busy !== ''}
              onClick={() => {
                const pending = updateDialog;
                setUpdateDialog(null);
                if (pending) void performAction(pending.targetID, pending.resource, 'update-start');
              }}
            >
              {t('serviceManagerTool.pullAndStart')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
              onClick={() => confirmMonitorSelection()}
            >
              {t('serviceManagerTool.addToWorkspace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Reveal>
  );
}

function ResourceList({
  targetID,
  inventory,
  workspaceResources,
  allowed,
  embedded = false,
  statuses,
  search,
  selection,
  onSelect,
  workspaceKeys,
  onAction,
  onWorkspaceChange,
  busy,
  t,
}: {
  targetID: string;
  inventory: ServiceInventory | null;
  workspaceResources?: ServiceResourceRef[];
  allowed?: Set<string>;
  embedded?: boolean;
  statuses: Set<string>;
  search: string;
  selection: Selection | null;
  onSelect: (next: Selection) => void;
  workspaceKeys: Set<string>;
  onAction: (targetID: string, resource: ServiceResourceRef, action: string) => void;
  onWorkspaceChange: (targetID: string, resource: ServiceResourceRef) => void;
  busy: string;
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
  if (!inventory && !workspaceResources)
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-2 text-center">
          <Spinner />
          <span className="text-sm text-muted-foreground">{t('serviceManagerTool.loading')}</span>
        </div>
      </div>
    );
  const match = (name: string) => !search || name.toLowerCase().includes(search);
  const copyText = async (value: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      toast.add({ title: t('serviceManagerTool.copiedToClipboard'), type: 'success' });
    } catch {
      toast.add({ title: t('serviceManagerTool.copyFailed'), type: 'error' });
    }
  };
  const row = (
    resource: ServiceResourceRef,
    kind: Selection['kind'],
    status: string,
    description = '',
    image = '',
  ) => {
    if (allowed && !allowed.has(resourceKey(resource))) return null;
    if (!match(resource.name || resource.id)) return null;
    if (!matchesStatusFilter(statuses, resource.runtime as Runtime, status)) return null;
    const active =
      selection &&
      selection.targetID === targetID &&
      resourceKey(selection.resource) === resourceKey(resource);
    const member = workspaceKeys.has(`${targetID}|${resourceKey(resource)}`);
    const running = ['running', 'online', 'active'].includes(status.toLowerCase());
    const actions = [running ? 'stop' : 'start', 'restart'];
    if (resource.runtime === 'systemd') actions.push('disable', 'disable-now');
    else actions.push('delete');
    if (resource.runtime === 'docker' && resource.group) actions.push('update');
    return (
      <ContextMenu key={resourceKey(resource)}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              className={`flex h-11 w-full items-center gap-2 border-b px-3 text-left text-sm hover:bg-muted/50 ${active ? 'bg-muted' : ''} ${running ? '' : 'text-muted-foreground'}`}
              onClick={() => onSelect({ targetID, resource, kind })}
            />
          }
        >
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate font-medium ${running ? '' : 'text-muted-foreground'}`}
            >
              {resource.name || resource.id}
            </span>
            {description ? (
              <span className="block truncate text-xs text-muted-foreground">{description}</span>
            ) : null}
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuGroup>
            {actions.map((action) => (
              <ContextMenuItem
                key={action}
                variant={
                  action === 'delete' || action.startsWith('disable') ? 'destructive' : 'default'
                }
                disabled={busy.startsWith(`${targetID}|${resourceKey(resource)}:`)}
                onClick={() => onAction(targetID, resource, action)}
              >
                {action === 'start' ? <Play size={14} weight="duotone" /> : null}
                {action === 'stop' ? <Pause size={14} weight="duotone" /> : null}
                {action === 'restart' ? <ArrowCounterClockwise size={14} weight="duotone" /> : null}
                {action === 'delete' ? <Trash size={14} weight="duotone" /> : null}
                {action.startsWith('disable') ? <Power size={14} weight="duotone" /> : null}
                {action === 'update' ? <ArrowsClockwise size={14} weight="duotone" /> : null}
                {t(`serviceManagerTool.actions.${action}`)}
              </ContextMenuItem>
            ))}
            <ContextMenuItem
              disabled={busy.startsWith(`${targetID}|${resourceKey(resource)}:`)}
              onClick={() => onWorkspaceChange(targetID, resource)}
            >
              {member ? <Trash size={14} weight="duotone" /> : <Plus size={14} weight="duotone" />}
              {t(
                member
                  ? 'serviceManagerTool.removeFromWorkspace'
                  : 'serviceManagerTool.addToWorkspace',
              )}
            </ContextMenuItem>
          </ContextMenuGroup>
          {resource.runtime === 'docker' ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuGroup>
                <ContextMenuItem onClick={() => void copyText(resource.id)}>
                  <Copy size={14} weight="duotone" />
                  {t('serviceManagerTool.copyId')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyText(resource.name || resource.id)}>
                  <Copy size={14} weight="duotone" />
                  {t('serviceManagerTool.copyName')}
                </ContextMenuItem>
                <ContextMenuItem disabled={!image} onClick={() => void copyText(image)}>
                  <Copy size={14} weight="duotone" />
                  {t('serviceManagerTool.copyImage')}
                </ContextMenuItem>
              </ContextMenuGroup>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  const group = (item: DockerComposeGroup) => {
    const containers = item.containers ?? [];
    // 搜索时按 Compose 组名或容器名匹配，未命中的组合整体隐藏。
    const groupMatched = match(item.name || item.id);
    const visibleContainers = containers.filter(
      (container) =>
        matchesStatusFilter(statuses, 'docker', container.status) &&
        (!allowed || allowed.has(resourceKey({ runtime: 'docker', id: container.id }))) &&
        (groupMatched || match(container.name || container.id)),
    );
    if (!visibleContainers.length) return null;
    const resource = { runtime: 'docker-compose', id: item.id, name: item.name };
    const active =
      selection?.kind === 'group' &&
      selection.targetID === targetID &&
      resourceKey(selection.resource) === resourceKey(resource);
    const collapsed = collapsedGroups.has(`${targetID}|${item.id}`);
    const running = containers.some((container) => container.status.toLowerCase() === 'running');
    const groupActions = [running ? 'stop' : 'start', 'restart', 'delete', 'update'];
    return (
      <div key={item.id}>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                className={`flex h-11 cursor-pointer items-center gap-2 border-b px-3 text-xs font-semibold hover:bg-muted/50 ${active ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                onClick={() => onSelect({ targetID, resource, kind: 'group' })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSelect({ targetID, resource, kind: 'group' });
                }}
              />
            }
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
                toggleGroup(`${targetID}|${item.id}`);
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
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-44">
            <ContextMenuGroup>
              {groupActions.map((action) => (
                <ContextMenuItem
                  key={action}
                  variant={action === 'delete' ? 'destructive' : 'default'}
                  disabled={busy.startsWith(`${targetID}|${resourceKey(resource)}:`)}
                  onClick={() => onAction(targetID, resource, action)}
                >
                  {action === 'start' ? <Play size={14} weight="duotone" /> : null}
                  {action === 'stop' ? <Pause size={14} weight="duotone" /> : null}
                  {action === 'restart' ? (
                    <ArrowCounterClockwise size={14} weight="duotone" />
                  ) : null}
                  {action === 'delete' ? <Trash size={14} weight="duotone" /> : null}
                  {action === 'update' ? <ArrowsClockwise size={14} weight="duotone" /> : null}
                  {t(`serviceManagerTool.actions.${action}`)}
                </ContextMenuItem>
              ))}
              <ContextMenuItem onClick={() => onWorkspaceChange(targetID, resource)}>
                {visibleContainers.some((container) =>
                  workspaceKeys.has(
                    `${targetID}|${resourceKey({ runtime: 'docker', id: container.id })}`,
                  ),
                ) ? (
                  <Trash size={14} weight="duotone" />
                ) : (
                  <Plus size={14} weight="duotone" />
                )}
                {t(
                  visibleContainers.some((container) =>
                    workspaceKeys.has(
                      `${targetID}|${resourceKey({ runtime: 'docker', id: container.id })}`,
                    ),
                  )
                    ? 'serviceManagerTool.removeFromWorkspace'
                    : 'serviceManagerTool.addToWorkspace',
                )}
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
        {collapsed
          ? null
          : visibleContainers.map((container) =>
              row(
                {
                  runtime: 'docker',
                  id: container.id,
                  name: container.name,
                  group: container.composeProject,
                },
                'container',
                container.status,
                container.image,
                container.image,
              ),
            )}
      </div>
    );
  };
  const standaloneContainers = (inventory?.containers ?? []).filter(
    (container) =>
      matchesStatusFilter(statuses, 'docker', container.status) &&
      (!allowed || allowed.has(resourceKey({ runtime: 'docker', id: container.id }))) &&
      match(container.name || container.id),
  );
  const pm2Processes = (inventory?.pm2Processes ?? []).filter(
    (process) =>
      matchesStatusFilter(statuses, 'pm2', process.status) &&
      (!allowed || allowed.has(resourceKey({ runtime: 'pm2', id: process.id }))) &&
      match(process.name || process.id),
  );
  const systemUnits = (inventory?.systemUnits ?? []).filter(
    (unit) =>
      matchesStatusFilter(statuses, 'systemd', unit.activeState) &&
      (!allowed ||
        allowed.has(resourceKey({ runtime: 'systemd', id: unit.id, scope: unit.scope }))) &&
      match(unit.name || unit.id),
  );
  const hasWorkspaceRuntime = (runtime: Runtime) =>
    !allowed || [...allowed].some((key) => key.startsWith(`${runtime}|`));
  const content = (
    <>
      {inventory && runtimeFiltered(statuses, 'docker') ? (
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
                      container.image,
                    ),
                  )}
                </>
              ) : null}
            </>
          ) : !search && hasWorkspaceRuntime('docker') ? (
            <RuntimeError name="Docker" error={inventory.docker.error} />
          ) : null}
        </>
      ) : null}
      {inventory && runtimeFiltered(statuses, 'pm2') ? (
        <>
          {inventory.pm2.available ? (
            !search || pm2Processes.length ? (
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
            ) : null
          ) : !search && hasWorkspaceRuntime('pm2') ? (
            <RuntimeError name="PM2" error={inventory.pm2.error} />
          ) : null}
        </>
      ) : null}
      {inventory && runtimeFiltered(statuses, 'systemd') ? (
        <>
          {inventory.systemd.available ? (
            !search || systemUnits.length ? (
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
            ) : null
          ) : !search && hasWorkspaceRuntime('systemd') ? (
            <RuntimeError name="Systemd" error={inventory.systemd.error} />
          ) : null}
        </>
      ) : null}
      {workspaceResources
        ?.filter((resource) => {
          if (!inventory) return true;
          if (resource.runtime === 'docker')
            return ![
              ...(inventory.containers ?? []),
              ...(inventory.dockerGroups ?? []).flatMap((group) => group.containers ?? []),
            ].some((item) => item.id === resource.id);
          if (resource.runtime === 'pm2')
            return !(inventory.pm2Processes ?? []).some((item) => item.id === resource.id);
          return !(inventory.systemUnits ?? []).some(
            (item) => item.id === resource.id && item.scope === resource.scope,
          );
        })
        .map((resource) =>
          row(
            resource,
            resource.runtime === 'docker'
              ? 'container'
              : resource.runtime === 'pm2'
                ? 'pm2'
                : 'systemd',
            '',
            t('serviceManagerTool.resourceUnavailable'),
          ),
        )}
    </>
  );
  return embedded ? content : <ScrollArea className="h-full min-h-0">{content}</ScrollArea>;
}
function RuntimeError({ name, error }: { name: string; error?: string }) {
  return (
    <div className="border-b px-3 py-3 text-xs text-muted-foreground">
      <WarningCircle className="mr-1 inline size-3.5" />
      {name}: {error ? formatBackendError(error) : '—'}
    </div>
  );
}

function ResourcePanel({
  selection,
  targetID,
  metricsActive,
  groupContainers,
  refreshToken,
  tab,
  onTabChange,
  monitorIDs,
  lines,
  truncated,
  logDraft,
  setLogDraft,
  applyFilter,
  query,
  regex,
  setRegex,
  caseSensitive,
  setCaseSensitive,
  onClear,
  monitors,
  targets,
  onSelectResource,
  t,
}: {
  selection: Selection;
  targetID: string;
  metricsActive: boolean;
  groupContainers: DockerContainer[];
  refreshToken: number;
  tab: string;
  onTabChange: (value: string) => void;
  monitorIDs: string[];
  lines: ServiceLogLine[];
  truncated: boolean;
  logDraft: string;
  setLogDraft: (value: string) => void;
  applyFilter: () => void;
  query: string;
  regex: boolean;
  setRegex: (value: boolean) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  onClear: () => void;
  monitors: LogMonitor[];
  targets: ServiceTarget[];
  onSelectResource: (monitor: LogMonitor) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resource = selection.resource;
  const scope = selection.kind === 'workspace' || selection.kind === 'host';
  const sourceLabels = useMemo(() => {
    if (!scope) return undefined;
    const targetNames = new Map(targets.map((item) => [item.id, targetLabel(item, t)]));
    return new Map(
      monitors.map((item) => [
        item.id,
        [
          selection.kind === 'workspace'
            ? (targetNames.get(item.targetID) ?? t('serviceManagerTool.targetUnavailable'))
            : '',
          item.resource.group,
          item.resource.name || item.resource.id,
        ]
          .filter(Boolean)
          .join(' / '),
      ]),
    );
  }, [scope, monitors, targets, selection.kind, t]);
  const visibleLines = useMemo(
    () => lines.filter((line) => monitorIDs.includes(line.monitorID)),
    [lines, monitorIDs],
  );
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value)}
        className="h-full min-h-0 gap-0"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          {scope ? (
            <span className="min-w-0 truncate text-sm font-semibold">
              {selection.kind === 'workspace' ? t('serviceManagerTool.workspace') : resource.name}
            </span>
          ) : null}
          <TabsList>
            <TabsTrigger value="info">{t('serviceManagerTool.detailTabs.info')}</TabsTrigger>
            <TabsTrigger value="performance">
              {t('serviceManagerTool.detailTabs.metrics')}
            </TabsTrigger>
            <TabsTrigger value="logs">{t('serviceManagerTool.detailTabs.logs')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="info" className="flex min-h-0 flex-col overflow-hidden">
          {scope ? (
            <ScopeInfoTab selection={selection} monitors={monitors} targets={targets} t={t} />
          ) : (
            <ResourceInfoTab
              targetID={targetID}
              resource={resource}
              groupContainers={groupContainers}
              refreshToken={refreshToken}
            />
          )}
        </TabsContent>
        <TabsContent value="performance" className="flex min-h-0 flex-col overflow-hidden">
          {selection.kind === 'workspace' ? (
            <ServiceWorkspacePerformance
              enabled={metricsActive}
              monitors={monitors}
              targets={targets}
              onSelectResource={onSelectResource}
            />
          ) : (
            <ServiceResourcePerformance
              enabled={metricsActive}
              targetID={targetID}
              resource={resource}
              sampleKind={selection.kind === 'host' ? 'source' : 'resource'}
            />
          )}
        </TabsContent>
        <TabsContent value="logs" className="flex min-h-0 flex-col overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
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
                {!scope ? (
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
                ) : null}
              </div>
              {truncated ? (
                <p className="mt-2 text-xs text-amber-600">
                  {t('serviceManagerTool.logsTruncated')}
                </p>
              ) : null}
              {lines.length >= VISIBLE_LOG_LIMIT ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('serviceManagerTool.visibleLogLimit')}
                </p>
              ) : null}
            </div>
            <LogList
              lines={visibleLines}
              query={query}
              regex={regex}
              caseSensitive={caseSensitive}
              sourceLabels={sourceLabels}
            />
          </div>
        </TabsContent>
      </Tabs>
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
    </>
  );
}

type ContainerInfo =
  | { runtime: 'docker'; detail: DockerContainerDetail }
  | { runtime: 'pm2'; detail: PM2ProcessDetail }
  | { runtime: 'systemd'; detail: SystemdUnitDetail };

function formatMoment(value: string | number) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function describeCommand(parts: string[] | null | undefined) {
  return parts?.length ? parts.join(' ') : '—';
}

function InfoSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="border-b px-4 py-3 last:border-b-0">
      {title ? (
        <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

function InfoFields({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs">
      {children}
    </dl>
  );
}

function InfoField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-foreground">{children}</dd>
    </>
  );
}

function ContainerSizeSpinner() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    let frame = 0;
    const align = () => {
      const { left, top } = anchor.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      // WebView 在半物理像素位置栅格化旋转 SVG 时会偏心；对齐静态容器，保留原动画。
      content.style.left = `${Math.round(left * scale) / scale - left}px`;
      content.style.top = `${Math.round(top * scale) / scale - top}px`;
    };
    const scheduleAlign = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    };
    const observer = new ResizeObserver(scheduleAlign);
    // 分栏拖动会改变位置而不改变图标尺寸，因此同时观察布局祖先。
    for (let element: Element | null = anchor; element; element = element.parentElement) {
      observer.observe(element);
    }
    window.addEventListener('resize', scheduleAlign);
    window.addEventListener('scroll', scheduleAlign, true);
    align();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleAlign);
      window.removeEventListener('scroll', scheduleAlign, true);
    };
  }, []);

  return (
    <span ref={anchorRef} className="inline-flex size-4 shrink-0">
      <span ref={contentRef} className="relative inline-flex">
        <Spinner />
      </span>
    </span>
  );
}

function ContainerSizePopover({
  size,
  loading,
  error,
}: {
  size: DockerContainerSize | null;
  loading: boolean;
  error: string;
}) {
  const { t } = useTranslation();
  const rows = size
    ? [
        {
          key: 'container',
          label: t('serviceManagerTool.detail.containerWritableLayer'),
          detail: '',
          size: size.container,
          available: true,
        },
        ...(size.mounts ?? []).map((mount, index) => ({
          key: `${mount.type}-${mount.source}-${mount.destination}-${index}`,
          label:
            mount.type === 'volume'
              ? t('serviceManagerTool.detail.dockerVolume')
              : t('serviceManagerTool.detail.bindMount'),
          detail:
            mount.type === 'volume'
              ? `${mount.name || mount.source} → ${mount.destination}`
              : `${mount.source} → ${mount.destination}`,
          size: mount.size,
          available: mount.available,
        })),
      ]
    : [];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="link"
            size="sm"
            className="h-auto min-h-0 min-w-0 gap-1.5 px-0 py-0 align-middle font-mono"
            aria-label={t('serviceManagerTool.detail.showSizeBreakdown')}
          />
        }
      >
        {size ? formatBytes(size.total) : '—'}
        {loading ? <ContainerSizeSpinner /> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle>{t('serviceManagerTool.detail.sizeBreakdown')}</PopoverTitle>
          {loading && size ? <ContainerSizeSpinner /> : null}
        </div>
        {size ? (
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-start justify-between gap-4 text-xs">
                <span className="min-w-0">
                  <span className="block text-foreground">{row.label}</span>
                  {row.detail ? (
                    <span className="block break-all font-mono text-[10px] text-muted-foreground">
                      {row.detail}
                    </span>
                  ) : null}
                </span>
                <span className="flex-none font-mono tabular-nums text-foreground">
                  {row.available
                    ? formatBytes(row.size)
                    : t('serviceManagerTool.detail.sizeUnavailable')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-12 items-center justify-center text-xs text-muted-foreground">
            {loading ? <ContainerSizeSpinner /> : t('serviceManagerTool.detail.sizeUnavailable')}
          </div>
        )}
        {error ? <p className="m-0 text-[10px] text-destructive">{error}</p> : null}
        {size && !size.complete ? (
          <p className="m-0 text-[10px] text-muted-foreground">
            {t('serviceManagerTool.detail.sizePartial')}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ScopeInfoTab({
  selection,
  monitors,
  targets,
  t,
}: {
  selection: Selection;
  monitors: LogMonitor[];
  targets: ServiceTarget[];
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const hostIDs = [...new Set(monitors.map((item) => item.targetID))];
  return (
    <ScrollArea className="h-full min-h-0">
      <InfoSection>
        <InfoFields>
          <InfoField label={t('serviceManagerTool.target')}>
            {selection.kind === 'workspace' ? hostIDs.length : selection.resource.name}
          </InfoField>
          <InfoField label={t('serviceManagerTool.scopeInfo.members')}>{monitors.length}</InfoField>
          {STATUS_GROUPS.map(({ runtime }) => (
            <InfoField key={runtime} label={t(`serviceManagerTool.runtimes.${runtime}`)}>
              {monitors.filter((item) => item.resource.runtime === runtime).length}
            </InfoField>
          ))}
        </InfoFields>
      </InfoSection>
      {selection.kind === 'workspace' && hostIDs.length ? (
        <InfoSection title={t('serviceManagerTool.target')}>
          <InfoFields>
            {hostIDs.map((id) => {
              const target = targets.find((item) => item.id === id);
              return (
                <InfoField
                  key={id}
                  label={
                    target ? targetLabel(target, t) : t('serviceManagerTool.targetUnavailable')
                  }
                >
                  {t('serviceManagerTool.workspaceMembers', {
                    total: monitors.filter((item) => item.targetID === id).length,
                  })}
                </InfoField>
              );
            })}
          </InfoFields>
        </InfoSection>
      ) : null}
    </ScrollArea>
  );
}

function InfoList({ items }: { items: string[] }) {
  return (
    <ul className="m-0 flex flex-col gap-1 font-mono text-[11px] break-all text-foreground">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

// 各类资源的详情字段不同，这里按运行时渲染结构化的键值信息，避免直接暴露原始 JSON。
function ContainerInfoView({
  info,
  containerSize,
  sizeLoading,
  sizeError,
}: {
  info: ContainerInfo;
  containerSize: DockerContainerSize | null;
  sizeLoading: boolean;
  sizeError: string;
}) {
  const { t } = useTranslation();
  if (info.runtime === 'docker') {
    const { container, command, entrypoint, mounts, networks, restartPolicy } = info.detail;
    return (
      <div className="flex flex-col">
        <InfoSection>
          <InfoFields>
            <InfoField label={t('serviceManagerTool.metrics.name')}>
              {container.name || container.id}
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.image')}>
              {container.image || '—'}
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.size')}>
              <ContainerSizePopover size={containerSize} loading={sizeLoading} error={sizeError} />
            </InfoField>
            <InfoField label={t('serviceManagerTool.status')}>
              <Badge variant={statusVariant(container.status)}>{container.status}</Badge>
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.id')}>{container.id}</InfoField>
            {container.composeProject ? (
              <InfoField label={t('serviceManagerTool.detail.composeProject')}>
                {container.composeProject}
              </InfoField>
            ) : null}
            {container.composeService ? (
              <InfoField label={t('serviceManagerTool.detail.composeService')}>
                {container.composeService}
              </InfoField>
            ) : null}
            {container.createdAt ? (
              <InfoField label={t('serviceManagerTool.detail.createdAt')}>
                {formatMoment(container.createdAt)}
              </InfoField>
            ) : null}
            {container.ports?.length ? (
              <InfoField label={t('serviceManagerTool.detail.ports')}>
                {container.ports.join(', ')}
              </InfoField>
            ) : null}
          </InfoFields>
        </InfoSection>
        <InfoSection title={t('serviceManagerTool.detail.config')}>
          <InfoFields>
            <InfoField label={t('serviceManagerTool.detail.command')}>
              {describeCommand(command)}
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.entrypoint')}>
              {describeCommand(entrypoint)}
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.restartPolicy')}>
              {restartPolicy || '—'}
            </InfoField>
          </InfoFields>
        </InfoSection>
        {mounts?.length ? (
          <InfoSection title={t('serviceManagerTool.detail.mounts')}>
            <InfoList items={mounts} />
          </InfoSection>
        ) : null}
        {networks?.length ? (
          <InfoSection title={t('serviceManagerTool.detail.networks')}>
            <InfoList items={networks} />
          </InfoSection>
        ) : null}
      </div>
    );
  }
  if (info.runtime === 'pm2') {
    const proc = info.detail.process;
    return (
      <div className="flex flex-col">
        <InfoSection>
          <InfoFields>
            <InfoField label={t('serviceManagerTool.metrics.name')}>
              {proc.name || proc.id}
            </InfoField>
            <InfoField label={t('serviceManagerTool.status')}>
              <Badge variant={statusVariant(proc.status)}>{proc.status}</Badge>
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.id')}>{proc.id}</InfoField>
            <InfoField label={t('serviceManagerTool.detail.pid')}>{String(proc.pid)}</InfoField>
            <InfoField label={t('serviceManagerTool.detail.restarts')}>
              {String(proc.restarts)}
            </InfoField>
            <InfoField label={t('serviceManagerTool.metrics.metric.cpu')}>
              {`${proc.cpu.toFixed(1)}%`}
            </InfoField>
            <InfoField label={t('serviceManagerTool.metrics.metric.memory')}>
              {formatBytes(proc.memory)}
            </InfoField>
            {proc.uptime ? (
              <InfoField label={t('serviceManagerTool.detail.startedAt')}>
                {formatMoment(proc.uptime)}
              </InfoField>
            ) : null}
          </InfoFields>
        </InfoSection>
        <InfoSection title={t('serviceManagerTool.detail.process')}>
          <InfoFields>
            <InfoField label={t('serviceManagerTool.detail.script')}>
              {proc.script || '—'}
            </InfoField>
            <InfoField label={t('serviceManagerTool.detail.cwd')}>{proc.cwd || '—'}</InfoField>
            <InfoField label={t('serviceManagerTool.detail.interpreter')}>
              {proc.interpreter || '—'}
            </InfoField>
          </InfoFields>
        </InfoSection>
      </div>
    );
  }
  const { unit, mainPID, execStart, fragmentPath } = info.detail;
  return (
    <div className="flex flex-col">
      <InfoSection>
        <InfoFields>
          <InfoField label={t('serviceManagerTool.metrics.name')}>{unit.name || unit.id}</InfoField>
          <InfoField label={t('serviceManagerTool.status')}>
            <Badge variant={statusVariant(unit.activeState)}>{unit.activeState}</Badge>
          </InfoField>
          <InfoField label={t('serviceManagerTool.detail.id')}>{unit.id}</InfoField>
          {unit.description ? (
            <InfoField label={t('serviceManagerTool.detail.description')}>
              {unit.description}
            </InfoField>
          ) : null}
          <InfoField label={t('serviceManagerTool.detail.scope')}>{unit.scope}</InfoField>
          <InfoField label={t('serviceManagerTool.detail.loadState')}>{unit.loadState}</InfoField>
          <InfoField label={t('serviceManagerTool.detail.subState')}>{unit.subState}</InfoField>
          <InfoField label={t('serviceManagerTool.detail.mainPID')}>
            {mainPID ? String(mainPID) : '—'}
          </InfoField>
        </InfoFields>
      </InfoSection>
      <InfoSection title={t('serviceManagerTool.detail.unit')}>
        <InfoFields>
          <InfoField label={t('serviceManagerTool.detail.execStart')}>{execStart || '—'}</InfoField>
          <InfoField label={t('serviceManagerTool.detail.fragmentPath')}>
            {fragmentPath || '—'}
          </InfoField>
        </InfoFields>
      </InfoSection>
    </div>
  );
}

function ResourceInfoTab({
  targetID,
  resource,
  groupContainers,
  refreshToken,
}: {
  targetID: string;
  resource: ServiceResourceRef;
  groupContainers: DockerContainer[];
  refreshToken: number;
}) {
  const { t } = useTranslation();
  const identity = `${targetID}|${resource.runtime}|${resource.scope ?? ''}|${resource.id}`;
  const [infoState, setInfoState] = useState<{ identity: string; value: ContainerInfo } | null>(
    null,
  );
  const [sizeState, setSizeState] = useState<{
    identity: string;
    value: DockerContainerSize;
  } | null>(null);
  const [sizeLoading, setSizeLoading] = useState(false);
  const [sizeError, setSizeError] = useState('');
  const [error, setError] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const detailRequestVersion = useRef(0);
  const sizeRequestVersion = useRef(0);
  const isGroup = resource.runtime === 'docker-compose';
  const info = infoState?.identity === identity ? infoState.value : null;
  const containerSize = sizeState?.identity === identity ? sizeState.value : null;

  useEffect(() => {
    const detailVersion = ++detailRequestVersion.current;
    const sizeVersion = ++sizeRequestVersion.current;
    if (isGroup) {
      setSizeLoading(false);
      return;
    }
    setError('');
    void (async () => {
      try {
        let next: ContainerInfo;
        if (resource.runtime === 'docker') {
          next = {
            runtime: 'docker',
            detail: await GetDockerContainerDetail(targetID, resource.id),
          };
        } else if (resource.runtime === 'pm2') {
          next = {
            runtime: 'pm2',
            detail: await GetPM2ProcessDetail(targetID, resource.id),
          };
        } else {
          next = {
            runtime: 'systemd',
            detail: await GetSystemdUnitDetail(targetID, resource.id, resource.scope ?? 'system'),
          };
        }
        if (detailRequestVersion.current === detailVersion) setInfoState({ identity, value: next });
      } catch (reason) {
        if (detailRequestVersion.current === detailVersion) setError(formatBackendError(reason));
      }
    })();
    if (resource.runtime === 'docker') {
      setSizeLoading(true);
      setSizeError('');
      void GetDockerContainerSize(targetID, resource.id)
        .then((next) => {
          if (sizeRequestVersion.current === sizeVersion) setSizeState({ identity, value: next });
        })
        .catch((reason) => {
          if (sizeRequestVersion.current === sizeVersion) setSizeError(formatBackendError(reason));
        })
        .finally(() => {
          if (sizeRequestVersion.current === sizeVersion) setSizeLoading(false);
        });
    } else {
      setSizeLoading(false);
      setSizeError('');
    }
  }, [identity, isGroup, refreshToken]);

  if (isGroup) {
    return (
      <ScrollArea className="h-full min-h-0">
        {groupContainers.length ? (
          <ul className="divide-y">
            {groupContainers.map((container) => (
              <li key={container.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {container.name || container.id}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {container.image}
                  </span>
                </span>
                <Badge variant={statusVariant(container.status)}>{container.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid min-h-24 place-items-center px-6 text-center text-xs text-muted-foreground">
            {t('serviceManagerTool.metrics.empty')}
          </div>
        )}
      </ScrollArea>
    );
  }

  return (
    <>
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
        <ScrollArea className="min-h-0 overflow-hidden">
          {!info && error ? (
            <p className="m-0 px-4 py-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : !info ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              {t('common.loading')}
            </div>
          ) : (
            <ContainerInfoView
              info={info}
              containerSize={containerSize}
              sizeLoading={sizeLoading}
              sizeError={sizeError}
            />
          )}
        </ScrollArea>
        <div className="flex items-center justify-end border-t px-4 py-2">
          <Button variant="outline" size="sm" disabled={!info} onClick={() => setRawOpen(true)}>
            <CodeSimple data-icon="inline-start" />
            {t('serviceManagerTool.detail.viewRaw')}
          </Button>
        </div>
      </div>
      <Dialog open={rawOpen} onOpenChange={setRawOpen}>
        <DialogContent className="flex h-[75dvh] min-h-0 flex-col sm:max-w-2xl">
          <DialogHeader className="flex-none">
            <DialogTitle>{resource.name || resource.id}</DialogTitle>
            <DialogDescription>{t('serviceManagerTool.detail.rawTitle')}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-muted/20 p-3">
            <pre className="m-0 font-mono text-[11px] break-all whitespace-pre-wrap text-foreground">
              {JSON.stringify(
                info?.runtime === 'docker'
                  ? { ...info.detail, size: containerSize }
                  : (info?.detail ?? null),
                null,
                2,
              )}
            </pre>
          </ScrollArea>
          <DialogFooter className="flex-none">
            <Button variant="outline" onClick={() => setRawOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
function LogList({
  lines,
  query,
  regex,
  caseSensitive,
  sourceLabels,
}: {
  lines: ServiceLogLine[];
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  sourceLabels?: Map<string, string>;
}) {
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
  const getItemKey = useCallback((index: number) => lines[index].sequence, [lines]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport,
    getItemKey,
    estimateSize: () => 24,
    overscan: 20,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;
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
          <div className="w-full">
            {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : null}
            {virtualRows.map((row) => {
              const line = lines[row.index];
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  className={`w-full border-b py-1 ${LOG_GRID}`}
                >
                  <WheelText className="text-muted-foreground">{logTime(line)}</WheelText>
                  <WheelText className="text-primary">
                    {sourceLabels?.get(line.monitorID) ?? line.name}
                  </WheelText>
                  <span className="break-all whitespace-pre-wrap">
                    {renderLogText(line.text, query, regex, caseSensitive)}
                  </span>
                </div>
              );
            })}
            {paddingBottom > 0 ? <div style={{ height: paddingBottom }} /> : null}
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
function renderLogText(
  text: string,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): ReactNode {
  const { text: plain, spans } = parseAnsi(text);
  const ranges = logMatchRanges(plain, query, regex, caseSensitive);
  if (!ranges.length) {
    if (spans.length === 1 && !spans[0].className && !spans[0].style) return spans[0].text;
    return spans.map((span, index) => logSpan(span, span.text, index));
  }
  const nodes: ReactNode[] = [];
  let position = 0;
  let key = 0;
  for (const span of spans) {
    const spanEnd = position + span.text.length;
    let consumed = 0;
    for (const range of ranges) {
      if (range.end <= position) continue;
      if (range.start >= spanEnd) break;
      const start = Math.max(range.start, position);
      const stop = Math.min(range.end, spanEnd);
      if (start > position + consumed)
        nodes.push(logSpan(span, span.text.slice(consumed, start - position), key++));
      nodes.push(logSpan(span, span.text.slice(start - position, stop - position), key++, true));
      consumed = stop - position;
    }
    if (consumed < span.text.length) nodes.push(logSpan(span, span.text.slice(consumed), key++));
    position = spanEnd;
  }
  return nodes;
}
function logSpan(span: AnsiSpan, content: string, key: number, marked = false): ReactNode {
  if (!content) return null;
  if (marked) {
    return (
      <mark key={key} className={`rounded-[2px] bg-warning/30 ${span.className}`}>
        {content}
      </mark>
    );
  }
  if (!span.className && !span.style) return content;
  return (
    <span key={key} className={span.className || undefined} style={span.style}>
      {content}
    </span>
  );
}
function logMatchRanges(
  text: string,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): Array<{ start: number; end: number }> {
  if (!query) return [];
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}
function matchesLog(line: ServiceLogLine, query: string, regex: boolean, caseSensitive: boolean) {
  if (!query) return true;
  const text = ansiPlainText(line.text);
  try {
    if (regex) return new RegExp(query, caseSensitive ? '' : 'i').test(text);
    return (caseSensitive ? text : text.toLowerCase()).includes(
      caseSensitive ? query : query.toLowerCase(),
    );
  } catch {
    return false;
  }
}
