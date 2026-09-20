import {
  codeFolding,
  foldable,
  foldEffect,
  foldedRanges,
  forceParsing,
  getIndentUnit,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  syntaxTreeAvailable,
  unfoldEffect,
} from '@codemirror/language';
import { Facet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { appSearchPanel } from './codeMirrorSearchPanel';

const indentMarkerColor = 'color-mix(in srgb, var(--muted-foreground) 20%, transparent)';
const indentMarkerActive = 'color-mix(in srgb, var(--primary) 30%, transparent)';
const indentMarkerThickness = 1;
const indentMarkerActiveThickness = 1.5;
const indentGuides = indentationMarkers({
  highlightActiveBlock: true,
  hideFirstIndent: false,
  markerType: 'fullScope',
  thickness: indentMarkerThickness,
  activeThickness: indentMarkerActiveThickness,
  colors: {
    light: indentMarkerColor,
    dark: indentMarkerColor,
    activeLight: indentMarkerActive,
    activeDark: indentMarkerActive,
  },
});

const quietBase = EditorView.theme({
  '&': { backgroundColor: 'var(--card)', color: 'var(--foreground)' },
  '.cm-content': { caretColor: 'var(--primary)' },
  '.cm-cursor,.cm-dropCursor': { borderLeftColor: 'var(--primary)' },
  '&.cm-focused .cm-selectionBackground,.cm-selectionBackground,.cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb,var(--primary) 24%,transparent)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb,var(--primary) 5%,transparent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'var(--muted-foreground)',
    borderRight: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb,var(--primary) 8%,transparent)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 12%, transparent)',
    borderColor: 'var(--border)',
    color: 'var(--primary)',
  },
  '.cm-indent-markers::before': {
    left: '6px',
    zIndex: '0',
  },
  '.cm-indent-markers.cm-indent-guide-hover::before': {
    background: 'var(--indent-hover-layer), var(--indent-markers)',
  },
  '.cm-indent-guide-foldable': {
    cursor: 'pointer',
  },
});
const quietSyntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: 'var(--destructive)' },
  {
    tag: [tags.name, tags.variableName, tags.propertyName, tags.attributeName],
    color: 'var(--foreground)',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--primary)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--warning)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--muted-foreground)',
    fontStyle: 'italic',
  },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: 'var(--foreground)' },
  { tag: [tags.invalid], color: 'var(--destructive)', textDecoration: 'underline' },
]);
function visualIndentColumns(text: string, tabSize: number) {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\t') col += tabSize - (col % tabSize);
    else if (ch === ' ' || ch === '\u00A0') col += 1;
    else break;
  }
  return col;
}

function clickedGuideColumn(view: EditorView, event: MouseEvent, lineFrom: number) {
  const start = view.coordsAtPos(lineFrom);
  if (!start) return null;
  const unit = getIndentUnit(view.state);
  if (unit <= 0) return null;
  const ch = view.defaultCharacterWidth;
  if (ch <= 0) return null;
  const relX = event.clientX - start.left;
  const level = Math.round((relX / ch - 0.5) / unit);
  if (level < 0) return null;
  const guideX = (level * unit + 0.5) * ch;
  const hitSlop = Math.min(Math.max(4, ch * 0.4), unit * ch * 0.4);
  if (Math.abs(relX - guideX) > hitSlop) return null;
  return level * unit;
}

function foldRangeForGuide(view: EditorView, lineFrom: number, column: number) {
  if (syntaxTree(view.state).length === 0) return null;
  let block = view.lineBlockAt(lineFrom);
  for (;;) {
    const range = foldable(view.state, block.from, block.to);
    if (range && range.to > lineFrom) {
      const openLine = view.state.doc.lineAt(range.from);
      if (visualIndentColumns(openLine.text, view.state.tabSize) === column) return range;
    }
    if (!block.from) return null;
    block = view.lineBlockAt(block.from - 1);
  }
}

function matchingFold(view: EditorView, range: { from: number; to: number }) {
  let found: { from: number; to: number } | null = null;
  foldedRanges(view.state).between(range.from, range.to, (start, end) => {
    if (start === range.from && end === range.to) found = { from: start, to: end };
  });
  return found;
}

