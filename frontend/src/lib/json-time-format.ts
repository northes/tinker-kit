import { format, isValid, parseISO } from 'date-fns';

export const JSON_TIME_FORMATS = ['none', 'datetime', 'milliseconds', 'date', 'iso'] as const;
export type JsonTimeFormat = (typeof JSON_TIME_FORMATS)[number];

const patterns = {
  datetime: 'yyyy-MM-dd HH:mm:ss',
  milliseconds: 'yyyy-MM-dd HH:mm:ss.SSS',
  date: 'yyyy-MM-dd',
} as const;

function isTimeKey(key: string): boolean {
  const normalized = key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
  return (
    /^(?:ts|time|timestamp|date|datetime|ctime|mtime|atime)$/.test(normalized) ||
    /_(?:ts|time|timestamp|date|datetime|at)$/.test(normalized)
  );
}

function parseTimeValue(value: string | number): Date | null {
  let source = String(value).trim();
  if (/^[+-]?\d+(?:\.\d{1,9})?$/.test(source)) {
    const [integer, fraction] = source.replace(/^[+-]/, '').split('.');
    // 与时间工具一致：最多 10 位为秒，11～13 位为毫秒；更长的值不猜测单位。
    if (integer.length > 13 || (fraction !== undefined && integer.length > 10)) return null;
    const date = new Date(Number(source) * (integer.length <= 10 ? 1000 : 1));
    return isValid(date) ? date : null;
  }

  // 只接受完整日期，避免将普通字符串、只有时分或不完整日期猜成时间。
  source = source.replace(
    /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(.*)$/,
    (_match, year: string, _separator: string, month: string, day: string, rest: string) =>
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${rest}`,
  );
  if (
    !/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/.test(
      source,
    )
  )
    return null;
  const date = parseISO(source.replace('t', 'T').replace(/z$/, 'Z'));
  return isValid(date) ? date : null;
}

// 仅返回展示文本；null 表示保留原值，不遍历或改写输入数据。
export function formatJsonTimeValue(
  key: string | undefined,
  value: unknown,
  target: JsonTimeFormat,
): string | null {
  if (
    target === 'none' ||
    key === undefined ||
    !isTimeKey(key) ||
    (typeof value !== 'string' && typeof value !== 'number')
  )
    return null;
  const date = parseTimeValue(value);
  if (!date) return null;
  return target === 'iso' ? date.toISOString() : format(date, patterns[target]);
}
