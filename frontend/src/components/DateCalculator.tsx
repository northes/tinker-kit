import { useEffect, useId, useRef, useState } from 'react';
import { enUS, zhCN } from 'date-fns/locale';
import { CalendarBlank, Copy, Minus, Plus } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import DateTimePickerPopover from './DateTimePickerPopover';
import {
  calculateDateDifference,
  calculateDateTime,
  dateDurationUnits,
  formatDateTimeDisplay,
  formatDateTimeLocal,
  parseDateTimeLocal,
  type DateDuration,
  type DateDurationUnit,
  type DateOperation,
} from '../utils/dateCalculator';
import type { PendingAction, ToolId } from './shared';
import { toast } from './ui/toast';

export const dateCalculatorModes = {
  difference: 'date-difference',
  calculation: 'date-calculation',
} as const;

type DateCalculatorMode = (typeof dateCalculatorModes)[keyof typeof dateCalculatorModes];
type DateCalculatorRecord = (
  tool: ToolId,
  action: string,
  detail: string,
  input: string,
  output?: string,
  meta?: { mode?: string },
) => void;

const initialDurationValues: Record<DateDurationUnit, string> = {
  years: '0',
  months: '0',
  days: '0',
  hours: '0',
  minutes: '0',
  seconds: '0',
};

function parseDurationValues(values: Record<DateDurationUnit, string>): DateDuration | null {
  const duration = {} as DateDuration;
  for (const unit of dateDurationUnits) {
    const value = values[unit].trim() ? Number(values[unit]) : 0;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    duration[unit] = value;
  }
  return duration;
}

function localDateTimePickerParts(value: Date) {
  const formatted = formatDateTimeLocal(value);
  return {
    date: new Date(value),
    time: formatted.slice(11),
  };
}

function parseLocalDateTimePicker(date: Date, time: string) {
  const formatted = formatDateTimeLocal(date);
  return formatted ? parseDateTimeLocal(`${formatted.slice(0, 10)}T${time}`) : null;
}

function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date | null;
  onChange: (value: Date) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-2 font-mono text-[10px] font-medium tracking-[.04em] text-muted-foreground">
      <span>{label}</span>
      <DateTimePickerPopover
        value={value}
        locale={i18n.language === 'zh-CN' ? zhCN : enUS}
        triggerLabel={label}
        timeLabel={t('timeTool.dateTimePicker.time')}
        cancelLabel={t('timeTool.dateTimePicker.cancel')}
        applyLabel={t('timeTool.dateTimePicker.apply')}
        getParts={localDateTimePickerParts}
        parse={parseLocalDateTimePicker}
        onChange={onChange}
        showValue
      />
    </div>
  );
}

function DurationField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Label
      htmlFor={id}
      className="flex min-w-0 flex-col gap-2 font-mono text-[10px] font-medium tracking-[.04em] text-muted-foreground"
    >
      <span>{label}</span>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-[38px] bg-card text-right tabular-nums dark:bg-card"
      />
    </Label>
  );
}

