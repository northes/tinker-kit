import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Dialogs } from '@wailsio/runtime';
import { Copy, DownloadSimple, File as FileIcon, FileImage, Trash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
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
  decodeBase64,
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

type OutputKind = 'text' | 'image' | 'file';
type FileInfo = { name: string; type: string; size: number; data: string; image: boolean };
type OutputFile = { name: string; mime: string; size: number; data: string };
const MAX_BYTES = 100 * 1024 * 1024;
const bytesLabel = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
function rawBase64(value: string) {
  const raw = value
    .trim()
    .replace(/^data:[^,]+,/, '')
    .replace(/^,/, '')
    .replace(/\s/g, '');
  return raw.length >= 4 &&
    raw.length <= Math.ceil((MAX_BYTES * 4) / 3) &&
    !raw.includes('.') &&
    /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) &&
    raw.length % 4 !== 1 &&
    (raw.length <= 4 * 1024 * 1024
      ? decodeBase64(raw) !== null
      : raw.includes('=') || raw.length >= 24)
    ? raw
    : '';
}
function isImage(value: string) {
  try {
    const raw = value.replace(/-/g, '+').replace(/_/g, '/');
    const b = Uint8Array.from(atob(raw.slice(0, 128)), (c) => c.charCodeAt(0));
    return (
      (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
      (b[0] === 0xff && b[1] === 0xd8) ||
      String.fromCharCode(...b.slice(0, 6)).startsWith('GIF') ||
      String.fromCharCode(...b.slice(8, 12)) === 'WEBP'
    );
  } catch {
    return false;
  }
}
function TextPane({
  label,
  value,
  onChange,
  onCreate,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  onCreate?: (view: EditorView) => void;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
      <span>{label}</span>
      <CodeMirror
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto"
        height="100%"
        value={value}
        onChange={onChange}
        readOnly={!onChange}
        editable={!!onChange}
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
export default function Base64Tool({
  active,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  theme: string;
  record: (
    tool: ToolId,
    action: string,
    detail: string,
    input: string,
    output?: string,
    meta?: { mode: string; mediaType?: string; name?: string; bytes?: number },
  ) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [sourceFile, setSourceFile] = useState<FileInfo | null>(null);
  const [output, setOutput] = useState('');
  const [outputKind, setOutputKind] = useState<OutputKind>('text');
  const [outputFile, setOutputFile] = useState<OutputFile | null>(null);
  const worker = useRef<Worker | null>(null);
  const consumed = useRef<PendingAction | null>(null);
  const revision = useRef(0);
  const inputView = useRef<EditorView | null>(null);
  useFocusOnActivate(active, () => inputView.current?.focus());
  const run = (action: 'encode' | 'decodeText' | 'decodeImage' | 'decodeFile', value: string) =>
    new Promise<{ output: string; bytes: number; mime?: string; ext?: string }>(
      (resolve, reject) => {
        worker.current?.terminate();
        const next = new Worker(new URL('../utils/base64.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.current = next;
        next.onmessage = (e) => {
          next.terminate();
          e.data.error ? reject(new Error('invalid')) : resolve(e.data);
        };
        next.postMessage({ id: 1, action, input: value });
      },
    );
  useEffect(() => () => worker.current?.terminate(), []);
  const convert = async (value: string) => {
    const id = ++revision.current,
      raw = rawBase64(value);
    try {
      if (/^data:/i.test(value.trim())) {
        if (id === revision.current) {
          setOutputKind('text');
          setOutputFile(null);
          setOutput(value.trim().replace(/^data:[^,]+,/, ''));
        }
        return;
      }
      if (raw) {
        if (isImage(raw)) {
          const result = await run('decodeImage', raw);
          if (id === revision.current) {
            setOutputKind('image');
            setOutput(result.output);
            setOutputFile({
              name: `decoded.${result.ext ?? 'bin'}`,
              mime: result.mime ?? 'application/octet-stream',
              size: result.bytes,
              data: result.output,
            });
          }
          return;
        }
        try {
          const result = await run('decodeText', raw);
          if (id === revision.current) {
            setOutputKind('text');
            setOutputFile(null);
            setOutput(result.output);
          }
        } catch {
          const result = await run('decodeFile', raw);
          if (id === revision.current) {
            setOutputKind('file');
            setOutput(result.output);
            setOutputFile({
              name: `decoded.${result.ext ?? 'bin'}`,
              mime: result.mime ?? 'application/octet-stream',
              size: result.bytes,
              data: result.output,
            });
          }
        }
        return;
      }
      const result = await run('encode', value);
      if (id === revision.current) {
        setOutputKind('text');
        setOutputFile(null);
        setOutput(result.output);
      }
    } catch {
      if (id === revision.current) {
        setOutputKind('text');
        setOutputFile(null);
        setOutput('');
        toast.add({ title: t('base64Tool.invalid'), type: 'warning' });
      }
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(
      () => void convert(input),
      input.length > 1024 * 1024 ? 180 : 80,
    );
    return () => window.clearTimeout(timer);
  }, [input]);
  const clear = () => {
    setSourceFile(null);
    setInput('');
    setOutput('');
    setOutputKind('text');
    setOutputFile(null);
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(output).catch(() => {});
    toast.add({ title: t('toast.copied', { value: bytesLabel(output.length) }) });
  };
  const applyFile = useCallback(
    (info: FileInfo) => {
      setSourceFile(info);
      setInput(info.data);
      record(
        'base64',
        t('base64Tool.encoded'),
        `${info.image ? t('base64Tool.image') : t('base64Tool.file')} · ${bytesLabel(info.size)}`,
        info.data,
        info.data.replace(/^data:[^,]+,/, ''),
        {
          mode: info.image ? 'image' : 'file',
          mediaType: info.type,
          name: info.name,
          bytes: info.size,
        },
      );
    },
    [record, t],
  );

  const loadPath = useCallback(
    async (path: string) => {
      try {
        const data = await readLocalFile(path, MAX_BYTES);
        applyFile({
          name: data.name,
          type: data.mimeType || 'application/octet-stream',
          size: data.size,
          data: data.dataURL,
          image: data.mimeType.startsWith('image/'),
        });
      } catch {
        toast.add({ title: t('base64Tool.invalid'), type: 'error' });
      }
    },
    [applyFile, t],
  );

  const fileDrop = useFileDrop({
    id: 'base64-drop-zone',
    enabled: active,
    pick: {
      Title: t('base64Tool.emptyTitle'),
      ButtonText: t('base64Tool.chooseFile'),
    },
    onPaths: (paths) => {
      const path = paths[0];
      if (path) void loadPath(path);
    },
    onError: () => toast.add({ title: t('base64Tool.invalid'), type: 'error' }),
  });

  useClipboardFilePaste({
    enabled: active,
    onFile: (file) => {
      if (file.size > MAX_BYTES) {
        toast.add({
          title: t('base64Tool.tooLarge', { size: bytesLabel(MAX_BYTES) }),
          type: 'warning',
        });
        return;
      }
      void fileToDataUrl(file)
        .then((data) =>
          applyFile({
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
            data,
            image: file.type.startsWith('image/'),
          }),
        )
        .catch(() => toast.add({ title: t('base64Tool.invalid'), type: 'error' }));
    },
  });
  useEffect(() => {
    if (!pending || pending.tool !== 'base64' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'clear') {
      clear();
      return;
    }
    if (pending.action === 'copy') {
      if (!output)
        toast.add({
          title: t('toast.clipboardEmpty'),
          description: t('toast.clipboardEmptyDesc'),
          type: 'warning',
        });
      else void copy();
      return;
    }
    setSourceFile(null);
    setInput(pending.input);
  }, [pending, output]);
  const save = async () => {
    if (!outputFile) return;
    try {
      const path = await Dialogs.SaveFile({
        Title: t('base64Tool.saveTitle'),
        Filename: outputFile.name,
        ButtonText: t('base64Tool.save'),
        CanCreateDirectories: true,
      });
      if (path) {
        await SaveBase64File(path, outputFile.data);
        toast.add({ title: t('base64Tool.saved', { name: outputFile.name }) });
      }
    } catch {
      toast.add({ title: t('base64Tool.saveFailed'), type: 'error' });
    }
  };
  const inputPane = sourceFile ? (
    <div className="flex h-full min-h-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
      <span>{t('base64Tool.fileInput')}</span>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-border bg-card">
        <>
          {sourceFile.image ? (
            <img
              className="max-h-[190px] max-w-full object-contain"
              src={sourceFile.data}
              alt={sourceFile.name}
            />
          ) : (
            <FileIcon size={42} weight="duotone" />
          )}
        </>
        <div className="flex max-w-[90%] flex-col items-center gap-0.5 text-center">
          <strong className="max-w-full truncate text-[10px] font-medium">{sourceFile.name}</strong>
          <small className="font-mono text-[9px] leading-5 text-muted-foreground">
            {sourceFile.type} · {bytesLabel(sourceFile.size)}
          </small>
        </div>
      </div>
    </div>
  ) : (
    <div className={`grid h-full min-h-0 gap-3 ${input ? 'grid-rows-1' : 'grid-rows-2'}`}>
      <div className="min-h-0">
        <TextPane
          label={t('base64Tool.input')}
          value={input}
          onChange={(value) => {
            setSourceFile(null);
            setInput(value);
          }}
          onCreate={(view) => {
            inputView.current = view;
          }}
        />
      </div>
      {!input && (
        <div className="min-h-0">
          <FileDropEmpty
            icon={FileImage}
            title={t('base64Tool.emptyTitle')}
            desc={t('base64Tool.fileHint')}
            actionLabel={t('base64Tool.chooseFile')}
            onChooseFile={() => void fileDrop.pick()}
            over={fileDrop.over}
          />
        </div>
      )}
    </div>
  );
  const resultPane =
    outputKind === 'text' ? (
      <TextPane label={t('base64Tool.output')} value={output} />
    ) : outputFile ? (
      <div className="flex h-full min-h-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
        <span>
          {outputKind === 'image' ? t('base64Tool.imageOutput') : t('base64Tool.fileOutput')}
        </span>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-border bg-card">
          {outputKind === 'image' ? (
            <img
              className="max-h-[190px] max-w-full object-contain"
              src={outputFile.data}
              alt={outputFile.name}
            />
          ) : (
            <>
              <FileIcon size={44} weight="duotone" />
              <strong className="text-xs font-medium">{t('base64Tool.binaryFile')}</strong>
            </>
          )}
          <footer className="flex w-full flex-col items-center gap-2 px-2 py-1.5">
            <span className="flex max-w-full flex-col items-center text-center">
              <strong className="max-w-full truncate text-[10px] font-medium">
                {outputFile.name}
              </strong>
              <small className="font-mono text-[9px] leading-5 text-muted-foreground">
                {outputFile.mime} · {bytesLabel(outputFile.size)}
              </small>
            </span>
            <Button
              variant="outline"
              onClick={() => void save()}
              className="h-[29px] text-[10px] [&_svg]:size-3.5"
            >
              <DownloadSimple data-icon="inline-start" weight="duotone" />
              {t('base64Tool.save')}
            </Button>
          </footer>
        </div>
      </div>
    ) : null;
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('base64Tool.title')} />
        <ToolLayoutContent className="grid grid-rows-[minmax(0,1fr)_auto] gap-3">
          <div className="grid h-full min-h-0 grid-cols-2 gap-3.5" {...fileDrop.dropProps}>
            {inputPane}
            {resultPane}
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('base64Tool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('base64Tool.clear'),
                icon: Trash,
                variant: 'tertiary',
                disabled: !input && !output,
                onPress: clear,
              },
              {
                key: 'copy',
                label: t('base64Tool.copy'),
                icon: Copy,
                variant: 'primary',
                disabled: outputKind !== 'text' || !output,
                onPress: () => void copy(),
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>
    </Reveal>
  );
}
