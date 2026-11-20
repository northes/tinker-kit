// 匹配时忽略大小写和常见分隔符，便于用 gxprod 找到 gx_prod、gx-prod 等名称。
export function normalizeSourceSearch(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}
