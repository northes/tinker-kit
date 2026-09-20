import {type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState,} from 'react';
import {Dialogs} from '@wailsio/runtime';
import {
    ArrowCounterClockwise,
    ArrowsOut,
    Crop,
    DownloadSimple,
    Image as ImageIcon,
    Trash,
    UploadSimple,
} from '@phosphor-icons/react';
import {useTranslation} from 'react-i18next';

import {SaveBase64File} from '../../bindings/changeme/configservice';
import {
    blobToDataUrl,
    canvasToBlob,
    canvasToIco,
    formatBytes,
    IMAGE_OUTPUT_FORMATS,
    ImageOutputError,
    type ImageOutputFormat,
} from '../lib/image-output';
import {Button} from './ui/button';
import {ScrollArea} from './ui/scroll-area';
import {
    ColorPicker,
    ColorPickerAlphaSlider,
    ColorPickerArea,
    ColorPickerContent,
    ColorPickerEyeDropper,
    ColorPickerFormatSelect,
    ColorPickerHueSlider,
    ColorPickerInput,
    ColorPickerSwatch,
    ColorPickerTrigger,
} from './ui/color-picker';
import {Input} from './ui/input';
import {Label} from './ui/label';
import {Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue} from './ui/select';
import {Slider} from './ui/slider';
import {Switch} from './ui/switch';
import {Toggle} from './ui/toggle';
import {
    type PendingAction,
    Reveal,
    ToolActionBar,
    type ToolId,
    ToolLayout,
    ToolLayoutContent,
    ToolLayoutFooter,
    ToolLayoutHeader,
    useFocusOnActivate,
} from './shared';
import {toast} from './ui/toast';
import FileDropEmpty, {readLocalFile, useFileDrop} from './fileDrop';
import './ImageTool.css';

type SizeMode = 'crop' | 'expand';
type Rect = { x: number; y: number; w: number; h: number };
type Fit = Rect & { scale: number };
type EdgeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'se' | 'sw';
type ExpandCanvas = { width: number; height: number; imageX: number; imageY: number };
type SizeSession =
    | { mode: 'crop'; sizeMode: SizeMode; crop: Rect }
    | {
    mode: 'expand';
    sizeMode: SizeMode;
    expand: ExpandCanvas;
    fillTransparent: boolean;
    fillColor: string;
};
type SourceImage = { name: string; mime: string; dataUrl: string; width: number; height: number };

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT = 8192;
const MIN_CROP = 8;
const OPEN_PATTERN = '*.png;*.jpg;*.jpeg;*.svg;*.webp';
const OUTPUT_FORMATS: ImageOutputFormat[] = ['jpg', 'png', 'webp', 'ico', 'svg'];
const FORMAT_LABEL_KEY: Record<ImageOutputFormat, string> = {
    jpg: 'imageTool.formatJpg',
    png: 'imageTool.formatPng',
    webp: 'imageTool.formatWebp',
    ico: 'imageTool.formatIco',
    svg: 'imageTool.formatSvg',
};
const FORMAT_FILTER_KEY: Record<ImageOutputFormat, string> = {
    jpg: 'imageTool.filterJpg',
    png: 'imageTool.filterPng',
    webp: 'imageTool.filterWebp',
    ico: 'imageTool.filterIco',
    svg: 'imageTool.filterSvg',
};
const EDGE_HANDLES: EdgeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<EdgeHandle, string> = {
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
};
const HANDLE_POS: Record<EdgeHandle, { left: string; top: string }> = {
    nw: {left: '0%', top: '0%'},
    n: {left: '50%', top: '0%'},
    ne: {left: '100%', top: '0%'},
    e: {left: '100%', top: '50%'},
    se: {left: '100%', top: '100%'},
    s: {left: '50%', top: '100%'},
    sw: {left: '0%', top: '100%'},
    w: {left: '0%', top: '50%'},
};
const HANDLE_KEY: Record<EdgeHandle, string> = {
    nw: 'imageTool.handleNw',
    n: 'imageTool.handleN',
    ne: 'imageTool.handleNe',
    e: 'imageTool.handleE',
    se: 'imageTool.handleSe',
    s: 'imageTool.handleS',
    sw: 'imageTool.handleSw',
    w: 'imageTool.handleW',
};

function clamp(n: number, min: number, max: number) {
    return Math.min(max, Math.max(min, n));
}

function basename(path: string) {
    return path.replace(/^.*[/\\]/, '') || path;
}

function mimeFromName(name: string) {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'webp') return 'image/webp';
    return '';
}

function isSupportedName(name: string, mime = '') {
    return Boolean(
        mimeFromName(name) || /^(image\/png|image\/jpeg|image\/svg\+xml|image\/webp)$/.test(mime),
    );
}

function isSvgSource(image: SourceImage) {
    return image.mime === 'image/svg+xml' || mimeFromName(image.name) === 'image/svg+xml';
}

function sourceFormatOf(image: SourceImage): Exclude<ImageOutputFormat, 'ico'> | '' {
    const mime = image.mime || mimeFromName(image.name);
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/svg+xml') return 'svg';
    return '';
}

function defaultOutputFormat(image: SourceImage): ImageOutputFormat {
    const format = sourceFormatOf(image);
    return format || 'png';
}

function isUneditedGeometry(image: SourceImage, crop: Rect, expand: ExpandCanvas) {
    return (
        crop.x === 0 &&
        crop.y === 0 &&
        Math.round(crop.w) === image.width &&
        Math.round(crop.h) === image.height &&
        expand.width === image.width &&
        expand.height === image.height &&
        expand.imageX === 0 &&
        expand.imageY === 0
    );
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return new Uint8Array();
    const header = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    if (/;base64/i.test(header)) {
        const binary = atob(payload.replace(/\s/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    try {
        return new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
        return new TextEncoder().encode(payload);
    }
}

function flattenCanvas(source: HTMLCanvasElement, color: string) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ctx');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);
    return canvas;
}

function blobQuality(quality: number) {
    return clamp(quality, 1, 100) / 100;
}

function isWebpUnsupported(error: unknown) {
    return (
        error instanceof ImageOutputError &&
        (error.code === 'invalidBlobType' ||
            error.code === 'encodingFailed' ||
            error.code === 'unsupportedFormat')
    );
}

function loadHtmlImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('load'));
        img.src = src;
    });
}

