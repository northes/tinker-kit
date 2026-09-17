import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { useTranslation } from 'react-i18next';
import { Copy, Trash } from '@phosphor-icons/react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { closeSearchPanel, openSearchPanel } from '@codemirror/search';
import { quietEditorTheme } from './codeMirrorTheme';
import {
  type PendingAction,
  Reveal,
  ToolActionBar,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  type ToolId,
  ToolLayout,
  useFocusOnActivate,
} from './shared';
import { toast } from './ui/toast';
import '../styles/tools/editor.css';

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CJK_WORD = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const ENGLISH_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const SENTENCE_END = /[.!?。！？…]+/u;

const countSentences = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(SENTENCE_END).filter((part) => part.trim()).length;
};

const countParagraphs = (value: string) => {
  if (!value.trim()) return 0;
  return value.split(/\r?\n(?:[ \t]*\r?\n)+/).filter((part) => part.trim()).length;
};

const analyzeText = (value: string) => {
  const chars = [...value];
  const chineseWords = value.match(CJK_WORD)?.length ?? 0;
  const englishWords = value.match(ENGLISH_WORD)?.length ?? 0;
  return {
    characters: chars.length,
    chinese: chars.filter((x) => CJK_CHAR.test(x)).length,
    english: chars.filter((x) => /[A-Za-z]/.test(x)).length,
    digits: chars.filter((x) => /\d/.test(x)).length,
    punctuation: chars.filter((x) => /\p{P}/u.test(x)).length,
    charactersNoSpaces: chars.filter((x) => !/\s/.test(x)).length,
    words: chineseWords + englishWords,
    chineseWords,
    englishWords,
    sentences: countSentences(value),
    paragraphs: countParagraphs(value),
    lines: value ? value.split(/\r?\n/).length : 0,
    bytes: new TextEncoder().encode(value).length,
  };
};

type CaseMode = 'upper' | 'lower' | 'lineUpper' | 'lineLower' | 'wordUpper' | 'wordLower';
// 模块级常量避免每次渲染触发 CodeMirror reconfigure，导致搜索面板被重置关闭。
const editorExtensions = [EditorView.lineWrapping];
const editorBasicSetup = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  closeBrackets: false,
} as const;
const caseModes: CaseMode[] = [
  'upper',
  'lower',
  'lineUpper',
  'lineLower',
  'wordUpper',
  'wordLower',
];
const transformCase = (value: string, mode: CaseMode) =>
  mode === 'upper'
    ? value.toUpperCase()
    : mode === 'lower'
      ? value.toLowerCase()
      : mode === 'lineUpper'
        ? value.replace(/(^|\n)([^\n])/g, (_, start, character) => start + character.toUpperCase())
        : mode === 'lineLower'
          ? value.replace(
              /(^|\n)([^\n])/g,
              (_, start, character) => start + character.toLowerCase(),
            )
          : mode === 'wordUpper'
            ? value.replace(
                /[A-Za-z]+/g,
                (word) => word[0].toUpperCase() + word.slice(1).toLowerCase(),
              )
            : value.replace(/[A-Za-z]+/g, (word) => word[0].toLowerCase() + word.slice(1));

