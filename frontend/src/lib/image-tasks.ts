import type { ImageTaskSnapshot } from '../../bindings/tinkerkit/models';

// 事件、首次查询和导出响应共用版本判断，避免晚到的快照清空或回退任务。
export function applyImageTaskSnapshot(
  current: ImageTaskSnapshot | null,
  incoming: ImageTaskSnapshot,
): ImageTaskSnapshot {
  return current && incoming.revision <= current.revision ? current : incoming;
}
