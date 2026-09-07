import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CancelError, Events } from '@wailsio/runtime';
import {
  ArrowsClockwise,
  CaretDown,
  CaretLeft,
  CaretUp,
  Check,
  Copy,
  DownloadSimple,
  HardDrives,
  ListDashes,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import {
  DeleteDockerImages,
  CancelImageTask,
  GetImageTasks,
  GetSSHConfigHosts,
  PushDockerImage,
  RefreshDockerImages,
  RetryImageExport,
  StartImageExport,
  StartImageExports,
  TestImageSourceConnection,
  WatchDockerImages,
} from '../../bindings/changeme/imageservice';
import { ValidateImageSource } from '../../bindings/changeme/configservice';
import type {
  Config as Settings,
  DockerImage,
  DockerImageDetail,
  DockerDeleteTarget,
  DockerStatus,
  ImageSource,
  ImageTask,
  ImageTaskSnapshot,
} from '../../bindings/changeme/models';
import { applyImageTaskSnapshot } from '../lib/image-tasks';
import {
  Reveal,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
  type PendingAction,
  type ToolId,
} from './shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ButtonGroup } from './ui/button-group';
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
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';

const LOCAL_SOURCE_ID = 'local';
const LOCAL_SOURCE = {
  id: LOCAL_SOURCE_ID,
  name: '本机',
  kind: 'local',
  sshHost: '',
} as unknown as ImageSource;
const IMAGE_SEARCH_DEBOUNCE_MS = 120;
const IMAGE_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

type SourceKind = 'local' | 'ssh' | 'registry';
type ManagedImageSource = Omit<
  ImageSource,
  | 'sshPort'
  | 'sshUsername'
  | 'sshPassword'
  | 'sshPrivateKey'
  | 'sshKeyPassphrase'
  | 'sshPrivateKeyPath'
  | 'registryURL'
  | 'registryUsername'
  | 'registryPassword'
> & {
  sshPort?: number | string;
  sshUsername?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshKeyPassphrase?: string;
  sshPrivateKeyPath?: string;
  registryURL?: string;
  registryUsername?: string;
  registryPassword?: string;
  capabilities?: { canDelete?: boolean; canPush?: boolean };
};
type SourceDraft = Partial<ManagedImageSource> &
  Pick<ManagedImageSource, 'name' | 'kind' | 'sshHost'> & { id?: string };

type WatchEventKind = 'snapshot' | 'create' | 'update' | 'delete';

type WatchProgress = {
  scanned?: number;
  total?: number;
  stage?: string;
};

type WatchDockerImagesEvent = {
  clientID: string;
  sourceID: string;
  generation?: number;
  revision?: number;
  kind?: WatchEventKind;
  images?: DockerImage[];
  image?: DockerImage;
  imageID?: string;
  imageIDs?: string[];
  status?: DockerStatus;
  progress?: WatchProgress;
  isUpdating?: boolean;
  isInitialLoad?: boolean;
  hasSnapshot?: boolean;
  snapshotUpdatedAt?: string;
  error?: string;
};

type ConfirmState =
  | { type: 'push'; image: DockerImage }
  | {
      type: 'delete';
      ids: string[];
      targets: DockerDeleteTarget[];
      name: string;
      sourceId: string;
      sourceKind: string;
      sourceConfigKey: string;
    }
  | null;

type SourceViewState = 'connecting' | 'unavailable' | 'loading-details' | 'updating' | 'connected';
type ContentViewState = 'loading' | 'error' | 'empty' | 'no-results' | 'table';

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.error === 'string' && value.error) return value.error;
  }
  return '';
}

// 来源状态只由连接探测、扫描错误和后台更新事件共同决定。
function resolveSourceViewState(
  isConnecting: boolean,
  status: DockerStatus | null,
  loadError: string,
  isUpdating: boolean,
  isInitialLoad: boolean,
): SourceViewState {
  if (isConnecting) return 'connecting';
  if (loadError || !status?.available) return 'unavailable';
  if (isUpdating && isInitialLoad) return 'loading-details';
  if (isUpdating) return 'updating';
  return 'connected';
}

// 内容区优先保留已有数据；只有没有任何镜像时，更新中才显示 loading。
function resolveContentViewState(
  isConnecting: boolean,
  hasSnapshot: boolean,
  imageCount: number,
  filteredCount: number,
  sourceViewState: SourceViewState,
): ContentViewState {
  if (isConnecting && !hasSnapshot && imageCount === 0) return 'loading';
  if (imageCount > 0) return filteredCount > 0 ? 'table' : 'no-results';
  if (hasSnapshot) return 'empty';
  if (sourceViewState === 'unavailable') return 'error';
  if (sourceViewState === 'loading-details' || sourceViewState === 'updating') return 'loading';
  return 'empty';
}

function isWatchCancelError(error: unknown) {
  return error instanceof CancelError || (error instanceof Error && error.name === 'CancelError');
}

function sshSourceId(alias: string) {
  return `ssh:${alias}`;
}

function isLocalSource(source: ImageSource) {
  return source.id === LOCAL_SOURCE_ID || source.kind === 'local';
}

function resolveSources(sources: ImageSource[] | null | undefined): ImageSource[] {
  const list = (sources ?? []).filter((source) => source.id);
  if (list.some(isLocalSource)) return list;
  return [LOCAL_SOURCE, ...list];
}

function sourceDisplayName(source: ImageSource, t: (key: string) => string) {
  return isLocalSource(source)
    ? t('imageManagerTool.localSource')
    : source.name || (source as ManagedImageSource).registryURL || source.sshHost;
}

