import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Events } from '@wailsio/runtime';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Archive,
  ArrowClockwise,
  ArrowUpRight,
  ArrowsLeftRight,
  CaretDown,
  CaretRight,
  CaretUp,
  CheckCircle,
  Copy,
  DownloadSimple,
  File,
  FileArchive,
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileIni,
  FileJpg,
  FileJs,
  FileJsx,
  FileMd,
  FilePdf,
  FilePng,
  FilePpt,
  FilePy,
  FileRs,
  FileSql,
  FileSvg,
  FileText,
  FileTs,
  FileTsx,
  FileTxt,
  FileVideo,
  FileVue,
  FileXls,
  FileZip,
  Folder,
  FolderSimplePlus,
  FolderStar,
  GearSix,
  HardDrives,
  ListDashes,
  MagnifyingGlass,
  PencilSimple,
  Star,
  Trash,
  UploadSimple,
  Warning,
  XCircle,
  type Icon,
} from '@phosphor-icons/react';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
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
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import {
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
  useCheckboxDragSelect,
} from './shared';
import { useFileDrop } from './fileDrop';
import type {
  FileSource,
  FileTask,
  FileTaskSnapshot,
  RemoteFileEntry,
  SSHProfile,
} from '../../bindings/changeme/models';
import {
  CalculateRemoteSize,
  CancelFileTask,
  CreateRemoteDirectory,
  GetFileSources,
  GetFileTasks,
  ListRemoteFiles,
  OperateRemoteFiles,
  ResolveRemoteFileTask,
  SaveFileSources,
  SearchRemoteFiles,
  StartFileDownload,
  StartRemoteFileOperation,
  StartFileUpload,
} from '../../bindings/changeme/fileservice';
import { SSHProfileSelect } from './SSHProfileSelect';
import { ConfirmDialog } from './ConfirmDialog';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { TargetHostManagerDialog } from './TargetHostManagerDialog';
import { toast } from './ui/toast';

type ManagedFileSource = FileSource;

const MANAGE_SOURCES_VALUE = '__manage-sources__';

function emptyFileSource(sshProfileID = ''): ManagedFileSource {
  return {
    id: '',
    name: '',
    sshProfileID,
    defaultPath: '',
    favoritePaths: [],
  };
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() || path;
}

function normalizeRemotePath(value: string) {
  const segments: string[] = [];
  for (const segment of value.trim().split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function remoteParent(value: string) {
  const normalized = normalizeRemotePath(value);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function sshProfileListingKey(profile: SSHProfile | null | undefined) {
  if (!profile) return '';
  return [
    profile.origin,
    profile.originAlias,
    profile.host,
    String(profile.port),
    profile.username,
    profile.password,
    profile.privateKey,
    profile.privateKeyPath,
    profile.keyPassphrase,
  ].join('\0');
}

const archiveFileExtensions = new Set([
  '7z',
  'apk',
  'arj',
  'bz',
  'bz2',
  'cab',
  'cpio',
  'deb',
  'dmg',
  'ear',
  'gz',
  'gzip',
  'iso',
  'jar',
  'lz',
  'lz4',
  'lzma',
  'rar',
  'rpm',
  'tar',
  'tbz',
  'tbz2',
  'tgz',
  'txz',
  'war',
  'xz',
  'z',
  'zipx',
  'zst',
]);

const imageFileExtensions = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jif',
  'jfif',
  'jpe',
  'raw',
  'tif',
  'tiff',
  'webp',
]);

const videoFileExtensions = new Set([
  '3gp',
  'avi',
  'flv',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mxf',
  'ogv',
  'webm',
  'wmv',
]);

const audioFileExtensions = new Set([
  'aac',
  'aiff',
  'alac',
  'amr',
  'flac',
  'm4a',
  'm4b',
  'mid',
  'midi',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'wma',
]);

const codeFileExtensions = new Set([
  'astro',
  'bash',
  'dart',
  'ex',
  'exs',
  'fish',
  'go',
  'graphql',
  'h',
  'hpp',
  'java',
  'json',
  'jl',
  'kt',
  'kts',
  'less',
  'lua',
  'm',
  'mm',
  'php',
  'pl',
  'proto',
  'r',
  'rb',
  'scss',
  'sh',
  'swift',
  'toml',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const textFileExtensions = new Set([
  'cfg',
  'conf',
  'diff',
  'env',
  'log',
  'patch',
  'properties',
  'rtf',
  'srt',
]);

const fileIconsByExtension = new Map<string, Icon>([
  ['c', FileC],
  ['cc', FileCpp],
  ['cjs', FileJs],
  ['cpp', FileCpp],
  ['cs', FileCSharp],
  ['css', FileCss],
  ['csv', FileCsv],
  ['doc', FileDoc],
  ['docx', FileDoc],
  ['hh', FileCpp],
  ['h', FileC],
  ['htm', FileHtml],
  ['html', FileHtml],
  ['ini', FileIni],
  ['jpeg', FileJpg],
  ['jpg', FileJpg],
  ['js', FileJs],
  ['jsx', FileJsx],
  ['md', FileMd],
  ['markdown', FileMd],
  ['mjs', FileJs],
  ['mts', FileTs],
  ['cts', FileTs],
  ['pdf', FilePdf],
  ['png', FilePng],
  ['ppt', FilePpt],
  ['pptx', FilePpt],
  ['py', FilePy],
  ['rs', FileRs],
  ['sql', FileSql],
  ['svg', FileSvg],
  ['ts', FileTs],
  ['tsx', FileTsx],
  ['txt', FileTxt],
  ['text', FileTxt],
  ['vue', FileVue],
  ['xls', FileXls],
  ['xlsx', FileXls],
]);

function remoteFileExtension(path: string) {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1) : '';
}

function remoteFileIcon(path: string): Icon {
  const extension = remoteFileExtension(path);
  if (extension === 'zip') return FileZip;
  const extensionIcon = fileIconsByExtension.get(extension);
  if (extensionIcon) return extensionIcon;
  if (archiveFileExtensions.has(extension)) return FileArchive;
  if (imageFileExtensions.has(extension)) return FileImage;
  if (videoFileExtensions.has(extension)) return FileVideo;
  if (audioFileExtensions.has(extension)) return FileAudio;
  if (codeFileExtensions.has(extension)) return FileCode;
  if (textFileExtensions.has(extension)) return FileText;
  return File;
}

function isArchivePath(value: string) {
  const lower = value.toLowerCase();
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz')
  );
}

function archiveStem(value: string) {
  const name = basename(value);
  const lower = name.toLowerCase();
  for (const extension of ['.tar.gz', '.tgz', '.zip', '.tar']) {
    if (lower.endsWith(extension)) {
      const stem = name.slice(0, -extension.length);
      return stem || name;
    }
  }
  return name;
}

function formatBytes(value: number, precise = false) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index++;
  } while (amount >= 1024 && index < units.length - 1);
  const fractionDigits = precise && index > 0 ? 1 : amount >= 10 ? 0 : 1;
  const formatted = amount.toFixed(fractionDigits);
  return `${precise ? formatted.replace(/\.0$/, '') : formatted} ${units[index]}`;
}

function timestampMillis(value: string) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatRemoteTimestamp(value: string, locale: string) {
  const timestamp = timestampMillis(value);
  return timestamp === null ? '—' : new Date(timestamp).toLocaleString(locale);
}

function taskPercent(task: FileTask, completed = task.completed) {
  if (!task.total || task.total <= 0) return null;
  return Math.max(0, Math.min(100, (completed / task.total) * 100));
}

const progressMinCatchUpDuration = 80;
const progressMaxCatchUpDuration = 800;

type ProgressAnimation = {
  from: number;
  to: number;
  startedAt: number;
  duration: number;
};

function progressCatchUpDuration(interval: number) {
  return Math.max(progressMinCatchUpDuration, Math.min(progressMaxCatchUpDuration, interval));
}

function useDisplayedTaskCompleted(task: FileTask) {
  const smooth = task.type === 'download';
  const [displayed, setDisplayed] = useState(task.completed);
  const displayedRef = useRef(task.completed);
  const animationRef = useRef<ProgressAnimation | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTargetAtRef = useRef<number | null>(null);

  const animate = useCallback((now: number) => {
    frameRef.current = null;
    const animation = animationRef.current;
    if (!animation) return;

    const elapsed = Math.max(0, now - animation.startedAt);
    const ratio = Math.min(1, elapsed / animation.duration);
    const next =
      ratio >= 1
        ? animation.to
        : Math.round(animation.from + (animation.to - animation.from) * ratio);
    if (next !== displayedRef.current) {
      displayedRef.current = next;
      setDisplayed(next);
    }

    if (ratio < 1) {
      frameRef.current = requestAnimationFrame(animate);
    } else {
      animationRef.current = null;
    }
  }, []);

  useEffect(() => {
    const target = task.completed;
    const current = displayedRef.current;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!smooth || reducedMotion || target <= current) {
      animationRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (target !== current) {
        displayedRef.current = target;
        setDisplayed(target);
      }
      return;
    }

    if (animationRef.current?.to === target) return;
    const now = performance.now();
    const lastTargetAt = lastTargetAtRef.current;
    lastTargetAtRef.current = now;
    animationRef.current = {
      from: current,
      to: target,
      startedAt: now,
      duration: progressCatchUpDuration(
        lastTargetAt === null ? progressMinCatchUpDuration : now - lastTargetAt,
      ),
    };
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(animate);
    }
  }, [animate, smooth, task.completed]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return displayed;
}

function taskUsesByteProgress(task: FileTask) {
  return task.type === 'download' || task.type === 'compress' || task.type === 'extract';
}

function taskTypeLabel(type: string, t: (key: string) => string) {
  if (type === 'upload') return t('sshFilesTool.upload');
  if (type === 'download') return t('sshFilesTool.download');
  if (type === 'copy') return t('sshFilesTool.copy');
  if (type === 'move') return t('sshFilesTool.move');
  if (type === 'extract') return t('sshFilesTool.extract');
  if (type === 'compress') return t('sshFilesTool.compress');
  return t('sshFilesTool.calculate');
}

function taskStatusLabel(status: string, t: (key: string) => string) {
  const keys: Record<string, string> = {
    queued: 'sshFilesTool.taskQueued',
    running: 'sshFilesTool.taskRunning',
    scanning: 'sshFilesTool.taskScanning',
    conflict: 'sshFilesTool.taskConflict',
    success: 'sshFilesTool.taskSuccess',
    failed: 'sshFilesTool.taskFailed',
    canceled: 'sshFilesTool.taskCanceled',
  };
  return t(keys[status] ?? 'sshFilesTool.taskUnknown');
}