function leadingWhitespaceLength(text: string) {
  const match = /^[ \t]*/.exec(text);
  return match ? match[0].length : 0;
}

function pointerGuideTarget(view: EditorView, event: MouseEvent) {
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  if (target.closest('.cm-foldPlaceholder, .cm-gutter')) return null;
  if (!target.closest('.cm-indent-markers')) return null;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  const empty = !line.text.trim();
  const indentCols = visualIndentColumns(line.text, view.state.tabSize);
  const indentEnd = line.from + leadingWhitespaceLength(line.text);
  if (!empty && pos >= indentEnd) return null;
  const column = clickedGuideColumn(view, event, line.from);
  if (column == null) return null;
  if (!empty && column >= indentCols) return null;
  return { lineFrom: line.from, column, empty };
}

const jsonFoldParseEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});
const jsonFoldParseClickMs = 40;
const jsonFoldParseTimeoutBudgetMs = 4;
const jsonFoldParseTimerDelayMs = 16;
const jsonFoldParseTimerBudgetMs = 8;

type IndentHover = { seedFrom: number; column: number };

const setIndentHover = StateEffect.define<IndentHover | null>();

const indentHoverField = StateField.define<IndentHover | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setIndentHover)) return effect.value;
    }
    if (tr.docChanged) return null;
    return value;
  },
});

function hoverEq(a: IndentHover | null, b: IndentHover | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.seedFrom === b.seedFrom && a.column === b.column;
}

function indentHoverLayer(column: number, unit: number, thickness: number) {
  const startOffset = column / unit;
  return `repeating-linear-gradient(to right, var(--indent-marker-active-bg-color) 0 ${thickness}px, transparent ${thickness}px ${unit}ch) ${startOffset * unit}.5ch/calc(${unit}ch - 1px) no-repeat`;
}

function visibleRangeContainingLine(view: EditorView, lineFrom: number) {
  const line = view.state.doc.lineAt(lineFrom);
  for (const range of view.visibleRanges) {
    if (line.to < range.from) return null;
    if (line.from <= range.to && line.to >= range.from) return range;
  }
  return null;
}

function indentBlockInVisibleRange(
  view: EditorView,
  seedFrom: number,
  column: number,
  vis: { from: number; to: number },
) {
  const { doc } = view.state;
  const tabSize = view.state.tabSize;
  const seed = doc.lineAt(seedFrom);
  if (seed.to < vis.from || seed.from > vis.to) return null;
  const minLine = doc.lineAt(vis.from).number;
  const maxLine = doc.lineAt(vis.to).number;
  const isBarrier = (line: { text: string }) =>
    Boolean(line.text.trim()) && visualIndentColumns(line.text, tabSize) <= column;

  let fromNo = seed.number;
  let toNo = seed.number;
  for (let n = seed.number - 1; n >= minLine; n--) {
    const line = doc.line(n);
    if (line.to < vis.from || isBarrier(line)) break;
    fromNo = n;
  }
  for (let n = seed.number + 1; n <= maxLine; n++) {
    const line = doc.line(n);
    if (line.from > vis.to || isBarrier(line)) break;
    toNo = n;
  }
  return { from: doc.line(fromNo).from, to: doc.line(toNo).to };
}

function lineInHoverBlock(
  view: EditorView,
  lineFrom: number,
  column: number,
  block: { from: number; to: number },
) {
  if (lineFrom < block.from || lineFrom > block.to) return false;
  const line = view.state.doc.lineAt(lineFrom);
  return !line.text.trim() || visualIndentColumns(line.text, view.state.tabSize) > column;
}

function hoverBlock(view: EditorView, seedFrom: number, column: number) {
  const foldRange = foldRangeForGuide(view, seedFrom, column);
  if (foldRange) return foldRange;
  const vis = visibleRangeContainingLine(view, seedFrom);
  if (!vis) return null;
  return indentBlockInVisibleRange(view, seedFrom, column, vis);
}

