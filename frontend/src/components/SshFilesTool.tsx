import { FavoritePath } from './ssh-files/FavoritePath';
import {
  Archive,
  ArrowClockwise,
  ArrowsLeftRight,
  ArrowUpRight,
  CaretDown,
  CaretRight,
  CaretUp,
  CheckCircle,
  Copy,
  DownloadSimple,
  File,
  FileArchive,
  Folder,
  FolderSimplePlus,
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
} from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Events } from '@wailsio/runtime';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalculateRemoteSize,
  CancelFileTask,
  CreateRemoteDirectory,
  GetFileTasks,
  GetRemoteFileEntry,
  ListRemoteFiles,
  OperateRemoteFiles,
  ResolveRemoteFileTask,
  SaveFileSources,
  StartFileDownload,
  StartFileUpload,
  StartRemoteFileOperation,
} from '../../bindings/tinkerkit/fileservice';
import type { FileTask, FileTaskSnapshot, RemoteFileEntry } from '../../bindings/tinkerkit/models';
import { ConfirmDialog } from './ConfirmDialog';
import { useFileDrop } from './fileDrop';
import {
  ToolActionButton,
  ToolHeaderField,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutToolbar,
  useCheckboxDragSelect,
} from './shared';
import {
  archiveStem,
  basename,
  buildRenamePreview,
  DIRECTORY_CACHE_TTL_MS,
  directoryListingKey,
  emptyFileSource,
  errorMessage,
  formatBytes,
  formatRemoteTimestamp,
  isArchivePath,
  isEditableTextFile,
  isRemotePathNotFound,
  MANAGE_SOURCES_VALUE,
  normalizeRemotePath,
  remoteFileIcon,
  remoteParent,
  timestampMillis,
  usesDirectoryTree,
  type CachedDirectoryListing,
  type FileSortKey,
  type ManagedFileSource,
  type OperationConflictState,
  type OperationDialogState,
  type RemoteFileOperation,
  type RemoteOperationRunResult,
  type SortDirection,
} from './ssh-files/model';
import { TaskProgressMeter } from './ssh-files/TaskProgressMeter';
import { useRemoteFileBrowser } from './ssh-files/useRemoteFileBrowser';
import { SSHProfileFormField } from './SSHProfileFormField';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { TargetHostManagerDialog, upsertManagerItem } from './TargetHostManagerDialog';
import { openTaskCenter } from './TaskCenter';
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
import { Switch } from './ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { toast } from './ui/toast';

const RemoteTextEditorDialog = lazy(async () => ({
  default: (await import('./RemoteTextEditorDialog')).RemoteTextEditorDialog,
}));

type Props = { active: boolean };

