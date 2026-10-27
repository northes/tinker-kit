import { useEffect, useState } from 'react';
import { ToolSearchField } from '../shared';

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
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <ToolSearchField
      id={id}
      label={label}
      placeholder={placeholder}
      value={draft}
      onValueChange={setDraft}
      onSubmit={onSearch}
      className="w-[220px] max-[700px]:w-full"
    />
  );
}
