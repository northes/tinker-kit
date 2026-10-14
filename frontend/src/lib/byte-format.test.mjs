import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatFileBytes,
  formatImageBytes,
  formatMetricBytes,
  formatTaskBytes,
} from './byte-format.ts';

test('各场景保留原有进制、精度和小数处理', () => {
  const cases = [
    [0, '0 B', '0 B', '0 B', '0 B'],
    [0.5, '0.5 B', '1 B', '1 B', '<1 B'],
    [1000, '1000 B', '1,000 B', '1.00 KB', '1000 B'],
    [1024, '1.0 KB', '1 KB', '1.02 KB', '1.0 KB'],
    [1536, '1.5 KB', '1.5 KB', '1.54 KB', '1.5 KB'],
    [10240, '10 KB', '10 KB', '10.2 KB', '10.0 KB'],
    [1024 ** 2, '1.0 MB', '1 MB', '1.05 MB', '1.0 MB'],
  ];
  for (const [value, file, image, metric, task] of cases) {
    assert.equal(formatFileBytes(value), file);
    assert.equal(formatImageBytes(value, 'en-US'), image);
    assert.equal(formatMetricBytes(value), metric);
    assert.equal(formatTaskBytes(value), task);
  }
  assert.equal(formatFileBytes(1024, true), '1 KB');
  assert.equal(formatFileBytes(10.5 * 1024 ** 2, true), '10.5 MB');
  assert.equal(formatFileBytes(10.5 * 1024 ** 2), '11 MB');
});

test('非法数值和超大数值保留场景各自的回退与最大单位', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(formatFileBytes(value), '—');
    assert.equal(formatImageBytes(value, 'zh-CN'), '');
    assert.equal(formatMetricBytes(value), '—');
    assert.equal(formatTaskBytes(value), '0 B');
  }
  assert.equal(formatFileBytes(-1), '—');
  assert.equal(formatImageBytes(-1, 'zh-CN'), '');
  assert.equal(formatMetricBytes(-1), '0 B');
  assert.equal(formatMetricBytes(null), '—');
  assert.equal(formatMetricBytes(undefined), '—');
  assert.equal(formatFileBytes(1024 ** 5), '1024 TB');
  assert.equal(formatImageBytes(1024 ** 5, 'en-US'), '1,024 TB');
  assert.equal(formatMetricBytes(1000 ** 5), '1000 TB');
  assert.equal(formatTaskBytes(1024 ** 5), '1024.0 TB');
});

test('镜像大小按语言格式化数字', () => {
  assert.equal(formatImageBytes(1234 * 1024 ** 4, 'en-US'), '1,234 TB');
  assert.equal(formatImageBytes(1234 * 1024 ** 4, 'de-DE'), '1.234 TB');
});
