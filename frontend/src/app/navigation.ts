import type { SidebarToolConfig } from '../../bindings/tinkerkit/models';
import { type ToolId } from '../components/shared';
import { tools, type Page, type PaletteItem } from './definitions';

export function routePath(page: Page | null) {
  return page ? `/${page}` : '/';
}

export function isPage(value: unknown): value is Page {
  return value === 'settings' || tools.some((tool) => tool.id === value);
}

export function isToolId(value: string): value is ToolId {
  return tools.some((tool) => tool.id === value);
}

export function resolveSidebarTools(
  configs: SidebarToolConfig[] | null | undefined,
): SidebarToolConfig[] {
  const seen = new Set<string>();
  const resolved: SidebarToolConfig[] = [];
  for (const item of configs ?? []) {
    if (!isToolId(item.id) || seen.has(item.id)) continue;
    resolved.push({ id: item.id, enabled: item.enabled });
    seen.add(item.id);
  }
  for (const tool of tools) {
    // 缺失工具仍追加到末尾。端口转发要跟在用户已经排好的端口占用后面，不能因为后加就掉到列表尾部。
    if (tool.id === 'port-forwards' || seen.has(tool.id)) continue;
    resolved.push({ id: tool.id, enabled: true });
    seen.add(tool.id);
  }
  if (seen.has('port-forwards')) return resolved;
  const inserted: SidebarToolConfig[] = [];
  for (const item of resolved) {
    inserted.push(item);
    if (item.id === 'ports') inserted.push({ id: 'port-forwards', enabled: true });
  }
  return inserted;
}

export function moveSidebarToolBy(
  list: SidebarToolConfig[],
  id: string,
  delta: number,
): SidebarToolConfig[] {
  const from = list.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function paletteToolId(item: PaletteItem): ToolId | null {
  if (item.tool) return item.tool;
  if (item.page && item.page !== 'settings') return item.page;
  return null;
}
