import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../components/ui/command';
import { type IndexedItem, type Page } from './definitions';
import { fuzzyScore } from './palette-search';

export function CommandPalette({
  open,
  onClose,
  indexed,
  run,
  page,
}: {
  open: boolean;
  onClose: () => void;
  indexed: IndexedItem[];
  run: (item: IndexedItem) => void;
  page: Page;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  useEffect(() => {
    if (open) setInput('');
  }, [open]);
  const matches = useMemo(() => {
    const q = input.trim().toLowerCase().replace(/\s+/g, '');
    if (!q) return null;
    const isEnglish = /^[a-z0-9]+$/i.test(q);
    const rank = (i: IndexedItem) =>
      i.tool === page
        ? 0
        : i.tool || i.groupKey === 'groups.tools'
          ? 1
          : i.groupKey === 'groups.nav'
            ? 2
            : 3;
    const labelHit = (i: IndexedItem) =>
      isEnglish && i.label.toLowerCase().replace(/\s+/g, '').includes(q) ? 1 : 0;
    const initialsHit = (i: IndexedItem) => (isEnglish && i.initials.includes(q) ? 1 : 0);
    const scored: Array<{ item: IndexedItem; score: number }> = [];
    for (const item of indexed) {
      const score = Math.max(
        fuzzyScore(item.text, q),
        fuzzyScore(item.pinyin, q) * 0.95,
        fuzzyScore(item.initials, q) * 0.9,
      );
      if (score > 0) scored.push({ item, score });
    }
    scored.sort(
      (a, b) =>
        rank(a.item) - rank(b.item) ||
        labelHit(b.item) - labelHit(a.item) ||
        initialsHit(b.item) - initialsHit(a.item) ||
        b.score - a.score,
    );
    return scored.map((s) => s.item);
  }, [input, indexed, page]);
  const list = matches ?? indexed;
  const groups = useMemo(() => {
    const grouped = new Map<string, { heading: string; items: IndexedItem[] }>();
    for (const item of list) {
      const heading = item.subgroup ? `${item.group} - ${item.subgroup}` : item.group;
      const group = grouped.get(heading);
      if (group) group.items.push(item);
      else grouped.set(heading, { heading, items: [item] });
    }
    const groupRank = (items: IndexedItem[]) =>
      Math.min(
        ...items.map((item) =>
          item.tool === page
            ? 0
            : item.tool || item.groupKey === 'groups.tools'
              ? 1
              : item.groupKey === 'groups.nav'
                ? 2
                : 3,
        ),
      );
    return [...grouped.values()].sort((a, b) => groupRank(a.items) - groupRank(b.items));
  }, [list, page]);
  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={t('palette.title')}
      description={t('palette.description')}
    >
      <Command shouldFilter={false} aria-label={t('palette.listLabel')}>
        <CommandInput
          autoFocus
          aria-label={t('palette.searchLabel')}
          placeholder={t('palette.searchPlaceholder')}
          value={input}
          onValueChange={(value) => setInput(value)}
        />
        <CommandList>
          <CommandEmpty>{t('palette.empty')}</CommandEmpty>
          {groups.map((group, index) => (
            <Fragment key={group.heading}>
              {index > 0 && <CommandSeparator />}
              <CommandGroup heading={group.heading}>
                {group.items.map((item) => (
                  <CommandItem key={item.id} value={item.id} onSelect={() => run(item)}>
                    <item.icon size={16} weight="duotone" />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </Fragment>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