function buildIndentHoverDecorations(view: EditorView): DecorationSet {
  const hover = view.state.field(indentHoverField);
  if (!hover) return Decoration.none;
  const vis = visibleRangeContainingLine(view, hover.seedFrom);
  if (!vis) return Decoration.none;
  const unit = getIndentUnit(view.state);
  if (unit <= 0 || hover.column % unit !== 0) return Decoration.none;
  const foldRange = foldRangeForGuide(view, hover.seedFrom, hover.column);
  const block = foldRange ?? indentBlockInVisibleRange(view, hover.seedFrom, hover.column, vis);
  if (!block) return Decoration.none;
  const layer = indentHoverLayer(hover.column, unit, indentMarkerActiveThickness);
  const deco = Decoration.line({
    class: foldRange ? 'cm-indent-guide-hover cm-indent-guide-foldable' : 'cm-indent-guide-hover',
    attributes: { style: `--indent-hover-layer: ${layer}` },
  });
  const builder = new RangeSetBuilder<Decoration>();
  const tabSize = view.state.tabSize;
  let lastFrom = -1;
  for (const vr of view.visibleRanges) {
    const from = Math.max(vr.from, block.from);
    const to = Math.min(vr.to, block.to);
    if (from >= to) continue;
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (line.from !== lastFrom) {
        const empty = !line.text.trim();
        const indent = visualIndentColumns(line.text, tabSize);
        if (empty || indent > hover.column) {
          builder.add(line.from, line.from, deco);
          lastFrom = line.from;
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function sameHoverBlock(view: EditorView, current: IndentHover, next: IndentHover) {
  if (current.column !== next.column) return false;
  const block = hoverBlock(view, current.seedFrom, current.column);
  return !!block && lineInHoverBlock(view, next.seedFrom, next.column, block);
}

const indentGuideFold = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildIndentHoverDecorations(view);
    }
    update(update: ViewUpdate) {
      const hover = update.state.field(indentHoverField);
      const hoverMoved =
        update.docChanged ||
        update.viewportChanged ||
        update.heightChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setIndentHover)));
      if (!hoverMoved) return;
      if (hover && !visibleRangeContainingLine(update.view, hover.seedFrom)) {
        this.decorations = Decoration.none;
        const view = update.view;
        queueMicrotask(() => {
          const current = view.state.field(indentHoverField);
          if (current && !visibleRangeContainingLine(view, current.seedFrom)) {
            view.dispatch({ effects: setIndentHover.of(null) });
          }
        });
        return;
      }
      this.decorations = buildIndentHoverDecorations(update.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousemove(event, view) {
        if (event.buttons) {
          if (view.state.field(indentHoverField))
            view.dispatch({ effects: setIndentHover.of(null) });
          return false;
        }
        const guide = pointerGuideTarget(view, event);
        const current = view.state.field(indentHoverField);
        if (!guide) {
          if (current) view.dispatch({ effects: setIndentHover.of(null) });
          return false;
        }
        if (guide.empty) {
          const block = current ? hoverBlock(view, current.seedFrom, current.column) : null;
          if (
            current &&
            current.column === guide.column &&
            block &&
            lineInHoverBlock(view, guide.lineFrom, guide.column, block)
          ) {
            return false;
          }
          if (current) view.dispatch({ effects: setIndentHover.of(null) });
          return false;
        }
        const next = { seedFrom: guide.lineFrom, column: guide.column };
        if (hoverEq(current, next)) return false;
        if (current && sameHoverBlock(view, current, next)) return false;
        view.dispatch({ effects: setIndentHover.of(next) });
        return false;
      },
      mouseleave(_event, view) {
        if (view.state.field(indentHoverField)) view.dispatch({ effects: setIndentHover.of(null) });
        return false;
      },
      mousedown(event, view) {
        if (event.button !== 0) return false;
        const guide = pointerGuideTarget(view, event);
        if (!guide) return false;
        if (view.state.facet(jsonFoldParseEnabled)) {
          const end = view.state.doc.length;
          if (!syntaxTreeAvailable(view.state, end)) {
            forceParsing(view, end, jsonFoldParseClickMs);
          }
        }
        const range = foldRangeForGuide(view, guide.lineFrom, guide.column);
        if (!range) return false;
        const folded = matchingFold(view, range);
        view.dispatch({
          effects: folded ? unfoldEffect.of(folded) : foldEffect.of(range),
        });
        event.preventDefault();
        return true;
      },
    },
  },
);

