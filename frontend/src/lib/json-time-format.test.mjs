import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSON_TIME_FORMATS, formatJsonTimeValue } from './json-time-format.ts';

const instant = '2024-01-02T03:04:05.123Z';
const milliseconds = Date.parse(instant);

test('识别常见时间 key、snake_case 和 camelCase，只格式化对应值', () => {
  for (const key of [
    'ts',
    'time',
    'timestamp',
    'create_time',
    'update_time',
    'delete_time',
    'created_at',
    'updatedAt',
    'deletedAt',
    'startTime',
    'end_date',
    'last_login_at',
    'mtime',
  ]) {
    assert.equal(formatJsonTimeValue(key, instant, 'iso'), instant, key);
  }
  for (const key of [undefined, 'id', 'runtime', 'timeout', 'times', 'estimate', 'format']) {
    assert.equal(formatJsonTimeValue(key, instant, 'iso'), null, key);
  }
});

test('识别数字或字符串的秒、毫秒时间戳及小数秒', () => {
  for (const value of [
    milliseconds,
    String(milliseconds),
    milliseconds / 1000,
    String(milliseconds / 1000),
  ]) {
    assert.equal(formatJsonTimeValue('timestamp', value, 'iso'), instant);
  }
  assert.equal(formatJsonTimeValue('ts', 0, 'iso'), '1970-01-01T00:00:00.000Z');
  assert.equal(formatJsonTimeValue('ts', -1, 'iso'), '1969-12-31T23:59:59.000Z');
});

test('完整日期、SQL 日期时间和斜线日期使用本地时区，支持所有目标格式', () => {
  const source = '2024-01-02 03:04:05.123';
  assert.equal(formatJsonTimeValue('time', source, 'datetime'), '2024-01-02 03:04:05');
  assert.equal(formatJsonTimeValue('time', source, 'milliseconds'), source);
  assert.equal(formatJsonTimeValue('time', source, 'date'), '2024-01-02');
  assert.equal(formatJsonTimeValue('time', '2024/1/2 03:04:05', 'datetime'), '2024-01-02 03:04:05');
  assert.equal(formatJsonTimeValue('time', '2024-01-02', 'date'), '2024-01-02');
  assert.equal(
    formatJsonTimeValue('time', source, 'iso'),
    new Date(2024, 0, 2, 3, 4, 5, 123).toISOString(),
  );
});

test('带偏移的时间和 UTC 时间表示同一时刻', () => {
  assert.equal(formatJsonTimeValue('time', '2024-01-02T11:04:05.123+08:00', 'iso'), instant);
  assert.equal(formatJsonTimeValue('time', '2024-01-02T03:04:05.123z', 'iso'), instant);
});

test('无效日期、普通内容、非标量及无法确定单位的数字保持原样', () => {
  for (const value of [
    null,
    undefined,
    true,
    {},
    [],
    '',
    'hello',
    '2024-02-30',
    '2023-02-29',
    '2024-13-01',
    '2024-01-02T25:00:00Z',
    '2024-01',
    '03:04',
    '2024-01-02T03:04:05+08:99',
    '1704164645123456',
    NaN,
    Infinity,
  ]) {
    assert.equal(formatJsonTimeValue('time', value, 'iso'), null, String(value));
  }
});

test('关闭时跳过识别，格式化不修改原始对象，重复调用无额外状态', () => {
  const source = Object.freeze({ time: milliseconds, id: milliseconds });
  for (const target of JSON_TIME_FORMATS) {
    formatJsonTimeValue('time', source.time, target);
  }
  assert.equal(formatJsonTimeValue('time', instant, 'none'), null);
  assert.deepEqual(source, { time: milliseconds, id: milliseconds });
});