export default function SshFilesTool({ active }: Props) {
  const { t, i18n } = useTranslation();
  const { profiles } = useSSHProfiles();
  const [sortKey, setSortKey] = useState<FileSortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [sizeValues, setSizeValues] = useState<Record<string, number>>({});
  const [tasks, setTasks] = useState<FileTask[]>([]);
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
  const [editingFile, setEditingFile] = useState<RemoteFileEntry | null>(null);
  const [treeExpanded, setTreeExpanded] = useState<string[]>([]);
  const [treeLoading, setTreeLoading] = useState<string[]>([]);
  const [treeErrors, setTreeErrors] = useState<Record<string, string>>({});
  const treeRequestRef = useRef(0);
  const treeViewportRef = useRef<HTMLElement | null>(null);
  const treeCurrentDirectoryRef = useRef<HTMLDivElement | null>(null);
  const treePositionPathRef = useRef('');
  const treeInitialFocusRef = useRef<HTMLButtonElement | null>(null);
  const treePositionPendingRef = useRef(false);
  const treeLoadingRef = useRef(treeLoading);
  treeLoadingRef.current = treeLoading;
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [treeCreateFolderOpen, setTreeCreateFolderOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState('');
  const [createFolderError, setCreateFolderError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [favoritesSaving, setFavoritesSaving] = useState(false);
  const [pendingFavoriteRemoval, setPendingFavoriteRemoval] = useState<{
    sourceID: string;
    path: string;
  } | null>(null);
  const favoriteRequestRef = useRef<ReturnType<typeof GetRemoteFileEntry> | null>(null);

  const refreshedUploadTasks = useRef(new Set<string>());
  const refreshedOperationTasks = useRef(new Set<string>());
  const handledConflictTasks = useRef(new Set<string>());
  const taskRevisionRef = useRef(0);
  const {
    currentPath,
    sourceID,
    activeSourceProfileID,
    profileListingKey,
    reloadCurrentView,
    sourceUsable,
    loadingSources,
    loading,
    searching,
    setError,
    resetSearchState,
    loadDirectory,
    showHidden,
    selected,
    entries,
    setSelected,
    source,
    favoritePaths,
    sources,
    setSources,
    missingFavoritePath,
    setMissingFavoritePath,
    navigate,
    searchActive,
    setEntries,
    setSourceID,
    searchMode,
    searchScope,
    setLoading,
    setPathEditing,
    setCurrentPath,
    setShowHidden,
    executeSearch,
    searchInput,
    setSearchInput,
    clearSearch,
    setSearchMode,
    setSearchScope,
    pathEditing,
    pathInput,
    setPathInput,
    breadcrumbs,
    isCurrentPathFavorite,
    cancelLoading,
    directoryLoadingPhase,
    loadingDirectoryPath,
    loadingCanceled,
    retryCanceledLoading,
    error,
    directoryCache,
  } = useRemoteFileBrowser({ active, profiles, manageOpen });
  const currentPathRef = useRef(currentPath);

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

  const refreshAfterTextSave = () => {
    if (editingFile) {
      const parent = remoteParent(editingFile.path);
      const prefix = [sourceID, activeSourceProfileID, profileListingKey].join('\0') + '\0';
      for (const [key, listing] of directoryCache) {
        if (key.startsWith(prefix) && listing.path === parent) directoryCache.delete(key);
      }
    }
    reloadCurrentView();
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
      void loadDirectory(sourceID, currentPath, showHidden, true);
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
      void loadDirectory(sourceID, currentPath, showHidden, true);
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

  const operationPathsFor = (entryPath: string) =>
    selected.includes(entryPath) ? selected : [entryPath];
  const renamePreview = useMemo(
    () =>
      operationDialog?.operation === 'rename' && operationDialog.renameForm
        ? buildRenamePreview(operationDialog.paths, operationDialog.renameForm, entries)
        : [],
    [entries, operationDialog],
  );
  const renameReady =
    renamePreview.length > 0 && renamePreview.every((item) => item.status === 'ok');

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

  const copyPathToClipboard = async (pathValues: string[]) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(pathValues.join('\n'));
      toast.add({ title: t('sshFilesTool.pathCopied'), type: 'success' });
    } catch {
      toast.add({ title: t('sshFilesTool.copyPathFailed'), type: 'error' });
    }
  };

  useEffect(
    () => () => {
      favoriteRequestRef.current?.cancel();
      favoriteRequestRef.current = null;
    },
    [sourceID, activeSourceProfileID, profileListingKey],
  );

  const openFavorite = async (path: string) => {
    if (!sourceUsable) return;
    favoriteRequestRef.current?.cancel();
    const request = GetRemoteFileEntry(sourceID, path);
    favoriteRequestRef.current = request;
    try {
      const entry = await request;
      if (favoriteRequestRef.current !== request) return;
      if (entry.isDir) navigate(path, 'favorite');
      else if (!entry.isSymlink && isEditableTextFile(entry.path)) setEditingFile(entry);
      else toast.add({ title: t('sshFilesTool.favoriteFileNotEditable'), type: 'error' });
    } catch (reason) {
      if (favoriteRequestRef.current !== request) return;
      if (isRemotePathNotFound(reason)) {
        setMissingFavoritePath({ sourceID, path, previousPath: currentPath });
      } else {
        toast.add({
          title: t('sshFilesTool.favoriteOpenFailed'),
          description: errorMessage(reason),
          type: 'error',
        });
      }
    } finally {
      if (favoriteRequestRef.current === request) favoriteRequestRef.current = null;
    }
  };

  const toggleFavorite = async (pathValue = currentPath, isFile = false) => {
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
          isFile
            ? isFavorite
              ? 'sshFilesTool.favoriteFileRemoved'
              : 'sshFilesTool.favoriteFileAdded'
            : isCurrentPath
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

  const removeFavoritePath = async (
    pending: { sourceID: string; path: string; previousPath?: string } | null,
  ) => {
    if (!pending || favoritesSaving) return;
    const targetSource = sources.find((item) => item.id === pending.sourceID);
    if (!targetSource) {
      setMissingFavoritePath(null);
      setPendingFavoriteRemoval(null);
      return;
    }
    const currentFavoritePaths = targetSource.favoritePaths ?? [];
    const nextFavoritePaths = currentFavoritePaths.filter(
      (pathValue) => pathValue !== pending.path,
    );
    if (nextFavoritePaths.length === currentFavoritePaths.length) {
      setMissingFavoritePath(null);
      setPendingFavoriteRemoval(null);
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
      setPendingFavoriteRemoval(null);
      if (
        sourceID === pending.sourceID &&
        pending.previousPath !== undefined &&
        pending.previousPath !== pending.path
      ) {
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
      await loadDirectory(sourceID, currentPath, showHidden, true);
      toast.add({ title: t('sshFilesTool.folderCreated'), type: 'success' });
    } catch (reason) {
      setCreateFolderError(errorMessage(reason));
    } finally {
      setCreatingFolder(false);
    }
  };

  const requestFileOperation = (operation: RemoteFileOperation, paths: string[]) => {
    if (!sourceUsable) return;
    setTreeCreateFolderOpen(false);
    const normalizedPaths = Array.from(new Set(paths.map(normalizeRemotePath)));
    if (!normalizedPaths.length) return;
    if (operation === 'rename') {
      normalizedPaths.sort((left, right) => right.split('/').length - left.split('/').length);
    }
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
    setOperationDialog({
      operation,
      paths: normalizedPaths,
      value,
      renameForm:
        operation === 'rename'
          ? {
              mode: normalizedPaths.length === 1 ? 'custom' : 'prefix',
              value: normalizedPaths.length === 1 ? basename(normalizedPaths[0]) : '',
              find: '',
              replacement: '',
            }
          : undefined,
    });
    if (usesDirectoryTree(operation)) {
      const parent = remoteParent(normalizedPaths[0]);
      treePositionPathRef.current = parent;
      const ancestors =
        parent === '/'
          ? ['/']
          : [
              '/',
              ...parent
                .split('/')
                .filter(Boolean)
                .map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`),
            ];
      setTreeExpanded(ancestors);
      treePositionPendingRef.current = true;
      setTreeLoading([]);
      setTreeErrors({});
      treeRequestRef.current++;
      for (const ancestor of ancestors) {
        if (ancestor !== currentPath) void loadTreeDirectory(ancestor);
      }
    }
  };

  const treeListing = (path: string) => {
    const key = directoryListingKey(
      sourceID,
      activeSourceProfileID,
      profileListingKey,
      path,
      showHidden,
    );
    const cached = directoryCache.get(key);
    if (cached && Date.now() - cached.cachedAt < DIRECTORY_CACHE_TTL_MS) return cached.entries;
    if (path === currentPath && !loading && !searchActive) return entries;
    return undefined;
  };

  const isKnownTreeDirectory = (path: string) =>
    path === '/' ||
    (path === currentPath && !searchActive) ||
    Array.from(directoryCache.values()).some(
      (listing) =>
        Date.now() - listing.cachedAt < DIRECTORY_CACHE_TTL_MS &&
        listing.entries.some((entry) => entry.path === path && entry.isDir),
    );

  const positionTreeAtCurrentDirectory = useCallback(() => {
    if (!treePositionPendingRef.current) return false;
    const viewport = treeViewportRef.current;
    const row = treeCurrentDirectoryRef.current;
    if (!viewport || !row || !viewport.isConnected || !row.isConnected || !viewport.clientHeight)
      return false;
    viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    return true;
  }, []);

  const receiveTreeViewport = useCallback(
    (viewport: HTMLElement | null) => {
      treeViewportRef.current = viewport;
      if (positionTreeAtCurrentDirectory() && treeLoadingRef.current.length === 0) {
        treePositionPendingRef.current = false;
      }
    },
    [positionTreeAtCurrentDirectory],
  );

  useLayoutEffect(() => {
    if (!usesDirectoryTree(operationDialog?.operation)) return;
    if (positionTreeAtCurrentDirectory() && treeLoadingRef.current.length === 0) {
      treePositionPendingRef.current = false;
    }
  }, [
    operationDialog?.operation,
    operationDialog?.paths,
    operationDialog?.value,
    treeLoading,
    positionTreeAtCurrentDirectory,
  ]);

  const renderTreeDirectory = (path: string, depth: number): React.ReactNode => {
    const expanded = treeExpanded.includes(path);
    const listing = expanded ? treeListing(path) : undefined;
    const directories =
      listing?.filter((entry) => entry.isDir).sort((a, b) => a.name.localeCompare(b.name)) ?? [];
    const currentParent = operationDialog?.paths.length
      ? remoteParent(operationDialog.paths[0])
      : '';
    const targetDirectory =
      operationDialog?.operation === 'compress'
        ? remoteParent(operationDialog.value)
        : operationDialog?.operation === 'extract' && !isKnownTreeDirectory(operationDialog.value)
          ? remoteParent(operationDialog.value)
          : operationDialog?.value;
    const nextAncestor = currentParent.startsWith(`${path === '/' ? '' : path}/`)
      ? `/${currentParent
          .split('/')
          .filter(Boolean)
          .slice(0, depth + 1)
          .join('/')}`
      : '';
    const children =
      nextAncestor &&
      nextAncestor !== path &&
      !directories.some((entry) => entry.path === nextAncestor)
        ? [nextAncestor, ...directories.map((entry) => entry.path)]
        : directories.map((entry) => entry.path);
    return (
      <div key={path}>
        <div
          ref={
            treePositionPendingRef.current && path === treePositionPathRef.current
              ? treeCurrentDirectoryRef
              : undefined
          }
          className="flex min-w-0 items-center gap-1"
          style={{ paddingLeft: depth * 16 }}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            disabled={operationRunning || creatingFolder}
            aria-label={t(
              expanded ? 'sshFilesTool.collapseDirectory' : 'sshFilesTool.expandDirectory',
              { name: path },
            )}
            aria-expanded={expanded}
            onClick={() => void expandTreeDirectory(path)}
          >
            {treeLoading.includes(path) ? (
              <Spinner />
            ) : expanded ? (
              <CaretDown size={14} />
            ) : (
              <CaretRight size={14} />
            )}
          </Button>
          <Button
            ref={path === currentParent ? treeInitialFocusRef : undefined}
            type="button"
            variant={targetDirectory === path ? 'secondary' : 'ghost'}
            className="h-7 min-w-0 flex-1 justify-start gap-2 px-2 text-xs"
            disabled={operationRunning || creatingFolder}
            onClick={() =>
              setOperationDialog((current) =>
                current
                  ? {
                      ...current,
                      value:
                        current.operation === 'compress'
                          ? normalizeRemotePath(`${path}/${basename(current.value)}`)
                          : path,
                    }
                  : current,
              )
            }
          >
            <Folder size={14} className="shrink-0" />
            <span className="truncate" title={path}>
              {path === '/' ? '/' : basename(path)}
            </span>
          </Button>
        </div>
        {expanded ? (
          <div>
            {treeErrors[path] ? (
              <p className="m-0 px-2 py-1 text-xs text-destructive" role="alert">
                {treeErrors[path]}
              </p>
            ) : null}
            {children.map((child) => renderTreeDirectory(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  const loadTreeDirectory = async (path: string, force = false) => {
    if (!force && treeListing(path)) return;
    const requestID = treeRequestRef.current;
    setTreeLoading((current) => [...current, path]);
    setTreeErrors((current) => ({ ...current, [path]: '' }));
    try {
      const result = await ListRemoteFiles(sourceID, path, showHidden, `tree-${requestID}-${path}`);
      if (requestID !== treeRequestRef.current) return;
      const resolved = normalizeRemotePath(result.path || path);
      const listing: CachedDirectoryListing = {
        cachedAt: Date.now(),
        requestID,
        path: resolved,
        entries: result.entries ?? [],
      };
      directoryCache.set(
        directoryListingKey(sourceID, activeSourceProfileID, profileListingKey, path, showHidden),
        listing,
      );
      if (resolved === currentPath && !searchActive) setEntries(listing.entries);
      directoryCache.set(
        directoryListingKey(
          sourceID,
          activeSourceProfileID,
          profileListingKey,
          resolved,
          showHidden,
        ),
        listing,
      );
    } catch (reason) {
      if (requestID === treeRequestRef.current)
        setTreeErrors((current) => ({ ...current, [path]: errorMessage(reason) }));
    } finally {
      if (requestID === treeRequestRef.current)
        setTreeLoading((current) => current.filter((item) => item !== path));
    }
  };

  const openTreeFolderCreator = () => {
    setCreateFolderName('');
    setCreateFolderError('');
    setTreeCreateFolderOpen(true);
  };

  const executeTreeFolderCreate = async () => {
    if (!operationDialog || !sourceUsable || creatingFolder) return;
    const name = createFolderName.trim();
    if (!name) {
      setCreateFolderError(t('sshFilesTool.folderNameRequired'));
      return;
    }
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
      setCreateFolderError(t('sshFilesTool.folderNameInvalid'));
      return;
    }
    const parent =
      operationDialog.operation === 'compress'
        ? remoteParent(operationDialog.value)
        : operationDialog.operation === 'extract' && !isKnownTreeDirectory(operationDialog.value)
          ? remoteParent(operationDialog.value)
          : normalizeRemotePath(operationDialog.value);
    const createdPath = normalizeRemotePath(`${parent}/${name}`);
    setCreatingFolder(true);
    setCreateFolderError('');
    try {
      await CreateRemoteDirectory(sourceID, createdPath);
      await loadTreeDirectory(parent, true);
      const ancestors =
        parent === '/'
          ? ['/']
          : [
              '/',
              ...parent
                .split('/')
                .filter(Boolean)
                .map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`),
            ];
      treePositionPathRef.current = createdPath;
      treePositionPendingRef.current = true;
      setTreeExpanded((current) => Array.from(new Set([...current, ...ancestors])));
      setOperationDialog((current) =>
        current
          ? {
              ...current,
              value:
                current.operation === 'compress'
                  ? normalizeRemotePath(`${createdPath}/${basename(current.value)}`)
                  : createdPath,
            }
          : current,
      );
      setTreeCreateFolderOpen(false);
      setCreateFolderName('');
    } catch (reason) {
      setCreateFolderError(errorMessage(reason));
    } finally {
      setCreatingFolder(false);
    }
  };

  const expandTreeDirectory = (path: string) => {
    if (treeExpanded.includes(path)) {
      setTreeExpanded((current) =>
        current.filter((item) => item !== path && !item.startsWith(`${path}/`)),
      );
      return;
    }
    setTreeExpanded((current) => [...current, path]);
    void loadTreeDirectory(path);
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
      await loadDirectory(sourceID, currentPath, showHidden, true);
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
    if (current.operation === 'rename') {
      if (!current.renameForm || !renameReady || !sourceUsable) {
        setOperationError(t('sshFilesTool.renamePreviewInvalid'));
        return;
      }
      setOperationRunning(true);
      setOperationError('');
      let completed = 0;
      try {
        for (const item of renamePreview) {
          await OperateRemoteFiles(sourceID, 'rename', [item.source], item.target, '');
          completed++;
        }
        setOperationDialog(null);
        setSelected([]);
        toast.add({
          title: t('sshFilesTool.operationSucceeded', { operation: t('sshFilesTool.rename') }),
          type: 'success',
        });
      } catch (reason) {
        setOperationDialog({ ...current, paths: current.paths.slice(completed) });
        setSelected((paths) =>
          paths.filter((path) => !current.paths.slice(0, completed).includes(path)),
        );
        setOperationError(
          completed
            ? t('sshFilesTool.renamePartialFailed', { completed, error: errorMessage(reason) })
            : errorMessage(reason),
        );
      } finally {
        if (completed) {
          resetSearchState();
          await loadDirectory(sourceID, currentPath, showHidden, true);
        }
        setOperationRunning(false);
      }
      return;
    }
    const value = current.value.trim();
    if (!value) {
      setOperationError(t('sshFilesTool.operationTargetRequired'));
      return;
    }
    let target = normalizeRemotePath(value);
    if (current.operation === 'compress' && !isArchivePath(target)) {
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
      <ToolLayoutToolbar
        left={
          <div className="flex min-w-0 flex-wrap items-end gap-3 max-[700px]:w-full">
            <ToolHeaderField
              label={t('sshFilesTool.source')}
              labelId="ssh-file-source-label"
              className="min-w-[220px] max-[700px]:w-full"
            >
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
                  aria-labelledby="ssh-file-source-label"
                  className="w-[220px] max-w-full max-[700px]:w-full"
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
            </ToolHeaderField>
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
            <ToolActionButton
              variant="primary"
              icon={UploadSimple}
              label={t('sshFilesTool.upload')}
              disabled={!sourceUsable || isLoading}
              onPress={() => void fileDrop.pick()}
            />
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
              <ScrollArea
                className="min-w-0 flex-1 py-1"
                options={{ overflow: { x: 'scroll', y: 'hidden' } }}
              >
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
                        <CaretRight
                          size={12}
                          className="mx-0.5 shrink-0 text-muted-foreground/50"
                        />
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
                    <div
                      key={favoritePath}
                      className="group/favorite relative rounded-md hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground"
                    >
                      <DropdownMenuItem
                        className="pr-8"
                        onClick={() => void openFavorite(favoritePath)}
                      >
                        <Star size={14} weight="duotone" aria-hidden="true" />
                        <FavoritePath path={favoritePath} />
                      </DropdownMenuItem>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-md bg-linear-to-r from-transparent via-popover to-popover pl-6 pr-1 opacity-0 group-hover/favorite:via-accent group-hover/favorite:to-accent group-hover/favorite:opacity-100 group-focus-within/favorite:via-accent group-focus-within/favorite:to-accent group-focus-within/favorite:opacity-100 [@media(pointer:coarse)]:opacity-100">
                        <DropdownMenuItem
                          render={<Button variant="ghost" size="icon-xs" />}
                          className="group/favorite-remove pointer-events-auto"
                          closeOnClick={false}
                          disabled={favoritesSaving}
                          aria-label={`${t('sshFilesTool.removeFavoritePath')} ${favoritePath}`}
                          title={t('sshFilesTool.removeFavoritePath')}
                          onClick={() =>
                            setPendingFavoriteRemoval({ sourceID, path: favoritePath })
                          }
                        >
                          <Trash
                            size={14}
                            className="opacity-60 group-hover/favorite-remove:opacity-80 group-focus-visible/favorite-remove:opacity-80"
                            aria-hidden="true"
                          />
                        </DropdownMenuItem>
                      </div>
                    </div>
                  ))
                ) : (
                  <DropdownMenuItem disabled>{t('sshFilesTool.noFavorites')}</DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 flex-none"
            disabled={!sourceUsable || isLoading}
            onClick={reloadCurrentView}
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
                    {searching
                      ? t('sshFilesTool.searching')
                      : t(`sshFilesTool.${directoryLoadingPhase}`)}
                  </span>
                  <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground/70">
                    {loadingDirectoryPath}
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
                  <div className="text-sm font-medium text-foreground">
                    {t('sshFilesTool.empty')}
                  </div>
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
                    onClick={reloadCurrentView}
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
                    {t(
                      searchActive ? 'sshFilesTool.searchNoResults' : 'sshFilesTool.directoryEmpty',
                    )}
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
                      const canFavoriteEntry =
                        entry.isDir || (!entry.isSymlink && isEditableTextFile(entry.path));
                      const isEntryFavorite = favoritePaths.includes(entry.path);
                      const EntryIcon = entry.isDir ? Folder : remoteFileIcon(entry.path);
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
                                      : isEditableTextFile(entry.path) && !entry.isSymlink
                                        ? setEditingFile(entry)
                                        : void downloadSelected([entry.path])
                                  }
                                >
                                  <EntryIcon
                                    size={16}
                                    weight="duotone"
                                    className="shrink-0 text-muted-foreground"
                                  />
                                  <span className="min-w-0 truncate">{entry.name}</span>
                                  {isEntryFavorite ? (
                                    <Star
                                      size={12}
                                      weight="fill"
                                      aria-label={t('sshFilesTool.favorites')}
                                      className="shrink-0 text-muted-foreground"
                                    />
                                  ) : null}
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
                                onClick={() => void copyPathToClipboard(operationPaths)}
                              >
                                <Copy size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchCopyPath'
                                    : 'sshFilesTool.copyPath',
                                )}
                              </ContextMenuItem>
                              {canFavoriteEntry && operationPaths.length === 1 ? (
                                <ContextMenuItem
                                  disabled={favoritesSaving}
                                  onClick={() => void toggleFavorite(entry.path, !entry.isDir)}
                                >
                                  <Star
                                    size={14}
                                    weight={isEntryFavorite ? 'fill' : 'duotone'}
                                    aria-hidden="true"
                                  />
                                  {t(
                                    isEntryFavorite
                                      ? 'sshFilesTool.removeFavoritePath'
                                      : entry.isDir
                                        ? 'sshFilesTool.addFavoritePath'
                                        : 'sshFilesTool.addFavoriteFile',
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
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchCopy'
                                    : 'sshFilesTool.copy',
                                )}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={operationRunning}
                                onClick={() => requestFileOperation('move', operationPaths)}
                              >
                                <ArrowsLeftRight size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchMove'
                                    : 'sshFilesTool.move',
                                )}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={operationRunning}
                                onClick={() => requestFileOperation('rename', operationPaths)}
                              >
                                <PencilSimple size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchRename'
                                    : 'sshFilesTool.rename',
                                )}
                              </ContextMenuItem>
                              <ContextMenuItem
                                variant="destructive"
                                disabled={operationRunning}
                                onClick={() => requestFileOperation('delete', operationPaths)}
                              >
                                <Trash size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchDelete'
                                    : 'sshFilesTool.delete',
                                )}
                              </ContextMenuItem>
                            </ContextMenuGroup>
                            <ContextMenuSeparator />
                            <ContextMenuGroup>
                              <ContextMenuItem
                                disabled={operationRunning || !archiveSelection}
                                onClick={() => requestFileOperation('extract', operationPaths)}
                              >
                                <FileArchive size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchExtract'
                                    : 'sshFilesTool.extract',
                                )}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={operationRunning}
                                onClick={() => requestFileOperation('compress', operationPaths)}
                              >
                                <Archive size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchCompress'
                                    : 'sshFilesTool.compress',
                                )}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={operationRunning}
                                onClick={() => void downloadSelected(operationPaths)}
                              >
                                <DownloadSimple size={14} weight="duotone" aria-hidden="true" />
                                {t(
                                  operationPaths.length > 1
                                    ? 'sshFilesTool.batchDownload'
                                    : 'sshFilesTool.download',
                                )}
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
                onClick={() => void copyPathToClipboard([currentPath])}
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
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem disabled={!sourceUsable || isLoading} onClick={reloadCurrentView}>
                <ArrowClockwise size={14} weight="duotone" aria-hidden="true" />
                {t('sshFilesTool.refresh')}
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
                onClick={() => openTaskCenter('ssh-files')}
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
          return upsertManagerItem(previous, next, (item) => item.id, draft.id || undefined);
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
                <SSHProfileFormField
                  id="ssh-source-profile"
                  value={draft.sshProfileID}
                  onSelect={(profile) =>
                    setDraft({
                      ...draft,
                      sshProfileID: profile?.id ?? '',
                      name: draft.name.trim() || profile?.name || draft.name,
                    })
                  }
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
          edit: t('sshFilesTool.editSource'),
          remove: t('sshFilesTool.removeSourceAction'),
          dragItem: (name) => t('sidebar.dragTool', { name }),
          empty: t('sshFilesTool.empty'),
          emptyHint: t('sshFilesTool.emptyHint'),
          save: t('common.save'),
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
        open={pendingFavoriteRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFavoriteRemoval(null);
        }}
        title={t('sshFilesTool.removeFavoritePath')}
        description={t('sshFilesTool.removeFavoriteDescription', {
          path: pendingFavoriteRemoval?.path ?? '',
        })}
        confirmLabel={t('sshFilesTool.removeFavoritePath')}
        destructive
        busy={favoritesSaving}
        onConfirm={() => void removeFavoritePath(pendingFavoriteRemoval)}
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
        onConfirm={() => void removeFavoritePath(missingFavoritePath)}
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
          if (!open && !operationRunning && !creatingFolder) {
            setOperationDialog(null);
            setOperationError('');
            setTreeCreateFolderOpen(false);
          }
        }}
      >
        <DialogContent
          initialFocus={
            usesDirectoryTree(operationDialog?.operation) ? treeInitialFocusRef : undefined
          }
          className="flex w-[min(560px,calc(100vw-32px))] max-w-none flex-col gap-5 sm:max-w-none"
        >
          <DialogHeader>
            <DialogTitle className="text-base">
              {operationDialog?.operation === 'rename' && operationDialog.paths.length > 1
                ? t('sshFilesTool.batchRenameTitle')
                : operationDialog
                  ? t(`sshFilesTool.${operationDialog.operation}Title`)
                  : ''}
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
            {usesDirectoryTree(operationDialog?.operation) ? (
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">
                    {t('sshFilesTool.directoryTree')}
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={operationRunning || creatingFolder}
                    onClick={() =>
                      treeCreateFolderOpen
                        ? setTreeCreateFolderOpen(false)
                        : openTreeFolderCreator()
                    }
                  >
                    {t('sshFilesTool.createFolder')}
                  </Button>
                </div>
                {treeCreateFolderOpen ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="ssh-tree-create-folder-name" className="sr-only">
                      {t('sshFilesTool.folderName')}
                    </Label>
                    <div className="flex min-w-0 gap-2">
                      <Input
                        id="ssh-tree-create-folder-name"
                        value={createFolderName}
                        placeholder={t('sshFilesTool.folderName')}
                        disabled={creatingFolder}
                        autoFocus
                        onChange={(event) => {
                          setCreateFolderName(event.target.value);
                          setCreateFolderError('');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void executeTreeFolderCreate();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={creatingFolder}
                        onClick={() => void executeTreeFolderCreate()}
                      >
                        {creatingFolder ? <Spinner data-icon="inline-start" /> : null}
                        {t('sshFilesTool.createFolderAction')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={creatingFolder}
                        onClick={() => setTreeCreateFolderOpen(false)}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                    {createFolderError ? (
                      <p className="m-0 text-xs text-destructive" role="alert">
                        {t('sshFilesTool.folderCreateFailed')}: {createFolderError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <ScrollArea
                  className="h-56 rounded-md border border-border p-2"
                  options={{ overflow: { x: 'hidden' } }}
                  onViewport={receiveTreeViewport}
                >
                  {renderTreeDirectory('/', 0)}
                </ScrollArea>
              </div>
            ) : null}
            {operationDialog?.operation === 'rename' && operationDialog.renameForm ? (
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label>{t('sshFilesTool.renameMode')}</Label>
                  <div className="flex flex-wrap gap-1">
                    {(['prefix', 'suffix', 'replace', 'custom'] as const).map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        size="sm"
                        variant={operationDialog.renameForm?.mode === mode ? 'secondary' : 'ghost'}
                        disabled={operationRunning}
                        onClick={() => {
                          setOperationError('');
                          setOperationDialog((current) =>
                            current?.renameForm
                              ? {
                                  ...current,
                                  renameForm: {
                                    ...current.renameForm,
                                    mode,
                                    value: mode === 'custom' ? basename(current.paths[0]) : '',
                                  },
                                }
                              : current,
                          );
                        }}
                      >
                        {t(`sshFilesTool.renameMode${mode[0].toUpperCase()}${mode.slice(1)}`)}
                      </Button>
                    ))}
                  </div>
                </div>
                {operationDialog.renameForm.mode === 'replace' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ssh-file-rename-find">{t('sshFilesTool.renameFind')}</Label>
                      <Input
                        id="ssh-file-rename-find"
                        value={operationDialog.renameForm.find}
                        disabled={operationRunning}
                        onChange={(event) => {
                          setOperationError('');
                          setOperationDialog((current) =>
                            current?.renameForm
                              ? {
                                  ...current,
                                  renameForm: { ...current.renameForm, find: event.target.value },
                                }
                              : current,
                          );
                        }}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ssh-file-rename-replacement">
                        {t('sshFilesTool.renameReplacement')}
                      </Label>
                      <Input
                        id="ssh-file-rename-replacement"
                        value={operationDialog.renameForm.replacement}
                        disabled={operationRunning}
                        onChange={(event) => {
                          setOperationError('');
                          setOperationDialog((current) =>
                            current?.renameForm
                              ? {
                                  ...current,
                                  renameForm: {
                                    ...current.renameForm,
                                    replacement: event.target.value,
                                  },
                                }
                              : current,
                          );
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="ssh-file-rename-value">
                      {t(
                        operationDialog.renameForm.mode === 'custom'
                          ? 'sshFilesTool.newName'
                          : operationDialog.renameForm.mode === 'prefix'
                            ? 'sshFilesTool.renamePrefix'
                            : 'sshFilesTool.renameSuffix',
                      )}
                    </Label>
                    <Input
                      id="ssh-file-rename-value"
                      value={operationDialog.renameForm.value}
                      disabled={operationRunning}
                      onChange={(event) => {
                        setOperationError('');
                        setOperationDialog((current) =>
                          current?.renameForm
                            ? {
                                ...current,
                                renameForm: { ...current.renameForm, value: event.target.value },
                              }
                            : current,
                        );
                      }}
                    />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label>{t('sshFilesTool.renamePreview')}</Label>
                  <ScrollArea
                    className="max-h-40 rounded-md border border-border bg-muted/40 px-3 py-2"
                    options={{ overflow: { x: 'hidden' } }}
                  >
                    <div className="grid gap-2">
                      {renamePreview.map((item) => (
                        <div key={item.source} className="grid gap-0.5 font-mono text-xs">
                          <span className="break-all text-muted-foreground">{item.source}</span>
                          <span
                            className={`break-all ${item.status === 'ok' ? 'text-foreground' : 'text-destructive'}`}
                          >
                            → {item.target}
                          </span>
                          {item.status !== 'ok' ? (
                            <span className="text-destructive">
                              {t(
                                `sshFilesTool.renameStatus${item.status[0].toUpperCase()}${item.status.slice(1)}`,
                              )}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label
                  htmlFor="ssh-file-operation-target"
                  className="text-xs text-muted-foreground"
                >
                  {operationDialog?.operation === 'compress'
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
                    : t('sshFilesTool.targetDirectoryHint')}
                </p>
              </div>
            )}
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
              disabled={operationRunning || creatingFolder}
              onClick={() => setOperationDialog(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="ssh-file-operation-form"
              disabled={
                operationRunning ||
                creatingFolder ||
                operationDialog === null ||
                (operationDialog?.operation === 'rename' && !renameReady)
              }
            >
              {operationRunning ? <Spinner data-icon="inline-start" /> : null}
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
      {editingFile ? (
        <Suspense fallback={null}>
          <RemoteTextEditorDialog
            key={`${sourceID}:${editingFile.path}`}
            sourceID={sourceID}
            path={editingFile.path}
            name={editingFile.name}
            onClose={() => setEditingFile(null)}
            onSaved={refreshAfterTextSave}
          />
        </Suspense>
      ) : null}
    </ToolLayout>
  );
}
