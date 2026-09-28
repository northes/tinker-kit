import { useId, useState } from 'react';
import type { Locale } from 'date-fns';
import { Calendar } from './ui/calendar';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { CalendarBlank } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { formatDateTimeDisplay } from '../utils/dateCalculator';

type DateTimePickerParts = {
  date: Date;
  time: string;
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function formatTimeValue(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isSameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function clampToRange(value: Date, min?: Date, max?: Date) {
  if (min && value.getTime() < min.getTime()) return min;
  if (max && value.getTime() > max.getTime()) return max;
  return value;
}

export default function DateTimePickerPopover({
  value,
  locale,
  triggerLabel,
  placeholder = triggerLabel,
  timeLabel,
  cancelLabel,
  applyLabel,
  showValue = false,
  triggerClassName,
  minDate,
  maxDate,
  getParts,
  parse,
  onChange,
}: {
  value: Date | null;
  locale: Locale;
  triggerLabel: string;
  placeholder?: string;
  timeLabel: string;
  cancelLabel: string;
  applyLabel: string;
  showValue?: boolean;
  triggerClassName?: string;
  minDate?: Date;
  maxDate?: Date;
  getParts: (value: Date) => DateTimePickerParts;
  parse: (date: Date, time: string) => Date | null;
  onChange: (value: Date) => void;
}) {
  const timeInputId = useId();
  const [open, setOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>();
  const [selectedTime, setSelectedTime] = useState('00:00:00');
  const minTime =
    minDate && selectedDate && isSameDay(selectedDate, minDate)
      ? formatTimeValue(minDate)
      : undefined;
  const maxTime =
    maxDate && selectedDate && isSameDay(selectedDate, maxDate)
      ? formatTimeValue(maxDate)
      : undefined;
  const disabledDays =
    minDate && maxDate
      ? { before: minDate, after: maxDate }
      : minDate
        ? { before: minDate }
        : maxDate
          ? { after: maxDate }
          : undefined;
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const parts = getParts(clampToRange(value ?? new Date(), minDate, maxDate));
      setSelectedDate(parts.date);
      setSelectedTime(parts.time);
    }
    setOpen(nextOpen);
  };
  const handleSelectDate = (date?: Date) => {
    if (!date) return;
    setSelectedDate(date);
    // 选到边界日期时把时间收敛到可用范围内，避免视觉上灰掉的时间仍被应用。
    if (minDate && isSameDay(date, minDate) && selectedTime < formatTimeValue(minDate)) {
      setSelectedTime(formatTimeValue(minDate));
    }
    if (maxDate && isSameDay(date, maxDate) && selectedTime > formatTimeValue(maxDate)) {
      setSelectedTime(formatTimeValue(maxDate));
    }
  };
  const applyDateTime = () => {
    if (!selectedDate || !selectedTime) return;
    const nextValue = parse(selectedDate, selectedTime);
    if (!nextValue) return;
    onChange(clampToRange(nextValue, minDate, maxDate));
    setOpen(false);
  };
  const resolvedTriggerClassName = cn(
    showValue
      ? 'h-[46px] w-full justify-start gap-2.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-normal dark:bg-card'
      : 'min-w-0',
    triggerClassName,
  );
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant={showValue ? 'ghost' : 'outline'}
            size={showValue ? 'default' : 'sm'}
            className={resolvedTriggerClassName}
            aria-label={triggerLabel}
            title={triggerLabel}
          />
        }
      >
        <CalendarBlank data-icon="inline-start" size={showValue ? 17 : 14} weight="duotone" />
        {showValue ? (
          <span className="min-w-0 truncate">
            {value ? formatDateTimeDisplay(value) : placeholder}
          </span>
        ) : (
          triggerLabel
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-36px)] gap-0 overflow-hidden p-0"
      >
        <Calendar
          mode="single"
          selected={selectedDate}
          defaultMonth={selectedDate}
          onSelect={handleSelectDate}
          captionLayout="dropdown"
          locale={locale}
          disabled={disabledDays}
        />
        <div className="border-t border-border p-3">
          <Label
            htmlFor={timeInputId}
            className="mb-2 text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground"
          >
            {timeLabel}
          </Label>
          <Input
            id={timeInputId}
            type="time"
            step="1"
            min={minTime}
            max={maxTime}
            value={selectedTime}
            onChange={(event) => setSelectedTime(event.target.value)}
            className="appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
          />
        </div>
        <div className="flex justify-end gap-1.5 border-t border-border p-2.5">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {cancelLabel}
          </Button>
          <Button size="sm" disabled={!selectedDate || !selectedTime} onClick={applyDateTime}>
            {applyLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
