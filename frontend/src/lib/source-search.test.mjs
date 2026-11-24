import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bestSourceSearchRank,
  normalizeSourceSearch,
  orderBySourceSearch,
  rankSourceSearch,
} from './source-search.ts';

test('归一化忽略大小写、空格、下划线和连字符', () => {
  assert.equal(normalizeSourceSearch('GX_Prod'), 'gxprod');
  assert.equal(normalizeSourceSearch('gx-prod'), 'gxprod');
  assert.equal(normalizeSourceSearch('l240 prod'), 'l240prod');
  assert.equal(normalizeSourceSearch('  _- '), '');
});

test('orbz 与 oz 都能命中 orb zot，去掉分隔符后的连续子串仍算连续命中', () => {
  // orb zot 归一化后是 orbzot，orbz 是连续子串；oz 只是按顺序出现。
  assert.equal(rankSourceSearch('orb zot', 'orbz'), 0);
  assert.equal(rankSourceSearch('orb zot', 'oz'), 1);
  assert.equal(rankSourceSearch('orb zot', 'orb'), 0);
  assert.equal(rankSourceSearch('orb zot', 'ORB Z'), 0);
  assert.equal(rankSourceSearch('orb zot', 'bro'), null);
});

test('l2p 命中三种分隔的 l240 prod，gxprod 仍是连续子串', () => {
  for (const name of ['l240_prod', 'l240-prod', 'l240 prod']) {
    assert.equal(rankSourceSearch(name, 'l2p'), 1);
    assert.equal(rankSourceSearch(name, 'l240'), 0);
  }
  assert.equal(rankSourceSearch('gx_prod', 'gxprod'), 0);
  assert.equal(rankSourceSearch('gx-prod', 'gxprod'), 0);
});

test('多字段取最好档：地址连续命中压过名称的按顺序命中', () => {
  assert.equal(bestSourceSearchRank(['orb zot', 'oz-host'], 'oz'), 0);
  assert.equal(bestSourceSearchRank(['alpha', 'user@l240-prod:22', ''], 'l2p'), 1);
  assert.equal(bestSourceSearchRank(['alpha', 'beta'], 'zz'), null);
  assert.equal(bestSourceSearchRank([], ''), 0);
});

test('连续子串在前，同档保持原顺序，空查询不改顺序', () => {
  const items = [
    { id: 'ordered-1', label: 'orb zot' },
    { id: 'contiguous-1', label: 'ozone' },
    { id: 'miss', label: 'beta' },
    { id: 'ordered-2', label: 'box zed' },
    { id: 'contiguous-2', label: 'foz' },
  ];
  const ordered = orderBySourceSearch(items, 'oz', (item) => [item.label]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ['contiguous-1', 'contiguous-2', 'ordered-1', 'ordered-2'],
  );
  assert.deepEqual(
    orderBySourceSearch(items, '   ', (item) => [item.label]).map((item) => item.id),
    items.map((item) => item.id),
  );
  assert.deepEqual(
    orderBySourceSearch(items, '', (item) => [item.label]).map((item) => item.id),
    items.map((item) => item.id),
  );
});

test('指定项命中时固定在末尾，不命中则剔除，空查询不动它', () => {
  const items = [
    { id: 'pin', label: 'box zed' },
    { id: 'contiguous', label: 'ozone' },
    { id: 'ordered', label: 'orb zot' },
  ];
  const pinLast = (item) => item.id === 'pin';
  assert.deepEqual(
    orderBySourceSearch(items, 'oz', (item) => [item.label], pinLast).map((item) => item.id),
    ['contiguous', 'ordered', 'pin'],
  );
  assert.deepEqual(
    orderBySourceSearch(items, 'nope', (item) => [item.label], pinLast).map((item) => item.id),
    [],
  );
  assert.deepEqual(
    orderBySourceSearch(items, '', (item) => [item.label], pinLast).map((item) => item.id),
    ['pin', 'contiguous', 'ordered'],
  );

  const missing = [{ id: 'missing', label: '配置已失效' }, ...items.slice(1)];
  const pinMissing = (item) => item.id === 'missing';
  assert.deepEqual(
    orderBySourceSearch(missing, '配置', (item) => [item.label], pinMissing).map((item) => item.id),
    ['missing'],
  );
  assert.deepEqual(
    orderBySourceSearch(missing, '配失', (item) => [item.label], pinMissing).map((item) => item.id),
    ['missing'],
  );
});
