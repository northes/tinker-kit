import { timeZoneNames } from './timezoneNames';

const months: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const regionNames: Record<string, string> = {
  Africa: '非洲',
  America: '美洲',
  Antarctica: '南极洲',
  Arctic: '北极',
  Asia: '亚洲',
  Atlantic: '大西洋',
  Australia: '澳大利亚',
  Etc: '其他',
  Europe: '欧洲',
  Indian: '印度洋',
  Pacific: '太平洋',
};
const cityNames: Record<string, string> = {
  Shanghai: '上海',
  Tokyo: '东京',
  Singapore: '新加坡',
  Kolkata: '加尔各答',
  Kathmandu: '加德满都',
  Dhaka: '达卡',
  Karachi: '卡拉奇',
  Tashkent: '塔什干',
  Almaty: '阿拉木图',
  Bishkek: '比什凯克',
  Ulaanbaatar: '乌兰巴托',
  Vladivostok: '符拉迪沃斯托克',
  Yakutsk: '雅库茨克',
  Irkutsk: '伊尔库茨克',
  Novosibirsk: '新西伯利亚',
  Yekaterinburg: '叶卡捷琳堡',
  London: '伦敦',
  Paris: '巴黎',
  Berlin: '柏林',
  Madrid: '马德里',
  Rome: '罗马',
  Amsterdam: '阿姆斯特丹',
  Brussels: '布鲁塞尔',
  Vienna: '维也纳',
  Prague: '布拉格',
  Warsaw: '华沙',
  Budapest: '布达佩斯',
  Athens: '雅典',
  Helsinki: '赫尔辛基',
  Stockholm: '斯德哥尔摩',
  Oslo: '奥斯陆',
  Copenhagen: '哥本哈根',
  Lisbon: '里斯本',
  Dublin: '都柏林',
  Moscow: '莫斯科',
  Dubai: '迪拜',
  Riyadh: '利雅得',
  Jerusalem: '耶路撒冷',
  Tehran: '德黑兰',
  Baghdad: '巴格达',
  Beirut: '贝鲁特',
  Amman: '安曼',
  Hong_Kong: '香港',
  Taipei: '台北',
  Seoul: '首尔',
  Bangkok: '曼谷',
  Jakarta: '雅加达',
  Manila: '马尼拉',
  Kuala_Lumpur: '吉隆坡',
  Yangon: '仰光',
  Ho_Chi_Minh: '胡志明市',
  Phnom_Penh: '金边',
  Sydney: '悉尼',
  Melbourne: '墨尔本',
  Perth: '珀斯',
  Brisbane: '布里斯班',
  Adelaide: '阿德莱德',
  Hobart: '霍巴特',
  Darwin: '达尔文',
  Auckland: '奥克兰',
  Wellington: '惠灵顿',
  Chatham: '查塔姆群岛',
  Fiji: '斐济',
  Guam: '关岛',
  Honolulu: '檀香山',
  Port_Moresby: '莫尔兹比港',
  Noumea: '努美阿',
  Apia: '阿皮亚',
  Tahiti: '塔希提',
  New_York: '纽约',
  Chicago: '芝加哥',
  Denver: '丹佛',
  Los_Angeles: '洛杉矶',
  Phoenix: '菲尼克斯',
  Anchorage: '安克雷奇',
  Detroit: '底特律',
  Indiana: '印第安纳',
  Toronto: '多伦多',
  Vancouver: '温哥华',
  Winnipeg: '温尼伯',
  Edmonton: '埃德蒙顿',
  Halifax: '哈利法克斯',
  St_Johns: '圣约翰斯',
  Mexico_City: '墨西哥城',
  Monterrey: '蒙特雷',
  Guatemala: '危地马拉城',
  Havana: '哈瓦那',
  Nassau: '拿骚',
  Barbados: '巴巴多斯',
  Puerto_Rico: '波多黎各',
  Marigot: '马里戈特',
  Santo_Domingo: '圣多明各',
  Port_of_Spain: '西班牙港',
  St_Thomas: '圣托马斯',
  Sao_Paulo: '圣保罗',
  Buenos_Aires: '布宜诺斯艾利斯',
  Cordoba: '科尔多瓦',
  La_Rioja: '拉里奥哈',
  Mendoza: '门多萨',
  Montevideo: '蒙得维的亚',
  Santiago: '圣地亚哥',
  Lima: '利马',
  Bogota: '波哥大',
  Caracas: '加拉加斯',
  Paramaribo: '帕拉马里博',
  Cayenne: '卡宴',
  Johannesburg: '约翰内斯堡',
  Cairo: '开罗',
  Lagos: '拉各斯',
  Nairobi: '内罗毕',
  Casablanca: '卡萨布兰卡',
  Tunis: '突尼斯',
  Algiers: '阿尔及尔',
  Tripoli: '的黎波里',
  Khartoum: '喀土穆',
  Addis_Ababa: '亚的斯亚贝巴',
  Reykjavik: '雷克雅未克',
  Rothera: '罗瑟拉',
  Troll: '特罗尔',
  Vostok: '东方站',
  Casey: '凯西站',
  Davis: '戴维斯站',
  Macquarie: '麦夸里岛',
  Kerguelen: '凯尔盖朗群岛',
  Reunion: '留尼汪',
  St_Helena: '圣赫勒拿',
  UTC: '协调世界时',
};
export function getSystemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
export type TimePreset =
  | 'now'
  | 'yesterday'
  | 'tomorrow'
  | 'sevenDaysAgo'
  | 'weekMonday'
  | 'weekTuesday'
  | 'weekWednesday'
  | 'weekThursday'
  | 'weekFriday'
  | 'weekSaturday'
  | 'weekSunday'
  | 'monthStart'
  | 'monthEnd'
  | 'yearStart'
  | 'yearEnd'
  | 'dayStart'
  | 'dayNoon'
  | 'dayEnd';
