import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialogs } from '@wailsio/runtime';
import { Copy, DownloadSimple, QrCode as QrCodeIcon, Trash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { quietEditorTheme } from './codeMirrorTheme';
import { SaveBase64File } from '../../bindings/changeme/configservice';
import {
  Reveal,
  ToolActionBar,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayout,
  useFocusOnActivate,
  type PendingAction,
  type ToolId,
} from './shared';
import { toast } from './ui/toast';
import FileDropEmpty, {
  fileToDataUrl,
  readLocalFile,
  useClipboardFilePaste,
  useFileDrop,
} from './fileDrop';
import '../styles/tools/editor.css';

const MAX_BYTES = 10 * 1024 * 1024;
const QR_SIZE = 512;
const MAX_DECODE_EDGE = 1600;
const bytesLabel = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load'));
    img.src = src;
  });
}

// 二维码像素通常较密，超长边先等比缩到上限再解码，避免大图拖慢主线程。
async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
  const img = await loadHtmlImage(dataUrl);
  const scale = Math.min(
    1,
    MAX_DECODE_EDGE / Math.max(1, Math.max(img.naturalWidth, img.naturalHeight)),
  );
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('ctx');
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return jsQR(data, width, height)?.data ?? null;
}

function QrTextPane({
  label,
  value,
  onChange,
  onCreate,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCreate?: (view: EditorView) => void;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
      <span>{label}</span>
      <CodeMirror
        className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto"
        height="100%"
        value={value}
        onChange={onChange}
        onCreateEditor={(view) => {
          view.contentDOM.setAttribute('aria-label', label);
          onCreate?.(view);
        }}
        theme={quietEditorTheme}
        extensions={[EditorView.lineWrapping]}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          closeBrackets: false,
        }}
      />
    </div>
  );
}

