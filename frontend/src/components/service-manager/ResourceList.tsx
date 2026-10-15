import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  CaretDown,
  Copy,
  Cube,
  Pause,
  Play,
  Plus,
  Power,
  Stack,
  Trash,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DockerComposeGroup,
  DockerContainer,
  ServiceInventory,
  ServiceResourceRef,
  SystemdUnit,
} from '../../../bindings/tinkerkit/models';
import { Button } from '../ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { ScrollArea } from '../ui/scroll-area';
import { Spinner } from '../ui/spinner';
import { toast } from '../ui/toast';
import {
  matchesStatusFilter,
  resourceKey,
  runtimeFiltered,
  type Runtime,
  type Selection,
} from './model';
import { RuntimeError } from './ResourcePanel';

export function ResourceList({
  targetID,
  inventory,
  pickedResources,
  allowed,
  embedded = false,
  statuses,
  search,
  selection,
  onSelect,
  pickedKeys,
  onAction,
  onPickChange,
  busy,
  t,
}: {
  targetID: string;
  inventory: ServiceInventory | null;
  pickedResources?: ServiceResourceRef[];
  allowed?: Set<string>;
  embedded?: boolean;
  statuses: Set<string>;
  search: string;
  selection: Selection | null;
  onSelect: (next: Selection) => void;
  pickedKeys: Set<string>;
  onAction: (targetID: string, resource: ServiceResourceRef, action: string) => void;
  onPickChange: (targetID: string, resource: ServiceResourceRef) => void;
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
  if (!inventory && !pickedResources)
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-2 text-center">
          <Spinner />
          <span className="text-sm text-muted-foreground">{t('serviceManagerTool.loading')}</span>
        </div>
      </div>
    );
  const match = (name: string) => !search || name.toLowerCase().includes(search);
  const containersByID = new Map(
    [
      ...(inventory?.containers ?? []),
      ...(inventory?.dockerGroups ?? []).flatMap((group) => group.containers ?? []),
    ].map((container) => [container.id, container]),
  );
  const matchContainer = (container: DockerContainer) =>
    match(
      [
        container.name,
        container.id,
        container.image,
        container.composeService,
        ...(container.ports ?? []),
      ].join(' '),
    );
  const copyText = async (
    value: string,
    failureKey:
      | 'serviceManagerTool.copyIdFailed'
      | 'serviceManagerTool.copyNameFailed'
      | 'serviceManagerTool.copyImageFailed',
  ) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      toast.add({ title: t('serviceManagerTool.copiedToClipboard'), type: 'success' });
    } catch {
      toast.add({ title: t(failureKey), type: 'error' });
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
    const container = resource.runtime === 'docker' ? containersByID.get(resource.id) : undefined;
    if (
      !(container
        ? matchContainer(container) || match(resource.group ?? '')
        : match(resource.name || resource.id))
    )
      return null;
    if (!matchesStatusFilter(statuses, resource.runtime as Runtime, status)) return null;
    const active =
      selection &&
      selection.targetID === targetID &&
      resourceKey(selection.resource) === resourceKey(resource);
    const member = pickedKeys.has(`${targetID}|${resourceKey(resource)}`);
    const running = ['running', 'online', 'active'].includes(status.toLowerCase());
    const nested = resource.runtime === 'docker' && Boolean(resource.group);
    const failed = /failed|dead|exited|errored/i.test(status);
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
              className={`flex h-10 w-full items-center gap-2 border-b text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${nested ? 'pl-10 pr-3' : 'px-3'} ${active ? 'bg-muted text-foreground' : 'text-foreground'}`}
              onClick={() => onSelect({ targetID, resource, kind })}
            />
          }
        >
          <span
            aria-hidden="true"
            className={`size-1.5 flex-none rounded-full ${running ? 'bg-success' : failed ? 'bg-destructive' : 'bg-muted-foreground/45'}`}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{resource.name || resource.id}</span>
            {description ? (
              <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                {description}
              </span>
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
              onClick={() => onPickChange(targetID, resource)}
            >
              {member ? <Trash size={14} weight="duotone" /> : <Plus size={14} weight="duotone" />}
              {t(member ? 'serviceManagerTool.unpick' : 'serviceManagerTool.pick')}
            </ContextMenuItem>
          </ContextMenuGroup>
          {resource.runtime === 'docker' ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuGroup>
                <ContextMenuItem
                  onClick={() => void copyText(resource.id, 'serviceManagerTool.copyIdFailed')}
                >
                  <Copy size={14} weight="duotone" />
                  {t('serviceManagerTool.copyId')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    void copyText(resource.name || resource.id, 'serviceManagerTool.copyNameFailed')
                  }
                >
                  <Copy size={14} weight="duotone" />
                  {t('serviceManagerTool.copyName')}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!image}
                  onClick={() => void copyText(image, 'serviceManagerTool.copyImageFailed')}
                >
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
    // 搜索组名、容器、服务名与端口，保留命中的组成员。
    const groupMatched = match(item.name || item.id);
    const visibleContainers = containers.filter(
      (container) =>
        matchesStatusFilter(statuses, 'docker', container.status) &&
        (!allowed || allowed.has(resourceKey({ runtime: 'docker', id: container.id }))) &&
        (groupMatched || matchContainer(container)),
    );
    if (!visibleContainers.length) return null;
    const resource = { runtime: 'docker-compose', id: item.id, name: item.name };
    const active =
      selection?.kind === 'group' &&
      selection.targetID === targetID &&
      resourceKey(selection.resource) === resourceKey(resource);
    const collapsed = !search && collapsedGroups.has(`${targetID}|${item.id}`);
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
                className={`flex h-9 cursor-pointer items-center gap-2 border-b px-3 text-xs font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'bg-muted text-foreground' : 'text-foreground'}`}
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
                size={12}
                className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
              />
            </Button>
            <Stack className="size-4 flex-none text-muted-foreground" weight="duotone" />
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
              <ContextMenuItem onClick={() => onPickChange(targetID, resource)}>
                {visibleContainers.some((container) =>
                  pickedKeys.has(
                    `${targetID}|${resourceKey({ runtime: 'docker', id: container.id })}`,
                  ),
                ) ? (
                  <Trash size={14} weight="duotone" />
                ) : (
                  <Plus size={14} weight="duotone" />
                )}
                {t(
                  visibleContainers.some((container) =>
                    pickedKeys.has(
                      `${targetID}|${resourceKey({ runtime: 'docker', id: container.id })}`,
                    ),
                  )
                    ? 'serviceManagerTool.unpick'
                    : 'serviceManagerTool.pick',
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
      matchContainer(container),
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
  const hasPickedRuntime = (runtime: Runtime) =>
    !allowed || [...allowed].some((key) => key.startsWith(`${runtime}|`));
  const showRuntimeSection = (visibleItems: number) => visibleItems > 0 || (!allowed && !search);
  const content = (
    <>
      {inventory && runtimeFiltered(statuses, 'docker') ? (
        <>
          {inventory.docker.available ? (
            <>
              {(inventory.dockerGroups ?? []).map(group)}
              {standaloneContainers.length ? (
                <>
                  <div className="flex h-8 items-center gap-2 border-b px-3 text-[10px] font-medium tracking-[0.04em] text-muted-foreground">
                    <Cube className="size-3.5" weight="duotone" />
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
          ) : !search && hasPickedRuntime('docker') ? (
            <RuntimeError name="Docker" error={inventory.docker.error} />
          ) : null}
        </>
      ) : null}
      {inventory && runtimeFiltered(statuses, 'pm2') ? (
        <>
          {inventory.pm2.available ? (
            showRuntimeSection(pm2Processes.length) ? (
              <>
                <div className="flex h-8 items-center border-b px-3 text-[10px] font-medium tracking-[0.04em] text-muted-foreground">
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
          ) : !search && hasPickedRuntime('pm2') ? (
            <RuntimeError name="PM2" error={inventory.pm2.error} />
          ) : null}
        </>
      ) : null}
      {inventory && runtimeFiltered(statuses, 'systemd') ? (
        <>
          {inventory.systemd.available ? (
            showRuntimeSection(systemUnits.length) ? (
              <>
                <div className="flex h-8 items-center border-b px-3 text-[10px] font-medium tracking-[0.04em] text-muted-foreground">
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
          ) : !search && hasPickedRuntime('systemd') ? (
            <RuntimeError name="Systemd" error={inventory.systemd.error} />
          ) : null}
        </>
      ) : null}
      {pickedResources
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
