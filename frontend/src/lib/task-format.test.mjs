import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskBytes } from './task-format.ts';

test('任务速度小于 1 B/s 时显示有效单位，不会产生 undefined', () => {
  assert.equal(formatTaskBytes(0.5), '<1 B');
  assert.equal(formatTaskBytes(0.5006), '<1 B');
});

test('任务字节格式化覆盖单位边界和非法输入', () => {
  assert.equal(formatTaskBytes(0), '0 B');
  assert.equal(formatTaskBytes(Number.NaN), '0 B');
  assert.equal(formatTaskBytes(512.6), '513 B');
  assert.equal(formatTaskBytes(1024), '1.0 KB');
  assert.equal(formatTaskBytes(1024 ** 5), '1024.0 TB');
});
