import { GearSix } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolDefinition } from '../components/SettingsPage';
import { ToolSearchField } from '../components/shared';
import type { ToolId } from '../components/shared';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';
import type { Romanize } from './definitions';
import { buildIndex, searchIndexedItems } from './palette-search';

const SEARCH_ID = 'workspace-blank-tab-search';
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
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      document.getElementById(SEARCH_ID)?.focus();
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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-none px-4 pb-3 pt-4">
        <ToolSearchField
          id={SEARCH_ID}
          value={query}
          onValueChange={setQuery}
          onSubmit={() => {
            const only = filtered[0];
            if (filtered.length !== 1 || !only) return;
            choose(only);
          }}
          onClear={() => setQuery('')}
          placeholder={t('workspaceTabs.blankSearchPlaceholder')}
          ariaLabel={t('workspaceTabs.blankSearchPlaceholder')}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1" options={{ overflow: { x: 'hidden' } }}>
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
  );
}
