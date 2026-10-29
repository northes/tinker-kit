import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox';
import { ScrollableText } from './ScrollableText';
import { Label } from './ui/label';
import { Trans, useTranslation } from 'react-i18next';
import {
  ArrowsInLineHorizontal,
  ArrowsInLineVertical,
  Copy,
  TextAa,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
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
  ToolLayout,
  useFocusOnActivate,
  editorSurfaceClass,
} from './shared';
import { toast } from './ui/toast';
import { dataUrlToText, readLocalFile, useFileDrop } from './fileDrop';
import '../styles/tools/editor.css';

const MAX_OPEN_BYTES = 10 * 1024 * 1024;

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

const spaceTransforms: Record<string, (input: string) => string> = {
  trim: (input) => input.trim(),
  compressSpaces: (input) => input.replace(/ {2,}/g, ' '),
  removeSpaces: (input) => input.replace(/[ \t]+/g, ''),
};

// 按行切分并保留原始换行符，整行移除空行（含仅空白字符的行）。
const removeEmptyLines = (input: string) =>
  (input.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).filter((line) => line.trim() !== '').join('');

const lineTransforms: Record<string, (input: string) => string> = {
  compressLine: (input) => input.replace(/\r\n?|\n/g, ' '),
  compressLineNoTrailingBackslash: (input) =>
    input.replace(/\\[ \t]*(?=\r\n?|\n|$)/g, '').replace(/\r\n?|\n/g, ' '),
  removeEmptyLines,
};

// 逐行在原行内容两侧拼接用户输入，换行符原样保留；末尾缺行时的零宽匹配不当作一行。
const addLineAffixes = (input: string, prefix: string, suffix: string) =>
  input.replace(/([^\r\n]*)(\r\n|\r|\n|$)/g, (match, content: string, ending: string) =>
    content === '' && ending === '' ? match : `${prefix}${content}${suffix}${ending}`,
  );

type AffixField = 'prefix' | 'suffix';

