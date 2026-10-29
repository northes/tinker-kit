import { ArrowsClockwise, CodeSimple, XCircle } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DockerContainer,
  DockerContainerSize,
  LogMonitor,
  ServiceResourceRef,
  ServiceTarget,
} from '../../../bindings/tinkerkit/models';
import {
  GetDockerContainerDetail,
  GetDockerContainerSize,
  GetPM2ProcessDetail,
  GetSystemdUnitDetail,
} from '../../../bindings/tinkerkit/servicemanagerservice';
import { formatBackendError } from '../../lib/backend-error';
import { formatMetricBytes as formatBytes } from '../../lib/byte-format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../ui/popover';
import { ScrollArea } from '../ui/scroll-area';
import { PixelAlignedSpinner } from '../PixelAlignedSpinner';
import { ToolCanceledState, ToolLoadingState } from '../shared';
import { STATUS_GROUPS, statusVariant, targetLabel, type Selection } from './model';
import { type ContainerInfo } from './ResourcePanel';

type CancellableCall = { cancel: (cause?: unknown) => PromiseLike<void> | void };

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

function ContainerSizePopover({
  size,
  loading,
  canceled,
  error,
}: {
  size: DockerContainerSize | null;
  loading: boolean;
  canceled: boolean;
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
        {loading ? <PixelAlignedSpinner /> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle>{t('serviceManagerTool.detail.sizeBreakdown')}</PopoverTitle>
          {loading && size ? <PixelAlignedSpinner /> : null}
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
            {loading ? (
              <PixelAlignedSpinner />
            ) : canceled ? (
              t('common.canceled')
            ) : (
              t('serviceManagerTool.detail.sizeUnavailable')
            )}
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

export function ScopeInfoTab({
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
            {selection.kind === 'picked' ? hostIDs.length : selection.resource.name}
          </InfoField>
          <InfoField label={t('serviceManagerTool.scopeInfo.members')}>{monitors.length}</InfoField>
          {STATUS_GROUPS.map(({ runtime }) => (
            <InfoField key={runtime} label={t(`serviceManagerTool.runtimes.${runtime}`)}>
              {monitors.filter((item) => item.resource.runtime === runtime).length}
            </InfoField>
          ))}
        </InfoFields>
      </InfoSection>
      {selection.kind === 'picked' && hostIDs.length ? (
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
                  {t('serviceManagerTool.pickedCount', {
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
  sizeCanceled,
  sizeError,
  onCancelSize,
  onRetrySize,
}: {
  info: ContainerInfo;
  containerSize: DockerContainerSize | null;
  sizeLoading: boolean;
  sizeCanceled: boolean;
  sizeError: string;
  onCancelSize: () => void;
  onRetrySize: () => void;
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
              <span className="inline-flex flex-wrap items-center gap-2">
                <ContainerSizePopover
                  size={containerSize}
                  loading={sizeLoading}
                  canceled={sizeCanceled}
                  error={sizeError}
                />
                {sizeLoading ? (
                  <Button variant="ghost" size="xs" className="text-[10px]" onClick={onCancelSize}>
                    <XCircle weight="duotone" data-icon="inline-start" size={12} />
                    {t('common.cancel')}
                  </Button>
                ) : null}
                {sizeCanceled && !sizeLoading ? (
                  <Button variant="ghost" size="xs" className="text-[10px]" onClick={onRetrySize}>
                    <ArrowsClockwise weight="duotone" data-icon="inline-start" size={12} />
                    {t('common.retry')}
                  </Button>
                ) : null}
              </span>
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

export function ResourceInfoTab({
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
  const [sizeCanceled, setSizeCanceled] = useState(false);
  const [sizeError, setSizeError] = useState('');
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailCanceled, setDetailCanceled] = useState(false);
  const [error, setError] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const detailRequestVersion = useRef(0);
  const sizeRequestVersion = useRef(0);
  const detailRequest = useRef<CancellableCall | null>(null);
  const sizeRequest = useRef<CancellableCall | null>(null);
  const isGroup = resource.runtime === 'docker-compose';
  const info = infoState?.identity === identity ? infoState.value : null;
  const containerSize = sizeState?.identity === identity ? sizeState.value : null;
  const retryDetail = () => setReloadToken((value) => value + 1);

  const cancelDetail = () => {
    const request = detailRequest.current;
    if (!request) return;
    detailRequest.current = null;
    detailRequestVersion.current++;
    void request.cancel();
    setDetailLoading(false);
    setDetailCanceled(true);
    setError('');
  };
  const cancelSize = () => {
    const request = sizeRequest.current;
    if (!request) return;
    sizeRequest.current = null;
    sizeRequestVersion.current++;
    void request.cancel();
    setSizeLoading(false);
    setSizeCanceled(true);
    setSizeError('');
  };

  useEffect(() => {
    const detailVersion = ++detailRequestVersion.current;
    const sizeVersion = ++sizeRequestVersion.current;
    detailRequest.current?.cancel();
    sizeRequest.current?.cancel();
    detailRequest.current = null;
    sizeRequest.current = null;
    setDetailCanceled(false);
    setSizeCanceled(false);
    if (isGroup) {
      setDetailLoading(false);
      setSizeLoading(false);
      return;
    }
    setError('');
    setDetailLoading(true);
    let detailCall: CancellableCall;
    let detailResult: Promise<ContainerInfo>;
    if (resource.runtime === 'docker') {
      const call = GetDockerContainerDetail(targetID, resource.id);
      detailCall = call;
      detailResult = call.then((detail) => ({ runtime: 'docker', detail }));
    } else if (resource.runtime === 'pm2') {
      const call = GetPM2ProcessDetail(targetID, resource.id);
      detailCall = call;
      detailResult = call.then((detail) => ({ runtime: 'pm2', detail }));
    } else {
      const call = GetSystemdUnitDetail(targetID, resource.id, resource.scope ?? 'system');
      detailCall = call;
      detailResult = call.then((detail) => ({ runtime: 'systemd', detail }));
    }
    detailRequest.current = detailCall;
    void detailResult
      .then((next) => {
        if (detailRequestVersion.current === detailVersion) setInfoState({ identity, value: next });
      })
      .catch((reason) => {
        if (detailRequestVersion.current === detailVersion) setError(formatBackendError(reason));
      })
      .finally(() => {
        if (detailRequest.current === detailCall) detailRequest.current = null;
        if (detailRequestVersion.current === detailVersion) setDetailLoading(false);
      });
    let sizeCall: CancellableCall | null = null;
    if (resource.runtime === 'docker') {
      const call = GetDockerContainerSize(targetID, resource.id);
      sizeCall = call;
      sizeRequest.current = call;
      setSizeLoading(true);
      setSizeError('');
      void call
        .then((next) => {
          if (sizeRequestVersion.current === sizeVersion) setSizeState({ identity, value: next });
        })
        .catch((reason) => {
          if (sizeRequestVersion.current === sizeVersion) setSizeError(formatBackendError(reason));
        })
        .finally(() => {
          if (sizeRequest.current === call) sizeRequest.current = null;
          if (sizeRequestVersion.current === sizeVersion) setSizeLoading(false);
        });
    } else {
      setSizeLoading(false);
      setSizeError('');
    }
    return () => {
      detailRequestVersion.current++;
      sizeRequestVersion.current++;
      if (detailRequest.current === detailCall) {
        detailRequest.current = null;
        void detailCall.cancel();
      }
      if (sizeCall && sizeRequest.current === sizeCall) {
        sizeRequest.current = null;
        void sizeCall.cancel();
      }
    };
  }, [identity, isGroup, refreshToken, reloadToken]);

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
          ) : !info && detailCanceled ? (
            <ToolCanceledState
              className="h-full"
              onRetry={retryDetail}
              retryLabel={t('serviceManagerTool.refresh')}
            />
          ) : !info ? (
            <ToolLoadingState
              className="h-full"
              label={t('common.loading')}
              onCancel={detailLoading ? cancelDetail : undefined}
            />
          ) : (
            <ContainerInfoView
              info={info}
              containerSize={containerSize}
              sizeLoading={sizeLoading}
              sizeCanceled={sizeCanceled}
              sizeError={sizeError}
              onCancelSize={cancelSize}
              onRetrySize={retryDetail}
            />
          )}
        </ScrollArea>
        <div className="flex items-center justify-end border-t px-4 py-2">
          <Button variant="outline" size="sm" disabled={!info} onClick={() => setRawOpen(true)}>
            <CodeSimple weight="duotone" data-icon="inline-start" />
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