export type TimeWeekStart = 'monday' | 'sunday';
const weekdayIndex: Partial<Record<TimePreset, number>> = {
  weekSunday: 0,
  weekMonday: 1,
  weekTuesday: 2,
  weekWednesday: 3,
  weekThursday: 4,
  weekFriday: 5,
  weekSaturday: 6,
};
function zonedDateTimeParts(date: Date, timeZone: string) {
  try {
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
      get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute'),
      second: get('second'),
    };
  } catch {
    return null;
  }
}
export function resolveTimePreset(
  preset: TimePreset,
  now: Date,
  timeZone: string,
  value: Date | null = null,
  weekStart: TimeWeekStart = 'monday',
) {
  if (preset === 'now') return now;
  if (preset === 'yesterday') return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (preset === 'tomorrow') return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (preset === 'sevenDaysAgo') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const current = zonedDateTimeParts(value ?? now, timeZone);
  const today = zonedDateTimeParts(now, timeZone);
  if (!current || !today) return null;
  const { hour, minute, second } = current;
  if (preset === 'dayStart')
    return makeDate(current.year, current.month, current.day, 0, 0, 0, 0, undefined, timeZone);
  if (preset === 'dayNoon')
    return makeDate(current.year, current.month, current.day, 12, 0, 0, 0, undefined, timeZone);
  if (preset === 'dayEnd')
    return makeDate(current.year, current.month, current.day, 23, 59, 59, 0, undefined, timeZone);
  const { year, month, day } = today;
  if (preset === 'monthStart')
    return makeDate(year, month, 1, hour, minute, second, 0, undefined, timeZone);
  if (preset === 'monthEnd') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return makeDate(year, month, lastDay, hour, minute, second, 0, undefined, timeZone);
  }
  if (preset === 'yearStart')
    return makeDate(year, 1, 1, hour, minute, second, 0, undefined, timeZone);
  if (preset === 'yearEnd')
    return makeDate(year, 12, 31, hour, minute, second, 0, undefined, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekStartDay = weekStart === 'sunday' ? 0 : 1;
  const targetWeekday = weekdayIndex[preset] ?? weekStartDay;
  const daysFromWeekStart = (date.getUTCDay() - weekStartDay + 7) % 7;
  const daysToTarget = (targetWeekday - weekStartDay + 7) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromWeekStart + daysToTarget);
  return makeDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    hour,
    minute,
    second,
    0,
    undefined,
    timeZone,
  );
}
function timeZoneOffsetLabel(timeZone: string, date = new Date()) {
  try {
    const part =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(date)
        .find((item) => item.type === 'timeZoneName')?.value || 'GMT';
    const match = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 'UTC+00:00';
    return `UTC${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}`;
  } catch {
    return 'UTC+00:00';
  }
}
export function getTimeZoneOptions(date = new Date()) {
  const supported =
    (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    ) || [];
  const ids = Array.from(new Set(['UTC', ...supported, getSystemTimeZone()]));
  return ids
    .sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)))
    .map((id) => {
      const region = regionNames[id.split('/')[0]] || '其他地区',
        city = timeZoneNames[id] || cityNames[id.split('/').pop() || id] || '未命名时区',
        localized = id === 'UTC' ? '协调世界时' : `${region}/${city}`;
      return { id, label: `${timeZoneOffsetLabel(id, date)} ${id} ${localized}` };
    });
}
function validParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
) {
  if (
    !Number.isInteger(year) ||
    year < 100 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0 ||
    millisecond > 999
  )
    return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}
