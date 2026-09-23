export type TextGeneratorMode = 'character' | 'line';
export type QuoteMode = 'none' | 'single' | 'double';
type RandomFill = (array: Uint32Array) => Uint32Array;

export const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const SYMBOLS = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

export function parseSeparator(value: string) {
  return value.replace(/\\([nrt\\])/g, (_, code: string) =>
    code === 'n' ? '\n' : code === 'r' ? '\r' : code === 't' ? '\t' : '\\',
  );
}

export function quoteValue(value: string, mode: QuoteMode) {
  if (mode === 'none') return value;
  const quote = mode === 'single' ? "'" : '"';
  return `${quote}${value.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`)}${quote}`;
}

export function linePool(content: string) {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

export function secureRandomIndex(
  size: number,
  random: RandomFill = (array) => crypto.getRandomValues(array),
) {
  if (!Number.isInteger(size) || size < 1) throw new Error('Random pool is empty');
  const limit = Math.floor(0x1_0000_0000 / size) * size;
  const value = new Uint32Array(1);
  do random(value);
  while (value[0] >= limit);
  return value[0] % size;
}

export function generateFromPool(pool: string[], length: number, random?: RandomFill) {
  if (pool.length === 0) throw new Error('Random pool is empty');
  return Array.from({ length }, () => pool[secureRandomIndex(pool.length, random)]).join('');
}

export function generateItems(options: {
  kind: 'uuid' | TextGeneratorMode;
  pool?: string[];
  length: number;
  quantity: number;
  uuid?: () => string;
  random?: RandomFill;
}) {
  const length = Math.min(512, Math.max(1, Math.trunc(options.length)));
  const quantity = Math.min(1000, Math.max(1, Math.trunc(options.quantity)));
  const makeUUID = options.uuid ?? crypto.randomUUID.bind(crypto);
  return Array.from({ length: quantity }, () =>
    options.kind === 'uuid'
      ? makeUUID()
      : generateFromPool(options.pool ?? [], length, options.random),
  );
}

export function generateText(options: {
  kind: 'uuid' | TextGeneratorMode;
  pool?: string[];
  length: number;
  quantity: number;
  separator: string;
  quote: QuoteMode;
  uuid?: () => string;
  random?: RandomFill;
}) {
  return generateItems(options)
    .map((item) => quoteValue(item, options.quote))
    .join(parseSeparator(options.separator));
}
