import { useEffect, useState, type Ref } from 'react';
import { ToolSearchField, toolHeaderControlClassName } from '../shared';

export function ImageSearchField({
  id,
  label,
  placeholder,
  value,
  onSearch,
  inputRef,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onSearch: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
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
      className={toolHeaderControlClassName}
      inputRef={inputRef}
    />
  );
}
