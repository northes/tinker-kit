import { mergeServiceInventory } from '../lib/service-inventory';
import {
  ArrowsClockwise,
  CaretDown,
  Cube,
  DesktopTower,
  GearSix,
  ListBullets,
  Queue,
  Trash,
  XCircle,
} from '@phosphor-icons/react';
import { CancelError, Events } from '@wailsio/runtime';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DockerContainer,
  LogMonitor,
  ServiceActionRequest,
  ServiceInventory,
  ServiceLogLine,
  ServiceResourceRef,
  ServiceTarget,
} from '../../bindings/tinkerkit/models';
import {
  ClearLogBuffer,
  GetLogMonitors,
  GetServiceInventory,
  GetServiceTargets,
  PerformServiceAction,
  QueryLogBuffer,
  RemoveLogMonitor,
  SaveServiceTargets,
  StartLogMonitors,
} from '../../bindings/tinkerkit/servicemanagerservice';
import { formatBackendError } from '../lib/backend-error';
import { isLocalSource, sourceLabel } from '../lib/local-source';
import { ConfirmDialog } from './ConfirmDialog';
import { LogFilterHistory } from '../../bindings/tinkerkit/configservice';
import {
  composeGroupContainers,
  isLogLimitFailure,
  LOCAL_TARGET,
  MANAGE_TARGETS_VALUE,
  monitorResourceKey,
  PICKED_SELECTION,
  pickedMemberKey,
  resourceKey,
  resourceRefsFor,
  STATUS_GROUPS,
  statusKey,
  statusVariant,
  targetLabel,
  VISIBLE_LOG_LIMIT,
  type LogEvent,
  type PickedMember,
  type Runtime,
  type Selection,
} from './service-manager/model';
import { ResourceList } from './service-manager/ResourceList';
import { ResourcePanel, RuntimeError } from './service-manager/ResourcePanel';
import {
  Reveal,
  ToolActionButton,
  ToolEmptyState,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutToolbar,
} from './shared';
import { SSHProfileFormField } from './SSHProfileFormField';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
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
import { toast } from './ui/toast';

