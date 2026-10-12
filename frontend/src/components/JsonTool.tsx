import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Switch } from './ui/switch';
import { Spinner } from './ui/spinner';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { Trans, useTranslation } from 'react-i18next';
import { Clipboard } from '@wailsio/runtime';
import CodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
import { json5 } from 'codemirror-json5';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { codeFolding, syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  highlightSpecialChars,
  highlightWhitespace,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { acceptCompletion } from '@codemirror/autocomplete';
import { SaveText } from '../../bindings/changeme/fileservice';
import { JSON_CONVERT_FORMATS, type JsonConvertFormat } from '../lib/json-converter';
import { useDebouncedJsonConversion } from '../hooks/useDebouncedJsonConversion';
import { useJsonInspection } from '../hooks/useJsonInspection';
import { useJsonSchemaEvaluation } from '../hooks/useJsonSchemaEvaluation';
import { jsonFoldParseActive, jsonFoldParseWarmup, quietEditorTheme } from './codeMirrorTheme';
import {
  Copy,
  DownloadSimple,
  Table as TableIcon,
  TreeStructure,
  Trash,
  UploadSimple,
  Wrench,
} from '@phosphor-icons/react';
import {
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
import { JsonSchemaPreview } from './JsonSchemaPreview';
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
import { useBackendPipelineEvaluation } from './useBackendPipelineEvaluation';
import {
  GetPipelineResultText,
  InspectJSON,
  RepairJSON,
  TransformJSON,
  ValidateJSON,
} from '../../bindings/changeme/jsonpipelineservice';
import { backendJSONPathCompletions } from './JsonPathCompletion';
import { dataUrlToText, readLocalFile, useFileDrop } from './fileDrop';

const MAX_OPEN_BYTES = 10 * 1024 * 1024;

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

const json5Language = json5();

class NewlineMarker extends WidgetType {
  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'json-newline-marker';
    marker.textContent = '↵';
    marker.setAttribute('aria-hidden', 'true');
    marker.style.color = 'var(--muted-foreground)';
    marker.style.opacity = '0.65';
    marker.style.userSelect = 'none';
    marker.style.pointerEvents = 'none';
    marker.style.paddingInline = '2px';
    return marker;
  }
}

const newlineMarker = new NewlineMarker();
const invisibleCharTheme = EditorView.theme({
  '.cm-highlightSpace': {
    backgroundImage:
      'radial-gradient(circle at 50% 55%, var(--muted-foreground) 1px, transparent 1.1px)',
    opacity: '0.65',
  },
  '.cm-highlightTab': {
    position: 'relative',
    backgroundImage: 'none',
    opacity: '0.65',
    '&::after': {
      content: '"→"',
      position: 'absolute',
      top: '0',
      right: '0',
      color: 'var(--muted-foreground)',
      fontFamily: 'monospace',
      fontSize: '1em',
      lineHeight: 'inherit',
      whiteSpace: 'pre',
    },
  },
});
const showNewlinesExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let line = view.state.doc.lineAt(from);
        while (line.to <= to && line.to < view.state.doc.length) {
          builder.add(line.to, line.to, Decoration.widget({ widget: newlineMarker, side: -1 }));
          if (line.number === view.state.doc.lines) break;
          line = view.state.doc.line(line.number + 1);
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function JsonEditorPane({
  label,
  value,
  onChange,
  foldExt,
  onCreate,
  theme,
  readOnly = false,
  emptyHint = false,
  cmClassName,
  formatOnPaste,
  tableMode = false,
  tableDisabled = false,
  active = true,
  onToggleTable,
  tablePreview,
  tableHint,
  schemaMode = false,
  showInvisibleChars = false,
  onToggleSchema,
  schemaPreview,
  onOpenFile,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  foldExt: ReturnType<typeof codeFolding>;
  onCreate?: (v: EditorView) => void;
  theme: Extension;
  readOnly?: boolean;
  emptyHint?: boolean;
  cmClassName?: string;
  formatOnPaste?: (next: string) => Promise<string | null> | string | null;
  tableMode?: boolean;
  tableDisabled?: boolean;
  active?: boolean;
  onToggleTable?: () => void;
  tablePreview?: ReactNode;
  tableHint?: string;
  schemaMode?: boolean;
  showInvisibleChars?: boolean;
  onToggleSchema?: () => void;
  schemaPreview?: ReactNode;
  onOpenFile?: () => void;
}) {
  const { t } = useTranslation();
  const paneRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [hintPos, setHintPos] = useState<{ left: number; top: number } | null>(null);
  const showHint = emptyHint && !readOnly && value.length === 0;
  const formatOnPasteRef = useRef(formatOnPaste);
  formatOnPasteRef.current = formatOnPaste;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 浮层需要避开行号槽，直接取位置 0 的实际坐标作为提示起点。
  const measureHint = useCallback(() => {
    const pane = paneRef.current;
    const view = viewRef.current;
    if (!pane || !view) return;
    const coords = view.coordsAtPos(0);
    if (!coords) return;
    const box = pane.getBoundingClientRect();
    setHintPos({ left: coords.left - box.left, top: coords.top - box.top });
  }, []);

  useLayoutEffect(() => {
    if (!showHint) {
      setHintPos(null);
      return;
    }
    const frame = requestAnimationFrame(measureHint);
    const pane = paneRef.current;
    const ro = new ResizeObserver(measureHint);
    if (pane) ro.observe(pane);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [showHint, value, measureHint]);

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
          const next =
            view.state.doc.sliceString(0, sel.from) + pasted + view.state.doc.sliceString(sel.to);
          onChangeRef.current?.(next);
          void Promise.resolve(format(next)).then((formatted) => {
            if (formatted !== null && formatted !== next && view.state.doc.toString() === next)
              onChangeRef.current?.(formatted);
          });
          return true;
        },
      }),
    [],
  );
  const extensions = useMemo(
    () => [
      json5Language,
      foldExt,
      jsonFoldParseWarmup,
      jsonFoldParseActive.of(active),
      pasteExt,
      ...(showInvisibleChars
        ? [
            showNewlinesExtension,
            invisibleCharTheme,
            highlightWhitespace(),
            highlightSpecialChars(),
          ]
        : []),
    ],
    [active, foldExt, pasteExt, showInvisibleChars],
  );
  return (
    <div className="json-pane flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-none items-center justify-between gap-2">
        <span className="json-pane-label font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
          {label}
        </span>
        {(onToggleTable || onToggleSchema) && (
          <div className="flex gap-1">
            {onToggleSchema && (
              <Button
                type="button"
                variant={schemaMode ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={t('jsonTool.schemaPreview')}
                title={t(schemaMode ? 'jsonTool.schemaPreviewOn' : 'jsonTool.schemaPreview')}
                onClick={onToggleSchema}
              >
                <TreeStructure weight="duotone" />
              </Button>
            )}
            {onToggleTable && (
              <Button
                type="button"
                variant={tableMode ? 'secondary' : 'ghost'}
                size="icon-sm"
                disabled={tableDisabled}
                aria-label={t('jsonTool.tablePreview')}
                title={
                  tableDisabled
                    ? tableHint
                    : t(tableMode ? 'jsonTool.tablePreviewOn' : 'jsonTool.tablePreview')
                }
                onClick={onToggleTable}
              >
                <TableIcon weight="duotone" />
              </Button>
            )}
          </div>
        )}
      </div>
      <div ref={paneRef} className="json-pane-editor relative flex min-h-0 min-w-0 flex-1">
        <CodeMirror
          className={`json-cm${cmClassName ? ' ' + cmClassName : ''}`}
          height="100%"
          value={value}
          onChange={onChange}
          onCreateEditor={(v) => {
            v.contentDOM.setAttribute('aria-label', label);
            viewRef.current = v;
            requestAnimationFrame(measureHint);
            onCreate?.(v);
          }}
          theme={theme}
          editable={!readOnly}
          extensions={extensions}
        />
        {showHint && hintPos ? (
          <div
            className="pointer-events-none absolute z-[1] font-[monospace] text-[length:var(--code-editor-font-size)] leading-[1.4] text-muted-foreground"
            style={{ left: hintPos.left, top: hintPos.top }}
          >
            <Trans
              i18nKey="jsonTool.placeholder"
              components={{
                open: (
                  <button
                    type="button"
                    className="pointer-events-auto cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-primary underline underline-offset-2"
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenFile?.();
                    }}
                  />
                ),
              }}
            />
          </div>
        ) : null}
        {tablePreview && (
          <div
            className={`json-table-layer${tableMode && active ? ' is-visible' : ''}`}
            aria-hidden={!tableMode || !active}
            {...(!tableMode || !active ? { inert: true } : {})}
          >
            {tablePreview}
          </div>
        )}
        {schemaPreview && (
          <div
            className={`json-schema-layer${schemaMode && active ? ' is-visible' : ''}`}
            aria-hidden={!schemaMode || !active}
            {...(!schemaMode || !active ? { inert: true } : {})}
          >
            {schemaPreview}
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
  const fmtPathError = (code: string, params?: Record<string, string | undefined>) =>
    t(`jsonTool.errors.${code}`, params);
  const [mode, setMode] = useState<JsonPageMode>('plain');
  const schema = mode === 'schema';
  const pipelineMode = mode === 'pipeline';
  const convertMode = mode === 'convert';
  const [convertFormat, setConvertFormat] = useState<JsonConvertFormat>('yaml');
  const [input, setInput] = useState('');
  const [showInvisibleChars, setShowInvisibleChars] = useState(false);
  const [path, setPath] = useState('$');
  const [result, setResult] = useState('');
  const [pathError, setPathError] = useState('');
  const [pipelineRules, setPipelineRules] = useState<PipelineItem[]>([]);
  const [pipelineFocusId, setPipelineFocusId] = useState<string | null>(null);
  const [inputTableMode, setInputTableMode] = useState(false);
  const [inputSchemaPreviewMode, setInputSchemaPreviewMode] = useState(false);
  const [resultTableMode, setResultTableMode] = useState(false);
  const [commentDialog, setCommentDialog] = useState<null | {
    mode: 'format' | 'minify';
    pane: 'input' | 'result';
  }>(null);
  const [repairPrompt, setRepairPrompt] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const consumed = useRef<PendingAction | null>(null);
  const views = useRef(new Map<string, EditorView>());
  const inputRef = useRef(input);
  inputRef.current = input;
  const resultRef = useRef(result);
  resultRef.current = result;
  const repairRevisionRef = useRef(0);
  const repairRequestRef = useRef<ReturnType<typeof RepairJSON> | null>(null);
  const transformRevisionRef = useRef(0);
  const transformRequestRef = useRef<ReturnType<typeof TransformJSON> | null>(null);
  const commentInspectionRevisionRef = useRef(0);
  const commentInspectionRequestRef = useRef<ReturnType<typeof InspectJSON> | null>(null);
  const autoFormatRevisionRef = useRef(0);
  const autoFormatRequestRef = useRef<ReturnType<typeof TransformJSON> | null>(null);
  const validateRevisionRef = useRef(0);
  const validateRequestRef = useRef<ReturnType<typeof ValidateJSON> | null>(null);
  const autoFormatRef = useRef(autoFormatOnFill);
  autoFormatRef.current = autoFormatOnFill;
  const schemaEvaluation = useJsonSchemaEvaluation(schema && active, input, path);
  const inputInspection = useJsonInspection(active && !pipelineMode, input);
  useEffect(
    () => () => {
      repairRevisionRef.current++;
      if (repairRequestRef.current) void repairRequestRef.current.cancel();
      transformRevisionRef.current++;
      if (transformRequestRef.current) void transformRequestRef.current.cancel();
      commentInspectionRevisionRef.current++;
      if (commentInspectionRequestRef.current) void commentInspectionRequestRef.current.cancel();
      autoFormatRevisionRef.current++;
      if (autoFormatRequestRef.current) void autoFormatRequestRef.current.cancel();
      validateRevisionRef.current++;
      if (validateRequestRef.current) void validateRequestRef.current.cancel();
    },
    [],
  );
  useFocusOnActivate(active, () => views.current.get('input')?.focus());
  const splitMode = schema || pipelineMode || convertMode;
  const splitRootRef = useRef<HTMLDivElement>(null);
  const [splitStacked, setSplitStacked] = useState(false);
  // schema 固定左右分栏，不随宽窄屏切换方向；其余模式窄屏上下分栏。
  const splitOrientation = schema ? 'horizontal' : splitStacked ? 'vertical' : 'horizontal';
  // 分栏库按面板 ID 保存布局；各模式使用独立标识，React key 不变以保留编辑器实例。
  const mainLayoutKey = !splitMode
    ? 'plain'
    : schema
      ? 'schema'
      : `${mode}-${splitStacked ? 'v' : 'h'}`;
  const pipelineLayoutKey = pipelineMode ? 'split' : 'single';
  // 分栏方向跟随实际可用宽度：窄屏上下分栏，宽屏左右分栏。
  useLayoutEffect(() => {
    const el = splitRootRef.current;
    if (!el) return;
    const update = () => setSplitStacked(el.clientWidth < 960);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const cmTheme = quietEditorTheme;
  const inputPreview = useMemo(() => {
    if (inputInspection.status !== 'ok' || (!inputTableMode && !inputSchemaPreviewMode)) {
      return { valid: inputInspection.status === 'ok', value: null };
    }
    try {
      return { valid: true, value: JSON.parse(inputInspection.text) as unknown };
    } catch {
      return { valid: false, value: null };
    }
  }, [inputInspection, inputSchemaPreviewMode, inputTableMode]);
  const jsonValue = inputInspection.status === 'ok';
  const inputIsSchema = inputInspection.status === 'ok' && inputInspection.isSchema;
  const resultInspection = useJsonInspection(active && schema, result);
  const resultPreview = useMemo(() => {
    if (resultInspection.status !== 'ok') {
      return { valid: resultInspection.status === 'pending', value: null };
    }
    try {
      return { valid: true, value: JSON.parse(resultInspection.text) as unknown };
    } catch {
      return { valid: false, value: null };
    }
  }, [resultInspection]);
  // Auto-exit table mode when content becomes empty or invalid
  useEffect(() => {
    if (inputTableMode && (inputInspection.status !== 'ok' || !inputPreview.valid)) {
      setInputTableMode(false);
    }
  }, [inputInspection.status, inputPreview.valid, inputTableMode]);
  useEffect(() => {
    if (inputSchemaPreviewMode && !inputIsSchema) setInputSchemaPreviewMode(false);
  }, [inputIsSchema, inputSchemaPreviewMode]);
  useEffect(() => {
    if (
      resultTableMode &&
      (!result.trim() ||
        (resultInspection.status !== 'pending' && resultInspection.status !== 'ok'))
    ) {
      setResultTableMode(false);
    }
  }, [result, resultInspection.status, resultTableMode]);
  const pathExt = useMemo(
    () => [
      EditorView.lineWrapping,
      backendJSONPathCompletions(() => inputRef.current),
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
  const reportTransformFailure = (pane: 'input' | 'result', minify: boolean) => {
    if (!minify && pane === 'input') {
      setRepairPrompt(true);
      return;
    }
    toast.add({
      title: t(minify ? 'jsonTool.minifyFailed' : 'jsonTool.formatFailed'),
      description: t('jsonTool.invalidJsonDesc'),
      type: 'error',
    });
  };
  const requestAutoFormat = useCallback((source: string): Promise<string | null> => {
    if (!source.trim()) return Promise.resolve(source);
    const revision = ++autoFormatRevisionRef.current;
    if (autoFormatRequestRef.current) void autoFormatRequestRef.current.cancel();
    const request = TransformJSON({
      source,
      operation: 'autoFormat',
      stripComments: false,
    });
    autoFormatRequestRef.current = request;
    return request
      .then((response) => {
        if (revision !== autoFormatRevisionRef.current) return null;
        return response.error ? source : response.text;
      })
      .catch(() => (revision === autoFormatRevisionRef.current ? source : null))
      .finally(() => {
        if (autoFormatRequestRef.current === request) autoFormatRequestRef.current = null;
      });
  }, []);
  const runTransform = (pane: 'input' | 'result', minify: boolean, stripComments: boolean) => {
    const src = pane === 'input' ? input : result;
    const set = pane === 'input' ? setInput : setResult;
    const revision = ++transformRevisionRef.current;
    if (transformRequestRef.current) void transformRequestRef.current.cancel();
    const request = TransformJSON({
      source: src,
      operation: minify ? 'minify' : 'format',
      stripComments,
    });
    transformRequestRef.current = request;
    void request
      .then((response) => {
        if (
          revision !== transformRevisionRef.current ||
          (pane === 'input' ? inputRef.current : resultRef.current) !== src
        )
          return;
        if (response.error) {
          reportTransformFailure(pane, minify);
          return;
        }
        set(response.text);
        record(
          'json',
          minify ? t('jsonTool.minified') : t('jsonTool.formatted'),
          summary(response.text),
          response.text,
        );
      })
      .catch(() => {
        if (revision === transformRevisionRef.current) reportTransformFailure(pane, minify);
      })
      .finally(() => {
        if (transformRequestRef.current === request) transformRequestRef.current = null;
      });
  };
  const requestTransform = (pane: 'input' | 'result', minify: boolean) => {
    const source = pane === 'input' ? input : result;
    const revision = ++commentInspectionRevisionRef.current;
    if (commentInspectionRequestRef.current) void commentInspectionRequestRef.current.cancel();
    const request = InspectJSON(source);
    commentInspectionRequestRef.current = request;
    void request
      .then((response) => {
        if (
          revision !== commentInspectionRevisionRef.current ||
          (pane === 'input' ? inputRef.current : resultRef.current) !== source
        )
          return;
        if (response.hasComment) {
          setCommentDialog({ mode: minify ? 'minify' : 'format', pane });
          return;
        }
        runTransform(pane, minify, false);
      })
      .catch(() => {
        if (revision === commentInspectionRevisionRef.current) runTransform(pane, minify, false);
      })
      .finally(() => {
        if (commentInspectionRequestRef.current === request)
          commentInspectionRequestRef.current = null;
      });
  };
  const repairInput = () => {
    if (!input.trim() || repairing) return;
    const source = input;
    const revision = ++repairRevisionRef.current;
    if (repairRequestRef.current) void repairRequestRef.current.cancel();
    setRepairing(true);
    const request = RepairJSON(source);
    repairRequestRef.current = request;
    void request
      .then((response) => {
        if (revision !== repairRevisionRef.current) return;
        if (response.error) {
          toast.add({
            title: t('jsonTool.repairFailed'),
            description: t('jsonTool.repairFailedDesc'),
            type: 'error',
          });
          return;
        }
        if (!response.changed) {
          toast.add({ title: t('jsonTool.repairNoChange') });
          return;
        }
        setInput(response.text);
        toast.add({ title: t('jsonTool.repaired') });
        record(
          'json',
          t('jsonTool.repaired'),
          `${response.lines} ${t('jsonTool.lines')} · ${response.characters} ${t('jsonTool.characters')}`,
          response.text,
          '',
          { bytes: response.bytes },
        );
      })
      .catch(() => {
        if (revision !== repairRevisionRef.current) return;
        toast.add({
          title: t('jsonTool.repairFailed'),
          description: t('jsonTool.repairFailedDesc'),
          type: 'error',
        });
      })
      .finally(() => {
        if (repairRequestRef.current !== request) return;
        repairRequestRef.current = null;
        setRepairing(false);
      });
  };
  const changeInput = setInput;
  const loadPath = useCallback(
    async (path: string) => {
      try {
        const data = await readLocalFile(path, MAX_OPEN_BYTES);
        setInput(dataUrlToText(data.dataURL));
        toast.add({ title: t('jsonTool.fileLoaded', { name: data.name }) });
      } catch {
        toast.add({ title: t('jsonTool.openFileFailed'), type: 'error' });
      }
    },
    [t],
  );
  const fileDrop = useFileDrop({
    id: 'json-drop-zone',
    enabled: active,
    pick: {
      Title: t('jsonTool.openFileTitle'),
      ButtonText: t('jsonTool.openFile'),
      Filters: [{ DisplayName: t('jsonTool.filterJson'), Pattern: '*.json;*.json5' }],
      AllowsOtherFiletypes: true,
    },
    onPaths: (paths) => {
      const path = paths[0];
      if (path) void loadPath(path);
    },
    onError: () => toast.add({ title: t('jsonTool.openFileFailed'), type: 'error' }),
  });
  const toggleSchema = () => setMode((current) => (current === 'schema' ? 'plain' : 'schema'));
  const toggleInputTable = () => {
    setInputTableMode((current) => !current);
    setInputSchemaPreviewMode(false);
  };
  const toggleInputSchemaPreview = () => {
    setInputSchemaPreviewMode((current) => !current);
    setInputTableMode(false);
  };
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
  const schemaResultExt = useMemo(
    () => [json5Language, foldExt, jsonFoldParseWarmup, jsonFoldParseActive.of(active)],
    [active, foldExt],
  );
  const convertErrorMessage =
    conversion.status === 'error'
      ? t(
          `jsonTool.convert.errors.${conversion.error.code === 'backendError' ? 'failed' : conversion.error.code}`,
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
  const pipeline = useBackendPipelineEvaluation(pipelineMode, input, pipelineRules);
  const pipelineError = pipeline.evaluation.status === 'error' ? pipeline.evaluation.error : null;
  const pipelineReady = pipeline.evaluation.status === 'ok' && !!pipeline.evaluation.resultID;
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
      await Clipboard.SetText(serializePipeline(pipelineRules));
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
  const copyPipeline = async () => {
    if (pipelineError || !pipeline.evaluation.resultID) return;
    let text = '';
    try {
      text = await GetPipelineResultText(pipeline.evaluation.resultID);
    } catch {
      toast.add({ title: t('jsonTool.pipeline.copyFailed'), type: 'error' });
      return;
    }
    try {
      // 后端取值是异步的，await 之后再调 navigator.clipboard 会丢失用户激活导致写入被拒；
      // 用 Wails 原生剪贴板，失败也能显式提示。
      await Clipboard.SetText(text);
    } catch {
      toast.add({ title: t('jsonTool.pipeline.clipboardWriteFailed'), type: 'error' });
      return;
    }
    const bytes = new TextEncoder().encode(text).length;
    toast.add({ title: t('toast.copied', { value: `${bytes} ${t('jsonTool.bytes')}` }) });
    record('json', t('jsonTool.pipeline.copy'), `${bytes} ${t('jsonTool.bytes')}`, input, text);
  };
  const copyPane = async (pane: 'input' | 'result') => {
    const value = pane === 'input' ? input : result;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.add({ title: t('toast.copyFailed'), type: 'error' });
      return;
    }
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
      actions.push(
        {
          key: 'repair',
          label: t('jsonTool.repair'),
          icon: Wrench,
          variant: 'secondary',
          disabled: !value || repairing,
          onPress: repairInput,
        },
        {
          key: 'format',
          label: t('jsonTool.format'),
          variant: 'primary',
          disabled: !value,
          onPress: () => requestTransform(pane, false),
        },
      );
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
          key: 'importExport',
          label: t('jsonTool.pipeline.importExport'),
          type: 'menu',
          options: [
            { key: 'import', label: t('jsonTool.pipeline.importConfig') },
            { key: 'export', label: t('jsonTool.pipeline.exportConfig') },
          ],
          onSelect: (value) => {
            if (value === 'import') void importPipeline();
            else if (value === 'export') void exportPipeline();
          },
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
          disabled: !!pipelineError || !pipelineReady,
          onPress: copyPipeline,
        },
      ]}
    />
  );
  const footerGridClass = convertMode
    ? 'grid-cols-1'
    : pipelineMode
      ? 'grid-cols-2'
      : schema
        ? 'grid-cols-2'
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
    if (pending.action === 'repair') {
      repairInput();
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
      void (async () => {
        try {
          await navigator.clipboard.writeText(toCopy);
          const bytes = new TextEncoder().encode(toCopy).length;
          toast.add({ title: t('toast.copied', { value: `${bytes} ${t('jsonTool.bytes')}` }) });
          record('json', t('jsonTool.copied'), `${bytes} ${t('jsonTool.bytes')}`, toCopy);
        } catch {
          toast.add({ title: t('toast.copyFailed'), type: 'error' });
        }
      })();
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
      const revision = ++validateRevisionRef.current;
      if (validateRequestRef.current) void validateRequestRef.current.cancel();
      const request = ValidateJSON(pending.input);
      validateRequestRef.current = request;
      void request
        .then((response) => {
          if (revision !== validateRevisionRef.current) return;
          record(
            'json',
            response.valid ? t('jsonTool.validated') : t('jsonTool.invalid'),
            summary(pending.input),
            pending.input,
          );
        })
        .catch(() => {
          if (revision === validateRevisionRef.current)
            record('json', t('jsonTool.invalid'), summary(pending.input), pending.input);
        })
        .finally(() => {
          if (validateRequestRef.current === request) validateRequestRef.current = null;
        });
      return;
    }
    if (!autoFormatRef.current) {
      changeInput(pending.input);
      return;
    }
    void requestAutoFormat(pending.input).then((next) => {
      if (next === null || inputRef.current !== pending.input) return;
      changeInput(next);
      if (next !== pending.input) record('json', t('jsonTool.formatted'), summary(next), next);
    });
  }, [pending, pipeline, requestAutoFormat]);
  useEffect(() => {
    const onFill = () => {
      if (!autoFormatRef.current) return;
      const view = views.current.get('input');
      if (!view) return;
      const src = view.state.doc.toString();
      void requestAutoFormat(src).then((next) => {
        if (
          next !== null &&
          next !== src &&
          views.current.get('input')?.state.doc.toString() === src
        )
          setInput(next);
      });
    };
    window.addEventListener('tinkerkit:json-after-fill', onFill);
    return () => window.removeEventListener('tinkerkit:json-after-fill', onFill);
  }, [requestAutoFormat]);
  useEffect(() => {
    if (!schema) return;
    if (schemaEvaluation.status === 'idle' || schemaEvaluation.status === 'pending') {
      setPathError('');
      return;
    }
    if (schemaEvaluation.status === 'empty') {
      setResult('');
      setPathError('');
      return;
    }
    if (schemaEvaluation.status === 'error') {
      setResult('');
      setPathError(
        fmtPathError(
          schemaEvaluation.code === 'backendError' ? 'pathNotFound' : schemaEvaluation.code,
          schemaEvaluation.params,
        ),
      );
      return;
    }
    setResult(schemaEvaluation.text);
    setPathError('');
  }, [schema, schemaEvaluation]);
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
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-none gap-1.5 px-2.5 text-[11px]"
                onClick={() => void fileDrop.pick()}
              >
                <UploadSimple data-icon="inline-start" weight="duotone" />
                {t('jsonTool.openFile')}
              </Button>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={autoFormatOnFill}
                  onCheckedChange={(checked) => onAutoFormatOnFillChange(checked)}
                />
                <span>{t('jsonTool.autoFormatOnFill')}</span>
              </Label>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={showInvisibleChars}
                  onCheckedChange={(checked) => setShowInvisibleChars(checked === true)}
                />
                <span>{t('jsonTool.showInvisibleChars')}</span>
              </Label>
            </>
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
          <div
            className="json-content relative h-full min-h-0 overflow-hidden"
            {...fileDrop.dropProps}
          >
            {fileDrop.over ? (
              <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border border-dashed border-primary bg-primary/10 text-primary">
                <span className="flex items-center gap-2 text-xs font-medium">
                  <UploadSimple size={16} weight="duotone" />
                  {t('fileDrop.release')}
                </span>
              </div>
            ) : null}
            <div ref={splitRootRef} className="json-schema-layout h-full min-h-0 min-w-0">
              <ResizablePanelGroup
                id="json-main-split"
                orientation={splitOrientation}
                className="min-h-0 min-w-0"
              >
                <ResizablePanel
                  key="primary"
                  id={`json-primary-${mainLayoutKey}`}
                  defaultSize={splitMode ? '50%' : '100%'}
                  minSize={splitOrientation === 'vertical' ? '25%' : 220}
                  className="min-h-0 min-w-0"
                >
                  <ResizablePanelGroup
                    id="json-pipeline-split"
                    orientation="vertical"
                    className="json-pipeline-source min-h-0 min-w-0"
                  >
                    <ResizablePanel
                      id={`json-pipeline-input-${pipelineLayoutKey}`}
                      defaultSize={pipelineMode ? '50%' : '100%'}
                      minSize="20%"
                      className="min-h-0 min-w-0"
                    >
                      <div className="flex h-full min-h-0 min-w-0 flex-col">
                        <JsonEditorPane
                          label={t('jsonTool.input')}
                          value={input}
                          onChange={changeInput}
                          foldExt={foldExt}
                          onCreate={(v) => views.current.set('input', v)}
                          theme={cmTheme}
                          showInvisibleChars={showInvisibleChars}
                          emptyHint
                          cmClassName="json-input-cm"
                          formatOnPaste={autoFormatOnFill ? requestAutoFormat : undefined}
                          tableMode={inputTableMode}
                          active={active}
                          tableDisabled={!input.trim() || inputInspection.status !== 'ok'}
                          tableHint={t('jsonTool.tablePreviewInvalid')}
                          onToggleTable={toggleInputTable}
                          tablePreview={
                            inputTableMode && active ? (
                              <JsonTablePreview value={inputPreview.value} t={t} />
                            ) : null
                          }
                          schemaMode={inputSchemaPreviewMode}
                          onToggleSchema={inputIsSchema ? toggleInputSchemaPreview : undefined}
                          schemaPreview={
                            inputSchemaPreviewMode && active && inputIsSchema ? (
                              <JsonSchemaPreview value={inputPreview.value} />
                            ) : null
                          }
                          onOpenFile={() => void fileDrop.pick()}
                        />
                      </div>
                    </ResizablePanel>
                    {pipelineMode ? (
                      <ResizableHandle
                        key="pipeline-handle"
                        variant="handle"
                        className="my-1"
                        aria-label={t('jsonTool.resizePanels')}
                      />
                    ) : null}
                    <ResizablePanel
                      id={`json-pipeline-output-${pipelineLayoutKey}`}
                      defaultSize={pipelineMode ? '50%' : 0}
                      minSize={pipelineMode ? '20%' : 0}
                      maxSize={pipelineMode ? '100%' : 0}
                      className="min-h-0 min-w-0"
                    >
                      <div
                        className={`json-pipeline-output-slot h-full min-h-0 min-w-0${pipelineMode ? '' : ' invisible pointer-events-none'}`}
                        aria-hidden={!pipelineMode}
                        {...(!pipelineMode ? { inert: true } : {})}
                      >
                        <PipelineOutputPane
                          evaluation={pipeline.evaluation}
                          theme={cmTheme}
                          foldExt={foldExt}
                        />
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </ResizablePanel>
                {splitMode ? (
                  <ResizableHandle
                    key="main-handle"
                    variant="handle"
                    className={splitOrientation === 'vertical' ? 'my-1' : 'mx-1'}
                    aria-label={t('jsonTool.resizePanels')}
                  />
                ) : null}
                <ResizablePanel
                  key="secondary"
                  id={`json-secondary-${mainLayoutKey}`}
                  defaultSize={splitMode ? '50%' : 0}
                  minSize={splitMode ? (splitOrientation === 'vertical' ? '25%' : 220) : 0}
                  maxSize={splitMode ? '100%' : 0}
                  className="min-h-0 min-w-0"
                >
                  <div className="relative h-full min-h-0 min-w-0">
                    <div
                      className={`json-convert-pane flex h-full min-h-0 min-w-0 flex-col gap-2${modeHostHidden(convertMode)}`}
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
                          if (
                            value === 'xml' ||
                            value === 'toml' ||
                            value === 'yaml' ||
                            value === 'csv'
                          )
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
                          <SelectGroup>
                            {convertFormats.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
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
                    <ResizablePanelGroup
                      id="json-schema-split"
                      orientation="vertical"
                      className={`json-schema-right min-h-0 min-w-0${schema ? '' : modeHostHidden(false)}`}
                      aria-hidden={!schema}
                      {...(!schema ? { inert: true } : {})}
                    >
                      <ResizablePanel
                        id="json-path"
                        defaultSize="14.2857%"
                        minSize={60}
                        className="min-h-0 min-w-0"
                      >
                        <div className="json-path flex h-full min-w-0 flex-col gap-2 min-h-0">
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
                      </ResizablePanel>
                      <ResizableHandle
                        variant="handle"
                        className="my-1"
                        aria-label={t('jsonTool.resizePanels')}
                      />
                      <ResizablePanel
                        id="json-result"
                        defaultSize="85.7143%"
                        minSize={120}
                        className="min-h-0 min-w-0"
                      >
                        <div className="json-pane flex h-full min-h-0 min-w-0 flex-col gap-2">
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
                            {schemaEvaluation.status === 'pending' ? (
                              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-card/70">
                                <Spinner className="size-5" />
                              </div>
                            ) : null}
                            {pathError ? (
                              <div className="absolute inset-0 z-10 flex min-h-0">
                                <JsonErrorPanel
                                  title={t('jsonTool.pipeline.errorTitle')}
                                  description={pathError}
                                />
                              </div>
                            ) : null}
                            {!pathError && resultTableMode && active && (
                              <div className="json-table-layer is-visible">
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
                      </ResizablePanel>
                    </ResizablePanelGroup>
                    <div
                      className={`json-pipeline-slot min-h-0 min-w-0${
                        pipelineMode ? ' h-full overflow-hidden' : modeHostHidden(false)
                      }`}
                      aria-hidden={!pipelineMode}
                      {...(!pipelineMode ? { inert: true } : {})}
                    >
                      <PipelinePanel
                        context={pipeline.context}
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
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
            <div className={`detected hidden${input && !jsonValue ? ' invalid' : ''}`}>
              <span>{t('jsonTool.detected')}</span>
              {input ? (
                <strong className={jsonValue ? undefined : 'empty'}>
                  {jsonValue ? `${t('jsonTool.valid')} · ${summary(input)}` : t('jsonTool.invalid')}
                </strong>
              ) : (
                <strong className="empty">
                  <Trans i18nKey="jsonTool.placeholder" components={{ open: <span /> }} />
                </strong>
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
      <AlertDialog
        open={repairPrompt}
        onOpenChange={(open) => {
          if (!open) setRepairPrompt(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('jsonTool.formatFailed')}</AlertDialogTitle>
            <AlertDialogDescription>{t('jsonTool.repairPrompt')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('jsonTool.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={repairing}
              onClick={() => {
                setRepairPrompt(false);
                repairInput();
              }}
            >
              {t('jsonTool.repair')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Reveal>
  );
}
