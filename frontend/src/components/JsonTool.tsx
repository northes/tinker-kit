import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { useTranslation } from 'react-i18next';
import { Clipboard } from '@wailsio/runtime';
import CodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
import { json5 } from 'codemirror-json5';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { codeFolding, syntaxTree } from '@codemirror/language';
import { EditorView, keymap } from '@codemirror/view';
import { acceptCompletion } from '@codemirror/autocomplete';
import { SaveText } from '../../bindings/changeme/fileservice';
import { JSON_CONVERT_FORMATS, type JsonConvertFormat } from '../lib/json-converter';
import { useDebouncedJsonConversion } from '../hooks/useDebouncedJsonConversion';
import { jsonFoldParseWarmup, quietEditorTheme } from './codeMirrorTheme';
import {
  Copy,
  DownloadSimple,
  Table as TableIcon,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import {
  formatJsonPreserve,
  hasComments,
  parseJsonLoose,
  Reveal,
  ToolActionBar,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
  ToolLayoutToolbarGroup,
  ToolLayout,
  useFocusOnActivate,
  type PendingAction,
  type ToolBarAction,
  type ToolId,
} from './shared';
import { toast } from './ui/toast';
import { JsonErrorPanel } from './JsonErrorPanel';
import { JsonTablePreview } from './JsonTablePreview';
import '../styles/tools/editor.css';
import '../styles/tools/json.css';
import {
  newPipelineItem,
  parsePipelineConfig,
  serializePipeline,
  PipelineOutputPane,
  PipelinePanel,
} from './JsonPipeline';
import type { PipelineItem } from './JsonPipelineEngine';
import { useDebouncedPipelineEvaluation } from './useDebouncedPipelineEvaluation';
import { pathCompletions as sharedPathCompletions } from './JsonPathCompletion';

type PathToken = { type: 'key' | 'index' | 'all'; value: string };
type SourceNode = {
  start: number;
  end: number;
  children?: Record<string, SourceNode> | SourceNode[];
};
type JsonPathErrorCode =
  | 'unclosedComment'
  | 'unclosedString'
  | 'invalidObjectKey'
  | 'missingColon'
  | 'unclosedNode'
  | 'pathMissingBracket'
  | 'pathInvalidSegment'
  | 'pathInvalidChar'
  | 'notArray'
  | 'indexOutOfRange'
  | 'noKeyAt'
  | 'keyNotFound'
  | 'pathNotFound';
class JsonPathError extends Error {
  constructor(
    readonly code: JsonPathErrorCode,
    readonly params: Record<string, string> = {},
  ) {
    super(code);
  }
}
const parseFail = (code: JsonPathErrorCode, params?: Record<string, string>): never => {
  throw new JsonPathError(code, params);
};
function sourceNode(doc: string, start = 0): SourceNode {
  const skip = (i: number) => {
    while (i < doc.length) {
      if (/\s/.test(doc[i])) {
        i++;
        continue;
      }
      if (doc[i] === '/' && doc[i + 1] === '/') {
        i = doc.indexOf('\n', i + 2);
        if (i < 0) return doc.length;
        continue;
      }
      if (doc[i] === '/' && doc[i + 1] === '*') {
        i = doc.indexOf('*/', i + 2);
        if (i < 0) parseFail('unclosedComment');
        i += 2;
        continue;
      }
      break;
    }
    return i;
  };
  const stringEnd = (i: number) => {
    const quote = doc[i++];
    for (; i < doc.length; i++) {
      if (doc[i] === '\\') i++;
      else if (doc[i] === quote) return i + 1;
    }
    return parseFail('unclosedString');
  };
  const value = (i: number): SourceNode => {
    i = skip(i);
    const node: SourceNode = { start: i, end: i };
    if (doc[i] === '{' || doc[i] === '[') {
      const object = doc[i] === '{';
      const children: Record<string, SourceNode> | SourceNode[] = object ? {} : [];
      i++;
      while (true) {
        i = skip(i);
        if (doc[i] === (object ? '}' : ']')) {
          node.end = i + 1;
          break;
        }
        if (object) {
          if (doc[i] !== '"' && doc[i] !== "'") parseFail('invalidObjectKey');
          const keyStart = i,
            keyEnd = stringEnd(i),
            key = JSON.parse(doc.slice(keyStart, keyEnd));
          i = skip(keyEnd);
          if (doc[i] !== ':') parseFail('missingColon');
          const child = value(i + 1);
          (children as Record<string, SourceNode>)[key] = child;
          i = skip(child.end);
        } else {
          const child = value(i);
          (children as SourceNode[]).push(child);
          i = skip(child.end);
        }
        if (doc[i] === ',') {
          i++;
          continue;
        }
        if (doc[i] === (object ? '}' : ']')) {
          node.end = i + 1;
          break;
        }
        parseFail('unclosedNode');
      }
      node.children = children;
      return node;
    }
    if (doc[i] === '"' || doc[i] === "'") node.end = stringEnd(i);
    else {
      while (i < doc.length && !/[\s,}\]]/.test(doc[i])) i++;
      node.end = i;
    }
    return node;
  };
  return value(start);
}
function parsePath(p: string): PathToken[] {
  const tokens: PathToken[] = [];
  let s = p.trim();
  if (s.startsWith('$')) s = s.slice(1);
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.' || s[i] === '/') {
      i++;
      continue;
    }
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) parseFail('pathMissingBracket');
      const inner = s.slice(i + 1, end).trim();
      if (inner === '*') tokens.push({ type: 'all', value: '*' });
      else if (/^-?\d+$/.test(inner)) tokens.push({ type: 'index', value: inner });
      else if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      )
        tokens.push({ type: 'key', value: inner.slice(1, -1) });
      else parseFail('pathInvalidSegment', { value: inner });
      i = end + 1;
    } else if (/[A-Za-z0-9_$]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$-]/.test(s[j])) j++;
      tokens.push({ type: 'key', value: s.slice(i, j) });
      i = j;
    } else parseFail('pathInvalidChar', { value: s[i] });
  }
  return tokens;
}
function matchPath(
  doc: string,
  path: string,
): { ok: true; value: unknown; source?: string } | { ok: false; error: JsonPathError } {
  try {
    const root = parseJsonLoose(doc);
    const tokens = parsePath(path);
    const walk = (cur: any, i: number): any => {
      if (i >= tokens.length) return cur;
      const tok = tokens[i];
      if (tok.type === 'all') {
        const children = Array.isArray(cur)
          ? cur
          : cur && typeof cur === 'object'
            ? Object.values(cur)
            : [];
        return children.map((c) => walk(c, i + 1));
      }
      if (tok.type === 'index') {
        if (!Array.isArray(cur)) parseFail('notArray');
        const next = cur[Number(tok.value)];
        if (next === undefined) parseFail('indexOutOfRange');
        return walk(next, i + 1);
      }
      if (cur == null || typeof cur !== 'object') parseFail('noKeyAt', { key: tok.value });
      if (!(tok.value in cur)) parseFail('keyNotFound', { key: tok.value });
      return walk(cur[tok.value], i + 1);
    };
    const value = walk(root, 0);
    let node = sourceNode(doc);
    for (const token of tokens) {
      if (token.type === 'all') {
        node = undefined as never;
        break;
      }
      const children = node.children;
      if (token.type === 'index') {
        if (!Array.isArray(children)) parseFail('notArray');
        else node = children[Number(token.value)];
      } else {
        if (!children || Array.isArray(children)) parseFail('noKeyAt', { key: token.value });
        else node = children[token.value];
      }
      if (!node) parseFail('pathNotFound');
    }
    return { ok: true, value, source: node ? doc.slice(node.start, node.end) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof JsonPathError ? e : new JsonPathError('pathNotFound') };
  }
}

