import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { closeCompletion, completeAnyWord, completionStatus } from '@codemirror/autocomplete';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { css } from '@codemirror/lang-css';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { ReadRemoteTextFile, SaveRemoteTextFile } from '../../bindings/tinkerkit/fileservice';
import { ToolSlotOverlayContext } from '../app/tool-slot';
import { quietEditorTheme } from './codeMirrorTheme';
import { editorCompletions } from './codeMirrorCompletion';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { toast } from './ui/toast';
import { backendErrorKey, formatBackendError } from '../lib/backend-error';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import '../styles/tools/editor.css';

const prettierParsers: Record<string, string> = {
  json: 'json',
  jsonc: 'jsonc',
  js: 'babel',
  jsx: 'babel',
  cjs: 'babel',
  mjs: 'babel',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  graphql: 'graphql',
};
const maxFormatBytes = 128 * 1024;
const tailLineOptions = [200, 500, 1000, 2000] as const;
const defaultTailLines = 500;

function nearBottom(view: EditorView) {
  const scroller = view.scrollDOM;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
}
const yamlSyntax = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.definition(tags.propertyName), color: 'var(--primary)' },
    { tag: tags.content, color: 'var(--success)' },
  ]),
);
const dotenvSyntax = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--primary)' },
  ]),
);

type DotenvState = { mode: 'key' | 'separator' | 'value'; quote: '' | '"' | "'" };

// dotenv 没有标准解析器，按行区分键、等号、值与注释，保证 .env 文件可见着色。
const dotenvLanguage = StreamLanguage.define<DotenvState>({
  name: 'dotenv',
  startState: () => ({ mode: 'key', quote: '' }),
  token(stream, state) {
    if (stream.sol()) {
      state.mode = 'key';
      state.quote = '';
    }
    if (stream.eatSpace() || stream.eol()) return null;

    const ch = stream.peek() as string;

    if (state.quote) {
      stream.next();
      if (ch === state.quote) state.quote = '';
      return 'string';
    }

    if (state.mode === 'key') {
      if (ch === '#') {
        stream.skipToEnd();
        return 'comment';
      }
      if (stream.match(/^export\b/)) return 'keyword';
      if (stream.match(/^[A-Za-z0-9_.-]+/)) {
        state.mode = 'separator';
        return 'propertyName';
      }
      stream.next();
      return null;
    }

    if (state.mode === 'separator') {
      stream.next();
      if (ch === '=') {
        state.mode = 'value';
        return 'operator';
      }
      return null;
    }

    if (ch === '"' || ch === "'") {
      state.quote = ch;
      stream.next();
      return 'string';
    }
    if (ch === '#' && (stream.pos === 0 || /\s/.test(stream.string[stream.pos - 1]))) {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '$' && (stream.match(/^\$\{[^}]*\}/) || stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)))
      return 'string-2';
    stream.next();
    return 'string';
  },
});

function extension(name: string) {
  return name.toLowerCase().split('.').pop() ?? '';
}

