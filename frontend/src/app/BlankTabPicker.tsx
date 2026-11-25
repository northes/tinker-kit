import { GearSix } from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolDefinition } from '../components/SettingsPage';
import { ToolSearchField } from '../components/shared';
import type { ToolId } from '../components/shared';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { Romanize } from './definitions';
import { buildIndex, searchIndexedItems } from './palette-search';

const SETTINGS_ITEM = '__settings__';
// 设置方块和工具并列，排在末尾；搜索关键词与命令面板的设置项保持一致。
const SETTINGS_KEYWORDS = 'settings preferences options 设置 配置 选项';

function gridColumnCount(grid: HTMLElement | null) {
  if (!grid) return 1;
  const children = [...grid.children] as HTMLElement[];
  if (children.length === 0) return 1;
  const firstTop = children[0].offsetTop;
  let cols = 0;
  for (const child of children) {
    if (Math.abs(child.offsetTop - firstTop) > 1) break;
    cols += 1;
  }
  return cols || 1;
}

export function BlankTabPicker({
  active,
  tools,
  romanize,
  onSelectTool,
  onOpenSettings,
}: {
  active: boolean;
  tools: ToolDefinition[];
  romanize: Romanize;
  onSelectTool: (toolId: ToolId) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  // 多个空白标签同时常驻挂载，搜索框必须定位到自己那一份，元素 id 也要各实例独立。
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      searchRef.current?.focus();
      setHighlightIndex(null);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
  useEffect(() => {
    setHighlightIndex(null);
  }, [query]);
  const indexed = useMemo(
    () =>
      buildIndex(
        [
          ...tools.map((tool) => ({
            id: tool.id,
            labelKey: tool.nameKey,
            groupKey: 'groups.tools',
            icon: tool.icon,
            keywords: tool.keywords,
            tool: tool.id as ToolId,
            label: t(tool.nameKey),
            group: '',
            subgroup: '',
          })),
          {
            id: SETTINGS_ITEM,
            labelKey: 'settings.title',
            groupKey: 'groups.nav',
            icon: GearSix,
            keywords: SETTINGS_KEYWORDS,
            label: t('settings.title'),
            group: '',
            subgroup: '',
          },
        ],
        romanize,
      ),
    [romanize, t, tools],
  );
  const filtered = useMemo(() => searchIndexedItems(indexed, query) ?? indexed, [indexed, query]);
  useEffect(() => {
    setHighlightIndex((current) => {
      if (current == null) return null;
      if (filtered.length === 0) return null;
      return Math.min(current, filtered.length - 1);
    });
  }, [filtered.length]);
  const choose = useCallback(
    (item: (typeof indexed)[number]) => {
      if (item.id === SETTINGS_ITEM) onOpenSettings();
      else if (item.tool) onSelectTool(item.tool);
    },
    [onOpenSettings, onSelectTool],
  );
  const focusHighlight = useCallback((index: number) => {
    setHighlightIndex(index);
    requestAnimationFrame(() => {
      const node = itemRefs.current[index];
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, []);
  useLayoutEffect(() => {
    if (highlightIndex == null) return;
    const node = itemRefs.current[highlightIndex];
    if (!node) return;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [highlightIndex, filtered]);
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown' || filtered.length === 0) return;
    event.preventDefault();
    focusHighlight(0);
  };
  const onTileKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const len = filtered.length;
    if (len === 0) return;
    const cols = gridColumnCount(gridRef.current);
    const last = len - 1;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const rowCount = Math.ceil(len / cols);
    if (event.key === 'ArrowRight') {
      if (col < cols - 1 && index < last) {
        event.preventDefault();
        focusHighlight(Math.min(index + 1, last));
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (col > 0) {
        event.preventDefault();
        focusHighlight(index - 1);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      const nextRow = row + 1;
      if (nextRow < rowCount) {
        event.preventDefault();
        focusHighlight(Math.min(nextRow * cols + col, last));
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      if (row > 0) {
        event.preventDefault();
        focusHighlight((row - 1) * cols + col);
        return;
      }
      event.preventDefault();
      setHighlightIndex(null);
      searchRef.current?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = filtered[index];
      if (item) choose(item);
    }
  };
  itemRefs.current.length = filtered.length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[52rem] flex-col justify-center">
        <ScrollArea className="min-h-0 max-h-full" options={{ overflow: { x: 'hidden' } }}>
          <div className="px-4 pb-3 pt-4">
            <div className="mx-auto w-full max-w-[32rem]">
              <ToolSearchField
                id={searchId}
                inputRef={searchRef}
                value={query}
                onValueChange={setQuery}
                onKeyDown={onSearchKeyDown}
                onSubmit={(value) => {
                  // 空查询不响应回车；有关键词时打开当前排序的第一个结果（可能是设置）。
                  if (!value) return;
                  const target =
                    highlightIndex != null && filtered[highlightIndex]
                      ? filtered[highlightIndex]
                      : filtered[0];
                  if (!target) return;
                  choose(target);
                }}
                placeholder={t('workspaceTabs.blankSearchPlaceholder')}
                ariaLabel={t('workspaceTabs.blankSearchLabel')}
              />
            </div>
          </div>
          <div
            ref={gridRef}
            role="listbox"
            aria-label={t('workspaceTabs.blankSearchLabel')}
            className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 px-4 pb-4 pt-1"
          >
            {filtered.map((item, index) => {
              const Icon = item.icon;
              const highlighted = highlightIndex === index;
              return (
                <Button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={highlighted}
                  variant="ghost"
                  tabIndex={highlighted ? 0 : -1}
                  className={cn(
                    'h-auto min-h-[5.5rem] w-full flex-col gap-2 px-2 py-3 text-center whitespace-normal',
                    highlighted && 'bg-accent text-foreground ring-2 ring-ring',
                  )}
                  onClick={() => choose(item)}
                  onKeyDown={(event) => onTileKeyDown(event, index)}
                  onFocus={() => setHighlightIndex(index)}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                >
                  <Icon size={22} weight="regular" aria-hidden="true" className="shrink-0" />
                  <span className="line-clamp-2 w-full text-[11px] leading-tight text-foreground">
                    {item.label}
                  </span>
                </Button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
