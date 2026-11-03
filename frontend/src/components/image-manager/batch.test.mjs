import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkImageBatch, runImageBatches } from './batch.ts';

test('按上限切分，余数单独成批', () => {
  assert.deepEqual(chunkImageBatch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkImageBatch([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
  assert.deepEqual(chunkImageBatch([1, 2, 3], 100), [[1, 2, 3]]);
});

test('空列表不产生调用，小于等于上限时只调用一次', () => {
  assert.deepEqual(chunkImageBatch([], 100), []);
  assert.deepEqual(chunkImageBatch(['a'], 1), [['a']]);
});

test('上限不可用或非法时退回单次调用', () => {
  assert.deepEqual(chunkImageBatch([1, 2, 3], Number.POSITIVE_INFINITY), [[1, 2, 3]]);
  assert.deepEqual(chunkImageBatch([1, 2, 3], Number.NaN), [[1, 2, 3]]);
  assert.deepEqual(chunkImageBatch([1, 2, 3], 0), [[1], [2], [3]]);
  assert.deepEqual(chunkImageBatch([1, 2, 3], 1.9), [[1], [2], [3]]);
});

test('串行执行并保持批次顺序，返回每批结果', async () => {
  const running = [];
  let active = 0;
  const results = await runImageBatches([1, 2, 3, 4, 5], 2, async (chunk) => {
    active += 1;
    assert.equal(active, 1, '批次不允许并行');
    running.push(chunk.length);
    await Promise.resolve();
    active -= 1;
    return chunk.reduce((sum, value) => sum + value, 0);
  });
  assert.deepEqual(running, [2, 2, 1]);
  assert.deepEqual(results, [3, 7, 5]);
});

test('单批失败即停止后续批次，并把错误抛给调用方', async () => {
  const calls = [];
  await assert.rejects(
    runImageBatches([1, 2, 3, 4], 2, async (chunk) => {
      calls.push(chunk);
      if (calls.length === 2) throw new Error('boom');
      return chunk;
    }),
    /boom/,
  );
  assert.deepEqual(calls, [
    [1, 2],
    [3, 4],
  ]);
});
