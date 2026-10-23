import {
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CloudArrowDown,
  Copy,
  DownloadSimple,
  GearSix,
  IdentificationCard,
  ListDashes,
  Package,
  PencilSimple,
  Trash,
  UploadSimple,
  XCircle,
} from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CancelError } from '@wailsio/runtime';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ValidateImageSource } from '../../bindings/tinkerkit/configservice';
import {
  DeleteDockerImages,
  PrepareImageImports,
  PushDockerImages,
  ResolveImagePullPlatforms,
  StartImageExport,
  StartImageExports,
  StartImageImports,
  StartImagePulls,
  StartImageTagChanges,
  StartRegistryImagePulls,
  TestImageSourceConnection,
} from '../../bindings/tinkerkit/imageservice';
import type {
  DockerDeleteTarget,
  DockerImageBatchResult,
  ImageImportEntry,
  ImageSource,
  ImageTask,
  Config as Settings,
} from '../../bindings/tinkerkit/models';
import { formatBackendError } from '../lib/backend-error';
import { imageArchitectures } from '../lib/image-architectures';
import { ConfirmDialog } from './ConfirmDialog';
import { ImageSearchField } from './image-manager/ImageSearchField';
import {
  associatedRegistryTags,
  asStringList,
  bindingSource,
  buildImageRows,
  buildRenamePreview,
  clipboardList,
  copyableImageName,
  deleteTargets,
  errorMessage,
  formatBytes,
  formatCreatedAt,
  formatCreatedAtCompact,
  IMAGE_TASK_RETENTION_MS,
  imageCreatedAtMs,
  imageExportEstimateBytes,
  imageExportReference,
  imageLabel,
  imageRowLabel,
  imageSizeBytes,
  imageWithTag,
  isLocalSource,
  isNamedImageRow,
  LOCAL_SOURCE,
  LOCAL_SOURCE_ID,
  MANAGE_SOURCES_VALUE,
  renameFormHasInput,
  resolveContentViewState,
  resolveSources,
  resolveSourceViewState,
  shortId,
  sourceDisplayName,
  sourceMissingSSHProfile,
  suggestedPullTarget,
  type ConfirmState,
  type ImageOperationDialogState,
  type ImageRenameForm,
  type ImageRenameScope,
  type ImageRow,
  type IndexedImage,
  type ManagedImageSource,
  type SortDirection,
  type SortKey,
  type SourceDraft,
} from './image-manager/model';
import { useImageManagerWatch } from './image-manager/useImageManagerWatch';
import { ImageImportDialog } from './ImageImportDialog';
import {
  Reveal,
  ToolActionButton,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutToolbar,
  useCheckboxDragSelect,
  type PendingAction,
} from './shared';
import { SSHProfileFormField } from './SSHProfileFormField';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import { openTaskCenter } from './TaskCenter';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
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
import { Spinner } from './ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { toast } from './ui/toast';

