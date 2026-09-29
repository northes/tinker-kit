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
import type { Config, FileTask, ImageTask } from '../../bindings/changeme/models';
import { CancelFileTask, GetFileTasks, RetryFileTask } from '../../bindings/changeme/fileservice';
import {
  CancelImageTask,
  GetImageTasks,
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
import { formatTaskBytes, formatTaskDuration } from '../lib/task-format';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
type TaskSettings = Pick<
  Config,
  'taskConcurrency' | 'taskChunkConcurrency' | 'taskNotificationMode'
>;

type ToolFilter = 'all' | 'image-manager' | 'ssh-files';
type StatusFilter =
  'all' | 'queued' | 'running' | 'scanning' | 'success' | 'failed' | 'canceled' | 'conflict';
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
  const [showElapsedTime, setShowElapsedTime] = useState(false);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [notificationPermissionOpen, setNotificationPermissionOpen] = useState(false);
  const [notificationSettingsOpenFailed, setNotificationSettingsOpenFailed] = useState(false);
  const [openingNotificationSettings, setOpeningNotificationSettings] = useState(false);
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
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

  const processSnapshot = useCallback(
    (kind: 'image' | 'file', data: any, notify: boolean) => {
      const revision = kind === 'image' ? imageRevision : fileRevision;
      if (data.revision < revision.current) return;
      revision.current = data.revision;
      if (kind === 'image') setImages(data.tasks ?? []);
      else setFiles(data.tasks ?? []);
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
          const status = t(
            task.status === 'success' ? 'taskCenter.completed' : 'taskCenter.failed',
          );
          const title = t('taskCenter.result', {
            status,
            task: taskTitle(task, t),
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
            await Send(`task-${task.id}`, title, title);
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
      })
      .catch(() => {
        ready = true;
      });
    return () => {
      offImage();
      offFile();
    };
  }, [processSnapshot, t]);

  useEffect(() => {
    const openCenter = (event: Event) => {
      const tool = (event as CustomEvent<ToolFilter>).detail;
      setToolFilter(tool === 'image-manager' || tool === 'ssh-files' ? tool : 'all');
      setStatusFilter('all');
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
    const timer = window.setInterval(() => setNow(Date.now()), 900);
    return () => window.clearInterval(timer);
  }, []);

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
            (statusFilter === 'all' || task.status === statusFilter),
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
    estimateSize: () => 118,
    overscan: 5,
  });

  const activeTasks = visibleTasks.filter((task) => active(task.status));
  const hasCancelableTasks = allTasks.some((task) => active(task.status));
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
    activeTasks.length > 0 && !hasUnknown && totalSpeed > 0
      ? Math.ceil(Math.max(0, total - completed) / totalSpeed)
      : null;
  const earliestTaskStart = activeTasks.reduce((earliest, task) => {
    const createdAt = Date.parse(task.createdAt);
    return Number.isFinite(createdAt) ? Math.min(earliest, createdAt) : earliest;
  }, Number.POSITIVE_INFINITY);
  const elapsedSeconds = Number.isFinite(earliestTaskStart)
    ? Math.floor(Math.max(0, now - earliestTaskStart) / 1000)
    : null;
  const footerTimeText = showElapsedTime
    ? t('taskCenter.elapsedTime', {
        duration: elapsedSeconds === null ? '—' : formatTaskDuration(elapsedSeconds),
      })
    : t('taskCenter.remainingTime', {
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

  const retryTask = async (task: UnifiedTask) => {
    try {
      if (task.file) await RetryFileTask(task.id);
      else await RetryImageTask(task.id);
    } catch {
      toast.add({ title: t('taskCenter.retryFailed'), type: 'error' });
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
  const progressText = (task: UnifiedTask) =>
    task.image?.type === 'pull'
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
    ['all', 'queued', 'running', 'scanning', 'success', 'failed', 'canceled', 'conflict'] as const
  ).map((value) => ({
    value,
    label: value === 'all' ? t('taskCenter.allStatuses') : statusLabel(value),
  }));
  const concurrencyOptions = Array.from({ length: 16 }, (_, index) => ({
    value: String(index + 1),
    label: t('taskCenter.limitOption', { value: index + 1 }),
  }));

  return (
    <TaskCenterContext.Provider value={openTaskCenter}>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex min-h-0 max-h-[calc(100dvh-var(--app-titlebar-height)-4rem)] flex-col sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('taskCenter.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid shrink-0 grid-cols-2 gap-2">
            <Select
              items={toolOptions}
              value={toolFilter}
              onValueChange={(value) => setToolFilter(value as ToolFilter)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(['all', 'image-manager', 'ssh-files'] as ToolFilter[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`taskCenter.tools.${value}`)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              items={statusOptions}
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {statusOptions.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3">
            <Button
              variant="link"
              size="sm"
              aria-expanded={limitsOpen}
              aria-controls="task-center-limits"
              onClick={() => setLimitsOpen((current) => !current)}
              className="w-fit shrink-0 px-0"
            >
              {t(limitsOpen ? 'taskCenter.hideLimits' : 'taskCenter.configureLimits')}
            </Button>
            {hasCancelableTasks ? (
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0"
                disabled={cancelingAll}
                onClick={() => void cancelAllTasks()}
              >
                {t('taskCenter.cancelAll')}
              </Button>
            ) : null}
          </div>
          {limitsOpen ? (
            <div
              id="task-center-limits"
              className="grid shrink-0 grid-cols-1 gap-x-6 gap-y-3 rounded-md border border-border px-3 py-2.5 sm:grid-cols-2"
            >
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
                    <SelectContent>
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
          ) : null}
          <ScrollArea
            className="max-h-[min(52vh,480px)] min-h-0 flex-1 overscroll-contain [padding-inline-end:var(--overlay-scrollbar-size)]"
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
                  isActive && task.total > 0 && (task.speed ?? 0) > 0 && task.image?.type !== 'pull'
                    ? Math.ceil(Math.max(0, task.total - task.completed) / (task.speed ?? 0))
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
                return (
                  <div
                    key={task.id}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full border-b border-border py-3"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
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
                              sourceDisplayNames[task.sourceID] || t('taskCenter.unknownSource')
                            }
                          >
                            {sourceDisplayNames[task.sourceID] || t('taskCenter.unknownSource')}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
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
                        {isActive && task.file ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => void CancelFileTask(task.id)}
                          >
                            {t('taskCenter.cancel')}
                          </Button>
                        ) : null}
                        {isActive && task.image?.type === 'export' ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => void CancelImageTask(task.id)}
                          >
                            {t('taskCenter.cancel')}
                          </Button>
                        ) : null}
                        {canRetry ? (
                          <Button variant="ghost" size="xs" onClick={() => void retryTask(task)}>
                            {t('taskCenter.retry')}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className={`mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted ${progress === null && isActive ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${progress ?? 0}%` }}
                      />
                    </div>
                    <div className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:grid-cols-[10rem_3.5rem_5.5rem_5.5rem]">
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
                );
              })}
              {visibleTasks.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground">
                  {t('taskCenter.empty')}
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <DialogFooter className="flex-col shrink-0 gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div
                role="progressbar"
                aria-label={t('taskCenter.aggregateProgress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={aggregateProgressPercent ?? undefined}
                className={`h-1.5 w-full overflow-hidden rounded-full bg-muted ${hasUnknown ? 'animate-pulse motion-reduce:animate-none' : ''}`}
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${totalProgress}%` }}
                />
              </div>
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
                <Button
                  variant="link"
                  size="xs"
                  className="w-20 justify-end truncate px-0 text-[10px] text-muted-foreground"
                  aria-label={t('taskCenter.toggleTimeDisplay')}
                  aria-pressed={showElapsedTime}
                  title={footerTimeText}
                  onClick={() => setShowElapsedTime((current) => !current)}
                >
                  {footerTimeText}
                </Button>
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
