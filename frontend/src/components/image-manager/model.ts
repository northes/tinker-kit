import { CancelError } from '@wailsio/runtime';
import type {
  DockerDeleteTarget,
  DockerImage,
  DockerImageDetail,
  DockerStatus,
  ImageSource,
  SSHProfile,
} from '../../../bindings/tinkerkit/models';
import { formatBackendError } from '../../lib/backend-error';
import { type ImageRenameForm, imageRepository, imageTag } from './rename';

export const LOCAL_SOURCE_ID = 'local';

export const MANAGE_SOURCES_VALUE = '__manage-sources__';

export const LOCAL_SOURCE = {
  id: LOCAL_SOURCE_ID,
  name: '本机',
  kind: 'local',
} as unknown as ImageSource;

export const IMAGE_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ManagedImageSource = Omit<
  ImageSource,
  'sshProfileID' | 'registryURL' | 'registryUsername' | 'registryPassword'
> & {
  sshProfileID?: string;
  registryURL?: string;
  registryUsername?: string;
  registryPassword?: string;
  capabilities?: { canDelete?: boolean; canPush?: boolean };
};

export type SourceDraft = Partial<ManagedImageSource> &
  Pick<ManagedImageSource, 'name' | 'kind'> & { id?: string };

type WatchEventKind = 'snapshot' | 'create' | 'update' | 'delete';

type WatchProgress = {
  scanned?: number;
  total?: number;
  stage?: string;
};