export default function ImageManagerTool({
  active,
  settings,
  onSettingsChange,
  onOpenDetail,
  pending,
  clearPending,
}: {
  active: boolean;
  settings: Settings;
  onSettingsChange: (patch: Pick<Settings, 'dockerCLIPath' | 'imageSources'>) => Promise<void>;
  onOpenDetail: (sourceId: string, imageId: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { profiles } = useSSHProfiles();
  const consumed = useRef<PendingAction | null>(null);
  const sourceLabelId = useId();
  const sources = useMemo(() => resolveSources(settings.imageSources), [settings.imageSources]);
  const cliPath = settings.dockerCLIPath ?? '';
  // 默认加载来源列表的首项；仅当用户在本工具内手动选择过且该来源仍存在时才保留选择。
  const [pickedSourceId, setPickedSourceId] = useState<string | null>(null);
  const source = sources.find((item) => item.id === pickedSourceId) ?? sources[0] ?? LOCAL_SOURCE;
  const sourceProfileMissing = sourceMissingSSHProfile(source, profiles);
  const sourceConfigKey = JSON.stringify({
    source,
    profile:
      source.kind === 'ssh' ? profiles.find((item) => item.id === source.sshProfileID) : null,
  });
  const {
    connectionPending,
    watchCanceled,
    cancelWatch,
    restartWatch,
    loadError,
    status,
    watchSourceId,
    images,
    selected,
    setSelected,
    isUpdating,
    isInitialLoad,
    hasSnapshot,
    snapshotUpdatedAt,
    tasks,
    requestWatchReload,
    applyTasks,
  } = useImageManagerWatch({ active, source, sourceProfileMissing, sourceConfigKey, cliPath });
  const [busy, setBusy] = useState<'push' | 'tag' | 'delete' | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [savingSources, setSavingSources] = useState(false);
  const [testingSource, setTestingSource] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [operationDialog, setOperationDialog] = useState<ImageOperationDialogState>(null);
  const [operationError, setOperationError] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [batchExportStarting, setBatchExportStarting] = useState(false);
  const [pullStarting, setPullStarting] = useState(false);
  const [importStarting, setImportStarting] = useState(false);
  const [importPlan, setImportPlan] = useState<{
    sourceConfigKey: string;
    entries: ImageImportEntry[];
  } | null>(null);
  const importRequest = useRef<ReturnType<typeof PrepareImageImports> | null>(null);
  const [taskClock, setTaskClock] = useState(Date.now);
  const sourceIsChanging = !sourceProfileMissing && watchSourceId !== source.id;
  const isConnecting = !sourceProfileMissing && (connectionPending || sourceIsChanging);
  const displayedImages = sourceIsChanging ? [] : images;
  const currentSourceConfigKey = useRef(sourceConfigKey);
  useEffect(() => {
    currentSourceConfigKey.current = sourceConfigKey;
    importRequest.current?.cancel();
    importRequest.current = null;
    setImportStarting(false);
    setImportPlan(null);
    return () => {
      importRequest.current?.cancel();
    };
  }, [sourceConfigKey, active]);
  const refreshList = useCallback(() => {
    requestWatchReload();
  }, [requestWatchReload]);

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
    if (!pending || pending.tool !== 'image-manager' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'refresh') {
      refreshList();
    }
  }, [clearPending, pending, refreshList]);

  const unnamed = t('imageManagerTool.unnamed');
  const indexedRows = useMemo<IndexedImage[]>(
    () =>
      buildImageRows(displayedImages).map((row) => ({
        row,
        searchId: row.image.id.toLocaleLowerCase(),
        // 同时匹配行名称与全部 tag，避免因展示顺序变化导致搜索结果闪烁。
        searchName: [imageLabel(row.image, ''), row.reference, ...asStringList(row.image.tags)]
          .join(' ')
          .toLocaleLowerCase(),
        sortName: imageRowLabel(row, '').toLocaleLowerCase(),
        sizeBytes: imageSizeBytes(row.image),
        createdAtMs: imageCreatedAtMs(row.image.createdAt),
      })),
    [displayedImages],
  );
  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const next = query
      ? indexedRows.filter(
          (item) => item.searchId.includes(query) || item.searchName.includes(query),
        )
      : [...indexedRows];
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
          ? left.sortName.localeCompare(right.sortName, i18n.language, {
              sensitivity: 'base',
            })
          : left.sizeBytes - right.sizeBytes;
      return comparison * direction;
    });
    return next.map((item) => item.row);
  }, [i18n.language, indexedRows, search, sortDirection, sortKey]);
  // 只渲染可视区域的行：列表可达上千条，全量 DOM 会让工具切换与滚动明显卡顿。
  const [imageListViewport, setImageListViewport] = useState<HTMLElement | null>(null);
  const imageRowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => imageListViewport,
    estimateSize: () => 37,
    overscan: 12,
  });
  const imageVirtualRows = imageRowVirtualizer.getVirtualItems();
  const imagePaddingTop = imageVirtualRows.length > 0 ? imageVirtualRows[0].start : 0;
  const imagePaddingBottom =
    imageVirtualRows.length > 0
      ? imageRowVirtualizer.getTotalSize() - imageVirtualRows[imageVirtualRows.length - 1].end
      : 0;
  const selectedCount = sourceIsChanging ? 0 : selected.size;
  const selectedRows = sourceIsChanging ? [] : filteredRows.filter((row) => selected.has(row.key));
  const allSelected = filteredRows.length > 0 && filteredRows.every((row) => selected.has(row.key));
  const someSelected = filteredRows.some((row) => selected.has(row.key)) && !allSelected;
  // 总大小按镜像去重（同一镜像的多个 tag 共享同一份磁盘占用），行数则按 tag 计。
  const filteredTotalBytes = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const row of filteredRows) {
      if (seen.has(row.image.id)) continue;
      seen.add(row.image.id);
      total += imageSizeBytes(row.image);
    }
    return total;
  }, [filteredRows]);
  const sourceViewState = sourceProfileMissing
    ? 'unavailable'
    : resolveSourceViewState(isConnecting, status, loadError, isUpdating, isInitialLoad);
  const contentError = sourceProfileMissing
    ? t('imageManagerTool.sshProfileMissingHint')
    : loadError || (status?.error ? formatBackendError(status.error) : '') || '';
  const contentViewState = resolveContentViewState(
    isConnecting,
    hasSnapshot,
    images.length,
    filteredRows.length,
    sourceViewState,
  );
  const actionBlocked =
    sourceProfileMissing || isConnecting || busy !== null || sourceViewState === 'unavailable';
  const interactionBlocked = busy !== null;
  const sourceSupportsDockerMutations = source.kind !== 'registry';
  const isRegistrySource = source.kind === 'registry';
  const currentPullPlatform = status?.localArchitecture
    ? `linux/${status.localArchitecture}`
    : '';
  const currentPullPlatformLabel = t('imageManagerTool.pullCurrentPlatform', {
    architecture: status?.localArchitecture || t('imageManagerTool.architectureUnknown'),
  });
  const sourceCanDelete = (source as ManagedImageSource).capabilities?.canDelete ?? true;
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
    const visibleKeys = new Set(filteredRows.map((row) => row.key));
    setSelected((current) => {
      const next = new Set([...current].filter((key) => visibleKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [filteredRows]);

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

  const openManage = () => setManageOpen(true);

  const sourceCandidate = (draft: SourceDraft, id?: string) => {
    const kind = draft.kind as 'ssh' | 'registry';
    return bindingSource({
      ...draft,
      id: id || draft.id?.trim() || `${kind}:connection-test`,
      kind,
      name: draft.name?.trim() ?? '',
      sshProfileID: draft.sshProfileID?.trim() ?? '',
    } as ManagedImageSource);
  };

  const saveManagedSources = async (managed: ImageSource[]) => {
    const nextSources = managed.map((item) =>
      isLocalSource(item)
        ? bindingSource({
            ...LOCAL_SOURCE,
            id: LOCAL_SOURCE_ID,
            kind: 'local',
          } as ManagedImageSource)
        : bindingSource(item as ManagedImageSource),
    );
    const invalid = nextSources.find((item) =>
      item.kind === 'ssh'
        ? !item.sshProfileID.trim() || !profiles.some((profile) => profile.id === item.sshProfileID)
        : item.kind === 'registry'
          ? !item.registryURL.trim()
          : false,
    );
    if (invalid)
      throw new Error(
        t(
          invalid.kind === 'ssh'
            ? 'imageManagerTool.sshProfileRequired'
            : 'imageManagerTool.registryURLRequired',
        ),
      );
    setSavingSources(true);
    try {
      await onSettingsChange({ dockerCLIPath: cliPath, imageSources: nextSources });
    } finally {
      setSavingSources(false);
    }
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(filteredRows.map((row) => row.key)) : new Set());
  };

  const toggleRow = (key: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const startCheckboxDrag = useCheckboxDragSelect((key) => selected.has(key), toggleRow);

  const viewRow = (row: ImageRow) => onOpenDetail(source.id, row.image.id);

  const copyImageName = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      toast.add({ title: t('imageManagerTool.copied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyNameFailed'), type: 'error' });
    }
  };

  const copyImageId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast.add({ title: t('imageManagerTool.idCopied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyIdFailed'), type: 'error' });
    }
  };

  const copyImageNames = (rows: ImageRow[]) => {
    const values = rows.map((item) => copyableImageName(source, imageRowLabel(item, unnamed)));
    void copyImageName(
      clipboardList(values, t('imageManagerTool.copyCount', { total: values.length })),
    );
  };

  const copyImageIds = (rows: ImageRow[]) => {
    const values = rows.map((item) => item.image.id);
    void copyImageId(
      clipboardList(values, t('imageManagerTool.copyCount', { total: values.length })),
    );
  };

  const copyDigest = async (digest: string) => {
    try {
      await navigator.clipboard.writeText(digest);
      toast.add({ title: t('imageManagerTool.digestCopied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyDigestFailed'), type: 'error' });
    }
  };

  const copyTag = async (tag: string) => {
    try {
      await navigator.clipboard.writeText(tag);
      toast.add({ title: t('imageManagerTool.tagCopied') });
    } catch {
      toast.add({ title: t('imageManagerTool.copyTagFailed'), type: 'error' });
    }
  };

  const reportBatchResult = (result: DockerImageBatchResult, successKey: string) => {
    const succeeded = result.succeeded ?? [];
    const failures = result.failed ?? [];
    if (failures.length > 0) {
      toast.add({
        title: t('imageManagerTool.pushPartial', {
          succeeded: succeeded.length,
          failed: failures.length,
        }),
        description: failures
          .map((failure) =>
            t('imageManagerTool.operationFailureReason', {
              image: failure.image,
              reason: formatBackendError(failure.error),
            }),
          )
          .join('\n'),
        type: succeeded.length > 0 ? 'warning' : 'error',
      });
    } else {
      toast.add({ title: t(successKey) });
    }
    return { succeeded, failures };
  };

  const runPushChanges = async (changes: Array<{ source: string; target: string }>) => {
    setBusy('push');
    try {
      const result = await PushDockerImages(source.id, changes);
      const { succeeded, failures } = reportBatchResult(result, 'imageManagerTool.pushed');
      if (succeeded.length > 0 || changes.some((change) => change.source !== change.target)) {
        requestWatchReload();
      }
      if (failures.length === 0) setSelected(new Set());
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.pushFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setBusy(null);
      setOperationDialog(null);
    }
  };

  const runTagChanges = async (
    changes: Array<{ source: string; target: string }>,
    removeSource: boolean,
  ) => {
    setBusy('tag');
    try {
      // Registry 换 Tag 需要网络读写且可能重推关联 Tag，统一作为后台任务执行并展示进度。
      const result = await StartImageTagChanges(source.id, changes, removeSource);
      if (result.started > 0) {
        applyTasks(result.snapshot);
        openTaskCenter('image-manager');
        setSelected(new Set());
      }
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.tagChangeFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setBusy(null);
      setOperationDialog(null);
    }
  };

  const operationRowsFor = (row: ImageRow) => (selected.has(row.key) ? selectedRows : [row]);

  const openPushDialog = (rows: ImageRow[]) => {
    if (
      actionBlocked ||
      !sourceSupportsDockerMutations ||
      rows.length === 0 ||
      rows.some((row) => !isNamedImageRow(row))
    ) {
      return;
    }
    setOperationError('');
    setOperationDialog({
      type: 'push',
      changes: rows.map((row) => ({ source: row.reference, target: row.reference })),
      sourceConfigKey,
      value: rows.length === 1 ? rows[0].reference : '',
    });
  };

  const openRenameDialog = (rows: ImageRow[]) => {
    if (actionBlocked || rows.length === 0 || rows.some((row) => !isNamedImageRow(row))) {
      return;
    }
    setOperationError('');
    // 单行沿用「直接输入完整名」的编辑体验，多行默认给出批量前缀；两者都可切换。
    // Registry 只支持同仓库换 Tag，单行默认直接输入 Tag，避免误改仓库。
    const single = rows.length === 1;
    setOperationDialog({
      type: 'rename',
      rows,
      sourceConfigKey,
      form: {
        scope: single && !isRegistrySource ? 'name' : 'tag',
        mode: single ? 'custom' : 'prefix',
        value: '',
        find: '',
        replacement: '',
      },
    });
  };

  const updateRenameForm = (patch: Partial<ImageRenameForm>) => {
    setOperationError('');
    setOperationDialog((current) =>
      current?.type === 'rename' ? { ...current, form: { ...current.form, ...patch } } : current,
    );
  };

  // 直接输入只在单行或作用对象为 Tag 时可用；切到完整镜像名时回退到前缀，避免批量共用同一完整名。
  const setRenameScope = (scope: ImageRenameScope) => {
    if (
      scope === 'name' &&
      operationDialog?.type === 'rename' &&
      operationDialog.rows.length > 1 &&
      operationDialog.form.mode === 'custom'
    ) {
      updateRenameForm({ scope, mode: 'prefix', value: '' });
      return;
    }
    updateRenameForm({ scope });
  };

  const openCopyTagDialog = (rows: ImageRow[]) => {
    if (actionBlocked || rows.length === 0 || rows.some((row) => !isNamedImageRow(row))) {
      return;
    }
    setOperationError('');
    setOperationDialog({ type: 'copy-tag', rows, sourceConfigKey, value: '' });
  };

  const openPullImageDialog = () => {
    if (actionBlocked) return;
    setOperationError('');
    setOperationDialog({
      type: 'pull-image',
      sourceConfigKey,
      value: '',
      target: '',
      username: '',
      password: '',
      platform: 'current',
      platforms: [],
      platformStatus: 'idle',
      platformError: '',
    });
  };

  const pullPlatformRequest = useRef<ReturnType<typeof ResolveImagePullPlatforms> | null>(null);
  const pullRevision = useRef(0);
  const pullReference = operationDialog?.type === 'pull-image' ? operationDialog.value : null;
  const pullUsername = operationDialog?.type === 'pull-image' ? operationDialog.username : null;
  const pullPassword = operationDialog?.type === 'pull-image' ? operationDialog.password : null;
  useEffect(
    () => () => {
      pullRevision.current++;
      pullPlatformRequest.current?.cancel();
      pullPlatformRequest.current = null;
    },
    [pullReference, pullUsername, pullPassword, sourceConfigKey, active],
  );

  useEffect(() => {
    setOperationDialog((current) => (current?.type === 'pull-image' ? null : current));
  }, [sourceConfigKey, active]);

  const updatePullInput = (
    patch: Partial<Extract<ImageOperationDialogState, { type: 'pull-image' }>>,
  ) => {
    pullRevision.current++;
    pullPlatformRequest.current?.cancel();
    setOperationError('');
    setOperationDialog((current) =>
      current?.type === 'pull-image'
        ? {
            ...current,
            ...patch,
            target:
              isRegistrySource &&
              patch.value !== undefined &&
              (!current.target || current.target === suggestedPullTarget(current.value))
                ? suggestedPullTarget(patch.value)
                : current.target,
            platform: 'current',
            platforms: [],
            platformStatus: 'idle',
            platformError: '',
          }
        : current,
    );
  };
  const resolvePullPlatforms = async () => {
    if (operationDialog?.type !== 'pull-image' || !operationDialog.value.trim()) return;
    pullPlatformRequest.current?.cancel();
    const revision = ++pullRevision.current;
    const request = ResolveImagePullPlatforms(source.id, operationDialog.value.trim(), {
      username: operationDialog.username,
      password: operationDialog.password,
      platform: '',
    });
    pullPlatformRequest.current = request;
    setOperationDialog((current) =>
      current?.type === 'pull-image'
        ? {
            ...current,
            platform: 'current',
            platforms: [],
            platformStatus: 'loading',
            platformError: '',
          }
        : current,
    );
    try {
      const platforms = (await request) ?? [];
      if (revision !== pullRevision.current) return;
      setOperationDialog((current) =>
        current?.type === 'pull-image'
          ? { ...current, platforms, platformStatus: 'success' }
          : current,
      );
    } catch (error) {
      if (revision !== pullRevision.current || error instanceof CancelError) return;
      setOperationDialog((current) =>
        current?.type === 'pull-image'
          ? { ...current, platformStatus: 'error', platformError: errorMessage(error) }
          : current,
      );
    } finally {
      if (revision === pullRevision.current) pullPlatformRequest.current = null;
    }
  };

  // 字段表单按操作类型唯一渲染，页脚确认按钮通过 form 关联，回车即可提交。
  const operationFormID = operationDialog ? `image-operation-${operationDialog.type}` : undefined;

  const renamePreview = useMemo(
    () =>
      operationDialog?.type === 'rename' && renameFormHasInput(operationDialog.form)
        ? buildRenamePreview(operationDialog.rows, operationDialog.form, isRegistrySource)
        : [],
    [isRegistrySource, operationDialog],
  );
  const renameReady =
    renamePreview.length > 0 && renamePreview.every((item) => item.status === 'ok');

  const submitOperation = () => {
    if (!operationDialog || busy || pullStarting) return;
    if (operationDialog.sourceConfigKey !== sourceConfigKey) {
      toast.add({ title: t('imageManagerTool.sourceChangedRefresh'), type: 'warning' });
      setOperationDialog(null);
      return;
    }
    if (operationDialog.type === 'rename') {
      const { form, rows } = operationDialog;
      if (!renameFormHasInput(form)) {
        setOperationError(t('imageManagerTool.operationInputRequired'));
        return;
      }
      const preview = buildRenamePreview(rows, form, isRegistrySource);
      if (preview.some((item) => item.status !== 'ok')) {
        setOperationError(t('imageManagerTool.renamePreviewInvalid'));
        return;
      }
      void runTagChanges(
        preview.map((item) => ({ source: item.source, target: item.target })),
        true,
      );
      return;
    }
    const value = operationDialog.value.trim();
    if (operationDialog.type === 'push') {
      if (operationDialog.changes.length === 1) {
        if (!value) {
          setOperationError(t('imageManagerTool.operationInputRequired'));
          return;
        }
        if (value === operationDialog.changes[0].source) {
          void runPushChanges(operationDialog.changes);
        } else {
          void runPushChanges([{ source: operationDialog.changes[0].source, target: value }]);
        }
        return;
      }
      void runPushChanges(operationDialog.changes);
      return;
    }
    if (operationDialog.type === 'pull-image') {
      const options = {
        ...operationDialog,
        platform:
          operationDialog.platform === 'current' ? currentPullPlatform : operationDialog.platform,
      };
      if (operationDialog.platform === 'current' && !currentPullPlatform) return;
      if (!value) {
        setOperationError(t('imageManagerTool.operationInputRequired'));
        return;
      }
      if (isRegistrySource) {
        if (!operationDialog.target.trim()) {
          setOperationError(t('imageManagerTool.operationInputRequired'));
          return;
        }
        void runRegistryPull(value, operationDialog.target.trim(), options);
      } else {
        setOperationDialog(null);
        setOperationError('');
        void runPullRefs([value], options);
      }
      return;
    }
    if (!value) {
      setOperationError(t('imageManagerTool.operationInputRequired'));
      return;
    }
    if (operationDialog.type !== 'copy-tag') return;
    const changes = operationDialog.rows.map((row) => ({
      source: row.reference,
      target: imageWithTag(row.reference, value),
    }));
    void runTagChanges(changes, false);
  };

  const runDelete = async (
    sourceID: string,
    ids: string[],
    targets: DockerDeleteTarget[],
    name: string,
    deleteManifest: boolean,
  ) => {
    setBusy('delete');
    try {
      const result = await DeleteDockerImages(sourceID, targets, deleteManifest);
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
                reason: formatBackendError(failure.error),
              }),
            )
            .join('\n'),
          type: 'warning',
        });
      } else {
        toast.add({ title: t('imageManagerTool.deleted') });
      }
      setSelected(new Set());
      requestWatchReload();
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.deleteFailed'),
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
    if (confirm.sourceConfigKey !== sourceConfigKey) {
      toast.add({ title: t('imageManagerTool.sourceChangedRefresh'), type: 'warning' });
      setConfirm(null);
    } else
      void runDelete(
        confirm.sourceId,
        confirm.ids,
        confirm.targets,
        confirm.name,
        confirm.deleteManifest,
      );
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
  const taskUsesBytes = (task: ImageTask) => task.progressUnit === 'bytes';
  const taskDone = (task: ImageTask) => (taskUsesBytes(task) ? task.bytes : task.completed);
  const taskPercent = (task: ImageTask) => {
    if (task.status === 'success') return 100;
    // docker pull 在管道下只输出层状态，层数会随发现新层（含“已存在”的层先报完成）
    // 回退，用 completed/total 会先冲到 100% 再掉回来；拉取改用不确定进度，
    // 进度文本仍显示已完成的层数。
    if (task.type === 'pull' || task.totalEstimated) return null;
    if (task.total <= 0) return null;
    const percent = (taskDone(task) / task.total) * 100;
    return Math.min(100, percent);
  };
  const taskProgress =
    activeTasks.length === 1 && activeTasks[0].total > 0 ? taskPercent(activeTasks[0]) : null;
  const runBatchExport = async (requestedRows: ImageRow[] = selectedRows) => {
    const imageIDs = requestedRows.map(
      (row) => row.reference || imageExportReference(row.image, unnamed),
    );
    const estimatedSizes = requestedRows.map((row) => imageExportEstimateBytes(row.image));
    if (imageIDs.length === 0 || batchExportStarting) return;
    setBatchExportStarting(true);
    try {
      const result = await StartImageExports(source.id, imageIDs, estimatedSizes);
      if (result.started > 0) {
        applyTasks(result.snapshot);
        openTaskCenter('image-manager');
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
  const runExport = async (row: ImageRow) => {
    try {
      const result = await StartImageExport(
        source.id,
        row.reference || imageExportReference(row.image, unnamed),
        imageExportEstimateBytes(row.image),
      );
      if (result.started > 0) {
        applyTasks(result.snapshot);
        openTaskCenter('image-manager');
      }
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.exportFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    }
  };
  const runPullRefs = async (
    requestedRefs: string[],
    options = { username: '', password: '', platform: '' },
  ) => {
    const refs = [...new Set(requestedRefs.map((ref) => ref.trim()).filter(Boolean))];
    if (refs.length === 0 || pullStarting) return;
    setPullStarting(true);
    try {
      const result = await StartImagePulls(source.id, refs, options);
      if (result.started > 0) {
        // 只放入后台任务队列，不弹出任务面板；进度由底栏的后台任务入口展示。
        // 拉取在后台异步执行，开始时就刷新只会拿到旧结果；完成后由 Go 侧重扫并推送 diff。
        applyTasks(result.snapshot);
      }
    } catch (error) {
      toast.add({
        title: t('imageManagerTool.pullFailed'),
        description: errorMessage(error) || undefined,
        type: 'error',
      });
    } finally {
      setPullStarting(false);
    }
  };
  const runPull = (requestedRows: ImageRow[]) =>
    runPullRefs(requestedRows.map((row) => row.reference));
  const runRegistryPull = async (
    reference: string,
    target: string,
    options: { username: string; password: string; platform: string },
  ) => {
    if (pullStarting) return;
    setPullStarting(true);
    setOperationError('');
    const key = sourceConfigKey;
    try {
      const result = await StartRegistryImagePulls(
        source.id,
        [{ source: reference, target }],
        options,
      );
      applyTasks(result.snapshot);
      if (currentSourceConfigKey.current === key) setOperationDialog(null);
    } catch (reason) {
      if (currentSourceConfigKey.current === key) setOperationError(errorMessage(reason));
    } finally {
      setPullStarting(false);
    }
  };
  const runImport = async () => {
    if (actionBlocked || importStarting) return;
    setImportStarting(true);
    const key = sourceConfigKey;
    const request = PrepareImageImports(source.id);
    importRequest.current = request;
    try {
      const entries = (await request) ?? [];
      if (currentSourceConfigKey.current === key && entries.length > 0) {
        setImportPlan({ sourceConfigKey: key, entries });
      }
    } catch (reason) {
      if (!(reason instanceof CancelError) && currentSourceConfigKey.current === key) {
        toast.add({
          title: t('imageManagerTool.importFailed'),
          description: errorMessage(reason),
          type: 'error',
        });
      }
    } finally {
      if (importRequest.current === request) {
        importRequest.current = null;
        setImportStarting(false);
      }
    }
  };
  const submitImport = async (entries: ImageImportEntry[]) => {
    if (!importPlan || importPlan.sourceConfigKey !== sourceConfigKey) {
      throw new Error(t('imageManagerTool.sourceChangedRefresh'));
    }
    const key = sourceConfigKey;
    const result = await StartImageImports(source.id, entries);
    applyTasks(result.snapshot);
    if (currentSourceConfigKey.current === key) setImportPlan(null);
  };

  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutToolbar
          left={
            <div className="flex min-w-0 flex-wrap items-end gap-4 max-[700px]:w-full">
              <ToolHeaderField
                label={t('imageManagerTool.source')}
                labelId={sourceLabelId}
                className="max-[700px]:w-full"
              >
                <Select
                  items={sources.map((item) => ({
                    value: item.id,
                    label: sourceDisplayName(item, t, profiles),
                  }))}
                  value={source.id}
                  onValueChange={(value) => {
                    if (value === MANAGE_SOURCES_VALUE) {
                      openManage();
                      return;
                    }
                    if (value) {
                      setPickedSourceId(value);
                    }
                  }}
                >
                  <SelectTrigger
                    aria-labelledby={sourceLabelId}
                    className="w-[220px] max-w-full max-[700px]:w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {sources.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {sourceDisplayName(item, t, profiles)}
                        </SelectItem>
                      ))}
                      {sources.length > 0 ? <SelectSeparator /> : null}
                      <SelectItem value={MANAGE_SOURCES_VALUE}>
                        <span className="flex items-center gap-2">
                          <GearSix size={14} weight="duotone" />
                          {t('imageManagerTool.manageSources')}
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {sourceProfileMissing ? (
                  <Badge variant="destructive" className="h-5 text-[10px]">
                    {t('imageManagerTool.sshProfileMissing')}
                  </Badge>
                ) : null}
              </ToolHeaderField>
              <ImageSearchField
                id="image-manager-search"
                label={t('imageManagerTool.search')}
                value={search}
                onSearch={setSearch}
                placeholder={t('imageManagerTool.searchPlaceholder')}
              />
            </div>
          }
          right={
            <div className="flex min-w-0 flex-wrap items-center gap-2 max-[700px]:w-full max-[700px]:justify-end">
              <ToolActionButton
                variant="secondary"
                icon={CloudArrowDown}
                label={t('imageManagerTool.pull')}
                disabled={actionBlocked || pullStarting}
                onPress={openPullImageDialog}
              />
              <ToolActionButton
                variant="secondary"
                label={t('imageManagerTool.importTar')}
                leading={
                  importStarting ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Package className="size-3.5" weight="duotone" aria-hidden />
                  )
                }
                disabled={actionBlocked || importStarting}
                onPress={() => void runImport()}
              />
              {sourceViewState === 'connecting' ? (
                <ToolActionButton
                  variant="secondary"
                  icon={XCircle}
                  label={t('common.cancel')}
                  onPress={cancelWatch}
                />
              ) : (
                <ToolActionButton
                  variant="secondary"
                  label={t('imageManagerTool.refresh')}
                  leading={<ArrowsClockwise className="size-3.5" weight="duotone" aria-hidden />}
                  disabled={busy !== null || sourceProfileMissing}
                  onPress={() => {
                    refreshList();
                  }}
                />
              )}
            </div>
          }
        />
        <ToolLayoutContent className="flex min-h-0 flex-col">
          {watchCanceled ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <XCircle size={16} weight="duotone" className="text-muted-foreground" />
              <div className="text-sm text-muted-foreground">
                {t('imageManagerTool.watchCanceled')}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('imageManagerTool.watchCanceledHint')}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-[30px] px-[11px] text-[11px]"
                onClick={restartWatch}
              >
                <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                {t('common.retry')}
              </Button>
            </div>
          ) : contentViewState === 'loading' ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
              <Spinner />
              {sourceViewState === 'connecting' ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={cancelWatch}
                >
                  <XCircle data-icon="inline-start" size={14} />
                  {t('common.cancel')}
                </Button>
              )}
            </div>
          ) : contentViewState === 'error' ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <Package size={28} weight="duotone" className="text-muted-foreground" />
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
                onClick={refreshList}
              >
                <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                {t('imageManagerTool.refresh')}
              </Button>
            </div>
          ) : contentViewState === 'empty' || contentViewState === 'no-results' ? (
            <div className="flex h-auto min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
              <Package size={28} weight="duotone" className="text-muted-foreground" />
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
            <ScrollArea
              className="min-h-0 flex-1 overscroll-contain [padding-inline-end:var(--overlay-scrollbar-size)]"
              onViewport={setImageListViewport}
            >
              <Table className="min-w-[640px]" containerClassName="overflow-visible">
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
                    <TableHead className="w-[110px] whitespace-nowrap">
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
                      className="w-[104px] whitespace-nowrap"
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
                      className="w-[160px] whitespace-nowrap"
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {imagePaddingTop > 0 ? (
                    <tr>
                      <td colSpan={5} style={{ height: imagePaddingTop, padding: 0 }} />
                    </tr>
                  ) : null}
                  {imageVirtualRows.map((virtualRow) => {
                    const row = filteredRows[virtualRow.index];
                    const operationRows = operationRowsFor(row);
                    const tagOperationAllowed =
                      operationRows.length > 0 &&
                      operationRows.every((item) => isNamedImageRow(item));
                    const dockerOperationAllowed =
                      sourceSupportsDockerMutations && tagOperationAllowed;
                    const rowLabel = imageRowLabel(row, unnamed);
                    const architectures = imageArchitectures(row.image);
                    return (
                      <ContextMenu key={row.key}>
                        <ContextMenuTrigger
                          render={
                            <TableRow
                              ref={imageRowVirtualizer.measureElement}
                              data-index={virtualRow.index}
                              data-row-key={row.key}
                              data-state={selected.has(row.key) ? 'selected' : undefined}
                              className="select-none border-border/60"
                            />
                          }
                        >
                          <TableCell
                            className="cursor-default"
                            onPointerDown={(event) => startCheckboxDrag(event, row.key)}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <Checkbox
                              className="cursor-default"
                              checked={selected.has(row.key)}
                              onCheckedChange={(checked) => toggleRow(row.key, checked === true)}
                              aria-label={t('imageManagerTool.selectRow')}
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <span className="font-mono text-[12px]" title={row.image.id}>
                              {source.kind === 'registry'
                                ? row.image.digest
                                  ? shortId(row.image.digest)
                                  : t('imageManagerTool.emptyValue')
                                : shortId(row.image.id)}
                            </span>
                          </TableCell>
                          <TableCell className="min-w-40">
                            <div className="inline-flex items-center gap-2 whitespace-nowrap">
                              <button
                                type="button"
                                className="cursor-pointer text-left text-foreground hover:text-primary hover:underline hover:underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={interactionBlocked}
                                title={t('imageManagerTool.viewName', { name: rowLabel })}
                                aria-label={t('imageManagerTool.viewName', { name: rowLabel })}
                                onClick={() => void viewRow(row)}
                              >
                                {rowLabel}
                              </button>
                              {architectures.length > 0 ? (
                                <Badge
                                  variant="secondary"
                                  title={t('imageManagerTool.architectureHint', {
                                    architectures: architectures.join(', '),
                                  })}
                                >
                                  {architectures.length === 1
                                    ? architectures[0]
                                    : t('imageManagerTool.architectureMulti')}
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatBytes(imageSizeBytes(row.image), i18n.language) ||
                              t('imageManagerTool.emptyValue')}
                          </TableCell>
                          <TableCell
                            className="whitespace-nowrap text-muted-foreground"
                            title={formatCreatedAt(row.image.createdAt, i18n.language)}
                          >
                            {formatCreatedAtCompact(row.image.createdAt, i18n.language)}
                          </TableCell>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="min-w-48">
                          <ContextMenuGroup>
                            <ContextMenuItem
                              disabled={interactionBlocked}
                              onClick={() => copyImageNames(operationRows)}
                            >
                              <Copy data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchCopyName')
                                : t('imageManagerTool.copyName')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={interactionBlocked}
                              onClick={() => copyImageIds(operationRows)}
                            >
                              <IdentificationCard data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchCopyId')
                                : t('imageManagerTool.copyId')}
                            </ContextMenuItem>
                          </ContextMenuGroup>
                          <ContextMenuSeparator />
                          <ContextMenuGroup>
                            <ContextMenuItem
                              disabled={actionBlocked}
                              onClick={() =>
                                operationRows.length === 1
                                  ? void runExport(operationRows[0])
                                  : void runBatchExport(operationRows)
                              }
                            >
                              <DownloadSimple data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchExport')
                                : t('imageManagerTool.exportTar')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={actionBlocked || !dockerOperationAllowed}
                              onClick={() => void runPull(operationRows)}
                            >
                              <CloudArrowDown data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchPullUpdate')
                                : t('imageManagerTool.pullUpdate')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={actionBlocked || !dockerOperationAllowed}
                              onClick={() => openPushDialog(operationRows)}
                            >
                              <UploadSimple data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchPushRemote')
                                : t('imageManagerTool.pushRemote')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={actionBlocked || !tagOperationAllowed}
                              onClick={() => openRenameDialog(operationRows)}
                            >
                              <PencilSimple data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchRename')
                                : t('imageManagerTool.rename')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={actionBlocked || !tagOperationAllowed}
                              onClick={() => openCopyTagDialog(operationRows)}
                            >
                              <Copy data-icon="inline-start" weight="duotone" />
                              {operationRows.length > 1
                                ? t('imageManagerTool.batchCopyTagAction')
                                : t('imageManagerTool.copyTagAction')}
                            </ContextMenuItem>
                          </ContextMenuGroup>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            disabled={actionBlocked || !sourceCanDelete}
                            onClick={() =>
                              setConfirm({
                                type: 'delete',
                                ids: operationRows.map((item) => item.reference || item.image.id),
                                targets: deleteTargets(operationRows),
                                name:
                                  operationRows.length > 1
                                    ? t('imageManagerTool.selectedCount', {
                                        count: operationRows.length,
                                      })
                                    : rowLabel,
                                sourceId: source.id,
                                sourceKind: source.kind,
                                sourceConfigKey,
                                deleteManifest: true,
                              })
                            }
                          >
                            <Trash data-icon="inline-start" weight="duotone" />
                            {operationRows.length > 1
                              ? t('imageManagerTool.batchDelete')
                              : t('imageManagerTool.delete')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                  {imagePaddingBottom > 0 ? (
                    <tr>
                      <td colSpan={5} style={{ height: imagePaddingBottom, padding: 0 }} />
                    </tr>
                  ) : null}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              <span>{t('imageManagerTool.filteredSummary', { count: filteredRows.length })}</span>
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
                  onClick={() => openTaskCenter('image-manager')}
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
          </div>
        </ToolLayoutFooter>
        <Dialog
          open={operationDialog !== null}
          onOpenChange={(open) => {
            if (!open && !busy && !pullStarting) {
              setOperationDialog(null);
              setOperationError('');
            }
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {operationDialog?.type === 'push'
                  ? operationDialog.changes.length > 1
                    ? t('imageManagerTool.batchPushTitle')
                    : t('imageManagerTool.pushTitle')
                  : operationDialog?.type === 'rename'
                    ? operationDialog.rows.length > 1
                      ? t('imageManagerTool.batchRenameTitle')
                      : t('imageManagerTool.renameTitle')
                    : operationDialog?.type === 'copy-tag'
                      ? t('imageManagerTool.copyTagTitle')
                      : t('imageManagerTool.pullImage')}
              </DialogTitle>
              <DialogDescription>
                {operationDialog?.type === 'push'
                  ? operationDialog.changes.length > 1
                    ? t('imageManagerTool.batchPushBody', {
                        count: operationDialog.changes.length,
                      })
                    : t('imageManagerTool.pushBody')
                  : operationDialog?.type === 'rename'
                    ? t('imageManagerTool.renameBody', {
                        total: operationDialog.rows.length,
                      })
                    : operationDialog?.type === 'copy-tag'
                      ? t('imageManagerTool.copyTagBody', {
                          count: operationDialog.rows.length,
                        })
                      : t(
                          isRegistrySource
                            ? 'imageManagerTool.registryPullBody'
                            : 'imageManagerTool.pullImageBody',
                        )}
              </DialogDescription>
            </DialogHeader>
            {operationDialog?.type === 'push' && operationDialog.changes.length === 1 ? (
              <form
                className="grid gap-2"
                id={operationFormID}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitOperation();
                }}
              >
                <Label htmlFor="image-operation-target">
                  {t('imageManagerTool.targetImageName')}
                </Label>
                <Input
                  id="image-operation-target"
                  value={operationDialog.value}
                  placeholder={operationDialog.changes[0]?.source}
                  aria-invalid={Boolean(operationError)}
                  onChange={(event) => {
                    setOperationError('');
                    setOperationDialog((current) =>
                      current?.type === 'push'
                        ? { ...current, value: event.target.value }
                        : current,
                    );
                  }}
                />
              </form>
            ) : null}
            {operationDialog?.type === 'rename' ? (
              <form
                className="grid gap-3"
                id={operationFormID}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitOperation();
                }}
              >
                <div className="grid gap-1.5">
                  <Label>{t('imageManagerTool.renameScope')}</Label>
                  <div className="flex w-fit gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={operationDialog.form.scope === 'tag' ? 'secondary' : 'ghost'}
                      onClick={() => setRenameScope('tag')}
                    >
                      {t('imageManagerTool.renameScopeTag')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={operationDialog.form.scope === 'name' ? 'secondary' : 'ghost'}
                      onClick={() => setRenameScope('name')}
                    >
                      {t('imageManagerTool.renameScopeName')}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('imageManagerTool.renameMode')}</Label>
                  <div className="flex w-fit flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={operationDialog.form.mode === 'prefix' ? 'secondary' : 'ghost'}
                      onClick={() => updateRenameForm({ mode: 'prefix', value: '' })}
                    >
                      {t('imageManagerTool.renameModePrefix')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={operationDialog.form.mode === 'suffix' ? 'secondary' : 'ghost'}
                      onClick={() => updateRenameForm({ mode: 'suffix', value: '' })}
                    >
                      {t('imageManagerTool.renameModeSuffix')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={operationDialog.form.mode === 'replace' ? 'secondary' : 'ghost'}
                      onClick={() => updateRenameForm({ mode: 'replace', value: '' })}
                    >
                      {t('imageManagerTool.renameModeReplace')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={operationDialog.form.mode === 'custom' ? 'secondary' : 'ghost'}
                      disabled={
                        operationDialog.rows.length > 1 && operationDialog.form.scope !== 'tag'
                      }
                      onClick={() => updateRenameForm({ mode: 'custom', value: '' })}
                    >
                      {t('imageManagerTool.renameModeCustom')}
                    </Button>
                  </div>
                </div>
                {operationDialog.form.mode === 'replace' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="image-operation-find">
                        {t('imageManagerTool.renameFindLabel')}
                      </Label>
                      <Input
                        id="image-operation-find"
                        value={operationDialog.form.find}
                        placeholder={t('imageManagerTool.renameFindPlaceholder')}
                        aria-invalid={Boolean(operationError)}
                        onChange={(event) => updateRenameForm({ find: event.target.value })}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="image-operation-replacement">
                        {t('imageManagerTool.renameReplaceLabel')}
                      </Label>
                      <Input
                        id="image-operation-replacement"
                        value={operationDialog.form.replacement}
                        placeholder={t('imageManagerTool.renameReplacePlaceholder')}
                        aria-invalid={Boolean(operationError)}
                        onChange={(event) => updateRenameForm({ replacement: event.target.value })}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-operation-target">
                      {t(
                        operationDialog.form.mode === 'prefix'
                          ? 'imageManagerTool.renamePrefixLabel'
                          : operationDialog.form.mode === 'suffix'
                            ? 'imageManagerTool.renameSuffixLabel'
                            : 'imageManagerTool.renameCustomLabel',
                      )}
                    </Label>
                    <Input
                      id="image-operation-target"
                      value={operationDialog.form.value}
                      placeholder={t(
                        operationDialog.form.mode === 'prefix'
                          ? 'imageManagerTool.renamePrefixPlaceholder'
                          : operationDialog.form.mode === 'suffix'
                            ? 'imageManagerTool.renameSuffixPlaceholder'
                            : 'imageManagerTool.renameCustomPlaceholder',
                      )}
                      autoFocus
                      aria-invalid={Boolean(operationError)}
                      onChange={(event) => updateRenameForm({ value: event.target.value })}
                    />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label>{t('imageManagerTool.renamePreview')}</Label>
                  {renamePreview.length === 0 ? (
                    <p className="m-0 text-xs text-muted-foreground">
                      {t('imageManagerTool.renamePreviewEmpty')}
                    </p>
                  ) : (
                    <ScrollArea className="max-h-40 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <div className="grid gap-2">
                        {renamePreview.map((item, index) => (
                          <div key={`${item.source}-${index}`} className="grid gap-0.5">
                            <code className="break-all font-mono text-xs leading-5 text-muted-foreground">
                              {item.source}
                            </code>
                            <div className="flex items-baseline gap-1.5">
                              <span aria-hidden="true" className="text-muted-foreground">
                                →
                              </span>
                              <code
                                className={`min-w-0 break-all font-mono text-xs leading-5 ${
                                  item.status === 'ok' ? 'text-foreground' : 'text-destructive'
                                }`}
                              >
                                {item.target || t('imageManagerTool.emptyValue')}
                              </code>
                            </div>
                            {item.status !== 'ok' ? (
                              <span className="text-[10px] text-destructive">
                                {t(
                                  item.status === 'empty'
                                    ? 'imageManagerTool.renameInvalidEmpty'
                                    : item.status === 'unchanged'
                                      ? 'imageManagerTool.renameInvalidUnchanged'
                                      : item.status === 'crossRepository'
                                        ? 'imageManagerTool.renameInvalidCrossRepository'
                                        : 'imageManagerTool.renameInvalidDuplicate',
                                )}
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </form>
            ) : null}
            {operationDialog?.type === 'copy-tag' ? (
              <form
                className="grid gap-2"
                id={operationFormID}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitOperation();
                }}
              >
                <Label htmlFor="image-operation-tag">{t('imageManagerTool.newTag')}</Label>
                <Input
                  id="image-operation-tag"
                  value={operationDialog.value}
                  placeholder={t('imageManagerTool.newTagPlaceholder')}
                  aria-invalid={Boolean(operationError)}
                  onChange={(event) => {
                    setOperationError('');
                    setOperationDialog((current) =>
                      current?.type === 'copy-tag'
                        ? { ...current, value: event.target.value }
                        : current,
                    );
                  }}
                />
              </form>
            ) : null}
            {operationDialog?.type === 'pull-image' ? (
              <form
                className="grid gap-2"
                id={operationFormID}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitOperation();
                }}
              >
                <Label htmlFor="image-operation-reference">
                  {t('imageManagerTool.imageReference')}
                </Label>
                <Input
                  id="image-operation-reference"
                  disabled={pullStarting}
                  value={operationDialog.value}
                  placeholder={t('imageManagerTool.imageReferencePlaceholder')}
                  autoFocus
                  aria-invalid={Boolean(operationError)}
                  onChange={(event) => {
                    updatePullInput({ value: event.target.value });
                  }}
                />
                <Label htmlFor="image-operation-platform">
                  {t('imageManagerTool.pullPlatform')}
                </Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={operationDialog.platform}
                    items={[
                      { value: 'current', label: currentPullPlatformLabel },
                      { value: 'all', label: t('imageManagerTool.pullAllPlatforms') },
                      ...operationDialog.platforms.map((value) => ({ value, label: value })),
                    ]}
                    disabled={
                      pullStarting ||
                      !operationDialog.value.trim() ||
                      operationDialog.platformStatus === 'loading'
                    }
                    onValueChange={(value) =>
                      setOperationDialog((current) =>
                        current?.type === 'pull-image'
                          ? { ...current, platform: value ?? 'current' }
                          : current,
                      )
                    }
                  >
                    <SelectTrigger id="image-operation-platform" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="current" disabled={!currentPullPlatform}>
                          {currentPullPlatformLabel}
                        </SelectItem>
                        <SelectItem value="all">
                          {t('imageManagerTool.pullAllPlatforms')}
                        </SelectItem>
                        {operationDialog.platforms.map((platform) => (
                          <SelectItem key={platform} value={platform}>
                            {platform}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={t('imageManagerTool.resolvePullPlatforms')}
                    title={t('imageManagerTool.resolvePullPlatforms')}
                    disabled={
                      pullStarting ||
                      !operationDialog.value.trim() ||
                      operationDialog.platformStatus === 'loading'
                    }
                    onClick={() => void resolvePullPlatforms()}
                  >
                    {operationDialog.platformStatus === 'loading' ? (
                      <Spinner />
                    ) : (
                      <ArrowsClockwise weight="duotone" />
                    )}
                  </Button>
                </div>
                <p
                  className={`m-0 text-xs ${operationDialog.platformStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                  role="status"
                >
                  {operationDialog.platformStatus === 'error'
                    ? t('imageManagerTool.pullPlatformsFailed', {
                        detail: operationDialog.platformError,
                      })
                    : operationDialog.platformStatus === 'loading'
                      ? t('imageManagerTool.pullPlatformsLoading')
                      : operationDialog.platformStatus === 'idle'
                        ? t('imageManagerTool.pullPlatformsIdle')
                        : t('imageManagerTool.pullPlatformsReady', {
                            total: operationDialog.platforms.length,
                          })}
                </p>
                {isRegistrySource ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="grid gap-2">
                        <Label htmlFor="image-pull-username">
                          {t('imageManagerTool.pullUsername')}
                        </Label>
                        <Input
                          id="image-pull-username"
                          autoComplete="username"
                          disabled={pullStarting}
                          value={operationDialog.username}
                          onChange={(event) => updatePullInput({ username: event.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="image-pull-password">
                          {t('imageManagerTool.pullPassword')}
                        </Label>
                        <Input
                          id="image-pull-password"
                          type="password"
                          autoComplete="current-password"
                          disabled={pullStarting}
                          value={operationDialog.password}
                          onChange={(event) => updatePullInput({ password: event.target.value })}
                        />
                      </div>
                    </div>
                    <Label htmlFor="image-operation-pull-target">
                      {t('imageManagerTool.importTarget')}
                    </Label>
                    <Input
                      id="image-operation-pull-target"
                      value={operationDialog.target}
                      placeholder={t('imageManagerTool.importTargetPlaceholder')}
                      disabled={pullStarting}
                      required
                      onChange={(event) => {
                        setOperationError('');
                        setOperationDialog((current) =>
                          current?.type === 'pull-image'
                            ? { ...current, target: event.target.value }
                            : current,
                        );
                      }}
                    />
                  </>
                ) : null}
              </form>
            ) : null}
            {operationDialog?.type === 'push' && operationDialog.changes.length > 1 ? (
              <ScrollArea
                element="form"
                className="max-h-36 rounded-md border border-border bg-muted/40 px-3 py-2"
                id={operationFormID}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitOperation();
                }}
              >
                {operationDialog.changes.map((change) => (
                  <code key={change.source} className="block break-all font-mono text-xs leading-5">
                    {change.source}
                  </code>
                ))}
              </ScrollArea>
            ) : null}
            {operationError ? (
              <p className="m-0 text-xs text-destructive" role="alert">
                {operationError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy !== null || pullStarting}
                onClick={() => {
                  setOperationDialog(null);
                  setOperationError('');
                }}
              >
                {t('imageManagerTool.cancel')}
              </Button>
              <Button
                type="submit"
                form={operationFormID}
                disabled={
                  busy !== null ||
                  pullStarting ||
                  (operationDialog?.type === 'rename' && !renameReady) ||
                  (operationDialog?.type === 'pull-image' &&
                    operationDialog.platform === 'current' &&
                    !currentPullPlatform)
                }
              >
                {busy || pullStarting ? <Spinner data-icon="inline-start" /> : null}
                {t('imageManagerTool.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </ToolLayout>
      {importPlan && importPlan.sourceConfigKey === sourceConfigKey ? (
        <ImageImportDialog
          entries={importPlan.entries}
          onClose={() => setImportPlan(null)}
          onSubmit={submitImport}
        />
      ) : null}
      <TargetHostManagerDialog<ImageSource, SourceDraft>
        open={manageOpen}
        onOpenChange={setManageOpen}
        items={sources}
        itemKey={(item) => item.id}
        itemName={(item) => sourceDisplayName(item, t, profiles)}
        itemDisabled={isLocalSource}
        createDraft={() => ({ id: '', name: '', kind: 'ssh', sshProfileID: '' }) as SourceDraft}
        toDraft={(item) => ({ ...(item as ManagedImageSource) }) as SourceDraft}
        commitDraft={async (draft, previous) => {
          const kind = draft.kind as 'ssh' | 'registry';
          if (kind === 'ssh' && !draft.sshProfileID?.trim())
            return t('imageManagerTool.sshProfileRequired');
          try {
            const id = draft.id?.trim() || `${kind}:${crypto.randomUUID()}`;
            const next = await ValidateImageSource(sourceCandidate(draft, id));
            return upsertManagerItem(
              previous,
              next,
              (item) => item.id,
              draft.id?.trim() || undefined,
            );
          } catch (error) {
            return errorMessage(error) || t('imageManagerTool.sourceInvalid');
          }
        }}
        saveItems={saveManagedSources}
        saving={savingSources}
        renderMeta={(item) =>
          isLocalSource(item) ? (
            <span>{t('imageManagerTool.localSource')}</span>
          ) : (
            <>
              <span>
                {item.kind === 'registry'
                  ? t('imageManagerTool.kindRegistry')
                  : t('imageManagerTool.kindSsh')}
              </span>
              {sourceMissingSSHProfile(item, profiles) ? (
                <Badge variant="destructive" className="h-4 text-[9px]">
                  {t('imageManagerTool.sshProfileMissing')}
                </Badge>
              ) : null}
            </>
          )
        }
        renderForm={({ draft, setDraft }) => (
          <>
            <div className="grid gap-1.5">
              <Label>{t('imageManagerTool.sourceKind')}</Label>
              <div className="flex w-fit gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={draft.kind === 'ssh' ? 'secondary' : 'ghost'}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      kind: 'ssh',
                      registryURL: '',
                      registryUsername: '',
                      registryPassword: '',
                    })
                  }
                >
                  {t('imageManagerTool.kindSsh')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={draft.kind === 'registry' ? 'secondary' : 'ghost'}
                  onClick={() => setDraft({ ...draft, kind: 'registry', sshProfileID: '' })}
                >
                  {t('imageManagerTool.kindRegistry')}
                </Button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="target-host-name">{t('imageManagerTool.sourceName')}</Label>
              <Input
                id="target-host-name"
                value={draft.name ?? ''}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            {draft.kind === 'ssh' ? (
              <div className="grid gap-1.5">
                <Label>{t('imageManagerTool.sshProfile')}</Label>
                <SSHProfileFormField
                  value={draft.sshProfileID ?? ''}
                  onSelect={(profile) =>
                    setDraft({
                      ...draft,
                      sshProfileID: profile?.id ?? '',
                      name: draft.name?.trim() || profile?.name || draft.name,
                    })
                  }
                  placeholder={t('imageManagerTool.selectSSHProfile')}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label>{t('imageManagerTool.registryURL')}</Label>
                  <Input
                    value={draft.registryURL ?? ''}
                    onChange={(event) => setDraft({ ...draft, registryURL: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>{t('imageManagerTool.registryUsername')}</Label>
                    <Input
                      value={draft.registryUsername ?? ''}
                      onChange={(event) =>
                        setDraft({ ...draft, registryUsername: event.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>{t('imageManagerTool.registryPassword')}</Label>
                    <Input
                      type="password"
                      value={draft.registryPassword ?? ''}
                      onChange={(event) =>
                        setDraft({ ...draft, registryPassword: event.target.value })
                      }
                    />
                  </div>
                </div>
              </>
            )}
          </>
        )}
        renderFormActions={(draft) =>
          draft.kind === 'registry' ? (
            <Button
              type="button"
              variant="outline"
              disabled={testingSource}
              onClick={() => {
                setTestingSource(true);
                void TestImageSourceConnection(sourceCandidate(draft))
                  .then(() =>
                    toast.add({
                      title: t('imageManagerTool.connectionSucceeded'),
                      type: 'success',
                    }),
                  )
                  .catch((error) =>
                    toast.add({
                      title: errorMessage(error) || t('imageManagerTool.connectionFailed'),
                      type: 'error',
                    }),
                  )
                  .finally(() => setTestingSource(false));
              }}
            >
              {testingSource ? <Spinner data-icon="inline-start" /> : null}
              {t('imageManagerTool.testConnection')}
            </Button>
          ) : null
        }
        strings={{
          title: t('imageManagerTool.manageSourcesTitle'),
          edit: t('imageManagerTool.editTargetHost'),
          remove: t('imageManagerTool.removeTargetHost'),
          dragItem: (name) => t('sidebar.dragTool', { name }),
          empty: t('imageManagerTool.targetHostsEmpty'),
          emptyHint: t('imageManagerTool.targetHostsEmptyHint'),
          save: t('common.save'),
          back: t('common.cancel'),
          discardTitle: t('imageManagerTool.discardTargetsTitle'),
          discardDescription: t('imageManagerTool.discardTargetsDescription'),
          discardConfirm: t('imageManagerTool.discardTargetsConfirm'),
          removeTitle: t('imageManagerTool.removeSourceConfirmTitle'),
          removeDescription: (name) => t('imageManagerTool.removeSourceConfirmBody', { name }),
          formTitle: (editing) =>
            editing ? t('imageManagerTool.editTargetHost') : t('imageManagerTool.addTargetHost'),
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t('imageManagerTool.deleteConfirmTitle')}
        confirmLabel={t('imageManagerTool.confirm')}
        cancelLabel={t('imageManagerTool.cancel')}
        destructive
        busy={busy !== null}
        onConfirm={confirmAction}
      >
        {confirm?.type === 'delete' ? (
          confirm.sourceKind === 'registry' ? (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="grid gap-1.5">
                <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {t('imageManagerTool.registryDeleteMode')}
                </div>
                <div className="flex w-fit flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={confirm.deleteManifest ? 'secondary' : 'ghost'}
                    disabled={busy !== null}
                    onClick={() =>
                      setConfirm((current) =>
                        current?.type === 'delete' ? { ...current, deleteManifest: true } : current,
                      )
                    }
                  >
                    {t('imageManagerTool.registryDeleteModeManifest')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={!confirm.deleteManifest ? 'secondary' : 'ghost'}
                    disabled={busy !== null}
                    onClick={() =>
                      setConfirm((current) =>
                        current?.type === 'delete'
                          ? { ...current, deleteManifest: false }
                          : current,
                      )
                    }
                  >
                    {t('imageManagerTool.registryDeleteModeTag')}
                  </Button>
                </div>
              </div>
              <p className="m-0">
                {confirm.deleteManifest
                  ? t('imageManagerTool.registryDeleteConfirmSummary')
                  : t('imageManagerTool.registryDeleteTagSummary')}
              </p>
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
                          <Copy aria-hidden="true" />
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
                  <ScrollArea className="mt-1.5 max-h-32 min-w-0 pr-1">
                    <div className="flex flex-wrap gap-1.5">
                      {registryConfirmTags.map((tag, index) => (
                        <button
                          type="button"
                          key={`${tag}-${index}`}
                          className="group inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-left text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          title={t('imageManagerTool.copyTag')}
                          aria-label={t('imageManagerTool.copyTag')}
                          onClick={() => void copyTag(tag)}
                        >
                          <Copy size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                          <code className="min-w-0 break-all font-mono text-xs leading-5">
                            {tag}
                          </code>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              <p className="m-0 text-xs text-muted-foreground">
                {confirm.deleteManifest
                  ? t('imageManagerTool.registryDeleteGCHint')
                  : t('imageManagerTool.registryDeleteTagRepushHint')}
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
      </ConfirmDialog>
    </Reveal>
  );
}
