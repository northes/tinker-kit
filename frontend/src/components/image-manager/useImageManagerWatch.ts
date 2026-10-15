import { Events } from '@wailsio/runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GetImageTasks,
  RefreshDockerImages,
  WatchDockerImages,
} from '../../../bindings/tinkerkit/imageservice';
import type {
  DockerImage,
  DockerStatus,
  ImageSource,
  ImageTaskSnapshot,
} from '../../../bindings/tinkerkit/models';
import { formatBackendError } from '../../lib/backend-error';
import { applyImageTaskSnapshot } from '../../lib/image-tasks';
import { errorMessage, isWatchCancelError, type WatchDockerImagesEvent } from './model';

// 镜像与任务订阅共同按帧提交快照；来源切换时清理旧订阅及可取消请求。
export function useImageManagerWatch({
  active,
  source,
  sourceProfileMissing,
  sourceConfigKey,
  cliPath,
}: {
  active: boolean;
  source: ImageSource;
  sourceProfileMissing: boolean;
  sourceConfigKey: string;
  cliPath: string;
}) {
  const { t } = useTranslation();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [connectionPending, setConnectionPending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [watchSourceId, setWatchSourceId] = useState<string | null>(null);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isUpdating, setIsUpdating] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState('');
  const watchClientID = useRef<string | null>(null);
  const watchSourceIDRef = useRef<string | null>(null);
  const [taskSnapshot, setTaskSnapshot] = useState<ImageTaskSnapshot | null>(null);
  const tasks = taskSnapshot?.tasks ?? [];

  // 后台更新会高频推送镜像与任务事件（每张镜像的 create/update、每次进度各一条）。
  // 事件只写入暂存引用并按帧合并成一次渲染：无论一轮扫描推送多少条事件，每帧最多
  // setState 一次，主线程不会因逐事件重渲染而占满、阻塞工具切换；工具不活跃（例如
  // 已切到别的工具）时不排帧，回到列表时一次性补齐。
  const activeRef = useRef(active);
  const pendingImagesRef = useRef(false);
  const pendingTasksRef = useRef<ImageTaskSnapshot | null>(null);
  const rebuildImagesRef = useRef<(() => DockerImage[]) | null>(null);
  const imageFrameRef = useRef(0);
  const taskFrameRef = useRef(0);
  const flushImages = useCallback(() => {
    imageFrameRef.current = 0;
    if (!activeRef.current || !pendingImagesRef.current) return;
    pendingImagesRef.current = false;
    const rebuild = rebuildImagesRef.current;
    if (rebuild) setImages(rebuild());
  }, []);
  const scheduleImages = useCallback(() => {
    pendingImagesRef.current = true;
    if (!activeRef.current || imageFrameRef.current) return;
    imageFrameRef.current = requestAnimationFrame(flushImages);
  }, [flushImages]);
  const flushTasks = useCallback(() => {
    taskFrameRef.current = 0;
    if (!activeRef.current || !pendingTasksRef.current) return;
    const next = pendingTasksRef.current;
    pendingTasksRef.current = null;
    setTaskSnapshot((current) => applyImageTaskSnapshot(current, next));
  }, []);

  // 手动刷新标记：只有用户主动刷新触发的 update 任务完成才提示，
  // 每 2 分钟的定时轮询保持静默。
  const applyTasks = useCallback(
    (snapshot: ImageTaskSnapshot) => {
      pendingTasksRef.current = applyImageTaskSnapshot(pendingTasksRef.current, snapshot);
      if (!activeRef.current || taskFrameRef.current) return;
      taskFrameRef.current = requestAnimationFrame(flushTasks);
    },
    [flushTasks],
  );

  useEffect(
    () => () => {
      if (imageFrameRef.current) cancelAnimationFrame(imageFrameRef.current);
      if (taskFrameRef.current) cancelAnimationFrame(taskFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    flushImages();
    flushTasks();
  }, [active, flushImages, flushTasks]);
  const requestWatchReload = useCallback(() => {
    if (sourceProfileMissing) {
      setConnectionPending(false);
      setLoadError(t('imageManagerTool.sshProfileMissingHint'));
      return;
    }
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
  }, [source.id, sourceProfileMissing, t]);
  const restartWatch = useCallback(() => {
    setConnectionPending(true);
    setLoadError('');
    setReloadNonce((value) => value + 1);
  }, []);

  // 导出与拉取在 Go 侧异步执行，前端只能从任务快照得知结果。首次快照只登记状态，
  // 之后的终态变化才提示，避免工具重新挂载时对历史任务重复弹 toast。
  useEffect(() => {
    let active = true;
    const apply = (snapshot: ImageTaskSnapshot) => {
      if (!active) return;
      applyTasks(snapshot);
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

  // 列表组件在详情页仍保持挂载；watcher 不随 active 切换重启，返回列表复用现有快照，按后台定时轮次更新。
  useEffect(() => {
    let mounted = true;
    const clientID = crypto.randomUUID();
    const sourceID = source.id;
    watchClientID.current = clientID;
    watchSourceIDRef.current = sourceID;
    let maxRevision = -1;
    let currentGeneration = -1;
    let restarting = false;
    const map = new Map<string, DockerImage>();
    const rebuild = () => Array.from(map.values());
    rebuildImagesRef.current = rebuild;

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

    if (sourceProfileMissing) {
      setConnectionPending(false);
      setLoadError(t('imageManagerTool.sshProfileMissingHint'));
      return () => {
        mounted = false;
        if (watchClientID.current === clientID) watchClientID.current = null;
        if (watchSourceIDRef.current === sourceID) watchSourceIDRef.current = null;
      };
    }

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
          scheduleImages();
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
        setLoadError(formatBackendError(payload.error));
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
        scheduleImages();
      } else if (kind === 'create' || kind === 'update') {
        if (payload.image && payload.image.id) {
          const image = payload.image;
          map.set(image.id, image);
          scheduleImages();
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
          scheduleImages();
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
      if (rebuildImagesRef.current === rebuild) rebuildImagesRef.current = null;
      offWatch();
      if (typeof watchCall?.cancel === 'function') {
        watchCall.cancel();
      }
    };
  }, [
    cliPath,
    reloadNonce,
    requestWatchReload,
    restartWatch,
    scheduleImages,
    source.id,
    sourceConfigKey,
    sourceProfileMissing,
    t,
  ]);
  return {
    connectionPending,
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
  };
}
