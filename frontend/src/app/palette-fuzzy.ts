export type PaletteSearchable = {
  label: string;
  text: string;
  pinyin: string;
  initials: string;
};

export function fuzzyScore(text: string, q: string): number {
  let m = 0,
    score = 0,
    streak = 0,
    prev = -1;
  for (let i = 0; i < q.length; i++) {
    const idx = text.indexOf(q[i], m);
    if (idx < 0) return -1;
    if (prev !== -1 && idx === prev + 1) {
      streak++;
      score += 3 + streak * 2;
    } else {
      streak = 0;
      score += 1 + (idx === 0 ? 4 : 0);
    }
    prev = idx;
    m = idx + 1;
  }
  return score + (m === text.length ? 2 : 0);
}

export function normalizePaletteQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

export function paletteItemMatchScore(item: PaletteSearchable, q: string): number {
  return Math.max(
    fuzzyScore(item.text, q),
    fuzzyScore(item.pinyin, q) * 0.95,
    fuzzyScore(item.initials, q) * 0.9,
  );
}

export function searchIndexedItems<T extends PaletteSearchable>(
  items: T[],
  rawQuery: string,
  tieBreak?: (a: T, b: T, q: string) => number,
): T[] | null {
  const q = normalizePaletteQuery(rawQuery);
  if (!q) return null;
  const isEnglish = /^[a-z0-9]+$/i.test(q);
  const labelHit = (i: T) =>
    isEnglish && i.label.toLowerCase().replace(/\s+/g, '').includes(q) ? 1 : 0;
  const initialsHit = (i: T) => (isEnglish && i.initials.includes(q) ? 1 : 0);
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = paletteItemMatchScore(item, q);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => {
    const tie = tieBreak?.(a.item, b.item, q) ?? 0;
    if (tie !== 0) return tie;
    return (
      labelHit(b.item) - labelHit(a.item) ||
      initialsHit(b.item) - initialsHit(a.item) ||
      b.score - a.score
    );
  });
  return scored.map((s) => s.item);
}
