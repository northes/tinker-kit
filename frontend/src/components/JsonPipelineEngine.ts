export type PipelineItemType = 'extract' | 'sort' | 'arraySort' | 'filter' | 'template';
export type PipelineSortMode = 'key' | 'value';
export type PipelineDirection = 'asc' | 'desc';
export type PipelineItem = {
  id: string;
  enabled: boolean;
  type: PipelineItemType;
  path: string;
  sortMode: PipelineSortMode;
  direction: PipelineDirection;
  arrayPath: string;
  itemPath: string;
  filterValue: string;
  template: string;
};

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

class PipelineConfigError extends Error {
  constructor() {
    super('invalidConfig');
  }
}

const typeOptions: PipelineItemType[] = ['extract', 'sort', 'arraySort', 'filter', 'template'];
const configString = (item: Record<string, unknown>, key: string, fallback: string) => {
  const value = item[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new PipelineConfigError();
  return value;
};

const createPipelineId = () => `pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function parsePipelineConfig(source: string): PipelineItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new PipelineConfigError();
  }
  if (isObject(parsed) && parsed.version !== undefined && parsed.version !== 1)
    throw new PipelineConfigError();
  const items = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : null;
  if (!items) throw new PipelineConfigError();
  const result = items.map((raw) => {
    if (
      !isObject(raw) ||
      typeof raw.type !== 'string' ||
      !typeOptions.includes(raw.type as PipelineItemType)
    )
      throw new PipelineConfigError();
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
      throw new PipelineConfigError();
    if (raw.sortMode !== undefined && raw.sortMode !== 'key' && raw.sortMode !== 'value')
      throw new PipelineConfigError();
    if (raw.direction !== undefined && raw.direction !== 'asc' && raw.direction !== 'desc')
      throw new PipelineConfigError();
    const item: PipelineItem = {
      id: createPipelineId(),
      enabled: raw.enabled ?? true,
      type: raw.type as PipelineItemType,
      path: configString(raw, 'path', '$'),
      sortMode: (raw.sortMode ?? 'key') as PipelineSortMode,
      direction: (raw.direction ?? 'asc') as PipelineDirection,
      arrayPath: configString(raw, 'arrayPath', '$'),
      itemPath: configString(raw, 'itemPath', '$'),
      filterValue: configString(raw, 'filterValue', ''),
      template: configString(raw, 'template', '{$.name}?token={$.token}'),
    };
    return item;
  });
  if (result.filter((item) => item.type === 'template').length > 1) throw new PipelineConfigError();
  const template = result.find((item) => item.type === 'template');
  return template ? [...result.filter((item) => item !== template), template] : result;
}

export function serializePipeline(rules: PipelineItem[]): string {
  return JSON.stringify({ version: 1, items: rules.map(({ id, ...item }) => item) }, null, 2);
}
