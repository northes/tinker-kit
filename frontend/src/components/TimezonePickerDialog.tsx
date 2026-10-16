import { useTranslation } from 'react-i18next';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';

export function TimezonePickerDialog({
  open,
  onOpenChange,
  zones,
  selectedIds,
  currentId,
  onSelect,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 区域/城市名等额外检索词由数据源提供，不参与展示。
  zones: Array<{ id: string; label: string; keywords?: string[] }>;
  selectedIds: string[];
  // 打开面板时高亮并滚动到中间的当前值。
  currentId?: string;
  onSelect: (id: string) => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const dialogTitle = title ?? t('timeTool.realTime.selectZone');
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
      description={dialogTitle}
      className="sm:max-w-lg"
    >
      <Command className="rounded-none! bg-transparent" initialValue={currentId}>
        <CommandInput placeholder={t('timeTool.timezonePlaceholder')} />
        <CommandList>
          <CommandEmpty>{t('timeTool.timezoneNoResults')}</CommandEmpty>
          <CommandGroup>
            {zones.map((zone) => {
              const added = selectedIds.includes(zone.id);
              return (
                <CommandItem
                  key={zone.id}
                  value={zone.id}
                  keywords={[
                    zone.label,
                    ...(zone.keywords ?? []),
                    ...(added ? t('timeTool.realTime.alreadyAddedSearchTerms').split(/\s+/) : []),
                  ]}
                  onSelect={() => {
                    onSelect(zone.id);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{zone.label}</span>
                  {added ? (
                    <span className="ms-auto flex-none text-xs text-muted-foreground">
                      {t('timeTool.realTime.alreadyAdded')}
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
