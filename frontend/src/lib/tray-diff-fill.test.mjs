import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTrayDiffFillTarget } from './tray-diff-fill.ts';

test('总是左边或右边', () => {
  const map = new Map();
  assert.deepEqual(resolveTrayDiffFillTarget('before', 't1', map).target, 'before');
  assert.deepEqual(resolveTrayDiffFillTarget('after', 't1', map).target, 'after');
});

test('交替填入按标签独立记下一次目标侧', () => {
  const map = new Map();
  const a1 = resolveTrayDiffFillTarget('alternate', 'tab-a', map);
  assert.equal(a1.target, 'before');
  const a2 = resolveTrayDiffFillTarget('alternate', 'tab-a', a1.nextByTabId);
  assert.equal(a2.target, 'after');
  const a3 = resolveTrayDiffFillTarget('alternate', 'tab-a', a2.nextByTabId);
  assert.equal(a3.target, 'before');

  const b1 = resolveTrayDiffFillTarget('alternate', 'tab-b', a3.nextByTabId);
  assert.equal(b1.target, 'before');
});
