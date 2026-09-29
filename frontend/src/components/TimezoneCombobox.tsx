import { useId } from 'react';
import { Globe } from '@phosphor-icons/react';
import { Button } from './ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from './ui/combobox';

export function TimezoneCombobox({
  value,
  onChange,
  zones,
  placeholder,
  emptyLabel,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  zones: Array<{ id: string; label: string }>;
  placeholder: string;
  emptyLabel: string;
  label: string;
}) {
  const labelId = useId();
  const current = zones.find((zone) => zone.id === value);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 pt-3.5 font-mono text-[10px] font-medium uppercase tracking-[.04em] text-muted-foreground">
      <span id={labelId}>{label}</span>
      <Combobox
        items={zones}
        value={current ?? null}
        onValueChange={(zone) => {
          if (zone) onChange(zone.id);
        }}
        itemToStringValue={(zone) => zone.label}
      >
        <ComboboxTrigger
          render={
            <Button
              variant="ghost"
              className="h-[46px] w-full justify-between rounded-lg border border-border bg-card px-3.5 text-[13px] font-normal"
              aria-labelledby={labelId}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Globe data-icon="inline-start" size={18} weight="duotone" />
            <span className="min-w-0 truncate">
              <ComboboxValue placeholder={placeholder} />
            </span>
          </span>
        </ComboboxTrigger>
        <ComboboxContent className="min-w-(--anchor-width)">
          <ComboboxInput
            inputClassName="select-text"
            showTrigger={false}
            placeholder={placeholder}
          />
          <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
          <ComboboxList>
            {(zone) => (
              <ComboboxItem key={zone.id} value={zone}>
                {zone.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