// CodeMirror 默认的 scrollIntoView 会向上遍历并滚动所有可滚动祖先，搜索选中
// 命中项时会把外层工作区/弹窗内容一起滚动，表现为界面整体位移。这里把滚动
// 限制在编辑器自身的滚动容器内。
const editorScopedScroll = EditorView.scrollHandler.of((view, range, { x, y, xMargin, yMargin }) => {
  const scroller = view.scrollDOM;
  const block = view.lineBlockAt(range.head);
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  let nextTop = viewTop;
  if (y === 'center') nextTop = block.top - (scroller.clientHeight - block.height) / 2;
  else if (y === 'start') nextTop = block.top - yMargin;
  else if (y === 'end') nextTop = block.bottom - scroller.clientHeight + yMargin;
  else if (block.top < viewTop + yMargin) nextTop = block.top - yMargin;
  else if (block.bottom > viewBottom - yMargin)
    nextTop = block.bottom - scroller.clientHeight + yMargin;
  let nextLeft = scroller.scrollLeft;
  const head = view.coordsAtPos(range.head);
  if (head) {
    const rect = scroller.getBoundingClientRect();
    const left = scroller.scrollLeft + (head.left - rect.left);
    const right = scroller.scrollLeft + (head.right - rect.left);
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    if (x === 'center') nextLeft = left - (scroller.clientWidth - (head.right - head.left)) / 2;
    else if (x === 'start') nextLeft = left - xMargin;
    else if (x === 'end') nextLeft = right - scroller.clientWidth + xMargin;
    else if (left < viewLeft + xMargin) nextLeft = left - xMargin;
    else if (right > viewRight - xMargin) nextLeft = right - scroller.clientWidth + xMargin;
  }
  scroller.scrollTop = Math.max(0, Math.min(nextTop, maxTop));
  scroller.scrollLeft = Math.max(0, Math.min(nextLeft, maxLeft));
  return true;
});

export const quietEditorTheme = [
  indentGuides,
  codeFolding(),
  indentHoverField,
  indentGuideFold,
  quietBase,
  syntaxHighlighting(quietSyntax),
  // 所有共享该主题的编辑器统一使用 VSCode 风格的搜索面板。
  appSearchPanel,
  editorScopedScroll,
];

function jsonFoldParseBudget(deadline?: IdleDeadline) {
  if (!deadline) return jsonFoldParseTimerBudgetMs;
  const remaining = deadline.timeRemaining();
  if (deadline.didTimeout || remaining <= 0) return jsonFoldParseTimeoutBudgetMs;
  return remaining;
}

function scheduleIdle(callback: (deadline?: IdleDeadline) => void) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback((deadline) => callback(deadline), { timeout: 80 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => callback(), jsonFoldParseTimerDelayMs);
  return () => clearTimeout(id);
}

const jsonFoldParseWarmupPlugin = ViewPlugin.fromClass(
  class {
    private cancelScheduled: (() => void) | null = null;
    private generation = 0;
    private alive = true;

    constructor(readonly view: EditorView) {
      this.queue();
    }

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      this.stop();
      this.queue();
    }

    destroy() {
      this.alive = false;
      this.stop();
    }

    private stop() {
      this.generation++;
      this.cancelScheduled?.();
      this.cancelScheduled = null;
    }

    private queue() {
      if (!this.alive || this.cancelScheduled) return;
      if (syntaxTreeAvailable(this.view.state, this.view.state.doc.length)) return;
      const generation = this.generation;
      this.cancelScheduled = scheduleIdle((deadline) => {
        this.cancelScheduled = null;
        if (!this.alive || generation !== this.generation) return;
        const end = this.view.state.doc.length;
        if (syntaxTreeAvailable(this.view.state, end)) return;
        forceParsing(this.view, end, jsonFoldParseBudget(deadline));
        if (!this.alive || generation !== this.generation) return;
        if (syntaxTreeAvailable(this.view.state, this.view.state.doc.length)) return;
        this.queue();
      });
    }
  },
);

export const jsonFoldParseWarmup: Extension = [
  jsonFoldParseEnabled.of(true),
  jsonFoldParseWarmupPlugin,
];
