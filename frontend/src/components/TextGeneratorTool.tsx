import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClipboardText,
  GearSix,
  HashStraight,
  PencilSimple,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { TextGeneratorSource } from '../../bindings/changeme/models';
import { Button } from './ui/button';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Slider } from './ui/slider';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';
import {
  Reveal,
  ToolActionBar,
  ToolLayout,
  ToolLayoutContent,
  ToolLayoutFooter,
  ToolLayoutHeader,
  ToolLayoutToolbar,
  type PendingAction,
  type ToolId,
} from './shared';
import {
  DIGITS,
  LOWERCASE,
  SYMBOLS,
  UPPERCASE,
  generateItems,
  linePool,
  parseSeparator,
  quoteValue,
  type QuoteMode,
} from '../lib/text-generator';

type SourceChoice = 'charset' | 'uuid' | `custom:${string}`;
type CharacterSet = 'uppercase' | 'lowercase' | 'digits' | 'symbols';
const QUICK_LENGTHS = [4, 6, 8, 12, 16, 32, 64, 128];
const DEFAULT_SETS: CharacterSet[] = ['uppercase', 'lowercase', 'digits'];
const SET_VALUES: Record<CharacterSet, string> = {
  uppercase: UPPERCASE,
  lowercase: LOWERCASE,
  digits: DIGITS,
  symbols: SYMBOLS,
};

