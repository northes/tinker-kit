import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { closeCompletion, completeAnyWord, completionStatus } from '@codemirror/autocomplete';
import { EditorView, keymap } from '@codemirror/view';
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
import { quietEditorTheme } from './codeMirrorTheme';
import { editorCompletions } from './codeMirrorCompletion';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Spinner } from './ui/spinner';
import { toast } from './ui/toast';
import { formatBackendError } from '../lib/backend-error';
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

type Props = {
  sourceID: string;
  path: string;
  name: string;
  onClose: () => void;
  onSaved: () => void;
};

export function RemoteTextEditorDialog({ sourceID, path, name, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [revision, setRevision] = useState('');
  const [error, setError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  // 补全消费过的原生 Esc：即使事件继续泄漏到 Dialog 的 document 监听，也不能再打开放弃确认。
  const consumedEscapes = useRef(new WeakSet<Event>());
  const saveRef = useRef(async () => {});
  const dirty = content !== savedContent;
  const formatSupported = Boolean(prettierParsers[extension(name)]);
  const formatTooLarge =
    formatSupported &&
    (content.length > maxFormatBytes || new TextEncoder().encode(content).length > maxFormatBytes);
  const canFormat = formatSupported && !formatTooLarge;
  const extensions = useMemo(
    () => [
      editorLanguage(name),
      EditorView.lineWrapping,
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

  useEffect(() => {
    const request = ReadRemoteTextFile(sourceID, path);
    let active = true;
    void request
      .then((file) => {
        if (!active) return;
        setContent(file.content);
        setSavedContent(file.content);
        setRevision(file.revision);
        setError('');
      })
      .catch((reason) => {
        if (active) setError(formatBackendError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void request.cancel();
    };
  }, [sourceID, path]);

  const save = async () => {
    if (loading || saving || formatting || !dirty) return;
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

  const format = async () => {
    if (!canFormat || formatting || saving || loading) return;
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

  return (
    <>
      <Dialog
        open
        onOpenChange={(open, details) => {
          if (open) return;
          // 关闭由 onClose 卸载编辑器；不能让 Dialog 在确认或 busy 守卫前改变内部状态。
          details.cancel();
          if (discardOpen) return;
          if (details.reason === 'escape-key') {
            const event = details.event;
            if (consumedEscapes.current.has(event)) return;
            if (event.defaultPrevented || ('repeat' in event && event.repeat)) return;
            const view = viewRef.current;
            if (view && completionStatus(view.state) !== null) {
              // 补全已由捕获阶段关闭时，同一次 Esc 仍可能走到这里。
              consumedEscapes.current.add(event);
              closeCompletion(view);
              event.preventDefault();
              return;
            }
            // 即将打开放弃确认框：同一原生事件不能再次进入确认框的关闭处理。
            consumedEscapes.current.add(event);
            event.preventDefault();
          }
          requestClose();
        }}
      >
        <DialogContent
          className="grid h-[min(72vh,720px)] w-[min(960px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-3 sm:max-w-none"
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
            const view = viewRef.current;
            if (!view || completionStatus(view.state) === null) return;
            // 补全属于编辑器内层：先标记并关闭，再尽量阻止外层 Dialog 处理同一次按键。
            consumedEscapes.current.add(event.nativeEvent);
            closeCompletion(view);
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <DialogHeader className="min-w-0">
            <DialogTitle className="truncate">
              {t('sshFilesTool.editTextTitle', { name })}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-xs" title={path}>
              {path}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 rounded-md border border-border bg-card">
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
                className="h-full rounded-[inherit] [&_.cm-editor]:h-full [&_.cm-editor]:rounded-[inherit] [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:rounded-[inherit] [&_.cm-scroller]:overflow-auto"
                height="100%"
                value={content}
                onChange={setContent}
                editable={!saving && !formatting}
                onCreateEditor={(view) => {
                  viewRef.current = view;
                  view.contentDOM.setAttribute('aria-label', t('sshFilesTool.editorContent'));
                }}
                theme={quietEditorTheme}
                extensions={extensions}
                basicSetup={{ autocompletion: false }}
              />
            )}
          </div>
          <DialogFooter>
            {error && revision ? (
              <p className="mr-auto self-center text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button variant="outline" onClick={requestClose} disabled={saving || formatting}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={() => void format()}
              disabled={!canFormat || loading || saving || formatting}
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
              disabled={loading || saving || formatting || !dirty || !revision}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
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
      </Dialog>
    </>
  );
}
