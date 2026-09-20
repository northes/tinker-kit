import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type Ref,
} from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Dialogs, Events } from '@wailsio/runtime';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import type { Icon } from './shared';
import { ReadFile } from '../../bindings/changeme/fileservice';
import type { LocalFile } from '../../bindings/changeme/models';
import './fileDrop.css';

export type LocalFilePickOptions = {
  Title?: string;
  ButtonText?: string;
  Filters?: { DisplayName: string; Pattern: string }[];
  CanChooseFiles?: boolean;
  CanChooseDirectories?: boolean;
  AllowsMultipleSelection?: boolean;
  AllowsOtherFiletypes?: boolean;
  ShowHiddenFiles?: boolean;
};

export function hasFileTransfer(dataTransfer: DataTransfer | null) {
  return Boolean(
    dataTransfer && (dataTransfer.types.includes('Files') || dataTransfer.files.length),
  );
}

export function useFileDragOver({ enabled = true }: { enabled?: boolean } = {}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const leaveFrame = useRef<number | null>(null);

  const cancelLeave = useCallback(() => {
    if (leaveFrame.current == null) return;
    cancelAnimationFrame(leaveFrame.current);
    leaveFrame.current = null;
  }, []);

  const clear = useCallback(() => {
    cancelLeave();
    depth.current = 0;
    setOver(false);
  }, [cancelLeave]);

  useEffect(() => {
    if (!enabled) {
      clear();
      return;
    }
    window.addEventListener('drop', clear);
    window.addEventListener('dragend', clear);
    return () => {
      window.removeEventListener('drop', clear);
      window.removeEventListener('dragend', clear);
      cancelLeave();
    };
  }, [cancelLeave, clear, enabled]);

  const onDragEnter = useCallback(
    (event: ReactDragEvent) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      cancelLeave();
      depth.current += 1;
      setOver(true);
    },
    [cancelLeave],
  );

  const onDragOver = useCallback((event: ReactDragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current > 0) return;
    cancelLeave();
    leaveFrame.current = requestAnimationFrame(() => {
      leaveFrame.current = null;
      if (depth.current === 0) setOver(false);
    });
  }, [cancelLeave]);

  return {
    over: enabled && over,
    clear,
    dragProps: enabled ? { onDragEnter, onDragOver, onDragLeave } : {},
  };
}

type FilesDroppedPayload = {
  files?: string[];
  details?: { id?: string };
};

/**
 * 统一的本地文件入口：Wails 原生拖入事件与 Wails 文件选择器。
 * 拖入要求宿主元素带有 `data-file-drop-target`，两者都会把选中的本地路径交给 `onPaths`。
 */
export function useFileDrop({
  id,
  enabled = true,
  pick,
  onPaths,
  onError,
}: {
  id: string;
  enabled?: boolean;
  pick?: LocalFilePickOptions;
  onPaths: (paths: string[]) => void;
  onError?: (error: unknown) => void;
}) {
  const drag = useFileDragOver({ enabled });
  const onPathsRef = useRef(onPaths);
  onPathsRef.current = onPaths;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;
    const off = Events.On('files-dropped', (event) => {
      const data = event.data as unknown as FilesDroppedPayload;
      if (data.details?.id !== id) return;
      const paths = data.files ?? [];
      if (paths.length) onPathsRef.current(paths);
    });
    return off;
  }, [enabled, id]);

  const pickFile = useCallback(async () => {
    try {
      const result = await Dialogs.OpenFile({
        CanChooseFiles: true,
        ...pickRef.current,
      } as Parameters<typeof Dialogs.OpenFile>[0]);
      const paths = Array.isArray(result) ? result : result ? [result] : [];
      if (paths.length) onPathsRef.current(paths);
    } catch (error) {
      onErrorRef.current?.(error);
    }
  }, []);

  return {
    over: drag.over,
    clear: drag.clear,
    pick: pickFile,
    dropProps: enabled ? { id, 'data-file-drop-target': true, ...drag.dragProps } : {},
  };
}

/**
 * 统一监听剪贴板中的文件粘贴；`accept` 用于按工具限定文件类型。
 */
export function useClipboardFilePaste({
  enabled = true,
  accept,
  onFile,
}: {
  enabled?: boolean;
  accept?: (file: File) => boolean;
  onFile: (file: File) => void;
}) {
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      const file = files.find((candidate) => acceptRef.current?.(candidate) ?? true);
      if (!file) return;
      event.preventDefault();
      onFileRef.current(file);
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [enabled]);
}

/** 按路径读取本地文件为 data URL 及元数据，供拖入与选择器共用。 */
export async function readLocalFile(path: string, maxBytes: number): Promise<LocalFile> {
  return await ReadFile(path, maxBytes);
}

/** 将剪贴板文件读取为 data URL，与路径读取产生的 data URL 保持一致。 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(file);
  });
}

/** 将 data URL 解码为文本，用于文本类工具直接填入编辑器。 */
export function dataUrlToText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(header)) {
    const binary = atob(payload.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

export default function FileDropEmpty({
  icon: Icon,
  title,
  desc,
  actionLabel,
  onChooseFile,
  actionRef,
  over: overProp,
  framed = true,
  announce = true,
  className,
}: {
  icon: Icon;
  title: string;
  desc: string;
  actionLabel: string;
  onChooseFile: () => void;
  actionRef?: Ref<HTMLButtonElement>;
  over?: boolean;
  framed?: boolean;
  announce?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const internal = useFileDragOver({ enabled: overProp === undefined });
  const over = overProp ?? internal.over;
  const release = t('fileDrop.release');

  return (
    <div
      className={cn('file-drop-empty', className)}
      data-over={over ? 'true' : undefined}
      data-framed={framed ? undefined : 'false'}
      {...(overProp === undefined ? internal.dragProps : {})}
    >
      {announce && over ? (
        <span className="sr-only" role="status">
          {release}
        </span>
      ) : null}
      <Icon className="file-drop-empty-icon" size={28} weight="duotone" aria-hidden />
      <strong className="file-drop-empty-title">
        <span className="file-drop-empty-title-idle" aria-hidden={over ? true : undefined}>
          {title}
        </span>
        <span className="file-drop-empty-title-release" aria-hidden={over ? undefined : true}>
          {release}
        </span>
      </strong>
      <span className="file-drop-empty-desc">{desc}</span>
      <Button
        ref={actionRef}
        type="button"
        variant="outline"
        size="sm"
        className="file-drop-empty-action"
        onClick={onChooseFile}
      >
        <UploadSimple data-icon="inline-start" weight="duotone" />
        {actionLabel}
      </Button>
    </div>
  );
}
