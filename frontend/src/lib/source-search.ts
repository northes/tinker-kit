// 匹配时忽略大小写和常见分隔符，便于用 gxprod 找到 gx_prod、gx-prod 等名称。
export function normalizeSourceSearch(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

// 0：归一化后的连续子串。1：查询字符按顺序出现。null：不匹配。
// 空查询视为连续命中，调用方据此保留原顺序。
export function rankSourceSearch(value: string, query: string): 0 | 1 | null {
  const needle = normalizeSourceSearch(query);
  if (needle === '') return 0;
  const haystack = normalizeSourceSearch(value);
  if (haystack.includes(needle)) return 0;
  let index = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found < 0) return null;
    index = found + 1;
  }
  return 1;
}

// 一项有多处可搜字段时，取最好的一档：任一字段连续命中即优于仅按顺序命中。
export function bestSourceSearchRank(fields: readonly string[], query: string): 0 | 1 | null {
  if (normalizeSourceSearch(query) === '') return 0;
  let ordered = false;
  for (const field of fields) {
    const rank = rankSourceSearch(field, query);
    if (rank === 0) return 0;
    if (rank === 1) ordered = true;
  }
  return ordered ? 1 : null;
}

// 连续子串在前，按顺序命中在后；同档保持原顺序。不匹配的项剔除。
// pinLast 命中时固定排在末尾（SSH「配置已失效」），空查询不改原顺序。
export function orderBySourceSearch<T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => readonly string[],
  pinLast?: (item: T) => boolean,
): T[] {
  if (normalizeSourceSearch(query) === '') return items.slice();
  const contiguous: T[] = [];
  const ordered: T[] = [];
  const pinned: T[] = [];
  for (const item of items) {
    const rank = bestSourceSearchRank(fieldsOf(item), query);
    if (rank === null) continue;
    if (pinLast?.(item)) {
      pinned.push(item);
      continue;
    }
    if (rank === 0) contiguous.push(item);
    else ordered.push(item);
  }
  return contiguous.concat(ordered, pinned);
}
