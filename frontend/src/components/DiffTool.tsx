import { useEffect, useRef, useState } from 'react';
import { minimalSetup } from 'codemirror';
import { MergeView, type Chunk } from '@codemirror/merge';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  lineNumbers,
  type DecorationSet,
  ViewPlugin,
} from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { quietEditorTheme } from './codeMirrorTheme';
import { ArrowsLeftRight, Info, Trash } from '@phosphor-icons/react';
import { Tooltip } from '@base-ui/react/tooltip';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
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
import {
  Reveal,
  ToolActionBar,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
  ToolLayoutToolbarGroup,
  type PendingAction,
} from './shared';
import '../styles/tools/editor.css';
import '../styles/tools/diff.css';

type Counts = { deletions: number; additions: number };
const diffTheme = EditorView.theme({
  '&': {
    height: '100%!important',
    overflow: 'visible!important',
    backgroundColor: 'var(--card)',
  },
  '.cm-scroller': {
    height: '100%!important',
    overflowY: 'visible!important',
  },
  '.cm-content': { padding: '9px 0 20px' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-indent-markers::before': { left: '8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    border: 0,
    color: 'var(--muted-foreground)',
  },
  '.cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '38px', textAlign: 'right' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '1px', background: 'transparent' },
  '&.cm-merge-a .cm-changedLineGutter, &.cm-merge-a .cm-deletedLineGutter': {
    backgroundColor: 'var(--destructive)',
  },
  '&.cm-merge-b .cm-changedLineGutter': { backgroundColor: 'var(--success)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-merge-a .cm-changedLine': {
    backgroundColor: 'color-mix(in srgb,var(--destructive) 10%,transparent)',
  },
  '&.cm-merge-b .cm-changedLine': {
    backgroundColor: 'color-mix(in srgb,var(--success) 10%,transparent)',
  },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb,var(--destructive) 12%,transparent)' },
  '.cm-insertedLine': { backgroundColor: 'color-mix(in srgb,var(--success) 14%,transparent)' },
  '&.cm-merge-a .cm-changedText': {
    backgroundColor: 'color-mix(in srgb,var(--destructive) 36%,transparent)',
  },
  '&.cm-merge-b .cm-changedText': {
    backgroundColor: 'color-mix(in srgb,var(--success) 36%,transparent)',
  },
});
function changedLines(chunks: readonly Chunk[], view: MergeView): Counts {
  let deletions = 0,
    additions = 0;
  for (const chunk of chunks) {
    if (chunk.toA > chunk.fromA)
      deletions +=
        view.a.state.doc.lineAt(Math.max(chunk.fromA, chunk.toA - 1)).number -
        view.a.state.doc.lineAt(chunk.fromA).number +
        1;
    if (chunk.toB > chunk.fromB)
      additions +=
        view.b.state.doc.lineAt(Math.max(chunk.fromB, chunk.toB - 1)).number -
        view.b.state.doc.lineAt(chunk.fromB).number +
        1;
  }
  return { deletions, additions };
}
function zigSyntax(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  const matcher =
    /\/\/.*|"(?:\\.|[^"\\])*"|@[A-Za-z_]\w*|\b(?:const|var|pub|fn|defer|try|true|false|void)\b|\b(?:i\d+|u\d+|usize|isize|Allocator|ArrayList|GeneralPurposeAllocator)\b|\b\d+\b|[=!+*/<>-]+/gu;
  for (let lineNo = 1; lineNo <= view.state.doc.lines; lineNo++) {
    const line = view.state.doc.line(lineNo);
    const source = line.text;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(source))) {
      const token = match[0];
      const className = token.startsWith('//')
        ? 'cm-zig-comment'
        : token.startsWith('"')
          ? 'cm-zig-string'
          : token.startsWith('@')
            ? 'cm-zig-builtin'
            : /^(?:const|var|pub|fn|defer|try|true|false|void)$/.test(token)
              ? 'cm-zig-keyword'
              : /^(?:i\d+|u\d+|usize|isize|Allocator|ArrayList|GeneralPurposeAllocator)$/.test(
                    token,
                  )
                ? 'cm-zig-type'
                : /^\d+$/.test(token)
                  ? 'cm-zig-number'
                  : 'cm-zig-operator';
      builder.add(
        line.from + match.index,
        line.from + match.index + token.length,
        Decoration.mark({ class: className }),
      );
    }
  }
  return builder.finish();
}
const zigHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = zigSyntax(view);
    }
    update(update) {
      if (update.docChanged) this.decorations = zigSyntax(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);
const languageLoaders: Record<string, () => Promise<Extension>> = {
  'C++': () => import('@codemirror/lang-cpp').then((module) => module.cpp()),
  'C#': () =>
    import('@codemirror/legacy-modes/mode/clike').then((module) =>
      StreamLanguage.define(module.csharp),
    ),
  CSS: () => import('@codemirror/lang-css').then((module) => module.css()),
  Go: () => import('@codemirror/lang-go').then((module) => module.go()),
  HTML: () => import('@codemirror/lang-html').then((module) => module.html()),
  Java: () => import('@codemirror/lang-java').then((module) => module.java()),
  JavaScript: () => import('@codemirror/lang-javascript').then((module) => module.javascript()),
  JSON: () => Promise.resolve(json()),
  JSX: () =>
    import('@codemirror/lang-javascript').then((module) => module.javascript({ jsx: true })),
  Markdown: () => import('@codemirror/lang-markdown').then((module) => module.markdown()),
  PHP: () => import('@codemirror/lang-php').then((module) => module.php()),
  Python: () => import('@codemirror/lang-python').then((module) => module.python()),
  Rust: () => import('@codemirror/lang-rust').then((module) => module.rust()),
  Shell: () =>
    import('@codemirror/legacy-modes/mode/shell').then((module) =>
      StreamLanguage.define(module.shell),
    ),
  SQL: () => import('@codemirror/lang-sql').then((module) => module.sql()),
  TypeScript: () =>
    import('@codemirror/lang-javascript').then((module) => module.javascript({ typescript: true })),
  XML: () => import('@codemirror/lang-xml').then((module) => module.xml()),
  YAML: () => import('@codemirror/lang-yaml').then((module) => module.yaml()),
};
function detectLanguage(value: string) {
  const source = value.trim();
  if (!source) return 'Plain Text';
  if (/^<\?php\b/i.test(source)) return 'PHP';
  if (/^<\?xml\b/i.test(source)) return 'XML';
  if (/<!doctype\s+html|<html\b|<(?:div|main|section|script|style|body|head)\b/i.test(source))
    return 'HTML';
  if (
    (source.startsWith('{') || source.startsWith('[')) &&
    (/^[\[{]\s*[\]}]$/.test(source) || /"(?:[^"\\]|\\.)*"\s*:/.test(source))
  )
    return 'JSON';
  if (
    /\b@import\s*\(|\bpub\s+fn\b|\bconst\s+\w+\s*=\s*@import\b|\b(?:defer|try)\s+\w+/.test(source)
  )
    return 'Zig';
  if (
    /^#!.*\b(?:ba|z|k)?sh\b/m.test(source) ||
    /^(?:export\s+\w+=|echo\s+|set\s+-[a-z]|(?:if|for|while)\s+.*;\s*then\b)/m.test(source)
  )
    return 'Shell';
  if (
    /^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|WITH)\b[\s\S]*\b(?:FROM|VALUES|SET|TABLE|AS)\b/im.test(
      source,
    )
  )
    return 'SQL';
  if (
    /^\s*(?:package\s+\w+|func\s+\w+\s*\(|import\s+\(?\s*"[^"\n]+")/m.test(source) ||
    /:=/.test(source)
  )
    return 'Go';
  if (
    /\bfn\s+\w+\s*\([^)]*\)(?:\s*->\s*[^\s{]+)?\s*\{|\blet\s+mut\b|\bimpl\s+\w+|\buse\s+[\w:]+::/.test(
      source,
    )
  )
    return 'Rust';
  if (
    /^\s*(?:using\s+System|namespace\s+\w+)|\bConsole\.WriteLine\b|\b(?:public|private)\s+(?:sealed\s+)?class\s+\w+/m.test(
      source,
    )
  )
    return 'C#';
  if (
    /^\s*(?:package\s+[\w.]+;|import\s+java\.)|\bpublic\s+(?:static\s+)?class\s+\w+|\bSystem\.out\./m.test(
      source,
    )
  )
    return 'Java';
  if (
    /^\s*#\s*include\b|\bstd::|\b(?:printf|scanf|cout|cin)\s*(?:\(|<<|>>)|\bint\s+main\s*\(/m.test(
      source,
    )
  )
    return 'C++';
  if (
    /^\s*(?:def|class)\s+\w+.*:|^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)|\b(?:print|len|range)\s*\(/m.test(
      source,
    )
  )
    return 'Python';
  if (
    /\binterface\s+\w+|\btype\s+\w+\s*=|\bimport\s+type\b|\b(?:const|let|var)\s+\w+\s*:\s*[A-Za-z_$]|\bas\s+const\b/.test(
      source,
    )
  )
    return 'TypeScript';
  if (/<\/?[A-Z][A-Za-z0-9.]*\b|\breturn\s*\(\s*</.test(source)) return 'JSX';
  if (
    /\b(?:const|let|var)\s+\w+|=>|\bfunction\s+\w+\s*\(|\bconsole\.(?:log|warn|error)\b/.test(
      source,
    )
  )
    return 'JavaScript';
  if (/^(?:#{1,6}\s+|```|>\s+|[-*+]\s+|\d+\.\s+)/m.test(source)) return 'Markdown';
  if (
    /(?:^|\})\s*[.#]?[A-Za-z][\w-]*(?:\s+[.#]?[\w-]+)*\s*\{[^{}]*[\w-]+\s*:[^{}]+\}/m.test(source)
  )
    return 'CSS';
  if (/^---\s*$|^(?:[\w.-]+|"[^"]+"):\s*(?:[^{}\[\n].*)?$|^\s*-\s+\w+/m.test(source)) return 'YAML';
  return 'Plain Text';
}
function DiffMerge({
  before,
  after,
  theme,
  languageExtensions,
  lastFilled,
  fillLabel,
  active,
  collapseUnchanged,
  aLabel,
  bLabel,
  onBeforeChange,
  onAfterChange,
  onCountsChange,
}: {
  before: string;
  after: string;
  theme: string;
  languageExtensions: Extension[];
  lastFilled: 'before' | 'after' | null;
  fillLabel: string;
  active: boolean;
  collapseUnchanged: boolean;
  aLabel: string;
  bLabel: string;
  onBeforeChange: (value: string) => void;
  onAfterChange: (value: string) => void;
  onCountsChange: (counts: Counts) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const callbacks = useRef({ onBeforeChange, onAfterChange, onCountsChange });
  callbacks.current = { onBeforeChange, onAfterChange, onCountsChange };
  useEffect(() => {
    if (!host.current) return;
    let merge: MergeView;
    const refresh = () => callbacks.current.onCountsChange(changedLines(merge.chunks, merge));
    const update = (side: 'a' | 'b') =>
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        callbacks.current[side === 'a' ? 'onBeforeChange' : 'onAfterChange'](
          update.state.doc.toString(),
        );
        queueMicrotask(refresh);
      });
    merge = new MergeView({
      parent: host.current,
      a: {
        doc: before,
        extensions: [
          minimalSetup,
          lineNumbers(),
          quietEditorTheme,
          diffTheme,
          ...languageExtensions,
          update('a'),
        ],
      },
      b: {
        doc: after,
        extensions: [
          minimalSetup,
          lineNumbers(),
          quietEditorTheme,
          diffTheme,
          ...languageExtensions,
          update('b'),
        ],
      },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: collapseUnchanged ? { margin: 3, minSize: 4 } : undefined,
      diffConfig: { scanLimit: 3000, timeout: 1000 },
    });
    mergeRef.current = merge;
    merge.a.contentDOM.setAttribute('aria-label', aLabel);
    merge.b.contentDOM.setAttribute('aria-label', bLabel);
    const scrollA = merge.a.scrollDOM,
      scrollB = merge.b.scrollDOM;
    let syncSource: 'a' | 'b' | null = null;
    let rafId: number | null = null;
    let disposed = false;
    const scheduleSync = (source: 'a' | 'b') => {
      syncSource = source;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (disposed || !syncSource) return;
        const currentSource = syncSource;
        syncSource = null;
        const sourceScroll = currentSource === 'a' ? scrollA : scrollB;
        const targetScroll = currentSource === 'a' ? scrollB : scrollA;
        if (
          targetScroll.scrollTop === sourceScroll.scrollTop &&
          targetScroll.scrollLeft === sourceScroll.scrollLeft
        )
          return;
        targetScroll.scrollTop = sourceScroll.scrollTop;
        targetScroll.scrollLeft = sourceScroll.scrollLeft;
      });
    };
    const onScrollA = () => scheduleSync('a');
    const onScrollB = () => scheduleSync('b');
    scrollA.addEventListener('scroll', onScrollA, { passive: true });
    scrollB.addEventListener('scroll', onScrollB, { passive: true });
    const onPaneDown = (view: EditorView) => (event: MouseEvent) => {
      if (view.contentDOM.contains(event.target as Node)) return;
      event.preventDefault();
      if (view.state.doc.length === 0) view.dispatch({ selection: { anchor: 0 } });
      view.focus();
    };
    const onDownA = onPaneDown(merge.a),
      onDownB = onPaneDown(merge.b);
    merge.a.dom.addEventListener('mousedown', onDownA);
    merge.b.dom.addEventListener('mousedown', onDownB);
    refresh();
    return () => {
      scrollA.removeEventListener('scroll', onScrollA);
      scrollB.removeEventListener('scroll', onScrollB);
      merge.a.dom.removeEventListener('mousedown', onDownA);
      merge.b.dom.removeEventListener('mousedown', onDownB);
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      syncSource = null;
      mergeRef.current = null;
      merge.destroy();
    };
  }, [theme, languageExtensions, collapseUnchanged, aLabel, bLabel]);
  useEffect(() => {
    const m = mergeRef.current;
    if (!m) return;
    const adoc = m.a.state.doc.toString(),
      bdoc = m.b.state.doc.toString();
    if (adoc !== before) m.a.dispatch({ changes: { from: 0, to: adoc.length, insert: before } });
    if (bdoc !== after) m.b.dispatch({ changes: { from: 0, to: bdoc.length, insert: after } });
  }, [before, after]);
  useEffect(() => {
    if (active) mergeRef.current?.a.focus();
  }, [active]);
  return (
    <div className="diff-merge-wrap h-full min-h-0 min-w-0">
      <div
        ref={host}
        className="diff-merge-host h-full min-h-0 min-w-0 overflow-hidden border-0 bg-card [--wails-draggable:no-drag] select-text"
      />
      {lastFilled && (
        <div className={`diff-fill-notice diff-fill-notice--${lastFilled}`} role="status">
          {fillLabel}
        </div>
      )}
    </div>
  );
}
export default function DiffTool({
  active,
  theme,
  clipboardTargetMode,
  onClipboardTargetModeChange,
  pending,
  clearPending,
}: {
  active: boolean;
  theme: string;
  clipboardTargetMode: string;
  onClipboardTargetModeChange: (mode: 'alternate' | 'before' | 'after') => void;
  record?: unknown;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [lastFilled, setLastFilled] = useState<'before' | 'after' | null>(null);
  const [collapseUnchanged, setCollapseUnchanged] = useState(false);
  const noticeTimer = useRef<number | null>(null);
  const targetMode =
    clipboardTargetMode === 'before' || clipboardTargetMode === 'after'
      ? clipboardTargetMode
      : 'alternate';
  const [, setCounts] = useState<Counts>({ deletions: 0, additions: 0 });
  const detectedLanguage = detectLanguage(`${before}\n${after}`);
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([]);
  const consumed = useRef<PendingAction | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    if (detectedLanguage === 'Plain Text') {
      setLanguageExtensions([]);
      return () => {
        cancelled = true;
      };
    }
    if (detectedLanguage === 'Zig') {
      setLanguageExtensions([zigHighlight]);
      return () => {
        cancelled = true;
      };
    }
    const load = languageLoaders[detectedLanguage];
    if (!load) {
      setLanguageExtensions([]);
      return () => {
        cancelled = true;
      };
    }
    load()
      .then((extension) => {
        if (!cancelled) setLanguageExtensions([extension]);
      })
      .catch(() => {
        if (!cancelled) setLanguageExtensions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [detectedLanguage]);
  useEffect(() => {
    if (!pending || pending === consumed.current || pending.tool !== 'diff') return;
    consumed.current = pending;
    if (pending.action === 'swap' || pending.action === 'clear') {
      pending.action === 'swap' ? swap() : clear();
      clearPending();
      return;
    }
    const target = pending.target ?? 'before';
    if (target === 'before') setBefore(pending.input);
    else setAfter(pending.input);
    if (pending.output !== undefined) {
      if (target === 'before') setAfter(pending.output);
      else setBefore(pending.output);
    }
    setLastFilled(target);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setLastFilled(null), 2200);
    clearPending();
  }, [pending, clearPending]);
  const clear = () => {
    setBefore('');
    setAfter('');
  };
  const swap = () => {
    setBefore(after);
    setAfter(before);
  };
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout className="diff-tool-layout [container-type:inline-size]">
        <ToolLayoutHeader title={t('diffTool.title')} />
        <ToolLayoutToolbar
          left={
            <div className="flex h-8 flex-none items-center gap-2 text-[11px] text-muted-foreground">
              <span id="diff-clipboard-target-label" className="whitespace-nowrap">
                {t('diffTool.clipboardTarget')}
              </span>
              <Select
                value={targetMode}
                items={(['alternate', 'before', 'after'] as const).map((key) => ({
                  value: key,
                  label: t(`diffTool.targets.${key}`),
                }))}
                onValueChange={(value) => {
                  if (value === 'before' || value === 'after' || value === 'alternate')
                    onClipboardTargetModeChange(value);
                }}
              >
                <SelectTrigger
                  className="h-8 w-32 flex-none text-[11px]"
                  aria-labelledby="diff-clipboard-target-label"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(['alternate', 'before', 'after'] as const).map((key) => (
                      <SelectItem key={key} value={key}>
                        {t(`diffTool.targets.${key}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Tooltip.Root>
                <Tooltip.Trigger
                  delay={300}
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-6 min-w-6 flex-none"
                      aria-label={t('diffTool.clipboardTargetHintLabel')}
                    />
                  }
                >
                  <Info />
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Positioner className="isolate z-50" side="bottom" sideOffset={6}>
                    <Tooltip.Popup className="relative isolate z-50 max-w-72 origin-(--transform-origin) rounded-md bg-popover px-2.5 py-2 text-xs leading-relaxed text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                      {t('diffTool.clipboardTargetHint')}
                    </Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
            </div>
          }
          right={
            <ToolLayoutToolbarGroup>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <span>{t('diffTool.collapseUnchanged')}</span>
                <Switch
                  checked={collapseUnchanged}
                  onCheckedChange={() => setCollapseUnchanged((value) => !value)}
                  size="sm"
                />
              </Label>
            </ToolLayoutToolbarGroup>
          }
        />
        <ToolLayoutContent>
          <div className="diff-tool-content grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-none">
            <DiffMerge
              before={before}
              after={after}
              theme={theme}
              languageExtensions={languageExtensions}
              collapseUnchanged={collapseUnchanged}
              lastFilled={lastFilled}
              fillLabel={lastFilled ? t(`diffTool.filled.${lastFilled}`) : ''}
              aLabel={t('diffTool.before')}
              bLabel={t('diffTool.after')}
              active={active}
              onBeforeChange={setBefore}
              onAfterChange={setAfter}
              onCountsChange={setCounts}
            />
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('diffTool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('diffTool.clear'),
                icon: Trash,
                variant: 'tertiary',
                disabled: !before && !after,
                onPress: clear,
              },
              {
                key: 'swap',
                label: t('diffTool.swap'),
                icon: ArrowsLeftRight,
                variant: 'secondary',
                disabled: !before && !after,
                onPress: swap,
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>
    </Reveal>
  );
}
