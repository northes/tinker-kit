import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Events, Window } from '@wailsio/runtime';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowClockwise,
  Funnel,
  FunnelSimple,
  FolderSimple,
  GearSix,
  ListDashes,
  X,
} from '@phosphor-icons/react';
import type { Config, FileTask, ImageTask } from '../../bindings/changeme/models';
import {
  CancelFileTask,
  ClearFileTasks,
  GetFileTasks,
  OpenFileTaskFolder,
  RetryFileTask,
} from '../../bindings/changeme/fileservice';
import {
  CancelImageTask,
  ClearImageTasks,
  GetImageTasks,
  OpenImageTaskFolder,
  RetryImageTask,
} from '../../bindings/changeme/imageservice';
import { Get as GetConfig } from '../../bindings/changeme/configservice';
import { GetFileSources } from '../../bindings/changeme/fileservice';
import {
  IsAvailable,
  OpenNotificationSettings,
  RequestAuthorization,
  Send,
} from '../../bindings/changeme/tasknotificationservice';
import { toast } from './ui/toast';
import { showTaskNotificationPermissionDialog } from '../lib/task-notification-feedback';
import {
  estimateTaskRemainingSeconds,
  formatTaskBytes,
  formatTaskDuration,
} from '../lib/task-format';
import { formatBackendError } from '../lib/backend-error';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { Spinner } from './ui/spinner';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from './ui/popover';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
type TaskSettings = Pick<
  Config,
  'taskConcurrency' | 'taskChunkConcurrency' | 'taskNotificationMode'
>;

type ToolFilter = 'all' | 'image-manager' | 'ssh-files';
type StatusFilter =
  'queued' | 'running' | 'scanning' | 'success' | 'failed' | 'canceled' | 'conflict';
type UnifiedTask = {
  id: string;
  tool: Exclude<ToolFilter, 'all'>;
  kind: string;
  name: string;
  sourceID: string;
  status: string;
  stage: string;
  createdAt: string;
  completed: number;
  total: number;
  speed?: number;
  error?: string;
  image?: ImageTask;
  file?: FileTask;
};

const TaskCenterContext = createContext<(tool: Exclude<ToolFilter, 'all'>) => void>(
  () => undefined,
);

export function openTaskCenter(tool: Exclude<ToolFilter, 'all'>) {
  window.dispatchEvent(new CustomEvent('tinkerkit:tasks-open', { detail: tool }));
}

export function useTaskCenter() {
  return useContext(TaskCenterContext);
}

const terminal = (status: string) => ['success', 'failed', 'canceled'].includes(status);
const active = (status: string) => ['queued', 'running', 'scanning', 'conflict'].includes(status);
const hasByteSpeed = (task: UnifiedTask) =>
  Boolean(task.file || task.image?.type === 'export' || task.image?.type === 'load');
const imageValue = (task: ImageTask) =>
  task.type === 'export' || task.type === 'load' ? task.bytes : task.completed;
const fileValue = (task: FileTask) => task.completed;

function fileName(task: FileTask) {
  const candidate = task.paths?.[0] || task.current || task.target || '';
  const trimmed = candidate.replace(/[\\/]$/, '');
  return trimmed.split(/[\\/]/).pop() || candidate || task.type;
}

function imageName(task: ImageTask) {
  return task.imageID || task.path?.split(/[\\/]/).pop() || task.type;
}

function taskTitle(task: UnifiedTask, t: (key: string) => string) {
  const operation =
    task.tool === 'image-manager'
      ? t(`imageManagerTool.taskStage${task.kind[0]?.toUpperCase()}${task.kind.slice(1)}`)
      : t(`sshFilesTool.${task.kind}`);
  return task.name ? `${operation} · ${task.name}` : operation;
}

function unifiedTasks(images: ImageTask[], files: FileTask[]): UnifiedTask[] {
  return [
    ...images
      .filter((task) => task.type !== 'detail' && task.type !== 'update')
      .map((task) => ({
        id: task.id,
        tool: 'image-manager' as const,
        kind: task.type,
        name: imageName(task),
        sourceID: task.sourceID,
        status: task.status,
        stage: task.stage,
        createdAt: task.createdAt,
        completed: imageValue(task),
        total: task.total,
        error: task.error,
        image: task,
      })),
    ...files
      .filter((task) => task.type !== 'size')
      .map((task) => ({
        id: task.id,
        tool: 'ssh-files' as const,
        kind: task.type,
        name: fileName(task),
        sourceID: task.sourceID,
        status: task.status,
        stage: task.stage,
        createdAt: task.createdAt,
        completed: fileValue(task),
        total: task.total,
        error: task.error,
        file: task,
      })),
  ];
}

