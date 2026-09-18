import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Trash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { RangeSetBuilder, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { quietEditorTheme } from './codeMirrorTheme';
import {
  Reveal,
  ToolActionBar,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayout,
  decodeBase64Text,
  useFocusOnActivate,
  type PendingAction,
  type ToolId,
} from './shared';
import { toast } from './ui/toast';
import '../styles/tools/editor.css';

type Decoded = { header: string; payload: string; signature: string };
const jsonSyntax = json();
const jwtSegmentMarks = [
  Decoration.mark({ class: 'cm-jwt-header' }),
  Decoration.mark({ class: 'cm-jwt-payload' }),
  Decoration.mark({ class: 'cm-jwt-signature' }),
];
function jwtSegmentDecorations(doc: Text) {
  const builder = new RangeSetBuilder<Decoration>();
  const text = doc.toString();
  let segmentStart = 0;
  let segment = 0;
  for (let position = 0; position <= text.length; position++) {
    if (position < text.length && text[position] !== '.') continue;
    if (segment < jwtSegmentMarks.length && segmentStart < position)
      builder.add(segmentStart, position, jwtSegmentMarks[segment]);
    if (position === text.length) break;
    segmentStart = position + 1;
    segment++;
  }
  return builder.finish();
}
const jwtSegmentHighlight = StateField.define<DecorationSet>({
  create(state) {
    return jwtSegmentDecorations(state.doc);
  },
  update(decorations, transaction) {
    return transaction.docChanged ? jwtSegmentDecorations(transaction.state.doc) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const jwtEditorTheme = EditorView.theme({
  '.cm-jwt-header': { color: 'var(--destructive)' },
  '.cm-jwt-payload': { color: 'var(--success)' },
  '.cm-jwt-signature': { color: 'var(--warning)' },
});
function decodeSegment(segment: string): string | null {
  const decoded = decodeBase64Text(segment);
  if (decoded === null) return null;
  try {
    return JSON.stringify(JSON.parse(decoded), null, 2);
  } catch {
    return null;
  }
}
function decodeJwt(token: string): Decoded | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const header = decodeSegment(parts[0]),
    payload = decodeSegment(parts[1]);
  return header !== null && payload !== null
    ? { header, payload, signature: parts[2] ?? '' }
    : null;
}
function JwtPane({
  label,
  value,
  onChange,
  onCreate,
  extensions,
  syntax,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  onCreate?: (view: EditorView) => void;
  extensions?: Extension[];
  syntax?: Extension;
  readOnly?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
      <span>{label}</span>
      <CodeMirror
        className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card focus-within:border-muted-foreground [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto"
        height="100%"
        value={value}
        onChange={onChange}
        onCreateEditor={(view) => {
          view.contentDOM.setAttribute('aria-label', label);
          onCreate?.(view);
        }}
        theme={quietEditorTheme}
        editable={!readOnly}
        readOnly={readOnly}
        extensions={[...(syntax ? [syntax] : []), EditorView.lineWrapping, ...(extensions ?? [])]}
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
export default function JwtTool({
  active,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const consumed = useRef<PendingAction | null>(null);
  const inputView = useRef<EditorView | null>(null);
  const lastRecorded = useRef('');
  const skipRecord = useRef(false);
  const recordTimer = useRef<number | null>(null);
  useFocusOnActivate(active, () => inputView.current?.focus());
  const decoded = useMemo(() => decodeJwt(input), [input]);
  useEffect(() => {
    const token = input.trim();
    if (recordTimer.current !== null) {
      window.clearTimeout(recordTimer.current);
      recordTimer.current = null;
    }
    if (skipRecord.current) {
      skipRecord.current = false;
      return;
    }
    if (decoded && token && lastRecorded.current !== token)
      recordTimer.current = window.setTimeout(() => {
        recordTimer.current = null;
        lastRecorded.current = token;
        const output = `${decoded.header}\n${decoded.payload}\n${decoded.signature}`,
          bytes = new TextEncoder().encode(output).length;
        record('jwt', t('jwtTool.decoded'), `${bytes} B`, token, output);
      }, 1500);
    else if (!decoded) lastRecorded.current = '';
    return () => {
      if (recordTimer.current !== null) window.clearTimeout(recordTimer.current);
    };
  }, [decoded, input, record, t]);
  const copy = async (kind: 'header' | 'payload' | 'signature') => {
    if (!decoded) return;
    const value = decoded[kind];
    await navigator.clipboard?.writeText(value).catch(() => {});
    const bytes = new TextEncoder().encode(value).length;
    toast.add({ title: t('toast.copied', { value: `${bytes} B` }) });
    record(
      'jwt',
      t(
        kind === 'header'
          ? 'jwtTool.copyHeader'
          : kind === 'payload'
            ? 'jwtTool.copyPayload'
            : 'jwtTool.copySignature',
      ),
      `${bytes} B`,
      input,
      value,
    );
  };
  useEffect(() => {
    if (!pending || pending.tool !== 'jwt' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'clear') {
      setInput('');
      return;
    }
    if (
      pending.action === 'copyHeader' ||
      pending.action === 'copyPayload' ||
      pending.action === 'copySignature'
    ) {
      if (!decoded) {
        toast.add({ title: t('jwtTool.invalid'), type: 'warning' });
        return;
      }
      void copy(
        pending.action === 'copyHeader'
          ? 'header'
          : pending.action === 'copyPayload'
            ? 'payload'
            : 'signature',
      );
      return;
    }
    skipRecord.current = pending.action === 'restore';
    setInput(pending.input);
  }, [pending, decoded]);
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('jwtTool.title')} />
        <ToolLayoutContent className="grid grid-rows-[minmax(0,1fr)_auto] gap-3">
          <div className="grid min-h-0 min-w-0 grid-cols-2 gap-3">
            <JwtPane
              label={t('jwtTool.input')}
              value={input}
              onChange={setInput}
              extensions={[jwtEditorTheme, jwtSegmentHighlight]}
              onCreate={(view) => {
                inputView.current = view;
              }}
            />
            <div className="grid min-h-0 min-w-0 grid-rows-[2fr_4fr_1fr] gap-3">
              <JwtPane
                label={t('jwtTool.header')}
                value={decoded?.header ?? ''}
                extensions={[jwtEditorTheme]}
                syntax={jsonSyntax}
                readOnly
              />
              <JwtPane
                label={t('jwtTool.payload')}
                value={decoded?.payload ?? ''}
                extensions={[jwtEditorTheme]}
                syntax={jsonSyntax}
                readOnly
              />
              <JwtPane
                label={t('jwtTool.signature')}
                value={decoded?.signature ?? ''}
                extensions={[jwtEditorTheme]}
                readOnly
              />
            </div>
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('jwtTool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('jwtTool.clear'),
                icon: Trash,
                variant: 'tertiary',
                disabled: !input,
                onPress: () => setInput(''),
              },
              {
                key: 'copyHeader',
                label: t('jwtTool.copyHeader'),
                icon: Copy,
                variant: 'secondary',
                disabled: !decoded,
                onPress: () => void copy('header'),
              },
              {
                key: 'copySignature',
                label: t('jwtTool.copySignature'),
                icon: Copy,
                variant: 'secondary',
                disabled: !decoded,
                onPress: () => void copy('signature'),
              },
              {
                key: 'copyPayload',
                label: t('jwtTool.copyPayload'),
                icon: Copy,
                variant: 'primary',
                disabled: !decoded,
                onPress: () => void copy('payload'),
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>
    </Reveal>
  );
}
