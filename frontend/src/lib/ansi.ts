import type { CSSProperties } from 'react';

const ESC = '\u001b';

export type AnsiSpan = {
  text: string;
  className: string;
  style?: CSSProperties;
};

export type AnsiText = {
  text: string;
  spans: AnsiSpan[];
};

type Paint = { index: number } | { rgb: [number, number, number] } | null;

type AnsiState = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  foreground: Paint;
  background: Paint;
};

// 基础 16 色映射到 Tailwind 调色板，跟随明暗主题；256 色与真彩色用内联样式。
const FOREGROUND_CLASSES = [
  'text-neutral-700 dark:text-neutral-300',
  'text-red-600 dark:text-red-400',
  'text-green-700 dark:text-green-400',
  'text-yellow-700 dark:text-yellow-400',
  'text-blue-600 dark:text-blue-400',
  'text-purple-600 dark:text-purple-400',
  'text-cyan-700 dark:text-cyan-400',
  'text-neutral-500 dark:text-neutral-200',
  'text-neutral-500 dark:text-neutral-400',
  'text-red-500 dark:text-red-400',
  'text-green-600 dark:text-green-400',
  'text-yellow-600 dark:text-yellow-300',
  'text-blue-500 dark:text-blue-400',
  'text-fuchsia-600 dark:text-fuchsia-400',
  'text-cyan-600 dark:text-cyan-300',
  'text-neutral-700 dark:text-neutral-100',
];

const BACKGROUND_CLASSES = [
  'bg-neutral-300 dark:bg-neutral-700',
  'bg-red-200 dark:bg-red-900',
  'bg-green-200 dark:bg-green-900',
  'bg-yellow-200 dark:bg-yellow-900',
  'bg-blue-200 dark:bg-blue-900',
  'bg-purple-200 dark:bg-purple-900',
  'bg-cyan-200 dark:bg-cyan-900',
  'bg-neutral-200 dark:bg-neutral-200',
  'bg-neutral-400 dark:bg-neutral-600',
  'bg-red-300 dark:bg-red-800',
  'bg-green-300 dark:bg-green-800',
  'bg-yellow-300 dark:bg-yellow-800',
  'bg-blue-300 dark:bg-blue-800',
  'bg-fuchsia-300 dark:bg-fuchsia-800',
  'bg-cyan-300 dark:bg-cyan-800',
  'bg-neutral-100 dark:bg-neutral-100',
];

function createState(): AnsiState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    foreground: null,
    background: null,
  };
}

function nextEscape(input: string, start: number): number {
  const next = input.indexOf(ESC, start);
  return next === -1 ? input.length : next;
}

function readEscape(input: string, start: number): { end: number; params: string | null } {
  let position = start + 1;
  if (position >= input.length) return { end: position, params: null };
  if (input[position] === '[') {
    position += 1;
    const paramStart = position;
    while (position < input.length) {
      const code = input.charCodeAt(position);
      if (code < 0x30 || code > 0x3f) break;
      position += 1;
    }
    const paramEnd = position;
    while (position < input.length) {
      const code = input.charCodeAt(position);
      if (code < 0x20 || code > 0x2f) break;
      position += 1;
    }
    if (position >= input.length) return { end: position, params: null };
    const isSgr = input[position] === 'm';
    return { end: position + 1, params: isSgr ? input.slice(paramStart, paramEnd) : null };
  }
  if (input[position] === ']') {
    position += 1;
    while (position < input.length) {
      if (input[position] === '\u0007') return { end: position + 1, params: null };
      if (input[position] === ESC && input[position + 1] === '\\') {
        return { end: position + 2, params: null };
      }
      position += 1;
    }
    return { end: position, params: null };
  }
  while (position < input.length) {
    const code = input.charCodeAt(position);
    if (code < 0x20 || code > 0x2f) break;
    position += 1;
  }
  if (position < input.length) position += 1;
  return { end: position, params: null };
}

function setPaint(state: AnsiState, code: number, paint: Paint) {
  if (code === 38) state.foreground = paint;
  else state.background = paint;
}

function extendedPaint(codes: number[], start: number): { paint: Paint; consumed: number } {
  if (codes[start] === 5) {
    const value = codes[start + 1];
    if (value === undefined || Number.isNaN(value)) return { paint: null, consumed: 1 };
    return { paint: { index: Math.min(Math.max(Math.trunc(value), 0), 255) }, consumed: 2 };
  }
  if (codes[start] === 2) {
    const channels: number[] = [];
    let cursor = start + 1;
    while (cursor < codes.length && channels.length < 3) {
      const value = codes[cursor];
      if (!Number.isNaN(value)) channels.push(Math.min(Math.max(Math.trunc(value), 0), 255));
      cursor += 1;
    }
    if (channels.length < 3) return { paint: null, consumed: codes.length - start };
    return { paint: { rgb: [channels[0], channels[1], channels[2]] }, consumed: cursor - start };
  }
  return { paint: null, consumed: 1 };
}