export default function TextGeneratorTool({
  active,
  sources,
  onSourcesChange,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  sources: TextGeneratorSource[];
  onSourcesChange: (sources: TextGeneratorSource[]) => void;
  record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceChoice>('charset');
  const [sets, setSets] = useState<CharacterSet[]>(DEFAULT_SETS);
  const [length, setLength] = useState(32);
  const [quantity, setQuantity] = useState(5);
  const [separator, setSeparator] = useState(',\\n');
  const [quote, setQuote] = useState<QuoteMode>('none');
  const [items, setItems] = useState<string[]>([]);
  const [restoredOutput, setRestoredOutput] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [editing, setEditing] = useState<TextGeneratorSource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TextGeneratorSource | null>(null);
  const consumed = useRef<PendingAction | null>(null);
  const selectedCustom = source.startsWith('custom:')
    ? sources.find((item) => item.id === source.slice(7))
    : undefined;
  const customSelected = source.startsWith('custom:');
  const lengthDisabled = source === 'uuid';
  const sourceLabel =
    source === 'uuid'
      ? t('textGeneratorTool.uuid')
      : (selectedCustom?.name ?? t('textGeneratorTool.charset'));
  const quoteItems = useMemo(
    () =>
      (['none', 'single', 'double'] as QuoteMode[]).map((value) => ({
        value,
        label: t(`textGeneratorTool.quotes.${value}`),
      })),
    [t],
  );
  const modeItems = useMemo(
    () =>
      (['character', 'line'] as const).map((value) => ({
        value,
        label: t(`textGeneratorTool.modes.${value}`),
      })),
    [t],
  );
  const pool = useMemo(() => {
    if (source === 'charset') return Array.from(sets.map((key) => SET_VALUES[key]).join(''));
    if (!selectedCustom) return [];
    return selectedCustom.mode === 'line'
      ? linePool(selectedCustom.content)
      : Array.from(selectedCustom.content);
  }, [selectedCustom, sets, source]);
  const output = useMemo(
    () =>
      restoredOutput ??
      items.map((item) => quoteValue(item, quote)).join(parseSeparator(separator)),
    [items, quote, restoredOutput, separator],
  );

  const generate = () => {
    if (source === 'charset' && sets.length === 0) {
      toast.add({ title: t('textGeneratorTool.selectOneSet'), type: 'warning' });
      return;
    }
    if (source !== 'uuid' && pool.length === 0) {
      toast.add({ title: t('textGeneratorTool.emptySource'), type: 'warning' });
      return;
    }
    const next = generateItems({
      kind: source === 'uuid' ? 'uuid' : selectedCustom?.mode === 'line' ? 'line' : 'character',
      pool,
      length,
      quantity,
    });
    setItems(next);
    setRestoredOutput(null);
    record(
      'text-generator',
      t('textGeneratorTool.generate'),
      t('textGeneratorTool.historyDetail', { source: sourceLabel, total: quantity }),
      '',
      next.map((item) => quoteValue(item, quote)).join(parseSeparator(separator)),
    );
  };

  useEffect(() => {
    if (!pending || pending.tool !== 'text-generator' || consumed.current === pending) return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'generate') generate();
    else if (pending.action === 'restore') {
      setItems([]);
      setRestoredOutput(pending.output ?? '');
    }
  }, [pending, pool, source, sets, length, quantity, separator, quote]);

  const saveSource = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const normalized = { ...editing, name: editing.name.trim() };
    if (!normalized.name || !normalized.content) return;
    const exists = sources.some((item) => item.id === normalized.id);
    onSourcesChange(
      exists
        ? sources.map((item) => (item.id === normalized.id ? normalized : item))
        : [...sources, normalized],
    );
    setEditing(null);
  };
  const removeSource = () => {
    if (!deleteTarget) return;
    onSourcesChange(sources.filter((item) => item.id !== deleteTarget.id));
    if (source === `custom:${deleteTarget.id}`) {
      setSource('charset');
      setSets(DEFAULT_SETS);
    }
    setDeleteTarget(null);
  };

  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader
          title={t('textGeneratorTool.title')}
          subtitle={t('textGeneratorTool.subtitle')}
        />
        <ToolLayoutToolbar
          left={
            <>
              <div className="grid gap-1.5">
                <Label className="text-[11px] text-muted-foreground">
                  {t('textGeneratorTool.source')}
                </Label>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="outline" className="h-8 min-w-44 justify-between" />}
                  >
                    {sourceLabel}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="min-w-56">
                    <DropdownMenuGroup>
                      <DropdownMenuCheckboxItem
                        checked={source === 'uuid'}
                        disabled={customSelected}
                        closeOnClick={false}
                        onCheckedChange={(checked) => setSource(checked ? 'uuid' : 'charset')}
                      >
                        {t('textGeneratorTool.uuid')}
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('textGeneratorTool.charset')}</DropdownMenuLabel>
                      {(['uppercase', 'lowercase', 'digits', 'symbols'] as CharacterSet[]).map(
                        (key) => (
                          <DropdownMenuCheckboxItem
                            key={key}
                            checked={sets.includes(key)}
                            disabled={source === 'uuid' || customSelected}
                            closeOnClick={false}
                            onCheckedChange={(checked) => {
                              setSource('charset');
                              setSets((current) =>
                                checked
                                  ? [...new Set([...current, key])]
                                  : current.filter((item) => item !== key),
                              );
                            }}
                          >
                            {t(`textGeneratorTool.sets.${key}`)}
                          </DropdownMenuCheckboxItem>
                        ),
                      )}
                    </DropdownMenuGroup>
                    {sources.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>
                            {t('textGeneratorTool.customSources')}
                          </DropdownMenuLabel>
                          {sources.map((item) => (
                            <DropdownMenuCheckboxItem
                              key={item.id}
                              checked={source === `custom:${item.id}`}
                              closeOnClick={false}
                              onCheckedChange={(checked) =>
                                setSource(checked ? `custom:${item.id}` : 'charset')
                              }
                            >
                              {item.name}
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuGroup>
                      </>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setManagerOpen(true)}>
                      <span className="flex items-center gap-2">
                        <GearSix size={14} weight="duotone" />
                        {t('textGeneratorTool.manage')}
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="grid min-w-72 gap-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <Label id="text-generator-length">{t('textGeneratorTool.length')}</Label>
                  <span className="tabular-nums">{length}</span>
                </div>
                <Slider
                  min={1}
                  max={512}
                  step={1}
                  value={[length]}
                  disabled={lengthDisabled}
                  aria-labelledby="text-generator-length"
                  onValueChange={(value) => setLength(Array.isArray(value) ? value[0] : value)}
                />
                <div className="flex gap-1">
                  {QUICK_LENGTHS.map((value) => (
                    <Button
                      key={value}
                      size="xs"
                      variant={length === value ? 'default' : 'outline'}
                      disabled={lengthDisabled}
                      onClick={() => setLength(value)}
                    >
                      {value}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          }
          right={
            <>
              <Label className="grid gap-1.5 text-[11px] text-muted-foreground">
                {t('textGeneratorTool.quantity')}
                <Input
                  className="w-24"
                  type="number"
                  min={1}
                  max={1000}
                  value={quantity}
                  onChange={(event) =>
                    setQuantity(Math.min(1000, Math.max(1, Number(event.target.value) || 1)))
                  }
                />
              </Label>
              <Label className="grid gap-1.5 text-[11px] text-muted-foreground">
                {t('textGeneratorTool.separator')}
                <Input
                  className="w-28 font-mono"
                  value={separator}
                  onChange={(event) => setSeparator(event.target.value)}
                />
              </Label>
              <div className="grid gap-1.5">
                <Label className="text-[11px] text-muted-foreground">
                  {t('textGeneratorTool.quote')}
                </Label>
                <Select
                  items={quoteItems}
                  value={quote}
                  onValueChange={(value) => setQuote(value as QuoteMode)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {quoteItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </>
          }
        />
        <ToolLayoutContent>
          <Textarea
            readOnly
            value={output}
            placeholder={t('textGeneratorTool.outputPlaceholder')}
            aria-label={t('textGeneratorTool.output')}
            className="h-full min-h-0 resize-none font-mono"
          />
        </ToolLayoutContent>
        <ToolLayoutFooter>
          <ToolActionBar
            label={t('textGeneratorTool.actions')}
            actions={[
              {
                key: 'clear',
                label: t('common.clear'),
                icon: X,
                variant: 'tertiary',
                disabled: !output,
                onPress: () => {
                  setItems([]);
                  setRestoredOutput(null);
                },
              },
              {
                key: 'copy',
                label: t('common.copy'),
                icon: ClipboardText,
                variant: 'secondary',
                disabled: !output,
                onPress: () =>
                  void navigator.clipboard.writeText(output).then(() =>
                    toast.add({
                      title: t('toast.copied', { value: t('textGeneratorTool.output') }),
                    }),
                  ),
              },
              {
                key: 'generate',
                label: t('textGeneratorTool.generate'),
                icon: HashStraight,
                variant: 'primary',
                onPress: generate,
              },
            ]}
          />
        </ToolLayoutFooter>
      </ToolLayout>

      <Dialog
        open={managerOpen}
        onOpenChange={(open) => {
          setManagerOpen(open);
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="grid max-h-[min(680px,calc(100vh-4rem))] min-h-0 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('textGeneratorTool.managerTitle')}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <form
              id="text-generator-source-form"
              className="grid min-h-0 gap-4 overflow-y-auto"
              onSubmit={saveSource}
            >
              <Label className="grid gap-1.5">
                {t('textGeneratorTool.sourceName')}
                <Input
                  autoFocus
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
              </Label>
              <Label className="grid gap-1.5">
                {t('textGeneratorTool.mode')}
                <Select
                  items={modeItems}
                  value={editing.mode}
                  onValueChange={(mode) =>
                    setEditing({ ...editing, mode: mode as 'character' | 'line' })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {modeItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Label>
              <Label className="grid min-h-0 gap-1.5">
                {t('textGeneratorTool.content')}
                <Textarea
                  className="min-h-48 resize-y font-mono"
                  value={editing.content}
                  onChange={(event) => setEditing({ ...editing, content: event.target.value })}
                />
              </Label>
            </form>
          ) : (
            <div className="min-h-28 overflow-y-auto divide-y divide-border">
              {sources.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">
                  {t('textGeneratorTool.noCustomSources')}
                </p>
              ) : (
                sources.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate font-medium">{item.name}</p>
                      <p className="m-0 text-xs text-muted-foreground">
                        {t(`textGeneratorTool.modes.${item.mode}`)}
                      </p>
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('common.edit')}
                      onClick={() => setEditing({ ...item })}
                    >
                      <PencilSimple weight="duotone" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive"
                      aria-label={t('common.delete')}
                      onClick={() => setDeleteTarget(item)}
                    >
                      <Trash weight="duotone" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
          <DialogFooter>
            {editing ? (
              <>
                <Button variant="outline" onClick={() => setEditing(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  form="text-generator-source-form"
                  disabled={!editing.name.trim() || !editing.content}
                >
                  {t('common.save')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setManagerOpen(false)}>
                  {t('common.close')}
                </Button>
                <Button
                  onClick={() =>
                    setEditing({
                      id: crypto.randomUUID(),
                      name: '',
                      content: '',
                      mode: 'character',
                    })
                  }
                >
                  <Plus weight="duotone" />
                  {t('common.add')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('textGeneratorTool.deleteTitle')}
        description={
          deleteTarget ? t('textGeneratorTool.deleteDescription', { name: deleteTarget.name }) : ''
        }
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={removeSource}
      />
    </Reveal>
  );
}