function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  offsetMinutes: number,
) {
  if (
    !validParts(year, month, day, hour, minute, second, millisecond) ||
    Math.abs(offsetMinutes) > 14 * 60
  )
    return null;
  const date = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60000,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
function zoneOffset(zone: string | undefined) {
  if (!zone) return null;
  if (/^(?:z|utc|gmt)$/i.test(zone)) return 0;
  const match = zone.match(/^(?:gmt)?([+-])(\d{2}):?(\d{2})$/i);
  if (!match) return undefined;
  const hour = Number(match[2]),
    minute = Number(match[3]);
  if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return undefined;
  return (match[1] === '-' ? -1 : 1) * (hour * 60 + minute);
}
function ianaDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const read = (date: Date) => {
      const parts = formatter.formatToParts(date),
        get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
      };
    };
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
      probe = new Date(Math.floor(wanted / 1000) * 1000);
    let parts = read(probe),
      offset =
        Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
        probe.getTime();
    const candidate = new Date(wanted - offset);
    parts = read(candidate);
    return parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === second
      ? candidate
      : null;
  } catch {
    return null;
  }
}
function makeDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  zone?: string,
  timeZone = getSystemTimeZone(),
) {
  const offset = zoneOffset(zone);
  return offset === undefined
    ? null
    : offset === null
      ? ianaDate(year, month, day, hour, minute, second, millisecond, timeZone)
      : zonedDate(year, month, day, hour, minute, second, millisecond, offset);
}
function fractionMilliseconds(value: string | undefined) {
  return value ? Number((value + '000').slice(0, 3)) : 0;
}

export function parseTimeInput(rawInput: string, now = new Date(), timeZone = getSystemTimeZone()) {
  const raw = rawInput.trim();
  if (!raw) return null;
  let match: RegExpMatchArray | null;
  if ((match = raw.match(/^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/)))
    return makeDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      0,
      undefined,
      timeZone,
    );
  if ((match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/)))
    return makeDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
      0,
      undefined,
      timeZone,
    );
  if ((match = raw.match(/^([+-]?\d+)(?:\.(\d{1,9}))?$/))) {
    const digits = match[1].replace(/^[+-]/, '').length;
    if (match[2]) {
      if (digits > 10) return null;
      const date = new Date(Number(raw) * 1000);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (digits <= 10) {
      const date = new Date(Number(match[1]) * 1000);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (digits <= 13) {
      const date = new Date(Number(match[1]));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }
  if (
    (match = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:\s?(Z|[+-]\d{2}:?\d{2}|UTC|GMT(?:[+-]\d{4})?))?)?$/i,
    ))
  )
    return makeDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
      fractionMilliseconds(match[7]),
      match[8],
      timeZone,
    );
  if ((match = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)))
    return makeDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
      0,
      undefined,
      timeZone,
    );
  if (
    (match = raw.match(
      /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})时(?:(\d{1,2})分?)?(?:(\d{1,2})秒?)?|\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
    ))
  )
    return makeDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || match[7] || 0),
      Number(match[5] || match[8] || 0),
      Number(match[6] || match[9] || 0),
      0,
      undefined,
      timeZone,
    );
  if ((match = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)))
    return makeDate(
      now.getFullYear(),
      Number(match[1]),
      Number(match[2]),
      Number(match[3] || 0),
      Number(match[4] || 0),
      Number(match[5] || 0),
      0,
      undefined,
      timeZone,
    );
  if ((match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)))
    return makeDate(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate(),
      Number(match[1]),
      Number(match[2]),
      Number(match[3] || 0),
      0,
      undefined,
      timeZone,
    );
  if (
    (match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))
  ) {
    if (Number(match[1]) <= 12 && Number(match[2]) <= 12) return null;
    return makeDate(
      Number(match[3]),
      Number(match[1]),
      Number(match[2]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
      0,
      undefined,
      timeZone,
    );
  }
  if (
    (match = raw.match(
      /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|[+-]\d{4})?)?$/i,
    ))
  ) {
    const month = months[match[2].toLowerCase()];
    return month
      ? makeDate(
          Number(match[3]),
          month,
          Number(match[1]),
          Number(match[4] || 0),
          Number(match[5] || 0),
          Number(match[6] || 0),
          0,
          match[7],
          timeZone,
        )
      : null;
  }
  if (
    (match = raw.match(
      /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|[+-]\d{4})?)?$/i,
    ))
  ) {
    const month = months[match[1].toLowerCase()];
    return month
      ? makeDate(
          Number(match[3]),
          month,
          Number(match[2]),
          Number(match[4] || 0),
          Number(match[5] || 0),
          Number(match[6] || 0),
          0,
          match[7],
          timeZone,
        )
      : null;
  }
  return null;
}
export function formatTimeInZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}
