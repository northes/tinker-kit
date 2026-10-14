export function basename(path: string) {
  return path.split('/').filter(Boolean).pop() || path;
}

export function normalizeRemotePath(value: string) {
  const segments: string[] = [];
  for (const segment of value.trim().split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function remoteParent(value: string) {
  const normalized = normalizeRemotePath(value);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}