export default function ServiceManagerTool({
  active,
  highlightLevels,
  setHighlightLevels,
  collapseLines,
  setCollapseLines,
}: {
  active: boolean;
  highlightLevels: boolean;
  setHighlightLevels: (value: boolean) => void;
  collapseLines: number;
  setCollapseLines: (value: number) => void;
}) {
  const { t } = useTranslation();
  const targetLabelId = useId();
  const { profiles, reload } = useSSHProfiles();
  const [targets, setTargets] = useState<ServiceTarget[]>([]);
  const [targetID, setTargetID] = useState('local');
  const targetIDRef = useRef(targetID);
  targetIDRef.current = targetID;
  const targetInitialized = useRef(false);
  const [inventory, setInventory] = useState<ServiceInventory | null>(null);
  const [detailRefreshVersion, setDetailRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadCanceled, setLoadCanceled] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState('');
  const [monitors, setMonitors] = useState<LogMonitor[]>([]);
  const [pickedMembers, setPickedMembers] = useState<PickedMember[]>([]);
  const [view, setView] = useState<'resource' | 'picked'>('resource');
  const [detailTab, setDetailTab] = useState('info');
  const [panelOrientation, setPanelOrientation] = useState<'horizontal' | 'vertical'>(() =>
    window.matchMedia('(max-width: 800px)').matches ? 'vertical' : 'horizontal',
  );
  const [pickedInventories, setPickedInventories] = useState<Record<string, ServiceInventory>>({});
  const [pickedErrors, setPickedErrors] = useState<Record<string, string>>({});
  const [pendingUnpick, setPendingUnpick] = useState<{
    members: PickedMember[];
    name: string;
    all: boolean;
  } | null>(null);
  const [unpicking, setUnpicking] = useState(false);
  const [logDraft, setLogDraft] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [filterHistory, setFilterHistory] = useState<string[]>([]);
  const historyQueue = useRef(Promise.resolve());
  const updateFilterHistory = (action: string, query = '') => {
    historyQueue.current = historyQueue.current.then(async () => {
      try {
        setFilterHistory((await LogFilterHistory(action, query)) ?? []);
      } catch (error) {
        toast.add({
          title: t('serviceManagerTool.historyFailed'),
          description: formatBackendError(error),
          type: 'error',
        });
      }
    });
    return historyQueue.current;
  };
  useEffect(() => {
    void updateFilterHistory('list');
  }, []);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [lines, setLines] = useState<ServiceLogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [highlightPattern, setHighlightPattern] = useState('');
  const [highlightPatterns, setHighlightPatterns] = useState<Record<string, string | undefined>>(
    {},
  );
  const [manageOpen, setManageOpen] = useState(false);
  const [savingTargets, setSavingTargets] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    resource: ServiceResourceRef;
    action: string;
    targetID: string;
  } | null>(null);
  const [updateDialog, setUpdateDialog] = useState<{
    resource: ServiceResourceRef;
    targetID: string;
  } | null>(null);
  const [pickDialog, setPickDialog] = useState<{
    resource: ServiceResourceRef;
    targetID: string;
    containers: DockerContainer[];
  } | null>(null);
  const [pickSelection, setPickSelection] = useState<Set<string>>(new Set());
  const monitorLoadVersion = useRef(0);
  const actionRequest = useRef<ReturnType<typeof PerformServiceAction> | null>(null);
  const inventoryRequests = useRef(new Map<string, ReturnType<typeof GetServiceInventory>>());
  const inventoryLoadVersion = useRef(0);
  const requestInventory = (id: string) => {
    const existing = inventoryRequests.current.get(id);
    if (existing) return existing;
    const request = GetServiceInventory(id);
    inventoryRequests.current.set(id, request);
    const cleanup = () => {
      if (inventoryRequests.current.get(id) === request) inventoryRequests.current.delete(id);
    };
    void request.then(cleanup, cleanup);
    return request;
  };
  // 与 SSH 文件管理一致：取消正在连接的清单请求，恢复由用户手动刷新触发。
  const cancelInventory = (id: string) => {
    const request = inventoryRequests.current.get(id);
    if (!request) return;
    inventoryRequests.current.delete(id);
    void request.cancel();
  };

  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const update = () => setPanelOrientation(media.matches ? 'vertical' : 'horizontal');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  // 浏览位置与监控会话独立；首次加载默认选中列表中的第一个目标，
  // 之后保留当前目标，目标被移除时回退到第一个可用的目标。
  const syncTargets = (next: ServiceTarget[]) => {
    setTargets(next);
    const current = targetIDRef.current;
    if (targetInitialized.current && next.some((item) => item.id === current)) return;
    targetInitialized.current = true;
    const fallback = next[0]?.id ?? 'local';
    if (fallback === current) return;
    cancelInventory(current);
    inventoryLoadVersion.current++;
    setSelection(null);
    setInventory(null);
    setTargetID(fallback);
  };

  const load = async (nextTarget = targetID, refreshDetails = false) => {
    const version = ++inventoryLoadVersion.current;
    setLoadCanceled(false);
    setLoading(true);
    try {
      const next = await requestInventory(nextTarget);
      if (targetIDRef.current !== nextTarget || version !== inventoryLoadVersion.current) return;
      setInventory((current) => mergeServiceInventory(current, next));
      if (refreshDetails) setDetailRefreshVersion((value) => value + 1);
    } catch (error) {
      if (targetIDRef.current !== nextTarget || version !== inventoryLoadVersion.current) return;
      toast.add({
        title: t('serviceManagerTool.refreshFailed'),
        description: formatBackendError(error),
        type: 'error',
      });
    } finally {
      if (targetIDRef.current === nextTarget && version === inventoryLoadVersion.current)
        setLoading(false);
    }
  };
  const cancelLoad = () => {
    if (!inventoryRequests.current.has(targetID)) return;
    cancelInventory(targetID);
    inventoryLoadVersion.current++;
    setLoading(false);
    setLoadCanceled(true);
  };
  const loadMonitors = async () => {
    const version = ++monitorLoadVersion.current;
    const items = (await GetLogMonitors('')) ?? [];
    if (version === monitorLoadVersion.current) setMonitors(items);
  };

  const selectedTargetID =
    view === 'picked' && selection?.kind !== 'picked'
      ? (selection?.targetID ?? targetID)
      : targetID;
  const selectedInventory =
    selectedTargetID === targetID ? inventory : pickedInventories[selectedTargetID];
  const currentTargetMonitors = useMemo(
    () => monitors.filter((item) => item.targetID === selectedTargetID),
    [monitors, selectedTargetID],
  );
  const monitoredByResource = useMemo(
    () => new Map(monitors.map((item) => [`${item.targetID}|${monitorResourceKey(item)}`, item])),
    [monitors],
  );
  const pickedMemberKeys = useMemo(
    () => new Set(pickedMembers.map(pickedMemberKey)),
    [pickedMembers],
  );
  const pickedTargetIDs = useMemo(
    () => [...new Set(pickedMembers.map((member) => member.targetID))],
    [pickedMembers],
  );
  // 仅已挑选成员的日志监控；自动采集但未被挑选的资源不在其中。
  const memberMonitors = useMemo(
    () =>
      monitors.filter((item) =>
        pickedMemberKeys.has(`${item.targetID}|${resourceKey(item.resource)}`),
      ),
    [monitors, pickedMemberKeys],
  );
  // Compose 组选中时聚合其所有容器的监控；单资源沿用资源键匹配。
  const selectedMonitors = useMemo(() => {
    if (!selection) return [] as LogMonitor[];
    if (view === 'picked' && selection.kind === 'picked') return memberMonitors;
    if (view === 'picked' && selection.kind === 'host')
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
    setInventory(null);
    setLoadCanceled(false);
    void load(targetID);
    void loadMonitors();
  }, [targetID]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (!loadCanceled && !inventoryRequests.current.has(targetID)) void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, targetID, loadCanceled]);
  useEffect(() => {
    if (view !== 'picked') return;
    const hostIDs = pickedTargetIDs;
    if (!hostIDs.length) return;
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      const results = await Promise.allSettled(hostIDs.map((id) => requestInventory(id)));
      running = false;
      if (cancelled) return;
      setPickedInventories((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          if (result.status === 'fulfilled')
            next[hostIDs[index]] = mergeServiceInventory(current[hostIDs[index]], result.value);
        });
        return next;
      });
      setPickedErrors((current) => {
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
  }, [view, active, pickedTargetIDs.join('|')]);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let dirty = false;
    let failed = false;
    let request: ReturnType<typeof QueryLogBuffer> | undefined;
    setLines([]);
    setTruncated(false);
    setHighlightPattern('');
    setHighlightPatterns({});
    const run = async () => {
      if (failed) return;
      dirty = true;
      if (running) return;
      running = true;
      try {
        while (dirty && !cancelled) {
          dirty = false;
          if (!activeMonitorIDs.length) {
            setLines([]);
            setTruncated(false);
            break;
          }
          request = QueryLogBuffer({
            monitorIDs: activeMonitorIDs,
            filter: { query: logQuery, regex, wholeWord, caseSensitive, streams: [] },
            limit: VISIBLE_LOG_LIMIT,
          });
          const snapshot = await request;
          if (!cancelled) {
            setLines(snapshot.lines ?? []);
            setTruncated(snapshot.truncated);
            setHighlightPattern(snapshot.highlightPattern);
            setHighlightPatterns(snapshot.highlightPatterns ?? {});
          }
        }
      } catch (error) {
        failed = true;
        if (!cancelled)
          toast.add({
            title: t('serviceManagerTool.filterFailed'),
            description: formatBackendError(error),
            type: 'error',
          });
      } finally {
        running = false;
      }
    };
    const off = Events.On('service-manager:logs', (event) => {
      const data = event.data as LogEvent;
      if (data?.lines?.some((line) => activeMonitorIDs.includes(line.monitorID))) void run();
    });
    const offState = Events.On('service-manager:log-state', () => {
      void loadMonitors();
      void run();
    });
    void run();
    return () => {
      cancelled = true;
      request?.cancel();
      off();
      offState();
    };
  }, [activeMonitorKey, logQuery, regex, caseSensitive, wholeWord]);

  const toolbarTarget = targets.find((target) => target.id === targetID);

  const selectTarget = (next: string | null) => {
    if (!next || next === targetID) return;
    targetInitialized.current = true;
    cancelInventory(targetID);
    inventoryLoadVersion.current++;
    setSelection(null);
    setInventory(null);
    setTargetID(next);
  };
  const openPicked = () => {
    setView('picked');
    setSelection(PICKED_SELECTION);
  };
  const showResources = () => {
    setView('resource');
    if (
      selection?.kind === 'picked' ||
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
    const actionLabel = t(`serviceManagerTool.actions.${action}`);
    const resourceLabel = resource.name || resource.id;
    setBusy(key);
    const request = PerformServiceAction({
      targetID: target,
      resource,
      action,
    } as ServiceActionRequest);
    actionRequest.current = request;
    try {
      const result = await request;
      const failed = result.failed ?? [];
      const succeeded = result.succeeded ?? [];
      if (failed.length) {
        const partial = succeeded.length > 0;
        toast.add({
          title: partial
            ? t('serviceManagerTool.actionPartialFailed', {
                action: actionLabel,
                resource: resourceLabel,
                successTotal: succeeded.length,
                failedTotal: failed.length,
              })
            : t('serviceManagerTool.actionFailed', {
                action: actionLabel,
                resource: resourceLabel,
              }),
          description: failed.map((item) => formatBackendError(item.error)).join('；'),
          type: partial ? 'warning' : 'error',
        });
      } else
        toast.add({
          title: t('serviceManagerTool.actionSucceeded', {
            action: actionLabel,
            resource: resourceLabel,
          }),
          type: 'success',
        });
      if (target === targetID) await load(target, view !== 'picked');
      if (view === 'picked') {
        const updated = await GetServiceInventory(target);
        setPickedInventories((current) => ({ ...current, [target]: updated }));
        setDetailRefreshVersion((value) => value + 1);
      }
    } catch (error) {
      if (error instanceof CancelError) {
        toast.add({
          title: t('serviceManagerTool.actionCanceled'),
          description: t('serviceManagerTool.actionCanceledHint', { resource: resourceLabel }),
          type: 'info',
        });
        if (target === targetID) await load(target, view !== 'picked');
        if (view === 'picked') {
          const updated = await GetServiceInventory(target);
          setPickedInventories((current) => ({ ...current, [target]: updated }));
          setDetailRefreshVersion((value) => value + 1);
        }
        return;
      }
      toast.add({
        title: t('serviceManagerTool.actionFailed', {
          action: actionLabel,
          resource: resourceLabel,
        }),
        description: formatBackendError(error),
        type: 'error',
      });
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
      setBusy('');
    }
  };
  const cancelAction = () => {
    const request = actionRequest.current;
    if (!request) return;
    actionRequest.current = null;
    void request.cancel();
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
  const togglePickContainer = (id: string, checked: boolean) =>
    setPickSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  // 挑选只更新成员集合；日志监控由成员同步 effect 启动，已存在的直接复用。
  const addPickedMembers = (members: PickedMember[]) => {
    setPickedMembers((current) => {
      const all = new Map(current.map((member) => [pickedMemberKey(member), member]));
      members.forEach((member) => all.set(pickedMemberKey(member), member));
      return [...all.values()];
    });
  };
  const confirmPickSelection = () => {
    const dialog = pickDialog;
    if (!dialog) return;
    const refs = dialog.containers
      .filter((item) => pickSelection.has(item.id))
      .map(
        (item) =>
          ({
            runtime: 'docker',
            id: item.id,
            name: item.name,
            group: dialog.resource.name,
          }) as ServiceResourceRef,
      );
    setPickDialog(null);
    addPickedMembers(refs.map((resource) => ({ targetID: dialog.targetID, resource })));
  };
  // 自动启动所选资源/Compose 组的日志监控并保留在后台；达到并发上限时淘汰最久未查看的一路后重试。
  const autoMonitorsRef = useRef(new Map<string, number>());
  const autoSequenceRef = useRef(0);
  // 达到并发上限时，淘汰最久未查看、且不属于已挑选成员的自动采集监控，为新的监控让位。
  const evictAutoMonitor = async (exclude: Set<string>) => {
    const tracked = autoMonitorsRef.current;
    const oldest = [...tracked.keys()].find((id) => {
      const item = monitors.find((candidate) => candidate.id === id);
      if (!item) return false;
      const key = `${item.targetID}|${resourceKey(item.resource)}`;
      return (
        !exclude.has(key) &&
        !pickedMemberKeys.has(key) &&
        (item.state === 'monitoring' || item.state === 'stopping')
      );
    });
    if (!oldest) return false;
    tracked.delete(oldest);
    await RemoveLogMonitor(oldest).catch(() => undefined);
    return true;
  };
  const ensureSelectionMonitors = async (sel: Selection) => {
    const sourceInventory = sel.targetID === targetID ? inventory : pickedInventories[sel.targetID];
    const resources = resourceRefsFor(sel.resource, sourceInventory);
    if (!resources.length) return;
    const sequence = ++autoSequenceRef.current;
    const tracked = autoMonitorsRef.current;
    const monitorOf = (resource: ServiceResourceRef) =>
      monitoredByResource.get(`${sel.targetID}|${resourceKey(resource)}`);
    resources.forEach((resource) => {
      const existing = monitorOf(resource);
      // 浏览过的资源记为自动采集，可在达到并发上限时淘汰；已挑选成员另行保护。
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
    if (selection.kind === 'picked' || selection.kind === 'host') return;
    void ensureSelectionMonitors(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, view, selection]);
  // 已挑选成员始终保留日志监控；与浏览自动采集复用同一路监控。
  useEffect(() => {
    if (!active) return;
    const byTarget = new Map<string, ServiceResourceRef[]>();
    pickedMembers.forEach((member) => {
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
  }, [active, pickedMembers]);
  const clear = async () => {
    await Promise.all(activeMonitorIDs.map((id) => ClearLogBuffer(id).catch(() => undefined)));
    setLines([]);
    setTruncated(false);
    await loadMonitors();
  };
  const changePick = (target: string, resource: ServiceResourceRef) => {
    const sourceInventory = target === targetID ? inventory : pickedInventories[target];
    const refs = resourceRefsFor(resource, sourceInventory);
    const keys = new Set(refs.map((ref) => `${target}|${resourceKey(ref)}`));
    const existing = pickedMembers.filter((member) => keys.has(pickedMemberKey(member)));
    if (existing.length) {
      setPendingUnpick({
        members: existing,
        name: resource.name || resource.id,
        all: false,
      });
      return;
    }
    // Compose 组多容器时先让用户选择要挑选的容器，默认全选。
    if (resource.runtime === 'docker-compose' && refs.length > 1) {
      setPickSelection(new Set(refs.map((ref) => ref.id)));
      setPickDialog({
        resource,
        targetID: target,
        containers: composeGroupContainers(resource, sourceInventory),
      });
      return;
    }
    addPickedMembers(refs.map((ref) => ({ targetID: target, resource: ref })));
  };
  const confirmUnpick = async () => {
    if (!pendingUnpick || unpicking) return;
    setUnpicking(true);
    const removed = pendingUnpick.members;
    const removedKeys = new Set(removed.map(pickedMemberKey));
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
      setPickedMembers((current) =>
        current.filter((member) => !removedKeys.has(pickedMemberKey(member))),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected')
        toast.add({
          title: t('serviceManagerTool.unpickFailed'),
          description: formatBackendError(failed.reason),
          type: 'error',
        });
      if (view === 'picked') {
        if (pickedMembers.every((member) => removedKeys.has(pickedMemberKey(member))))
          showResources();
        else if (
          selection?.kind !== 'picked' &&
          selectedMonitors.length > 0 &&
          selectedMonitors.every((monitor) =>
            removedKeys.has(`${monitor.targetID}|${resourceKey(monitor.resource)}`),
          )
        ) {
          setSelection(PICKED_SELECTION);
        }
      }
      setPendingUnpick(null);
    } finally {
      setUnpicking(false);
    }
  };
  const selectedTargetMissing =
    toolbarTarget?.kind === 'ssh' &&
    !profiles.some((profile) => profile.id === toolbarTarget.sshProfileID);
  const openManage = () => {
    void reload().catch(() => undefined);
    setManageOpen(true);
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
        <ToolLayoutToolbar
          left={
            <>
              <ToolHeaderField
                label={t('serviceManagerTool.target')}
                labelId={targetLabelId}
                className="max-[700px]:w-full"
              >
                <Select
                  disabled={view === 'picked'}
                  items={targets.map((item) => ({
                    value: item.id,
                    label: targetLabel(item, t),
                  }))}
                  value={targetID}
                  onValueChange={(value) => {
                    if (value === MANAGE_TARGETS_VALUE) {
                      openManage();
                      return;
                    }
                    selectTarget(value);
                  }}
                >
                  <SelectTrigger
                    aria-labelledby={targetLabelId}
                    className="w-[220px] max-w-full max-[700px]:w-full"
                  >
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
                  <Badge variant="destructive">{t('serviceManagerTool.sshProfileMissing')}</Badge>
                ) : null}
              </ToolHeaderField>
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
                    <CaretDown weight="duotone" data-icon="inline-end" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="no-scrollbar max-h-80 w-56 overflow-y-auto"
                  >
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
              <ToolActionButton
                variant="secondary"
                active={view === 'resource'}
                icon={ListBullets}
                label={t('serviceManagerTool.hosts')}
                onPress={showResources}
              />
              <ToolActionButton
                variant="secondary"
                active={view === 'picked'}
                icon={Queue}
                label={t('serviceManagerTool.picked')}
                onPress={openPicked}
              >
                <Badge variant={pickedMembers.length > 0 ? 'success' : 'secondary'}>
                  {pickedMembers.length}
                </Badge>
              </ToolActionButton>
              {loading ? (
                <ToolActionButton
                  variant="secondary"
                  icon={XCircle}
                  label={t('common.cancel')}
                  onPress={cancelLoad}
                />
              ) : (
                <ToolActionButton
                  variant="secondary"
                  label={t('serviceManagerTool.refresh')}
                  leading={<ArrowsClockwise className="size-3.5" weight="duotone" aria-hidden />}
                  onPress={() =>
                    void (
                      view === 'picked'
                        ? Promise.allSettled(
                            pickedTargetIDs.map(async (id) => {
                              try {
                                const next = await GetServiceInventory(id);
                                setPickedInventories((current) => ({ ...current, [id]: next }));
                                setPickedErrors((current) => {
                                  const nextErrors = { ...current };
                                  delete nextErrors[id];
                                  return nextErrors;
                                });
                              } catch (error) {
                                setPickedErrors((current) => ({
                                  ...current,
                                  [id]: formatBackendError(error),
                                }));
                              }
                            }),
                          )
                        : load(targetID, true)
                    ).then(() => {
                      if (view === 'picked') setDetailRefreshVersion((value) => value + 1);
                    })
                  }
                />
              )}
              {busy && !loading ? (
                <ToolActionButton
                  variant="secondary"
                  icon={XCircle}
                  label={t('common.cancel')}
                  onPress={cancelAction}
                />
              ) : null}
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
              {view === 'picked' ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div
                    className={`flex h-10 flex-none items-center justify-between gap-2 border-b px-3 hover:bg-muted/50 ${selection?.kind === 'picked' ? 'bg-muted' : ''}`}
                  >
                    <button
                      type="button"
                      aria-pressed={selection?.kind === 'picked'}
                      className="-ml-3 flex h-10 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelection(PICKED_SELECTION)}
                    >
                      <Queue className="size-4 flex-none text-muted-foreground" weight="duotone" />
                      <span className="font-medium">{t('serviceManagerTool.picked')}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {t('serviceManagerTool.pickedCount', {
                          total: pickedMembers.length,
                        })}
                      </span>
                    </button>
                    {pickedMembers.length ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="flex-none text-muted-foreground hover:text-destructive"
                        aria-label={t('serviceManagerTool.unpickAll')}
                        title={t('serviceManagerTool.unpickAll')}
                        onClick={() => {
                          setPendingUnpick({
                            members: [...pickedMembers],
                            name: '',
                            all: true,
                          });
                        }}
                      >
                        <Trash weight="duotone" />
                      </Button>
                    ) : null}
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    {pickedMembers.length ? (
                      pickedTargetIDs.map((hostID) => (
                        <div key={hostID}>
                          <button
                            type="button"
                            aria-pressed={
                              selection?.kind === 'host' && selection.targetID === hostID
                            }
                            className={`flex h-9 w-full min-w-0 items-center gap-2 border-b px-3 text-left text-xs font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selection?.kind === 'host' && selection.targetID === hostID ? 'bg-muted text-foreground' : 'text-foreground'}`}
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
                            <DesktopTower
                              className="size-4 flex-none text-muted-foreground"
                              weight="duotone"
                            />
                            <span className="truncate">
                              {targets.find((item) => item.id === hostID)
                                ? targetLabel(
                                    targets.find((item) => item.id === hostID)!,
                                    t,
                                  )
                                : t('serviceManagerTool.targetUnavailable')}
                            </span>
                          </button>
                          {pickedErrors[hostID] ? (
                            <RuntimeError
                              name={t('serviceManagerTool.target')}
                              error={pickedErrors[hostID]}
                            />
                          ) : null}
                          <ResourceList
                            targetID={hostID}
                            inventory={pickedInventories[hostID] ?? null}
                            pickedResources={pickedMembers
                              .filter((member) => member.targetID === hostID)
                              .map((member) => member.resource)}
                            allowed={
                              new Set(
                                pickedMembers
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
                            pickedKeys={pickedMemberKeys}
                            onAction={act}
                            onPickChange={changePick}
                            busy={busy}
                            t={t}
                          />
                        </div>
                      ))
                    ) : (
                      <ToolEmptyState
                        className="h-full"
                        icon={Cube}
                        title={t('serviceManagerTool.pickedEmpty')}
                      />
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
                  pickedKeys={pickedMemberKeys}
                  onAction={act}
                  onPickChange={changePick}
                  busy={busy}
                  loadingCanceled={loadCanceled}
                  onRetryLoading={() => void load(targetID)}
                  onCancelLoading={cancelLoad}
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
                  selection.kind === 'picked' ||
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
                    applyFilter={(value = logDraft) => {
                      setLogDraft(value);
                      setLogQuery(value);
                      if (value.trim()) void updateFilterHistory('add', value);
                    }}
                    filterHistory={filterHistory}
                    deleteFilterHistory={(value) => void updateFilterHistory('delete', value)}
                    clearFilterHistory={() => void updateFilterHistory('clear')}
                    highlightPattern={highlightPattern}
                    highlightPatterns={highlightPatterns}
                    regex={regex}
                    wholeWord={wholeWord}
                    setWholeWord={setWholeWord}
                    highlightLevels={highlightLevels}
                    setHighlightLevels={setHighlightLevels}
                    collapseLines={collapseLines}
                    setCollapseLines={setCollapseLines}
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
        items={targets.length ? targets : [LOCAL_TARGET]}
        itemKey={(item) => item.id}
        itemName={(item) => sourceLabel(item, t('serviceManagerTool.localTarget'))}
        activeKey={targetID}
        itemDisabled={isLocalSource}
        createDraft={() =>
          ({ id: '', name: '', kind: 'ssh', sshProfileID: profiles[0]?.id ?? '' }) as ServiceTarget
        }
        toDraft={(item) => ({ ...item })}
        commitDraft={(draft, previous) => {
          const profile = profiles.find((item) => item.id === draft.sshProfileID);
          if (!profile) return t('serviceManagerTool.sshProfileRequired');
          const next = {
            id: `ssh:${profile.id}`,
            name: draft.name.trim() || profile.name,
            kind: 'ssh',
            sshProfileID: profile.id,
          } as ServiceTarget;
          return upsertManagerItem(previous, next, (item) => item.id, draft.id || undefined);
        }}
        saveItems={async (nextTargets) => {
          setSavingTargets(true);
          try {
            await SaveServiceTargets(nextTargets);
            syncTargets((await GetServiceTargets()) ?? []);
          } finally {
            setSavingTargets(false);
          }
        }}
        saving={savingTargets}
        renderMeta={(item) =>
          item.id === 'local' || item.kind === 'local' ? (
            <span>{t('serviceManagerTool.localTarget')}</span>
          ) : (
            <>
              <span>{t('serviceManagerTool.targetKindSsh')}</span>
              {!profiles.some((profile) => profile.id === item.sshProfileID) ? (
                <Badge variant="destructive">{t('serviceManagerTool.sshProfileMissing')}</Badge>
              ) : null}
            </>
          )
        }
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
              <SSHProfileFormField
                value={draft.sshProfileID ?? ''}
                onSelect={(profile) =>
                  setDraft({
                    ...draft,
                    sshProfileID: profile?.id ?? '',
                    name: draft.name.trim() || profile?.name || draft.name,
                  })
                }
                placeholder={t('serviceManagerTool.selectSSHProfile')}
              />
            </div>
          </>
        )}
        strings={{
          title: t('serviceManagerTool.manageTargetsTitle'),
          edit: t('serviceManagerTool.editTarget'),
          remove: t('serviceManagerTool.removeTarget'),
          dragItem: (name) => t('sidebar.dragTool', { name }),
          empty: t('serviceManagerTool.targetHostsEmpty'),
          emptyHint: t('serviceManagerTool.targetHostsEmptyHint'),
          save: t('common.save'),
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
        open={pendingUnpick !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnpick(null);
        }}
        title={t(
          pendingUnpick?.all
            ? 'serviceManagerTool.unpickAllTitle'
            : 'serviceManagerTool.unpickTitle',
        )}
        description={
          pendingUnpick?.all
            ? t('serviceManagerTool.unpickAllConfirm', {
                total: pendingUnpick.members.length,
              })
            : t('serviceManagerTool.unpickConfirm', {
                name: pendingUnpick?.name ?? '',
              })
        }
        confirmLabel={t(
          pendingUnpick?.all ? 'serviceManagerTool.unpickAll' : 'serviceManagerTool.unpick',
        )}
        destructive
        busy={unpicking}
        onConfirm={() => void confirmUnpick()}
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
        open={pickDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPickDialog(null);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col sm:max-w-md">
          <DialogHeader className="flex-none">
            <DialogTitle>{t('serviceManagerTool.pickSelectTitle')}</DialogTitle>
            <DialogDescription>
              {pickDialog
                ? t('serviceManagerTool.pickSelectDesc', {
                    name: pickDialog.resource.name || pickDialog.resource.id,
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1 overscroll-contain [padding-inline-end:var(--overlay-scrollbar-size)]">
            <div className="divide-y divide-border">
              {(pickDialog?.containers ?? []).map((container) => (
                <Label
                  key={container.id}
                  htmlFor={`pick-container-${container.id}`}
                  className="cursor-pointer gap-2 py-2 font-normal"
                >
                  <Checkbox
                    id={`pick-container-${container.id}`}
                    checked={pickSelection.has(container.id)}
                    onCheckedChange={(checked) =>
                      togglePickContainer(container.id, checked === true)
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{container.name || container.id}</span>
                  <Badge variant={statusVariant(container.status)}>{container.status || '—'}</Badge>
                </Label>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="flex-none">
            <Button variant="outline" onClick={() => setPickDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={pickSelection.size === 0} onClick={() => confirmPickSelection()}>
              {t('serviceManagerTool.pick')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Reveal>
  );
}