export function TaskCenter({
  settings,
  onSettingsChange,
}: {
  settings: TaskSettings;
  onSettingsChange: (patch: Partial<TaskSettings>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [clearingFinished, setClearingFinished] = useState(false);

  const [notificationPermissionOpen, setNotificationPermissionOpen] = useState(false);
  const [notificationSettingsOpenFailed, setNotificationSettingsOpenFailed] = useState(false);
  const [openingNotificationSettings, setOpeningNotificationSettings] = useState(false);
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter[]>([]);
  const [images, setImages] = useState<ImageTask[]>([]);
  const [files, setFiles] = useState<FileTask[]>([]);
  const [sourceDisplayNames, setSourceDisplayNames] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [concurrencyDraft, setConcurrencyDraft] = useState({
    taskConcurrency: settings.taskConcurrency ?? 4,
    taskChunkConcurrency: settings.taskChunkConcurrency ?? 4,
  });
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const buffered = useRef<Array<{ kind: 'image' | 'file'; data: any }>>([]);
  const imageRevision = useRef(-1);
  const fileRevision = useRef(-1);
  const statuses = useRef(new Map<string, string>());
  const samples = useRef(new Map<string, { bytes: number; at: number; speed: number }>());
  const notificationAuthorized = useRef<boolean | null>(null);
  const pendingSnapshots = useRef<{ image?: ImageTask[]; file?: FileTask[] }>({});

  const processSnapshot = useCallback(
    (kind: 'image' | 'file', data: any, notify: boolean) => {
      const revision = kind === 'image' ? imageRevision : fileRevision;
      if (data.revision < revision.current) return;
      revision.current = data.revision;
      if (kind === 'image') pendingSnapshots.current.image = data.tasks ?? [];
      else pendingSnapshots.current.file = data.tasks ?? [];
      const items: UnifiedTask[] =
        kind === 'image'
          ? unifiedTasks(data.tasks ?? [], []).filter((task) => task.tool === 'image-manager')
          : unifiedTasks([], data.tasks ?? []).filter((task) => task.tool === 'ssh-files');
      for (const task of items) {
        const before = statuses.current.get(task.id);
        if (
          notify &&
          terminal(task.status) &&
          task.status !== 'canceled' &&
          before &&
          !terminal(before)
        ) {
          const toolName = t(
            task.tool === 'image-manager' ? 'tools.image-manager.name' : 'tools.ssh-files.name',
          );
          const taskName = taskTitle(task, t);
          const status = t(task.status === 'success' ? 'taskCenter.completed' : 'taskCenter.failed');
          const notificationTitle = t(
            task.status === 'success'
              ? 'taskCenter.notificationCompleted'
              : 'taskCenter.notificationFailed',
          );
          const notificationBody = t('taskCenter.notificationBody', {
            task: taskName,
            tool: toolName,
          });
          const title = t('taskCenter.result', {
            status,
            task: taskName,
            tool: toolName,
          });
          toast.add({
            title,
            description: task.error ? formatBackendError(task.error) : undefined,
            type: task.status === 'failed' ? 'error' : undefined,
          });
          void (async () => {
            const mode = settings.taskNotificationMode ?? 'unfocused';
            if (mode === 'off') return;
            if (mode === 'unfocused' && (await Window.IsFocused())) return;
            if (!(await IsAvailable())) {
              showTaskNotificationPermissionDialog();
              return;
            }
            if (notificationAuthorized.current !== true) {
              notificationAuthorized.current = await RequestAuthorization();
              if (!notificationAuthorized.current) {
                showTaskNotificationPermissionDialog();
                return;
              }
            }
            await Send(`task-${task.id}`, notificationTitle, notificationBody);
          })().catch(() => showTaskNotificationPermissionDialog());
        }
        statuses.current.set(task.id, task.status);
        const time = Date.now();
        const prior = samples.current.get(task.id);
        const rate =
          prior && time > prior.at
            ? Math.max(0, ((task.completed - prior.bytes) * 1000) / (time - prior.at))
            : 0;
        samples.current.set(task.id, {
          bytes: task.completed,
          at: time,
          speed: prior ? prior.speed * 0.55 + rate * 0.45 : rate,
        });
      }
    },
    [settings.taskNotificationMode, t],
  );

  const commitSnapshots = useCallback(() => {
    const pending = pendingSnapshots.current;
    if (pending.image) {
      setImages(pending.image);
      pending.image = undefined;
    }
    if (pending.file) {
      setFiles(pending.file);
      pending.file = undefined;
    }
  }, []);

  useEffect(() => {
    let ready = false;
    const offImage = Events.On('image-manager:tasks', (event) => {
      const data = event.data as { revision: number; tasks: ImageTask[] };
      if (!ready) buffered.current.push({ kind: 'image', data });
      else processSnapshot('image', data, true);
    });
    const offFile = Events.On('ssh-files:tasks', (event) => {
      const data = event.data as { revision: number; tasks: FileTask[] };
      if (!ready) buffered.current.push({ kind: 'file', data });
      else processSnapshot('file', data, true);
    });
    void Promise.all([GetImageTasks(), GetFileTasks(), GetConfig(), GetFileSources()])
      .then(([imageSnapshot, fileSnapshot, currentConfig, sources]) => {
        const names: Record<string, string> = Object.fromEntries(
          (sources ?? []).map((source) => [source.id, source.name]),
        );
        for (const source of currentConfig.imageSources ?? [])
          names[source.id] =
            source.name || (source.kind === 'local' ? t('taskCenter.localSource') : '');
        setSourceDisplayNames(names);
        processSnapshot('image', imageSnapshot, false);
        processSnapshot('file', fileSnapshot, false);
        ready = true;
        const pending = buffered.current.splice(0);
        pending.sort((a, b) => a.data.revision - b.data.revision);
        for (const event of pending) processSnapshot(event.kind, event.data, true);
        commitSnapshots();
      })
      .catch(() => {
        ready = true;
      });
    return () => {
      offImage();
      offFile();
    };
  }, [processSnapshot, commitSnapshots, t]);

  useEffect(() => {
    const openCenter = (event: Event) => {
      const tool = (event as CustomEvent<ToolFilter>).detail;
      setToolFilter(tool === 'image-manager' || tool === 'ssh-files' ? tool : 'all');
      setStatusFilter([]);
      setOpen(true);
    };
    window.addEventListener('tinkerkit:tasks-open', openCenter);
    return () => window.removeEventListener('tinkerkit:tasks-open', openCenter);
  }, []);

  useEffect(() => {
    const showPermissionDialog = () => {
      setNotificationSettingsOpenFailed(false);
      setNotificationPermissionOpen(true);
    };
    window.addEventListener('tinkerkit:task-notification-permission', showPermissionDialog);
    return () =>
      window.removeEventListener('tinkerkit:task-notification-permission', showPermissionDialog);
  }, []);

  const openNotificationSettings = async () => {
    setOpeningNotificationSettings(true);
    try {
      await OpenNotificationSettings();
      setNotificationPermissionOpen(false);
    } catch {
      setNotificationSettingsOpenFailed(true);
    } finally {
      setOpeningNotificationSettings(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      commitSnapshots();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [commitSnapshots]);

  useEffect(() => {
    setConcurrencyDraft({
      taskConcurrency: settings.taskConcurrency ?? 4,
      taskChunkConcurrency: settings.taskChunkConcurrency ?? 4,
    });
  }, [settings.taskConcurrency, settings.taskChunkConcurrency]);

  useEffect(() => {
    const mode = settings.taskNotificationMode ?? 'unfocused';
    if (mode === 'off' || notificationAuthorized.current !== null) return;
    void IsAvailable()
      .then(async (available) => {
        if (!available) {
          notificationAuthorized.current = false;
          showTaskNotificationPermissionDialog();
          return;
        }
        const authorized = await RequestAuthorization();
        notificationAuthorized.current = authorized;
        if (!authorized) showTaskNotificationPermissionDialog();
      })
      .catch(() => {
        notificationAuthorized.current = false;
        showTaskNotificationPermissionDialog();
      });
  }, [settings.taskNotificationMode, t]);

  const allTasks = useMemo(() => unifiedTasks(images, files), [images, files]);
  const tasksWithSpeed = useMemo(
    () =>
      allTasks.map((task) => ({
        ...task,
        speed: active(task.status) ? (samples.current.get(task.id)?.speed ?? 0) : 0,
      })),
    [allTasks, now],
  );
  const visibleTasks = useMemo(
    () =>
      tasksWithSpeed
        .filter(
          (task) =>
            (toolFilter === 'all' || task.tool === toolFilter) &&
            (statusFilter.length === 0 || statusFilter.includes(task.status as StatusFilter)),
        )
        .sort(
          (a, b) =>
            (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) ||
            a.id.localeCompare(b.id),
        ),
    [tasksWithSpeed, toolFilter, statusFilter],
  );
  const virtualizer = useVirtualizer({
    count: visibleTasks.length,
    getScrollElement: () => viewport,
    estimateSize: () => 92,
    overscan: 5,
  });

  const activeTasks = visibleTasks.filter((task) => active(task.status));
  const hasCancelableTasks = allTasks.some((task) => active(task.status));
  const hasFinishedTasks = allTasks.some((task) => !active(task.status));
  const known = activeTasks.filter((task) => task.total > 0 && task.image?.type !== 'pull');
  const hasUnknown = activeTasks.some((task) => task.total <= 0 || task.image?.type === 'pull');
  const total = known.reduce((sum, task) => sum + task.total, 0);
  const completed = known.reduce((sum, task) => sum + Math.min(task.completed, task.total), 0);
  const totalProgress = total > 0 ? (completed / total) * 100 : 0;
  const totalSpeed = activeTasks.reduce(
    (sum, task) => sum + (hasByteSpeed(task) ? (task.speed ?? 0) : 0),
    0,
  );
  const aggregateProgressPercent =
    activeTasks.length > 0 && !hasUnknown && total > 0 ? Math.min(100, totalProgress) : null;
  const remainingSeconds =
    activeTasks.length > 0 && !hasUnknown
      ? estimateTaskRemainingSeconds(Math.max(0, total - completed), totalSpeed)
      : null;
  const footerTimeText = t('taskCenter.remainingTime', {
    duration: remainingSeconds === null ? '—' : formatTaskDuration(remainingSeconds),
  });

  const selectConcurrency = (key: 'taskConcurrency' | 'taskChunkConcurrency', next: number) => {
    const updated = { ...concurrencyDraft, [key]: next };
    setConcurrencyDraft(updated);
    onSettingsChange({ [key]: next });
    void (async () => {
      const { SetTaskSettings } = await import('../../bindings/changeme/configservice');
      const saved = await SetTaskSettings(
        updated.taskConcurrency ?? 4,
        updated.taskChunkConcurrency ?? 4,
        settings.taskNotificationMode ?? 'unfocused',
      );
      onSettingsChange({
        taskConcurrency: saved.taskConcurrency,
        taskChunkConcurrency: saved.taskChunkConcurrency,
        taskNotificationMode: saved.taskNotificationMode,
      });
    })().catch(() => toast.add({ title: t('toast.settingsFailed'), type: 'error' }));
  };

  const cancelAllTasks = async () => {
    if (cancelingAll) return;
    setCancelingAll(true);
    try {
      const pending = allTasks.filter((task) => active(task.status));
      const results = await Promise.allSettled(
        pending.map((task) => (task.file ? CancelFileTask(task.id) : CancelImageTask(task.id))),
      );
      if (results.some((result) => result.status === 'rejected')) {
        toast.add({ title: t('taskCenter.cancelSomeFailed'), type: 'error' });
      }
    } finally {
      setCancelingAll(false);
    }
  };

  const clearFinishedTasks = async () => {
    if (clearingFinished) return;
    setClearingFinished(true);
    try {
      await Promise.all([ClearImageTasks(), ClearFileTasks()]);
    } catch {
      toast.add({ title: t('taskCenter.clearFinishedFailed'), type: 'error' });
    } finally {
      setClearingFinished(false);
    }
  };

  const retryTask = async (task: UnifiedTask) => {
    try {
      if (task.file) await RetryFileTask(task.id);
      else await RetryImageTask(task.id);
    } catch {
      toast.add({ title: t('taskCenter.retryFailed'), type: 'error' });
    }
  };

  const openTaskFolder = async (task: UnifiedTask) => {
    try {
      if (task.file) await OpenFileTaskFolder(task.id);
      else await OpenImageTaskFolder(task.id);
    } catch {
      toast.add({ title: t('taskCenter.openFolderFailed'), type: 'error' });
    }
  };

  const statusLabel = (status: string) =>
    t(`taskCenter.status.${status}`, { defaultValue: status });
  const progressPercent = (task: UnifiedTask) =>
    task.status === 'success'
      ? 100
      : task.image?.type === 'pull'
        ? null
        : task.total > 0
          ? Math.min(100, (task.completed / task.total) * 100)
          : null;
  const countImageTask = (type?: string) =>
    type === 'pull' || type === 'tagCopy' || type === 'tagRename';
  const progressText = (task: UnifiedTask) =>
    task.image && countImageTask(task.image.type)
      ? t('imageManagerTool.taskProgressCount', {
          completed: task.image.completed,
          total: task.image.total,
        })
      : task.total > 0
        ? `${formatTaskBytes(task.completed)} / ${formatTaskBytes(task.total)}`
        : task.file?.files
          ? t('taskCenter.filesProgress', { done: task.file.doneFiles, total: task.file.files })
          : '—';
  const toolOptions = (['all', 'image-manager', 'ssh-files'] as ToolFilter[]).map((value) => ({
    value,
    label: t(`taskCenter.tools.${value}`),
  }));
  const statusOptions = (
    ['queued', 'running', 'scanning', 'success', 'failed', 'canceled', 'conflict'] as const
  ).map((value) => ({
    value,
    label: statusLabel(value),
  }));
  const concurrencyOptions = Array.from({ length: 16 }, (_, index) => ({
    value: String(index + 1),
    label: t('taskCenter.limitOption', { value: index + 1 }),
  }));

  return (
    <TaskCenterContext.Provider value={openTaskCenter}>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[600px] max-h-[calc(100dvh-var(--app-titlebar-height)-4rem)] min-h-0 flex-col sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('taskCenter.title')}</DialogTitle>
          </DialogHeader>
          <div className="flex shrink-0 items-center justify-end gap-1.5">
            {hasCancelableTasks ? (
              <Button
                variant="destructive"
                size="sm"
                className="mr-auto shrink-0"
                disabled={cancelingAll}
                onClick={() => void cancelAllTasks()}
              >
                {t('taskCenter.cancelAll')}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="flex-none"
                    aria-label={t('taskCenter.filterTool')}
                    title={t('taskCenter.filterTool')}
                  />
                }
              >
                <Funnel weight="duotone" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuRadioGroup
                  value={toolFilter}
                  onValueChange={(value) => setToolFilter(value as ToolFilter)}
                >
                  {toolOptions.map(({ value, label }) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="flex-none"
                    aria-label={t('taskCenter.filterStatus')}
                    title={t('taskCenter.filterStatus')}
                  />
                }
              >
                <FunnelSimple weight="duotone" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuGroup>
                  <DropdownMenuCheckboxItem
                    checked={statusFilter.length === 0}
                    onCheckedChange={() => setStatusFilter([])}
                  >
                    {t('taskCenter.allStatuses')}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {statusOptions.map(({ value, label }) => (
                    <DropdownMenuCheckboxItem
                      key={value}
                      checked={statusFilter.includes(value)}
                      onCheckedChange={(checked) =>
                        setStatusFilter((current) =>
                          checked
                            ? current.includes(value)
                              ? current
                              : [...current, value]
                            : current.filter((item) => item !== value),
                        )
                      }
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="flex-none"
                    aria-label={t('taskCenter.configureLimits')}
                    title={t('taskCenter.configureLimits')}
                  />
                }
              >
                <GearSix weight="duotone" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72" disableAnchorTracking>
                <PopoverHeader>
                  <PopoverTitle>{t('taskCenter.configureLimits')}</PopoverTitle>
                </PopoverHeader>
                <div className="grid gap-3">
                  {(
                    [
                      {
                        key: 'taskConcurrency',
                        label: t('taskCenter.concurrency'),
                        description: t('taskCenter.concurrencyDesc'),
                      },
                      {
                        key: 'taskChunkConcurrency',
                        label: t('taskCenter.chunks'),
                        description: t('taskCenter.chunksDesc'),
                      },
                    ] as const
                  ).map(({ key, label, description }) => (
                    <div key={key} className="grid min-w-0 gap-1.5">
                      <Label htmlFor={`task-center-${key}`} className="text-xs font-medium">
                        {label}
                      </Label>
                      <p className="m-0 text-[10px] leading-tight text-muted-foreground">
                        {description}
                      </p>
                      <Select
                        items={concurrencyOptions}
                        value={String(concurrencyDraft[key])}
                        onValueChange={(value) => {
                          if (value) selectConcurrency(key, Number(value));
                        }}
                      >
                        <SelectTrigger id={`task-center-${key}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent container={document.body}>
                          <SelectGroup>
                            {concurrencyOptions.map(({ value, label: optionLabel }) => (
                              <SelectItem key={value} value={value}>
                                {optionLabel}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <Button
                  variant="destructive"
                  className="w-full"
                  disabled={clearingFinished || !hasFinishedTasks}
                  onClick={() => void clearFinishedTasks()}
                >
                  {clearingFinished ? <Spinner data-icon="inline-start" /> : null}
                  {t('taskCenter.clearFinished')}
                </Button>
              </PopoverContent>
            </Popover>
          </div>
          {visibleTasks.length === 0 ? (
            <Empty className="min-h-0 flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListDashes weight="duotone" />
                </EmptyMedia>
                <EmptyTitle>{t('taskCenter.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea
              className="min-h-0 flex-1 overscroll-contain [padding-inline-end:var(--overlay-scrollbar-size)]"
              scrollFade="y"
              onViewport={setViewport}
              options={{ overflow: { x: 'hidden' } }}
            >
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const task = visibleTasks[item.index];
                  const progress = progressPercent(task);
                  const isActive = active(task.status);
                  const measureText = progressText(task);
                  const speedText =
                    isActive && (task.speed ?? 0) > 0 && hasByteSpeed(task)
                      ? `${formatTaskBytes(task.speed ?? 0)}/s`
                      : '—';
                  const remainingTaskSeconds =
                    isActive && task.total > 0 && task.image?.type !== 'pull'
                      ? estimateTaskRemainingSeconds(
                          Math.max(0, task.total - task.completed),
                          task.speed ?? 0,
                        )
                      : null;
                  const percentText =
                    progress === null
                      ? '—'
                      : `${progress.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 })}%`;
                  const toolName = t(
                    task.tool === 'image-manager'
                      ? 'tools.image-manager.name'
                      : 'tools.ssh-files.name',
                  );
                  const canRetry = task.status === 'failed' || task.status === 'canceled';
                  const canCancel = isActive && (task.file || task.image?.type === 'export');
                  const canOpenFolder =
                    terminal(task.status) &&
                    ((task.image?.type === 'export' && Boolean(task.image.path)) ||
                      (task.file?.type === 'download' && Boolean(task.file.target)));
                  const indeterminate = progress === null && isActive;
                  const fillPercent = indeterminate ? 100 : (progress ?? 0);
                  return (
                    <div
                      key={task.id}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      className="absolute left-0 top-0 w-full py-1.5"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <div className="relative overflow-hidden rounded-lg border border-border bg-card p-3">
                        <div
                          aria-hidden="true"
                          className="absolute inset-y-0 left-0 bg-primary/10 transition-[width] duration-300 ease-out motion-reduce:transition-none"
                          style={{ width: `${fillPercent}%` }}
                        />
                        <div className="relative">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div
                                className="truncate text-sm font-medium text-foreground"
                                title={taskTitle(task, t)}
                              >
                                {taskTitle(task, t)}
                              </div>
                              <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                                <span className="shrink-0">{toolName}</span>
                                <span aria-hidden="true">·</span>
                                <span
                                  className="min-w-0 truncate"
                                  title={
                                    sourceDisplayNames[task.sourceID] ||
                                    t('taskCenter.unknownSource')
                                  }
                                >
                                  {sourceDisplayNames[task.sourceID] ||
                                    t('taskCenter.unknownSource')}
                                </span>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {canOpenFolder ? (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={t('taskCenter.openFolder')}
                                  title={t('taskCenter.openFolder')}
                                  onClick={() => void openTaskFolder(task)}
                                >
                                  <FolderSimple weight="duotone" />
                                </Button>
                              ) : null}
                              <Badge
                                variant={
                                  task.status === 'success'
                                    ? 'success'
                                    : task.status === 'failed'
                                      ? 'destructive'
                                      : isActive
                                        ? 'blue'
                                        : 'outline'
                                }
                              >
                                {statusLabel(task.status)}
                              </Badge>
                              {canCancel ? (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={t('taskCenter.cancel')}
                                  title={t('taskCenter.cancel')}
                                  onClick={() =>
                                    task.file
                                      ? void CancelFileTask(task.id)
                                      : void CancelImageTask(task.id)
                                  }
                                >
                                  <X weight="duotone" />
                                </Button>
                              ) : null}
                              {canRetry ? (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={t('taskCenter.retry')}
                                  title={t('taskCenter.retry')}
                                  onClick={() => void retryTask(task)}
                                >
                                  <ArrowClockwise weight="duotone" />
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:grid-cols-[10rem_3.5rem_5.5rem_5.5rem]">
                            <span
                              className="min-w-0 whitespace-normal sm:whitespace-nowrap"
                              title={measureText}
                              aria-label={t('taskCenter.itemProgress', { value: measureText })}
                            >
                              {measureText}
                            </span>
                            <span
                              className="text-right"
                              aria-label={t('taskCenter.itemPercent', { value: percentText })}
                            >
                              {percentText}
                            </span>
                            <span
                              className="text-right"
                              aria-label={t('taskCenter.itemSpeed', { value: speedText })}
                            >
                              {speedText}
                            </span>
                            <span
                              className="text-right"
                              aria-label={t('taskCenter.itemRemaining', {
                                value:
                                  remainingTaskSeconds === null
                                    ? '—'
                                    : formatTaskDuration(remainingTaskSeconds),
                              })}
                            >
                              {t('taskCenter.itemRemainingShort', {
                                duration:
                                  remainingTaskSeconds === null
                                    ? '—'
                                    : formatTaskDuration(remainingTaskSeconds),
                              })}
                            </span>
                          </div>
                          {task.error ? (
                            <div
                              className="mt-1 line-clamp-2 break-all text-[10px] text-destructive"
                              title={formatBackendError(task.error)}
                            >
                              {formatBackendError(task.error)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
          <DialogFooter className="flex-col shrink-0 gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_8rem] items-center gap-x-2 gap-y-1 text-[10px] tabular-nums text-muted-foreground sm:grid-cols-[7rem_4.5rem_5rem_5rem]">
                <span className="min-w-0 truncate" title={formatTaskBytes(totalSpeed) + '/s'}>
                  {t('taskCenter.totalSpeed', { speed: `${formatTaskBytes(totalSpeed)}/s` })}
                </span>
                <span className="text-right">
                  {t('taskCenter.progressPercent', {
                    percent:
                      aggregateProgressPercent === null
                        ? '—'
                        : `${aggregateProgressPercent.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 })}%`,
                  })}
                </span>
                <span className="text-right">
                  {t('taskCenter.activeCount', { total: activeTasks.length })}
                </span>
                <span className="w-20 truncate text-right" title={footerTimeText}>
                  {footerTimeText}
                </span>
              </div>
            </div>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={notificationPermissionOpen} onOpenChange={setNotificationPermissionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                notificationSettingsOpenFailed
                  ? 'settings.taskNotificationSettingsOpenFailed'
                  : 'settings.taskNotificationUnavailable',
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                notificationSettingsOpenFailed
                  ? 'settings.taskNotificationSettingsOpenFailedDesc'
                  : 'settings.taskNotificationBlockedDesc',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotificationPermissionOpen(false)}>
              {t('settings.taskNotificationDialogLater')}
            </Button>
            <Button
              onClick={() => void openNotificationSettings()}
              disabled={openingNotificationSettings}
            >
              {t(
                openingNotificationSettings
                  ? 'settings.taskNotificationSettingsOpening'
                  : notificationSettingsOpenFailed
                    ? 'settings.taskNotificationSettingsRetry'
                    : 'settings.openTaskNotificationSettings',
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TaskCenterContext.Provider>
  );
}
