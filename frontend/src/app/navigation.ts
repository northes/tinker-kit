import type { SidebarToolConfig } from '../../bindings/changeme/models';
import { type ToolId } from '../components/shared';
import { tools, type Page, type PaletteItem } from './definitions';

function loadValue<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') as T;
  } catch {
    return fallback;
  }
}

export const IMAGE_MANAGER_DETAIL_PATH = '/image-manager/detail';

type ImageManagerDetailRoute = {
  sourceId: string;
  imageId: string;
};

export function imageManagerDetailRoute(
  pathname: string,
  search: string,
): ImageManagerDetailRoute | null {
  if (pathname !== IMAGE_MANAGER_DETAIL_PATH) return null;
  const params = new URLSearchParams(search);
  const sourceId = params.get('source')?.trim() ?? '';
  const imageId = params.get('image')?.trim() ?? '';
  return sourceId && imageId ? { sourceId, imageId } : null;
}

function pageFromPath(path: string): Page {
  const value = path.replace(/^\/+/, '');
  if (value === 'settings' || value === 'history' || tools.some((tool) => tool.id === value))
    return value as Page;
  const last = loadValue<string>('devutils.lastPage', '');
  if (last === 'settings' || last === 'history' || tools.some((tool) => tool.id === last))
    return last as Page;
  return tools[0].id as Page;
}

export function pageFromLocation(pathname: string, search: string): Page {
  if (imageManagerDetailRoute(pathname, search)) return 'image-manager-detail';
  if (pathname === IMAGE_MANAGER_DETAIL_PATH) return 'image-manager';
  return pageFromPath(pathname);
}

export function routePath(page: Page) {
  return page === 'image-manager-detail' ? IMAGE_MANAGER_DETAIL_PATH : `/${page}`;
}

export function routeMatchesPage(pathname: string, search: string, page: Page) {
  if (page === 'image-manager-detail') return imageManagerDetailRoute(pathname, search) !== null;
  return pathname === routePath(page);
}

export function isPage(value: unknown): value is Page {
  return value === 'settings' || value === 'history' || tools.some((tool) => tool.id === value);
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
    if (!seen.has(tool.id)) resolved.push({ id: tool.id, enabled: true });
  }
  return resolved;
}

export function availablePage(page: Page, sidebarTools: SidebarToolConfig[]): Page {
  if (page === 'settings' || page === 'history' || page === 'image-manager-detail') return page;
  if (sidebarTools.some((item) => item.id === page && item.enabled)) return page;
  const firstEnabled = sidebarTools.find((item) => item.enabled && isToolId(item.id));
  return firstEnabled ? (firstEnabled.id as ToolId) : 'settings';
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
  if (
    item.page &&
    item.page !== 'settings' &&
    item.page !== 'history' &&
    item.page !== 'image-manager-detail'
  )
    return item.page;
  return null;
}
