import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskBytes, formatTaskDuration } from './task-format.ts';

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

test('任务耗时使用紧凑的时分秒格式并钳制负数', () => {
  assert.equal(formatTaskDuration(0), '0:00');
  assert.equal(formatTaskDuration(89), '1:29');
  assert.equal(formatTaskDuration(3661), '1:01:01');
  assert.equal(formatTaskDuration(-10), '0:00');
});