function taskStatusVariant(
  status: string,
): 'secondary' | 'blue' | 'success' | 'destructive' | 'outline' {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'canceled') return 'outline';
  if (status === 'conflict') return 'outline';
  if (status === 'queued' || status === 'running' || status === 'scanning') return 'blue';
  return 'secondary';
}

function TaskProgressMeter({ task, compact = false }: { task: FileTask; compact?: boolean }) {
  const { t } = useTranslation();
  const completed = useDisplayedTaskCompleted(task);
  const percent = taskPercent(task, completed);
  const running = ['queued', 'running', 'scanning'].includes(task.status);
  const progressWidth = percent ?? (task.status === 'success' ? 100 : 0);

  if (compact) {
    return (
      <span
        className={`relative h-1.5 w-20 overflow-hidden rounded-full bg-muted ${percent === null ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${progressWidth}%` }}
        />
      </span>
    );
  }

  const progressText =
    task.type === 'extract' && task.total <= 0
      ? t('sshFilesTool.taskExtractedUnknown', {
          completed: formatBytes(completed),
        })
      : taskUsesByteProgress(task)
        ? t('sshFilesTool.taskBytes', {
            completed: formatBytes(completed, task.type === 'download'),
            total: task.total ? formatBytes(task.total) : '—',
          })
        : task.files > 0
          ? t('sshFilesTool.taskFiles', {
              done: task.doneFiles,
              total: task.files,
            })
          : t('sshFilesTool.taskBytes', {
              completed: formatBytes(completed),
              total: task.total ? formatBytes(task.total) : '—',
            });

  return (
    <div className="mt-2 flex items-center gap-2">
      <div
        className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ${percent === null && running ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={progressText}
      >
        <div
          className={`h-full rounded-full ${task.status === 'success' ? 'bg-success' : task.status === 'failed' ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${progressWidth}%` }}
        />
      </div>
      <span className="flex-none font-mono text-[10px] text-muted-foreground">{progressText}</span>
    </div>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function isRemotePathNotFound(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('no such file') ||
    /(?:file|directory|path).*(?:does not exist|not found)/.test(message) ||
    message.includes('不存在') ||
    message.includes('找不到')
  );
}

type Props = { active: boolean };
type RemoteFileOperation = 'copy' | 'move' | 'rename' | 'delete' | 'extract' | 'compress';
type InputRemoteFileOperation = Exclude<RemoteFileOperation, 'delete'>;
type TransferOperation = Extract<RemoteFileOperation, 'copy' | 'move'>;
type OperationDialogState = {
  operation: InputRemoteFileOperation;
  paths: string[];
  value: string;
} | null;
type OperationConflictState = {
  taskID: string;
  operation: TransferOperation;
  paths: string[];
  target: string;
  value: string;
  conflicts: string[];
} | null;
type RemoteOperationRunResult =
  | { status: 'completed' }
  | { status: 'started' }
  | { status: 'conflict'; paths: string[] }
  | { status: 'failed' };
type FileSortKey = 'name' | 'size' | 'modifiedAt' | 'createdAt';
type SortDirection = 'asc' | 'desc';
type RemoteSearchMode = 'name' | 'content';
type RemoteSearchScope = 'current' | 'recursive';
type MissingFavoritePath = { sourceID: string; path: string; previousPath: string };
type LoadingKind = 'sources' | 'directory' | 'search';
type CancellableCall = {
  cancel: (cause?: unknown) => PromiseLike<void> | void;
};

