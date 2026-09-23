import { add, differenceInCalendarDays, sub } from 'date-fns';

export const dateDurationUnits = [
  'years',
  'months',
  'days',
  'hours',
  'minutes',
  'seconds',
] as const;

export type DateDurationUnit = (typeof dateDurationUnits)[number];
export type DateDuration = Record<DateDurationUnit, number>;
export type DateOperation = 'add' | 'subtract';

export type DateDifference = {
  duration: DateDuration;
};

function isValidDate(date: Date) {
  return !Number.isNaN(date.getTime());
}

function isSupportedDate(date: Date) {
  return isValidDate(date) && date.getFullYear() >= 1 && date.getFullYear() <= 9999;
}

function pad(value: number, length: number) {
  return String(value).padStart(length, '0');
}

function isValidDurationValue(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function addCalendarUnit(date: Date, unit: 'years' | 'months', value: number) {
  return unit === 'years' ? add(date, { years: value }) : add(date, { months: value });
}

function takeCalendarUnits(start: Date, end: Date, unit: 'years' | 'months', initialValue: number) {
  const endTime = end.getTime();
  let value = Math.max(0, initialValue);
  while (value > 0) {
    const candidate = addCalendarUnit(start, unit, value);
    if (isValidDate(candidate) && candidate.getTime() <= endTime) return { value, date: candidate };
    value--;
  }
  return { value: 0, date: start };
}

function calendarDuration(start: Date, end: Date): DateDuration {
  let cursor = new Date(start);
  const years = takeCalendarUnits(cursor, end, 'years', end.getFullYear() - cursor.getFullYear());
  cursor = years.date;
  const months = takeCalendarUnits(
    cursor,
    end,
    'months',
    (end.getFullYear() - cursor.getFullYear()) * 12 + end.getMonth() - cursor.getMonth(),
  );
  cursor = months.date;
  let daysValue = Math.max(0, differenceInCalendarDays(end, cursor));
  while (daysValue > 0) {
    const candidate = add(cursor, { days: daysValue });
    if (isValidDate(candidate) && candidate.getTime() <= end.getTime()) {
      cursor = candidate;
      break;
    }
    daysValue--;
  }
  const remainingMilliseconds = Math.max(0, end.getTime() - cursor.getTime());
  const hours = Math.floor(remainingMilliseconds / 3600000);
  const minutes = Math.floor((remainingMilliseconds - hours * 3600000) / 60000);
  const seconds = Math.floor((remainingMilliseconds - hours * 3600000 - minutes * 60000) / 1000);
  return {
    years: years.value,
    months: months.value,
    days: daysValue,
    hours,
    minutes,
    seconds,
  };
}

export function formatDateTimeLocal(date: Date) {
  if (!isSupportedDate(date)) return '';
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`;
}

export function formatDateTimeDisplay(date: Date) {
  return formatDateTimeLocal(date).replace('T', ' ');
}

export function calculateDateDifference(start: Date, end: Date): DateDifference | null {
  if (!isValidDate(start) || !isValidDate(end)) return null;

  const startTime = start.getTime();
  const endTime = end.getTime();
  const earlier = endTime < startTime ? end : start;
  const later = endTime < startTime ? start : end;
  return {
    duration: calendarDuration(earlier, later),
  };
}

export function calculateDateTime(base: Date, duration: DateDuration, operation: DateOperation) {
  if (!isValidDate(base) || dateDurationUnits.some((unit) => !isValidDurationValue(duration[unit])))
    return null;
  try {
    const result = operation === 'subtract' ? sub(base, duration) : add(base, duration);
    return isSupportedDate(result) ? result : null;
  } catch {
    return null;
  }
}
