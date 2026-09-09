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
export type DateDifferenceDirection = 'forward' | 'backward' | 'same';

export type DateDifference = {
  direction: DateDifferenceDirection;
  duration: DateDuration;
};

const dateTimeLocalPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

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

export function parseDateTimeLocal(value: string) {
  const match = value.trim().match(dateTimeLocalPattern);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;

  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (!isValidDate(date)) return null;
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second
    ? date
    : null;
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
  const direction = startTime === endTime ? 'same' : endTime > startTime ? 'forward' : 'backward';
  const earlier = direction === 'backward' ? end : start;
  const later = direction === 'backward' ? start : end;
  return {
    direction,
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
