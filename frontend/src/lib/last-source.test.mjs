import assert from 'node:assert/strict';
import test from 'node:test';
import { createLastSourceMemory, resolveLastSource } from './last-source.ts';

test('记住的来源仍在列表里时返回它', () => {
  const memory = createLastSourceMemory();
  memory.remember('ssh:1');
  assert.equal(memory.resolve(['local', 'ssh:1', 'ssh:2'], 'local'), 'ssh:1');
});

test('记住的来源已被删除时回退到调用方的默认值', () => {
  const memory = createLastSourceMemory();
  memory.remember('ssh:9');
  assert.equal(memory.resolve(['local', 'ssh:1'], 'local'), 'local');
  assert.equal(memory.resolve(['ssh:1', 'ssh:2'], 'ssh:1'), 'ssh:1');
});

test('空值不覆盖已有的记忆', () => {
  const memory = createLastSourceMemory();
  memory.remember('ssh:1');
  memory.remember('');
  memory.remember(null);
  memory.remember(undefined);
  assert.equal(memory.resolve(['ssh:1'], 'local'), 'ssh:1');
});

test('两个实例互不影响', () => {
  const ports = createLastSourceMemory();
  const network = createLastSourceMemory();
  ports.remember('ssh:1');
  network.remember('ssh:2');
  assert.equal(ports.resolve(['ssh:1', 'ssh:2'], 'local'), 'ssh:1');
  assert.equal(network.resolve(['ssh:1', 'ssh:2'], 'local'), 'ssh:2');
  // 没有记忆过的实例仍然走默认值。
  assert.equal(createLastSourceMemory().resolve(['ssh:1'], 'local'), 'local');
});

test('挂载快照不随其它标签的选择变化', () => {
  const memory = createLastSourceMemory();
  memory.remember('ssh:1');
  // 新标签在挂载时取一次快照。
  const snapshot = memory.current();
  // 另一个标签随后改成本工具的上次来源。
  memory.remember('ssh:2');
  assert.equal(snapshot, 'ssh:1');
  assert.equal(memory.current(), 'ssh:2');
  // 已有标签继续用快照，只有新标签读到新值。
  assert.equal(resolveLastSource(snapshot, ['local', 'ssh:1', 'ssh:2'], 'local'), 'ssh:1');
  assert.equal(memory.resolve(['local', 'ssh:1', 'ssh:2'], 'local'), 'ssh:2');
});

test('快照里的来源被删除后回退到调用方的默认值', () => {
  const memory = createLastSourceMemory();
  memory.remember('ssh:9');
  const snapshot = memory.current();
  assert.equal(resolveLastSource(snapshot, ['local', 'ssh:1'], 'local'), 'local');
  // 没有记忆时快照是空串，同样只走默认值。
  assert.equal(resolveLastSource(createLastSourceMemory().current(), ['ssh:1'], 'ssh:1'), 'ssh:1');
});