export default function QrCodeTool({
  active,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  record: (
    tool: ToolId,
    action: string,
    detail: string,
    input: string,
    output?: string,
    meta?: { mode?: string; mediaType?: string; name?: string; bytes?: number },
  ) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [qr, setQr] = useState<{ key: string; url: string } | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const inputView = useRef<EditorView | null>(null);
  const emptyRef = useRef<HTMLButtonElement>(null);
  const consumed = useRef<PendingAction | null>(null);
  const lastRecorded = useRef('');
  const skipRecord = useRef(false);
  const recordTimer = useRef<number | null>(null);
  const exportRef = useRef<() => Promise<void>>(async () => {});
  const textBytes = new TextEncoder().encode(text).length;
  useFocusOnActivate(active, () => inputView.current?.focus());

  // 文本稳定后生成二维码预览。
  useEffect(() => {
    if (!text) {
      setQr(null);
      setQrFailed(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      QRCode.toDataURL(text, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: QR_SIZE,
      })
        .then((url) => {
          if (cancelled) return;
          setQr({ key: text, url });
          setQrFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setQr(null);
          setQrFailed(true);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text]);

  useEffect(() => {
    if (recordTimer.current !== null) {
      window.clearTimeout(recordTimer.current);
      recordTimer.current = null;
    }
    if (skipRecord.current) {
      skipRecord.current = false;
      return;
    }
    const token = text.trim();
    if (text && qr?.key === text && lastRecorded.current !== token)
      recordTimer.current = window.setTimeout(() => {
        recordTimer.current = null;
        lastRecorded.current = token;
        record('qrcode', t('qrTool.generated'), `${bytesLabel(textBytes)}`, text);
      }, 1500);
    else if (!text) lastRecorded.current = '';
    return () => {
      if (recordTimer.current !== null) window.clearTimeout(recordTimer.current);
    };
  }, [text, qr, textBytes, record, t]);

  const applyDecodedImage = useCallback(
    async (dataUrl: string, name: string, mimeType: string, bytes: number) => {
      try {
        const decoded = await decodeQrFromDataUrl(dataUrl);
        if (decoded === null) {
          toast.add({ title: t('qrTool.noQr'), type: 'warning' });
          return;
        }
        skipRecord.current = true;
        setText(decoded);
        record('qrcode', t('qrTool.decoded'), bytesLabel(bytes), decoded, '', {
          mode: 'image',
          mediaType: mimeType,
          name,
          bytes,
        });
      } catch {
        toast.add({ title: t('qrTool.decodeFailed'), type: 'error' });
      }
    },
    [record, t],
  );

  const decodeImagePath = useCallback(
    async (path: string) => {
      try {
        const data = await readLocalFile(path, MAX_BYTES);
        await applyDecodedImage(data.dataURL, data.name, data.mimeType, data.size);
      } catch {
        toast.add({ title: t('qrTool.decodeFailed'), type: 'error' });
      }
    },
    [applyDecodedImage, t],
  );

  const fileDrop = useFileDrop({
    id: 'qrcode-drop-zone',
    enabled: active,
    pick: {
      Title: t('qrTool.emptyTitle'),
      ButtonText: t('qrTool.chooseImage'),
      Filters: [
        { DisplayName: t('qrTool.filterImages'), Pattern: '*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg' },
      ],
    },
    onPaths: (paths) => {
      const path = paths[0];
      if (path) void decodeImagePath(path);
    },
    onError: () => toast.add({ title: t('qrTool.decodeFailed'), type: 'error' }),
  });

  // 粘贴图片自动解析；粘贴文本仍交给编辑器默认行为。
  useClipboardFilePaste({
    enabled: active,
    accept: (file) => file.type.startsWith('image/'),
    onFile: (file) => {
      if (file.size > MAX_BYTES) {
        toast.add({ title: t('qrTool.tooLarge'), type: 'warning' });
        return;
      }
      void fileToDataUrl(file)
        .then(async (dataUrl) => {
          if (dataUrl) {
            await applyDecodedImage(dataUrl, file.name, file.type, file.size);
            return;
          }
          toast.add({ title: t('qrTool.decodeFailed'), type: 'error' });
        })
        .catch(() => toast.add({ title: t('qrTool.decodeFailed'), type: 'error' }));
    },
  });

  const copy = async () => {
    if (!text) return;
    await navigator.clipboard?.writeText(text).catch(() => {});
    toast.add({ title: t('toast.copied', { value: bytesLabel(textBytes) }) });
    record('qrcode', t('qrTool.copy'), bytesLabel(textBytes), text);
  };

  const exportImage = async () => {
    if (!qr || qr.key !== text) {
      toast.add({ title: t('qrTool.noQr'), type: 'warning' });
      return;
    }
    try {
      const path = await Dialogs.SaveFile({
        Title: t('qrTool.saveTitle'),
        Filename: 'qrcode.png',
        ButtonText: t('qrTool.save'),
        CanCreateDirectories: true,
        Filters: [{ DisplayName: t('qrTool.filterPng'), Pattern: '*.png' }],
      });
      if (!path) return;
      await SaveBase64File(path, qr.url);
      const detail = `PNG · ${bytesLabel(Math.round(((qr.url.length - 'data:image/png;base64,'.length) * 3) / 4))}`;
      record('qrcode', t('qrTool.exported'), detail, text);
      toast.add({ title: t('qrTool.exportedToast') });
    } catch {
      toast.add({ title: t('qrTool.exportFailed'), type: 'error' });
    }
  };
  exportRef.current = exportImage;

  useEffect(() => {
    if (!pending || pending.tool !== 'qrcode' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'clear') {
      setText('');
      return;
    }
    if (pending.action === 'copy') {
      if (!text)
        toast.add({
          title: t('toast.clipboardEmpty'),
          description: t('toast.clipboardEmptyDesc'),
          type: 'warning',
        });
      else void copy();
      return;
    }
    if (pending.action === 'export') {
      void exportRef.current();
      return;
    }
    skipRecord.current = pending.action === 'restore';
    setText(pending.input);
  }, [pending, text]);

  const showQr = qr !== null && qr.key === text;

  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('qrTool.title')} subtitle={t('qrTool.subtitle')} />
        <ToolLayoutContent>
          <div
            className="grid h-full min-h-0 min-w-0 grid-cols-2 gap-3.5 max-[700px]:grid-cols-1"
            {...fileDrop.dropProps}
          >
            <div className={`grid h-full min-h-0 gap-3 ${text ? 'grid-rows-1' : 'grid-rows-2'}`}>
              <div className="min-h-0">
                <QrTextPane
                  label={t('qrTool.input')}
                  value={text}
                  onChange={setText}
                  onCreate={(view) => {
                    inputView.current = view;
                  }}
                />
              </div>
              {!text && (
                <div className="min-h-0">
                  <FileDropEmpty
                    icon={QrCodeIcon}
                    title={t('qrTool.emptyTitle')}
                    desc={t('qrTool.emptyHint')}
                    actionLabel={t('qrTool.chooseImage')}
                    onChooseFile={() => void fileDrop.pick()}
                    actionRef={emptyRef}
                    over={fileDrop.over}
                  />
                </div>
              )}
            </div>
            <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
              <span>{t('qrTool.preview')}</span>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-card p-4">
                {showQr && qr ? (
                  <img
                    src={qr.url}
                    alt={t('qrTool.preview')}
                    draggable={false}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : qrFailed ? (
                  <p className="m-0 max-w-[240px] text-center text-[11px] leading-5 normal-case tracking-normal">
                    {t('qrTool.tooLong')}
                  </p>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <QrCodeIcon size={36} weight="duotone" aria-hidden />
                    <span className="text-[11px] normal-case tracking-normal">
                      {t('qrTool.previewEmpty')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('qrTool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('qrTool.clear'),
                icon: Trash,
                variant: 'tertiary',
                disabled: !text,
                onPress: () => setText(''),
              },
              {
                key: 'copy',
                label: t('qrTool.copy'),
                icon: Copy,
                variant: 'secondary',
                disabled: !text,
                onPress: () => void copy(),
              },
              {
                key: 'export',
                label: t('qrTool.export'),
                icon: DownloadSimple,
                variant: 'primary',
                disabled: !showQr,
                onPress: () => void exportImage(),
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>
    </Reveal>
  );
}
