import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonRepairError, normalizeJsonSyntax, repairJson } from './json-repair.ts';

const parse = (source) => JSON.parse(repairJson(source).text);

test('修复单引号与未加引号的键', () => {
  assert.deepEqual(parse(`{name: 'Ethan', age: 27}`), { name: 'Ethan', age: 27 });
});

test('修复对象和数组的最后一项逗号', () => {
  assert.deepEqual(parse(`{"users":["Tom","Jerry",],}`), { users: ['Tom', 'Jerry'] });
});

test('补齐缺失的逗号', () => {
  assert.deepEqual(parse(`{"name":"Ethan"\n"age":27}`), { name: 'Ethan', age: 27 });
});

test('补全未闭合的字符串', () => {
  assert.deepEqual(parse(`{\n  "name": "Ethan,\n  "age": 27\n}`), { name: 'Ethan', age: 27 });
});

test('补全未闭合的括号', () => {
  assert.deepEqual(parse(`{"profile":{"age":27}`), { profile: { age: 27 } });
});

test('修复 undefined 与大小写错误的布尔值和常量', () => {
  assert.deepEqual(parse(`{"age": undefined, "on": True, "off": FALSE, "v": NONE}`), {
    age: null,
    on: true,
    off: false,
    v: null,
  });
});

test('移除注释', () => {
  assert.deepEqual(parse(`{\n  // 名称\n  "name": "Ethan",\n  /* 年龄 */\n  "age": 27\n}`), {
    name: 'Ethan',
    age: 27,
  });
});

test('转义字符串中的直接换行', () => {
  assert.deepEqual(parse(`{"message":"hello\nworld"}`), { message: 'hello\nworld' });
});

test('把多个根对象合并为数组', () => {
  assert.deepEqual(parse(`{"name":"Tom"}\n{"name":"Jerry"}`), [{ name: 'Tom' }, { name: 'Jerry' }]);
});

test('把等号当冒号处理', () => {
  assert.deepEqual(parse(`{"name" = "Ethan", "age" = 27}`), { name: 'Ethan', age: 27 });
});

test('把分号当逗号处理', () => {
  assert.deepEqual(parse(`{"name":"Ethan"; "age":27;}`), { name: 'Ethan', age: 27 });
});

test('修复混用的数组和对象括号', () => {
  assert.deepEqual(parse(`{"users":[{"name":"Tom"],{"name":"Jerry"}]}`), {
    users: [{ name: 'Tom' }, { name: 'Jerry' }],
  });
});

test('修复数字前导加号、十六进制与前导零', () => {
  assert.deepEqual(parse(`{"plus": +123, "hex": 0xFF, "zero": 00123}`), {
    plus: 123,
    hex: 255,
    zero: 123,
  });
});

test('修复非法转义与非法数字格式', () => {
  assert.deepEqual(parse(`{"a":"\\x20","b":"\\v"}`), { a: 'x20', b: 'v' });
  assert.deepEqual(parse(`{"a":123.,"b":.123,"c":1e}`), { a: 123, b: 0.123, c: 1 });
});

test('字符串与注释内容不会被归一化改写', () => {
  assert.equal(normalizeJsonSyntax(`{"a":"x = y; z"}`), `{"a":"x = y; z"}`);
  assert.equal(normalizeJsonSyntax(`{"a":"0xFF"}`), `{"a":"0xFF"}`);
  assert.equal(normalizeJsonSyntax(`{"date":"2023-01-01"}`), `{"date":"2023-01-01"}`);
});

test('不会改写标识符内的常量或十六进制片段', () => {
  assert.equal(
    normalizeJsonSyntax('{"a": myundefined, "b": a0xFF}'),
    '{"a": myundefined, "b": a0xFF}',
  );
});

test('有效 JSON 不标记为已修复', () => {
  const valid = '{"project":"TinkerKit","version":1}';
  const result = repairJson(valid);
  assert.equal(result.changed, false);
  assert.deepEqual(JSON.parse(result.text), JSON.parse(valid));
});

test('无法修复的输入抛出 JsonRepairError', () => {
  assert.throws(() => repairJson('   '), JsonRepairError);
  assert.throws(() => repairJson('][,:'), JsonRepairError);
});
