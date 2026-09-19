import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Check, Copy, Plus, Trash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { quietEditorTheme } from './codeMirrorTheme';
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
  type ToolId,
} from './shared';
import { toast } from './ui/toast';
import {
  appendUrlParam,
  parseSupportedUrl,
  removeUrlParam,
  updateUrlPart,
  urlParamsJson,
} from '../utils/url';
import '../styles/tools/editor.css';

function UrlPart({
  label,
  value,
  id,
  editable,
  fallback = '/',
  onChange,
  onCopy,
}: {
  label: string;
  value: string;
  id: string;
  editable: boolean;
  fallback?: string;
  onChange: (value: string) => void;
  onCopy: (id: string, value: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const labelId = `${id}-label`;
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)_32px] items-center gap-3 border-b border-border px-0.5 py-[13px] last:border-b-0">
      <span
        id={labelId}
        className="font-mono text-[10px] leading-[1.35] font-medium uppercase tracking-[.04em] text-muted-foreground"
      >
        {label}
      </span>
      {editable ? (
        <Input
          aria-labelledby={labelId}
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 select-text font-mono text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <code
          aria-labelledby={labelId}
          className="min-w-0 overflow-wrap-anywhere font-mono text-xs leading-6 text-foreground"
        >
          {value || fallback}
        </code>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-8 min-w-8 flex-none"
        aria-label={t('urlTool.copyPart', { part: label })}
        onClick={() => onCopy(id, value, label)}
      >
        <Copy size={14} weight="duotone" />
      </Button>
    </div>
  );
}

export default function UrlTool({
  active,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  theme: string;
  record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [editResults, setEditResults] = useState(false);
  const inputView = useRef<EditorView | null>(null);
  const consumed = useRef<PendingAction | null>(null);
  const lastRecorded = useRef('');
  const recordTimer = useRef<number | null>(null);
  const [copied, setCopied] = useState('');
  const parts = useMemo(() => parseSupportedUrl(input), [input]);
  const invalid = !!input.trim() && !parts;
  useFocusOnActivate(active, () => inputView.current?.focus());
  const output = parts ? JSON.stringify(parts, null, 2) : '';
  useEffect(() => {
    const value = input.trim();
    if (recordTimer.current !== null) {
      window.clearTimeout(recordTimer.current);
      recordTimer.current = null;
    }
    if (parts && value && lastRecorded.current !== value)
      recordTimer.current = window.setTimeout(() => {
        recordTimer.current = null;
        lastRecorded.current = value;
        record(
          'url',
          t('urlTool.analyzed'),
          t('urlTool.paramCount', { count: parts.params.length }),
          input,
          output,
        );
      }, 1500);
    else if (!value) lastRecorded.current = '';
    return () => {
      if (recordTimer.current !== null) window.clearTimeout(recordTimer.current);
    };
  }, [parts, input, output, record, t]);
  const copyValue = async (id: string, value: string, label: string) => {
    await navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? '' : current)), 1600);
    toast.add({ title: t('toast.copied', { value: label }) });
  };
  const copy = async () => {
    if (!parts) return;
    await copyValue('all', output, t('urlTool.copied'));
    record(
      'url',
      t('urlTool.copy'),
      t('urlTool.paramCount', { count: parts.params.length }),
      input,
      output,
    );
  };
  useEffect(() => {
    if (!pending || pending.tool !== 'url' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'clear') {
      setInput('');
      return;
    }
    if (pending.action === 'copy') {
      if (!parts) toast.add({ title: t('urlTool.invalid'), type: 'warning' });
      else void copy();
      return;
    }
    setInput(pending.input);
  }, [pending, parts]);
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('urlTool.title')} />
        <ToolLayoutToolbar
          right={
            <ToolLayoutToolbarGroup>
              <Label className="flex h-8 flex-none items-center gap-2 border border-transparent bg-transparent py-0 pr-1.5 text-[11px] text-muted-foreground">
                <span>{t('urlTool.editResults')}</span>
                <Switch
                  checked={editResults}
                  onCheckedChange={(checked) => setEditResults(checked === true)}
                  size="sm"
                />
              </Label>
            </ToolLayoutToolbarGroup>
          }
        />
        <ToolLayoutContent>
          <div className="grid h-full min-h-0 min-w-0 grid-cols-2 grid-rows-[minmax(0,1fr)] gap-3 max-[700px]:grid-cols-1 max-[700px]:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-h-0 min-w-0 flex-col gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
              <span>{t('urlTool.input')}</span>
              <CodeMirror
                className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card focus-within:border-muted-foreground [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto"
                height="100%"
                value={input}
                onChange={setInput}
                onCreateEditor={(view) => {
                  view.contentDOM.setAttribute('aria-label', t('urlTool.input'));
                  inputView.current = view;
                }}
                theme={quietEditorTheme}
                extensions={[EditorView.lineWrapping]}
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
            <ScrollArea className="min-h-0 min-w-0">
              {parts ? (
                <>
                  <UrlPart
                    label={t('urlTool.protocol')}
                    value={parts.protocol}
                    id="protocol"
                    editable={editResults}
                    fallback=""
                    onChange={(value) => setInput(updateUrlPart(input, { protocol: value }))}
                    onCopy={copyValue}
                  />
                  <UrlPart
                    label={t('urlTool.hostname')}
                    value={parts.hostname}
                    id="hostname"
                    editable={editResults}
                    fallback=""
                    onChange={(value) => setInput(updateUrlPart(input, { hostname: value }))}
                    onCopy={copyValue}
                  />
                  {editResults || parts.port ? (
                    <UrlPart
                      label={t('urlTool.port')}
                      value={parts.port}
                      id="port"
                      editable={editResults}
                      fallback=""
                      onChange={(value) => setInput(updateUrlPart(input, { port: value }))}
                      onCopy={copyValue}
                    />
                  ) : null}
                  <UrlPart
                    label={t('urlTool.base')}
                    value={parts.base}
                    id="base"
                    editable={editResults}
                    onChange={(value) => setInput(updateUrlPart(input, { base: value }))}
                    onCopy={copyValue}
                  />
                  {editResults || parts.username || parts.password ? (
                    <>
                      <UrlPart
                        label={t('urlTool.username')}
                        value={parts.username}
                        id="username"
                        editable={editResults}
                        fallback=""
                        onChange={(value) => setInput(updateUrlPart(input, { username: value }))}
                        onCopy={copyValue}
                      />
                      <UrlPart
                        label={t('urlTool.password')}
                        value={parts.password}
                        id="password"
                        editable={editResults}
                        fallback=""
                        onChange={(value) => setInput(updateUrlPart(input, { password: value }))}
                        onCopy={copyValue}
                      />
                    </>
                  ) : null}
                  <UrlPart
                    label={t('urlTool.path')}
                    value={parts.path}
                    id="path"
                    editable={editResults}
                    onChange={(value) => setInput(updateUrlPart(input, { path: value }))}
                    onCopy={copyValue}
                  />
                  {editResults || parts.hash ? (
                    <UrlPart
                      label={t('urlTool.hash')}
                      value={parts.hash}
                      id="hash"
                      editable={editResults}
                      onChange={(value) => setInput(updateUrlPart(input, { hash: value }))}
                      onCopy={copyValue}
                    />
                  ) : null}
                  {editResults || parts.params.length > 0 ? (
                    <div className="grid grid-cols-[104px_minmax(0,1fr)_32px] items-start gap-3 border-b border-border px-0.5 py-[13px] last:border-b-0">
                      <span
                        id="url-params-label"
                        className="pt-[7px] font-mono text-[10px] leading-[1.35] font-medium uppercase tracking-[.04em] text-muted-foreground"
                      >
                        {t('urlTool.params')}
                      </span>
                      <div
                        className="min-w-0 overflow-hidden rounded-lg border border-border bg-border"
                        role="group"
                        aria-labelledby="url-params-label"
                      >
                        {parts.params.length ? (
                          parts.params.map(([key, value], index) => (
                            <div
                              key={index}
                              className={`grid gap-px border-b border-border last:border-b-0 ${
                                editResults
                                  ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]'
                                  : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
                              }`}
                            >
                              {editResults ? (
                                <>
                                  <Input
                                    aria-label={key || t('urlTool.params')}
                                    autoComplete="off"
                                    spellCheck={false}
                                    className="h-8 min-w-0 rounded-none border-0 bg-card px-2 py-[7px] font-mono text-xs shadow-none select-text focus-visible:ring-0 dark:bg-card"
                                    value={key}
                                    onChange={(event) =>
                                      setInput(
                                        updateUrlPart(input, {
                                          param: { index, key: event.target.value },
                                        }),
                                      )
                                    }
                                  />
                                  <Input
                                    aria-label={value || t('urlTool.params')}
                                    autoComplete="off"
                                    spellCheck={false}
                                    className="h-8 min-w-0 rounded-none border-0 bg-card px-2 py-[7px] font-mono text-xs shadow-none select-text focus-visible:ring-0 dark:bg-card"
                                    value={value}
                                    onChange={(event) =>
                                      setInput(
                                        updateUrlPart(input, {
                                          param: { index, value: event.target.value },
                                        }),
                                      )
                                    }
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 min-w-8 flex-none rounded-none bg-card"
                                    aria-label={t('urlTool.removeParam')}
                                    onClick={() => setInput(removeUrlParam(input, index))}
                                  >
                                    <Trash size={14} weight="duotone" />
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <code className="min-w-0 overflow-wrap-anywhere bg-card px-2 py-[7px] font-mono text-xs leading-5 text-foreground">
                                    {key}
                                  </code>
                                  <code className="min-w-0 overflow-wrap-anywhere bg-card px-2 py-[7px] font-mono text-xs leading-5 text-foreground">
                                    {value}
                                  </code>
                                </>
                              )}
                            </div>
                          ))
                        ) : editResults ? null : (
                          <div className="bg-card px-2 py-[7px] text-xs normal-case">
                            {t('urlTool.noParams')}
                          </div>
                        )}
                        {editResults ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-full min-w-0 justify-start rounded-none bg-card px-2 text-xs font-normal"
                            aria-label={t('urlTool.addParam')}
                            onClick={() => setInput(appendUrlParam(input))}
                          >
                            <Plus data-icon="inline-start" size={14} weight="duotone" />
                            {t('urlTool.addParam')}
                          </Button>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 min-w-8 flex-none"
                        aria-label={t('urlTool.copyPart', { part: t('urlTool.params') })}
                        onClick={() =>
                          void copyValue('params', urlParamsJson(parts.params), t('urlTool.params'))
                        }
                      >
                        <Copy size={14} weight="duotone" />
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                  <strong className="text-xs text-foreground">
                    {invalid ? t('urlTool.invalid') : t('urlTool.empty')}
                  </strong>
                  <span className="max-w-[270px] text-[11px] leading-5">
                    {invalid ? t('urlTool.invalidHint') : t('urlTool.emptyHint')}
                  </span>
                </div>
              )}
            </ScrollArea>
          </div>
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('urlTool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('urlTool.clear'),
                icon: Trash,
                variant: 'tertiary',
                disabled: !input,
                onPress: () => setInput(''),
              },
              {
                key: 'copyInput',
                label:
                  copied === 'input'
                    ? t('urlTool.partCopied', { part: t('urlTool.input') })
                    : t('urlTool.copyPart', { part: t('urlTool.input') }),
                icon: copied === 'input' ? Check : Copy,
                variant: 'secondary',
                disabled: !input,
                onPress: () => void copyValue('input', input, t('urlTool.input')),
              },
              {
                key: 'copy',
                label: copied === 'all' ? t('urlTool.copied') : t('urlTool.copy'),
                icon: copied === 'all' ? Check : Copy,
                variant: 'primary',
                disabled: !parts,
                onPress: () => void copy(),
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>
    </Reveal>
  );
}