export type WatchDockerImagesEvent = {
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

export type ConfirmState = {
  type: 'delete';
  ids: string[];
  targets: DockerDeleteTarget[];
  name: string;
  sourceId: string;
  sourceKind: string;
  sourceConfigKey: string;
  deleteManifest: boolean;
} | null;

export type ImageOperationDialogState =
  | {
      type: 'push';
      changes: Array<{ source: string; target: string }>;
      sourceConfigKey: string;
      value: string;
    }
  | {
      type: 'rename';
      rows: ImageRow[];
      sourceConfigKey: string;
      form: ImageRenameForm;
    }
  | {
      type: 'copy-tag';
      rows: ImageRow[];
      sourceConfigKey: string;
      value: string;
    }
  | {
      type: 'pull-image';
      sourceConfigKey: string;
      value: string;
      target: string;
      username: string;
      password: string;
      platform: string;
      platforms: string[];
      platformStatus: 'idle' | 'loading' | 'success' | 'error';
      platformError: string;
    }
  | null;

type SourceViewState = 'connecting' | 'unavailable' | 'loading-details' | 'updating' | 'connected';

type ContentViewState = 'loading' | 'error' | 'empty' | 'no-results' | 'table';

export function errorMessage(error: unknown) {
  return formatBackendError(error);
}

// 来源状态只由连接探测、扫描错误和后台更新事件共同决定。
export function resolveSourceViewState(
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
export function resolveContentViewState(
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

export function isWatchCancelError(error: unknown) {
  return error instanceof CancelError || (error instanceof Error && error.name === 'CancelError');
}

export function isLocalSource(source: ImageSource) {
  return source.id === LOCAL_SOURCE_ID || source.kind === 'local';
}

export function resolveSources(sources: ImageSource[] | null | undefined): ImageSource[] {
  const list = (sources ?? []).filter((source) => source.id);
  if (list.some(isLocalSource)) return list;
  return [LOCAL_SOURCE, ...list];
}

export function sourceDisplayName(
  source: ImageSource,
  t: (key: string) => string,
  profiles: SSHProfile[],
) {
  if (isLocalSource(source)) return t('imageManagerTool.localSource');
  if (source.name) return source.name;
  if (source.kind === 'ssh') {
    const profileID = (source as ManagedImageSource).sshProfileID?.trim() ?? '';
    return (
      profiles.find((profile) => profile.id === profileID)?.name ??
      t('imageManagerTool.sshProfileMissing')
    );
  }
  return (source as ManagedImageSource).registryURL || '';
}

export function sourceMissingSSHProfile(source: ImageSource, profiles: SSHProfile[]) {
  if (source.kind !== 'ssh') return false;
  const profileID = (source as ManagedImageSource).sshProfileID?.trim() ?? '';
  return !profileID || !profiles.some((profile) => profile.id === profileID);
}

export function bindingSource(source: ManagedImageSource): ImageSource {
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
    sshProfileID: ssh ? (source.sshProfileID?.trim() ?? '') : '',
    registryURL: normalizedRegistryURL,
    registryUsername: registry ? (source.registryUsername?.trim() ?? '') : '',
    registryPassword: registry ? (source.registryPassword ?? '') : '',
  } as ImageSource;
}

export function asStringList(value: string[] | string | null | undefined) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

export function labelEntries(labels: DockerImageDetail['labels']) {
  if (!labels) return [];
  return Object.entries(labels).filter((entry): entry is [string, string] =>
    Boolean(entry[0] && entry[1] != null && entry[1] !== ''),
  );
}

export { formatImageBytes as formatBytes } from '../../lib/byte-format';
export {
  buildRenamePreview,
  renameFormHasInput,
  type ImageRenameForm,
  type ImageRenameScope,
} from './rename';

export function formatRawJSON(value: string) {
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

export function formatCreatedAt(value: string, locale: string) {
  if (!value) return '';
  const date = parseDateSafe(value);
  return date ? date.toLocaleString(locale) : value;
}

export function formatCreatedAtCompact(value: string, locale: string) {
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

export function shortId(id: string) {
  const value = id.replace(/^sha256:/, '');
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function imageLabel(image: DockerImage, unnamed: string) {
  return image.name?.trim() || unnamed;
}

function isNamedImageReference(image: DockerImage, unnamed: string) {
  const name = imageLabel(image, unnamed);
  return Boolean(name) && name !== unnamed && !name.includes('<none>') && !name.includes('@');
}

export function imageExportReference(image: DockerImage, unnamed: string) {
  return isNamedImageReference(image, unnamed) ? imageLabel(image, unnamed) : image.id;
}

// 目标是当前 Registry 内的仓库引用，去掉来源域名，保留命名空间和 Tag。
export function suggestedPullTarget(reference: string) {
  let value = reference.trim().split('@')[0];
  if (!value) return '';
  const slash = value.indexOf('/');
  const first = value.slice(0, slash);
  if (slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    value = value.slice(slash + 1);
  }
  if (!value) return '';
  return imageTag(value) ? value : `${value}:latest`;
}

export function imageWithTag(reference: string, tag: string) {
  return `${imageRepository(reference)}:${tag}`;
}

export function copyableImageName(source: ImageSource, name: string) {
  if (source.kind !== 'registry') return name;
  const registryPrefix = ((source as ManagedImageSource).registryURL ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');
  return registryPrefix && !name.startsWith(`${registryPrefix}/`)
    ? `${registryPrefix}/${name}`
    : name;
}

// 多选复制时按「1. 值\n2. 值\n...\n共 N 个」输出；单选直接返回原始值。
export function clipboardList(values: string[], countLabel: string) {
  if (values.length <= 1) return values[0] ?? '';
  return [...values.map((value, index) => `${index + 1}. ${value}`), countLabel].join('\n');
}

function registryImageIdentity(image: DockerImage) {
  const digest = image.digest?.trim();
  return digest ? `${image.repository}\u0000${digest}` : '';
}

export function associatedRegistryTags(images: DockerImage[], ids: string[]) {
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

// 删除按行粒度：具名行用 repo:tag（docker rmi <tag> 只移除该 tag），
// 悬空行才回退到镜像 ID（docker rmi <id> 删除整个镜像）。
export function deleteTargets(rows: ImageRow[]): DockerDeleteTarget[] {
  const seen = new Set<string>();
  const targets: DockerDeleteTarget[] = [];
  for (const row of rows) {
    const imageID = row.reference || row.image.id;
    if (seen.has(imageID)) continue;
    seen.add(imageID);
    targets.push({ imageID, expectedDigest: row.image.digest?.trim() ?? '' });
  }
  return targets;
}

type ImageWithSizeBytes = DockerImage & { sizeBytes?: number | null };

export type SortKey = 'name' | 'size' | 'createdAt';

export type SortDirection = 'asc' | 'desc';

export function imageSizeBytes(image: DockerImage) {
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

export function imageExportEstimateBytes(image: DockerImage) {
  const sizeBytes = imageSizeBytes(image);
  return Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : 0;
}

export function imageCreatedAtMs(value: string) {
  const date = parseDateSafe(value);
  return date ? date.getTime() : null;
}

export type ImageRow = {
  key: string;
  reference: string;
  tag: string;
  image: DockerImage;
};

// 与 `docker images` 一致：同一镜像的每个 tag 各占一行，行身份是 repo:tag。
// 只有没有任何具名 tag 的悬空镜像才退回镜像 ID 作为行键。
export function buildImageRows(images: DockerImage[]): ImageRow[] {
  const rows: ImageRow[] = [];
  for (const image of images) {
    const tags = asStringList(image.tags).filter((tag) => !tag.includes('<none>'));
    if (tags.length === 0) {
      rows.push({ key: image.id, reference: '', tag: '', image });
      continue;
    }
    for (const tag of tags) {
      rows.push({ key: tag, reference: tag, tag, image });
    }
  }
  return rows;
}

export function imageRowLabel(row: ImageRow, unnamed: string) {
  return row.reference || imageLabel(row.image, unnamed);
}

export function isNamedImageRow(row: ImageRow) {
  return Boolean(row.reference);
}

export type IndexedImage = {
  row: ImageRow;
  searchId: string;
  searchName: string;
  sortName: string;
  sizeBytes: number;
  createdAtMs: number | null;
};
