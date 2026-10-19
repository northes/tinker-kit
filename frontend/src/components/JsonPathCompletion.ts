import {
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { editorCompletions } from './codeMirrorCompletion';
import {
  QueryJSONPathCompletion,
  QueryPipelineCompletion,
} from '../../bindings/tinkerkit/jsonpipelineservice';
import type { PipelineCompletionContext } from './useBackendPipelineEvaluation';

type PathToken = { type: 'key' | 'index' | 'all'; value: string };
const normalizeCompletionText = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const fuzzyCompletionMatch = (value: string, query: string) => {
  const candidate = normalizeCompletionText(value),
    needle = normalizeCompletionText(query);
  let index = 0;
  for (const char of needle) {
    index = candidate.indexOf(char, index);
    if (index < 0) return false;
    index++;
  }
  return true;
};

function splitPathSegments(prefix: string) {
  const tokens: PathToken[] = [];
  let s = prefix;
  if (s.startsWith('$')) s = s.slice(1);
  let i = 0,
    partial = '',
    inBracket = false,
    followedBySep = false;
  const len = s.length;
  while (i < len) {
    const ch = s[i];
    if (ch === '.' || ch === ' ' || ch === '/') {
      i++;
      continue;
    }
    if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) {
        inBracket = true;
        partial = s.slice(i + 1);
        break;
      }
      const inner = s.slice(i + 1, end).trim();
      if (inner === '*') tokens.push({ type: 'all', value: '*' });
      else if (/^-?\d+$/.test(inner)) tokens.push({ type: 'index', value: inner });
      else if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      )
        tokens.push({ type: 'key', value: inner.slice(1, -1) });
      else {
        inBracket = true;
        partial = inner;
        break;
      }
      i = end + 1;
      followedBySep = i < len && (s[i] === '.' || s[i] === '/');
    } else if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_$-]/.test(s[j])) j++;
      if (j >= len) {
        partial = s.slice(i);
        break;
      }
      tokens.push({ type: 'key', value: s.slice(i, j) });
      i = j;
    } else i++;
  }
  return { tokens, partial, inBracket, followedBySep };
}
const normalizePathInput = EditorView.inputHandler.of((view, from, to, text) => {
  const normalized = text.replace(/。/g, '.');
  if (/[.[{]/.test(normalized)) queueMicrotask(() => startCompletion(view));
  if (normalized === text) return false;
  view.dispatch({
    changes: { from, to, insert: normalized },
    selection: { anchor: from + normalized.length },
  });
  return true;
});

// Schema 路径补全由 Go 后端解析完整输入，前端只负责光标范围、取消请求和渲染候选。
export function backendJSONPathCompletions(getSource: () => string) {
  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const prefix = context.state.doc.sliceString(0, context.pos).replace(/\s+$/, '');
    if (prefix === '' || prefix === '$') return null;
    const { tokens, partial, inBracket } = splitPathSegments(prefix);
    if (tokens.length === 0 && !(prefix.startsWith('$.') || prefix.startsWith('$['))) return null;
    const last = prefix.slice(-1);
    const afterSep = last === '.' || last === '[' || last === '/';
    if (!partial.length && !afterSep && !inBracket) return null;
    const request = QueryJSONPathCompletion({ source: getSource(), prefix, limit: 100 });
    context.addEventListener('abort', () => void request.cancel(), { onDocChange: true });
    try {
      const response = await request;
      if (context.aborted || !response.items?.length) return null;
      const options = response.items.map((option) => ({
        label: option.label,
        apply: option.apply,
        type: option.type,
      }));
      const end =
        context.pos + (context.state.doc.sliceString(context.pos, context.pos + 1) === ']' ? 1 : 0);
      const isArraySample = options[0]?.label.startsWith('[*].') ?? false;
      const from = isArraySample
        ? partial.length && prefix.includes('.')
          ? context.pos - partial.length - 1
          : prefix.endsWith('.')
            ? context.pos - 1
            : context.pos
        : inBracket
          ? context.pos - partial.length - 1
          : partial.length
            ? context.pos - partial.length
            : context.pos;
      return { from, to: end, options, filter: false };
    } catch {
      return null;
    }
  };
  return [
    ...editorCompletions({
      override: [source],
      activateOnTyping: true,
    }),
    normalizePathInput,
  ];
}

export function valueCompletions(values: unknown[] | (() => unknown[])) {
  const source = (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/[^\s,]*/);
    const typed = (match?.text ?? '').toLowerCase();
    const current = typeof values === 'function' ? values() : values;
    const options = [
      ...new Set(
        current
          .filter(
            (value) =>
              value === null ||
              typeof value === 'boolean' ||
              typeof value === 'number' ||
              typeof value === 'string',
          )
          .map((value) => JSON.stringify(value)),
      ),
    ]
      .filter((value): value is string => !!value)
      .filter((value) => !typed || fuzzyCompletionMatch(value, typed))
      .map((value) => ({ label: value, apply: value, type: 'value' }));
    if (!options.length) return null;
    return { from: match?.from ?? context.pos, to: context.pos, options, filter: false };
  };
  return [
    ...editorCompletions({
      override: [source],
      activateOnTyping: true,
    }),
  ];
}

