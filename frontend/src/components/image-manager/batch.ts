// 后端对单次镜像批量调用有条目上限，超出上限的条目会被直接标记失败而不是继续处理。
// 这里把大批量选择拆成多次调用，让每个请求都落在上限内。
export function chunkImageBatch<T>(items: T[], limit: number): T[][] {
  if (items.length === 0) return [];
  // 上限读取失败时不猜测数值，退回单次调用。
  if (!Number.isFinite(limit) || limit >= items.length) return [items];
  const size = Math.max(1, Math.floor(limit));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// 逐批串行执行：镜像批量操作会争用同一条删除/变更锁，并行只会互相等待。
export async function runImageBatches<T, R>(
  items: T[],
  limit: number,
  run: (chunk: T[]) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const chunk of chunkImageBatch(items, limit)) {
    results.push(await run(chunk));
  }
  return results;
}
