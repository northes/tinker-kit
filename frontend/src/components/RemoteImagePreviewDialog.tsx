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
  const maxX = Math.max(0, (naturalW * scale - viewW) / 2);
  const maxY = Math.max(0, (naturalH * scale - viewH) / 2);
  return {
    x: clamp(panX, -maxX, maxX),
    y: clamp(panY, -maxY, maxY),
  };
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
  const canPan = decoded && scale > fit * 1.001;
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
      let panX = offsetX * (1 - ratio) + current.panX * ratio;
      let panY = offsetY * (1 - ratio) + current.panY * ratio;
      if (nextScale <= current.fit * 1.001) {
        panX = 0;
        panY = 0;
      } else {
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
      }
      viewRef.current = { ...current, scale: nextScale, panX, panY };
      setScale(nextScale);
      setPan({ x: panX, y: panY });
      setMode('custom');
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [decoded]);

  const showFit = () => {
    setMode('fit');
    setScale(fit);
    setPan({ x: 0, y: 0 });
  };

  const showActual = () => {
    setMode('actual');
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canPan || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
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
    setPan(
      clampPan(
        drag.panX + event.clientX - drag.x,
        drag.panY + event.clientY - drag.y,
        scale,
        natural.w,
        natural.h,
        viewport.w,
        viewport.h,
      ),
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
  };

  const copyImage = async () => {
    const img = imageRef.current;
    if (!img || !decoded || copying || decodeFailed) return;
    setCopying(true);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('clipboard unavailable');
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context || canvas.width === 0 || canvas.height === 0) {
          reject(new Error('encode'));
          return;
        }
        context.drawImage(img, 0, 0);
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('encode'))),
          'image/png',
        );
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
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
                  className={`absolute top-1/2 left-1/2 max-w-none select-none ${decoded ? '' : 'invisible'}`}
                  style={{
                    width: natural.w || undefined,
                    height: natural.h || undefined,
                    transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${scale})`,
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
              <div
                className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive"
                role="alert"
              >
                {failure}
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
