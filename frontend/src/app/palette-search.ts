import { type IndexedItem, type Romanize, type TranslatablePaletteItem } from './definitions';

export {
  fuzzyScore,
  normalizePaletteQuery,
  paletteItemMatchScore,
  searchIndexedItems,
  type PaletteSearchable,
} from './palette-fuzzy';

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
