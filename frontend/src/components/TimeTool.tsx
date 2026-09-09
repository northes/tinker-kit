import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Clock, Copy, DotsSixVertical, Eye, EyeClosed, GpsFix, Globe } from '@phosphor-icons/react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from './ui/combobox';
import {
  Reveal,
  ToolLayoutContent,
  ToolLayoutHeader,
  ToolLayout,
  undoRedoKey,
  useFocusOnActivate,
  useHistory,
  type PendingAction,
  type ToolId,
} from './shared';
import DateCalculator, { dateCalculatorModes } from './DateCalculator';
import DateTimePickerPopover from './DateTimePickerPopover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import {
  formatTimeInZone,
  getSystemTimeZone,
  getTimeZoneOptions,
  parseTimeInput,
  resolveTimePreset,
  type TimePreset,
} from '../utils/time';
import { toast } from './ui/toast';

const resultIds = [
  'local',
  'dateTime',
  'dateOnly',
  'timeOnly',
  'zonedIso8601',
  'rfc3339',
  'utc',
  'compact',
  'underscore',
  'unixSeconds',
  'unixMilliseconds',
  'unixNanoseconds',
] as const;
type TimeResultId = (typeof resultIds)[number];
type TimeToolMode = 'convert' | 'dateCalculator';
const timePresets: TimePreset[] = [
  'now',
  'sevenDaysAgo',
  'weekMonday',
  'monthStart',
  'monthEnd',
  'yearStart',
  'yearEnd',
];
function normalizeOrder(order: string[]) {
  const valid = new Set<string>(resultIds),
    seen = new Set<string>(),
    next: TimeResultId[] = [];
  for (const id of order)
    if (valid.has(id) && !seen.has(id)) {
      next.push(id as TimeResultId);
      seen.add(id);
    }
  for (const id of resultIds) if (!seen.has(id)) next.push(id);
  return next;
}
function TimezoneCombobox({
  value,
  onChange,
  zones,
  placeholder,
  emptyLabel,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  zones: Array<{ id: string; label: string }>;
  placeholder: string;
  emptyLabel: string;
  label: string;
}) {
  const labelId = useId();
  const current = zones.find((zone) => zone.id === value);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 pt-3.5 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
      <span id={labelId}>{label}</span>
      <Combobox
        items={zones}
        value={current ?? null}
        onValueChange={(zone) => {
          if (zone) onChange(zone.id);
        }}
        itemToStringValue={(zone) => zone.label}
      >
        <ComboboxTrigger
          render={
            <Button
              variant="ghost"
              className="h-[46px] w-full justify-between rounded-lg border border-border bg-card px-3.5 text-[13px] font-normal"
              aria-labelledby={labelId}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Globe data-icon="inline-start" size={18} weight="duotone" />
            <span className="min-w-0 truncate">
              <ComboboxValue placeholder={placeholder} />
            </span>
          </span>
        </ComboboxTrigger>
        <ComboboxContent className="min-w-(--anchor-width)">
          <ComboboxInput
            inputClassName="select-text"
            showTrigger={false}
            placeholder={placeholder}
          />
          <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
          <ComboboxList>
            {(zone) => (
              <ComboboxItem key={zone.id} value={zone}>
                {zone.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date),
    get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}
function zonedOffset(date: Date, timeZone: string) {
  const part =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(date)
        .find((item) => item.type === 'timeZoneName')?.value || 'GMT',
    match = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return match ? `${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}` : 'Z';
}
function TimeResultRow({
  id,
  label,
  value,
  hidden,
  editing,
  onCopy,
  onToggle,
}: {
  id: TimeResultId;
  label: string;
  value: string;
  hidden: boolean;
  editing: boolean;
  onCopy: () => void;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const sortable = useSortable({ id, disabled: !editing });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    zIndex: sortable.isDragging ? 1 : undefined,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      data-time-result-id={id}
      className={`grid min-h-11 items-center border-b border-border px-1 ${editing ? 'grid-cols-[30px_110px_minmax(0,1fr)_34px]' : 'grid-cols-[110px_minmax(0,1fr)]'} ${hidden ? 'opacity-40' : ''} ${sortable.isDragging ? 'bg-accent' : ''}`}
    >
      {editing && (
        <Button
          ref={sortable.setActivatorNodeRef}
          variant="ghost"
          size="icon-sm"
          className="flex-none cursor-grab active:cursor-grabbing"
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label={t('timeTool.dragResult', { label })}
        >
          <DotsSixVertical size={16} weight="duotone" />
        </Button>
      )}
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Button
        variant="ghost"
        className="min-h-9 min-w-0 justify-start gap-2.5 rounded-lg px-3"
        onClick={onCopy}
      >
        <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-foreground">
          {value}
        </code>
        <Copy data-icon="inline-end" size={15} weight="duotone" />
      </Button>
      {editing && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="flex-none"
          onClick={onToggle}
          aria-label={t(hidden ? 'timeTool.showResult' : 'timeTool.hideResult', { label })}
        >
          {hidden ? <Eye size={16} weight="duotone" /> : <EyeClosed size={16} weight="duotone" />}
        </Button>
      )}
    </div>
  );
}
export default function TimeTool({
  active,
  resultOrder,
  hiddenResults,
  onSaveResults,
  record,
  pending,
  clearPending,
}: {
  active: boolean;
  resultOrder: string[];
  hiddenResults: string[];
  onSaveResults: (order: string[], hidden: string[]) => void;
  record: (tool: ToolId, action: string, detail: string, input: string) => void;
  pending: PendingAction | null;
  clearPending: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { value: input, setValue: setInput, undo, redo } = useHistory('');
  const [timeZone, setTimeZone] = useState(getSystemTimeZone);
  const zones = useMemo(() => getTimeZoneOptions(), []);
  const consumed = useRef<PendingAction | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<TimeToolMode>('convert');
  const [editing, setEditing] = useState(false);
  const [draftOrder, setDraftOrder] = useState<TimeResultId[]>(() => normalizeOrder(resultOrder));
  const [draftHidden, setDraftHidden] = useState<Set<string>>(() => new Set(hiddenResults));
  const draftOrderRef = useRef(draftOrder),
    draftHiddenRef = useRef(draftHidden);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useFocusOnActivate(active, () => inputRef.current?.focus());
  const parsed = useMemo(() => parseTimeInput(input, new Date(), timeZone), [input, timeZone]);
  const values = useMemo<Record<TimeResultId, string>>(() => {
    if (!parsed)
      return Object.fromEntries(resultIds.map((id) => [id, ''])) as Record<TimeResultId, string>;
    const part = zonedParts(parsed, timeZone),
      date = `${part.year}-${part.month}-${part.day}`,
      time = `${part.hour}:${part.minute}:${part.second}`;
    return {
      local: formatTimeInZone(parsed, timeZone),
      dateTime: `${date} ${time}`,
      dateOnly: date,
      timeOnly: time,
      zonedIso8601: `${date}T${time}${zonedOffset(parsed, timeZone)}`,
      rfc3339: parsed.toISOString(),
      utc: parsed.toUTCString(),
      compact: `${part.year}${part.month}${part.day}${part.hour}${part.minute}${part.second}`,
      underscore: `${part.year}_${part.month}_${part.day}_${part.hour}_${part.minute}_${part.second}`,
      unixSeconds: Math.floor(parsed.getTime() / 1000).toString(),
      unixMilliseconds: parsed.getTime().toString(),
      unixNanoseconds: (BigInt(parsed.getTime()) * 1000000n).toString(),
    };
  }, [parsed, timeZone]);
  const order = normalizeOrder(resultOrder),
    hidden = new Set(hiddenResults),
    displayedResults = editing ? draftOrder : order.filter((id) => !hidden.has(id));
  const applyTimePreset = (preset: TimePreset) => {
    const date = resolveTimePreset(preset, new Date(), timeZone);
    if (!date) return;
    const timestamp = Math.floor(date.getTime() / 1000).toString();
    setInput(timestamp, { isolate: true });
    record('time', t(`timeTool.presets.${preset}`), timestamp, timestamp);
  };
  useEffect(() => {
    if (!pending || pending.tool !== 'time' || consumed.current === pending) return;
    if (
      pending.action === 'restore' &&
      (pending.mode === dateCalculatorModes.difference ||
        pending.mode === dateCalculatorModes.calculation)
    )
      return;
    consumed.current = pending;
    clearPending();
    if (pending.action === 'refresh') {
      applyTimePreset('now');
      return;
    }
    if (pending.action === 'timezone') {
      setTimeZone(getSystemTimeZone());
      return;
    }
    setInput(pending.input, { isolate: true });
    if (pending.action !== 'restore')
      record('time', t('timeTool.converted'), pending.input.trim().slice(0, 40), pending.input);
  }, [pending]);
  const copyResult = (id: TimeResultId) => {
    const label = t(`timeTool.${id}`),
      value = values[id];
    navigator.clipboard?.writeText(value).catch(() => {});
    toast.add({ title: t('toast.copied', { value }) });
    record('time', t('timeTool.converted'), label, input);
  };
  const startEditing = () => {
    const next = normalizeOrder(resultOrder),
      nextHidden = new Set(hiddenResults);
    if (!input.trim()) setInput(Math.floor(Date.now() / 1000).toString(), { isolate: true });
    draftOrderRef.current = next;
    draftHiddenRef.current = nextHidden;
    setDraftOrder(next);
    setDraftHidden(nextHidden);
    setEditing(true);
  };
  const finishEditing = () => {
    onSaveResults(draftOrderRef.current, [...draftHiddenRef.current]);
    setEditing(false);
  };
  const toggleResult = (id: TimeResultId) => {
    const next = new Set(draftHiddenRef.current);
    next.has(id) ? next.delete(id) : next.add(id);
    draftHiddenRef.current = next;
    setDraftHidden(next);
  };
  const moveResult = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= draftOrderRef.current.length ||
      toIndex >= draftOrderRef.current.length ||
      fromIndex === toIndex
    )
      return;
    const next = arrayMove(draftOrderRef.current, fromIndex, toIndex);
    draftOrderRef.current = next;
    setDraftOrder(next);
  };
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutHeader title={t('timeTool.title')} />
        <ToolLayoutContent>
          <Tabs
            value={mode}
            onValueChange={(value) => {
              if (value === 'convert' || value === 'dateCalculator') setMode(value);
            }}
            className="h-full min-h-0 gap-3"
          >
            <TabsList className="w-full">
              <TabsTrigger value="convert">{t('timeTool.modes.convert')}</TabsTrigger>
              <TabsTrigger value="dateCalculator">{t('timeTool.modes.dateCalculator')}</TabsTrigger>
            </TabsList>
            <TabsContent value="convert" keepMounted className="min-h-0 overflow-hidden">
              <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_auto_minmax(0,1fr)]">
                <Label className="flex flex-col items-stretch gap-2 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
                  <span>{t('timeTool.input')}</span>
                  <div className="flex h-[46px] min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 focus-within:border-muted-foreground">
                    <Clock size={18} weight="duotone" />
                    <Input
                      ref={inputRef}
                      className="min-w-0 flex-1 select-text border-0 bg-transparent px-0 py-0 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
                      value={input}
                      onKeyDown={(event) => undoRedoKey(event, undo, redo)}
                      onChange={(event) => setInput(event.target.value)}
                      placeholder={t('timeTool.placeholder')}
                    />
                  </div>
                </Label>
                <div className="flex flex-col gap-2 pt-3.5">
                  <span className="font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
                    {t('timeTool.quickFill')}
                  </span>
                  <div
                    className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-1.5"
                    role="toolbar"
                    aria-label={t('timeTool.quickFill')}
                  >
                    {timePresets.map((preset) => (
                      <Button
                        key={preset}
                        variant="outline"
                        size="sm"
                        className="min-w-0"
                        onClick={() => applyTimePreset(preset)}
                      >
                        {t(`timeTool.presets.${preset}`)}
                      </Button>
                    ))}
                    <DateTimePickerPopover
                      value={parsed}
                      locale={i18n.language === 'zh-CN' ? zhCN : enUS}
                      triggerLabel={t('timeTool.pickDateTime')}
                      timeLabel={t('timeTool.dateTimePicker.time')}
                      cancelLabel={t('timeTool.dateTimePicker.cancel')}
                      applyLabel={t('timeTool.dateTimePicker.apply')}
                      getParts={(date) => {
                        const part = zonedParts(date, timeZone);
                        return {
                          date: new Date(
                            Number(part.year),
                            Number(part.month) - 1,
                            Number(part.day),
                          ),
                          time: `${part.hour}:${part.minute}:${part.second}`,
                        };
                      }}
                      parse={(date, time) =>
                        parseTimeInput(
                          `${format(date, 'yyyy-MM-dd')}T${time}`,
                          new Date(),
                          timeZone,
                        )
                      }
                      onChange={(date) => {
                        const timestamp = Math.floor(date.getTime() / 1000).toString();
                        setInput(timestamp, { isolate: true });
                        record('time', t('timeTool.pickDateTime'), timestamp, timestamp);
                      }}
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <TimezoneCombobox
                    value={timeZone}
                    onChange={setTimeZone}
                    zones={zones}
                    label={t('timeTool.timezone')}
                    placeholder={t('timeTool.timezonePlaceholder')}
                    emptyLabel={t('timeTool.timezoneNoResults')}
                  />
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    className="flex-none rounded-lg"
                    aria-label={t('timeTool.useSystemTimezone')}
                    onClick={() => setTimeZone(getSystemTimeZone())}
                  >
                    <GpsFix size={17} weight="duotone" />
                  </Button>
                </div>
                <div className="mt-3.5 flex min-h-[39px] items-center justify-between gap-3 border-b border-border px-1 py-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    {editing ? t('timeTool.editHint') : ''}
                  </span>
                  <Button
                    variant={editing ? 'default' : 'ghost'}
                    onClick={editing ? finishEditing : startEditing}
                    className="h-[26px] px-2.5 text-[11px]"
                  >
                    {t(editing ? 'timeTool.done' : 'timeTool.edit')}
                  </Button>
                </div>
                <div className="min-h-0 overflow-x-hidden overflow-y-auto">
                  {/* 预览和编辑共用上下文，保持拖拽回调注册稳定。 */}
                  {editing || parsed ? (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={({ active, collisions }) => {
                        // over/newIndex 经由副作用更新，快速松手时可能落后于本轮碰撞结果。
                        const targetId = collisions?.[0]?.id;
                        if (targetId == null) return;
                        const from = draftOrderRef.current.indexOf(
                          String(active.id) as TimeResultId,
                        );
                        const to = draftOrderRef.current.indexOf(String(targetId) as TimeResultId);
                        moveResult(from, to);
                      }}
                    >
                      <SortableContext
                        items={displayedResults}
                        strategy={verticalListSortingStrategy}
                      >
                        <div>
                          {displayedResults.map((id) => (
                            <TimeResultRow
                              key={id}
                              id={id}
                              label={t(`timeTool.${id}`)}
                              value={values[id]}
                              hidden={editing && draftHidden.has(id)}
                              editing={editing}
                              onCopy={() => copyResult(id)}
                              onToggle={() => toggleResult(id)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  ) : (
                    <div className="flex min-h-[140px] flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                      <Clock size={24} weight="duotone" />
                      <strong className="text-sm font-semibold">{t('timeTool.emptyTitle')}</strong>
                      <span className="text-[11px]">{t('timeTool.emptyHint')}</span>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
            <TabsContent
              value="dateCalculator"
              keepMounted
              className="min-h-0 min-w-0 overflow-y-auto [padding-inline-end:var(--overlay-scrollbar-hit-size)]"
            >
              <DateCalculator
                record={record}
                pending={pending}
                clearPending={clearPending}
                onActivate={() => setMode('dateCalculator')}
              />
            </TabsContent>
          </Tabs>
        </ToolLayoutContent>
      </ToolLayout>
    </Reveal>
  );
}