const CONVERT_EXTENSIONS: Record<JsonConvertFormat, string> = {
  yaml: 'yaml',
  xml: 'xml',
  toml: 'toml',
  csv: 'csv',
};

function isConvertFormat(value: string | undefined): value is JsonConvertFormat {
  return value === 'yaml' || value === 'xml' || value === 'toml' || value === 'csv';
}

type JsonPageMode = 'plain' | 'schema' | 'pipeline' | 'convert';
function modeHostHidden(visible: boolean) {
  return visible ? '' : ' is-hidden absolute inset-0 invisible pointer-events-none';
}

function tryAutoFormat(src: string) {
  if (!src.trim()) return src;
  try {
    if (hasComments(src)) {
      const next = formatJsonPreserve(src);
      parseJsonLoose(next);
      return next;
    }
    return JSON.stringify(parseJsonLoose(src), null, 2);
  } catch {
    return src;
  }
}
const json5Language = json5();

function JsonEditorPane({
  label,
  value,
  onChange,
  foldExt,
  onCreate,
  theme,
  readOnly = false,
  placeholder,
  cmClassName,
  formatOnPaste,
  tableMode = false,
  tableDisabled = false,
  active = true,
  onToggleTable,
  tablePreview,
  tableHint,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  foldExt: ReturnType<typeof codeFolding>;
  onCreate?: (v: EditorView) => void;
  theme: Extension;
  readOnly?: boolean;
  placeholder?: string;
  cmClassName?: string;
  formatOnPaste?: (next: string) => string;
  tableMode?: boolean;
  tableDisabled?: boolean;
  active?: boolean;
  onToggleTable?: () => void;
  tablePreview?: ReactNode;
  tableHint?: string;
}) {
  const { t } = useTranslation();
  const formatOnPasteRef = useRef(formatOnPaste);
  formatOnPasteRef.current = formatOnPaste;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pasteExt = useMemo(
    () =>
      EditorView.domEventHandlers({
        paste(event, view) {
          const format = formatOnPasteRef.current;
          if (!format) return false;
          const pasted = event.clipboardData?.getData('text/plain');
          if (pasted == null) return false;
          event.preventDefault();
          const sel = view.state.selection.main;
          onChangeRef.current?.(
            format(
              view.state.doc.sliceString(0, sel.from) + pasted + view.state.doc.sliceString(sel.to),
            ),
          );
          return true;
        },
      }),
    [],
  );
  const extensions = useMemo(
    () => [json5Language, foldExt, jsonFoldParseWarmup, pasteExt],
    [foldExt, pasteExt],
  );
  return (
    <div className="json-pane flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <span className="json-pane-label flex-none font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
        {label}
      </span>
      <div className="json-pane-editor relative flex min-h-0 min-w-0 flex-1">
        {onToggleTable && (
          <Button
            type="button"
            variant={tableMode ? 'secondary' : 'ghost'}
            size="icon-sm"
            className="json-table-toggle absolute top-2 right-2 z-20"
            disabled={tableDisabled}
            aria-label={t('jsonTool.tablePreview')}
            title={
              tableDisabled
                ? tableHint
                : t(tableMode ? 'jsonTool.tablePreviewOn' : 'jsonTool.tablePreview')
            }
            onClick={onToggleTable}
          >
            <TableIcon />
          </Button>
        )}
        <CodeMirror
          className={`json-cm${cmClassName ? ' ' + cmClassName : ''}`}
          height="100%"
          value={value}
          onChange={onChange}
          onCreateEditor={(v) => {
            v.contentDOM.setAttribute('aria-label', label);
            onCreate?.(v);
          }}
          theme={theme}
          editable={!readOnly}
          placeholder={placeholder}
          extensions={extensions}
        />
        {tablePreview && (
          <div
            className={`json-table-layer${tableMode && active ? ' is-visible' : ''}`}
            aria-hidden={!tableMode || !active}
            {...(!tableMode || !active ? { inert: true } : {})}
          >
            {tablePreview}
          </div>
        )}
      </div>
    </div>
  );
}