function ResultValue({
  label,
  value,
  formatHint,
  onCopy,
  copyLabel,
}: {
  label: string;
  value: string;
  formatHint?: string;
  onCopy: () => void;
  copyLabel: string;
}) {
  return (
    <div className="flex min-w-0 items-end justify-between gap-3 border-t border-border pt-3">
      <div className="min-w-0">
        <span className="font-mono text-[10px] font-medium tracking-[.04em] text-muted-foreground">
          {label}
        </span>
        <code className="mt-1 block break-words text-sm font-medium text-foreground">{value}</code>
        {formatHint ? (
          <span className="mt-1 block text-[10px] text-muted-foreground">{formatHint}</span>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="flex-none"
        aria-label={copyLabel}
        title={copyLabel}
        onClick={onCopy}
      >
        <Copy size={15} weight="duotone" />
      </Button>
    </div>
  );
}

function ResultMessage({ message, invalid }: { message: string; invalid?: boolean }) {
  return (
    <div
      className={`border-t border-border pt-3 text-[11px] ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}
      role={invalid ? 'alert' : undefined}
    >
      {message}
    </div>
  );
}

type RestoredDateCalculatorState =
  | {
      mode: typeof dateCalculatorModes.difference;
      start: string;
      end: string;
    }
  | {
      mode: typeof dateCalculatorModes.calculation;
      base: string;
      operation: DateOperation;
      duration: Record<DateDurationUnit, string>;
    };

function parseRestoredDateCalculatorState(mode: string | undefined, input: string) {
  if (mode !== dateCalculatorModes.difference && mode !== dateCalculatorModes.calculation)
    return null;
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return null;
    if (mode === dateCalculatorModes.difference) {
      return typeof value.start === 'string' && typeof value.end === 'string'
        ? ({
            mode,
            start: value.start,
            end: value.end,
          } satisfies RestoredDateCalculatorState)
        : null;
    }
    if (typeof value.base !== 'string') return null;
    if (value.operation !== 'add' && value.operation !== 'subtract') return null;
    if (!value.duration || typeof value.duration !== 'object') return null;
    const source = value.duration as Record<string, unknown>;
    const duration = {} as Record<DateDurationUnit, string>;
    for (const unit of dateDurationUnits) {
      const unitValue = source[unit];
      if (
        typeof unitValue !== 'string' &&
        (typeof unitValue !== 'number' || !Number.isSafeInteger(unitValue))
      )
        return null;
      duration[unit] = String(unitValue);
    }
    return {
      mode,
      base: value.base,
      operation: value.operation,
      duration,
    } satisfies RestoredDateCalculatorState;
  } catch {
    return null;
  }
}

export default function DateCalculator({
  record,
  pending,
  clearPending,
  onActivate,
}: {
  record: DateCalculatorRecord;
  pending: PendingAction | null;
  clearPending: () => void;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const [initialDateTime] = useState(() => formatDateTimeLocal(new Date()));
  const [differenceStart, setDifferenceStart] = useState(initialDateTime);
  const [differenceEnd, setDifferenceEnd] = useState(initialDateTime);
  const [baseDate, setBaseDate] = useState(initialDateTime);
  const [operation, setOperation] = useState<DateOperation>('add');
  const [durationValues, setDurationValues] = useState(initialDurationValues);
  const consumed = useRef<PendingAction | null>(null);

  useEffect(() => {
    if (
      !pending ||
      pending.tool !== 'time' ||
      pending.action !== 'restore' ||
      consumed.current === pending
    )
      return;
    const restored = parseRestoredDateCalculatorState(pending.mode, pending.input);
    if (!restored) {
      clearPending();
      return;
    }
    consumed.current = pending;
    clearPending();
    onActivate();
    if (restored.mode === dateCalculatorModes.difference) {
      setDifferenceStart(restored.start);
      setDifferenceEnd(restored.end);
    } else {
      setBaseDate(restored.base);
      setOperation(restored.operation);
      setDurationValues(restored.duration);
    }
  }, [pending]);

  const startDate = parseDateTimeLocal(differenceStart);
  const endDate = parseDateTimeLocal(differenceEnd);
  const difference = startDate && endDate ? calculateDateDifference(startDate, endDate) : null;
  const differenceText = difference
    ? dateDurationUnits
        .map((unit) => `${difference.duration[unit]} ${t(`timeTool.dateCalculator.units.${unit}`)}`)
        .join(' ')
    : '';
  const parsedBaseDate = parseDateTimeLocal(baseDate);
  const duration = parseDurationValues(durationValues);
  const calculatedDate =
    parsedBaseDate && duration ? calculateDateTime(parsedBaseDate, duration, operation) : null;
  const calculatedDateText = calculatedDate ? formatDateTimeDisplay(calculatedDate) : '';
  const copyResult = (value: string, action: string, input: string, mode: DateCalculatorMode) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
    toast.add({ title: t('toast.copied', { value }) });
    record('time', action, value, input, value, { mode });
  };
  const differenceMessage =
    !differenceStart.trim() || !differenceEnd.trim()
      ? t('timeTool.dateCalculator.enterDates')
      : t('timeTool.dateCalculator.invalidDate');
  const calculationMessage = !baseDate.trim()
    ? t('timeTool.dateCalculator.enterBaseDate')
    : !parsedBaseDate
      ? t('timeTool.dateCalculator.invalidDate')
      : !duration
        ? t('timeTool.dateCalculator.invalidDuration')
        : t('timeTool.dateCalculator.resultOutOfRange');
  const differenceInput = JSON.stringify({ start: differenceStart, end: differenceEnd });
  const calculationInput = JSON.stringify({ base: baseDate, operation, duration });
  const directionLabel = difference
    ? t(`timeTool.dateCalculator.direction.${difference.direction}`)
    : '';

  return (
    <div className="min-w-0 pb-4">
      <p className="mb-5 text-[11px] leading-5 text-muted-foreground">
        {t('timeTool.dateCalculator.subtitle')}
      </p>
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-x-7 gap-y-8">
        <section className="flex min-w-0 flex-col gap-4 border-b border-border pb-6">
          <div className="flex items-start gap-2.5">
            <CalendarBlank className="mt-0.5 flex-none" size={18} weight="duotone" />
            <div className="min-w-0">
              <h2 className="m-0 text-sm font-medium text-foreground">
                {t('timeTool.dateCalculator.differenceTitle')}
              </h2>
              <p className="mt-1 mb-0 text-[10px] leading-4 text-muted-foreground">
                {t('timeTool.dateCalculator.differenceHint')}
              </p>
            </div>
          </div>
          <div className="grid min-w-0 gap-3">
            <DateTimeField
              label={t('timeTool.dateCalculator.startDate')}
              value={startDate}
              onChange={(value) => setDifferenceStart(formatDateTimeLocal(value))}
            />
            <DateTimeField
              label={t('timeTool.dateCalculator.endDate')}
              value={endDate}
              onChange={(value) => setDifferenceEnd(formatDateTimeLocal(value))}
            />
          </div>
          {difference ? (
            <>
              <div className="grid grid-cols-3 gap-px border border-border bg-border">
                {dateDurationUnits.map((unit) => (
                  <div
                    key={unit}
                    className="flex min-h-[62px] min-w-0 flex-col justify-between bg-card px-2.5 py-2"
                  >
                    <strong className="text-lg leading-none font-semibold tabular-nums text-foreground">
                      {difference.duration[unit]}
                    </strong>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {t(`timeTool.dateCalculator.units.${unit}`)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="m-0 text-[10px] text-muted-foreground">{directionLabel}</p>
              <ResultValue
                label={t('timeTool.dateCalculator.differenceResult')}
                value={differenceText}
                onCopy={() =>
                  copyResult(
                    differenceText,
                    t('timeTool.dateCalculator.copyDifference'),
                    differenceInput,
                    dateCalculatorModes.difference,
                  )
                }
                copyLabel={t('timeTool.dateCalculator.copyResult')}
              />
            </>
          ) : (
            <ResultMessage
              message={differenceMessage}
              invalid={!!differenceStart.trim() && !!differenceEnd.trim()}
            />
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-4 border-b border-border pb-6">
          <div className="flex items-start gap-2.5">
            <PlusMinusIcon />
            <div className="min-w-0">
              <h2 className="m-0 text-sm font-medium text-foreground">
                {t('timeTool.dateCalculator.adjustmentTitle')}
              </h2>
              <p className="mt-1 mb-0 text-[10px] leading-4 text-muted-foreground">
                {t('timeTool.dateCalculator.adjustmentHint')}
              </p>
            </div>
          </div>
          <DateTimeField
            label={t('timeTool.dateCalculator.baseDate')}
            value={parsedBaseDate}
            onChange={(value) => setBaseDate(formatDateTimeLocal(value))}
          />
          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend className="font-mono text-[10px] font-medium tracking-[.04em] text-muted-foreground">
              {t('timeTool.dateCalculator.operation')}
            </legend>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant={operation === 'add' ? 'default' : 'outline'}
                aria-pressed={operation === 'add'}
                onClick={() => setOperation('add')}
              >
                <Plus data-icon="inline-start" size={14} weight="duotone" />
                {t('timeTool.dateCalculator.add')}
              </Button>
              <Button
                variant={operation === 'subtract' ? 'default' : 'outline'}
                aria-pressed={operation === 'subtract'}
                onClick={() => setOperation('subtract')}
              >
                <Minus data-icon="inline-start" size={14} weight="duotone" />
                {t('timeTool.dateCalculator.subtract')}
              </Button>
            </div>
          </fieldset>
          <div className="grid grid-cols-3 gap-x-2 gap-y-3">
            {dateDurationUnits.map((unit) => (
              <DurationField
                key={unit}
                id={`${idPrefix}-${unit}`}
                label={t(`timeTool.dateCalculator.units.${unit}`)}
                value={durationValues[unit]}
                onChange={(value) =>
                  setDurationValues((current) => ({ ...current, [unit]: value }))
                }
              />
            ))}
          </div>
          {calculatedDate ? (
            <ResultValue
              label={t('timeTool.dateCalculator.calculatedResult')}
              value={calculatedDateText}
              formatHint={t('timeTool.dateCalculator.formatHint')}
              onCopy={() =>
                copyResult(
                  calculatedDateText,
                  t('timeTool.dateCalculator.copyCalculation'),
                  calculationInput,
                  dateCalculatorModes.calculation,
                )
              }
              copyLabel={t('timeTool.dateCalculator.copyResult')}
            />
          ) : (
            <ResultMessage message={calculationMessage} invalid={!!baseDate.trim()} />
          )}
        </section>
      </div>
    </div>
  );
}

function PlusMinusIcon() {
  return (
    <span className="mt-0.5 flex size-[18px] flex-none items-center justify-center">
      <Plus size={11} weight="bold" />
      <Minus size={11} weight="bold" />
    </span>
  );
}
