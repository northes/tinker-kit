import { MagnifyingGlass } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { Input } from '../ui/input';

export function ImageSearchField({
  id,
  label,
  placeholder,
  value,
  onSearch,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onSearch: (value: string) => void;
}) {
  const labelId = useId();
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="flex min-w-0 flex-col gap-1 text-[10px] font-medium text-muted-foreground max-[700px]:w-full">
      <span id={labelId}>{label}</span>
      <div className="relative flex w-[220px] max-w-full items-center max-[700px]:w-full">
        <MagnifyingGlass
          size={14}
          weight="duotone"
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 text-muted-foreground"
        />
        <Input
          id={id}
          aria-labelledby={labelId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              onSearch(draft);
            }
          }}
          placeholder={placeholder}
          className="h-[30px] pl-8 text-[11px]"
        />
      </div>
    </div>
  );
}