function fitContain(srcW: number, srcH: number, boxW: number, boxH: number, pad = 20): Fit {
    const availW = Math.max(0, boxW - pad * 2);
    const availH = Math.max(0, boxH - pad * 2);
    if (availW <= 0 || availH <= 0 || srcW <= 0 || srcH <= 0)
        return {x: 0, y: 0, w: 0, h: 0, scale: 1};
    const scale = Math.min(availW / srcW, availH / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return {x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale};
}

function pointInFit(clientX: number, clientY: number, origin: DOMRect, fit: Fit) {
    return {
        x: (clientX - origin.left - fit.x) / fit.scale,
        y: (clientY - origin.top - fit.y) / fit.scale,
    };
}

function fromPoints(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    maxW: number,
    maxH: number,
): Rect {
    const x = clamp(Math.min(x0, x1), 0, Math.max(0, maxW - 1));
    const y = clamp(Math.min(y0, y1), 0, Math.max(0, maxH - 1));
    const r = clamp(Math.max(x0, x1), x + 1, maxW);
    const b = clamp(Math.max(y0, y1), y + 1, maxH);
    return {x, y, w: Math.max(1, r - x), h: Math.max(1, b - y)};
}

function resizeRect(
    rect: Rect,
    handle: EdgeHandle,
    x: number,
    y: number,
    maxW: number,
    maxH: number,
): Rect {
    let {x: rx, y: ry, w, h} = rect;
    const right = rx + w;
    const bottom = ry + h;
    if (handle.includes('w')) rx = clamp(x, 0, right - MIN_CROP);
    if (handle.includes('n')) ry = clamp(y, 0, bottom - MIN_CROP);
    if (handle.includes('e')) w = clamp(x, rx + MIN_CROP, maxW) - rx;
    if (handle.includes('s')) h = clamp(y, ry + MIN_CROP, maxH) - ry;
    if (handle.includes('w')) w = right - rx;
    if (handle.includes('n')) h = bottom - ry;
    return {x: rx, y: ry, w: Math.max(1, w), h: Math.max(1, h)};
}

function moveRect(rect: Rect, dx: number, dy: number, maxW: number, maxH: number): Rect {
    return {
        x: clamp(rect.x + dx, 0, Math.max(0, maxW - rect.w)),
        y: clamp(rect.y + dy, 0, Math.max(0, maxH - rect.h)),
        w: rect.w,
        h: rect.h,
    };
}

function outputSize(image: SourceImage, mode: SizeMode, crop: Rect, expand: ExpandCanvas) {
    if (mode === 'crop')
        return {w: Math.max(1, Math.round(crop.w)), h: Math.max(1, Math.round(crop.h))};
    return {w: expand.width, h: expand.height};
}

function clampExpand(next: ExpandCanvas, imgW: number, imgH: number): ExpandCanvas {
    const width = clamp(Math.round(next.width), imgW, MAX_OUTPUT);
    const height = clamp(Math.round(next.height), imgH, MAX_OUTPUT);
    return {
        width,
        height,
        imageX: clamp(Math.round(next.imageX), 0, width - imgW),
        imageY: clamp(Math.round(next.imageY), 0, height - imgH),
    };
}

async function renderComposite(args: {
    source: SourceImage;
    sizeMode: SizeMode;
    crop: Rect;
    expand: ExpandCanvas;
    fillTransparent: boolean;
    fillColor: string;
}) {
    const img = await loadHtmlImage(args.source.dataUrl);
    const cropRect =
        args.sizeMode === 'crop'
            ? args.crop
            : {x: 0, y: 0, w: args.source.width, h: args.source.height};
    const placed =
        args.sizeMode === 'expand'
            ? clampExpand(args.expand, args.source.width, args.source.height)
            : {width: cropRect.w, height: cropRect.h, imageX: 0, imageY: 0};
    const width = Math.max(1, Math.round(placed.width));
    const height = Math.max(1, Math.round(placed.height));
    if (width > MAX_OUTPUT || height > MAX_OUTPUT) throw new Error('size');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ctx');
    if (args.sizeMode === 'expand') {
        if (args.fillTransparent) ctx.clearRect(0, 0, width, height);
        else {
            ctx.fillStyle = args.fillColor;
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(
            img,
            0,
            0,
            args.source.width,
            args.source.height,
            placed.imageX,
            placed.imageY,
            args.source.width,
            args.source.height,
        );
    } else {
        ctx.drawImage(
            img,
            cropRect.x,
            cropRect.y,
            cropRect.w,
            cropRect.h,
            0,
            0,
            cropRect.w,
            cropRect.h,
        );
    }
    return canvas;
}

async function encodeRasterBlob(
    canvas: HTMLCanvasElement,
    format: Exclude<ImageOutputFormat, 'svg'>,
    quality: number,
    flattenColor: string,
) {
    if (format === 'ico') return canvasToIco(canvas);
    if (format === 'jpg') {
        return canvasToBlob(flattenCanvas(canvas, flattenColor), 'jpg', blobQuality(quality));
    }
    return canvasToBlob(canvas, format, blobQuality(quality));
}

type Session = {
    pointerId: number;
    target: Element;
    onMove: (event: PointerEvent) => void;
    onEnd: (canceled: boolean) => void;
};

function usePointerSession() {
    const session = useRef<Session | null>(null);
    const stopRef = useRef<(canceled: boolean) => void>(() => {
    });
    const [dragging, setDragging] = useState(false);
    const handleMove = useRef((event: PointerEvent) => {
        const current = session.current;
        if (!current || event.pointerId !== current.pointerId) return;
        current.onMove(event);
    }).current;
    const handleUp = useRef((event: PointerEvent) => {
        if (session.current && event.pointerId === session.current.pointerId) stopRef.current(false);
    }).current;
    const handleCancel = useRef((event: PointerEvent) => {
        if (session.current && event.pointerId === session.current.pointerId) stopRef.current(true);
    }).current;
    const handleBlur = useRef(() => stopRef.current(true)).current;
    const handleHidden = useRef(() => {
        if (document.hidden) stopRef.current(true);
    }).current;

    const stop = useCallback(
        (canceled: boolean) => {
            const current = session.current;
            if (!current) return;
            session.current = null;
            setDragging(false);
            try {
                if (current.target.hasPointerCapture(current.pointerId))
                    current.target.releasePointerCapture(current.pointerId);
            } catch {
                /* already released */
            }
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleCancel);
            window.removeEventListener('blur', handleBlur);
            document.removeEventListener('visibilitychange', handleHidden);
            current.onEnd(canceled);
        },
        [handleBlur, handleCancel, handleHidden, handleMove, handleUp],
    );

    stopRef.current = stop;

    useEffect(() => () => stop(true), [stop]);

    const start = useCallback(
        (
            event: ReactPointerEvent,
            onMoveFn: (e: PointerEvent) => void,
            onEnd: (canceled: boolean) => void,
        ) => {
            stop(true);
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            session.current = {
                pointerId: event.pointerId,
                target: event.currentTarget,
                onMove: onMoveFn,
                onEnd,
            };
            setDragging(true);
            window.addEventListener('pointermove', handleMove);
            window.addEventListener('pointerup', handleUp);
            window.addEventListener('pointercancel', handleCancel);
            window.addEventListener('blur', handleBlur);
            document.addEventListener('visibilitychange', handleHidden);
        },
        [handleBlur, handleCancel, handleHidden, handleMove, handleUp, stop],
    );

    return {start, stop, dragging};
}

export default function ImageTool({
                                      active,
                                      record,
                                      pending,
                                      clearPending,
                                  }: {
    active: boolean;
    record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
    pending: PendingAction | null;
    clearPending: () => void;
}) {
    const {t} = useTranslation();
    const consumed = useRef<PendingAction | null>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const emptyRef = useRef<HTMLButtonElement>(null);
    const pointer = usePointerSession();
    const [source, setSource] = useState<SourceImage | null>(null);
    const [sizeMode, setSizeMode] = useState<SizeMode>('crop');
    const [crop, setCrop] = useState<Rect>({x: 0, y: 0, w: 1, h: 1});
    const [expand, setExpand] = useState<ExpandCanvas>({width: 1, height: 1, imageX: 0, imageY: 0});
    const [fillTransparent, setFillTransparent] = useState(true);
    const [fillColor, setFillColor] = useState('#ffffff');
    const [quality, setQuality] = useState(92);
    const [targetSize, setTargetSize] = useState('');
    const [compressing, setCompressing] = useState(false);
    const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>('png');
    const [imageSelected, setImageSelected] = useState(false);
    const [sizeInput, setSizeInput] = useState({w: '', h: ''});
    const sizeInputFocus = useRef<'w' | 'h' | null>(null);
    const [pane, setPane] = useState({w: 0, h: 0});
    const pathLoaderRef = useRef<(path: string) => void>(() => {
    });
    const fileDrop = useFileDrop({
        id: 'image-drop-zone',
        enabled: active,
        pick: {
            Title: t('imageTool.openTitle'),
            ButtonText: t('imageTool.open'),
            Filters: [{DisplayName: t('imageTool.filterImages'), Pattern: OPEN_PATTERN}],
        },
        onPaths: (paths) => {
            const path = paths[0];
            if (path) pathLoaderRef.current(path);
        },
        onError: () => toast.add({title: t('imageTool.loadFailed'), type: 'error'}),
    });
    const over = fileDrop.over;
    const [sizeSession, setSizeSession] = useState<SizeSession | null>(null);
    const [encodedOutput, setEncodedOutput] = useState<{
        key: string;
        bytes: number;
        url: string | null;
        error: 'webp' | 'failed' | null;
    } | null>(null);
    const encodedUrlRef = useRef<string | null>(null);
    const encodeTaskRef = useRef(0);
    const exportRef = useRef<() => Promise<void>>(async () => {
    });
    const compressRef = useRef<() => Promise<void>>(async () => {
    });
    const cropEditing = sizeSession?.mode === 'crop';
    const expandEditing = sizeSession?.mode === 'expand';
    const svgAllowed = Boolean(
        source && isSvgSource(source) && isUneditedGeometry(source, crop, expand),
    );
    const sourceBytes = useMemo(
        () => (source ? dataUrlToBytes(source.dataUrl).byteLength : 0),
        [source],
    );
    const sourceFormat = source ? sourceFormatOf(source) : '';
    const jpgFlattenColor = sizeMode === 'expand' && !fillTransparent ? fillColor : '#ffffff';
    const showQuality = outputFormat === 'jpg' || outputFormat === 'webp';

    useFocusOnActivate(active, () => {
        if (source) previewRef.current?.focus();
        else emptyRef.current?.focus();
    });

    useEffect(() => {
        const el = previewRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect) setPane({w: rect.width, h: rect.height});
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [source]);

    const out = source ? outputSize(source, sizeMode, crop, expand) : {w: 0, h: 0};
    const fit = useMemo(
        () =>
            source
                ? sizeMode === 'crop' && cropEditing
                    ? fitContain(source.width, source.height, pane.w, pane.h)
                    : fitContain(out.w, out.h, pane.w, pane.h)
                : {x: 0, y: 0, w: 0, h: 0, scale: 1},
        [source, sizeMode, cropEditing, pane.w, pane.h, out.w, out.h],
    );

    const outputKey = source
        ? [
            source.dataUrl,
            sizeMode,
            crop.x,
            crop.y,
            crop.w,
            crop.h,
            expand.width,
            expand.height,
            expand.imageX,
            expand.imageY,
            fillTransparent ? '1' : '0',
            fillColor,
            quality,
            outputFormat,
            jpgFlattenColor,
        ].join('|')
        : '';

    const replaceEncodedOutput = useCallback(
        (
            next: {
                key: string;
                bytes: number;
                url: string | null;
                error: 'webp' | 'failed' | null;
            } | null,
        ) => {
            const nextUrl = next?.url ?? null;
            if (encodedUrlRef.current && encodedUrlRef.current !== nextUrl)
                URL.revokeObjectURL(encodedUrlRef.current);
            encodedUrlRef.current = nextUrl;
            setEncodedOutput(next);
        },
        [],
    );

    const invalidateEncodedOutput = useCallback(() => {
        encodeTaskRef.current += 1;
        replaceEncodedOutput(null);
    }, [replaceEncodedOutput]);

    const startGeometry = (
        event: ReactPointerEvent,
        onMoveFn: (e: PointerEvent) => void,
        onEnd: (canceled: boolean) => void,
    ) => {
        invalidateEncodedOutput();
        pointer.start(event, onMoveFn, onEnd);
    };

    const resetImage = useCallback(
        (next: SourceImage | null) => {
            pointer.stop(true);
            invalidateEncodedOutput();
            setSource(next);
            setSizeMode('crop');
            setCrop(next ? {x: 0, y: 0, w: next.width, h: next.height} : {x: 0, y: 0, w: 1, h: 1});
            setExpand(
                next
                    ? {width: next.width, height: next.height, imageX: 0, imageY: 0}
                    : {width: 1, height: 1, imageX: 0, imageY: 0},
            );
            setFillTransparent(true);
            setFillColor('#ffffff');
            setQuality(92);
            setOutputFormat(next ? defaultOutputFormat(next) : 'png');
            setImageSelected(false);
            fileDrop.clear();
            setSizeSession(null);
        },
        [fileDrop.clear, invalidateEncodedOutput, pointer.stop],
    );

    const clearSelection = () => {
        setImageSelected(false);
    };

    const applyLoaded = useCallback(
        async (dataUrl: string, name: string, mime: string) => {
            try {
                const img = await loadHtmlImage(dataUrl);
                const width = img.naturalWidth || img.width || 1;
                const height = img.naturalHeight || img.height || 1;
                resetImage({
                    name,
                    mime: mime || mimeFromName(name) || 'image/png',
                    dataUrl,
                    width,
                    height,
                });
            } catch {
                toast.add({title: t('imageTool.loadFailed'), type: 'error'});
            }
        },
        [resetImage, t],
    );

    const loadPath = useCallback(
        async (path: string) => {
            const name = basename(path);
            if (!isSupportedName(name)) {
                toast.add({title: t('imageTool.unsupported'), type: 'warning'});
                return;
            }
            try {
                const data = await readLocalFile(path, MAX_BYTES);
                await applyLoaded(data.dataURL, data.name, data.mimeType);
            } catch {
                toast.add({title: t('imageTool.loadFailed'), type: 'error'});
            }
        },
        [applyLoaded, t],
    );
    pathLoaderRef.current = loadPath;

    useEffect(() => {
        if (outputFormat === 'svg' && !svgAllowed) setOutputFormat('png');
    }, [outputFormat, svgAllowed]);

    useEffect(() => {
        if (!source) {
            replaceEncodedOutput(null);
            return;
        }
        if (pointer.dragging) return;
        const task = ++encodeTaskRef.current;
        const key = outputKey;
        let cancelled = false;
        void (async () => {
            try {
                if (outputFormat === 'svg') {
                    if (!svgAllowed) throw new ImageOutputError('unsupportedFormat');
                    if (cancelled || task !== encodeTaskRef.current) return;
                    replaceEncodedOutput({key, bytes: sourceBytes, url: null, error: null});
                    return;
                }
                const canvas = await renderComposite({
                    source,
                    sizeMode,
                    crop,
                    expand,
                    fillTransparent,
                    fillColor,
                });
                if (cancelled || task !== encodeTaskRef.current) return;
                const blob = await encodeRasterBlob(canvas, outputFormat, quality, jpgFlattenColor);
                if (cancelled || task !== encodeTaskRef.current) return;
                let url: string | null = null;
                if (outputFormat === 'jpg' || outputFormat === 'webp') {
                    url = URL.createObjectURL(blob);
                    await loadHtmlImage(url);
                    if (cancelled || task !== encodeTaskRef.current) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                }
                replaceEncodedOutput({key, bytes: blob.size, url, error: null});
            } catch (error) {
                if (cancelled || task !== encodeTaskRef.current) return;
                replaceEncodedOutput({
                    key,
                    bytes: 0,
                    url: null,
                    error: outputFormat === 'webp' && isWebpUnsupported(error) ? 'webp' : 'failed',
                });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [
        source,
        pointer.dragging,
        outputKey,
        outputFormat,
        svgAllowed,
        sourceBytes,
        sizeMode,
        crop,
        expand,
        fillTransparent,
        fillColor,
        quality,
        jpgFlattenColor,
        replaceEncodedOutput,
    ]);

    useEffect(
        () => () => {
            if (encodedUrlRef.current) URL.revokeObjectURL(encodedUrlRef.current);
        },
        [],
    );

    const exportImage = async () => {
        if (sizeSession || pointer.dragging) return;
        if (!source) {
            toast.add({title: t('imageTool.noImage'), type: 'warning'});
            return;
        }
        const format = outputFormat === 'svg' && !svgAllowed ? 'png' : outputFormat;
        try {
            let dataUrl: string;
            let width = out.w;
            let height = out.h;
            if (format === 'svg') {
                const bytes = dataUrlToBytes(source.dataUrl);
                const buffer = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buffer).set(bytes);
                const blob = new Blob([buffer], {type: IMAGE_OUTPUT_FORMATS.svg.mime});
                dataUrl = await blobToDataUrl(blob);
                width = source.width;
                height = source.height;
            } else {
                const canvas = await renderComposite({
                    source,
                    sizeMode,
                    crop,
                    expand,
                    fillTransparent,
                    fillColor,
                });
                width = canvas.width;
                height = canvas.height;
                const blob = await encodeRasterBlob(canvas, format, quality, jpgFlattenColor);
                dataUrl = await blobToDataUrl(blob);
            }
            const info = IMAGE_OUTPUT_FORMATS[format];
            const base = source.name.replace(/\.[^.]+$/, '') || 'image';
            const filename =
                format === 'svg' ? `${base}.${info.extension}` : `${base}-edited.${info.extension}`;
            const pattern = format === 'jpg' ? '*.jpg;*.jpeg' : `*.${info.extension}`;
            const path = await Dialogs.SaveFile({
                Title: t('imageTool.exportTitle'),
                Filename: filename,
                ButtonText: t('imageTool.save'),
                CanCreateDirectories: true,
                Filters: [{DisplayName: t(FORMAT_FILTER_KEY[format]), Pattern: pattern}],
            });
            if (!path) return;
            await SaveBase64File(path, dataUrl);
            const detail = t('imageTool.dimensions', {width, height});
            record('image', t('imageTool.export'), detail, source.name, filename);
            toast.add({title: t('imageTool.exported')});
        } catch (error) {
            toast.add({
                title:
                    format === 'webp' && isWebpUnsupported(error)
                        ? t('imageTool.webpUnsupported')
                        : t('imageTool.exportFailed'),
                type: 'error',
            });
        }
    };
    exportRef.current = exportImage;

    // 二分查找不超目标大小的最大质量；质量单调影响体积，仅对有损格式生效。
    const compressToTarget = async () => {
        if (compressing) return;
        if (!source) {
            toast.add({title: t('imageTool.noImage'), type: 'warning'});
            return;
        }
        if (sizeSession || pointer.dragging) return;
        if (outputFormat !== 'jpg' && outputFormat !== 'webp') return;
        const kb = Math.round(Number(targetSize));
        if (!Number.isFinite(kb) || kb <= 0) {
            toast.add({title: t('imageTool.compressTargetInvalid'), type: 'warning'});
            return;
        }
        const targetBytes = kb * 1024;
        setCompressing(true);
        try {
            const canvas = await renderComposite({
                source,
                sizeMode,
                crop,
                expand,
                fillTransparent,
                fillColor,
            });
            let lo = 1;
            let hi = 100;
            let bestQuality = -1;
            let bestBytes = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const blob = await encodeRasterBlob(canvas, outputFormat, mid, jpgFlattenColor);
                if (blob.size <= targetBytes) {
                    bestQuality = mid;
                    bestBytes = blob.size;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            if (bestQuality < 0) {
                toast.add({title: t('imageTool.compressTooLarge'), type: 'warning'});
                return;
            }
            setQuality(bestQuality);
            record('image', t('imageTool.compress'), formatBytes(bestBytes), source.name);
            toast.add({title: t('imageTool.compressDone', {quality: bestQuality})});
        } catch (error) {
            toast.add({
                title:
                    outputFormat === 'webp' && isWebpUnsupported(error)
                        ? t('imageTool.webpUnsupported')
                        : t('imageTool.compressFailed'),
                type: 'error',
            });
        } finally {
            setCompressing(false);
        }
    };
    compressRef.current = compressToTarget;

    useEffect(() => {
        if (!pending || pending.tool !== 'image' || consumed.current === pending) return;
        consumed.current = pending;
        clearPending();
        if (pending.action === 'clear') {
            resetImage(null);
            return;
        }
        if (pending.action === 'export') {
            void exportRef.current();
            return;
        }
        if (pending.action === 'compress') {
            void compressRef.current();
        }
    }, [pending, clearPending]);

    useEffect(() => {
        if (!out.w || !out.h) return;
        setSizeInput((current) => ({
            w: sizeInputFocus.current === 'w' ? current.w : String(out.w),
            h: sizeInputFocus.current === 'h' ? current.h : String(out.h),
        }));
    }, [out.w, out.h]);

    const applySize = () => {
        if (!source || !sizeSession) return;
        const nextW = clamp(Math.round(Number(sizeInput.w) || 0), MIN_CROP, MAX_OUTPUT);
        const nextH = clamp(Math.round(Number(sizeInput.h) || 0), MIN_CROP, MAX_OUTPUT);
        if (sizeSession.mode === 'crop') {
            const w = clamp(nextW, MIN_CROP, source.width);
            const h = clamp(nextH, MIN_CROP, source.height);
            setCrop({
                x: clamp(crop.x, 0, source.width - w),
                y: clamp(crop.y, 0, source.height - h),
                w,
                h,
            });
            setSizeInput({w: String(w), h: String(h)});
            return;
        }
        const next = clampExpand(
            {...expand, width: Math.max(nextW, source.width), height: Math.max(nextH, source.height)},
            source.width,
            source.height,
        );
        setExpand(next);
        setSizeInput({w: String(next.width), h: String(next.height)});
    };

    const focusSizeInput = (field: 'w' | 'h') => {
        sizeInputFocus.current = field;
    };

    const blurSizeInput = () => {
        sizeInputFocus.current = null;
        applySize();
    };

    const beginSizeEdit = (mode: SizeMode) => {
        if (!source) return;
        if (sizeSession?.mode === mode) return;
        pointer.stop(true);
        invalidateEncodedOutput();

        let prevSizeMode = sizeMode;
        let prevCrop = crop;
        let prevExpand = expand;
        let prevFillTransparent = fillTransparent;
        let prevFillColor = fillColor;
        if (sizeSession?.mode === 'crop') {
            prevSizeMode = sizeSession.sizeMode;
            prevCrop = sizeSession.crop;
            setCrop(sizeSession.crop);
        } else if (sizeSession?.mode === 'expand') {
            prevSizeMode = sizeSession.sizeMode;
            prevExpand = sizeSession.expand;
            prevFillTransparent = sizeSession.fillTransparent;
            prevFillColor = sizeSession.fillColor;
            setExpand(sizeSession.expand);
            setFillTransparent(sizeSession.fillTransparent);
            setFillColor(sizeSession.fillColor);
        }

        setSizeMode(mode);
        setImageSelected(false);
        if (mode === 'crop') {
            setSizeSession({mode: 'crop', sizeMode: prevSizeMode, crop: {...prevCrop}});
            return;
        }
        setSizeSession({
            mode: 'expand',
            sizeMode: prevSizeMode,
            expand: {...prevExpand},
            fillTransparent: prevFillTransparent,
            fillColor: prevFillColor,
        });
    };

    const commitSizeEdit = () => {
        pointer.stop(false);
        setSizeSession(null);
        setImageSelected(false);
    };

    const cancelSizeEdit = () => {
        if (!sizeSession) return;
        pointer.stop(true);
        setSizeMode(sizeSession.sizeMode);
        if (sizeSession.mode === 'crop') setCrop(sizeSession.crop);
        else {
            setExpand(sizeSession.expand);
            setFillTransparent(sizeSession.fillTransparent);
            setFillColor(sizeSession.fillColor);
        }
        setSizeSession(null);
        setImageSelected(false);
    };

    const stagePoint = (event: PointerEvent, origin: DOMRect, snapped: Fit) =>
        pointInFit(event.clientX, event.clientY, origin, snapped);

    const beginCropDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!source || !cropEditing) return;
        const origin = event.currentTarget.getBoundingClientRect();
        const snapped = {...fit};
        const start = stagePoint(event.nativeEvent, origin, snapped);
        const prev = crop;
        const live = {...prev};
        clearSelection();
        startGeometry(
            event,
            (move) => {
                const p = stagePoint(move, origin, snapped);
                live.w = Math.abs(p.x - start.x);
                live.h = Math.abs(p.y - start.y);
                setCrop(fromPoints(start.x, start.y, p.x, p.y, source.width, source.height));
            },
            (canceled) => {
                if (canceled || live.w < 2 || live.h < 2) setCrop(prev);
            },
        );
    };

    const beginCropMove = (event: ReactPointerEvent) => {
        if (!source || !cropEditing) return;
        event.stopPropagation();
        const origin = previewRef.current?.getBoundingClientRect();
        if (!origin) return;
        const snapped = {...fit};
        const start = stagePoint(event.nativeEvent, origin, snapped);
        const prev = crop;
        clearSelection();
        startGeometry(
            event,
            (move) => {
                const p = stagePoint(move, origin, snapped);
                setCrop(moveRect(prev, p.x - start.x, p.y - start.y, source.width, source.height));
            },
            (canceled) => {
                if (canceled) setCrop(prev);
            },
        );
    };

    const beginCropResize = (event: ReactPointerEvent, handle: EdgeHandle) => {
        if (!source || !cropEditing) return;
        event.stopPropagation();
        const origin = previewRef.current?.getBoundingClientRect();
        if (!origin) return;
        const snapped = {...fit};
        const prev = crop;
        startGeometry(
            event,
            (move) => {
                const p = stagePoint(move, origin, snapped);
                setCrop(resizeRect(prev, handle, p.x, p.y, source.width, source.height));
            },
            (canceled) => {
                if (canceled) setCrop(prev);
            },
        );
    };

    const beginExpand = (event: ReactPointerEvent, handle: EdgeHandle) => {
        if (!source || !expandEditing) return;
        event.stopPropagation();
        const origin = previewRef.current?.getBoundingClientRect();
        if (!origin) return;
        const snapped = {...fit};
        const prev = expand;
        startGeometry(
            event,
            (move) => {
                const p = stagePoint(move, origin, snapped);
                const next = {...prev};
                if (handle.includes('e')) next.width = p.x;
                if (handle.includes('s')) next.height = p.y;
                if (handle.includes('w')) {
                    next.width = prev.width - p.x;
                    next.imageX = prev.imageX - p.x;
                }
                if (handle.includes('n')) {
                    next.height = prev.height - p.y;
                    next.imageY = prev.imageY - p.y;
                }
                setExpand(clampExpand(next, source.width, source.height));
            },
            (canceled) => {
                if (canceled) setExpand(prev);
            },
        );
    };

    const beginImageMove = (event: ReactPointerEvent) => {
        if (!source || !expandEditing) return;
        event.stopPropagation();
        const origin = previewRef.current?.getBoundingClientRect();
        if (!origin) return;
        const snapped = {...fit};
        const start = stagePoint(event.nativeEvent, origin, snapped);
        const prev = expand;
        setImageSelected(true);
        startGeometry(
            event,
            (move) => {
                const p = stagePoint(move, origin, snapped);
                setExpand(
                    clampExpand(
                        {
                            ...prev,
                            imageX: prev.imageX + p.x - start.x,
                            imageY: prev.imageY + p.y - start.y,
                        },
                        source.width,
                        source.height,
                    ),
                );
            },
            (canceled) => {
                if (canceled) setExpand(prev);
            },
        );
    };

    const cropStyle =
        source && cropEditing
            ? {
                left: fit.x + crop.x * fit.scale,
                top: fit.y + crop.y * fit.scale,
                width: crop.w * fit.scale,
                height: crop.h * fit.scale,
            }
            : null;
    const canvasStyle =
        source && (sizeMode === 'expand' || (sizeMode === 'crop' && !cropEditing))
            ? {left: fit.x, top: fit.y, width: fit.w, height: fit.h}
            : null;
    const imageStyle =
        source && sizeMode === 'expand'
            ? {
                left: expand.imageX * fit.scale,
                top: expand.imageY * fit.scale,
                width: source.width * fit.scale,
                height: source.height * fit.scale,
            }
            : source && cropEditing
                ? {left: fit.x, top: fit.y, width: fit.w, height: fit.h}
                : source && sizeMode === 'crop'
                    ? {
                        left: -crop.x * fit.scale,
                        top: -crop.y * fit.scale,
                        width: source.width * fit.scale,
                        height: source.height * fit.scale,
                    }
                    : null;

    const showEncodedPreview = Boolean(
        source &&
        encodedOutput &&
        encodedOutput.url &&
        encodedOutput.key === outputKey &&
        (outputFormat === 'jpg' || outputFormat === 'webp') &&
        !sizeSession &&
        !pointer.dragging,
    );

    const formatItems = OUTPUT_FORMATS.map((format) => ({
        value: format,
        label: t(FORMAT_LABEL_KEY[format]),
    }));

    const outputSizeText = !source
        ? t('imageTool.infoEmpty')
        : encodedOutput?.key !== outputKey
            ? t('imageTool.outputSizePending')
            : encodedOutput.error === 'webp'
                ? t('imageTool.webpUnsupported')
                : encodedOutput.error
                    ? t('imageTool.outputSizeUnavailable')
                    : formatBytes(encodedOutput.bytes);

    return (
        <Reveal index={0} fill active={active}>
            <ToolLayout className="image-tool">
                <ToolLayoutHeader title={t('imageTool.title')}/>
                <ToolLayoutContent>
                    <div
                        className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1.2fr)_minmax(228px,0.72fr)] grid-rows-[minmax(0,1fr)] max-[700px]:grid-cols-1 max-[700px]:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="flex h-full min-h-0 min-w-0 flex-col">
                            <div
                                ref={previewRef}
                                tabIndex={source ? 0 : -1}
                                aria-label={t('imageTool.preview')}
                                data-empty={source ? undefined : 'true'}
                                data-over={over ? 'true' : undefined}
                                data-dragging={pointer.dragging ? 'true' : undefined}
                                {...fileDrop.dropProps}
                                className="image-tool-stage relative min-h-0 flex-1 overflow-hidden"
                            >
                                {over ? (
                                    <span className="sr-only" role="status">
                    {t('fileDrop.release')}
                  </span>
                                ) : null}
                                {!source ? (
                                    <FileDropEmpty
                                        icon={ImageIcon}
                                        title={t('imageTool.emptyTitle')}
                                        desc={t('imageTool.emptyHint')}
                                        actionLabel={t('imageTool.chooseFile')}
                                        onChooseFile={() => void fileDrop.pick()}
                                        actionRef={emptyRef}
                                        over={over}
                                        framed={false}
                                        announce={false}
                                    />
                                ) : (
                                    <>
                                        {sizeMode === 'expand' && canvasStyle ? (
                                            <div
                                                className="absolute z-[1]"
                                                style={canvasStyle}
                                                onPointerDown={() => clearSelection()}
                                            >
                                                <div className="absolute inset-0 overflow-hidden">
                                                    <div
                                                        data-fill="true"
                                                        className={`absolute inset-0 ${fillTransparent ? 'image-tool-check' : ''}`}
                                                        style={fillTransparent ? undefined : {backgroundColor: fillColor}}
                                                    />
                                                    {imageStyle ? (
                                                        <img
                                                            src={source.dataUrl}
                                                            alt={source.name}
                                                            draggable={false}
                                                            aria-label={expandEditing ? t('imageTool.moveImage') : undefined}
                                                            data-selected={imageSelected ? 'true' : undefined}
                                                            className={`image-tool-photo absolute max-h-none max-w-none select-none ${expandEditing ? 'cursor-move' : ''} ${showEncodedPreview ? 'opacity-0' : ''}`}
                                                            style={imageStyle}
                                                            onPointerDown={expandEditing ? beginImageMove : undefined}
                                                        />
                                                    ) : null}
                                                    {showEncodedPreview && encodedOutput?.url ? (
                                                        <img
                                                            src={encodedOutput.url}
                                                            alt=""
                                                            aria-hidden
                                                            draggable={false}
                                                            className="pointer-events-none absolute inset-0 max-h-none max-w-none size-full"
                                                        />
                                                    ) : null}
                                                </div>
                                                {expandEditing
                                                    ? EDGE_HANDLES.map((handle) => (
                                                        <button
                                                            key={handle}
                                                            type="button"
                                                            className="image-tool-handle"
                                                            style={{
                                                                ...HANDLE_POS[handle],
                                                                cursor: HANDLE_CURSOR[handle]
                                                            }}
                                                            aria-label={t('imageTool.expandHandle', {
                                                                handle: t(HANDLE_KEY[handle]),
                                                            })}
                                                            onPointerDown={(event) => beginExpand(event, handle)}
                                                        />
                                                    ))
                                                    : null}
                                            </div>
                                        ) : null}
                                        {sizeMode === 'crop' && !cropEditing && canvasStyle ? (
                                            <div className="absolute z-[1] overflow-hidden" style={canvasStyle}>
                                                {imageStyle ? (
                                                    <img
                                                        src={source.dataUrl}
                                                        alt={source.name}
                                                        draggable={false}
                                                        className={`absolute max-h-none max-w-none select-none ${showEncodedPreview ? 'opacity-0' : ''}`}
                                                        style={imageStyle}
                                                    />
                                                ) : null}
                                                {showEncodedPreview && encodedOutput?.url ? (
                                                    <img
                                                        src={encodedOutput.url}
                                                        alt=""
                                                        aria-hidden
                                                        draggable={false}
                                                        className="pointer-events-none absolute inset-0 max-h-none max-w-none size-full"
                                                    />
                                                ) : null}
                                            </div>
                                        ) : null}
                                        {cropEditing && imageStyle ? (
                                            <img
                                                src={source.dataUrl}
                                                alt={source.name}
                                                draggable={false}
                                                className="absolute max-h-none max-w-none select-none"
                                                style={imageStyle}
                                            />
                                        ) : null}
                                        {cropEditing ? (
                                            <div
                                                className="absolute inset-0 z-[1] cursor-crosshair"
                                                onPointerDown={beginCropDraw}
                                            />
                                        ) : null}
                                        {cropStyle ? (
                                            <div
                                                role="group"
                                                aria-label={t('imageTool.moveCrop')}
                                                className="image-tool-crop absolute z-[2] cursor-move border border-primary"
                                                style={cropStyle}
                                                onPointerDown={beginCropMove}
                                            >
                                                {EDGE_HANDLES.map((handle) => (
                                                    <button
                                                        key={handle}
                                                        type="button"
                                                        className="image-tool-handle"
                                                        style={{...HANDLE_POS[handle], cursor: HANDLE_CURSOR[handle]}}
                                                        aria-label={t('imageTool.cropHandle', {
                                                            handle: t(HANDLE_KEY[handle]),
                                                        })}
                                                        onPointerDown={(event) => beginCropResize(event, handle)}
                                                    />
                                                ))}
                                            </div>
                                        ) : null}
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            className="image-tool-replace absolute top-2 right-2 bg-background"
                                            aria-label={t('imageTool.replace')}
                                            onClick={() => void fileDrop.pick()}
                                        >
                                            <UploadSimple weight="duotone"/>
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                        <ScrollArea
                            className="image-tool-controls h-full min-h-0 min-w-0 border-border max-[700px]:border-t min-[701px]:border-l [padding-inline-end:var(--overlay-scrollbar-size)]"
                            options={{ overflow: { x: 'hidden' } }}>
                            <div className="flex min-h-0 flex-col">
                            <div className="flex flex-col gap-2 py-2.5 pl-3 max-[700px]:pl-0">
                                <dl
                                    className="image-tool-meta m-0 flex min-w-0 flex-wrap items-baseline gap-y-0.5 text-[11px] leading-4 text-muted-foreground"
                                    aria-label={t('imageTool.info')}
                                >
                                    {source ? (
                                        <>
                                            <div className="flex min-w-0 items-baseline gap-1">
                                                <dt className="sr-only">{t('imageTool.infoDimensions')}</dt>
                                                <dd className="m-0 min-w-0 truncate tabular-nums">
                                                    {t('imageTool.dimensions', {
                                                        width: source.width,
                                                        height: source.height,
                                                    })}
                                                </dd>
                                            </div>
                                            <div className="flex min-w-0 items-baseline gap-1">
                                                <dt className="sr-only">{t('imageTool.infoFormat')}</dt>
                                                <dd className="m-0 min-w-0 truncate">
                                                    {sourceFormat ? t(FORMAT_LABEL_KEY[sourceFormat]) : t('imageTool.infoEmpty')}
                                                </dd>
                                            </div>
                                            <div className="flex min-w-0 items-baseline gap-1">
                                                <dt className="sr-only">{t('imageTool.infoSize')}</dt>
                                                <dd className="m-0 min-w-0 truncate tabular-nums">
                                                    {formatBytes(sourceBytes)}
                                                </dd>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="flex min-w-0 items-baseline gap-1">
                                            <dt className="sr-only">{t('imageTool.info')}</dt>
                                            <dd className="m-0">{t('imageTool.infoEmpty')}</dd>
                                        </div>
                                    )}
                                </dl>
                                <section
                                    className="flex flex-col gap-2 border-t border-border pt-2.5"
                                    aria-labelledby="image-size-heading"
                                >
                                    <div
                                        className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                                        <h2
                                            id="image-size-heading"
                                            className="m-0 min-w-0 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground"
                                        >
                                            {t('imageTool.size')}
                                        </h2>
                                        <div className="image-tool-size-actions">
                                            <Toggle
                                                size="sm"
                                                className="flex-none"
                                                pressed={sizeSession?.mode === 'crop'}
                                                disabled={!source}
                                                onClick={() => beginSizeEdit('crop')}
                                                onPressedChange={() => beginSizeEdit('crop')}
                                                aria-label={t('imageTool.crop')}
                                            >
                                                <Crop data-icon="inline-start"/>
                                                {t('imageTool.crop')}
                                            </Toggle>
                                            <Toggle
                                                size="sm"
                                                className="flex-none"
                                                pressed={sizeSession?.mode === 'expand'}
                                                disabled={!source}
                                                onClick={() => beginSizeEdit('expand')}
                                                onPressedChange={() => beginSizeEdit('expand')}
                                                aria-label={t('imageTool.expand')}
                                            >
                                                <ArrowsOut data-icon="inline-start"/>
                                                {t('imageTool.expand')}
                                            </Toggle>
                                        </div>
                                    </div>
                                    {sizeSession ? (
                                        <>
                                            <p className="m-0 text-[11px] leading-5 text-muted-foreground"
                                               role="status">
                                                {sizeSession.mode === 'crop'
                                                    ? t('imageTool.cropHint')
                                                    : t('imageTool.expandHint')}
                                            </p>
                                            <div
                                                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-2">
                                                <Label
                                                    htmlFor="image-size-width"
                                                    className="flex-col items-stretch gap-1.5 text-[11px] text-muted-foreground"
                                                >
                                                    {t('imageTool.width')}
                                                    <Input
                                                        id="image-size-width"
                                                        type="number"
                                                        min={1}
                                                        max={MAX_OUTPUT}
                                                        value={sizeInput.w}
                                                        onFocus={() => focusSizeInput('w')}
                                                        onBlur={blurSizeInput}
                                                        onChange={(event) =>
                                                            setSizeInput((current) => ({
                                                                ...current,
                                                                w: event.target.value
                                                            }))
                                                        }
                                                    />
                                                </Label>
                                                <Label
                                                    htmlFor="image-size-height"
                                                    className="flex-col items-stretch gap-1.5 text-[11px] text-muted-foreground"
                                                >
                                                    {t('imageTool.height')}
                                                    <Input
                                                        id="image-size-height"
                                                        type="number"
                                                        min={1}
                                                        max={MAX_OUTPUT}
                                                        value={sizeInput.h}
                                                        onFocus={() => focusSizeInput('h')}
                                                        onBlur={blurSizeInput}
                                                        onChange={(event) =>
                                                            setSizeInput((current) => ({
                                                                ...current,
                                                                h: event.target.value
                                                            }))
                                                        }
                                                    />
                                                </Label>
                                            </div>
                                            {sizeSession.mode === 'expand' ? (
                                                <div
                                                    className="flex flex-col gap-2"
                                                    role="group"
                                                    aria-label={t('imageTool.fill')}
                                                >
                                                    <Label
                                                        htmlFor="image-fill-transparent"
                                                        className="justify-between text-[11px] text-muted-foreground"
                                                    >
                                                        <span>{t('imageTool.fillTransparent')}</span>
                                                        <Switch
                                                            id="image-fill-transparent"
                                                            checked={fillTransparent}
                                                            onCheckedChange={(checked) => setFillTransparent(checked === true)}
                                                            size="sm"
                                                        />
                                                    </Label>
                                                    {!fillTransparent ? (
                                                        <Label
                                                            htmlFor="image-fill-color-label"
                                                            className="justify-between text-[11px] text-muted-foreground"
                                                        >
                                                            <span id="image-fill-color-label" className="min-w-0 truncate">
                                                                {t('imageTool.fillColor')}
                                                            </span>
                                                            <ColorPicker
                                                                value={fillColor}
                                                                onValueChange={setFillColor}
                                                                defaultFormat="hex"
                                                            >
                                                                <ColorPickerTrigger
                                                                    className="px-0 py-0"
                                                                    aria-labelledby="image-fill-color-label"
                                                                    render={<ColorPickerSwatch/>}
                                                                />
                                                                <ColorPickerContent>
                                                                    <ColorPickerArea/>
                                                                    <div className="flex items-center gap-2">
                                                                        <ColorPickerEyeDropper/>
                                                                        <div className="flex flex-1 flex-col gap-2">
                                                                            <ColorPickerHueSlider/>
                                                                            <ColorPickerAlphaSlider/>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-2">
                                                                        <ColorPickerFormatSelect/>
                                                                        <ColorPickerInput/>
                                                                    </div>
                                                                </ColorPickerContent>
                                                            </ColorPicker>
                                                        </Label>
                                                    ) : null}
                                                </div>
                                            ) : null}
                                            <div className="flex flex-wrap justify-end gap-2">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="flex-none"
                                                    onClick={cancelSizeEdit}
                                                >
                                                    {t('imageTool.editCancel')}
                                                </Button>
                                                <Button
                                                    variant="default"
                                                    size="sm"
                                                    className="flex-none"
                                                    onClick={commitSizeEdit}
                                                >
                                                    {t('imageTool.editDone')}
                                                </Button>
                                            </div>
                                        </>
                                    ) : null}
                                </section>
                                <section
                                    className="flex flex-col gap-2 border-t border-border pt-2.5"
                                    aria-labelledby="image-output-heading"
                                >
                                    <h2
                                        id="image-output-heading"
                                        className="m-0 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground"
                                    >
                                        {t('imageTool.output')}
                                    </h2>
                                    <Label
                                        htmlFor="image-output-format"
                                        className="flex-col items-stretch gap-1.5 text-[11px] text-muted-foreground"
                                    >
                                        {t('imageTool.format')}
                                        <Select
                                            items={formatItems}
                                            value={outputFormat}
                                            disabled={!source}
                                            onValueChange={(value) => {
                                                if (
                                                    value === 'jpg' ||
                                                    value === 'png' ||
                                                    value === 'webp' ||
                                                    value === 'ico' ||
                                                    value === 'svg'
                                                ) {
                                                    if (value === 'svg' && !svgAllowed) return;
                                                    setOutputFormat(value);
                                                }
                                            }}
                                        >
                                            <SelectTrigger
                                                id="image-output-format"
                                                size="sm"
                                                className="h-7 w-full min-w-0 text-[11px]"
                                                aria-label={t('imageTool.format')}
                                            >
                                                <SelectValue/>
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectGroup>
                                                    {OUTPUT_FORMATS.map((format) => (
                                                        <SelectItem
                                                            key={format}
                                                            value={format}
                                                            disabled={format === 'svg' && !svgAllowed}
                                                        >
                                                            {t(FORMAT_LABEL_KEY[format])}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            </SelectContent>
                                        </Select>
                                    </Label>
                                    {source && isSvgSource(source) && !svgAllowed ? (
                                        <p className="m-0 text-[11px] leading-5 text-muted-foreground">
                                            {t('imageTool.svgEditedHint')}
                                        </p>
                                    ) : null}
                                    {showQuality ? (
                                        <div className="flex flex-col gap-1.5">
                                            <div
                                                className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                                <span id="image-quality-label">{t('imageTool.quality')}</span>
                                                <span className="tabular-nums">{t('imageTool.qualityValue', {value: quality})}</span>
                                            </div>
                                            <Slider
                                                min={1}
                                                max={100}
                                                step={1}
                                                value={[quality]}
                                                disabled={!source}
                                                aria-labelledby="image-quality-label"
                                                onValueChange={(value) => {
                                                    const next = Array.isArray(value) ? value[0] : value;
                                                    if (typeof next === 'number' && Number.isFinite(next)) setQuality(next);
                                                }}
                                            />
                                            <div
                                                className="flex items-end justify-between gap-2"
                                                role="group"
                                                aria-label={t('imageTool.compress')}
                                            >
                                                <Label
                                                    htmlFor="image-compress-target"
                                                    className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5 text-[11px] text-muted-foreground"
                                                >
                                                    {t('imageTool.compressTarget')}
                                                    <Input
                                                        id="image-compress-target"
                                                        type="number"
                                                        min={1}
                                                        inputMode="numeric"
                                                        placeholder="1024"
                                                        value={targetSize}
                                                        disabled={!source}
                                                        onChange={(event) => setTargetSize(event.target.value)}
                                                    />
                                                </Label>
                                                <div className="flex flex-none flex-col gap-1.5">
                                                    <span className="h-4 text-[11px] text-muted-foreground">KB</span>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-8"
                                                        disabled={!source || compressing || Boolean(sizeSession) || pointer.dragging}
                                                        onClick={() => void compressToTarget()}
                                                    >
                                                        {t('imageTool.compress')}
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    ) : null}
                                    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                        <dt>{t('imageTool.outputDimensions')}</dt>
                                        <dd className="m-0 min-w-0 truncate text-right tabular-nums">
                                            {source
                                                ? t('imageTool.dimensions', {width: out.w, height: out.h})
                                                : t('imageTool.infoEmpty')}
                                        </dd>
                                        <dt>{t('imageTool.outputSize')}</dt>
                                        <dd className="m-0 min-w-0 truncate text-right tabular-nums" role="status" aria-live="polite">
                                            {outputSizeText}
                                        </dd>
                                    </dl>
                                </section>
                            </div>
                            </div>
                        </ScrollArea>
                    </div>
                </ToolLayoutContent>
                <ToolLayoutFooter>
                    <ToolActionBar
                        label={t('imageTool.actions')}
                        actions={[
                            {
                                key: 'clear',
                                label: t('imageTool.clear'),
                                icon: Trash,
                                variant: 'tertiary',
                                disabled: !source,
                                onPress: () => resetImage(null),
                            },
                            {
                                key: 'restore',
                                label: t('imageTool.restore'),
                                icon: ArrowCounterClockwise,
                                variant: 'tertiary',
                                disabled: !source,
                                onPress: () => {
                                    if (source) resetImage(source);
                                },
                            },
                            {
                                key: 'export',
                                label: t('imageTool.export'),
                                icon: DownloadSimple,
                                variant: 'primary',
                                disabled: !source || Boolean(sizeSession) || pointer.dragging,
                                onPress: () => void exportImage(),
                            },
                        ]}
                    />
                </ToolLayoutFooter>
            </ToolLayout>
        </Reveal>
    );
}
