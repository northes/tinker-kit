import { ArrowsClockwise, CaretLeft, Package, XCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { DockerImageDetail } from '../../../bindings/tinkerkit/models';
import {
  Reveal,
  ToolActionButton,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutHeader,
  ToolLayoutToolbar,
} from '../shared';
import { ScrollArea } from '../ui/scroll-area';
import { Spinner } from '../ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { asStringList, formatBytes, formatCreatedAt, formatRawJSON, labelEntries } from './model';

export function ImageManagerDetailView({
  active,
  detail,
  error,
  loading,
  canceled,
  onCancel,
  onRetry,
  onBack,
}: {
  active: boolean;
  detail: DockerImageDetail | null;
  error: string;
  loading: boolean;
  canceled: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const unnamed = t('imageManagerTool.unnamed');
  const detailMetadataRows = detail
    ? [
        { key: 'id', label: t('imageManagerTool.detailId'), value: detail.id },
        {
          key: 'names',
          label: t('imageManagerTool.detailNames'),
          value:
            [...new Set([detail.name, ...asStringList(detail.tags)].filter(Boolean))].join(', ') ||
            unnamed,
        },
        {
          key: 'repository',
          label: t('imageManagerTool.detailRepository'),
          value: detail.repository,
        },
        {
          key: 'size',
          label: t('imageManagerTool.detailSize'),
          value: formatBytes(detail.size, i18n.language),
        },
        { key: 'digest', label: t('imageManagerTool.detailDigest'), value: detail.digest },
        { key: 'mediaType', label: t('imageManagerTool.detailMediaType'), value: detail.mediaType },
        { key: 'sizeType', label: t('imageManagerTool.detailSizeType'), value: detail.sizeType },
        {
          key: 'manifest',
          label: t('imageManagerTool.detailManifest'),
          value: detail.manifest
            ? `${detail.manifest.mediaType} · ${t('imageManagerTool.manifestSize', { size: formatBytes(detail.manifest.config.size + (detail.manifest.layers ?? []).reduce((total, layer) => total + layer.size, 0), i18n.language) })}`
            : detail.index
              ? t('imageManagerTool.detailIndex')
              : '',
        },
        {
          key: 'platforms',
          label: t('imageManagerTool.detailPlatforms'),
          value: detail.index?.manifests
            ?.map((item) =>
              item.platform
                ? `${item.platform.os}/${item.platform.architecture}${item.platform.variant ? `/${item.platform.variant}` : ''}`
                : '',
            )
            .filter(Boolean)
            .join(', '),
        },
        {
          key: 'createdAt',
          label: t('imageManagerTool.detailCreated'),
          value: formatCreatedAt(detail.metadata.createdAt || detail.createdAt, i18n.language),
        },
        {
          key: 'architecture',
          label: t('imageManagerTool.detailArchitecture'),
          value: detail.metadata.architecture || detail.architecture,
        },
        {
          key: 'os',
          label: t('imageManagerTool.detailOs'),
          value: detail.metadata.os || detail.os,
        },
        {
          key: 'osVersion',
          label: t('imageManagerTool.detailOsVersion'),
          value: detail.metadata.osVersion,
        },
        {
          key: 'variant',
          label: t('imageManagerTool.detailVariant'),
          value: detail.metadata.variant,
        },
        { key: 'author', label: t('imageManagerTool.detailAuthor'), value: detail.metadata.author },
        {
          key: 'dockerVersion',
          label: t('imageManagerTool.detailDockerVersion'),
          value: detail.metadata.dockerVersion,
        },
        {
          key: 'container',
          label: t('imageManagerTool.detailContainer'),
          value: detail.metadata.container,
        },
        {
          key: 'configDigest',
          label: t('imageManagerTool.detailConfigDigest'),
          value: detail.metadata.configDigest,
        },
        {
          key: 'rootfsType',
          label: t('imageManagerTool.detailRootfsType'),
          value: detail.metadata.rootfsType,
        },
        {
          key: 'diffIDs',
          label: t('imageManagerTool.detailDiffIDs'),
          value: asStringList(detail.metadata.diffIDs).join('\n'),
        },
      ]
    : [];

  const runtime = detail?.runtime;
  const healthcheck = runtime?.healthcheck;
  const runtimeHealthcheck = healthcheck
    ? [
        `${t('imageManagerTool.detailRuntimeHealthcheckTest')}: ${asStringList(healthcheck.test).join(' ') || t('imageManagerTool.emptyValue')}`,
        healthcheck.interval
          ? `${t('imageManagerTool.detailRuntimeHealthcheckInterval')}: ${healthcheck.interval}`
          : '',
        healthcheck.timeout
          ? `${t('imageManagerTool.detailRuntimeHealthcheckTimeout')}: ${healthcheck.timeout}`
          : '',
        healthcheck.startPeriod
          ? `${t('imageManagerTool.detailRuntimeHealthcheckStartPeriod')}: ${healthcheck.startPeriod}`
          : '',
        healthcheck.retries > 0
          ? `${t('imageManagerTool.detailRuntimeHealthcheckRetries')}: ${healthcheck.retries}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const runtimeRows = detail
    ? [
        {
          key: 'command',
          label: t('imageManagerTool.detailCommand'),
          value: asStringList(runtime?.command ?? detail.command).join(' '),
        },
        {
          key: 'entrypoint',
          label: t('imageManagerTool.detailEntrypoint'),
          value: asStringList(runtime?.entrypoint ?? detail.entrypoint).join(' '),
        },
        { key: 'user', label: t('imageManagerTool.detailRuntimeUser'), value: runtime?.user ?? '' },
        {
          key: 'workingDir',
          label: t('imageManagerTool.detailRuntimeWorkingDir'),
          value: runtime?.workingDir ?? '',
        },
        {
          key: 'env',
          label: t('imageManagerTool.detailRuntimeEnv'),
          value: asStringList(runtime?.env).join('\n'),
        },
        {
          key: 'exposedPorts',
          label: t('imageManagerTool.detailRuntimeExposedPorts'),
          value: asStringList(runtime?.exposedPorts).join('\n'),
        },
        {
          key: 'volumes',
          label: t('imageManagerTool.detailRuntimeVolumes'),
          value: asStringList(runtime?.volumes).join('\n'),
        },
        {
          key: 'stopSignal',
          label: t('imageManagerTool.detailRuntimeStopSignal'),
          value: runtime?.stopSignal ?? '',
        },
        {
          key: 'shell',
          label: t('imageManagerTool.detailRuntimeShell'),
          value: asStringList(runtime?.shell).join(' '),
        },
        {
          key: 'healthcheck',
          label: t('imageManagerTool.detailRuntimeHealthcheck'),
          value: runtimeHealthcheck,
        },
        {
          key: 'tty',
          label: t('imageManagerTool.detailRuntimeTty'),
          value: runtime?.tty
            ? t('imageManagerTool.booleanTrue')
            : t('imageManagerTool.booleanFalse'),
        },
        {
          key: 'openStdin',
          label: t('imageManagerTool.detailRuntimeOpenStdin'),
          value: runtime?.openStdin
            ? t('imageManagerTool.booleanTrue')
            : t('imageManagerTool.booleanFalse'),
        },
        {
          key: 'networkDisabled',
          label: t('imageManagerTool.detailRuntimeNetworkDisabled'),
          value: runtime?.networkDisabled
            ? t('imageManagerTool.booleanTrue')
            : t('imageManagerTool.booleanFalse'),
        },
      ]
    : [];
  const detailLayers =
    detail?.layers && detail.layers.length > 0 ? detail.layers : (detail?.manifest?.layers ?? []);
  const rawManifest = detail ? formatRawJSON(detail.rawManifest) : '';
  const renderDetailRows = (rows: Array<{ key: string; label: string; value?: string }>) =>
    rows.map((row) => {
      const isMono = ['id', 'digest', 'configDigest', 'diffIDs', 'command', 'entrypoint'].includes(
        row.key,
      );
      return (
        <div
          key={row.key}
          className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4"
        >
          <dt className="text-[10px] font-medium text-muted-foreground">{row.label}</dt>
          <dd
            className={`m-0 min-w-0 whitespace-pre-wrap break-words text-[12px] text-foreground ${isMono ? 'font-mono' : ''}`}
          >
            {row.value || t('imageManagerTool.emptyValue')}
          </dd>
        </div>
      );
    });

  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('imageManagerTool.detailTitle')} />
        <ToolLayoutToolbar
          left={
            <ToolActionButton
              variant="tertiary"
              icon={CaretLeft}
              label={t('imageManagerTool.back')}
              onPress={onBack}
            />
          }
        />
        <ToolLayoutContent className="flex min-h-0 flex-col">
          {loading ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
              <Spinner />
              <ToolActionButton
                variant="tertiary"
                icon={XCircle}
                label={t('common.cancel')}
                onPress={onCancel}
              />
            </div>
          ) : canceled ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <XCircle size={16} weight="duotone" className="text-muted-foreground" />
              <div className="text-sm text-muted-foreground">
                {t('imageManagerTool.detailCanceled')}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('imageManagerTool.detailCanceledHint')}
              </div>
              <ToolActionButton
                variant="secondary"
                icon={ArrowsClockwise}
                label={t('common.retry')}
                onPress={onRetry}
                className="mt-2"
              />
            </div>
          ) : error ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <Package size={28} weight="duotone" className="text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {t('imageManagerTool.loadFailed')}
              </div>
              <div className="max-w-md text-xs text-muted-foreground">{error}</div>
            </div>
          ) : detail ? (
            <ScrollArea
              className="h-full min-h-0 [padding-inline-end:var(--overlay-scrollbar-size)]"
              options={{ overflow: { x: 'hidden' } }}
            >
              <section aria-labelledby="image-detail-metadata" className="mt-3">
                <h3
                  id="image-detail-metadata"
                  className="m-0 text-[12px] font-semibold text-foreground"
                >
                  {t('imageManagerTool.detailMetadata')}
                </h3>
                <dl className="mt-2 divide-y divide-border">
                  {renderDetailRows(detailMetadataRows)}
                </dl>
                <dl className="divide-y divide-border">
                  <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
                    <dt className="text-[10px] font-medium text-muted-foreground">
                      {t('imageManagerTool.detailLabels')}
                    </dt>
                    <dd className="m-0 min-w-0">
                      {labelEntries(detail.labels).length === 0 ? (
                        <p className="m-0 text-[12px] text-muted-foreground">
                          {t('imageManagerTool.labelsEmpty')}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {labelEntries(detail.labels).map(([key, value]) => (
                            <div key={key} className="flex flex-col gap-0.5">
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {key}
                              </span>
                              <span className="break-words text-[12px] text-foreground">
                                {value}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="image-detail-layers" className="mt-6">
                <h3
                  id="image-detail-layers"
                  className="m-0 text-[12px] font-semibold text-foreground"
                >
                  {t('imageManagerTool.detailLayers')}
                </h3>
                {detailLayers.length === 0 ? (
                  <p className="mt-2 text-[12px] text-muted-foreground">
                    {t('imageManagerTool.layersEmpty')}
                  </p>
                ) : (
                  <ScrollArea className="mt-2 border-y border-border">
                    <Table className="min-w-[42rem] text-[11px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-14">
                            {t('imageManagerTool.detailLayerIndex')}
                          </TableHead>
                          <TableHead>{t('imageManagerTool.detailLayerSize')}</TableHead>
                          <TableHead>{t('imageManagerTool.detailLayerDigest')}</TableHead>
                          <TableHead>{t('imageManagerTool.detailLayerMediaType')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detailLayers.map((layer, index) => (
                          <TableRow key={`${layer.digest}-${index}`}>
                            <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                            <TableCell className="whitespace-nowrap">
                              {layer.size > 0
                                ? formatBytes(layer.size, i18n.language)
                                : t('imageManagerTool.emptyValue')}
                            </TableCell>
                            <TableCell className="max-w-[24rem] break-all font-mono">
                              {layer.digest || t('imageManagerTool.emptyValue')}
                            </TableCell>
                            <TableCell className="max-w-[20rem] break-all font-mono">
                              {layer.mediaType || t('imageManagerTool.emptyValue')}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </section>

              <section aria-labelledby="image-detail-runtime" className="mt-6">
                <h3
                  id="image-detail-runtime"
                  className="m-0 text-[12px] font-semibold text-foreground"
                >
                  {t('imageManagerTool.detailRuntime')}
                </h3>
                <dl className="mt-2 divide-y divide-border">{renderDetailRows(runtimeRows)}</dl>
              </section>

              <section aria-labelledby="image-detail-raw-manifest" className="mt-6 pb-6">
                <h3
                  id="image-detail-raw-manifest"
                  className="m-0 text-[12px] font-semibold text-foreground"
                >
                  {t('imageManagerTool.detailRawManifest')}
                </h3>
                {rawManifest ? (
                  <ScrollArea
                    element="pre"
                    className="mt-2 max-h-[32rem] whitespace-pre-wrap break-all border-y border-border p-3 font-mono text-[11px] leading-5 text-foreground"
                  >
                    {rawManifest}
                  </ScrollArea>
                ) : (
                  <p className="mt-2 text-[12px] text-muted-foreground">
                    {t('imageManagerTool.rawManifestEmpty')}
                  </p>
                )}
              </section>
            </ScrollArea>
          ) : null}
        </ToolLayoutContent>
      </ToolLayout>
    </Reveal>
  );
}
