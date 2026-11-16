import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolDefinition } from '../components/SettingsPage';
import { ToolSearchField } from '../components/shared';
import type { ToolId } from '../components/shared';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';

const SEARCH_ID = 'workspace-blank-tab-search';

export function BlankTabPicker({
  active,
  tools,
  onSelect,
}: {
  active: boolean;
  tools: ToolDefinition[];
  onSelect: (toolId: ToolId) => void;
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
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool) => {
      const name = t(tool.nameKey).toLowerCase();
      return name.includes(q) || tool.keywords.toLowerCase().includes(q);
    });
  }, [query, t, tools]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-none px-4 pb-3 pt-4">
        <ToolSearchField
          id={SEARCH_ID}
          value={query}
          onValueChange={setQuery}
          onSubmit={() => {
            if (filtered.length !== 1) return;
            const only = filtered[0];
            if (only) onSelect(only.id as ToolId);
          }}
          onClear={() => setQuery('')}
          placeholder={t('workspaceTabs.blankSearchPlaceholder')}
          ariaLabel={t('workspaceTabs.blankSearchPlaceholder')}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1" options={{ overflow: { x: 'hidden' } }}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 px-4 pb-4 pt-1">
          {filtered.map((tool) => {
            const Icon = tool.icon;
            return (
              <Button
                key={tool.id}
                type="button"
                variant="ghost"
                className="h-auto min-h-[5.5rem] w-full flex-col gap-2 px-2 py-3 text-center whitespace-normal"
                onClick={() => onSelect(tool.id as ToolId)}
              >
                <Icon size={22} weight="regular" aria-hidden="true" className="shrink-0" />
                <span className="line-clamp-2 w-full text-[11px] leading-tight text-foreground">
                  {t(tool.nameKey)}
                </span>
              </Button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
