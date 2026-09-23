/**
 * 尽力把无效 JSON 修复为严格 JSON。
 *
 * 分两层处理：
 * 1. 先做一层字符串感知的语法归一化，补齐 jsonrepair 不认识的写法：
 *    `=` 当冒号、`;` 当逗号、数字前导 `+`、括号混用、全大写常量、
 *    十六进制与前导零数字。
 * 2. 再交给 jsonrepair 处理结构类错误：缺失引号、尾逗号、缺逗号、
 *    未闭合的字符串与括号、单引号、注释、undefined 等。
 *
 * 修复结果会再次严格解析校验，无法得到有效 JSON 时抛出 JsonRepairError。
 */

import { jsonrepair } from 'jsonrepair';

export type JsonRepairFailureCode = 'empty' | 'unrepairable';

export class JsonRepairError extends Error {
  readonly code: JsonRepairFailureCode;

  constructor(code: JsonRepairFailureCode) {
    super(code);
    this.name = 'JsonRepairError';
    this.code = code;
  }
}

export type JsonRepairResult = {
  /** 修复后的严格 JSON 文本，使用两个空格缩进。 */
  text: string;
  /** 输入本身是否无效，即是否实际执行了修复。 */
  changed: boolean;
};

const WORD_CONSTANTS: Record<string, string> = {
  True: 'true',
  TRUE: 'true',
  False: 'false',
  FALSE: 'false',
  None: 'null',
  NONE: 'null',
  NULL: 'null',
  undefined: 'null',
  UNDEFINED: 'null',
};

const NUMBER_PATTERN = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const WORD_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*/;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isNumberBoundary(source: string, index: number): boolean {
  const char = source[index];
  if (char === undefined) return true;
  if (/[\s{}[\],:]/.test(char)) return true;
  return char === '/' && (source[index + 1] === '/' || source[index + 1] === '*');
}

function normalizeNumber(raw: string): string {
  const hex = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(raw);
  if (hex) {
    const value = Number.parseInt(hex[2], 16);
    return hex[1] === '-' ? String(-value) : String(value);
  }
  const unsigned = raw.startsWith('+') ? raw.slice(1) : raw;
  return unsigned.replace(/^0+(?=\d)/, '');
}

/** 复制一段字符串字面量；遇到裸换行视为未闭合，按原样返回，避免跨行误配对引号。 */
function copyStringLiteral(source: string, start: number): { text: string; next: number } {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      index += 1;
      break;
    }
    if (char === '\n' || char === '\r') break;
    index += 1;
  }
  return { text: source.slice(start, index), next: index };
}

/**
 * 把 jsonrepair 不认识的写法归一化为等价的常见 JSON 写法。
 * 字符串与注释原样保留，因此无法识别时输出与输入一致。
 */
export function normalizeJsonSyntax(source: string): string {
  let out = '';
  let index = 0;
  const stack: string[] = [];

  while (index < source.length) {
    const char = source[index];

    if (char === '"' || char === "'") {
      const { text, next } = copyStringLiteral(source, index);
      out += text;
      index = next;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2);
      const stop = end < 0 ? source.length : end;
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      out += char;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      const expected = stack.pop();
      out += expected && expected !== char ? expected : char;
      index += 1;
      continue;
    }

    if (char === '=' && source[index - 1] !== '=' && source[index + 1] !== '=') {
      out += ':';
      index += 1;
      continue;
    }
    if (char === ';') {
      out += ',';
      index += 1;
      continue;
    }

    if (char >= '0' && char <= '9') {
      const match = NUMBER_PATTERN.exec(source.slice(index));
      if (match && isNumberBoundary(source, index + match[0].length)) {
        out += normalizeNumber(match[0]);
        index += match[0].length;
        continue;
      }
    }
    if ((char === '+' || char === '-') && isDigit(source[index + 1])) {
      const match = NUMBER_PATTERN.exec(source.slice(index));
      if (match && isNumberBoundary(source, index + match[0].length)) {
        out += normalizeNumber(match[0]);
        index += match[0].length;
        continue;
      }
    }

    const word = WORD_PATTERN.exec(source.slice(index));
    if (word) {
      out += word[0] in WORD_CONSTANTS ? WORD_CONSTANTS[word[0]] : word[0];
      index += word[0].length;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** 尝试修复一段可能无效的 JSON；无法修复时抛出 JsonRepairError。 */
export function repairJson(source: string): JsonRepairResult {
  if (!source.trim()) throw new JsonRepairError('empty');

  try {
    const value = JSON.parse(source);
    return { text: JSON.stringify(value, null, 2), changed: false };
  } catch {
    // 输入不是严格 JSON，继续走修复流程。
  }

  const normalized = normalizeJsonSyntax(source);
  let repaired: string;
  try {
    repaired = jsonrepair(normalized);
  } catch {
    throw new JsonRepairError('unrepairable');
  }

  let value: unknown;
  try {
    value = JSON.parse(repaired);
  } catch {
    throw new JsonRepairError('unrepairable');
  }
  return { text: JSON.stringify(value, null, 2), changed: true };
}
