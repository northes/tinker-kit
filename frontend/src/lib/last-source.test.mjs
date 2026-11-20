import assert from 'node:assert/strict';
import test from 'node:test';
import { createLastSourceMemory } from './last-source.ts';

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
