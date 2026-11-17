import { GearSix } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolDefinition } from '../components/SettingsPage';
import { ToolSearchField } from '../components/shared';
import type { ToolId } from '../components/shared';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';
import type { Romanize } from './definitions';
import { buildIndex, searchIndexedItems } from './palette-search';

const SETTINGS_ITEM = '__settings__';
// 设置方块和工具并列，排在末尾；搜索关键词与命令面板的设置项保持一致。
const SETTINGS_KEYWORDS = 'settings preferences options 设置 配置 选项';

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
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
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
  const choose = (item: (typeof indexed)[number]) => {
    if (item.id === SETTINGS_ITEM) onOpenSettings();
    else if (item.tool) onSelectTool(item.tool);
  };
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
                onSubmit={(value) => {
                  // 空查询不响应回车；有关键词时打开当前排序的第一个结果（可能是设置）。
                  if (!value) return;
                  const first = filtered[0];
                  if (!first) return;
                  choose(first);
                }}
                placeholder={t('workspaceTabs.blankSearchPlaceholder')}
                ariaLabel={t('workspaceTabs.blankSearchLabel')}
              />
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 px-4 pb-4 pt-1">
            {filtered.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-[5.5rem] w-full flex-col gap-2 px-2 py-3 text-center whitespace-normal"
                  onClick={() => choose(item)}
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
