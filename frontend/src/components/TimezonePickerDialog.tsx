import { useTranslation } from 'react-i18next';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';

export function TimezonePickerDialog({
  open,
  onOpenChange,
  zones,
  selectedIds,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zones: Array<{ id: string; label: string }>;
  selectedIds: string[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const title = t('timeTool.realTime.selectZone');
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={title}
      className="sm:max-w-lg"
    >
      <Command className="rounded-none! bg-transparent">
        <CommandInput placeholder={t('timeTool.timezonePlaceholder')} />
        <CommandList>
          <CommandEmpty>{t('timeTool.timezoneNoResults')}</CommandEmpty>
          {zones.map((zone) => {
            const added = selectedIds.includes(zone.id);
            return (
              <CommandItem
                key={zone.id}
                value={zone.id}
                keywords={[zone.label]}
                disabled={added}
                onSelect={() => {
                  onSelect(zone.id);
                  onOpenChange(false);
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
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
