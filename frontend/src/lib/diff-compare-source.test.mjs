import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getComparableDiffSource,
  isDiffCompareSourceAvailable,
  isDiffCompareSourceTab,
  listDiffCompareSources,
} from './diff-compare-source.ts';

const toolTab = (id, toolId, pinned = false) => ({
  id,
  kind: 'tool',
  toolId,
  ordinal: 1,
  activatedAt: 0,
  pinned,
});

const remoteSource = {
  toolId: 'ssh-files',
  editorOpen: true,
  ready: true,
  fileName: 'config.yaml',
  text: '  modified: true\n',
};

test('只允许 JSON、文本和 SSH 文件管理作为来源', () => {
  for (const toolId of ['json', 'text', 'ssh-files']) {
    assert.equal(isDiffCompareSourceTab(toolTab(toolId, toolId)), true);
  }
  assert.equal(isDiffCompareSourceTab(toolTab('diff', 'diff')), false);
  assert.equal(isDiffCompareSourceTab({ ...toolTab('blank', 'json'), kind: 'blank' }), false);
  assert.equal(isDiffCompareSourceTab({ ...toolTab('settings', 'text'), kind: 'settings' }), false);
});

test('空白禁用，实际填入文本保留首尾空白', () => {
  assert.equal(isDiffCompareSourceAvailable(undefined), false);
  assert.equal(isDiffCompareSourceAvailable(null), false);
  assert.equal(isDiffCompareSourceAvailable({ toolId: 'json', text: '' }), false);
  assert.equal(isDiffCompareSourceAvailable({ toolId: 'text', text: ' \t\n　' }), false);
  const source = { toolId: 'json', text: '  { "ok": true }\n' };
  assert.equal(getComparableDiffSource(toolTab('json', 'json'), source), source);
  assert.equal(getComparableDiffSource(toolTab('text', 'text'), source), undefined);
});

test('SSH 编辑器必须已打开、已就绪且有文本', () => {
  assert.equal(isDiffCompareSourceAvailable(remoteSource), true);
  assert.equal(isDiffCompareSourceAvailable({ ...remoteSource, editorOpen: false }), false);
  assert.equal(isDiffCompareSourceAvailable({ ...remoteSource, ready: false }), false);
  assert.equal(isDiffCompareSourceAvailable({ ...remoteSource, text: '\n' }), false);
});

test('候选跟随标签栏顺序并附上 SSH 文件名', () => {
  const remote = toolTab('remote', 'ssh-files', true);
  const text = toolTab('text', 'text');
  const json = toolTab('json', 'json');
  const diff = toolTab('diff', 'diff');
  const blankInput = toolTab('blank-input', 'json');
  const closed = toolTab('closed', 'ssh-files');
  const sources = new Map([
    ['json', { toolId: 'json', text: '{}' }],
    ['text', { toolId: 'text', text: 'hello' }],
    ['remote', remoteSource],
    ['diff', { toolId: 'text', text: 'excluded' }],
    ['blank-input', { toolId: 'json', text: '  ' }],
    ['closed', { ...remoteSource, editorOpen: false }],
  ]);

  assert.deepEqual(listDiffCompareSources([remote, text, diff, json, blankInput, closed], sources), [
    { tab: remote, fileName: 'config.yaml' },
    { tab: text, fileName: undefined },
    { tab: json, fileName: undefined },
  ]);
  assert.deepEqual(listDiffCompareSources([remote, json, text], sources).map(({ tab }) => tab.id), [
    'remote',
    'json',
    'text',
  ]);
  assert.deepEqual(listDiffCompareSources([diff, blankInput, closed], sources), []);
});
