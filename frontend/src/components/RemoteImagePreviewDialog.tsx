import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ReadRemoteImageFile } from '../../bindings/tinkerkit/fileservice';
import { ToolSlotOverlayContext } from '../app/tool-slot';
import { formatBytes } from './ssh-files/model';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { toast } from './ui/toast';
import { formatBackendError } from '../lib/backend-error';

const minZoomFactor = 0.25;
const maxZoomFactor = 8;
const zoomWheelGain = 0.0015;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampPan(
  panX: number,
  panY: number,
  scale: number,
  naturalW: number,
  naturalH: number,
  viewW: number,
  viewH: number,
) {
  // 双向取绝对差：放大时不允许把图像边缘拖进视口，缩小时不允许把整图拖出视口。
  const maxX = Math.abs(naturalW * scale - viewW) / 2;
  const maxY = Math.abs(naturalH * scale - viewH) / 2;
  return {
    x: clamp(panX, -maxX, maxX),
    y: clamp(panY, -maxY, maxY),
  };
}

// 居中与平移、缩放合成一条 transform：拖动时直接写 DOM 与 React 渲染共用同一字符串，避免重渲染时跳位。
function panTransform(panX: number, panY: number, scale: number) {
  return `translate3d(calc(-50% + ${panX}px), calc(-50% + ${panY}px), 0) scale(${scale})`;
}

// data URL 还原成 Blob，保留原始 MIME，供剪贴板优先写入原图字节。
function dataURLToBlob(dataURL: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,/i.exec(dataURL);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const body = dataURL.slice(match[0].length);
  try {
    if (match[2]) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new Blob([bytes], { type: mime });
    }
    return new Blob([new TextEncoder().encode(decodeURIComponent(body))], { type: mime });
  } catch {
    return null;
  }
}

function clipboardSupports(type: string) {
  const supports = (ClipboardItem as unknown as { supports?: (value: string) => boolean }).supports;
  return typeof supports === 'function' ? supports.call(ClipboardItem, type) : true;
}

type ZoomMode = 'fit' | 'actual' | 'custom';

type Props = {
  sourceID: string;
  path: string;
  name: string;
  size: number;
  onClose: () => void;
  onDownload: () => void;
};

