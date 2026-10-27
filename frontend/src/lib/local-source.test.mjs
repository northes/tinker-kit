import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalSource, sourceLabel } from './local-source.ts';

test('本地来源按 id 或 kind 判定', () => {
  assert.equal(isLocalSource({ id: 'local', kind: 'local' }), true);
  assert.equal(isLocalSource({ id: 'local' }), true);
  assert.equal(isLocalSource({ id: 'ssh:1', kind: 'local' }), true);
  assert.equal(isLocalSource({ id: 'ssh:1', kind: 'ssh' }), false);
  assert.equal(isLocalSource({ id: 'registry:docker', kind: 'registry' }), false);
});

test('本地来源展示名走 i18n，忽略持久化的 name', () => {
  // Go 端把本地来源的 name 固定为「本机」，英文界面不能直接展示它。
  assert.equal(
    sourceLabel({ id: 'local', kind: 'local', name: '本机' }, 'Local machine'),
    'Local machine',
  );
  assert.equal(sourceLabel({ id: 'local', kind: 'local', name: '本机' }, '本机'), '本机');
});

test('远程来源展示用户填写的名称', () => {
  assert.equal(sourceLabel({ id: 'ssh:1', kind: 'ssh', name: '测试机' }, '本机'), '测试机');
  assert.equal(sourceLabel({ id: 'ssh:1', kind: 'ssh' }, '本机'), '');
});