type BackendContextGetter = () => PipelineCompletionContext;

// backendPathCompletions / backendValueCompletions 把路径与取值补全委托给后端，
// 前端只负责光标位置、替换范围与渲染，不再需要完整 AST。
export function backendPathCompletions(
  getContext: BackendContextGetter,
  itemId: string,
  field: string,
  template = false,
) {
  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.state.doc.sliceString(0, context.pos);
    const start = template ? before.lastIndexOf('{') : 0;
    if (start < 0 || (template && before.lastIndexOf('}') > start)) return null;
    const templatePrefix = template ? before.slice(start + 1) : '';
    if (template && templatePrefix === '')
      return {
        from: context.pos,
        to: context.pos,
        options: [
          {
            label: '{$.}',
            type: 'keyword',
            apply: (view, _completion, from, to) => {
              view.dispatch({
                changes: { from, to, insert: '$.}' },
                selection: { anchor: from + 2 },
              });
              startCompletion(view);
            },
          },
        ],
      };
    if (template && !templatePrefix.startsWith('$.')) return null;
    const prefix = (template ? templatePrefix : before).replace(/\s+$/, '');
    if (!template && (prefix === '' || prefix === '$')) return null;
    const { tokens, partial, inBracket } = splitPathSegments(prefix);
    if (!template && tokens.length === 0 && !(prefix.startsWith('$.') || prefix.startsWith('$[')))
      return null;
    const last = prefix.slice(-1);
    const afterSep = last === '.' || last === '[' || last === '/';
    if (!template && !partial.length && !afterSep && !inBracket) return null;
    const pipeline = getContext();
    if (!pipeline) return null;
    const request = QueryPipelineCompletion({
      sessionID: pipeline.sessionID,
      docID: pipeline.docID,
      pipelineID: pipeline.pipelineID,
      itemID: itemId,
      field,
      prefix,
      limit: 100,
    });
    context.addEventListener('abort', () => void request.cancel(), { onDocChange: true });
    let options: CompletionResult['options'];
    try {
      const response = await request;
      if (context.aborted || response.stale || !response.items?.length) return null;
      options = response.items.map((option) => ({
        label: option.label,
        apply: option.apply,
        type: option.type,
      }));
    } catch {
      return null;
    }
    const end =
      context.pos + (context.state.doc.sliceString(context.pos, context.pos + 1) === ']' ? 1 : 0);
    const isArraySample = options[0]?.label.startsWith('[*].') ?? false;
    const from = isArraySample
      ? partial.length && prefix.includes('.')
        ? context.pos - partial.length - 1
        : prefix.endsWith('.')
          ? context.pos - 1
          : context.pos
      : inBracket
        ? context.pos - partial.length - 1
        : partial.length
          ? context.pos - partial.length
          : context.pos;
    return { from, to: end, options, filter: false };
  };
  return [
    ...editorCompletions({
      override: [source],
      activateOnTyping: true,
    }),
    normalizePathInput,
  ];
}

export function backendValueCompletions(getContext: BackendContextGetter, itemId: string) {
  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const match = context.matchBefore(/[^\s,]*/);
    const typed = match?.text ?? '';
    const pipeline = getContext();
    if (!pipeline) return null;
    const request = QueryPipelineCompletion({
      sessionID: pipeline.sessionID,
      docID: pipeline.docID,
      pipelineID: pipeline.pipelineID,
      itemID: itemId,
      field: 'filterValue',
      prefix: typed,
      limit: 100,
    });
    context.addEventListener('abort', () => void request.cancel(), { onDocChange: true });
    try {
      const response = await request;
      if (context.aborted || response.stale || !response.items?.length) return null;
      return {
        from: match?.from ?? context.pos,
        to: context.pos,
        options: response.items.map((option) => ({
          label: option.label,
          apply: option.apply,
          type: option.type,
        })),
        filter: false,
      };
    } catch {
      return null;
    }
  };
  return [
    ...editorCompletions({
      override: [source],
      activateOnTyping: true,
    }),
  ];
}