function editorLanguage(name: string): Extension {
  const ext = extension(name);
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return StreamLanguage.define(dockerFile);
  if (['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext))
    return javascript({
      typescript: ['ts', 'tsx', 'mts', 'cts'].includes(ext),
      jsx: ['jsx', 'tsx'].includes(ext),
    });
  if (['json', 'jsonc'].includes(ext)) return json();
  if (['html', 'htm', 'vue'].includes(ext)) return html();
  if (['css', 'scss', 'less'].includes(ext)) return css();
  if (['md', 'markdown'].includes(ext)) return markdown();
  if (['yaml', 'yml'].includes(ext)) return [yaml(), yamlSyntax];
  if (ext === 'xml' || ext === 'svg') return xml();
  if (ext === 'go') return go();
  if (['py', 'pyw'].includes(ext)) return python();
  if (ext === 'rs') return rust();
  if (ext === 'java') return java();
  if (['c', 'cc', 'cpp', 'h', 'hpp'].includes(ext)) return cpp();
  if (ext === 'php') return php();
  if (ext === 'sql') return sql();
  if (['sh', 'bash', 'zsh', 'fish'].includes(ext)) return StreamLanguage.define(shell);
  if (ext === 'rb') return StreamLanguage.define(ruby);
  if (ext === 'lua') return StreamLanguage.define(lua);
  if (ext === 'swift') return StreamLanguage.define(swift);
  if (['diff', 'patch'].includes(ext)) return StreamLanguage.define(diff);
  if (ext === 'toml') return StreamLanguage.define(toml);
  if (ext === 'proto') return StreamLanguage.define(protobuf);
  if (ext === 'env' || lower.startsWith('.env')) return [dotenvLanguage, dotenvSyntax];
  if (['ini', 'properties', 'cfg', 'conf'].includes(ext)) return StreamLanguage.define(properties);
  return [];
}

async function formatText(name: string, content: string) {
  const parser = prettierParsers[extension(name)];
  if (!parser) return content;
  const prettier = await import('prettier/standalone');
  const plugins =
    parser === 'json' || parser === 'jsonc' || parser === 'babel'
      ? [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')]
      : parser === 'typescript'
        ? [await import('prettier/plugins/typescript'), await import('prettier/plugins/estree')]
        : parser === 'html' || parser === 'vue'
          ? [await import('prettier/plugins/html')]
          : parser === 'css' || parser === 'scss' || parser === 'less'
            ? [await import('prettier/plugins/postcss')]
            : parser === 'markdown'
              ? [await import('prettier/plugins/markdown')]
              : parser === 'yaml'
                ? [await import('prettier/plugins/yaml')]
                : [await import('prettier/plugins/graphql')];
  return prettier.format(content, { parser, plugins });
}

export type RemoteTextEditorContent = { text: string; ready: boolean };

type Props = {
  sourceID: string;
  path: string;
  name: string;
  onProbeResult?: (errorKey: string | null) => boolean;
  onClose: () => void;
  onSaved: () => void;
  onContentChange: (content: RemoteTextEditorContent | null) => void;
};

export function RemoteTextEditorDialog({
  sourceID,
  path,
  name,
  onProbeResult,
  onClose,
  onSaved,
  onContentChange,
}: Props) {
  const { t } = useTranslation();
  const overlayRoot = useContext(ToolSlotOverlayContext);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [liveRefresh, setLiveRefresh] = useState(false);
  const [tailLines, setTailLines] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [tailScroll, setTailScroll] = useState(0);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [revision, setRevision] = useState('');
  const [error, setError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  // 补全消费过的原生 Esc：即使事件继续泄漏到 Dialog 的 document 监听，也不能再打开放弃确认。
  const consumedEscapes = useRef(new WeakSet<Event>());
  const saveRef = useRef(async () => {});
  const followTailRef = useRef(true);
  const autoTailRef = useRef(true);
  const probing = onProbeResult !== undefined;
  const finishProbe = useEffectEvent(
    (errorKey: string | null) => onProbeResult?.(errorKey) ?? false,
  );
  useLayoutEffect(() => {
    if (probing) return;
    return () => onContentChange(null);
  }, [probing, onContentChange]);
  useLayoutEffect(() => {
    if (!probing) onContentChange({ text: content, ready: !loading && !readFailed });
  }, [probing, content, loading, readFailed, onContentChange]);
  const dirty = content !== savedContent;
  const formatSupported = Boolean(prettierParsers[extension(name)]);
  const formatTooLarge =
    formatSupported &&
    (content.length > maxFormatBytes || new TextEncoder().encode(content).length > maxFormatBytes);
  const canFormat = formatSupported && !formatTooLarge && !truncated;
  const tailItems = useMemo(
    () => [
      { value: '0', label: t('sshFilesTool.tailLinesAll') },
      ...tailLineOptions.map((total) => ({
        value: String(total),
        label: t('sshFilesTool.tailLinesLast', { total }),
      })),
    ],
    [t],
  );
  const extensions = useMemo(
    () => [
      editorLanguage(name),
      EditorView.lineWrapping,
      ViewPlugin.fromClass(
        class {
          private readonly onScroll: () => void;
          constructor(private readonly view: EditorView) {
            this.onScroll = () => {
              followTailRef.current = nearBottom(this.view);
            };
            this.view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
          }
          destroy() {
            this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
          }
        },
      ),
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
      ...editorCompletions(),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void saveRef.current();
            return true;
          },
        },
      ]),
    ],
    [name],
  );

  useLayoutEffect(() => {
    let active = true;
    let request: ReturnType<typeof ReadRemoteTextFile> | undefined;
    setLoading(true);

    const read = async () => {
      if (!active) return;
      try {
        request = ReadRemoteTextFile(sourceID, path, tailLines);
        const file = await request;
        if (!active) return;
        setContent(file.content);
        setSavedContent(file.content);
        setRevision(file.revision);
        setTruncated(file.truncated);
        setReadFailed(false);
        setError('');
        if (tailLines > 0 && followTailRef.current) setTailScroll((value) => value + 1);
        setLoading(false);
        finishProbe(null);
      } catch (reason) {
        if (!active) return;
        const errorKey = backendErrorKey(reason);
        if (finishProbe(errorKey)) return;
        if (autoTailRef.current && tailLines === 0 && errorKey === 'errors.sshFile.textTooLarge') {
          autoTailRef.current = false;
          followTailRef.current = true;
          setTailLines(defaultTailLines);
          return;
        }
        setContent('');
        setSavedContent('');
        setRevision('');
        setTruncated(false);
        setReadFailed(true);
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
  }, [sourceID, path, tailLines]);

  useEffect(() => {
    if (!liveRefresh || loading) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: ReturnType<typeof ReadRemoteTextFile> | undefined;

    const refresh = async () => {
      request = ReadRemoteTextFile(sourceID, path, tailLines);
      try {
        const file = await request;
        if (!active) return;
        setContent(file.content);
        setSavedContent(file.content);
        setRevision(file.revision);
        setTruncated(file.truncated);
        setReadFailed(false);
        setError('');
        if (followTailRef.current) setTailScroll((value) => value + 1);
      } catch (reason) {
        if (!active) return;
        if (tailLines === 0 && backendErrorKey(reason) === 'errors.sshFile.textTooLarge') {
          followTailRef.current = true;
          setLoading(true);
          setTailLines(defaultTailLines);
          return;
        }
        setReadFailed(true);
        setError(formatBackendError(reason));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1500);
      }
    };

    timer = setTimeout(() => void refresh(), 1500);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void request?.cancel();
    };
  }, [liveRefresh, loading, sourceID, path, tailLines]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || tailScroll === 0) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }),
    });
  }, [tailScroll]);

  const save = async () => {
    if (truncated || liveRefresh || loading || saving || formatting || !dirty) return;
    setSaving(true);
    setError('');
    try {
      const nextRevision = await SaveRemoteTextFile(sourceID, path, content, revision);
      setSavedContent(content);
      setRevision(nextRevision);
      onSaved();
      toast.add({ title: t('sshFilesTool.editorSaved'), type: 'success' });
    } catch (reason) {
      setError(formatBackendError(reason));
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  const requestClose = () => {
    if (saving || formatting) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  // 编辑器只占住标签内容区，不再用模态 Dialog。Esc 只在这层处理，不能挂到 document 上把标签栏一并挡住。
  const onEditorKeyDown = (event: {
    key: string;
    repeat?: boolean;
    defaultPrevented: boolean;
    isComposing?: boolean;
    nativeEvent?: Event & { isComposing?: boolean; repeat?: boolean };
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (event.key !== 'Escape' || event.isComposing || event.nativeEvent?.isComposing) return;
    if (discardOpen) return;
    const native = event.nativeEvent ?? (event as unknown as Event);
    if (consumedEscapes.current.has(native)) return;
    if (event.defaultPrevented || event.repeat || event.nativeEvent?.repeat) return;
    const view = viewRef.current;
    if (view && completionStatus(view.state) !== null) {
      consumedEscapes.current.add(native);
      closeCompletion(view);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    consumedEscapes.current.add(native);
    event.preventDefault();
    requestClose();
  };

  const format = async () => {
    if (!canFormat || truncated || formatting || saving || loading || liveRefresh) return;
    setFormatting(true);
    setError('');
    try {
      const formatted = await formatText(name, content);
      viewRef.current?.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: formatted },
      });
      setContent(formatted);
    } catch (reason) {
      setError(formatBackendError(reason));
    } finally {
      setFormatting(false);
    }
  };

  if (probing) return null;

  const editor = (
    <section
      className="pointer-events-auto absolute inset-0 z-20 flex min-h-0 items-center justify-center overflow-hidden p-4"
      onKeyDownCapture={onEditorKeyDown}
    >
      {/* 模糊层只盖当前工具页，标签栏仍可点击；点击它与全局对话框一样按关闭处理。
            这一层不能做 opacity 动画：自身或祖先 opacity 不是 1 时 backdrop-filter 会消失。 */}
      <div
        aria-hidden="true"
        className="absolute inset-0 cursor-default bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
        onClick={requestClose}
      />
      <div
        data-slot="remote-text-editor"
        role="dialog"
        aria-label={t('sshFilesTool.editTextTitle', { name })}
        className="relative grid h-[min(72vh,720px)] min-h-0 max-h-full w-[min(960px,calc(100%-2rem))] grid-rows-[minmax(0,1fr)_auto_auto] gap-y-2 overflow-hidden rounded-xl border border-border bg-popover pb-4 shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 duration-100"
      >
        <div className="min-h-0 min-w-0 p-0.5">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[calc(var(--radius-xl)-2px)] border border-border bg-card">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : error && !revision ? (
              <div
                className="flex h-full items-center justify-center text-sm text-destructive"
                role="alert"
              >
                {error}
              </div>
            ) : (
              <CodeMirror
                className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:rounded-[inherit] [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:rounded-[inherit] [&_.cm-scroller]:overflow-auto"
                height="100%"
                value={content}
                onChange={setContent}
                editable={!truncated && !liveRefresh && !saving && !formatting}
                onCreateEditor={(view) => {
                  viewRef.current = view;
                  view.contentDOM.setAttribute('aria-label', t('sshFilesTool.editorContent'));
                  view.focus();
                }}
                theme={quietEditorTheme}
                extensions={extensions}
                basicSetup={{ autocompletion: false }}
              />
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4">
          <p
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
          </p>
          {truncated ? (
            <p className="text-xs text-muted-foreground">{t('sshFilesTool.tailTruncated')}</p>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 px-4 sm:flex-row sm:justify-end">
          <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
            <Select
              items={tailItems}
              value={String(tailLines)}
              disabled={loading || saving || formatting || dirty}
              onValueChange={(value) => {
                if (value == null) return;
                const next = Number(value);
                if (!Number.isInteger(next) || next === tailLines) return;
                autoTailRef.current = false;
                followTailRef.current = true;
                setLoading(true);
                setTailLines(next);
              }}
            >
              <SelectTrigger aria-label={t('sshFilesTool.tailLinesLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {tailItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant={liveRefresh ? 'secondary' : 'outline'}
              onClick={() => setLiveRefresh((enabled) => !enabled)}
              disabled={loading || saving || formatting || (!liveRefresh && dirty)}
              aria-pressed={liveRefresh}
            >
              {liveRefresh ? t('sshFilesTool.stopLiveRefresh') : t('sshFilesTool.startLiveRefresh')}
            </Button>
          </div>
          {error && revision ? (
            <p className="mr-auto self-center text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button variant="outline" onClick={requestClose} disabled={saving || formatting}>
            {t('common.close')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void format()}
            disabled={!canFormat || loading || saving || formatting || liveRefresh || truncated}
            title={
              formatTooLarge
                ? t('sshFilesTool.formatTooLarge')
                : !formatSupported
                  ? t('sshFilesTool.formatUnavailable')
                  : undefined
            }
          >
            {formatting ? <Spinner data-icon="inline-start" /> : null}
            {t('sshFilesTool.formatText')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={
              loading || saving || formatting || liveRefresh || truncated || !dirty || !revision
            }
          >
            {saving ? <Spinner data-icon="inline-start" /> : null}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </section>
  );

  return (
    <>
      {overlayRoot ? createPortal(editor, overlayRoot) : editor}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(open, details) => {
          if (details.reason === 'escape-key') {
            const event = details.event;
            if (
              consumedEscapes.current.has(event) ||
              event.defaultPrevented ||
              ('repeat' in event && event.repeat)
            ) {
              details.cancel();
              return;
            }
          }
          setDiscardOpen(open);
        }}
        title={t('sshFilesTool.discardTextTitle')}
        description={t('sshFilesTool.discardTextDescription')}
        confirmLabel={t('sshFilesTool.discardTextAction')}
        destructive
        onConfirm={onClose}
      />
    </>
  );
}