export default function SshFilesTool({ active }: Props) {
  const { t, i18n } = useTranslation();
  const { profiles } = useSSHProfiles();
  const [sources, setSources] = useState<ManagedFileSource[]>([]);
  const [sourceID, setSourceID] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [pathEditing, setPathEditing] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<RemoteSearchMode>('name');
  const [searchScope, setSearchScope] = useState<RemoteSearchScope>('current');
  const [searchActive, setSearchActive] = useState(false);
  const [searching, setSearching] = useState(false);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [sortKey, setSortKey] = useState<FileSortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [sizeValues, setSizeValues] = useState<Record<string, number>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [loadingCanceled, setLoadingCanceled] = useState<LoadingKind | null>(null);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState<FileTask[]>([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [savingManage, setSavingManage] = useState(false);
  const [uploadPaths, setUploadPaths] = useState<string[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState('/');
  const [uploadError, setUploadError] = useState('');
  const [uploadStarting, setUploadStarting] = useState(false);
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [operationDialog, setOperationDialog] = useState<OperationDialogState>(null);
  const [operationConflict, setOperationConflict] = useState<OperationConflictState>(null);
  const [deletePaths, setDeletePaths] = useState<string[] | null>(null);
  const [operationError, setOperationError] = useState('');
  const [operationRunning, setOperationRunning] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState('');
  const [createFolderError, setCreateFolderError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [favoritesSaving, setFavoritesSaving] = useState(false);
  const [missingFavoritePath, setMissingFavoritePath] = useState<MissingFavoritePath | null>(null);
  const refreshedUploadTasks = useRef(new Set<string>());
  const refreshedOperationTasks = useRef(new Set<string>());
  const notifiedTaskFailures = useRef(new Set<string>());
  const handledConflictTasks = useRef(new Set<string>());
  const taskRevisionRef = useRef(0);
  const sourcesRequestRef = useRef(0);
  const directoryRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const loadingKindRef = useRef<LoadingKind | null>(null);
  const loadingCallsRef = useRef(new Set<CancellableCall>());
  const pendingFavoritePathRef = useRef<MissingFavoritePath | null>(null);
  const currentPathRef = useRef(currentPath);
  const directoryLoadKeyRef = useRef('');
  const sourcesLoadedRef = useRef(false);

  const cancelLoading = useCallback(() => {
    const kind = loadingKindRef.current;
    if (!kind) return;
    // 目录加载被中断时清空已加载标记，返回该工具时会重新加载。
    if (kind === 'directory') directoryLoadKeyRef.current = '';
    sourcesRequestRef.current++;
    directoryRequestRef.current++;
    searchRequestRef.current++;
    const requests = Array.from(loadingCallsRef.current);
    loadingCallsRef.current.clear();
    loadingKindRef.current = null;
    for (const request of requests) void request.cancel();
    setLoadingSources(false);
    setLoading(false);
    setSearching(false);
    setError('');
    setLoadingCanceled(kind);
  }, []);

  useEffect(() => {
    return () => {
      sourcesRequestRef.current++;
      directoryRequestRef.current++;
      searchRequestRef.current++;
      const requests = Array.from(loadingCallsRef.current);
      loadingCallsRef.current.clear();
      for (const request of requests) void request.cancel();
    };
  }, []);

  const source = sources.find((item) => item.id === sourceID) ?? null;
  const favoritePaths = source?.favoritePaths ?? [];
  const isCurrentPathFavorite = favoritePaths.includes(currentPath);
  const activeSourceProfileID = source?.sshProfileID ?? '';
  const activeSourceProfile = profiles.find((item) => item.id === activeSourceProfileID);
  const sourceUsable = Boolean(source && activeSourceProfile);
  const sourceDefaultPath = source?.defaultPath ?? '';
  const profileListingKey = useMemo(
    () => sshProfileListingKey(activeSourceProfile),
    [activeSourceProfile],
  );
  const directoryLoadKey = sourceID
    ? [
        sourceID,
        activeSourceProfileID,
        profileListingKey,
        currentPath,
        showHidden ? '1' : '0',
      ].join('\0')
    : '';
  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split('/').filter(Boolean);
    return [
      { label: '/', path: '/' },
      ...parts.map((part, index) => ({
        label: part,
        path: `/${parts.slice(0, index + 1).join('/')}`,
      })),
    ];
  }, [currentPath]);

  const applyTaskSnapshot = useCallback((snapshot: FileTaskSnapshot) => {
    if (snapshot.revision < taskRevisionRef.current) return;
    taskRevisionRef.current = snapshot.revision;
    const nextTasks = snapshot.tasks ?? [];
    setTasks(nextTasks);
    setSizeValues((current) => {
      const next = { ...current };
      for (const task of nextTasks) {
        if (task.type === 'size' && task.status === 'success' && task.target)
          next[task.target] = task.completed;
      }
      return next;
    });
  }, []);

  const loadSources = useCallback(async () => {
    const requestID = ++sourcesRequestRef.current;
    loadingKindRef.current = 'sources';
    setLoadingCanceled(null);
    setLoadingSources(true);
    setError('');
    let sourceRequest: ReturnType<typeof GetFileSources> | null = null;
    try {
      sourceRequest = GetFileSources();
      loadingCallsRef.current.add(sourceRequest);
      const nextSources = await sourceRequest;
      if (requestID !== sourcesRequestRef.current) return;
      setSources(nextSources ?? []);
      setSourceID((current) =>
        nextSources?.some((item) => item.id === current) ? current : nextSources?.[0]?.id || '',
      );
      sourcesLoadedRef.current = true;
    } catch (reason) {
      if (requestID !== sourcesRequestRef.current) return;
      throw reason;
    } finally {
      if (sourceRequest) loadingCallsRef.current.delete(sourceRequest);
      if (requestID === sourcesRequestRef.current) {
        setLoadingSources(false);
        if (loadingKindRef.current === 'sources') loadingKindRef.current = null;
      }
    }
  }, []);

  const loadDirectory = useCallback(
    async (id: string, pathValue: string, hidden: boolean) => {
      const requestID = ++directoryRequestRef.current;
      loadingKindRef.current = 'directory';
      setLoadingCanceled(null);
      const requested = pathValue.trim();
      const normalizedPath = requested ? normalizeRemotePath(requested) : '';
      const pendingFavoritePath =
        pendingFavoritePathRef.current?.sourceID === id &&
        pendingFavoritePathRef.current.path === normalizedPath
          ? pendingFavoritePathRef.current
          : null;
      pendingFavoritePathRef.current = null;
      setMissingFavoritePath(null);
      if (!id) {
        if (loadingKindRef.current === 'directory') loadingKindRef.current = null;
        setEntries([]);
        setSelected([]);
        setError('');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      setEntries([]);
      setSelected([]);
      const request = ListRemoteFiles(id, normalizedPath, hidden);
      loadingCallsRef.current.add(request);
      try {
        const result = await request;
        if (requestID !== directoryRequestRef.current) return;
        const resolved = result.path ? normalizeRemotePath(result.path) : normalizedPath;
        setEntries(result.entries ?? []);
        if (resolved) {
          directoryLoadKeyRef.current = [
            id,
            activeSourceProfileID,
            profileListingKey,
            resolved,
            hidden ? '1' : '0',
          ].join('\0');
          setCurrentPath(resolved);
          setPathInput(resolved);
        }
      } catch (reason) {
        if (requestID !== directoryRequestRef.current) return;
        setEntries([]);
        const message = errorMessage(reason);
        setError(message);
        if (pendingFavoritePath && isRemotePathNotFound(reason)) {
          setMissingFavoritePath(pendingFavoritePath);
        }
      } finally {
        loadingCallsRef.current.delete(request);
        if (requestID === directoryRequestRef.current) {
          setLoading(false);
          if (loadingKindRef.current === 'directory') loadingKindRef.current = null;
        }
      }
    },
    [activeSourceProfileID, profileListingKey],
  );

  const resetSearchState = useCallback(() => {
    searchRequestRef.current++;
    setSearchInput('');
    setSearchQuery('');
    setSearchActive(false);
    setSearching(false);
  }, []);

  const executeSearch = async (queryValue = searchInput) => {
    if (!sourceUsable || searching) return;
    const query = queryValue.trim();
    if (!query) {
      resetSearchState();
      if (sourceID) await loadDirectory(sourceID, currentPath, showHidden);
      return;
    }

    const requestID = ++searchRequestRef.current;
    directoryRequestRef.current++;
    loadingKindRef.current = 'search';
    setLoadingCanceled(null);
    setSearchInput(query);
    setSearchQuery(query);
    setSearchActive(true);
    setSearching(true);
    setLoading(true);
    setError('');
    setEntries([]);
    setSelected([]);
    const request = SearchRemoteFiles(
      sourceID,
      currentPath,
      query,
      searchMode,
      searchScope,
      showHidden,
    );
    loadingCallsRef.current.add(request);
    try {
      const result = await request;
      if (requestID !== searchRequestRef.current) return;
      setEntries(result ?? []);
    } catch (reason) {
      if (requestID !== searchRequestRef.current) return;
      setEntries([]);
      setError(errorMessage(reason));
    } finally {
      loadingCallsRef.current.delete(request);
      if (requestID === searchRequestRef.current) {
        setLoading(false);
        setSearching(false);
        if (loadingKindRef.current === 'search') loadingKindRef.current = null;
      }
    }
  };

  const retryCanceledLoading = () => {
    const kind = loadingCanceled;
    setLoadingCanceled(null);
    setError('');
    if (kind === 'sources') {
      void loadSources().catch((reason) => setError(errorMessage(reason)));
    } else if (kind === 'search' && searchQuery) {
      void executeSearch(searchQuery);
    } else if (sourceID) {
      void loadDirectory(sourceID, currentPath, showHidden);
    }
  };

  const clearSearch = () => {
    const shouldReload = searchActive || Boolean(searchQuery);
    resetSearchState();
    if (shouldReload && sourceID) {
      void loadDirectory(sourceID, currentPath, showHidden);
    } else if (shouldReload) {
      setEntries([]);
      setSelected([]);
      setError('');
      setLoading(false);
    }
  };

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const openUploadDialog = useCallback((paths: string[], target: string) => {
    if (!paths.length) return;
    setUploadPaths(paths);
    setUploadTarget(target);
    setUploadError('');
    setAllowOverwrite(false);
    setUploadOpen(true);
  }, []);

  const fileDrop = useFileDrop({
    id: 'ssh-files-drop-zone',
    enabled: active && sourceUsable && !loadingSources && !loading && !searching,
    pick: {
      Title: t('sshFilesTool.chooseUpload'),
      ButtonText: t('sshFilesTool.choose'),
      CanChooseFiles: true,
      CanChooseDirectories: true,
      AllowsMultipleSelection: true,
    },
    onPaths: (paths) => openUploadDialog(paths, currentPathRef.current),
    onError: (reason) => setError(errorMessage(reason)),
  });

  useEffect(() => {
    if (!active) {
      cancelLoading();
      return;
    }
    if (sourcesLoadedRef.current) return;
    resetSearchState();
    void loadSources().catch((reason) => setError(errorMessage(reason)));
  }, [active, cancelLoading, loadSources, resetSearchState]);

  useEffect(() => {
    if (!active) return;
    void GetFileTasks()
      .then(applyTaskSnapshot)
      .catch(() => undefined);
    const offTasks = Events.On('ssh-files:tasks', (event) =>
      applyTaskSnapshot(event.data as FileTaskSnapshot),
    );
    return () => {
      offTasks();
    };
  }, [active, applyTaskSnapshot]);

  useEffect(() => {
    if (!active || !sourceID) return;
    if (manageOpen) return;
    if (!sourceUsable) {
      directoryLoadKeyRef.current = directoryLoadKey;
      resetSearchState();
      setEntries([]);
      setLoading(false);
      setError(t('sshFilesTool.sshProfileMissing'));
      return;
    }
    const nextPath = sourceDefaultPath
      ? currentPath === '/' || !currentPath.trim()
        ? normalizeRemotePath(sourceDefaultPath)
        : normalizeRemotePath(currentPath)
      : currentPath.trim()
        ? normalizeRemotePath(currentPath)
        : '';
    if (nextPath !== currentPath) {
      setCurrentPath(nextPath);
      setPathInput(nextPath);
      return;
    }
    setPathInput(currentPath);
    if (directoryLoadKeyRef.current === directoryLoadKey) return;
    directoryLoadKeyRef.current = directoryLoadKey;
    resetSearchState();
    void loadDirectory(sourceID, currentPath, showHidden);
  }, [
    active,
    currentPath,
    directoryLoadKey,
    loadDirectory,
    manageOpen,
    resetSearchState,
    showHidden,
    sourceDefaultPath,
    sourceID,
    sourceUsable,
    t,
  ]);

  useEffect(() => {
    if (!active || !sourceUsable) return;
    for (const task of tasks) {
      if (
        task.type !== 'upload' ||
        task.status !== 'success' ||
        task.target !== currentPath ||
        refreshedUploadTasks.current.has(task.id)
      ) {
        continue;
      }
      refreshedUploadTasks.current.add(task.id);
      resetSearchState();
      void loadDirectory(sourceID, currentPath, showHidden);
    }
  }, [
    active,
    currentPath,
    loadDirectory,
    resetSearchState,
    showHidden,
    sourceID,
    sourceUsable,
    tasks,
  ]);

  useEffect(() => {
    if (!active) return;
    for (const task of tasks) {
      if (task.status !== 'failed' || notifiedTaskFailures.current.has(task.id)) continue;
      notifiedTaskFailures.current.add(task.id);
      toast.add({
        title: t('sshFilesTool.taskFailedToast', {
          operation: taskTypeLabel(task.type, t),
        }),
        description: task.error || t('sshFilesTool.taskFailed'),
        type: 'error',
      });
    }
  }, [active, t, tasks]);

  useEffect(() => {
    for (const task of tasks) {
      if (task.status !== 'conflict') {
        handledConflictTasks.current.delete(task.id);
      }
    }
    if (!active || !sourceUsable || operationConflict) return;
    const conflictTask = tasks.find(
      (task) =>
        task.sourceID === sourceID &&
        (task.type === 'copy' || task.type === 'move') &&
        task.status === 'conflict' &&
        task.paths?.length &&
        task.conflicts?.length &&
        !handledConflictTasks.current.has(task.id),
    );
    if (!conflictTask) return;
    handledConflictTasks.current.add(conflictTask.id);
    setOperationError('');
    setOperationConflict({
      taskID: conflictTask.id,
      operation: conflictTask.type === 'copy' ? 'copy' : 'move',
      paths: conflictTask.paths ?? [],
      target: conflictTask.target ?? '/',
      value: conflictTask.target ?? '/',
      conflicts: conflictTask.conflicts ?? [],
    });
  }, [active, operationConflict, sourceID, sourceUsable, tasks]);

  useEffect(() => {
    if (!active || !sourceUsable) return;
    for (const task of tasks) {
      if (
        task.sourceID !== sourceID ||
        task.status !== 'success' ||
        !['copy', 'move', 'extract', 'compress'].includes(task.type) ||
        refreshedOperationTasks.current.has(task.id)
      ) {
        continue;
      }
      refreshedOperationTasks.current.add(task.id);
      resetSearchState();
      void loadDirectory(sourceID, currentPath, showHidden);
      toast.add({
        title: t('sshFilesTool.operationSucceeded', {
          operation: t(`sshFilesTool.${task.type}`),
        }),
        type: 'success',
      });
    }
  }, [
    active,
    currentPath,
    loadDirectory,
    resetSearchState,
    showHidden,
    sourceID,
    sourceUsable,
    t,
    tasks,
  ]);

  const navigate = (nextPath: string, navigationSource: 'favorite' | 'normal' = 'normal') => {
    const normalizedPath = normalizeRemotePath(nextPath);
    pendingFavoritePathRef.current =
      navigationSource === 'favorite' && sourceID
        ? { sourceID, path: normalizedPath, previousPath: currentPath }
        : null;
    resetSearchState();
    setPathEditing(false);
    setEntries([]);
    setSelected([]);
    setError('');
    setLoading(true);
    if (normalizedPath === currentPath) {
      void loadDirectory(sourceID, normalizedPath, showHidden);
      return;
    }
    setCurrentPath(normalizedPath);
  };

  const operationPathsFor = (entryPath: string) =>
    selected.includes(entryPath) ? selected : [entryPath];

  const startCheckboxDrag = useCheckboxDragSelect(
    (path) => selected.includes(path),
    (path, checked) =>
      setSelected((current) =>
        checked
          ? current.includes(path)
            ? current
            : [...current, path]
          : current.filter((item) => item !== path),
      ),
  );

  const copyPathToClipboard = async (pathValue: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(pathValue);
      toast.add({ title: t('sshFilesTool.pathCopied'), type: 'success' });
    } catch {
      toast.add({ title: t('sshFilesTool.copyPathFailed'), type: 'error' });
    }
  };

  const toggleFavorite = async (pathValue = currentPath) => {
    if (!sourceUsable || !source || favoritesSaving) return;
    const normalizedPath = normalizeRemotePath(pathValue);
    const isFavorite = favoritePaths.includes(normalizedPath);
    const isCurrentPath = normalizedPath === currentPath;
    const nextFavoritePaths = isFavorite
      ? favoritePaths.filter((favoritePath) => favoritePath !== normalizedPath)
      : [...favoritePaths, normalizedPath];
    const nextSources = sources.map((item) =>
      item.id === sourceID ? { ...item, favoritePaths: nextFavoritePaths } : item,
    );
    setFavoritesSaving(true);
    try {
      await SaveFileSources(nextSources);
      setSources(nextSources);
      toast.add({
        title: t(
          isCurrentPath
            ? isFavorite
              ? 'sshFilesTool.favoriteRemoved'
              : 'sshFilesTool.favoriteAdded'
            : isFavorite
              ? 'sshFilesTool.favoritePathRemoved'
              : 'sshFilesTool.favoritePathAdded',
        ),
        type: 'success',
      });
    } catch (reason) {
      toast.add({
        title: t('sshFilesTool.favoriteSaveFailed'),
        description: errorMessage(reason),
        type: 'error',
      });
    } finally {
      setFavoritesSaving(false);
    }
  };

  const removeMissingFavoritePath = async () => {
    const pending = missingFavoritePath;
    if (!pending || favoritesSaving) return;
    const targetSource = sources.find((item) => item.id === pending.sourceID);
    if (!targetSource) {
      setMissingFavoritePath(null);
      return;
    }
    const currentFavoritePaths = targetSource.favoritePaths ?? [];
    const nextFavoritePaths = currentFavoritePaths.filter(
      (pathValue) => pathValue !== pending.path,
    );
    if (nextFavoritePaths.length === currentFavoritePaths.length) {
      setMissingFavoritePath(null);
      return;
    }
    const nextSources = sources.map((item) =>
      item.id === pending.sourceID ? { ...item, favoritePaths: nextFavoritePaths } : item,
    );
    setFavoritesSaving(true);
    try {
      await SaveFileSources(nextSources);
      setSources(nextSources);
      setMissingFavoritePath(null);
      if (sourceID === pending.sourceID && pending.previousPath !== pending.path) {
        navigate(pending.previousPath);
      }
      toast.add({ title: t('sshFilesTool.favoritePathRemoved'), type: 'success' });
    } catch (reason) {
      toast.add({
        title: t('sshFilesTool.favoritePathRemoveFailed'),
        description: errorMessage(reason),
        type: 'error',
      });
    } finally {
      setFavoritesSaving(false);
    }
  };

  const requestCreateFolder = () => {
    if (!sourceUsable || isLoading) return;
    setCreateFolderName('');
    setCreateFolderError('');
    setCreateFolderOpen(true);
  };

  const executeCreateFolder = async () => {
    if (!sourceUsable || creatingFolder) return;
    const name = createFolderName.trim();
    if (!name) {
      setCreateFolderError(t('sshFilesTool.folderNameRequired'));
      return;
    }
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
      setCreateFolderError(t('sshFilesTool.folderNameInvalid'));
      return;
    }
    setCreatingFolder(true);
    setCreateFolderError('');
    try {
      const target = normalizeRemotePath(`${currentPath}/${name}`);
      await CreateRemoteDirectory(sourceID, target);
      setCreateFolderOpen(false);
      setCreateFolderName('');
      resetSearchState();
      await loadDirectory(sourceID, currentPath, showHidden);
      toast.add({ title: t('sshFilesTool.folderCreated'), type: 'success' });
    } catch (reason) {
      setCreateFolderError(errorMessage(reason));
    } finally {
      setCreatingFolder(false);
    }
  };

  const requestFileOperation = (operation: RemoteFileOperation, paths: string[]) => {
    if (!sourceUsable) return;
    const normalizedPaths = Array.from(new Set(paths.map(normalizeRemotePath)));
    if (!normalizedPaths.length) return;
    if (operation === 'rename' && normalizedPaths.length !== 1) return;
    setSelected(normalizedPaths);
    setOperationError('');
    if (operation === 'delete') {
      setDeletePaths(normalizedPaths);
      return;
    }
    const value =
      operation === 'rename'
        ? basename(normalizedPaths[0])
        : operation === 'compress'
          ? normalizeRemotePath(
              `${currentPath}/${normalizedPaths.length === 1 ? `${basename(normalizedPaths[0])}.tar.gz` : 'archive.tar.gz'}`,
            )
          : operation === 'extract'
            ? normalizedPaths.length === 1
              ? normalizeRemotePath(
                  `${remoteParent(normalizedPaths[0])}/${archiveStem(normalizedPaths[0])}`,
                )
              : currentPath
            : currentPath;
    setOperationDialog({ operation, paths: normalizedPaths, value });
  };

  const runRemoteOperation = async (
    operation: RemoteFileOperation,
    paths: string[],
    target: string,
    conflictPolicy = '',
  ): Promise<RemoteOperationRunResult> => {
    if (!sourceUsable || operationRunning) return { status: 'failed' };
    setOperationRunning(true);
    setOperationError('');
    try {
      if (['copy', 'move', 'extract', 'compress'].includes(operation)) {
        const snapshot = await StartRemoteFileOperation(
          sourceID,
          operation,
          paths,
          target,
          conflictPolicy,
        );
        applyTaskSnapshot(snapshot);
        setSelected([]);
        return { status: 'started' };
      }
      const result = await OperateRemoteFiles(sourceID, operation, paths, target, conflictPolicy);
      if (result?.conflicts?.length) {
        return { status: 'conflict', paths: result.conflicts };
      }
      resetSearchState();
      setSelected([]);
      await loadDirectory(sourceID, currentPath, showHidden);
      toast.add({
        title: t('sshFilesTool.operationSucceeded', {
          operation: t(`sshFilesTool.${operation}`),
        }),
        type: 'success',
      });
      return { status: 'completed' };
    } catch (reason) {
      setOperationError(errorMessage(reason));
      return { status: 'failed' };
    } finally {
      setOperationRunning(false);
    }
  };

  const executeOperationDialog = async () => {
    if (!operationDialog || operationRunning) return;
    const current = operationDialog;
    const value = current.value.trim();
    if (!value) {
      setOperationError(t('sshFilesTool.operationTargetRequired'));
      return;
    }
    let target = normalizeRemotePath(value);
    if (current.operation === 'rename') {
      if (value === '.' || value === '..' || /[\\/]/.test(value)) {
        setOperationError(t('sshFilesTool.renameNameInvalid'));
        return;
      }
      target = normalizeRemotePath(`${remoteParent(current.paths[0])}/${value}`);
    } else if (current.operation === 'compress' && !isArchivePath(target)) {
      setOperationError(t('sshFilesTool.archiveExtensionRequired'));
      return;
    }
    const result = await runRemoteOperation(current.operation, current.paths, target);
    if (result.status === 'completed' || result.status === 'started') {
      setOperationDialog(null);
    }
  };

  const restoreOperationDialog = () => {
    if (!operationConflict) return;
    const current = operationConflict;
    setOperationConflict(null);
    setOperationError('');
    setOperationDialog({
      operation: current.operation,
      paths: current.paths,
      value: current.value,
    });
  };

  const cancelOperationConflict = () => {
    if (!operationConflict) return;
    void CancelFileTask(operationConflict.taskID).catch((reason) => {
      setOperationError(errorMessage(reason));
    });
    restoreOperationDialog();
  };

  const resolveOperationConflict = async (conflictPolicy: 'overwrite' | 'keep-both') => {
    if (!operationConflict || operationRunning) return;
    const current = operationConflict;
    setOperationRunning(true);
    setOperationError('');
    try {
      const snapshot = await ResolveRemoteFileTask(current.taskID, conflictPolicy);
      applyTaskSnapshot(snapshot);
      setSelected([]);
      setOperationConflict(null);
    } catch (reason) {
      setOperationError(errorMessage(reason));
    } finally {
      setOperationRunning(false);
    }
  };

  const executeDelete = async () => {
    if (!deletePaths || operationRunning) return;
    const result = await runRemoteOperation('delete', deletePaths, '');
    if (result.status === 'completed') {
      setDeletePaths(null);
    }
  };

  const confirmUpload = async () => {
    if (!sourceUsable || uploadPaths.length === 0 || uploadStarting || !allowOverwrite) return;
    setUploadStarting(true);
    setUploadError('');
    try {
      const snapshot = await StartFileUpload(sourceID, uploadPaths, uploadTarget);
      applyTaskSnapshot(snapshot);
      setUploadOpen(false);
    } catch (reason) {
      setUploadError(errorMessage(reason));
    } finally {
      setUploadStarting(false);
    }
  };

  const downloadSelected = async (paths: string[]) => {
    if (!sourceUsable) return;
    try {
      const snapshot = await StartFileDownload(sourceID, paths);
      applyTaskSnapshot(snapshot);
      setSelected([]);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const saveManagedSources = async (next: ManagedFileSource[]) => {
    setSavingManage(true);
    try {
      await SaveFileSources(next);
      setSources(next);
      setSourceID((current) =>
        next.some((item) => item.id === current) ? current : (next[0]?.id ?? ''),
      );
    } finally {
      setSavingManage(false);
    }
  };

  const calculateSize = async (entry: RemoteFileEntry) => {
    if (!sourceUsable) return;
    try {
      const snapshot = await CalculateRemoteSize(sourceID, entry.path);
      applyTaskSnapshot(snapshot);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const activeTasks = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running' || task.status === 'scanning',
  );
  const sortedEntries = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...entries].sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;

      if (sortKey === 'name') {
        return (
          left.name.localeCompare(right.name, i18n.language, {
            sensitivity: 'base',
            numeric: true,
          }) * direction
        );
      }

      const leftValue =
        sortKey === 'size'
          ? left.isDir
            ? (sizeValues[left.path] ?? null)
            : left.size
          : timestampMillis(sortKey === 'modifiedAt' ? left.modifiedAt : left.createdAt);
      const rightValue =
        sortKey === 'size'
          ? right.isDir
            ? (sizeValues[right.path] ?? null)
            : right.size
          : timestampMillis(sortKey === 'modifiedAt' ? right.modifiedAt : right.createdAt);

      if (leftValue === null || rightValue === null) {
        if (leftValue === rightValue) return 0;
        return leftValue === null ? 1 : -1;
      }
      return (leftValue - rightValue) * direction;
    });
  }, [entries, i18n.language, sizeValues, sortDirection, sortKey]);
  // 只渲染可视区域的行：远端目录可能很大，全量渲染会拖慢滚动与切换。
  const [fileListViewport, setFileListViewport] = useState<HTMLElement | null>(null);
  const fileRowVirtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => fileListViewport,
    estimateSize: () => 33,
    overscan: 12,
  });
  const fileVirtualRows = fileRowVirtualizer.getVirtualItems();
  const filePaddingTop = fileVirtualRows.length > 0 ? fileVirtualRows[0].start : 0;
  const filePaddingBottom =
    fileVirtualRows.length > 0
      ? fileRowVirtualizer.getTotalSize() - fileVirtualRows[fileVirtualRows.length - 1].end
      : 0;
  const calculatingSizePaths = useMemo(
    () =>
      new Set(
        tasks
          .filter(
            (task) =>
              task.type === 'size' &&
              ['queued', 'running', 'scanning'].includes(task.status) &&
              task.target,
          )
          .map((task) => task.target as string),
      ),
    [tasks],
  );
  const sourceOptions = (
    <SelectGroup>
      {sources.map((item) => (
        <SelectItem key={item.id} value={item.id}>
          {item.name}
        </SelectItem>
      ))}
      {sources.length > 0 ? <SelectSeparator /> : null}
      <SelectItem value={MANAGE_SOURCES_VALUE}>
        <span className="flex items-center gap-2">
          <GearSix size={14} weight="duotone" />
          {t('sshFilesTool.manage')}
        </span>
      </SelectItem>
    </SelectGroup>
  );
  const isLoading = loadingSources || loading || searching;
  const searchModeLabel = t(
    searchMode === 'name' ? 'sshFilesTool.searchByName' : 'sshFilesTool.searchByContent',
  );
  const searchScopeLabel = t(
    searchScope === 'current'
      ? 'sshFilesTool.searchCurrentDirectory'
      : 'sshFilesTool.searchFromCurrentDirectory',
  );
  const changeSort = (nextKey: FileSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(nextKey);
      setSortDirection('asc');
    }
  };
  const sortLabel = (key: FileSortKey) => {
    if (key === 'name') return t('sshFilesTool.name');
    if (key === 'size') return t('sshFilesTool.size');
    if (key === 'modifiedAt') return t('sshFilesTool.modified');
    return t('sshFilesTool.created');
  };
  const sortableHeader = (key: FileSortKey, label: string) => {
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
        className="-ml-2 h-7 px-2 text-[10px] font-medium"
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

  return (
    <ToolLayout>
      <ToolLayoutHeader title={t('sshFilesTool.title')} subtitle={t('sshFilesTool.subtitle')} />
      <ToolLayoutToolbar
        left={
          <div className="flex min-w-0 flex-wrap items-end gap-3 max-[700px]:w-full">
            <div className="flex min-w-[220px] flex-col gap-1 text-[10px] font-medium text-muted-foreground max-[700px]:w-full">
              <span id="ssh-file-source-label">{t('sshFilesTool.source')}</span>
              <Select
                items={sources.map((item) => ({ value: item.id, label: item.name }))}
                value={sourceID || null}
                disabled={isLoading}
                onValueChange={(value) => {
                  if (value === MANAGE_SOURCES_VALUE) {
                    setManageOpen(true);
                    return;
                  }
                  if (value !== null) {
                    resetSearchState();
                    setEntries([]);
                    setSelected([]);
                    setError('');
                    setLoading(true);
                    setPathEditing(false);
                    setSourceID(value);
                    setCurrentPath('');
                  }
                }}
              >
                <SelectTrigger
                  className="h-[30px] w-[220px] max-w-full text-[11px] max-[700px]:w-full"
                  aria-labelledby="ssh-file-source-label"
                >
                  <SelectValue placeholder={t('sshFilesTool.noSource')} />
                </SelectTrigger>
                <SelectContent>{sourceOptions}</SelectContent>
              </Select>
              {source && !sourceUsable ? (
                <Badge variant="destructive" className="h-5 text-[10px]">
                  {t('sshFilesTool.sshProfileMissing')}
                </Badge>
              ) : null}
            </div>
            <label className="flex items-center gap-2 pb-1.5 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={showHidden}
                disabled={isLoading}
                onCheckedChange={(checked) => {
                  if (searchActive) resetSearchState();
                  setShowHidden(checked);
                }}
              />
              {t('sshFilesTool.showHidden')}
            </label>
          </div>
        }
        right={
          <div className="flex min-w-0 flex-wrap items-center gap-2 max-[700px]:w-full max-[700px]:justify-end">
            <form
              className="relative w-[min(28vw,260px)] min-w-[180px] max-[700px]:order-last max-[700px]:w-full"
              onSubmit={(event) => {
                event.preventDefault();
                void executeSearch();
              }}
            >
              <MagnifyingGlass
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    clearSearch();
                    return;
                  }
                  if (event.key === 'Enter' && event.nativeEvent.isComposing) {
                    event.preventDefault();
                  }
                }}
                disabled={!sourceUsable || isLoading}
                placeholder={t('sshFilesTool.searchPlaceholder')}
                aria-label={t('sshFilesTool.search')}
                className="h-[30px] w-full bg-muted/20 pl-8 pr-8 text-[11px]"
              />
              {searchInput ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-0.5 h-7 w-7 -translate-y-1/2"
                  disabled={!sourceUsable || isLoading}
                  aria-label={t('sshFilesTool.clearSearch')}
                  onClick={clearSearch}
                >
                  <XCircle size={14} />
                </Button>
              ) : null}
            </form>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-[30px] max-w-[190px] flex-none px-2 text-[10px]"
                    disabled={!sourceUsable || isLoading}
                    aria-label={t('sshFilesTool.searchOptions')}
                  />
                }
              >
                <span className="truncate">
                  {t('sshFilesTool.searchOptionsSummary', {
                    mode: searchModeLabel,
                    scope: searchScopeLabel,
                  })}
                </span>
                <CaretDown data-icon="inline-end" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('sshFilesTool.searchMode')}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setSearchMode('name')}>
                    <CheckCircle
                      size={14}
                      className={searchMode === 'name' ? 'text-primary' : 'invisible'}
                      aria-hidden="true"
                    />
                    {t('sshFilesTool.searchByName')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSearchMode('content')}>
                    <CheckCircle
                      size={14}
                      className={searchMode === 'content' ? 'text-primary' : 'invisible'}
                      aria-hidden="true"
                    />
                    {t('sshFilesTool.searchByContent')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('sshFilesTool.searchScope')}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setSearchScope('current')}>
                    <CheckCircle
                      size={14}
                      className={searchScope === 'current' ? 'text-primary' : 'invisible'}
                      aria-hidden="true"
                    />
                    {t('sshFilesTool.searchCurrentDirectory')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSearchScope('recursive')}>
                    <CheckCircle
                      size={14}
                      className={searchScope === 'recursive' ? 'text-primary' : 'invisible'}
                      aria-hidden="true"
                    />
                    {t('sshFilesTool.searchFromCurrentDirectory')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="default"
              className="h-[30px] flex-none px-[11px] text-[11px]"
              disabled={!sourceUsable || isLoading}
              onClick={() => void fileDrop.pick()}
            >
              <UploadSimple data-icon="inline-start" size={14} />
              {t('sshFilesTool.upload')}
            </Button>
          </div>
        }
      />
      <ToolLayoutContent className="flex min-h-0 flex-col">
        <div
          className="flex min-h-10 min-w-0 items-center gap-1 border-y border-border bg-muted/20 px-2 text-xs"
          aria-label={t('sshFilesTool.path')}
        >
          {searchActive ? (
            <Badge variant="secondary" className="h-6 flex-none px-2 text-[10px]">
              {t('sshFilesTool.searchResults')}
            </Badge>
          ) : null}
          {pathEditing ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                navigate(pathInput);
              }}
            >
              <Input
                autoFocus
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  setPathInput(currentPath);
                  setPathEditing(false);
                }}
                disabled={!sourceUsable || isLoading}
                aria-label={t('sshFilesTool.pathInput')}
                className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
              />
              <Button
                type="submit"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 flex-none"
                disabled={!sourceUsable || isLoading}
                aria-label={t('sshFilesTool.navigatePath')}
              >
                <CheckCircle size={14} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 flex-none"
                disabled={isLoading}
                aria-label={t('common.cancel')}
                onClick={() => {
                  setPathInput(currentPath);
                  setPathEditing(false);
                }}
              >
                <XCircle size={14} />
              </Button>
            </form>
          ) : (
            <>
              <ScrollArea className="min-w-0 flex-1 py-1" options={{ overflow: { x: 'scroll', y: 'hidden' } }}>
                <div className="flex items-center gap-0.5">
                {breadcrumbs.map((crumb, index) => (
                  <span key={crumb.path} className="flex items-center whitespace-nowrap">
                    <button
                      type="button"
                      className={`rounded px-1.5 py-1 hover:bg-accent hover:text-foreground ${index === breadcrumbs.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                      disabled={!sourceUsable || isLoading}
                      aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
                      onClick={() => navigate(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                    {index < breadcrumbs.length - 1 ? (
                      <CaretRight size={12} className="mx-0.5 shrink-0 text-muted-foreground/50" />
                    ) : null}
                  </span>
                ))}
                </div>
              </ScrollArea>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 flex-none"
                disabled={!sourceUsable || isLoading}
                aria-label={t('sshFilesTool.editPath')}
                onClick={() => {
                  setPathInput(currentPath);
                  setPathEditing(true);
                }}
              >
                <PencilSimple size={14} />
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant={isCurrentPathFavorite ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 flex-none px-2 text-[11px]"
                  disabled={!sourceUsable || isLoading || favoritesSaving}
                  aria-label={t('sshFilesTool.favorites')}
                />
              }
            >
              {favoritesSaving ? (
                <Spinner className="size-3" />
              ) : (
                <Star
                  size={14}
                  weight={isCurrentPathFavorite ? 'fill' : 'duotone'}
                  aria-hidden="true"
                />
              )}
              <span>{t('sshFilesTool.favorites')}</span>
              <CaretDown data-icon="inline-end" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-32px)]">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('sshFilesTool.favorites')}</DropdownMenuLabel>
                {favoritePaths.length ? (
                  favoritePaths.map((favoritePath) => (
                    <DropdownMenuItem
                      key={favoritePath}
                      onClick={() => navigate(favoritePath, 'favorite')}
                    >
                      <Star size={14} weight="duotone" aria-hidden="true" />
                      <span className="min-w-0 truncate" title={favoritePath}>
                        {favoritePath}
                      </span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>{t('sshFilesTool.noFavorites')}</DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!sourceUsable || isLoading || favoritesSaving}
                onClick={() => void toggleFavorite()}
              >
                <Star
                  size={14}
                  weight={isCurrentPathFavorite ? 'fill' : 'duotone'}
                  aria-hidden="true"
                />
                {t(
                  isCurrentPathFavorite
                    ? 'sshFilesTool.removeFavorite'
                    : 'sshFilesTool.addFavorite',
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 flex-none"
            disabled={!sourceUsable || isLoading}
            onClick={() =>
              searchActive && searchQuery
                ? void executeSearch(searchQuery)
                : void loadDirectory(sourceID, currentPath, showHidden)
            }
            aria-label={t('sshFilesTool.refresh')}
          >
            <ArrowClockwise size={14} />
          </Button>
        </div>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                data-over={fileDrop.over ? 'true' : undefined}
                aria-busy={isLoading}
                {...fileDrop.dropProps}
                className="group/file-drop relative min-h-0 flex-1"
              />
            }
          >
            <ScrollArea
              className="h-full [padding-inline-end:var(--overlay-scrollbar-size)]"
              onViewport={setFileListViewport}
            >
            {fileDrop.over ? (
              <span className="sr-only" role="status">
                {t('fileDrop.release')}
              </span>
            ) : null}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border border-dashed border-primary bg-primary/10 px-4 py-3 text-primary opacity-0 group-data-[over=true]/file-drop:opacity-100 group-[.file-drop-target-active]/file-drop:opacity-100"
            >
              <span className="flex items-center gap-2 text-xs font-medium">
                <UploadSimple size={16} weight="duotone" />
                {t('fileDrop.release')}
              </span>
            </div>
            {loadingSources ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Spinner />
                <span className="text-sm text-muted-foreground">
                  {t('sshFilesTool.loadingSources')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 px-2 text-xs"
                  onClick={cancelLoading}
                >
                  <XCircle data-icon="inline-start" size={14} />
                  {t('common.cancel')}
                </Button>
              </div>
            ) : loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Spinner />
                <span className="text-sm text-muted-foreground">
                  {searching ? t('sshFilesTool.searching') : t('sshFilesTool.loadingDirectory')}
                </span>
                <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground/70">
                  {currentPath}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 px-2 text-xs"
                  onClick={cancelLoading}
                >
                  <XCircle data-icon="inline-start" size={14} />
                  {t('common.cancel')}
                </Button>
              </div>
            ) : loadingCanceled ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <XCircle size={16} weight="duotone" className="text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {t('sshFilesTool.loadingCanceled')}
                </span>
                <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground/70">
                  {t('sshFilesTool.loadingCanceledHint')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 px-2 text-xs"
                  onClick={retryCanceledLoading}
                >
                  <ArrowClockwise data-icon="inline-start" size={14} />
                  {t('sshFilesTool.refresh')}
                </Button>
              </div>
            ) : !sourceID ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <HardDrives size={30} weight="duotone" className="text-muted-foreground" />
                <div className="text-sm font-medium text-foreground">{t('sshFilesTool.empty')}</div>
                <div className="max-w-sm text-xs text-muted-foreground">
                  {t('sshFilesTool.emptyHint')}
                </div>
                <Button
                  variant="outline"
                  className="mt-1 h-8 text-xs"
                  onClick={() => setManageOpen(true)}
                >
                  {t('sshFilesTool.addSource')}
                </Button>
              </div>
            ) : !sourceUsable ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Warning size={30} weight="duotone" className="text-destructive" />
                <div className="text-sm font-medium text-foreground">
                  {t('sshFilesTool.sshProfileMissing')}
                </div>
                <div className="max-w-sm text-xs text-muted-foreground">
                  {t('sshFilesTool.sshProfileMissingHint')}
                </div>
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <XCircle size={30} weight="duotone" className="text-destructive" />
                <div className="text-sm font-medium text-foreground">
                  {t(searchActive ? 'sshFilesTool.searchFailed' : 'sshFilesTool.loadFailed')}
                </div>
                <div className="max-w-lg break-words text-xs text-muted-foreground">{error}</div>
                <Button
                  variant="outline"
                  className="mt-1 h-8 text-xs"
                  onClick={() =>
                    searchActive && searchQuery
                      ? void executeSearch(searchQuery)
                      : void loadDirectory(sourceID, currentPath, showHidden)
                  }
                >
                  <ArrowClockwise data-icon="inline-start" size={14} />
                  {t('sshFilesTool.refresh')}
                </Button>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                {searchActive ? (
                  <MagnifyingGlass size={30} weight="duotone" className="text-muted-foreground" />
                ) : (
                  <Folder size={30} weight="duotone" className="text-muted-foreground" />
                )}
                <div className="text-sm font-medium text-foreground">
                  {t(searchActive ? 'sshFilesTool.searchNoResults' : 'sshFilesTool.directoryEmpty')}
                </div>
                <div className="max-w-sm text-xs text-muted-foreground">
                  {t(
                    searchActive
                      ? 'sshFilesTool.searchNoResultsHint'
                      : 'sshFilesTool.directoryEmptyHint',
                  )}
                </div>
              </div>
            ) : (
              <Table className="min-w-[840px] text-xs" containerClassName="overflow-visible">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 px-3 text-[10px] text-muted-foreground">
                      <Checkbox
                        checked={entries.length > 0 && selected.length === entries.length}
                        indeterminate={selected.length > 0 && selected.length < entries.length}
                        onCheckedChange={(checked) =>
                          setSelected(checked === true ? entries.map((item) => item.path) : [])
                        }
                        aria-label={t(
                          searchActive
                            ? 'sshFilesTool.selectAllSearchResults'
                            : 'sshFilesTool.selectAll',
                        )}
                      />
                    </TableHead>
                    <TableHead
                      className="min-w-[280px] text-[10px] text-muted-foreground"
                      aria-sort={
                        sortKey === 'name'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('name', t('sshFilesTool.name'))}
                    </TableHead>
                    <TableHead
                      className="w-32 text-[10px] text-muted-foreground"
                      aria-sort={
                        sortKey === 'size'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('size', t('sshFilesTool.size'))}
                    </TableHead>
                    <TableHead
                      className="w-44 text-[10px] text-muted-foreground"
                      aria-sort={
                        sortKey === 'modifiedAt'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('modifiedAt', t('sshFilesTool.modified'))}
                    </TableHead>
                    <TableHead
                      className="w-44 text-[10px] text-muted-foreground"
                      aria-sort={
                        sortKey === 'createdAt'
                          ? sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {sortableHeader('createdAt', t('sshFilesTool.created'))}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filePaddingTop > 0 ? (
                    <tr>
                      <td colSpan={5} style={{ height: filePaddingTop, padding: 0 }} />
                    </tr>
                  ) : null}
                  {fileVirtualRows.map((virtualRow) => {
                    const entry = sortedEntries[virtualRow.index];
                    const operationPaths = operationPathsFor(entry.path);
                    const archiveSelection = operationPaths.every(isArchivePath);
                    const parentPath = searchActive ? remoteParent(entry.path) : '';
                    const isEntryFavorite = entry.isDir && favoritePaths.includes(entry.path);
                    const EntryIcon = entry.isDir
                      ? isEntryFavorite
                        ? FolderStar
                        : Folder
                      : remoteFileIcon(entry.path);
                    return (
                      <ContextMenu key={entry.path}>
                        <ContextMenuTrigger
                          render={
                            <TableRow
                              ref={fileRowVirtualizer.measureElement}
                              data-index={virtualRow.index}
                              data-row-key={entry.path}
                              data-state={selected.includes(entry.path) ? 'selected' : undefined}
                              className="group select-none border-border/60"
                            />
                          }
                        >
                          <TableCell
                            className="w-10 cursor-default px-3 py-2"
                            onPointerDown={(event) => startCheckboxDrag(event, entry.path)}
                          >
                            <Checkbox
                              className="cursor-default"
                              checked={selected.includes(entry.path)}
                              onCheckedChange={(checked) =>
                                setSelected((current) =>
                                  checked
                                    ? [...current, entry.path]
                                    : current.filter((item) => item !== entry.path),
                                )
                              }
                              aria-label={entry.name}
                            />
                          </TableCell>
                          <TableCell className="min-w-[280px] max-w-0 py-2">
                            <div className="min-w-0 max-w-full">
                              <button
                                type="button"
                                className="flex w-full min-w-0 max-w-full items-center gap-2 text-left text-foreground hover:underline"
                                title={entry.path}
                                onClick={() =>
                                  entry.isDir
                                    ? navigate(entry.path)
                                    : void downloadSelected([entry.path])
                                }
                              >
                                <EntryIcon
                                  size={16}
                                  weight="duotone"
                                  className="shrink-0 text-muted-foreground"
                                />
                                <span className="min-w-0 truncate">{entry.name}</span>
                                {entry.isSymlink ? (
                                  <ArrowUpRight
                                    size={11}
                                    aria-label={t('sshFilesTool.symbolicLink')}
                                    className="shrink-0 text-muted-foreground"
                                  />
                                ) : null}
                              </button>
                              {parentPath ? (
                                <button
                                  type="button"
                                  className="block w-full min-w-0 max-w-full truncate text-left text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                                  title={parentPath}
                                  onClick={() => navigate(parentPath)}
                                >
                                  {parentPath}
                                </button>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="w-32 py-2 text-muted-foreground">
                            {entry.isDir ? (
                              calculatingSizePaths.has(entry.path) ? (
                                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                  <Spinner className="size-3" />
                                  {t('sshFilesTool.scanning')}
                                </span>
                              ) : sizeValues[entry.path] !== undefined ? (
                                formatBytes(sizeValues[entry.path])
                              ) : (
                                <button
                                  type="button"
                                  className="text-primary underline underline-offset-2"
                                  disabled={calculatingSizePaths.has(entry.path)}
                                  onClick={() => void calculateSize(entry)}
                                >
                                  {t('sshFilesTool.calculate')}
                                </button>
                              )
                            ) : (
                              formatBytes(entry.size)
                            )}
                          </TableCell>
                          <TableCell className="w-44 py-2 text-muted-foreground">
                            {formatRemoteTimestamp(entry.modifiedAt, i18n.language)}
                          </TableCell>
                          <TableCell className="w-44 py-2 text-muted-foreground">
                            {formatRemoteTimestamp(entry.createdAt, i18n.language)}
                          </TableCell>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="min-w-44">
                          <ContextMenuGroup>
                            <ContextMenuItem
                              disabled={operationRunning}
                              onClick={() => void copyPathToClipboard(entry.path)}
                            >
                              <Copy size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.copyPath')}
                            </ContextMenuItem>
                            {entry.isDir ? (
                              <ContextMenuItem
                                disabled={favoritesSaving}
                                onClick={() => void toggleFavorite(entry.path)}
                              >
                                <Star
                                  size={14}
                                  weight={isEntryFavorite ? 'fill' : 'duotone'}
                                  aria-hidden="true"
                                />
                                {t(
                                  isEntryFavorite
                                    ? 'sshFilesTool.removeFavoritePath'
                                    : 'sshFilesTool.addFavoritePath',
                                )}
                              </ContextMenuItem>
                            ) : null}
                          </ContextMenuGroup>
                          <ContextMenuSeparator />
                          <ContextMenuGroup>
                            <ContextMenuItem
                              disabled={operationRunning}
                              onClick={() => requestFileOperation('copy', operationPaths)}
                            >
                              <Copy size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.copy')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={operationRunning}
                              onClick={() => requestFileOperation('move', operationPaths)}
                            >
                              <ArrowsLeftRight size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.move')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={operationRunning || operationPaths.length !== 1}
                              onClick={() => requestFileOperation('rename', operationPaths)}
                            >
                              <PencilSimple size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.rename')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              variant="destructive"
                              disabled={operationRunning}
                              onClick={() => requestFileOperation('delete', operationPaths)}
                            >
                              <Trash size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.delete')}
                            </ContextMenuItem>
                          </ContextMenuGroup>
                          <ContextMenuSeparator />
                          <ContextMenuGroup>
                            <ContextMenuItem
                              disabled={operationRunning || !archiveSelection}
                              onClick={() => requestFileOperation('extract', operationPaths)}
                            >
                              <FileArchive size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.extract')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={operationRunning}
                              onClick={() => requestFileOperation('compress', operationPaths)}
                            >
                              <Archive size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.compress')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={operationRunning}
                              onClick={() => void downloadSelected(operationPaths)}
                            >
                              <DownloadSimple size={14} weight="duotone" aria-hidden="true" />
                              {t('sshFilesTool.download')}
                            </ContextMenuItem>
                          </ContextMenuGroup>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                  {filePaddingBottom > 0 ? (
                    <tr>
                      <td colSpan={5} style={{ height: filePaddingBottom, padding: 0 }} />
                    </tr>
                  ) : null}
                </TableBody>
              </Table>
            )}
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-44">
            <ContextMenuGroup>
              <ContextMenuItem
                disabled={!sourceUsable || isLoading}
                onClick={() => void copyPathToClipboard(currentPath)}
              >
                <Copy size={14} weight="duotone" aria-hidden="true" />
                {t('sshFilesTool.copyPath')}
              </ContextMenuItem>
              <ContextMenuItem disabled={!sourceUsable || isLoading} onClick={requestCreateFolder}>
                <FolderSimplePlus size={14} weight="duotone" aria-hidden="true" />
                {t('sshFilesTool.createFolder')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!sourceUsable || isLoading || favoritesSaving}
                onClick={() => void toggleFavorite()}
              >
                <Star
                  size={14}
                  weight={isCurrentPathFavorite ? 'fill' : 'duotone'}
                  aria-hidden="true"
                />
                {t(
                  isCurrentPathFavorite
                    ? 'sshFilesTool.removeFavoritePath'
                    : 'sshFilesTool.addFavoritePath',
                )}
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      </ToolLayoutContent>
      <ToolLayoutFooter>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              {searchActive
                ? t('sshFilesTool.searchResultCount', { count: entries.length })
                : entries.length
                  ? t('sshFilesTool.itemCount', { count: entries.length })
                  : ''}
            </span>
            {activeTasks.length > 0 || tasks.length > 0 ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 text-left text-muted-foreground hover:text-foreground"
                onClick={() => setTasksOpen(true)}
                aria-label={t('sshFilesTool.tasksTitle')}
              >
                {activeTasks.length > 0 ? (
                  <>
                    {activeTasks.length === 1 ? (
                      <TaskProgressMeter key={activeTasks[0].id} task={activeTasks[0]} compact />
                    ) : (
                      <span
                        className="relative h-1.5 w-20 animate-pulse overflow-hidden rounded-full bg-muted motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    )}
                    <span>{t('sshFilesTool.activeTasks', { count: activeTasks.length })}</span>
                  </>
                ) : (
                  <ListDashes size={14} weight="duotone" aria-hidden="true" />
                )}
              </button>
            ) : null}
          </div>
          <div className="flex min-h-[30px] flex-none flex-wrap items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className={`h-[30px] flex-none px-[11px] text-[11px]${selected.length ? '' : ' invisible pointer-events-none'}`}
                    disabled={operationRunning || selected.length === 0}
                    aria-hidden={selected.length === 0}
                    tabIndex={selected.length > 0 ? 0 : -1}
                  />
                }
              >
                <ListDashes data-icon="inline-start" size={14} />
                {t('sshFilesTool.batchActions')}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={operationRunning}
                    onClick={() => requestFileOperation('copy', selected)}
                  >
                    <Copy size={14} weight="duotone" aria-hidden="true" />
                    {t('sshFilesTool.copy')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={operationRunning}
                    onClick={() => requestFileOperation('move', selected)}
                  >
                    <ArrowsLeftRight size={14} weight="duotone" aria-hidden="true" />
                    {t('sshFilesTool.move')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={operationRunning || !selected.every(isArchivePath)}
                    onClick={() => requestFileOperation('extract', selected)}
                  >
                    <FileArchive size={14} weight="duotone" aria-hidden="true" />
                    {t('sshFilesTool.extract')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={operationRunning}
                    onClick={() => requestFileOperation('compress', selected)}
                  >
                    <Archive size={14} weight="duotone" aria-hidden="true" />
                    {t('sshFilesTool.compress')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={operationRunning}
                    onClick={() => void downloadSelected(selected)}
                  >
                    <DownloadSimple size={14} weight="duotone" aria-hidden="true" />
                    {t('sshFilesTool.download')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={operationRunning}
                    onClick={() => requestFileOperation('delete', selected)}
                  >
                    <Trash size={14} weight="duotone" aria-hidden="true" />
                    {t('sshFilesTool.delete')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ToolLayoutFooter>

      <TargetHostManagerDialog<ManagedFileSource, ManagedFileSource>
        open={manageOpen}
        onOpenChange={setManageOpen}
        items={sources}
        itemKey={(item) => item.id}
        itemName={(item) =>
          item.name.trim() ||
          profiles.find((profile) => profile.id === item.sshProfileID)?.name ||
          t('sshFilesTool.sourceName')
        }
        createDraft={() => emptyFileSource(profiles[0]?.id ?? '')}
        toDraft={(item) => ({ ...item })}
        commitDraft={(draft, previous) => {
          const profile = profiles.find((item) => item.id === draft.sshProfileID);
          if (!draft.sshProfileID || !profile) return t('sshFilesTool.sourceNeedsSSHProfile');
          const next = {
            ...draft,
            id: draft.id || crypto.randomUUID(),
            name: draft.name.trim() || profile.name,
          };
          return previous.some((item) => item.id === next.id)
            ? previous.map((item) => (item.id === next.id ? next : item))
            : [...previous, next];
        }}
        saveItems={saveManagedSources}
        saving={savingManage}
        renderMeta={(item) => {
          const linkedProfile = profiles.find((candidate) => candidate.id === item.sshProfileID);
          return (
            <>
              <span className="truncate">
                {linkedProfile?.name || t('sshFilesTool.sshProfileMissing')}
              </span>
              {!linkedProfile ? (
                <Badge variant="destructive" className="h-4 shrink-0 text-[9px]">
                  {t('sshFilesTool.sshProfileMissing')}
                </Badge>
              ) : null}
              <span aria-hidden="true">·</span>
              <span className="truncate font-mono">
                {item.defaultPath.trim()
                  ? normalizeRemotePath(item.defaultPath)
                  : t('sshFilesTool.remoteHome')}
              </span>
            </>
          );
        }}
        renderForm={({ draft, setDraft }) => {
          const linkedProfile = profiles.find((item) => item.id === draft.sshProfileID);
          return (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-source-name" className="text-xs text-muted-foreground">
                  {t('sshFilesTool.sourceName')}
                </Label>
                <Input
                  id="ssh-source-name"
                  value={draft.name}
                  placeholder={linkedProfile?.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-source-profile" className="text-xs text-muted-foreground">
                  {t('sshFilesTool.selectSSHProfile')}
                </Label>
                <SSHProfileSelect
                  id="ssh-source-profile"
                  value={draft.sshProfileID}
                  onValueChange={(sshProfileID) => setDraft({ ...draft, sshProfileID })}
                  placeholder={t('sshFilesTool.selectSSHProfile')}
                />
                <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                  {linkedProfile
                    ? `${linkedProfile.username ? `${linkedProfile.username}@` : ''}${linkedProfile.host}:${linkedProfile.port || 22}`
                    : t('sshFilesTool.sshProfileMissing')}
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-source-default-path" className="text-xs text-muted-foreground">
                  {t('sshFilesTool.defaultPath')}
                </Label>
                <Input
                  id="ssh-source-default-path"
                  value={draft.defaultPath}
                  placeholder={t('sshFilesTool.remoteHome')}
                  onChange={(event) => setDraft({ ...draft, defaultPath: event.target.value })}
                  className="font-mono text-xs"
                />
                <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                  {t('sshFilesTool.sourceHint')}
                </p>
              </div>
            </>
          );
        }}
        strings={{
          title: t('sshFilesTool.manageTitle'),
          description: t('sshFilesTool.manageDesc'),
          listTitle: t('sshFilesTool.source'),
          add: t('sshFilesTool.addSource'),
          edit: t('sshFilesTool.editSource'),
          remove: t('sshFilesTool.removeSourceAction'),
          empty: t('sshFilesTool.empty'),
          emptyHint: t('sshFilesTool.emptyHint'),
          save: t('common.save'),
          done: t('common.done'),
          back: t('sshFilesTool.backToList'),
          discardTitle: t('sshFilesTool.discardManageTitle'),
          discardDescription: t('sshFilesTool.discardManageConfirm'),
          discardConfirm: t('sshFilesTool.discardManageAction'),
          removeTitle: t('sshFilesTool.removeSourceTitle'),
          removeDescription: (name) => t('sshFilesTool.removeSourceConfirm', { name }),
          formTitle: (editing) =>
            editing ? t('sshFilesTool.editSourceTitle') : t('sshFilesTool.newSourceTitle'),
        }}
      />
      <ConfirmDialog
        open={missingFavoritePath !== null}
        onOpenChange={(open) => {
          if (!open) setMissingFavoritePath(null);
        }}
        title={t('sshFilesTool.favoritePathMissingTitle')}
        description={t('sshFilesTool.favoritePathMissingDescription', {
          path: missingFavoritePath?.path ?? '',
        })}
        confirmLabel={t('sshFilesTool.removeFavoritePath')}
        destructive
        busy={favoritesSaving}
        onConfirm={() => void removeMissingFavoritePath()}
      />
      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          if (!uploadStarting) {
            setUploadOpen(open);
            if (!open) {
              setUploadError('');
              setAllowOverwrite(false);
            }
          }
        }}
      >
        <DialogContent className="flex w-[min(520px,calc(100vw-32px))] max-w-none flex-col gap-5 sm:max-w-none">
          <DialogHeader>
            <DialogTitle className="text-base">{t('sshFilesTool.uploadTitle')}</DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {t('sshFilesTool.uploadDesc', { count: uploadPaths.length })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            id="ssh-upload-form"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmUpload();
            }}
          >
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <Warning size={16} weight="duotone" className="mt-0.5 shrink-0" />
              <div className="grid min-w-0 gap-2">
                <p className="m-0 leading-5">{t('sshFilesTool.uploadOverwriteWarning')}</p>
                <label className="flex min-w-0 items-center gap-2 text-foreground">
                  <Checkbox
                    id="ssh-upload-allow-overwrite"
                    checked={allowOverwrite}
                    disabled={uploadStarting}
                    onCheckedChange={(checked) => setAllowOverwrite(checked === true)}
                  />
                  <span className="min-w-0 leading-5">
                    {t('sshFilesTool.uploadOverwriteConfirm')}
                  </span>
                </label>
              </div>
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('sshFilesTool.uploadItems')}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {uploadPaths.length}
                </span>
              </div>
              <ScrollArea
                id="ssh-upload-items"
                className="max-h-32 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs"
              >
                {uploadPaths.map((item) => (
                  <div key={item} className="flex min-w-0 items-center gap-2 py-1">
                    <File size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate" title={item}>
                      {basename(item)}
                    </span>
                  </div>
                ))}
              </ScrollArea>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-upload-target" className="text-xs text-muted-foreground">
                {t('sshFilesTool.targetPath')}
              </Label>
              <Input
                id="ssh-upload-target"
                value={uploadTarget}
                onChange={(event) => setUploadTarget(event.target.value)}
                className="font-mono text-xs"
                disabled={uploadStarting}
              />
              <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                {t('sshFilesTool.uploadTargetHint')}
              </p>
            </div>
            {uploadError ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">
                  {t('sshFilesTool.uploadFailed')}: {uploadError}
                </span>
              </div>
            ) : null}
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={uploadStarting}
              onClick={() => setUploadOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="ssh-upload-form"
              disabled={
                uploadStarting || !sourceUsable || uploadPaths.length === 0 || !allowOverwrite
              }
            >
              {uploadStarting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <UploadSimple data-icon="inline-start" size={14} />
              )}
              {t('sshFilesTool.startUpload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createFolderOpen}
        onOpenChange={(open) => {
          if (!open && !creatingFolder) {
            setCreateFolderOpen(false);
            setCreateFolderError('');
          }
        }}
      >
        <DialogContent className="flex w-[min(420px,calc(100vw-32px))] max-w-none flex-col gap-5 sm:max-w-none">
          <DialogHeader>
            <DialogTitle className="text-base">{t('sshFilesTool.createFolderTitle')}</DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {t('sshFilesTool.createFolderDesc', { path: currentPath })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-1.5"
            id="ssh-create-folder-form"
            onSubmit={(event) => {
              event.preventDefault();
              void executeCreateFolder();
            }}
          >
            <Label htmlFor="ssh-create-folder-name" className="text-xs text-muted-foreground">
              {t('sshFilesTool.folderName')}
            </Label>
            <Input
              id="ssh-create-folder-name"
              value={createFolderName}
              onChange={(event) => setCreateFolderName(event.target.value)}
              className="font-mono text-xs"
              disabled={creatingFolder}
              autoFocus
            />
            <p className="m-0 text-[10px] leading-4 text-muted-foreground">
              {t('sshFilesTool.folderNameHint')}
            </p>
            {createFolderError ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">
                  {t('sshFilesTool.folderCreateFailed')}: {createFolderError}
                </span>
              </div>
            ) : null}
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={creatingFolder}
              onClick={() => setCreateFolderOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="ssh-create-folder-form"
              disabled={creatingFolder || !sourceUsable}
            >
              {creatingFolder ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FolderSimplePlus data-icon="inline-start" size={14} />
              )}
              {t('sshFilesTool.createFolderAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={operationDialog !== null}
        onOpenChange={(open) => {
          if (!open && !operationRunning) {
            setOperationDialog(null);
            setOperationError('');
          }
        }}
      >
        <DialogContent className="flex w-[min(520px,calc(100vw-32px))] max-w-none flex-col gap-5 sm:max-w-none">
          <DialogHeader>
            <DialogTitle className="text-base">
              {operationDialog ? t(`sshFilesTool.${operationDialog.operation}Title`) : ''}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {t('sshFilesTool.operationDesc', { count: operationDialog?.paths.length ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            id="ssh-file-operation-form"
            onSubmit={(event) => {
              event.preventDefault();
              void executeOperationDialog();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-file-operation-target" className="text-xs text-muted-foreground">
                {operationDialog?.operation === 'rename'
                  ? t('sshFilesTool.newName')
                  : operationDialog?.operation === 'compress'
                    ? t('sshFilesTool.archivePath')
                    : t('sshFilesTool.targetDirectory')}
              </Label>
              <Input
                id="ssh-file-operation-target"
                value={operationDialog?.value ?? ''}
                onChange={(event) =>
                  setOperationDialog((current) =>
                    current ? { ...current, value: event.target.value } : current,
                  )
                }
                className="font-mono text-xs"
                disabled={operationRunning}
              />
              <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                {operationDialog?.operation === 'compress'
                  ? t('sshFilesTool.archivePathHint')
                  : operationDialog?.operation === 'rename'
                    ? t('sshFilesTool.renameNameHint')
                    : t('sshFilesTool.targetDirectoryHint')}
              </p>
            </div>
            {operationError ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">
                  {t('sshFilesTool.operationFailed')}: {operationError}
                </span>
              </div>
            ) : null}
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={operationRunning}
              onClick={() => setOperationDialog(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="ssh-file-operation-form"
              disabled={operationRunning || operationDialog === null}
            >
              {operationRunning ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CheckCircle data-icon="inline-start" size={14} />
              )}
              {t('sshFilesTool.applyOperation')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={operationConflict !== null}
        onOpenChange={(open) => {
          if (!open && !operationRunning) cancelOperationConflict();
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-[calc(100vw-32px)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sshFilesTool.operationConflictTitle')}</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="grid gap-2 text-xs leading-5">
              <p className="m-0">
                {t('sshFilesTool.operationConflictDesc', {
                  count: operationConflict?.conflicts.length ?? 0,
                })}
              </p>
              <ScrollArea className="w-full max-h-40 overscroll-contain rounded-md border border-border bg-muted/20 p-2">
                <ul className="m-0 list-none space-y-1 font-mono text-[11px]">
                {operationConflict?.conflicts.map((path) => (
                  <li key={path} className="w-full break-all">
                    {path}
                  </li>
                ))}
                </ul>
              </ScrollArea>
              <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                {t('sshFilesTool.operationConflictKeepHint')}
              </p>
              {operationError ? (
                <span className="break-words text-destructive" role="alert">
                  {t('sshFilesTool.operationFailed')}: {operationError}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={operationRunning}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={operationRunning || operationConflict === null}
              onClick={() => void resolveOperationConflict('keep-both')}
            >
              {operationRunning ? <Spinner data-icon="inline-start" /> : null}
              {t('sshFilesTool.keepBoth')}
            </Button>
            <AlertDialogAction
              variant="destructive"
              disabled={operationRunning || operationConflict === null}
              onClick={() => void resolveOperationConflict('overwrite')}
            >
              {operationRunning ? <Spinner data-icon="inline-start" /> : null}
              {t('sshFilesTool.overwrite')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog
        open={deletePaths !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletePaths(null);
            setOperationError('');
          }
        }}
        title={t('sshFilesTool.deleteTitle')}
        descriptionClassName="grid gap-2"
        error={operationError ? `${t('sshFilesTool.operationFailed')}: ${operationError}` : null}
        confirmLabel={t('sshFilesTool.deleteAction')}
        destructive
        busy={operationRunning}
        onConfirm={() => void executeDelete()}
      >
        <p className="m-0">{t('sshFilesTool.deleteDesc', { count: deletePaths?.length ?? 0 })}</p>
        <ScrollArea className="w-full max-h-40 overscroll-contain">
          <ol className="m-0 list-none space-y-1 font-mono text-[11px]">
          {deletePaths?.map((path, index) => (
            <li
              key={`${path}-${index}`}
              className="flex w-full min-w-0 items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
            >
              <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1 break-all">{path}</span>
            </li>
          ))}
          </ol>
        </ScrollArea>
      </ConfirmDialog>
      <Dialog open={tasksOpen} onOpenChange={setTasksOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('sshFilesTool.tasksTitle')}</DialogTitle>
            <DialogDescription>{t('sshFilesTool.tasksDesc')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 max-h-[55vh] overflow-hidden">
            <ScrollArea className="min-h-0 max-h-[55vh] overscroll-contain [padding-inline-end:var(--overlay-scrollbar-size)]" options={{ overflow: { x: 'hidden' } }}>
              {tasks.length ? (
                <div>
                  {tasks
                    .slice()
                    .reverse()
                    .map((task) => {
                      const running = ['queued', 'running', 'scanning'].includes(task.status);
                      return (
                        <div
                          key={task.id}
                          className="border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {taskTypeLabel(task.type, t)}
                              </div>
                              <div className="flex flex-none items-center gap-1.5">
                                <Badge
                                  variant={taskStatusVariant(task.status)}
                                  className="h-5 text-[10px]"
                                >
                                  {taskStatusLabel(task.status, t)}
                                </Badge>
                                {running ? (
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    className="h-6 px-2 text-[11px]"
                                    onClick={() => void CancelFileTask(task.id)}
                                  >
                                    {t('sshFilesTool.cancelTask')}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                              <span
                                className="min-w-0 break-all"
                                title={task.current || task.target || undefined}
                              >
                                {task.current || task.target || '—'}
                              </span>
                            </div>
                            <TaskProgressMeter task={task} />
                            {task.error ? (
                              <div
                                className="mt-1 break-all text-[10px] text-destructive"
                                role="alert"
                              >
                                {task.error}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {t('sshFilesTool.noTasks')}
                </div>
               )}
             </ScrollArea>
           </div>
           <DialogFooter>
            <Button variant="outline" onClick={() => setTasksOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ToolLayout>
  );
}
