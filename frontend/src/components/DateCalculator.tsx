import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { CalendarBlank, Copy, Minus, Plus } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  calculateDateDifference,
  calculateDateTime,
  dateDurationUnits,
  formatDateTimeDisplay,
  formatDateTimeLocal,
  type DateDuration,
  type DateDurationUnit,
  type DateOperation,
} from '../utils/dateCalculator';
import { parseTimeInput } from '../utils/time';
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

function DateTimeField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Label
      htmlFor={id}
      className="flex min-w-0 flex-col items-stretch gap-2 font-mono text-[10px] font-medium tracking-[.04em] text-muted-foreground"
    >
      <span>{label}</span>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-[38px] bg-card text-[13px] dark:bg-card"
      />
    </Label>
  );
}

function placeCaretAtEnd(event: FocusEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  requestAnimationFrame(() => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
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
      className="flex min-w-0 flex-col items-stretch gap-2 font-mono text-[10px] font-medium tracking-[.04em] text-muted-foreground"
    >
      <span>{label}</span>
      <Input
        id={id}
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ''))}
        onFocus={placeCaretAtEnd}
        className="h-[38px] bg-card text-right tabular-nums dark:bg-card"
      />
    </Label>
  );
}

function ResultValue({
  label,
  value,
  onCopy,
  copyLabel,
}: {
  label: string;
  value: string;
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

  const startDate = parseTimeInput(differenceStart);
  const endDate = parseTimeInput(differenceEnd);
  const difference = startDate && endDate ? calculateDateDifference(startDate, endDate) : null;
  const differenceUnits = difference
    ? dateDurationUnits.filter((unit) => difference.duration[unit] > 0)
    : [];
  const differenceText = difference
    ? (differenceUnits.length > 0
        ? differenceUnits
        : [dateDurationUnits[dateDurationUnits.length - 1]]
      )
        .map((unit) => `${difference.duration[unit]} ${t(`timeTool.dateCalculator.units.${unit}`)}`)
        .join(' ')
    : '';
  const parsedBaseDate = parseTimeInput(baseDate);
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

  return (
    <div className="min-w-0 px-1.5 pb-4">
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-x-7 gap-y-8">
        <section className="flex min-w-0 flex-col gap-4 border-b border-border pb-6">
          <div className="flex items-start gap-2.5">
            <CalendarBlank className="mt-0.5 flex-none" size={18} weight="duotone" />
            <div className="min-w-0">
              <h2 className="m-0 text-sm font-medium text-foreground">
                {t('timeTool.dateCalculator.differenceTitle')}
              </h2>
            </div>
          </div>
          <div className="grid min-w-0 gap-3">
            <DateTimeField
              id={`${idPrefix}-start`}
              label={t('timeTool.dateCalculator.startDate')}
              value={differenceStart}
              placeholder={t('timeTool.placeholder')}
              onChange={setDifferenceStart}
            />
            <DateTimeField
              id={`${idPrefix}-end`}
              label={t('timeTool.dateCalculator.endDate')}
              value={differenceEnd}
              placeholder={t('timeTool.placeholder')}
              onChange={setDifferenceEnd}
            />
          </div>
          {difference ? (
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
            </div>
          </div>
          <DateTimeField
            id={`${idPrefix}-base`}
            label={t('timeTool.dateCalculator.baseDate')}
            value={baseDate}
            placeholder={t('timeTool.placeholder')}
            onChange={setBaseDate}
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
