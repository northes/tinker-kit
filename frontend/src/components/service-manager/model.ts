import { useTranslation } from 'react-i18next';
import type {
  DockerContainer,
  LogMonitor,
  ServiceInventory,
  ServiceLogLine,
  ServiceResourceRef,
  ServiceTarget,
} from '../../../bindings/tinkerkit/models';
import { backendErrorKey } from '../../lib/backend-error';
import { sourceLabel } from '../../lib/local-source';

export const MANAGE_TARGETS_VALUE = '__manage-targets__';

export const VISIBLE_LOG_LIMIT = 5000;

const LOG_LIMIT_ERROR_KEY = 'errors.service.logMonitorLimitReached';

export const LOCAL_TARGET: ServiceTarget = { id: 'local', name: '本机', kind: 'local' };

export type Runtime = 'docker' | 'pm2' | 'systemd';

export type Selection = {
  targetID: string;
  resource: ServiceResourceRef;
  kind: 'container' | 'group' | 'pm2' | 'systemd' | 'host' | 'picked';
};

// 已挑选成员：用户显式挑选的容器或服务，与自动采集的日志监控相互独立。
export type PickedMember = { targetID: string; resource: ServiceResourceRef };

export const PICKED_SELECTION: Selection = {
  targetID: '',
  resource: { runtime: 'picked', id: 'picked' },
  kind: 'picked',
};

export type LogEvent = { lines?: ServiceLogLine[] };

// 每个运行时支持的状态，作为状态筛选里的分组。
export const STATUS_GROUPS: Array<{ runtime: Runtime; statuses: string[] }> = [
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

export function statusKey(runtime: Runtime, status: string) {
  return `${runtime}:${status}`;
}

export function matchesStatusFilter(statuses: Set<string>, runtime: Runtime, status: string) {
  return statuses.size === 0 || statuses.has(statusKey(runtime, status));
}

export function runtimeFiltered(statuses: Set<string>, runtime: Runtime) {
  if (statuses.size === 0) return true;
  for (const key of statuses) {
    if (key.startsWith(`${runtime}:`)) return true;
  }
  return false;
}

export function resourceKey(resource: ServiceResourceRef) {
  return `${resource.runtime}|${resource.scope ?? ''}|${resource.id}`;
}

export function pickedMemberKey(member: PickedMember) {
  return `${member.targetID}|${resourceKey(member.resource)}`;
}

export function monitorResourceKey(monitor: LogMonitor) {
  return resourceKey(monitor.resource);
}

// Compose 组对应的容器列表。
export function composeGroupContainers(
  resource: ServiceResourceRef,
  inventory: ServiceInventory | null,
) {
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
export function resourceRefsFor(
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
export function isLogLimitFailure(monitor: LogMonitor) {
  return monitor.state === 'failed' && backendErrorKey(monitor.error) === LOG_LIMIT_ERROR_KEY;
}

export function statusVariant(value: string) {
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

export function dayKeyOf(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function logTime(line: ServiceLogLine) {
  const date = logDate(line);
  if (!date) return line.timestamp || line.receivedAt || '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function logDayKey(line: ServiceLogLine) {
  const date = logDate(line);
  return date ? dayKeyOf(date) : '';
}

export function targetLabel(target: ServiceTarget, t: ReturnType<typeof useTranslation>['t']) {
  return sourceLabel(target, t('serviceManagerTool.localTarget'));
}
