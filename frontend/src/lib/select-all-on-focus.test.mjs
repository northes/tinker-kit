import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { selectAllOnFocus } from './select-all-on-focus.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });

function mount(value) {
  const input = dom.window.document.createElement('input');
  input.value = value;
  dom.window.document.body.appendChild(input);
  input.addEventListener('mousedown', selectAllOnFocus);
  input.addEventListener('mouseup', selectAllOnFocus);
  input.addEventListener('focus', selectAllOnFocus);
  return input;
}

function mouse(type, button = 0) {
  return new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button });
}

test('聚焦时全选已有文字', () => {
  const input = mount('alpha.local');
  input.focus();
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 'alpha.local'.length);
  input.remove();
});

test('空内容聚焦不调用选区', () => {
  const input = mount('');
  let calls = 0;
  input.select = () => {
    calls += 1;
  };
  input.focus();
  assert.equal(calls, 0);
  input.remove();
});

test('禁用时聚焦不调用选区', () => {
  const input = mount('alpha.local');
  input.disabled = true;
  let calls = 0;
  input.select = () => {
    calls += 1;
  };
  input.dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: true }));
  assert.equal(calls, 0);
  input.remove();
});

test('首次点入在 mouseup 补回全选，并阻止浏览器把光标落到点击处', () => {
  const input = mount('alpha.local');
  input.dispatchEvent(mouse('mousedown'));
  input.focus();
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, input.value.length);
  // 模拟聚焦后选区被清掉（浏览器 mouseup 或中间一次渲染）。
  input.setSelectionRange(3, 3);
  const up = mouse('mouseup');
  input.dispatchEvent(up);
  assert.equal(up.defaultPrevented, true);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, input.value.length);
  input.remove();
});

test('已经聚焦后再点不重新全选', () => {
  const input = mount('alpha.local');
  input.focus();
  input.setSelectionRange(4, 4);
  const down = mouse('mousedown');
  input.dispatchEvent(down);
  assert.equal(down.defaultPrevented, false);
  input.setSelectionRange(2, 2);
  const up = mouse('mouseup');
  input.dispatchEvent(up);
  assert.equal(up.defaultPrevented, false);
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 2);
  input.remove();
});
