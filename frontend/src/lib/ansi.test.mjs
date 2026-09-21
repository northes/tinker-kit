import assert from 'node:assert/strict';
import test from 'node:test';
import { ansiPlainText, parseAnsi } from './ansi.ts';

test('无转义序列时保持原文', () => {
  const line = parseAnsi('plain text');
  assert.equal(line.text, 'plain text');
  assert.deepEqual(line.spans, [{ text: 'plain text', className: '' }]);
  assert.equal(ansiPlainText('plain text'), 'plain text');
  assert.deepEqual(parseAnsi(''), { text: '', spans: [] });
});

test('彩色序列渲染为带样式的片段且不进入纯文本', () => {
  const line = parseAnsi('\u001b[90msrvx 0.11.21 · node 20.20.2 · prod\u001b[39m');
  assert.equal(line.text, 'srvx 0.11.21 · node 20.20.2 · prod');
  assert.equal(line.spans.length, 1);
  assert.match(line.spans[0].className, /text-neutral-500/);
  assert.equal(line.spans[0].style, undefined);
});

test('重置与组合样式按顺序生效', () => {
  const line = parseAnsi('\u001b[1;31merror\u001b[0m done');
  assert.equal(line.text, 'error done');
  assert.deepEqual(
    line.spans.map((span) => span.text),
    ['error', ' done'],
  );
  assert.match(line.spans[0].className, /font-semibold/);
  assert.match(line.spans[0].className, /text-red-600/);
  assert.equal(line.spans[1].className, '');
});

test('背景色与反显互换前景背景', () => {
  const line = parseAnsi('\u001b[31;47mwarn\u001b[7mnow');
  assert.match(line.spans[0].className, /text-red-600/);
  assert.match(line.spans[0].className, /bg-neutral-200/);
  assert.match(line.spans[1].className, /bg-red-200/);
  assert.match(line.spans[1].className, /text-neutral-200/);
});

test('256 色与真彩色使用内联样式', () => {
  const palette = parseAnsi('\u001b[38;5;208mhot');
  assert.equal(palette.spans[0].style?.color, 'rgb(255 135 0)');
  const grayscale = parseAnsi('\u001b[38;5;240mgray');
  assert.equal(grayscale.spans[0].style?.color, 'rgb(88 88 88)');
  const truecolor = parseAnsi('\u001b[38;2;10;20;30mdeep');
  assert.equal(truecolor.spans[0].style?.color, 'rgb(10 20 30)');
  const colon = parseAnsi('\u001b[38:2::1:2:3mcolon');
  assert.equal(colon.spans[0].style?.color, 'rgb(1 2 3)');
});

test('非 SGR 控制序列被丢弃且不影响纯文本', () => {
  const line = parseAnsi(
    '\u001b[2K\u001b[1Gprogress\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\',
  );
  assert.equal(line.text, 'progresslink');
  assert.equal(line.spans.length, 1);
});

test('ansiPlainText 与解析结果一致', () => {
  const raw = '\u001b[90mr\u001b[0m\u001b[2Kest';
  assert.equal(ansiPlainText(raw), parseAnsi(raw).text);
  assert.equal(ansiPlainText(raw), 'rest');
});