function bindingSource(source: ManagedImageSource): ImageSource {
  const ssh = source.kind === 'ssh';
  const registry = source.kind === 'registry';
  const registryURL = registry ? (source.registryURL?.trim() ?? '') : '';
  let normalizedRegistryURL = registryURL.replace(/\/+$/, '');
  try {
    const parsed = new URL(registryURL);
    if (parsed.protocol === 'https:') {
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      normalizedRegistryURL = parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // 让服务端返回具体的 URL 校验错误。
  }
  return {
    id: source.id,
    name: source.name.trim(),
    kind: source.kind.trim(),
    sshHost: ssh ? source.sshHost.trim() : '',
    sshPort: ssh ? Number(source.sshPort) || 22 : 0,
    sshUsername: ssh ? (source.sshUsername?.trim() ?? '') : '',
    sshPassword: ssh ? (source.sshPassword ?? '') : '',
    sshPrivateKey: ssh ? (source.sshPrivateKey ?? '') : '',
    sshPrivateKeyPath: ssh ? (source.sshPrivateKeyPath ?? '') : '',
    sshKeyPassphrase: ssh ? (source.sshKeyPassphrase ?? '') : '',
    registryURL: normalizedRegistryURL,
    registryUsername: registry ? (source.registryUsername?.trim() ?? '') : '',
    registryPassword: registry ? (source.registryPassword ?? '') : '',
  } as ImageSource;
}

function asStringList(value: string[] | string | null | undefined) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

function labelEntries(labels: DockerImageDetail['labels']) {
  if (!labels) return [];
  return Object.entries(labels).filter((entry): entry is [string, string] =>
    Boolean(entry[0] && entry[1] != null && entry[1] !== ''),
  );
}

function formatBytes(bytes: number, locale: string) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  })} ${units[unit]}`;
}

function formatRawJSON(value: string) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2) ?? value;
  } catch {
    return value;
  }
}

function parseDateSafe(value: string): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  // 1. 标准 Date 解析（ISO 8601、RFC 3339 等）
  let parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  // 2. 匹配 Go time.String() 格式，例如: "2025-07-15 19:01:16 +0800 CST" 或 "2025-07-15 19:01:16.123456789 +0800 CST m=+0.000000001"
  // 去除尾随的非标准时区缩写/单调时钟，转换为标准 ISO/RFC 格式 "YYYY-MM-DDTHH:mm:ss[.SSS]±HH:MM"
  const goTimeMatch = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-]\d{2})(?::?(\d{2}))?(?:\s+[A-Za-z0-9_-]+)?(?:\s+m=.*)?$/,
  );
  if (goTimeMatch) {
    const [, datePart, timePart, tzHours, tzMinutes = '00'] = goTimeMatch;
    const isoString = `${datePart}T${timePart}${tzHours}:${tzMinutes}`;
    parsed = new Date(isoString);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // 3. 匹配常见无时区格式 "YYYY-MM-DD HH:mm:ss"
  const simpleMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (simpleMatch) {
    const [, datePart, timePart] = simpleMatch;
    parsed = new Date(`${datePart}T${timePart}`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function formatCreatedAt(value: string, locale: string) {
  if (!value) return '';
  const date = parseDateSafe(value);
  return date ? date.toLocaleString(locale) : value;
}

function formatCreatedAtCompact(value: string, locale: string) {
  if (!value) return '';
  const date = parseDateSafe(value);
  if (!date) return value;
  const isCurrentYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(isCurrentYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function shortId(id: string) {
  const value = id.replace(/^sha256:/, '');
  return value.length > 12 ? value.slice(0, 12) : value;
}

function imageLabel(image: DockerImage, unnamed: string) {
  return image.name?.trim() || unnamed;
}

function copyableImageName(source: ImageSource, image: DockerImage, unnamed: string) {
  const name = imageLabel(image, unnamed);
  if (source.kind !== 'registry') return name;
  const registryPrefix = ((source as ManagedImageSource).registryURL ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');
  return registryPrefix && !name.startsWith(`${registryPrefix}/`)
    ? `${registryPrefix}/${name}`
    : name;
}

function registryImageIdentity(image: DockerImage) {
  const digest = image.digest?.trim();
  return digest ? `${image.repository}\u0000${digest}` : '';
}

function associatedRegistryTags(images: DockerImage[], ids: string[]) {
  const selectedIds = new Set(ids);
  const selectedImages = images.filter((image) => selectedIds.has(image.id));
  const identities = new Set(selectedImages.map(registryImageIdentity).filter(Boolean));
  if (identities.size === 0) return [];
  const selectedTags = new Set(selectedImages.flatMap((image) => asStringList(image.tags)));
  return [
    ...new Set(
      images
        .filter((image) => identities.has(registryImageIdentity(image)))
        .flatMap((image) => asStringList(image.tags))
        .filter((tag) => !selectedTags.has(tag)),
    ),
  ];
}

function deleteTargets(images: DockerImage[], ids: string[]): DockerDeleteTarget[] {
  const byID = new Map(images.map((image) => [image.id, image]));
  return ids.map((imageID) => ({
    imageID,
    expectedDigest: byID.get(imageID)?.digest?.trim() ?? '',
  }));
}

function ImageSearchField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => onChange(draft), IMAGE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, onChange, value]);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="flex min-w-0 flex-col gap-1 text-[10px] font-medium text-muted-foreground max-[700px]:w-full">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative flex w-[220px] max-w-full items-center max-[700px]:w-full">
        <MagnifyingGlass
          size={14}
          weight="duotone"
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 text-muted-foreground"
        />
        <Input
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          className="h-[30px] pl-8 text-[11px]"
        />
      </div>
    </div>
  );
}

export function ImageManagerDetailView({
  active,
  detail,
  error,
  loading,
  onBack,
  sourceLabel,
}: {
  active: boolean;
  detail: DockerImageDetail | null;
  error: string;
  loading: boolean;
  onBack: () => void;
  sourceLabel: string;
}) {
  const { t, i18n } = useTranslation();
  const unnamed = t('imageManagerTool.unnamed');
  const detailMetadataRows = detail
    ? [
        { key: 'id', label: t('imageManagerTool.detailId'), value: detail.id },
        {
          key: 'names',
          label: t('imageManagerTool.detailNames'),
          value: [detail.name, ...asStringList(detail.tags)].filter(Boolean).join(', ') || unnamed,
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
        <ToolLayoutHeader
          title={t('imageManagerTool.detailTitle')}
          subtitle={sourceLabel || t('imageManagerTool.title')}
        />
        <ToolLayoutToolbar
          left={
            <Button
              variant="ghost"
              onClick={onBack}
              className="h-[30px] flex-none px-[11px] text-[11px]"
            >
              <CaretLeft data-icon="inline-start" weight="duotone" aria-hidden="true" />
              {t('imageManagerTool.back')}
            </Button>
          }
        />
        <ToolLayoutContent className="flex min-h-0 flex-col">
          {loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : error ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <HardDrives size={28} weight="duotone" className="text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {t('imageManagerTool.loadFailed')}
              </div>
              <div className="max-w-md text-xs text-muted-foreground">{error}</div>
            </div>
          ) : detail ? (
            <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto [padding-inline-end:var(--overlay-scrollbar-hit-size)]">
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
                  <div className="mt-2 overflow-x-auto border-y border-border">
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
                  </div>
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
                  <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-all border-y border-border p-3 font-mono text-[11px] leading-5 text-foreground">
                    {rawManifest}
                  </pre>
                ) : (
                  <p className="mt-2 text-[12px] text-muted-foreground">
                    {t('imageManagerTool.rawManifestEmpty')}
                  </p>
                )}
              </section>
            </div>
          ) : null}
        </ToolLayoutContent>
      </ToolLayout>
    </Reveal>
  );
}

type ImageWithSizeBytes = DockerImage & { sizeBytes?: number | null };
type SortKey = 'name' | 'size' | 'createdAt';
type SortDirection = 'asc' | 'desc';

function imageSizeBytes(image: DockerImage) {
  const sizeBytes = (image as ImageWithSizeBytes).sizeBytes;
  if (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes)) return Math.max(0, sizeBytes);
  const match = String(image.size ?? '')
    .trim()
    .match(/^([\d.,]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i);
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] ?? 'B').toLowerCase();
  const exponent =
    unit.startsWith('ki') || unit.startsWith('mi') || unit.startsWith('gi') || unit.startsWith('ti')
      ? ({ b: 0, kib: 1, mib: 2, gib: 3, tib: 4 }[unit] ?? 0)
      : ({ b: 0, kb: 1, mb: 2, gb: 3, tb: 4 }[unit] ?? 0);
  return value * (unit.endsWith('i') || unit.includes('ib') ? 1024 ** exponent : 1000 ** exponent);
}

function imageCreatedAtMs(value: string) {
  const date = parseDateSafe(value);
  return date ? date.getTime() : null;
}

type IndexedImage = {
  image: DockerImage;
  searchId: string;
  searchName: string;
  sizeBytes: number;
  createdAtMs: number | null;
};

export default function ImageManagerTool({
  active,
  settings,
  onSettingsChange,
  onOpenDetail,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  settings: Settings;
  onSettingsChange: (patch: Pick<Settings, 'dockerCLIPath' | 'imageSources'>) => Promise<void>;
  onOpenDetail: (sourceId: string, imageId: string) => void;
  record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t, i18n } = useTranslation();
  const consumed = useRef<PendingAction | null>(null);
  const sourceLabelId = useId();
  const sources = useMemo(() => resolveSources(settings.imageSources), [settings.imageSources]);
  const cliPath = settings.dockerCLIPath ?? '';
  const [sourceId, setSourceId] = useState(LOCAL_SOURCE_ID);
  const source = sources.find((item) => item.id === sourceId) ?? sources[0] ?? LOCAL_SOURCE;
  const [reloadNonce, setReloadNonce] = useState(0);
  const [connectionPending, setConnectionPending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [watchSourceId, setWatchSourceId] = useState<string | null>(null);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'push' | 'delete' | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTab, setManageTab] = useState<'ssh' | 'registry'>('ssh');
  const [editingSource, setEditingSource] = useState<SourceDraft | null>(null);
  const [draftSources, setDraftSources] = useState<ImageSource[]>([]);
  const [savingSources, setSavingSources] = useState(false);
  const [sourceSaveError, setSourceSaveError] = useState('');
  const [sourceDraftError, setSourceDraftError] = useState('');
  const [testingSource, setTestingSource] = useState(false);
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [copiedDigest, setCopiedDigest] = useState<string | null>(null);
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [hostOptions, setHostOptions] = useState<Array<{ alias: string; selected: boolean }>>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const deferredSearch = useDeferredValue(search);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState('');
  const watchClientID = useRef<string | null>(null);
  const watchSourceIDRef = useRef<string | null>(null);
  const [taskSnapshot, setTaskSnapshot] = useState<ImageTaskSnapshot | null>(null);
  const tasks = taskSnapshot?.tasks ?? [];
  const applyTasks = useCallback((snapshot: ImageTaskSnapshot) => {
    setTaskSnapshot((current) => applyImageTaskSnapshot(current, snapshot));
  }, []);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [batchExportStarting, setBatchExportStarting] = useState(false);
  const [retryingTaskID, setRetryingTaskID] = useState<string | null>(null);
  const [taskClock, setTaskClock] = useState(Date.now);
  const sourceConfigKey = JSON.stringify(source);
  const sourceIsChanging = watchSourceId !== source.id;
  const isConnecting = connectionPending || sourceIsChanging;
  const displayedImages = sourceIsChanging ? [] : images;
  const requestWatchReload = useCallback(() => {
    const clientID = watchClientID.current;
    if (clientID && watchSourceIDRef.current === source.id) {
      void RefreshDockerImages(source.id, clientID).catch((error) => {
        setLoadError(errorMessage(error) || t('imageManagerTool.loadFailed'));
      });
      return;
    }
    setConnectionPending(true);
    setLoadError('');
    setReloadNonce((value) => value + 1);
  }, [source.id, t]);
  const restartWatch = useCallback(() => {
    setConnectionPending(true);
    setLoadError('');
    setReloadNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const apply = (snapshot: ImageTaskSnapshot) => {
      if (active) applyTasks(snapshot);
    };
    const off = Events.On('image-manager:tasks', (event) => apply(event.data as ImageTaskSnapshot));
    void GetImageTasks()
      .then(apply)
      .catch(() => undefined);
    return () => {
      active = false;
      off();
    };
  }, [applyTasks]);

  useEffect(() => {
    const now = Date.now();
    const expirations = tasks
      .filter((task) => task.status !== 'queued' && task.status !== 'running')
      .map((task) => Date.parse(task.updatedAt) + IMAGE_TASK_RETENTION_MS)
      .filter((expiresAt) => expiresAt > now);
    if (expirations.length === 0) return;
    const timer = window.setTimeout(() => setTaskClock(Date.now()), Math.min(...expirations) - now);
    return () => window.clearTimeout(timer);
  }, [tasks, taskClock]);

  useEffect(() => {
    if (!sources.some((item) => item.id === sourceId))
      setSourceId(sources[0]?.id ?? LOCAL_SOURCE_ID);
  }, [sourceId, sources]);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    const clientID = crypto.randomUUID();
    const sourceID = source.id;
    watchClientID.current = clientID;
    watchSourceIDRef.current = sourceID;
    let maxRevision = -1;
    let currentGeneration = -1;
    let restarting = false;
    const map = new Map<string, DockerImage>();

    setImages([]);
    setSelected(new Set());
    setWatchSourceId(sourceID);
    setStatus(null);
    setConnectionPending(true);
    setLoadError('');
    setIsUpdating(false);
    setIsInitialLoad(false);
    setHasSnapshot(false);
    setSnapshotUpdatedAt('');

    const offWatch = Events.On('image-manager:watch-docker-images', (event) => {
      const payload = event.data as WatchDockerImagesEvent | undefined;
      if (!mounted || !payload || payload.clientID !== clientID || payload.sourceID !== sourceID) {
        return;
      }

      if (typeof payload.generation === 'number') {
        if (payload.generation < currentGeneration) return;
        if (payload.generation > currentGeneration) {
          currentGeneration = payload.generation;
          maxRevision = -1;
          map.clear();
          setImages([]);
          setHasSnapshot(false);
          setSnapshotUpdatedAt('');
        }
      }

      if (typeof payload.revision === 'number') {
        if (maxRevision >= 0 && payload.revision !== maxRevision + 1) {
          if (!restarting) {
            restarting = true;
            restartWatch();
          }
          return;
        }
        if (payload.revision <= maxRevision) return;
        maxRevision = payload.revision;
      }

      if (payload.status) {
        setStatus(payload.status);
        // 连接态只由后端连接探测结果结束；镜像数据事件不能代表
        // SSH/Registry 已连通或 Docker daemon 可用。
        setConnectionPending(false);
      }
      if (payload.isUpdating !== undefined) {
        setIsUpdating(payload.isUpdating);
      }
      if (payload.isInitialLoad !== undefined) {
        setIsInitialLoad(payload.isInitialLoad);
      }
      if (payload.hasSnapshot !== undefined) {
        setHasSnapshot(payload.hasSnapshot);
      }
      if (payload.snapshotUpdatedAt) {
        setSnapshotUpdatedAt(payload.snapshotUpdatedAt);
      }
      if (payload.progress) {
        const stage = payload.progress.stage;
        if (stage === 'scanning' || stage === 'done') {
          setLoadError('');
        }
        if (stage === 'done' || stage === 'failed') {
          setConnectionPending(false);
        }
      }
      if (payload.error) {
        setLoadError(payload.error);
      }

      const kind =
        payload.kind ?? (payload.images ? 'snapshot' : payload.image ? 'update' : undefined);

      if (kind === 'snapshot') {
        map.clear();
        for (const img of payload.images ?? []) {
          if (img && img.id) {
            map.set(img.id, img);
          }
        }
        setImages(Array.from(map.values()));
      } else if (kind === 'create' || kind === 'update') {
        if (payload.image && payload.image.id) {
          const image = payload.image;
          map.set(image.id, image);
          setImages(Array.from(map.values()));
        }
      } else if (kind === 'delete') {
        const idsToDelete = payload.imageIDs ?? (payload.imageID ? [payload.imageID] : []);
        let changed = false;
        for (const id of idsToDelete) {
          if (map.delete(id)) {
            changed = true;
          }
        }
        if (changed) {
          setImages(Array.from(map.values()));
        }
        setSelected((current) => {
          const next = new Set(current);
          let selChanged = false;
          for (const id of idsToDelete) {
            if (next.delete(id)) selChanged = true;
          }
          return selChanged ? next : current;
        });
      }
    });

    const watchCall = WatchDockerImages(sourceID, clientID);
    void watchCall.catch((error) => {
      if (!mounted || isWatchCancelError(error)) return;
      setConnectionPending(false);
      setLoadError(errorMessage(error) || t('imageManagerTool.loadFailed'));
    });

    return () => {
      mounted = false;
      if (watchClientID.current === clientID) watchClientID.current = null;
      if (watchSourceIDRef.current === sourceID) watchSourceIDRef.current = null;
      offWatch();
      if (typeof watchCall?.cancel === 'function') {
        watchCall.cancel();
      }
    };
  }, [
    active,
    cliPath,
    reloadNonce,
    requestWatchReload,
    restartWatch,
    source.id,
    sourceConfigKey,
    t,
  ]);

  useEffect(() => {
    if (!pending || pending.tool !== 'image-manager' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'refresh') {
      requestWatchReload();
      record(
        'image-manager',
        t('imageManagerTool.refreshed'),
        sourceDisplayName(source, t),
        source.id,
      );
    }
  }, [clearPending, pending, record, requestWatchReload, source, t]);

  const unnamed = t('imageManagerTool.unnamed');
  const indexedImages = useMemo<IndexedImage[]>(
    () =>
      displayedImages.map((image) => ({
        image,
        searchId: image.id.toLocaleLowerCase(),
        searchName: imageLabel(image, '').toLocaleLowerCase(),
        sizeBytes: imageSizeBytes(image),
        createdAtMs: imageCreatedAtMs(image.createdAt),
      })),
    [displayedImages],
  );
  const filteredImages = useMemo(() => {
    const query = deferredSearch.trim().toLocaleLowerCase();
    const next = query
      ? indexedImages.filter(
          (item) => item.searchId.includes(query) || item.searchName.includes(query),
        )
      : [...indexedImages];
    const direction = sortDirection === 'asc' ? 1 : -1;
    next.sort((left, right) => {
      if (sortKey === 'createdAt') {
        if (left.createdAtMs === null || right.createdAtMs === null) {
          if (left.createdAtMs === right.createdAtMs) return 0;
          return left.createdAtMs === null ? 1 : -1;
        }
        return (left.createdAtMs - right.createdAtMs) * direction;
      }
      const comparison =
        sortKey === 'name'
          ? left.searchName.localeCompare(right.searchName, i18n.language, {
              sensitivity: 'base',
            })
          : left.sizeBytes - right.sizeBytes;
      return comparison * direction;
    });
    return next.map((item) => item.image);
  }, [deferredSearch, i18n.language, indexedImages, sortDirection, sortKey]);
  const selectedCount = sourceIsChanging ? 0 : selected.size;
  const allSelected =
    filteredImages.length > 0 && filteredImages.every((image) => selected.has(image.id));
  const someSelected = filteredImages.some((image) => selected.has(image.id)) && !allSelected;
  const filteredTotalBytes = useMemo(
    () => filteredImages.reduce((total, image) => total + imageSizeBytes(image), 0),
    [filteredImages],
  );
  const sourceViewState = resolveSourceViewState(
    isConnecting,
    status,
    loadError,
    isUpdating,
    isInitialLoad,
  );
  const contentError = loadError || status?.error || '';
  const contentViewState = resolveContentViewState(
    isConnecting,
    hasSnapshot,
    images.length,
    filteredImages.length,
    sourceViewState,
  );
  const actionBlocked = isConnecting || busy !== null || sourceViewState === 'unavailable';
  const interactionBlocked = busy !== null;
  const registryConfirmDigests =
    confirm?.type === 'delete' && confirm.sourceKind === 'registry'
      ? [
          ...new Set(
            confirm.targets
              .map((target) => target.expectedDigest)
              .filter((digest): digest is string => Boolean(digest)),
          ),
        ]
      : [];
  const registryConfirmTags =
    confirm?.type === 'delete' && confirm.sourceKind === 'registry'
      ? associatedRegistryTags(images, confirm.ids)
      : [];

  useEffect(() => {
    const visibleIds = new Set(filteredImages.map((image) => image.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filteredImages]);

  const changeSort = (nextKey: SortKey) => {
    if (sortKey === nextKey)
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(nextKey);
      setSortDirection('asc');
    }
  };

  const sortLabel = (key: SortKey) =>
    t(
      `imageManagerTool.sort${key === 'createdAt' ? 'Created' : key[0].toUpperCase() + key.slice(1)}`,
    );

  const sortableHeader = (key: SortKey, label: string) => {
    const activeSort = sortKey === key;
    const directionLabel = activeSort
      ? sortDirection === 'asc'
        ? t('imageManagerTool.sortAscending')
        : t('imageManagerTool.sortDescending')
      : t('imageManagerTool.sortNotActive');
    return (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 px-2 text-[11px] font-medium"
        aria-label={t('imageManagerTool.sortBy', {
          column: sortLabel(key),
          direction: directionLabel,
        })}
        onClick={() => changeSort(key)}
      >
        {label}
        {activeSort ? (
          sortDirection === 'asc' ? (
            <CaretUp data-icon="inline-end" aria-hidden="true" />
          ) : (
            <CaretDown data-icon="inline-end" aria-hidden="true" />
          )
        ) : null}
      </Button>
    );
  };

  const openManage = () => {
    setManageTab('ssh');
    setEditingSource(null);
    setHostsError('');
    setHostOptions([]);
    setManageOpen(true);
    setDraftSources(sources);
    setSourceSaveError('');
    setSourceDraftError('');
    setHostsLoading(true);
    void GetSSHConfigHosts()
      .then((hosts) => {
        const aliases = new Map<string, string>();
        for (const host of hosts ?? []) {
          const alias = host.alias?.trim();
          if (alias) aliases.set(alias, alias);
        }
        for (const item of sources) {
          if (!isLocalSource(item) && item.sshHost && !aliases.has(item.sshHost)) {
            aliases.set(item.sshHost, item.name || item.sshHost);
          }
        }
        const selectedIds = new Set(
          sources.filter((item) => !isLocalSource(item)).map((item) => item.id),
        );
        setHostOptions(
          [...aliases.entries()].map(([alias]) => ({
            alias,
            selected: selectedIds.has(sshSourceId(alias)),
          })),
        );
      })
      .catch((error) => {
        setHostsError(errorMessage(error) || t('imageManagerTool.sshHostsFailed'));
      })
      .finally(() => setHostsLoading(false));
  };

  const newSource = (kind: 'ssh' | 'registry') => {
    setManageTab(kind);
    setSourceDraftError('');
    setEditingSource({ id: '', name: '', kind, sshHost: '', sshPort: 22 });
  };

  const editSource = (item: ImageSource) => {
    const kind = (item.kind === 'registry' ? 'registry' : 'ssh') as 'ssh' | 'registry';
    setManageTab(kind);
    setSourceDraftError('');
    setEditingSource({ ...(item as ManagedImageSource), kind });
  };

  const updateDraft = (patch: Partial<SourceDraft>) => {
    setSourceDraftError('');
    setEditingSource((current) => (current ? { ...current, ...patch } : current));
  };

  const sourceCandidate = (draft: SourceDraft, id?: string) => {
    const kind = draft.kind as 'ssh' | 'registry';
    return bindingSource({
      ...draft,
      id: id || draft.id?.trim() || `${kind}:connection-test`,
      kind,
      name: draft.name?.trim() ?? '',
      sshHost: draft.sshHost?.trim() ?? '',
    } as ManagedImageSource);
  };

  const saveSource = async () => {
    if (!editingSource) return;
    const kind = editingSource.kind as SourceKind;
    const id = editingSource.id?.trim() || `${kind}:${crypto.randomUUID()}`;
    try {
      const next = await ValidateImageSource(sourceCandidate(editingSource, id));
      setDraftSources((current) => [
        ...current.filter((item) => !isLocalSource(item) && item.id !== editingSource.id),
        next,
      ]);
      setSourceDraftError('');
      setEditingSource(null);
    } catch (error) {
      setSourceDraftError(errorMessage(error) || t('imageManagerTool.sourceInvalid'));
    }
  };

  const testSourceConnection = async () => {
    if (!editingSource) return;
    setTestingSource(true);
    try {
      await TestImageSourceConnection(sourceCandidate(editingSource));
      setSourceDraftError('');
      toast.add({ title: t('imageManagerTool.connectionSucceeded'), type: 'success' });
    } catch (error) {
      setSourceDraftError(errorMessage(error) || t('imageManagerTool.connectionFailed'));
    } finally {
      setTestingSource(false);
    }
  };

  const removeSource = (id: string) => {
    if (id === LOCAL_SOURCE_ID) return;
    setDraftSources((current) => current.filter((item) => isLocalSource(item) || item.id !== id));
    if (sourceId === id) setSourceId(LOCAL_SOURCE_ID);
  };

  const renderEditForm = () => {
    if (!editingSource) return null;
    return (
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <h3 className="m-0 text-sm font-medium text-foreground">
          {editingSource.id ? t('imageManagerTool.editSource') : t('imageManagerTool.addSource')}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="source-edit-name">{t('imageManagerTool.sourceName')}</Label>
            <Input
              id="source-edit-name"
              value={editingSource.name ?? ''}
              onChange={(e) => updateDraft({ name: e.target.value })}
            />
          </div>
          {editingSource.kind === 'ssh' ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="source-edit-ssh-host">{t('imageManagerTool.sshHost')}</Label>
                <Input
                  id="source-edit-ssh-host"
                  value={editingSource.sshHost ?? ''}
                  onChange={(e) => updateDraft({ sshHost: e.target.value })}
                  placeholder={t('imageManagerTool.sshHostPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="source-edit-ssh-port">{t('imageManagerTool.sshPort')}</Label>
                <Input
                  id="source-edit-ssh-port"
                  type="number"
                  value={editingSource.sshPort ?? 22}
                  onChange={(e) => updateDraft({ sshPort: Number(e.target.value) || 22 })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="source-edit-ssh-username">
                  {t('imageManagerTool.sshUsername')}
                </Label>
                <Input
                  id="source-edit-ssh-username"
                  value={editingSource.sshUsername ?? ''}
                  onChange={(e) => updateDraft({ sshUsername: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="source-edit-ssh-password">
                  {t('imageManagerTool.sshPassword')}
                </Label>
                <Input
                  id="source-edit-ssh-password"
                  type="password"
                  value={editingSource.sshPassword ?? ''}
                  onChange={(e) => updateDraft({ sshPassword: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="source-edit-ssh-privkey">
                  {t('imageManagerTool.sshPrivateKey')}
                </Label>
                <Textarea
                  id="source-edit-ssh-privkey"
                  className="min-h-32 text-xs font-mono"
                  value={editingSource.sshPrivateKey ?? ''}
                  onChange={(e) => updateDraft({ sshPrivateKey: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="source-edit-ssh-passphrase">
                  {t('imageManagerTool.sshKeyPassphrase')}
                </Label>
                <Input
                  id="source-edit-ssh-passphrase"
                  type="password"
                  value={editingSource.sshKeyPassphrase ?? ''}
                  onChange={(e) => updateDraft({ sshKeyPassphrase: e.target.value })}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="source-edit-registry-url">
                  {t('imageManagerTool.registryURL')}
                </Label>
                <Input
                  id="source-edit-registry-url"
                  value={editingSource.registryURL ?? ''}
                  onChange={(e) => updateDraft({ registryURL: e.target.value })}
                  placeholder={t('imageManagerTool.registryURLPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="source-edit-registry-username">
                  {t('imageManagerTool.registryUsername')}
                </Label>
                <Input
                  id="source-edit-registry-username"
                  value={editingSource.registryUsername ?? ''}
                  onChange={(e) => updateDraft({ registryUsername: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="source-edit-registry-password">
                  {t('imageManagerTool.registryPassword')}
                </Label>
                <Input
                  id="source-edit-registry-password"
                  type="password"
                  value={editingSource.registryPassword ?? ''}
                  onChange={(e) => updateDraft({ registryPassword: e.target.value })}
                />
              </div>
            </>
          )}
        </div>
        {sourceDraftError ? (
          <p className="m-0 text-sm text-destructive" role="alert">
            {sourceDraftError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingSource(null);
              setSourceDraftError('');
            }}
          >
            {t('imageManagerTool.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={testingSource}
            onClick={() => void testSourceConnection()}
          >
            {testingSource ? <Spinner data-icon="inline-start" /> : null}
            {t('imageManagerTool.testConnection')}
          </Button>
          <Button size="sm" onClick={() => void saveSource()} disabled={testingSource}>
            {t('imageManagerTool.saveSource')}
          </Button>
        </div>
      </div>
    );
  };

  const saveSources = async () => {
    const local = draftSources.find(isLocalSource) ?? LOCAL_SOURCE;
    const existing = draftSources.filter((item) => !isLocalSource(item));
    const existingIds = new Set(existing.map((item) => item.id));
    const nextSources: ImageSource[] = [
      bindingSource({ ...local, id: LOCAL_SOURCE_ID, kind: 'local' } as ManagedImageSource),
      ...hostOptions
        .filter((host) => host.selected)
        .filter((host) => !existingIds.has(sshSourceId(host.alias)))
        .map((host) =>
          bindingSource({
            id: sshSourceId(host.alias),
            name: host.alias,
            kind: 'ssh',
            sshHost: host.alias,
          } as ManagedImageSource),
        ),
      ...existing
        .filter(
          (item) =>
            !hostOptions.some((host) => sshSourceId(host.alias) === item.id && !host.selected),
        )
        .map((item) => bindingSource(item as ManagedImageSource)),
    ];
    const invalid = nextSources.find((item) =>
      item.kind === 'ssh'
        ? !item.sshHost.trim()
        : item.kind === 'registry'
          ? !item.registryURL.trim()
          : false,
    );
    if (invalid) {
      setSourceSaveError(
        t(
          invalid.kind === 'ssh'
            ? 'imageManagerTool.sshHostRequired'
            : 'imageManagerTool.registryURLRequired',
        ),
      );
      return;
    }
    setSavingSources(true);
    setSourceSaveError('');
    try {
      await onSettingsChange({ dockerCLIPath: cliPath, imageSources: nextSources });
      setManageOpen(false);
    } catch (error) {
      setSourceSaveError(errorMessage(error) || t('imageManagerTool.sourceSaveFailed'));
    } finally {
      setSavingSources(false);
    }
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(filteredImages.map((image) => image.id)) : new Set());
  };

  const toggleRow = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const viewImage = (image: DockerImage) => onOpenDetail(source.id, image.id);

  const copyImageName = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopiedName(name);
      window.setTimeout(
        () => setCopiedName((current) => (current === name ? null : current)),
        1400,
      );
      toast.add({ title: t('imageManagerTool.copied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyFailed'), type: 'error' });
    }
  };

  const copyDigest = async (digest: string) => {
    try {
      await navigator.clipboard.writeText(digest);
      setCopiedDigest(digest);
      window.setTimeout(
        () => setCopiedDigest((current) => (current === digest ? null : current)),
        1400,
      );
      toast.add({ title: t('imageManagerTool.digestCopied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyFailed'), type: 'error' });
    }
  };

  const copyTag = async (tag: string) => {
    try {
      await navigator.clipboard.writeText(tag);
      setCopiedTag(tag);
      window.setTimeout(() => setCopiedTag((current) => (current === tag ? null : current)), 1400);
      toast.add({ title: t('imageManagerTool.tagCopied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyFailed'), type: 'error' });
    }
  };

  const runPush = async (image: DockerImage) => {
    setBusy('push');
    try {
      const result = await PushDockerImage(source.id, image.name || image.id);
      if (!result.success) {
        toast.add({
          title: t('imageManagerTool.actionFailed'),
          description: result.error || undefined,
          type: 'error',
        });
        return;
      }
      toast.add({ title: t('imageManagerTool.pushed') });
      record('image-manager', t('imageManagerTool.push'), imageLabel(image, unnamed), image.id);
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.actionFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const runDelete = async (
    sourceID: string,
    ids: string[],
    targets: DockerDeleteTarget[],
    name: string,
  ) => {
    setBusy('delete');
    try {
      const result = await DeleteDockerImages(sourceID, targets);
      const deleted = result.deleted?.length ?? 0;
      const failures = result.failed ?? [];
      const failed = failures.length;
      if (failed > 0) {
        toast.add({
          title: t('imageManagerTool.deletePartial', { deleted, failed }),
          description: failures
            .map((failure) =>
              t('imageManagerTool.deleteFailureReason', {
                image: failure.imageID,
                reason: failure.error,
              }),
            )
            .join('\n'),
          type: 'warning',
        });
      } else {
        toast.add({ title: t('imageManagerTool.deleted') });
      }
      record('image-manager', t('imageManagerTool.delete'), name, ids.join('\n'));
      setSelected(new Set());
      requestWatchReload();
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.actionFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const confirmAction = () => {
    if (!confirm || busy) return;
    if (confirm.type === 'push') void runPush(confirm.image);
    else if (confirm.sourceConfigKey !== sourceConfigKey) {
      toast.add({ title: t('imageManagerTool.sourceChangedRefresh'), type: 'warning' });
      setConfirm(null);
    } else void runDelete(confirm.sourceId, confirm.ids, confirm.targets, confirm.name);
  };

  const taskCutoff = Date.now() - IMAGE_TASK_RETENTION_MS;
  const visibleTasks = tasks.filter(
    (task) =>
      task.status === 'queued' ||
      task.status === 'running' ||
      Date.parse(task.updatedAt) > taskCutoff,
  );
  const activeTasks = visibleTasks.filter(
    (task) => task.status === 'queued' || task.status === 'running',
  );
  const taskDone = (task: ImageTask) => (task.type === 'export' ? task.bytes : task.completed);
  const taskPercent = (task: ImageTask) =>
    task.status === 'success'
      ? 100
      : task.total > 0
        ? Math.min(100, (taskDone(task) / task.total) * 100)
        : null;
  const taskProgress =
    activeTasks.length === 1 && activeTasks[0].total > 0 ? taskPercent(activeTasks[0]) : null;
  const taskTypeLabel = (task: ImageTask) => {
    if (task.type === 'export') return t('imageManagerTool.taskStageExport');
    if (task.type === 'detail') return t('imageManagerTool.taskStageDetail');
    return t('imageManagerTool.taskStageUpdate');
  };
  const taskSourceLabel = (task: ImageTask) => {
    const taskSource = sources.find((item) => item.id === task.sourceID);
    return taskSource ? sourceDisplayName(taskSource, t) : task.sourceID;
  };
  const taskStatus = (task: ImageTask) =>
    t(`imageManagerTool.taskStatus${task.status.charAt(0).toUpperCase()}${task.status.slice(1)}`);
  const taskStatusVariant = (task: ImageTask): 'secondary' | 'destructive' | 'outline' =>
    task.status === 'failed' ? 'destructive' : task.status === 'canceled' ? 'outline' : 'secondary';
  const taskProgressLabel = (task: ImageTask) => {
    if (task.type === 'export') {
      const completed = formatBytes(task.bytes, i18n.language) || formatBytes(0, i18n.language);
      return task.total > 0 || task.status === 'success'
        ? t('imageManagerTool.taskExportProgress', {
            completed,
            total: formatBytes(task.total || task.bytes, i18n.language),
          })
        : t('imageManagerTool.taskExportProgressUnknown', { completed });
    }
    return t('imageManagerTool.taskProgressCount', {
      completed: task.completed,
      total: task.total,
    });
  };
  const runBatchExport = async () => {
    const imageIDs = filteredImages
      .filter((image) => selected.has(image.id))
      .map((image) => image.name || image.id);
    if (imageIDs.length === 0 || batchExportStarting) return;
    setBatchExportStarting(true);
    try {
      const result = await StartImageExports(source.id, imageIDs);
      if (result.started > 0) {
        applyTasks(result.snapshot);
        setTasksOpen(true);
        record(
          'image-manager',
          t('imageManagerTool.batchExport'),
          t('imageManagerTool.selectedCount', { count: result.started }),
          imageIDs.join('\n'),
        );
      }
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.exportFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setBatchExportStarting(false);
    }
  };
  const runExport = async (image: DockerImage) => {
    try {
      const result = await StartImageExport(source.id, image.name || image.id);
      if (result.started > 0) {
        applyTasks(result.snapshot);
        setTasksOpen(true);
        record(
          'image-manager',
          t('imageManagerTool.exportTar'),
          imageLabel(image, unnamed),
          image.id,
        );
      }
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.exportFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    }
  };
  const retryExport = async (task: ImageTask) => {
    if (retryingTaskID) return;
    setRetryingTaskID(task.id);
    try {
      const result = await RetryImageExport(task.id);
      applyTasks(result.snapshot);
      setTasksOpen(true);
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.exportFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setRetryingTaskID(null);
    }
  };

  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader
          title={t('imageManagerTool.title')}
          subtitle={t('imageManagerTool.subtitle')}
        />
        <ToolLayoutToolbar
          left={
            <div className="flex min-w-0 flex-wrap items-end gap-4 max-[700px]:w-full">
              <div className="flex min-w-0 flex-col gap-1 text-[10px] font-medium text-muted-foreground max-[700px]:w-full">
                <span id={sourceLabelId}>{t('imageManagerTool.source')}</span>
                <Select
                  items={sources.map((item) => ({
                    value: item.id,
                    label: sourceDisplayName(item, t),
                  }))}
                  value={source.id}
                  onValueChange={(value) => {
                    if (value) {
                      setSourceId(value);
                    }
                  }}
                >
                  <SelectTrigger
                    className="h-[30px] w-[220px] max-w-full text-[11px] max-[700px]:w-full"
                    aria-labelledby={sourceLabelId}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {sources.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {sourceDisplayName(item, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ImageSearchField
                id="image-manager-search"
                label={t('imageManagerTool.search')}
                value={search}
                onChange={setSearch}
                placeholder={t('imageManagerTool.searchPlaceholder')}
              />
            </div>
          }
          right={
            <div className="flex min-w-0 flex-wrap items-center gap-2 max-[700px]:w-full max-[700px]:justify-end">
              <Button
                variant="outline"
                className="h-[30px] min-w-[30px] flex-none px-[11px] text-[11px]"
                disabled={busy !== null}
                onClick={() => {
                  requestWatchReload();
                  record(
                    'image-manager',
                    t('imageManagerTool.refreshed'),
                    sourceDisplayName(source, t),
                    source.id,
                  );
                }}
              >
                {sourceViewState === 'connecting' ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                )}
                {t('imageManagerTool.refresh')}
              </Button>
              <Button
                variant="ghost"
                className="h-[30px] flex-none px-[11px] text-[11px]"
                onClick={openManage}
              >
                {t('imageManagerTool.manageSources')}
              </Button>
            </div>
          }
        />
        <ToolLayoutContent className="flex min-h-0 flex-col">
          {contentViewState === 'loading' ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : contentViewState === 'error' ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <HardDrives size={28} weight="duotone" className="text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {t('imageManagerTool.loadFailed')}
              </div>
              <div className="max-w-md text-xs text-muted-foreground">
                {contentError || t('imageManagerTool.loadFailedHint')}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-[30px] px-[11px] text-[11px]"
                onClick={requestWatchReload}
              >
                <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                {t('imageManagerTool.refresh')}
              </Button>
            </div>
          ) : contentViewState === 'empty' || contentViewState === 'no-results' ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <HardDrives size={28} weight="duotone" className="text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {contentViewState === 'no-results'
                  ? t('imageManagerTool.searchNoResults')
                  : t('imageManagerTool.emptyTitle')}
              </div>
              <div className="text-xs text-muted-foreground">
                {contentViewState === 'no-results'
                  ? t('imageManagerTool.searchNoResultsHint')
                  : t('imageManagerTool.emptyHint')}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain [padding-inline-end:var(--overlay-scrollbar-hit-size)]">
              <Table className="min-w-[760px]" containerClassName="overflow-visible">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead className="w-10 whitespace-nowrap">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onCheckedChange={(checked) => toggleAll(checked === true)}
                        aria-label={t('imageManagerTool.selectAll')}
                      />
                    </TableHead>
                    <TableHead className="whitespace-nowrap">
                      {t('imageManagerTool.columnId')}
                    </TableHead>
                    <TableHead
                      className="min-w-40"
                      aria-sort={
                        sortKey === 'name'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('name', t('imageManagerTool.columnName'))}
                    </TableHead>
                    <TableHead
                      className="whitespace-nowrap"
                      aria-sort={
                        sortKey === 'size'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('size', t('imageManagerTool.columnSize'))}
                    </TableHead>
                    <TableHead
                      className="whitespace-nowrap"
                      aria-sort={
                        sortKey === 'createdAt'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('createdAt', t('imageManagerTool.columnCreated'))}
                    </TableHead>
                    <TableHead className="w-32 whitespace-nowrap text-right">
                      {t('imageManagerTool.columnActions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredImages.map((image) => (
                    <TableRow
                      key={image.id}
                      data-state={selected.has(image.id) ? 'selected' : undefined}
                    >
                      <TableCell
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={selected.has(image.id)}
                          onCheckedChange={(checked) => toggleRow(image.id, checked === true)}
                          aria-label={t('imageManagerTool.selectRow')}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="font-mono text-[12px]" title={image.id}>
                          {source.kind === 'registry'
                            ? image.digest
                              ? shortId(image.digest)
                              : t('imageManagerTool.emptyValue')
                            : shortId(image.id)}
                        </span>
                      </TableCell>
                      <TableCell className="min-w-40">
                        <button
                          type="button"
                          className="inline-flex min-w-0 max-w-full cursor-pointer truncate text-left text-foreground hover:text-primary hover:underline hover:underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={interactionBlocked}
                          title={t('imageManagerTool.viewName', {
                            name: imageLabel(image, unnamed),
                          })}
                          aria-label={t('imageManagerTool.viewName', {
                            name: imageLabel(image, unnamed),
                          })}
                          onClick={() => void viewImage(image)}
                        >
                          <span className="truncate">{imageLabel(image, unnamed)}</span>
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatBytes(imageSizeBytes(image), i18n.language) ||
                          t('imageManagerTool.emptyValue')}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap text-muted-foreground"
                        title={formatCreatedAt(image.createdAt, i18n.language)}
                      >
                        {formatCreatedAtCompact(image.createdAt, i18n.language)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <ButtonGroup
                          className="ml-auto flex-none"
                          aria-label={t('imageManagerTool.rowActions')}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={interactionBlocked}
                            onClick={() => void viewImage(image)}
                          >
                            {t('imageManagerTool.view')}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              disabled={interactionBlocked}
                              render={
                                <Button
                                  variant="outline"
                                  size="sm"
                                  aria-label={t('imageManagerTool.moreActions')}
                                />
                              }
                            >
                              <CaretDown weight="duotone" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-32">
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  onClick={() =>
                                    void copyImageName(copyableImageName(source, image, unnamed))
                                  }
                                >
                                  {copiedName === copyableImageName(source, image, unnamed)
                                    ? t('imageManagerTool.copied')
                                    : t('imageManagerTool.copyName')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={actionBlocked}
                                  onClick={() => void runExport(image)}
                                >
                                  <DownloadSimple data-icon="inline-start" weight="duotone" />
                                  {t('imageManagerTool.exportTar')}
                                </DropdownMenuItem>
                                {((source as ManagedImageSource).capabilities?.canPush ??
                                source.kind !== 'registry') ? (
                                  <DropdownMenuItem
                                    disabled={actionBlocked}
                                    onClick={() => setConfirm({ type: 'push', image })}
                                  >
                                    {t('imageManagerTool.push')}
                                  </DropdownMenuItem>
                                ) : null}
                                {((source as ManagedImageSource).capabilities?.canDelete ??
                                true) ? (
                                  <DropdownMenuItem
                                    variant="destructive"
                                    disabled={actionBlocked}
                                    onClick={() =>
                                      setConfirm({
                                        type: 'delete',
                                        ids: [image.id],
                                        targets: deleteTargets(images, [image.id]),
                                        name: imageLabel(image, unnamed),
                                        sourceId: source.id,
                                        sourceKind: source.kind,
                                        sourceConfigKey,
                                      })
                                    }
                                  >
                                    {t('imageManagerTool.delete')}
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </ButtonGroup>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              <span>{t('imageManagerTool.filteredSummary', { count: filteredImages.length })}</span>
              <span>
                {t('imageManagerTool.filteredSize', {
                  size:
                    formatBytes(filteredTotalBytes, i18n.language) ||
                    t('imageManagerTool.emptyValue'),
                })}
              </span>
              {selectedCount > 0 ? (
                <span>{t('imageManagerTool.selectedCount', { count: selectedCount })}</span>
              ) : null}
              {hasSnapshot ? (
                <span title={snapshotUpdatedAt || undefined}>
                  {snapshotUpdatedAt
                    ? t('imageManagerTool.snapshotUpdatedAt', {
                        time: formatCreatedAt(snapshotUpdatedAt, i18n.language),
                      })
                    : t('imageManagerTool.snapshotCached')}
                </span>
              ) : null}
              {hasSnapshot && contentError ? (
                <span className="text-destructive">{contentError}</span>
              ) : null}
              {activeTasks.length > 0 || visibleTasks.length > 0 ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 text-left text-muted-foreground hover:text-foreground"
                  onClick={() => setTasksOpen(true)}
                  aria-label={t('imageManagerTool.backgroundTasks')}
                >
                  {activeTasks.length > 0 ? (
                    <>
                      <span
                        className={`relative h-1.5 w-20 overflow-hidden rounded-full bg-muted ${taskProgress === null ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                        aria-hidden="true"
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-primary"
                          style={{ width: `${taskProgress ?? 0}%` }}
                        />
                      </span>
                      <span>
                        {t('imageManagerTool.backgroundTasksCount', { count: activeTasks.length })}
                      </span>
                    </>
                  ) : (
                    <ListDashes size={14} weight="duotone" aria-hidden="true" />
                  )}
                </button>
              ) : null}
            </div>
            <div className="flex flex-none flex-wrap items-center justify-end gap-2">
              {selectedCount > 0 ? (
                <Button
                  variant="outline"
                  className="h-[30px] flex-none px-[11px] text-[11px]"
                  disabled={actionBlocked || batchExportStarting}
                  onClick={() => void runBatchExport()}
                >
                  {batchExportStarting ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <DownloadSimple data-icon="inline-start" weight="duotone" />
                  )}
                  {t('imageManagerTool.batchExport')}
                </Button>
              ) : null}
              <Button
                variant="destructive"
                className={`h-[30px] flex-none px-[11px] text-[11px]${selectedCount > 0 ? '' : ' invisible pointer-events-none'}`}
                disabled={actionBlocked || selectedCount === 0}
                aria-hidden={selectedCount === 0}
                tabIndex={selectedCount > 0 ? 0 : -1}
                onClick={() =>
                  setConfirm({
                    type: 'delete',
                    ids: [...selected],
                    targets: deleteTargets(images, [...selected]),
                    name: t('imageManagerTool.selectedCount', { count: selectedCount }),
                    sourceId: source.id,
                    sourceKind: source.kind,
                    sourceConfigKey,
                  })
                }
              >
                {busy === 'delete' ? <Spinner data-icon="inline-start" /> : null}
                {t('imageManagerTool.batchDelete')}
              </Button>
            </div>
          </div>
        </ToolLayoutFooter>
        <Dialog open={tasksOpen} onOpenChange={setTasksOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('imageManagerTool.backgroundTasks')}</DialogTitle>
              <DialogDescription>{t('imageManagerTool.backgroundTasksDesc')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 max-h-[55vh] overflow-hidden">
              <div className="min-h-0 max-h-[55vh] overflow-x-hidden overflow-y-auto overscroll-contain [padding-inline-end:var(--overlay-scrollbar-hit-size)] [scrollbar-gutter:auto]">
                {visibleTasks.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    {t('imageManagerTool.backgroundTasksEmpty')}
                  </div>
                ) : (
                  visibleTasks
                    .slice()
                    .reverse()
                    .map((task) => {
                      const running = task.status === 'queued' || task.status === 'running';
                      const percent = taskPercent(task);
                      return (
                        <div
                          key={task.id}
                          className="border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {taskTypeLabel(task)}
                              </div>
                              <div className="flex flex-none items-center gap-1.5">
                                <Badge
                                  variant={taskStatusVariant(task)}
                                  className="h-5 text-[10px]"
                                >
                                  {taskStatus(task)}
                                </Badge>
                                {running ? (
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    className="h-6 px-2 text-[11px]"
                                    onClick={() =>
                                      void CancelImageTask(task.id).catch(() => undefined)
                                    }
                                  >
                                    {t('imageManagerTool.cancelTask')}
                                  </Button>
                                ) : null}
                                {task.type === 'export' && task.status === 'failed' ? (
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={retryingTaskID !== null}
                                    onClick={() => void retryExport(task)}
                                  >
                                    {retryingTaskID === task.id ? (
                                      <Spinner data-icon="inline-start" />
                                    ) : null}
                                    {t('imageManagerTool.retryExport')}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                              <span className="truncate">{taskSourceLabel(task)}</span>
                              {task.imageID ? (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="min-w-0 break-all">{task.imageID}</span>
                                </>
                              ) : null}
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <div
                                className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ${percent === null && running ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                              >
                                <div
                                  className="h-full rounded-full bg-primary"
                                  style={{ width: `${percent ?? 0}%` }}
                                />
                              </div>
                              <span className="flex-none font-mono text-[10px] text-muted-foreground">
                                {taskProgressLabel(task)}
                              </span>
                            </div>
                            {task.error || task.path ? (
                              <div className="mt-1 break-all text-[10px] text-muted-foreground">
                                {task.error || task.path}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTasksOpen(false)}>
                {t('imageManagerTool.cancel')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </ToolLayout>
      <Dialog
        open={manageOpen}
        onOpenChange={(open) => {
          setManageOpen(open);
          if (!open) {
            setEditingSource(null);
            setSourceDraftError('');
          }
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col sm:max-w-lg"
          showCloseButton
        >
          <DialogHeader className="flex-none">
            <DialogTitle>{t('imageManagerTool.manageSourcesTitle')}</DialogTitle>
            <DialogDescription>{t('imageManagerTool.manageSourcesDesc')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [padding-inline-end:var(--overlay-scrollbar-hit-size)]">
            <Tabs
              value={manageTab}
              onValueChange={(value) => {
                setManageTab(value as 'ssh' | 'registry');
              }}
              orientation="horizontal"
              className="flex-col min-w-0 gap-4"
            >
              <TabsList className="w-full">
                <TabsTrigger value="ssh">{t('imageManagerTool.manageTabSsh')}</TabsTrigger>
                <TabsTrigger value="registry">
                  {t('imageManagerTool.manageTabRegistry')}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="ssh" className="flex min-w-0 flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">
                    {t('imageManagerTool.sources')}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => newSource('ssh')}>
                    <Plus data-icon="inline-start" /> {t('imageManagerTool.addSource')}
                  </Button>
                </div>
                {draftSources.filter((item) => item.kind === 'ssh').length > 0 ? (
                  <div className="divide-y divide-border">
                    {draftSources
                      .filter((item) => item.kind === 'ssh')
                      .map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-foreground">
                              {sourceDisplayName(item, t)}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {t('imageManagerTool.kindSsh')}
                            </div>
                          </div>
                          <div className="flex flex-none gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('imageManagerTool.editSource')}
                              onClick={() => editSource(item)}
                            >
                              <PencilSimple />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('imageManagerTool.removeSource')}
                              onClick={() => removeSource(item.id)}
                            >
                              <Trash />
                            </Button>
                          </div>
                        </div>
                      ))}
                  </div>
                ) : null}

                {editingSource?.kind === 'ssh' && !editingSource.id ? (
                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {t('imageManagerTool.sshHosts')}
                    </span>
                    {hostsLoading ? (
                      <div className="flex justify-center py-3">
                        <Spinner />
                      </div>
                    ) : hostsError ? (
                      <p className="m-0 text-sm text-destructive">{hostsError}</p>
                    ) : hostOptions.length === 0 ? (
                      <p className="m-0 text-sm text-muted-foreground">
                        {t('imageManagerTool.sshHostsEmpty')}
                      </p>
                    ) : (
                      <div className="divide-y divide-border">
                        {hostOptions.map((host, index) => {
                          const id = sshSourceId(host.alias);
                          return (
                            <label key={id} className="flex cursor-pointer items-center gap-2 py-2">
                              <Checkbox
                                checked={host.selected}
                                onCheckedChange={(checked) =>
                                  setHostOptions((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, selected: checked === true }
                                        : item,
                                    ),
                                  )
                                }
                              />
                              <span className="min-w-0 truncate font-mono text-[13px]">
                                {host.alias}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}

                {editingSource?.kind === 'ssh' ? renderEditForm() : null}
              </TabsContent>

              <TabsContent value="registry" className="flex min-w-0 flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">
                    {t('imageManagerTool.sources')}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => newSource('registry')}>
                    <Plus data-icon="inline-start" /> {t('imageManagerTool.addRegistry')}
                  </Button>
                </div>
                {draftSources.filter((item) => item.kind === 'registry').length > 0 ? (
                  <div className="divide-y divide-border">
                    {draftSources
                      .filter((item) => item.kind === 'registry')
                      .map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-foreground">
                              {sourceDisplayName(item, t)}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {t('imageManagerTool.kindRegistry')}
                            </div>
                          </div>
                          <div className="flex flex-none gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('imageManagerTool.editSource')}
                              onClick={() => editSource(item)}
                            >
                              <PencilSimple />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('imageManagerTool.removeSource')}
                              onClick={() => removeSource(item.id)}
                            >
                              <Trash />
                            </Button>
                          </div>
                        </div>
                      ))}
                  </div>
                ) : null}

                {editingSource?.kind === 'registry' ? renderEditForm() : null}
              </TabsContent>
            </Tabs>
            {sourceSaveError ? (
              <p className="m-0 pt-3 text-sm text-destructive" role="alert">
                {sourceSaveError}
              </p>
            ) : null}
          </div>
          <DialogFooter className="flex-none">
            <Button variant="outline" disabled={savingSources} onClick={() => setManageOpen(false)}>
              {t('imageManagerTool.cancel')}
            </Button>
            <Button disabled={savingSources} onClick={() => void saveSources()}>
              {savingSources ? <Spinner data-icon="inline-start" /> : null}
              {t('imageManagerTool.saveSources')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader className="min-w-0">
            <AlertDialogTitle>
              {confirm?.type === 'push'
                ? t('imageManagerTool.pushConfirmTitle')
                : t('imageManagerTool.deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription
              render={<div />}
              className="min-w-0 max-w-full text-left whitespace-normal break-words [overflow-wrap:anywhere]"
            >
              {confirm?.type === 'push' ? (
                <p className="m-0">
                  {t('imageManagerTool.pushConfirmBody', {
                    name: imageLabel(confirm.image, unnamed),
                  })}
                </p>
              ) : confirm?.type === 'delete' ? (
                confirm.sourceKind === 'registry' ? (
                  <div className="flex min-w-0 flex-col gap-3">
                    <p className="m-0">{t('imageManagerTool.registryDeleteConfirmSummary')}</p>
                    <div className="min-w-0 rounded-md border border-border bg-muted/40 px-3 py-2">
                      {registryConfirmDigests.length > 0 ? (
                        <div className="space-y-1.5">
                          {registryConfirmDigests.map((digest) => (
                            <div key={digest} className="flex min-w-0 items-start gap-2">
                              <code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-foreground">
                                {digest}
                              </code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="flex-none"
                                title={t('imageManagerTool.copyDigest')}
                                aria-label={t('imageManagerTool.copyDigest')}
                                onClick={() => void copyDigest(digest)}
                              >
                                {copiedDigest === digest ? (
                                  <Check aria-hidden="true" />
                                ) : (
                                  <Copy aria-hidden="true" />
                                )}
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="m-0 mt-2 text-xs text-muted-foreground">
                          {t('imageManagerTool.registryDeleteDigestPending')}
                        </p>
                      )}
                    </div>
                    {registryConfirmTags.length > 0 ? (
                      <div className="min-w-0">
                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                          {t('imageManagerTool.registryDeleteTags')}
                        </div>
                        <div className="mt-1.5 flex max-h-32 min-w-0 flex-wrap gap-1.5 overflow-y-auto pr-1">
                          {registryConfirmTags.map((tag, index) => (
                            <button
                              type="button"
                              key={`${tag}-${index}`}
                              className="group inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-left text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                              title={t('imageManagerTool.copyTag')}
                              aria-label={t('imageManagerTool.copyTag')}
                              onClick={() => void copyTag(tag)}
                            >
                              {copiedTag === tag ? (
                                <Check size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                              ) : (
                                <Copy size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                              )}
                              <code className="min-w-0 break-all font-mono text-xs leading-5">
                                {tag}
                              </code>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <p className="m-0 text-xs text-muted-foreground">
                      {t('imageManagerTool.registryDeleteGCHint')}
                    </p>
                  </div>
                ) : (
                  <p className="m-0">
                    {confirm.ids.length > 1
                      ? t('imageManagerTool.deleteConfirmManyBody', { count: confirm.ids.length })
                      : t('imageManagerTool.deleteConfirmBody', { name: confirm.name })}
                  </p>
                )
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>
              {t('imageManagerTool.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.type === 'delete' ? 'destructive' : 'default'}
              disabled={busy !== null}
              onClick={confirmAction}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {t('imageManagerTool.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Reveal>
  );
}