export function RemoteImagePreviewDialog({
  sourceID,
  path,
  name,
  size,
  onClose,
  onDownload,
}: Props) {
  const { t } = useTranslation();
  const overlayRoot = useContext(ToolSlotOverlayContext);
  const sectionRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  // 交互（拖动/滚轮）期间的实时视图状态：transform 直接写 DOM，React state 每帧末同步一次。
  const liveRef = useRef<{ scale: number; panX: number; panY: number } | null>(null);
  const commitFrameRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [decoded, setDecoded] = useState(false);
  const [dataURL, setDataURL] = useState('');
  const [fileSize, setFileSize] = useState(size);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [mode, setMode] = useState<ZoomMode>('fit');
  const [copying, setCopying] = useState(false);

  // 适应窗口只缩小不放大：小图放大到充满窗口既模糊又会让「适应窗口」与「100%」无从区分。
  const fit =
    natural.w > 0 && natural.h > 0 && viewport.w > 0 && viewport.h > 0
      ? Math.min(1, viewport.w / natural.w, viewport.h / natural.h)
      : 1;
  // 任意缩放比例都允许拖拽：缩小时可在视口内移动，放大时用于查看局部。
  const canPan = decoded;
  const viewRef = useRef({
    scale,
    panX: pan.x,
    panY: pan.y,
    fit,
    naturalW: natural.w,
    naturalH: natural.h,
    viewW: viewport.w,
    viewH: viewport.h,
  });
  viewRef.current = {
    scale,
    panX: pan.x,
    panY: pan.y,
    fit,
    naturalW: natural.w,
    naturalH: natural.h,
    viewW: viewport.w,
    viewH: viewport.h,
  };

  useLayoutEffect(() => {
    sectionRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    let active = true;
    let request: ReturnType<typeof ReadRemoteImageFile> | undefined;
    setLoading(true);
    setError('');
    setDecodeFailed(false);
    setDecoded(false);
    setDataURL('');
    setMode('fit');
    setPan({ x: 0, y: 0 });
    liveRef.current = null;

    const read = async () => {
      if (!active) return;
      request = ReadRemoteImageFile(sourceID, path);
      try {
        const file = await request;
        if (!active) return;
        if (!file?.dataURL) {
          setError(t('sshFilesTool.imageReadUnavailable'));
          setLoading(false);
          return;
        }
        setDataURL(file.dataURL);
        if (typeof file.size === 'number' && file.size > 0) setFileSize(file.size);
        setLoading(false);
      } catch (reason) {
        if (!active) return;
        setError(formatBackendError(reason));
        setLoading(false);
      }
    };
    // 在本轮同步清理结束后发请求，避免 Strict Mode 重放 effect 时读两次。
    queueMicrotask(() => void read());
    return () => {
      active = false;
      void request?.cancel();
    };
  }, [sourceID, path, t]);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node || !dataURL) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setViewport({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [dataURL]);

  const settleImage = (img: HTMLImageElement) => {
    if (!img.naturalWidth || !img.naturalHeight) {
      setDecodeFailed(true);
      setDecoded(false);
      return;
    }
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    setDecodeFailed(false);
    setDecoded(true);
  };

  useLayoutEffect(() => {
    const img = imageRef.current;
    if (!img || !dataURL || decoded) return;
    // 命中缓存的图片可能在挂载时已经 complete，load 事件不会再派发。
    if (img.complete) settleImage(img);
  });

  useLayoutEffect(() => {
    if (mode !== 'fit' || !decoded) return;
    setScale(fit);
    setPan({ x: 0, y: 0 });
  }, [mode, fit, decoded]);

  // 窗口尺寸变化后立即把平移量收回新边界，不必等下一次滚轮或拖拽。
  useLayoutEffect(() => {
    if (!decoded) return;
    if (!natural.w || !natural.h || !viewport.w || !viewport.h) return;
    const clamped = clampPan(pan.x, pan.y, scale, natural.w, natural.h, viewport.w, viewport.h);
    if (clamped.x === pan.x && clamped.y === pan.y) return;
    setPan(clamped);
    // 交互进行中同步实时值，避免下一帧又被旧位置盖回去。
    if (liveRef.current) liveRef.current = { scale, panX: clamped.x, panY: clamped.y };
  }, [decoded, pan.x, pan.y, scale, natural.w, natural.h, viewport.w, viewport.h]);

  // 交互热路径直接改 img 的 transform，避开每次 pointermove/wheel 都重渲染整个对话框。
  const paint = (nextScale: number, panX: number, panY: number) => {
    const img = imageRef.current;
    if (!img) return;
    img.style.transform = panTransform(panX, panY, nextScale);
  };

  const commitLive = () => {
    const live = liveRef.current;
    if (!live) return;
    setScale((current) => (current === live.scale ? current : live.scale));
    setPan((current) =>
      current.x === live.panX && current.y === live.panY ? current : { x: live.panX, y: live.panY },
    );
  };

  // 同一帧内的多次交互只提交一次 state，保证百分比文案与按钮状态跟着走而不拖慢手势。
  const scheduleCommit = () => {
    if (commitFrameRef.current) return;
    commitFrameRef.current = requestAnimationFrame(() => {
      commitFrameRef.current = 0;
      commitLive();
    });
  };

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !decoded) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      const line = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      const nextScale = clamp(
        current.scale * Math.exp(-event.deltaY * line * zoomWheelGain),
        Math.min(current.fit, 1) * minZoomFactor || minZoomFactor,
        Math.max(current.fit, 1) * maxZoomFactor,
      );
      if (nextScale === current.scale) return;
      const rect = node.getBoundingClientRect();
      const offsetX = event.clientX - rect.left - rect.width / 2;
      const offsetY = event.clientY - rect.top - rect.height / 2;
      const ratio = nextScale / current.scale;
      // 指针锚定缩放：视口中心为原点，保持光标下的图像点不动（与 translate+scale 层叠一致）。
      let panX = offsetX * (1 - ratio) + current.panX * ratio;
      let panY = offsetY * (1 - ratio) + current.panY * ratio;
      const clamped = clampPan(
        panX,
        panY,
        nextScale,
        current.naturalW,
        current.naturalH,
        current.viewW,
        current.viewH,
      );
      panX = clamped.x;
      panY = clamped.y;
      viewRef.current = { ...current, scale: nextScale, panX, panY };
      liveRef.current = { scale: nextScale, panX, panY };
      paint(nextScale, panX, panY);
      // 滚轮缩放不再隐式重置模式：fit 只由按钮恢复，避免缩回时悄悄清掉平移。
      setMode('custom');
      scheduleCommit();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [decoded]);

  const showFit = () => {
    liveRef.current = null;
    setMode('fit');
    setScale(fit);
    setPan({ x: 0, y: 0 });
  };

  const showActual = () => {
    liveRef.current = null;
    setMode('actual');
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  // 交互中若因其它原因重渲染（模式切换、视口尺寸变化），把 DOM 上的实时位置盖回去，避免回跳。
  useLayoutEffect(() => {
    const live = liveRef.current;
    if (live) paint(live.scale, live.panX, live.panY);
  });

  useEffect(
    () => () => {
      if (commitFrameRef.current) cancelAnimationFrame(commitFrameRef.current);
    },
    [],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!decoded || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const img = imageRef.current;
    if (img) img.style.willChange = 'transform';
    liveRef.current = { scale: viewRef.current.scale, panX: pan.x, panY: pan.y };
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = viewRef.current;
    const next = clampPan(
      drag.panX + event.clientX - drag.x,
      drag.panY + event.clientY - drag.y,
      current.scale,
      current.naturalW,
      current.naturalH,
      current.viewW,
      current.viewH,
    );
    // 同步给 viewRef：拖动中途滚轮缩放时能读到最新位置。
    current.panX = next.x;
    current.panY = next.y;
    liveRef.current = { scale: current.scale, panX: next.x, panY: next.y };
    // 直接写 transform：样式写入不触发布局，同一帧内的多次移动由浏览器自行合并。
    // 平移不改变百分比，所以拖动全程不提交 state，等到抬手再对齐一次。
    paint(current.scale, next.x, next.y);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (commitFrameRef.current) {
      cancelAnimationFrame(commitFrameRef.current);
      commitFrameRef.current = 0;
    }
    const img = imageRef.current;
    if (img) img.style.willChange = '';
    // 抬手时一次性对齐 state：transform 字符串不变，不会出现视觉跳变。
    commitLive();
    liveRef.current = null;
  };

  const rasterizeToPNG = (img: HTMLImageElement) =>
    new Promise<Blob>((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0 || canvas.height === 0) {
        reject(new Error('encode'));
        return;
      }
      context.drawImage(img, 0, 0);
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('encode'))), 'image/png');
    });

  const copyImage = async () => {
    const img = imageRef.current;
    if (!img || !decoded || copying || decodeFailed) return;
    setCopying(true);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('clipboard unavailable');
      }
      const original = dataURLToBlob(dataURL);
      // 优先写入原始字节（GIF/WebP 等保持原样），只有剪贴板拒绝该 MIME 时才退回单帧 PNG。
      if (original && clipboardSupports(original.type)) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ [original.type]: original })]);
          toast.add({ title: t('sshFilesTool.imageCopied'), type: 'success' });
          return;
        } catch {
          // 继续走 PNG 回退。
        }
      }
      const png = original?.type === 'image/png' ? original : await rasterizeToPNG(img);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast.add({ title: t('sshFilesTool.imageCopied'), type: 'success' });
    } catch {
      toast.add({ title: t('sshFilesTool.imageCopyFailed'), type: 'error' });
    } finally {
      setCopying(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const failure = decodeFailed ? t('sshFilesTool.imageDecodeFailed') : error;
  const preview = (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="pointer-events-auto absolute inset-0 z-20 flex min-h-0 items-center justify-center overflow-hidden p-4 outline-none"
      onKeyDownCapture={onKeyDown}
    >
      {/* 模糊层只盖当前工具页，标签栏仍可点击；点击它与全局对话框一样按关闭处理。
          这一层不能做 opacity 动画：自身或祖先 opacity 不是 1 时 backdrop-filter 会消失。 */}
      <div
        aria-hidden="true"
        className="absolute inset-0 cursor-default bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
        onClick={onClose}
      />
      <div
        data-slot="remote-image-preview"
        role="dialog"
        aria-label={t('sshFilesTool.imagePreviewTitle', { name })}
        className="relative grid h-[min(72vh,720px)] min-h-0 max-h-full w-[min(960px,calc(100%-2rem))] grid-rows-[minmax(0,1fr)_auto_auto] gap-y-2 overflow-hidden rounded-xl border border-border bg-popover pb-4 shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 duration-100"
      >
        <div className="min-h-0 min-w-0 p-0.5">
          <div className="relative h-full min-h-0 overflow-hidden rounded-[calc(var(--radius-xl)-2px)] border border-border bg-card">
            {dataURL && !failure ? (
              <div
                ref={viewportRef}
                className={`absolute inset-0 touch-none overflow-hidden ${canPan ? 'cursor-grab active:cursor-grabbing' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <img
                  ref={imageRef}
                  src={dataURL}
                  alt={name}
                  draggable={false}
                  className={`absolute top-1/2 left-1/2 max-w-none origin-center select-none ${decoded ? '' : 'invisible'}`}
                  style={{
                    width: natural.w || undefined,
                    height: natural.h || undefined,
                    transform: panTransform(pan.x, pan.y, scale),
                    transformOrigin: 'center center',
                  }}
                  onLoad={(event) => settleImage(event.currentTarget)}
                  onError={() => {
                    setDecodeFailed(true);
                    setDecoded(false);
                  }}
                />
              </div>
            ) : null}
            {loading || (dataURL && !decoded && !failure) ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner />
              </div>
            ) : null}
            {failure ? (
              // 长错误（例如无空格的地址或堆栈）必须换行并可在区域内滚动，不能被 overflow-hidden 截断。
              <div className="h-full w-full overflow-auto" role="alert">
                <div className="flex min-h-full items-center justify-center px-6 py-4">
                  <p className="wrap-anywhere m-0 min-w-0 max-w-full text-center text-sm whitespace-pre-wrap text-destructive">
                    {failure}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4">
          <p
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
          </p>
          <p className="text-xs text-muted-foreground">{formatBytes(fileSize)}</p>
        </div>
        <div className="flex flex-col-reverse gap-2 px-4 sm:flex-row sm:justify-end">
          <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant={mode === 'fit' ? 'secondary' : 'outline'}
              onClick={showFit}
              disabled={!decoded}
              aria-pressed={mode === 'fit'}
            >
              {t('sshFilesTool.imageFit')}
            </Button>
            <Button
              variant={mode === 'actual' ? 'secondary' : 'outline'}
              onClick={showActual}
              disabled={!decoded}
              aria-pressed={mode === 'actual'}
            >
              {t('sshFilesTool.imageActualSize')}
            </Button>
            <p className="text-xs text-muted-foreground" aria-label={t('sshFilesTool.imageZoom')}>
              {decoded ? `${Math.round(scale * 100)}%` : ''}
            </p>
          </div>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="outline" onClick={onDownload}>
            {t('sshFilesTool.download')}
          </Button>
          <Button onClick={() => void copyImage()} disabled={!decoded || copying || decodeFailed}>
            {copying ? <Spinner data-icon="inline-start" /> : null}
            {t('sshFilesTool.copyImage')}
          </Button>
        </div>
      </div>
    </section>
  );

  return overlayRoot ? createPortal(preview, overlayRoot) : preview;
}
