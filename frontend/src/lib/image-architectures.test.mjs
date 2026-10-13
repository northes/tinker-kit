import assert from 'node:assert/strict';
import test from 'node:test';
import { imageArchitectures } from './image-architectures.ts';

const image = (...architectures) => ({
  platforms: architectures.map((architecture) => ({ architecture, os: 'linux', variant: '' })),
});

test('单架构与多架构都返回去重排序后的架构列表', () => {
  assert.deepEqual(imageArchitectures(image('amd64')), ['amd64']);
  assert.deepEqual(imageArchitectures(image('arm64', 'amd64', 'arm64')), ['amd64', 'arm64']);
});

test('占位架构与缺失平台返回空列表', () => {
  assert.deepEqual(imageArchitectures(image('unknown')), []);
  assert.deepEqual(imageArchitectures(image('')), []);
  assert.deepEqual(imageArchitectures({ platforms: null }), []);
  assert.deepEqual(imageArchitectures(image('amd64', 'unknown', 'amd64')), ['amd64']);
});