export default function JsonTool({
  active,
  theme,
  autoFormatOnFill,
  onAutoFormatOnFillChange,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  theme: string;
  autoFormatOnFill: boolean;
  onAutoFormatOnFillChange: (value: boolean) => void;
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
  const fmtErr = (e: unknown) =>
    e instanceof JsonPathError ? t(`jsonTool.errors.${e.code}`, e.params) : String(e);
  const [mode, setMode] = useState<JsonPageMode>('plain');
  const schema = mode === 'schema';
  const pipelineMode = mode === 'pipeline';
  const convertMode = mode === 'convert';
  const [convertFormat, setConvertFormat] = useState<JsonConvertFormat>('yaml');
  const [input, setInput] = useState('');
  const [path, setPath] = useState('$');
  const [result, setResult] = useState('');
  const [pathError, setPathError] = useState('');
  const [pipelineRules, setPipelineRules] = useState<PipelineItem[]>([]);
  const [pipelineFocusId, setPipelineFocusId] = useState<string | null>(null);
  const [inputTableMode, setInputTableMode] = useState(false);
  const [resultTableMode, setResultTableMode] = useState(false);
  const [commentDialog, setCommentDialog] = useState<null | {
    mode: 'format' | 'minify';
    pane: 'input' | 'result';
  }>(null);
  const consumed = useRef<PendingAction | null>(null);
  const views = useRef(new Map<string, EditorView>());
  const autoFormatRef = useRef(autoFormatOnFill);
  autoFormatRef.current = autoFormatOnFill;
  useFocusOnActivate(active, () => views.current.get('input')?.focus());
  const cmTheme = quietEditorTheme;
  const inputPreview = useMemo(() => {
    try {
      return { valid: true as const, value: parseJsonLoose(input) };
    } catch {
      return { valid: false as const, value: null };
    }
  }, [input]);
  const jsonValue = inputPreview.valid ? inputPreview.value : null;
  const resultPreview = useMemo(() => {
    try {
      return { valid: true, value: parseJsonLoose(result) };
    } catch {
      return { valid: false, value: null };
    }
  }, [result]);
  // Auto-exit table mode when content becomes empty or invalid
  useEffect(() => {
    if (inputTableMode && (!input.trim() || !inputPreview.valid)) {
      setInputTableMode(false);
    }
  }, [input, inputPreview.valid, inputTableMode]);
  useEffect(() => {
    if (resultTableMode && (!result.trim() || !resultPreview.valid)) {
      setResultTableMode(false);
    }
  }, [result, resultPreview.valid, resultTableMode]);
  const jsonValueRef = useRef<unknown>(jsonValue);
  jsonValueRef.current = jsonValue;
  const pathExt = useMemo(
    () => [
      EditorView.lineWrapping,
      sharedPathCompletions(() => jsonValueRef.current),
      keymap.of([
        {
          key: 'Tab',
          run: (v) => {
            acceptCompletion(v);
            return true;
          },
        },
      ]),
    ],
    [],
  );
  const foldExt = useMemo(
    () =>
      codeFolding({
        preparePlaceholder: (state: any, range: { from: number; to: number }) => {
          let node = syntaxTree(state).resolveInner(range.from, 1);
          while (node && node.name !== 'Object' && node.name !== 'Array' && node.parent)
            node = node.parent;
          if (!node) return '…';
          if (node.name === 'Object')
            return t('jsonTool.foldObject', { count: node.getChildren('Property').length });
          let n = 0;
          const c = node.cursor();
          if (c.firstChild())
            do {
              if (!['[', ']', ','].includes(c.name)) n++;
            } while (c.nextSibling());
          return t('jsonTool.foldArray', { count: n });
        },
        placeholderDOM: (_view: unknown, onclick: (e: Event) => void, prepared?: string) => {
          const el = document.createElement('span');
          el.textContent = prepared ?? '…';
          el.className = 'cm-foldPlaceholder';
          el.onclick = onclick;
          return el;
        },
      }),
    [t],
  );
  const summary = (v: string) =>
    `${v.split(/\r?\n/).length} ${t('jsonTool.lines')} · ${[...v].length} ${t('jsonTool.characters')}`;
  const runTransform = (pane: 'input' | 'result', minify: boolean, stripComments: boolean) => {
    const src = pane === 'input' ? input : result;
    const set = pane === 'input' ? setInput : setResult;
    try {
      let next;
      if (!minify && !stripComments && hasComments(src)) {
        next = formatJsonPreserve(src);
        try {
          parseJsonLoose(next);
        } catch {
          toast.add({
            title: t('jsonTool.formatFailed'),
            description: t('jsonTool.invalidJsonDesc'),
            type: 'error',
          });
          return;
        }
      } else {
        const v = stripComments ? parseJsonLoose(src) : JSON.parse(src);
        next = minify ? JSON.stringify(v) : JSON.stringify(v, null, 2);
      }
      set(next);
      record(
        'json',
        minify ? t('jsonTool.minified') : t('jsonTool.formatted'),
        summary(next),
        next,
      );
    } catch {
      toast.add({
        title: t(minify ? 'jsonTool.minifyFailed' : 'jsonTool.formatFailed'),
        description: t('jsonTool.invalidJsonDesc'),
        type: 'error',
      });
    }
  };
  const requestTransform = (pane: 'input' | 'result', minify: boolean) => {
    if (hasComments(pane === 'input' ? input : result))
      setCommentDialog({ mode: minify ? 'minify' : 'format', pane });
    else runTransform(pane, minify, false);
  };
  const changeInput = setInput;
  const toggleSchema = () => setMode((current) => (current === 'schema' ? 'plain' : 'schema'));
  const togglePipeline = () =>
    setMode((current) => (current === 'pipeline' ? 'plain' : 'pipeline'));
  const toggleConvert = () => setMode((current) => (current === 'convert' ? 'plain' : 'convert'));
  const convertFormats = useMemo(
    () =>
      JSON_CONVERT_FORMATS.map((key) => ({
        value: key,
        label: t(`jsonTool.convert.formats.${key}`),
      })),
    [t],
  );
  const conversion = useDebouncedJsonConversion(convertMode, input, convertFormat);
  const [displayedConvert, setDisplayedConvert] = useState({
    text: '',
    format: convertFormat,
  });
  const convertReady =
    conversion.status === 'ok' && conversion.input === input && conversion.format === convertFormat;
  useEffect(() => {
    if (conversion.status !== 'ok') return;
    if (conversion.input !== input || conversion.format !== convertFormat) return;
    const next = { text: conversion.output, format: conversion.format };
    setDisplayedConvert((current) =>
      current.text === next.text && current.format === next.format ? current : next,
    );
  }, [conversion, convertFormat, input]);
  const convertLang = useMemo((): Extension[] => {
    if (displayedConvert.format === 'xml') return [xml(), EditorView.lineWrapping];
    if (displayedConvert.format === 'yaml') return [yaml(), EditorView.lineWrapping];
    return [EditorView.lineWrapping];
  }, [displayedConvert.format]);
  const schemaResultExt = useMemo(() => [json5Language, foldExt, jsonFoldParseWarmup], [foldExt]);
  const convertErrorMessage =
    conversion.status === 'error'
      ? t(
          `jsonTool.convert.errors.${conversion.error.code === 'workerError' ? 'failed' : conversion.error.code}`,
          conversion.error.params,
        )
      : '';
  const copyConvert = async () => {
    if (
      conversion.status !== 'ok' ||
      conversion.input !== input ||
      conversion.format !== convertFormat
    )
      return;
    const text = conversion.output;
    try {
      if (!navigator.clipboard) throw new Error('clipboard');
      await navigator.clipboard.writeText(text);
    } catch {
      toast.add({ title: t('jsonTool.pipeline.clipboardWriteFailed'), type: 'error' });
      return;
    }
    const bytes = new TextEncoder().encode(text).length;
    toast.add({ title: t('toast.copied', { value: `${bytes} ${t('jsonTool.bytes')}` }) });
    record('json', t('jsonTool.copied'), `${bytes} ${t('jsonTool.bytes')}`, input, text, {
      mode: convertFormat,
    });
  };
  const exportConvert = async () => {
    if (
      conversion.status !== 'ok' ||
      conversion.input !== input ||
      conversion.format !== convertFormat
    )
      return;
    const text = conversion.output;
    const filename = `converted.${CONVERT_EXTENSIONS[convertFormat]}`;
    try {
      const path = await SaveText(text, filename);
      if (!path) return;
      toast.add({ title: t('jsonTool.convert.exported', { name: filename }) });
      record('json', t('jsonTool.convert.export'), filename, input, text, {
        mode: convertFormat,
      });
    } catch {
      toast.add({ title: t('jsonTool.convert.exportFailed'), type: 'error' });
    }
  };
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tinkerkit:json-schema', { detail: schema }));
  }, [schema]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tinkerkit:json-pipeline', { detail: pipelineMode }));
  }, [pipelineMode]);
  useEffect(() => {
    if (!schema) return;
    setPath((current) => {
      const normalized = current.trim();
      return normalized === '' || normalized === '$.' ? '$' : current;
    });
  }, [schema]);
  const pipeline = useDebouncedPipelineEvaluation(pipelineMode, input, pipelineRules);
  const addPipelineItem = () => {
    const next = newPipelineItem();
    const hasTemplate = pipelineRules.some((item) => item.type === 'template');
    setPipelineFocusId(next.id);
    if (hasTemplate) toast.add({ title: t('jsonTool.pipeline.templateNotice'), type: 'warning' });
    setPipelineRules((r) => {
      const template = r.find((item) => item.type === 'template');
      if (!template) return [...r, next];
      return [...r.filter((item) => item.id !== template.id), next, template];
    });
  };
  const removePipelineItem = (id: string) =>
    setPipelineRules((r) => r.filter((item) => item.id !== id));
  const movePipelineItem = (from: number, to: number) =>
    setPipelineRules((r) => {
      if (from === to || to < 0 || to >= r.length) return r;
      const next = [...r];
      const [moved] = next.splice(from, 1);
      if (!moved || moved.type === 'template') return r;
      const templateIndex = next.findIndex((item) => item.type === 'template');
      next.splice(
        templateIndex < 0 ? Math.min(to, next.length) : Math.min(to, templateIndex),
        0,
        moved,
      );
      return next;
    });
  const exportPipeline = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard');
      await navigator.clipboard.writeText(serializePipeline(pipelineRules));
      toast.add({ title: t('jsonTool.pipeline.exported') });
    } catch {
      toast.add({
        title: t('jsonTool.pipeline.exportFailed'),
        description: t('jsonTool.pipeline.clipboardWriteFailed'),
        type: 'error',
      });
    }
  };
  const importPipeline = async () => {
    try {
      const source = (await Clipboard.Text().catch(() => '')) || '';
      if (!source.trim()) {
        toast.add({ title: t('jsonTool.pipeline.importEmpty'), type: 'warning' });
        return;
      }
      setPipelineRules(parsePipelineConfig(source));
      toast.add({ title: t('jsonTool.pipeline.imported') });
    } catch (error) {
      if (error instanceof Error && error.message === 'invalidConfig') {
        toast.add({
          title: t('jsonTool.pipeline.importFailed'),
          description: t('jsonTool.pipeline.invalidConfig'),
          type: 'error',
        });
        return;
      }
      toast.add({
        title: t('jsonTool.pipeline.importFailed'),
        description: t('jsonTool.pipeline.clipboardReadFailed'),
        type: 'error',
      });
    }
  };
  const copyPipeline = () => {
    if (pipeline.error || !pipeline.output) return;
    void navigator.clipboard?.writeText(pipeline.output).catch(() => {});
    const bytes = new TextEncoder().encode(pipeline.output).length;
    toast.add({ title: t('toast.copied', { value: `${bytes} ${t('jsonTool.bytes')}` }) });
    record(
      'json',
      t('jsonTool.pipeline.copy'),
      `${bytes} ${t('jsonTool.bytes')}`,
      input,
      pipeline.output,
    );
  };
  const copyPane = async (pane: 'input' | 'result') => {
    const value = pane === 'input' ? input : result;
    await navigator.clipboard?.writeText(value).catch(() => {});
    const bytes = new TextEncoder().encode(value).length;
    toast.add({ title: t('toast.copied', { value: `${bytes} ${t('jsonTool.bytes')}` }) });
  };
  const editorActions = (pane: 'input' | 'result') => {
    const value = pane === 'input' ? input : result;
    const actions: ToolBarAction[] = [
      {
        key: 'clear',
        label: t('jsonTool.clear'),
        icon: Trash,
        variant: 'tertiary',
        disabled: !value,
        onPress: () => (pane === 'input' ? changeInput('') : setResult('')),
      },
    ];
    actions.push(
      {
        key: 'copy',
        label: t('jsonTool.copy'),
        icon: Copy,
        variant: 'secondary',
        disabled: !value,
        onPress: () => copyPane(pane),
      },
      {
        key: 'minify',
        label: t('jsonTool.minify'),
        variant: 'secondary',
        disabled: !value,
        onPress: () => requestTransform(pane, true),
      },
    );
    if (pane === 'input')
      actions.push({
        key: 'format',
        label: t('jsonTool.format'),
        variant: 'primary',
        disabled: !value,
        onPress: () => requestTransform(pane, false),
      });
    else
      actions.push({
        key: 'format',
        label: t('jsonTool.format'),
        variant: 'primary',
        disabled: !value,
        onPress: () => requestTransform(pane, false),
      });
    return (
      <ToolActionBar
        label={t(pane === 'input' ? 'jsonTool.inputActions' : 'jsonTool.resultActions')}
        actions={actions}
      />
    );
  };
  const pipelineRuleActions = (
    <ToolActionBar
      label={t('jsonTool.pipeline.ruleActions')}
      actions={[
        {
          key: 'import',
          label: t('jsonTool.pipeline.importConfig'),
          icon: UploadSimple,
          variant: 'secondary',
          onPress: () => void importPipeline(),
        },
        {
          key: 'export',
          label: t('jsonTool.pipeline.exportConfig'),
          icon: DownloadSimple,
          variant: 'secondary',
          onPress: () => void exportPipeline(),
        },
        {
          key: 'add',
          label: t('jsonTool.pipeline.addItem'),
          variant: 'primary',
          onPress: addPipelineItem,
        },
      ]}
    />
  );
  const pipelineActions = (
    <ToolActionBar
      label={t('jsonTool.pipeline.actions')}
      actions={[
        {
          key: 'copy',
          label: t('jsonTool.copy'),
          icon: Copy,
          variant: 'primary',
          disabled: !!pipeline.error || !pipeline.output,
          onPress: copyPipeline,
        },
      ]}
    />
  );
  const jsonGridClass = convertMode
    ? 'grid-cols-2 grid-rows-[minmax(0,1fr)] gap-3'
    : pipelineMode
      ? 'grid-cols-2 grid-rows-[minmax(0,1fr)] gap-3'
      : schema
        ? 'grid-cols-2 grid-rows-[minmax(0,1fr)] gap-3 @max-[959px]/json-page:grid-cols-2 @max-[959px]/json-page:grid-rows-1 @min-[960px]/json-page:grid-cols-3 @min-[960px]/json-page:grid-rows-1'
        : 'grid-cols-1 grid-rows-[minmax(0,1fr)] gap-0';
  const footerGridClass = convertMode
    ? 'grid-cols-1'
    : pipelineMode
      ? 'grid-cols-2'
      : schema
        ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @max-[959px]/json-page:grid-cols-2 @min-[960px]/json-page:grid-cols-3'
        : 'grid-cols-1';
  const convertActions = (
    <ToolActionBar
      label={t('jsonTool.convert.actions')}
      actions={[
        {
          key: 'copy',
          label: t('jsonTool.copy'),
          icon: Copy,
          variant: 'secondary',
          disabled: !convertReady,
          onPress: () => void copyConvert(),
        },
        {
          key: 'export',
          label: t('jsonTool.convert.export'),
          icon: DownloadSimple,
          variant: 'primary',
          disabled: !convertReady,
          onPress: () => void exportConvert(),
        },
      ]}
    />
  );
  useEffect(() => {
    if (!pending || pending.tool !== 'json' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    const pane = pending.pane ?? 'input';
    if (pending.action === 'autoFormatOnFill') {
      onAutoFormatOnFillChange(!autoFormatRef.current);
      return;
    }
    if (pending.action === 'schema') {
      toggleSchema();
      return;
    }
    if (pending.action === 'pipeline') {
      togglePipeline();
      return;
    }
    if (pending.action === 'convert') {
      toggleConvert();
      return;
    }
    if (pending.action === 'convertCopy') {
      void copyConvert();
      return;
    }
    if (pending.action === 'convertExport') {
      void exportConvert();
      return;
    }
    if (pending.action === 'pipelineAddItem') {
      addPipelineItem();
      return;
    }
    if (pending.action === 'pipelineCopy') {
      copyPipeline();
      return;
    }
    if (pending.action === 'pipelineImport') {
      void importPipeline();
      return;
    }
    if (pending.action === 'pipelineExport') {
      void exportPipeline();
      return;
    }
    if (pending.action === 'clear') {
      pane === 'input' ? changeInput('') : setResult('');
      return;
    }
    if (pending.action === 'format' || pending.action === 'minify') {
      requestTransform(pane, pending.action === 'minify');
      return;
    }
    if (pending.action === 'copy') {
      const toCopy = (pane === 'input' ? input : result).trim() || pending.input;
      if (!toCopy.trim()) {
        toast.add({
          title: t('toast.clipboardEmpty'),
          description: t('toast.clipboardEmptyDesc'),
          type: 'warning',
        });
        return;
      }
      void navigator.clipboard?.writeText(toCopy).catch(() => {});
      const bytes = new TextEncoder().encode(toCopy).length;
      toast.add({ title: t('toast.copied', { value: `${bytes} ${t('jsonTool.bytes')}` }) });
      record('json', t('jsonTool.copied'), `${bytes} ${t('jsonTool.bytes')}`, toCopy);
      return;
    }
    if (pending.action === 'restore') {
      changeInput(pending.input);
      if (pending.output !== undefined) setResult(pending.output);
      if (isConvertFormat(pending.mode)) {
        setConvertFormat(pending.mode);
        setMode('convert');
        if (pending.output !== undefined) {
          setDisplayedConvert({ text: pending.output, format: pending.mode });
        }
      }
      return;
    }
    if (pending.action === 'validate') {
      changeInput(pending.input);
      try {
        JSON.parse(pending.input);
        record('json', t('jsonTool.validated'), summary(pending.input), pending.input);
      } catch {
        record('json', t('jsonTool.invalid'), summary(pending.input), pending.input);
      }
      return;
    }
    const next = autoFormatRef.current ? tryAutoFormat(pending.input) : pending.input;
    changeInput(next);
    if (autoFormatRef.current && next !== pending.input)
      record('json', t('jsonTool.formatted'), summary(next), next);
  }, [pending, pipeline]);
  useEffect(() => {
    const onFill = () => {
      if (!autoFormatRef.current) return;
      const view = views.current.get('input');
      if (!view) return;
      const src = view.state.doc.toString();
      const next = tryAutoFormat(src);
      if (next !== src) setInput(next);
    };
    window.addEventListener('tinkerkit:json-after-fill', onFill);
    return () => window.removeEventListener('tinkerkit:json-after-fill', onFill);
  }, []);
  useEffect(() => {
    if (!schema) return;
    if (!input.trim()) {
      setResult('');
      setPathError('');
      return;
    }
    const m = matchPath(input, path);
    if (m.ok) {
      setResult(m.source ?? JSON.stringify(m.value, null, 2));
      setPathError('');
    } else {
      setResult('');
      setPathError(fmtErr(m.error));
    }
  }, [schema, input, path]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const keys =
        mode === 'schema'
          ? ['input', 'path', 'result']
          : mode === 'convert'
            ? ['input', 'convert']
            : ['input'];
      for (const key of keys) views.current.get(key)?.requestMeasure();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode]);
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout className="json-page [container-name:json-page] [container-type:inline-size]">
        <ToolLayoutHeader title={t('jsonTool.title')} />
        <ToolLayoutToolbar
          className="json-toolbar @max-[700px]/json-page:flex-col @max-[700px]/json-page:items-stretch"
          rightClassName="@max-[700px]/json-page:ml-0"
          left={
            <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
              <Checkbox
                checked={autoFormatOnFill}
                onCheckedChange={(checked) => onAutoFormatOnFillChange(checked)}
              />
              <span>{t('jsonTool.autoFormatOnFill')}</span>
            </Label>
          }
          right={
            <ToolLayoutToolbarGroup>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <span>{t('jsonTool.schema')}</span>
                <Switch checked={schema} onCheckedChange={toggleSchema} size="sm" />
              </Label>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <span>{t('jsonTool.pipeline.title')}</span>
                <Switch checked={pipelineMode} onCheckedChange={togglePipeline} size="sm" />
              </Label>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <span>{t('jsonTool.convert.title')}</span>
                <Switch checked={convertMode} onCheckedChange={toggleConvert} size="sm" />
              </Label>
            </ToolLayoutToolbarGroup>
          }
        />
        <ToolLayoutContent>
          <div className="json-content h-full min-h-0 overflow-hidden">
            <div
              className={`json-schema-layout relative grid h-full min-h-0 min-w-0 ${jsonGridClass}${pipelineMode ? ' pipeline-layout' : ''}`}
            >
              <div
                className={
                  pipelineMode
                    ? 'json-pipeline-source grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 overflow-hidden'
                    : 'contents'
                }
              >
                <JsonEditorPane
                  label={t('jsonTool.input')}
                  value={input}
                  onChange={changeInput}
                  foldExt={foldExt}
                  onCreate={(v) => views.current.set('input', v)}
                  theme={cmTheme}
                  placeholder={t('jsonTool.placeholder')}
                  cmClassName="json-input-cm"
                  formatOnPaste={autoFormatOnFill ? tryAutoFormat : undefined}
                  tableMode={inputTableMode}
                  active={active}
                  tableDisabled={!input.trim() || !inputPreview.valid}
                  tableHint={t('jsonTool.tablePreviewInvalid')}
                  onToggleTable={() => setInputTableMode((current) => !current)}
                  tablePreview={<JsonTablePreview value={inputPreview.value} t={t} />}
                />
                <div
                  className={`json-pipeline-output-slot min-h-0 min-w-0${
                    pipelineMode ? ' h-full' : modeHostHidden(false)
                  }`}
                  aria-hidden={!pipelineMode}
                  {...(!pipelineMode ? { inert: true } : {})}
                >
                  <PipelineOutputPane
                    output={pipeline.output}
                    error={pipeline.error}
                    theme={cmTheme}
                    foldExt={foldExt}
                  />
                </div>
              </div>
              <div
                className={`json-convert-pane flex min-h-0 min-w-0 flex-col gap-2${modeHostHidden(convertMode)}`}
                aria-hidden={!convertMode}
                {...(!convertMode ? { inert: true } : {})}
              >
                <span className="json-pane-label flex-none font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
                  {t('jsonTool.convert.format')}
                </span>
                <Select
                  items={convertFormats}
                  value={convertFormat}
                  onValueChange={(value) => {
                    if (value === 'xml' || value === 'toml' || value === 'yaml' || value === 'csv')
                      setConvertFormat(value);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-full min-w-0 text-[11px]"
                    aria-label={t('jsonTool.convert.format')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {convertFormats.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="json-pane-editor relative flex min-h-0 min-w-0 flex-1">
                  <CodeMirror
                    className="json-cm"
                    height="100%"
                    value={displayedConvert.text}
                    editable={false}
                    theme={cmTheme}
                    onCreateEditor={(v) => {
                      v.contentDOM.setAttribute('aria-label', t('jsonTool.convert.output'));
                      views.current.set('convert', v);
                    }}
                    extensions={convertLang}
                  />
                  {conversion.status === 'error' ? (
                    <div className="absolute inset-0 z-10 flex min-h-0">
                      <JsonErrorPanel
                        title={t('jsonTool.convert.errorTitle')}
                        description={convertErrorMessage}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
              <div
                className={
                  schema
                    ? 'json-schema-right grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 @max-[959px]/json-page:grid @min-[960px]/json-page:contents'
                    : `json-schema-right min-h-0 min-w-0${modeHostHidden(false)}`
                }
                aria-hidden={!schema}
                {...(!schema ? { inert: true } : {})}
              >
                <div
                  className={schema ? 'contents' : modeHostHidden(false).trim()}
                  aria-hidden={!schema}
                  {...(!schema ? { inert: true } : {})}
                >
                  <div className="json-path flex min-w-0 flex-col gap-2 min-h-0">
                    <span className="flex-none font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
                      {t('jsonTool.schema')}
                    </span>
                    <div className="json-path-field flex min-h-0 min-w-0 flex-1">
                      <CodeMirror
                        className="json-cm json-path-cm"
                        height="100%"
                        value={path}
                        onChange={setPath}
                        theme={cmTheme}
                        indentWithTab={false}
                        onCreateEditor={(v) => {
                          v.contentDOM.setAttribute('aria-label', t('jsonTool.schema'));
                          views.current.set('path', v);
                        }}
                        basicSetup={{
                          lineNumbers: false,
                          foldGutter: false,
                          autocompletion: false,
                          closeBrackets: false,
                        }}
                        extensions={pathExt}
                        placeholder={t('jsonTool.schemaPathPlaceholder')}
                      />
                    </div>
                  </div>
                  <div className="json-pane flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
                    <span className="json-pane-label flex-none font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
                      {t('jsonTool.result')}
                    </span>
                    <div className="json-pane-editor relative flex min-h-0 min-w-0 flex-1">
                      <CodeMirror
                        className="json-cm"
                        height="100%"
                        value={result}
                        editable={false}
                        theme={cmTheme}
                        onCreateEditor={(v) => {
                          v.contentDOM.setAttribute('aria-label', t('jsonTool.result'));
                          views.current.set('result', v);
                        }}
                        extensions={schemaResultExt}
                      />
                      {pathError ? (
                        <div className="absolute inset-0 z-10 flex min-h-0">
                          <JsonErrorPanel
                            title={t('jsonTool.pipeline.errorTitle')}
                            description={pathError}
                          />
                        </div>
                      ) : null}
                      {!pathError && (
                        <div
                          className={`json-table-layer${resultTableMode && active ? ' is-visible' : ''}`}
                          aria-hidden={!resultTableMode || !active}
                          {...(!resultTableMode || !active ? { inert: true } : {})}
                        >
                          <JsonTablePreview value={resultPreview.value} t={t} />
                        </div>
                      )}
                      {!pathError && (
                        <Button
                          type="button"
                          variant={resultTableMode ? 'secondary' : 'ghost'}
                          size="icon-sm"
                          className="json-table-toggle absolute top-2 right-2 z-20"
                          disabled={!result.trim() || !resultPreview.valid}
                          aria-label={t('jsonTool.tablePreview')}
                          title={
                            !result.trim() || !resultPreview.valid
                              ? t('jsonTool.tablePreviewInvalid')
                              : t(
                                  resultTableMode
                                    ? 'jsonTool.tablePreviewOn'
                                    : 'jsonTool.tablePreview',
                                )
                          }
                          onClick={() => setResultTableMode((current) => !current)}
                        >
                          <TableIcon />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div
                className={`json-pipeline-slot min-h-0 min-w-0${
                  pipelineMode ? ' h-full overflow-hidden' : modeHostHidden(false)
                }`}
                aria-hidden={!pipelineMode}
                {...(!pipelineMode ? { inert: true } : {})}
              >
                <PipelinePanel
                  contexts={pipeline.contexts}
                  rules={pipelineRules}
                  theme={cmTheme}
                  focusItemId={pipelineFocusId}
                  onFocusHandled={() => setPipelineFocusId(null)}
                  onChange={setPipelineRules}
                  onRemove={removePipelineItem}
                  onMove={movePipelineItem}
                />
              </div>
            </div>
            <div className={`detected hidden${input && !jsonValue ? ' invalid' : ''}`}>
              <span>{t('jsonTool.detected')}</span>
              {input ? (
                <strong className={jsonValue ? undefined : 'empty'}>
                  {jsonValue ? `${t('jsonTool.valid')} · ${summary(input)}` : t('jsonTool.invalid')}
                </strong>
              ) : (
                <strong className="empty">{t('jsonTool.placeholder')}</strong>
              )}
            </div>
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <div
            className={`json-footer-actions grid items-start gap-3 ${footerGridClass}${pipelineMode ? ' pipeline-layout' : ''}`}
          >
            {convertMode ? (
              convertActions
            ) : (
              <>
                {mode === 'plain' ? (
                  editorActions('input')
                ) : pipelineMode ? (
                  <div className="json-pipeline-footer-actions min-w-0">{pipelineActions}</div>
                ) : schema ? (
                  <div className="min-w-0" aria-hidden="true" />
                ) : null}
                {schema && editorActions('result')}
                {pipelineMode && (
                  <div className="json-pipeline-rules-footer-actions min-w-0">
                    {pipelineRuleActions}
                  </div>
                )}
              </>
            )}
          </div>
        </ToolLayoutFooter>
      </ToolLayout>
      <AlertDialog
        open={commentDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCommentDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('jsonTool.commentTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {commentDialog?.mode === 'minify'
                ? t('jsonTool.commentMinifyBody')
                : t('jsonTool.commentFormatBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('jsonTool.cancel')}</AlertDialogCancel>
            {commentDialog?.mode === 'format' && (
              <Button
                variant="outline"
                onClick={() => {
                  const d = commentDialog;
                  setCommentDialog(null);
                  if (d) runTransform(d.pane, false, false);
                }}
              >
                {t('jsonTool.keepComments')}
              </Button>
            )}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const d = commentDialog;
                setCommentDialog(null);
                if (d) runTransform(d.pane, d.mode === 'minify', true);
              }}
            >
              {commentDialog?.mode === 'minify'
                ? t('jsonTool.minifyClear')
                : t('jsonTool.clearComments')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Reveal>
  );
}
