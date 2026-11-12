import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateTaskRemainingSeconds,
  fileTaskMeasure,
  formatTaskBytes,
  formatTaskDuration,
  imageTaskMeasure,
  summarizeTaskMeasures,
  taskMeasurePercent,
} from './task-format.ts';

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

test('镜像和文件任务都填成当前值与总量', () => {
  assert.deepEqual(imageTaskMeasure({ progressUnit: 'bytes', bytes: 10, completed: 1, total: 20 }), {
    current: 10,
    total: 20,
    unit: 'bytes',
  });
  assert.deepEqual(imageTaskMeasure({ progressUnit: 'items', bytes: 10, completed: 2, total: 5 }), {
    current: 2,
    total: 5,
    unit: 'count',
  });
  assert.deepEqual(fileTaskMeasure({ completed: 4, total: 8, files: 3, doneFiles: 1 }), {
    current: 4,
    total: 8,
    unit: 'bytes',
  });
  assert.deepEqual(fileTaskMeasure({ completed: 0, total: 0, files: 3, doneFiles: 1 }), {
    current: 1,
    total: 3,
    unit: 'files',
  });
});

test('有总量就按比例显示，成功时视为完成，没有总量则不确定', () => {
  const measure = { current: 25, total: 100, unit: 'bytes' };
  assert.equal(taskMeasurePercent(measure, 'running'), 25);
  assert.equal(taskMeasurePercent({ ...measure, current: 150 }, 'running'), 100);
  assert.equal(taskMeasurePercent(measure, 'success'), 100);
  assert.equal(taskMeasurePercent({ ...measure, total: 0 }, 'running'), null);
});

test('汇总进度要求总量已知且单位同类', () => {
  assert.deepEqual(
    summarizeTaskMeasures([
      { current: 25, total: 100, unit: 'bytes' },
      { current: 25, total: 100, unit: 'bytes' },
    ]),
    { percent: 25, remainingBytes: 150 },
  );
  assert.deepEqual(
    summarizeTaskMeasures([
      { current: 1, total: 4, unit: 'count' },
      { current: 1, total: 4, unit: 'files' },
    ]),
    { percent: 25, remainingBytes: null },
  );
  assert.deepEqual(
    summarizeTaskMeasures([
      { current: 25, total: 100, unit: 'bytes' },
      { current: 1, total: 4, unit: 'count' },
    ]),
    { percent: null, remainingBytes: null },
  );
  assert.deepEqual(
    summarizeTaskMeasures([
      { current: 25, total: 100, unit: 'bytes' },
      { current: 0, total: 0, unit: 'bytes' },
    ]),
    { percent: null, remainingBytes: null },
  );
});

test('速度低于 1 B/s 或输入无效时不估算剩余时间', () => {
  assert.equal(estimateTaskRemainingSeconds(1024, 0), null);
  assert.equal(estimateTaskRemainingSeconds(1024, 0.99), null);
  assert.equal(estimateTaskRemainingSeconds(1024, Number.NaN), null);
  assert.equal(estimateTaskRemainingSeconds(Number.POSITIVE_INFINITY, 1), null);
});

test('速度达到 1 B/s 后按剩余字节估算时间', () => {
  assert.equal(estimateTaskRemainingSeconds(1024, 1), 1024);
  assert.equal(estimateTaskRemainingSeconds(1024, 512), 2);
  assert.equal(estimateTaskRemainingSeconds(1, 2), 1);
  assert.equal(estimateTaskRemainingSeconds(0, 1), 0);
});