function applySgr(state: AnsiState, params: string) {
  const codes = params
    ? params.split(/[;:]/).map((value) => (value === '' ? Number.NaN : Number(value)))
    : [0];
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (Number.isNaN(code)) continue;
    if (code === 38 || code === 48) {
      const { paint, consumed } = extendedPaint(codes, index + 1);
      setPaint(state, code, paint);
      index += consumed;
      continue;
    }
    switch (code) {
      case 0:
        Object.assign(state, createState());
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.dim = true;
        break;
      case 3:
        state.italic = true;
        break;
      case 4:
        state.underline = true;
        break;
      case 7:
        state.inverse = true;
        break;
      case 9:
        state.strike = true;
        break;
      case 21:
      case 22:
        state.bold = false;
        state.dim = false;
        break;
      case 23:
        state.italic = false;
        break;
      case 24:
        state.underline = false;
        break;
      case 27:
        state.inverse = false;
        break;
      case 29:
        state.strike = false;
        break;
      case 39:
        state.foreground = null;
        break;
      case 49:
        state.background = null;
        break;
      default:
        if (code >= 30 && code <= 37) state.foreground = { index: code - 30 };
        else if (code >= 40 && code <= 47) state.background = { index: code - 40 };
        else if (code >= 90 && code <= 97) state.foreground = { index: code - 90 + 8 };
        else if (code >= 100 && code <= 107) state.background = { index: code - 100 + 8 };
        break;
    }
  }
}

function palette256Color(index: number): string {
  if (index < 232) {
    const cube = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(cube / 36) % 6];
    const green = levels[Math.floor(cube / 6) % 6];
    const blue = levels[cube % 6];
    return `rgb(${red} ${green} ${blue})`;
  }
  const value = 8 + (index - 232) * 10;
  return `rgb(${value} ${value} ${value})`;
}

function paintValue(paint: Paint, classes: string[]): { className?: string; style?: string } {
  if (!paint) return {};
  if ('rgb' in paint) return { style: `rgb(${paint.rgb[0]} ${paint.rgb[1]} ${paint.rgb[2]})` };
  if (paint.index < 16) return { className: classes[paint.index] };
  return { style: palette256Color(paint.index) };
}

function paintAttributes(state: AnsiState): { className: string; style?: CSSProperties } {
  const className: string[] = [];
  if (state.bold) className.push('font-semibold');
  if (state.dim) className.push('opacity-60');
  if (state.italic) className.push('italic');
  if (state.underline) className.push('underline');
  if (state.strike) className.push('line-through');
  const foreground = state.inverse ? state.background : state.foreground;
  const background = state.inverse ? state.foreground : state.background;
  const foregroundValue = paintValue(foreground, FOREGROUND_CLASSES);
  const backgroundValue = paintValue(background, BACKGROUND_CLASSES);
  if (foregroundValue.className) className.push(foregroundValue.className);
  if (backgroundValue.className) className.push(backgroundValue.className);
  const style: CSSProperties = {};
  if (foregroundValue.style) style.color = foregroundValue.style;
  if (backgroundValue.style) style.backgroundColor = backgroundValue.style;
  return {
    className: className.join(' '),
    style: Object.keys(style).length ? style : undefined,
  };
}

export function ansiPlainText(input: string): string {
  if (!input.includes(ESC)) return input;
  let plain = '';
  let position = 0;
  while (position < input.length) {
    if (input[position] !== ESC) {
      const next = nextEscape(input, position);
      plain += input.slice(position, next);
      position = next;
      continue;
    }
    position = readEscape(input, position).end;
  }
  return plain;
}

export function parseAnsi(input: string): AnsiText {
  if (!input.includes(ESC)) {
    return { text: input, spans: input ? [{ text: input, className: '' }] : [] };
  }
  const spans: AnsiSpan[] = [];
  const state = createState();
  let plain = '';
  let runStart = 0;
  const flush = () => {
    if (plain.length <= runStart) return;
    const { className, style } = paintAttributes(state);
    spans.push({ text: plain.slice(runStart, plain.length), className, style });
    runStart = plain.length;
  };
  let position = 0;
  while (position < input.length) {
    if (input[position] !== ESC) {
      const next = nextEscape(input, position);
      plain += input.slice(position, next);
      position = next;
      continue;
    }
    const escape = readEscape(input, position);
    if (escape.params !== null) {
      flush();
      applySgr(state, escape.params);
    }
    position = escape.end;
  }
  flush();
  return { text: plain, spans };
}
