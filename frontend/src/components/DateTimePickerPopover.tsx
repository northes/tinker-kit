import { useId, useState } from 'react';
import type { Locale } from 'date-fns';
import { Calendar } from './ui/calendar';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { CalendarBlank } from '@phosphor-icons/react';
import { formatDateTimeDisplay } from '../utils/dateCalculator';

type DateTimePickerParts = {
  date: Date;
  time: string;
};

export default function DateTimePickerPopover({
  value,
  locale,
  triggerLabel,
  placeholder = triggerLabel,
  timeLabel,
  cancelLabel,
  applyLabel,
  showValue = false,
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
  getParts: (value: Date) => DateTimePickerParts;
  parse: (date: Date, time: string) => Date | null;
  onChange: (value: Date) => void;
}) {
  const timeInputId = useId();
  const [open, setOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>();
  const [selectedTime, setSelectedTime] = useState('00:00:00');
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const parts = getParts(value ?? new Date());
      setSelectedDate(parts.date);
      setSelectedTime(parts.time);
    }
    setOpen(nextOpen);
  };
  const applyDateTime = () => {
    if (!selectedDate || !selectedTime) return;
    const nextValue = parse(selectedDate, selectedTime);
    if (!nextValue) return;
    onChange(nextValue);
    setOpen(false);
  };
  const triggerClassName = showValue
    ? 'h-[46px] w-full justify-start gap-2.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-normal dark:bg-card'
    : 'min-w-0';
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant={showValue ? 'ghost' : 'outline'}
            size={showValue ? 'default' : 'sm'}
            className={triggerClassName}
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
          onSelect={setSelectedDate}
          captionLayout="dropdown"
          locale={locale}
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
