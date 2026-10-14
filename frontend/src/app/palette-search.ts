import { type IndexedItem, type Romanize, type TranslatablePaletteItem } from './definitions';

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

export function buildIndex(items: TranslatablePaletteItem[], romanize: Romanize): IndexedItem[] {
  return items.map((item) => {
    const raw = `${item.label} ${item.group} ${item.subgroup} ${item.keywords}`.toLowerCase();
    const text = raw.replace(/\s+/g, '');
    let initials = '';
    for (const word of raw.split(/\s+/)) {
      if (/^[a-z0-9]+$/.test(word)) {
        if (word.length <= 2) initials += word;
      } else {
        for (const c of word) {
          const s = romanize(c);
          if (s) initials += s[0];
        }
      }
    }
    return { ...item, text, pinyin: romanize(text), initials };
  });
}