const AFFIX_HISTORY_LIMIT = 5;
// 最新一次输入排在最前，重复值只保留一条。
const rememberAffix = (entries: string[], value: string) =>
  value === ''
    ? entries
    : [value, ...entries.filter((entry) => entry !== value)].slice(0, AFFIX_HISTORY_LIMIT);

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
// 菜单里按 全部 / 每行 / 每个单词 分三组。
const caseModeGroups: CaseMode[][] = [
  ['upper', 'lower'],
  ['lineUpper', 'lineLower'],
  ['wordUpper', 'wordLower'],
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

// 首尾字符输入框：可直接输入任意字符，也可从最近使用记录中回填。
function AffixHistoryCombobox({
  id,
  label,
  value,
  entries,
  autoFocus,
  onChange,
  onDelete,
}: {
  id: string;
  label: string;
  value: string;
  entries: string[];
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onDelete: (entry: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Combobox
      items={entries}
      // 自由输入也必须同步为控件值，否则浮层关闭时会用空选中值覆盖输入。
      value={value || null}
      onValueChange={(next) => onChange(next ?? '')}
      inputValue={value}
      onInputValueChange={onChange}
      filter={(entry, query) => entry.toLowerCase().includes(query.trim().toLowerCase())}
      openOnInputClick
    >
      <ComboboxInput id={id} className="w-full" triggerLabel={label} autoFocus={autoFocus} />
      <ComboboxContent>
        <ComboboxList>
          {(entry: string) => (
            <ComboboxItem key={entry} value={entry} showIndicator={false} className="group/affix">
              <ScrollableText text={entry} />
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-md bg-linear-to-r from-transparent via-popover to-popover pl-6 pr-1 opacity-0 group-hover/affix:via-accent group-hover/affix:to-accent group-hover/affix:opacity-100 group-focus-within/affix:via-accent group-focus-within/affix:to-accent group-focus-within/affix:opacity-100 group-data-[highlighted]/affix:via-accent group-data-[highlighted]/affix:to-accent group-data-[highlighted]/affix:opacity-100 [@media(pointer:coarse)]:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="group/affix-remove pointer-events-auto"
                  aria-label={t('textTool.affixDeleteHistory', { value: entry })}
                  title={t('textTool.affixDeleteHistory', { value: entry })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(entry);
                  }}
                >
                  <Trash
                    weight="duotone"
                    size={14}
                    className="opacity-60 group-hover/affix-remove:opacity-80 group-focus-visible/affix-remove:opacity-80"
                    aria-hidden="true"
                  />
                </Button>
              </div>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>
          {t(entries.length ? 'textTool.affixNoMatch' : 'textTool.affixNoHistory')}
        </ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}

// 输入值随对话框关闭重置，最近使用记录由 TextTool 持有并跨次保留。
function AffixDialog({
  histories,
  onDeleteHistory,
  onApply,
  onClose,
}: {
  histories: Record<AffixField, string[]>;
  onDeleteHistory: (field: AffixField, entry: string) => void;
  onApply: (prefix: string, suffix: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');
  const canApply = prefix !== '' || suffix !== '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('textTool.affix')}</DialogTitle>
        </DialogHeader>
        <form
          id="text-affix-form"
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canApply) return;
            onApply(prefix, suffix);
            onClose();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="text-affix-prefix">{t('textTool.affixPrefix')}</Label>
            <AffixHistoryCombobox
              id="text-affix-prefix"
              label={t('textTool.affixPrefix')}
              value={prefix}
              entries={histories.prefix}
              autoFocus
              onChange={setPrefix}
              onDelete={(entry) => onDeleteHistory('prefix', entry)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="text-affix-suffix">{t('textTool.affixSuffix')}</Label>
            <AffixHistoryCombobox
              id="text-affix-suffix"
              label={t('textTool.affixSuffix')}
              value={suffix}
              entries={histories.suffix}
              onChange={setSuffix}
              onDelete={(entry) => onDeleteHistory('suffix', entry)}
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="text-affix-form" disabled={!canApply}>
            {t('common.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TextTool({
  active,
  alwaysShowSearch,
  onAlwaysShowSearchChange,
  pending,
  clearPending,
}: {
  active: boolean;
  theme: string;
  alwaysShowSearch: boolean;
  onAlwaysShowSearchChange: (value: boolean) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [affixOpen, setAffixOpen] = useState(false);
  const [affixHistory, setAffixHistory] = useState<Record<AffixField, string[]>>({
    prefix: [],
    suffix: [],
  });
  // 用 state 触发一次 effect 重跑，确保自动应用「始终显示搜索」时编辑器已创建。
  const [editorReady, setEditorReady] = useState(false);
  const consumed = useRef<PendingAction | null>(null);
  const inputView = useRef<EditorView | null>(null);
  const alwaysShowSearchChangeRef = useRef(onAlwaysShowSearchChange);
  alwaysShowSearchChangeRef.current = onAlwaysShowSearchChange;
  const paneRef = useRef<HTMLDivElement>(null);
  const [hintPos, setHintPos] = useState<{ left: number; top: number } | null>(null);
  const showHint = value.length === 0;
  // 浮层需要避开行号槽，直接取位置 0 的实际坐标作为提示起点。
  const measureHint = useCallback(() => {
    const pane = paneRef.current;
    const view = inputView.current;
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
  const loadPath = useCallback(
    async (path: string) => {
      try {
        const data = await readLocalFile(path, MAX_OPEN_BYTES);
        setValue(dataUrlToText(data.dataURL));
        toast.add({ title: t('textTool.fileLoaded', { name: data.name }) });
      } catch {
        toast.add({ title: t('textTool.openFileFailed'), type: 'error' });
      }
    },
    [t],
  );
  const fileDrop = useFileDrop({
    id: 'text-drop-zone',
    enabled: active,
    pick: {
      Title: t('textTool.openFileTitle'),
      ButtonText: t('textTool.openFile'),
      Filters: [
        { DisplayName: t('textTool.filterText'), Pattern: '*.txt;*.md;*.json;*.csv;*.log' },
      ],
      AllowsOtherFiletypes: true,
    },
    onPaths: (paths) => {
      const path = paths[0];
      if (path) void loadPath(path);
    },
    onError: () => toast.add({ title: t('textTool.openFileFailed'), type: 'error' }),
  });
  useFocusOnActivate(active, () => inputView.current?.focus());
  const stats = useMemo(() => analyzeText(value), [value]);
  const apply = (fn: (input: string) => string) => {
    setValue(fn(value));
  };
  // 确认后只记录非空输入，输入框本身随对话框关闭而重置。
  const applyAffixes = (prefix: string, suffix: string) => {
    setValue((input) => addLineAffixes(input, prefix, suffix));
    setAffixHistory((history) => ({
      prefix: rememberAffix(history.prefix, prefix),
      suffix: rememberAffix(history.suffix, suffix),
    }));
  };
  const updateAffixHistory = (field: AffixField, update: (entries: string[]) => string[]) => {
    setAffixHistory((history) => ({ ...history, [field]: update(history[field]) }));
  };
  const deleteAffixHistory = (field: AffixField, entry: string) =>
    updateAffixHistory(field, (entries) => entries.filter((item) => item !== entry));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.add({
        title: t('toast.copied', { value: `${[...value].length} ${t('textTool.characters')}` }),
      });
    } catch {
      toast.add({ title: t('toast.copyFailed'), type: 'error' });
    }
  };
  useEffect(() => {
    if (!pending || pending.tool !== 'text' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    const transforms: Record<string, (input: string) => string> = {
      trim: spaceTransforms.trim,
      removeSpaces: spaceTransforms.removeSpaces,
      compress: spaceTransforms.compressSpaces,
      ...lineTransforms,
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
      if (next)
        void (async () => {
          try {
            await navigator.clipboard.writeText(next);
          } catch {
            toast.add({ title: t('toast.copyFailed'), type: 'error' });
          }
        })();
      return;
    }
    if (transforms[pending.action]) {
      setValue(transforms[pending.action](value));
      return;
    }
    setValue(pending.input);
  }, [pending, value, t]);
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
        <ToolLayoutContent className="grid grid-rows-[minmax(0,1fr)_auto] gap-3">
          <div
            className="flex min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground"
            {...fileDrop.dropProps}
          >
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span>{t('textTool.input')}</span>
              <span className="flex min-w-0 items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 flex-none gap-1.5 px-2 text-[11px]"
                  onClick={() => void fileDrop.pick()}
                >
                  <UploadSimple data-icon="inline-start" weight="duotone" />
                  {t('textTool.openFile')}
                </Button>
                <Label className="min-w-0 gap-1.5 text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
                  <Checkbox
                    checked={alwaysShowSearch}
                    onCheckedChange={(checked) => onAlwaysShowSearchChange(checked === true)}
                  />
                  <span>{t('textTool.alwaysShowSearch')}</span>
                </Label>
              </span>
            </span>
            <div ref={paneRef} className="relative flex min-h-0 min-w-0 flex-1">
              <CodeMirror
                className={editorSurfaceClass}
                height="100%"
                value={value}
                onChange={setValue}
                onCreateEditor={(view) => {
                  view.contentDOM.setAttribute('aria-label', t('textTool.input'));
                  inputView.current = view;
                  setEditorReady(true);
                  requestAnimationFrame(measureHint);
                }}
                theme={quietEditorTheme}
                extensions={editorExtensions}
                basicSetup={editorBasicSetup}
              />
              {showHint && hintPos ? (
                <div
                  className="pointer-events-none absolute z-[1] font-[monospace] text-[length:var(--code-editor-font-size)] leading-[1.4] normal-case tracking-normal text-muted-foreground"
                  style={{ left: hintPos.left, top: hintPos.top }}
                >
                  <Trans
                    i18nKey="textTool.placeholder"
                    components={{
                      open: (
                        <button
                          type="button"
                          className="pointer-events-auto cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-primary underline underline-offset-2"
                          onClick={(event) => {
                            event.preventDefault();
                            void fileDrop.pick();
                          }}
                        />
                      ),
                    }}
                  />
                </div>
              ) : null}
            </div>
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
                icon: TextAa,
                type: 'menu',
                disabled: !value,
                options: caseModeGroups.flatMap((group, index) =>
                  group.map((key) => ({
                    key,
                    label: t(`textTool.caseModes.${key}`),
                    group: String(index),
                  })),
                ),
                onSelect: (mode) => apply((input) => transformCase(input, mode as CaseMode)),
              },
              {
                key: 'spaces',
                label: t('textTool.spaces'),
                icon: ArrowsInLineHorizontal,
                type: 'menu',
                disabled: !value,
                options: ['trim', 'compressSpaces', 'removeSpaces'].map((key) => ({
                  key,
                  label: t(`textTool.${key}`),
                })),
                onSelect: (mode) => apply(spaceTransforms[mode]),
              },
              {
                key: 'lines',
                label: t('textTool.line'),
                icon: ArrowsInLineVertical,
                type: 'menu',
                disabled: !value,
                options: [
                  ...['compressLine', 'compressLineNoTrailingBackslash', 'removeEmptyLines'].map(
                    (key) => ({ key, label: t(`textTool.${key}`), group: 'transform' }),
                  ),
                  { key: 'affix', label: t('textTool.affix'), group: 'affix' },
                ],
                onSelect: (mode) => {
                  if (mode === 'affix') {
                    setAffixOpen(true);
                    return;
                  }
                  apply(lineTransforms[mode]);
                },
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
        {affixOpen ? (
          <AffixDialog
            histories={affixHistory}
            onDeleteHistory={deleteAffixHistory}
            onApply={applyAffixes}
            onClose={() => setAffixOpen(false)}
          />
        ) : null}
      </ToolLayout>
    </Reveal>
  );
}
