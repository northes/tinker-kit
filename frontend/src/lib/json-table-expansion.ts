// 展开状态由预览会话持有，不依赖单元格或表格 DOM 的挂载周期。
export function createJsonTableExpansion() {
  const expanded = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    isExpanded: (path: string) => expanded.has(path),
    toggle(path: string) {
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      listeners.get(path)?.forEach((listener) => listener());
    },
    subscribe(path: string, listener: () => void) {
      const subscribers = listeners.get(path) ?? new Set<() => void>();
      subscribers.add(listener);
      listeners.set(path, subscribers);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(path);
      };
    },
  };
}

export function jsonTableChildPath(parent: string, key: string | number): string {
  return `${parent}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