function StatLink({
  label,
  count,
  items,
}: {
  label: string;
  count: number;
  items: Array<{ key: string; label: string; count: number }>;
}) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="link"
            size="sm"
            className="h-auto min-h-0 min-w-0 flex-none px-0 py-0"
            aria-label={t('textTool.showDetails', { label })}
          />
        }
      >
        <span>{label}</span>
        <span className="font-mono tabular-nums">{count.toLocaleString()}</span>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64">
        <PopoverTitle>{label}</PopoverTitle>
        <div className="flex flex-col gap-1.5">
          {items.map((item) => (
            <div key={item.key} className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">{item.label}</span>
              <span className="font-mono tabular-nums text-foreground">
                {item.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StatPlain({ label, count }: { label: string; count: number }) {
  return (
    <span className="inline-flex min-w-0 flex-none items-center gap-1 text-[0.8rem]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{count.toLocaleString()}</span>
    </span>
  );
}

export default function TextTool({
  active,
  alwaysShowSearch,
  onAlwaysShowSearchChange,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  theme: string;
  alwaysShowSearch: boolean;
  onAlwaysShowSearchChange: (value: boolean) => void;
  record: (tool: ToolId, action: string, detail: string, input: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  // 用 state 触发一次 effect 重跑，确保自动应用「始终显示搜索」时编辑器已创建。
  const [editorReady, setEditorReady] = useState(false);
  const consumed = useRef<PendingAction | null>(null);
  const inputView = useRef<EditorView | null>(null);
  const alwaysShowSearchChangeRef = useRef(onAlwaysShowSearchChange);
  alwaysShowSearchChangeRef.current = onAlwaysShowSearchChange;
  useFocusOnActivate(active, () => inputView.current?.focus());
  const stats = useMemo(() => analyzeText(value), [value]);
  const apply = (action: string, fn: (input: string) => string) => {
    const next = fn(value);
    setValue(next);
    record('text', action, `${[...next].length} ${t('textTool.characters')}`, next);
  };
  const copy = () => {
    navigator.clipboard?.writeText(value).catch(() => {});
    toast.add({
      title: t('toast.copied', { value: `${[...value].length} ${t('textTool.characters')}` }),
    });
    record('text', t('textTool.copy'), `${[...value].length} ${t('textTool.characters')}`, value);
  };
  useEffect(() => {
    if (!pending || pending.tool !== 'text' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    const transforms: Record<string, (input: string) => string> = {
      trim: (s) => s.trim(),
      removeSpaces: (s) => s.replace(/[ \t]+/g, ''),
      compress: (s) => s.replace(/ {2,}/g, ' '),
      compressLine: (s) => s.replace(/\r\n?|\n/g, ' '),
      upper: (s) => transformCase(s, 'upper'),
      lower: (s) => transformCase(s, 'lower'),
      lineUpper: (s) => transformCase(s, 'lineUpper'),
      lineLower: (s) => transformCase(s, 'lineLower'),
      wordUpper: (s) => transformCase(s, 'wordUpper'),
      wordLower: (s) => transformCase(s, 'wordLower'),
    };
    if (pending.action === 'clear') {
      setValue('');
      return;
    }
    if (pending.action === 'copy') {
      const next = value.trim() || pending.input;
      if (next) navigator.clipboard?.writeText(next).catch(() => {});
      return;
    }
    if (transforms[pending.action]) {
      setValue(transforms[pending.action](value));
      return;
    }
    setValue(pending.input);
  }, [pending, value]);
  // 勾选后打开搜索栏并保持常驻；用户按 Esc 或点关闭时关闭面板并同步取消勾选。
  useEffect(() => {
    const view = inputView.current;
    if (!view) return;
    if (!alwaysShowSearch) {
      closeSearchPanel(view);
      return;
    }
    openSearchPanel(view);
    const panel = view.dom.querySelector<HTMLElement>('.cm-panel.cm-app-search');
    if (!panel) return;
    const close = () => alwaysShowSearchChangeRef.current(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.cm-app-search-close')) close();
    };
    panel.addEventListener('keydown', onKeyDown, true);
    panel.addEventListener('click', onClick, true);
    return () => {
      panel.removeEventListener('keydown', onKeyDown, true);
      panel.removeEventListener('click', onClick, true);
    };
  }, [alwaysShowSearch, editorReady]);
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('textTool.title')} />
        <ToolLayoutContent className="grid grid-rows-[minmax(0,1fr)_auto] gap-3">
          <div className="flex min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span>{t('textTool.input')}</span>
              <Label className="min-w-0 gap-1.5 text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
                <Checkbox
                  checked={alwaysShowSearch}
                  onCheckedChange={(checked) => onAlwaysShowSearchChange(checked === true)}
                />
                <span>{t('textTool.alwaysShowSearch')}</span>
              </Label>
            </span>
            <CodeMirror
              className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card focus-within:border-muted-foreground [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto"
              height="100%"
              value={value}
              onChange={setValue}
              onCreateEditor={(view) => {
                view.contentDOM.setAttribute('aria-label', t('textTool.input'));
                inputView.current = view;
                setEditorReady(true);
              }}
              theme={quietEditorTheme}
              extensions={editorExtensions}
              basicSetup={editorBasicSetup}
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <StatLink
              label={t('textTool.totalCharacters')}
              count={stats.characters}
              items={[
                { key: 'chinese', label: t('textTool.chinese'), count: stats.chinese },
                { key: 'english', label: t('textTool.english'), count: stats.english },
                { key: 'digits', label: t('textTool.digits'), count: stats.digits },
                { key: 'punctuation', label: t('textTool.punctuation'), count: stats.punctuation },
                {
                  key: 'charactersNoSpaces',
                  label: t('textTool.charactersNoSpaces'),
                  count: stats.charactersNoSpaces,
                },
              ]}
            />
            <StatLink
              label={t('textTool.totalWords')}
              count={stats.words}
              items={[
                {
                  key: 'chineseWords',
                  label: t('textTool.chineseWords'),
                  count: stats.chineseWords,
                },
                {
                  key: 'englishWords',
                  label: t('textTool.englishWords'),
                  count: stats.englishWords,
                },
              ]}
            />
            <StatPlain label={t('textTool.sentences')} count={stats.sentences} />
            <StatPlain label={t('textTool.paragraphs')} count={stats.paragraphs} />
            <StatPlain label={t('textTool.lines')} count={stats.lines} />
            <StatPlain label={t('textTool.bytes')} count={stats.bytes} />
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('textTool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('textTool.clear'),
                icon: Trash,
                variant: 'tertiary',
                disabled: !value,
                onPress: () => setValue(''),
              },
              {
                key: 'case',
                label: t('textTool.case'),
                type: 'select',
                disabled: !value,
                options: caseModes.map((key) => ({ key, label: t(`textTool.caseModes.${key}`) })),
                onSelect: (mode) =>
                  apply(t(`textTool.caseModes.${mode}`), (input) =>
                    transformCase(input, mode as CaseMode),
                  ),
              },
              {
                key: 'trim',
                label: t('textTool.trim'),
                variant: 'secondary',
                disabled: !value,
                onPress: () => apply(t('textTool.trimmed'), (input) => input.trim()),
              },
              {
                key: 'compressSpaces',
                label: t('textTool.compressSpaces'),
                variant: 'secondary',
                disabled: !value,
                onPress: () =>
                  apply(t('textTool.compressedSpaces'), (input) => input.replace(/ {2,}/g, ' ')),
              },
              {
                key: 'removeSpaces',
                label: t('textTool.removeSpaces'),
                variant: 'secondary',
                disabled: !value,
                onPress: () =>
                  apply(t('textTool.removedSpaces'), (input) => input.replace(/[ \t]+/g, '')),
              },
              {
                key: 'compressLine',
                label: t('textTool.compressLine'),
                variant: 'secondary',
                disabled: !value,
                onPress: () =>
                  apply(t('textTool.compressedLine'), (input) => input.replace(/\r\n?|\n/g, ' ')),
              },
              {
                key: 'copy',
                label: t('textTool.copy'),
                icon: Copy,
                variant: 'primary',
                disabled: !value,
                onPress: copy,
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>
    </Reveal>
  );
}
