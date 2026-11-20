// 本次运行内某个工具最近一次选中的来源，供该工具新建标签沿用；只活在内存里。
//
// 不写 localStorage、不进持久化 Config：重启后回退到各工具原有默认。
// 记忆按工具隔离，每个工具各建一个实例，互不共享，也不跨工具按 SSH 主机共享。
export type LastSourceMemory = {
  // 空值忽略，避免来源还没加载完时用空串覆盖已有的记忆。
  remember(sourceID: string | null | undefined): void;
  // 本工具当前记住的来源（可能为空串）。标签在挂载时取一次快照，
  // 之后就不再跟着其它标签的选择变化。
  current(): string;
  // 记住的来源仍可用就用它，否则用调用方给的默认值（各工具原有默认）。
  resolve(availableIDs: readonly string[], fallback: string): string;
};

// 记忆的取值规则：记住的来源仍在候选里才返回它，否则用调用方给的默认值。
// 单独导出是为了让在渲染期需要固定取值的标签用挂载快照调用同一条规则。
export function resolveLastSource(
  remembered: string,
  availableIDs: readonly string[],
  fallback: string,
): string {
  return remembered && availableIDs.includes(remembered) ? remembered : fallback;
}

export function createLastSourceMemory(): LastSourceMemory {
  let remembered = '';
  return {
    remember(sourceID) {
      if (!sourceID) return;
      remembered = sourceID;
    },
    current() {
      return remembered;
    },
    resolve(availableIDs, fallback) {
      return resolveLastSource(remembered, availableIDs, fallback);
    },
  };
}
