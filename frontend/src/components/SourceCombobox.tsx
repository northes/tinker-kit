import { GearSix } from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectAllOnFocus } from '@/lib/select-all-on-focus';
import { bestSourceSearchRank, orderBySourceSearch } from '@/lib/source-search';
import { Button } from './ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox';

type SourceOption = { value: string; label: string };

type SourceComboboxProps = {
  id?: string;
  label: string;
  labelId?: string;
  value: string | null;
  items: SourceOption[];
  onValueChange: (value: string) => void;
  manage?: { label: string; onClick: () => void };
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

function sourceFields(item: SourceOption) {
  return [item.label];
}

function matchesSource(item: SourceOption, query: string) {
  return bestSourceSearchRank(sourceFields(item), query) !== null;
}

export function SourceCombobox({
  id,
  label,
  labelId,
  value,
  items,
  onValueChange,
  manage,
  placeholder,
  disabled,
  className,
}: SourceComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const selected = items.find((item) => item.value === value) ?? null;
  // draft 为空表示还没输入筛选，列表保持原顺序。输入后连续子串排在按顺序命中之前。
  const rankedItems = useMemo(
    () => orderBySourceSearch(items, draft ?? '', sourceFields),
    [items, draft],
  );
  // 关闭时会清掉 draft。冻住打开期间的排序，避免退出动画闪回全量列表。
  // 重新打开且尚未输入时仍传原顺序；Base UI 在选中标签未改前会忽略这份外部列表。
  const rankedWhileOpenRef = useRef(rankedItems);
  if (open) rankedWhileOpenRef.current = rankedItems;

  function closePopup() {
    setOpen(false);
    setDraft(null);
  }

  // 工具进入禁用态时结束本次筛选，恢复后从关闭状态开始。
  if (disabled && (open || draft !== null)) {
    closePopup();
  }

  return (
    <Combobox<SourceOption>
      items={items}
      value={selected}
      onValueChange={(next, details) => {
        // 删除筛选文字时，Base UI 也会尝试清空选中项。
        if (next === null) {
          details.cancel();
        } else if (!details.isCanceled) {
          onValueChange(next.value);
        }
      }}
      inputRef={inputRef}
      inputValue={draft ?? selected?.label ?? ''}
      onInputValueChange={(next, details) => {
        if (details.reason === 'escape-key') {
          // 浮层已关闭时，保留选中项并将 Esc 交给外层。
          setDraft(null);
          details.cancel();
          details.allowPropagation();
        } else if (details.reason === 'input-change') {
          setDraft(next);
        }
      }}
      filter={matchesSource}
      filteredItems={open ? rankedItems : rankedWhileOpenRef.current}
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          setOpen(true);
          return;
        }
        closePopup();
        if (details.reason === 'escape-key' && manageButtonRef.current?.matches(':focus')) {
          inputRef.current?.focus();
        }
      }}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        aria-labelledby={labelId}
        aria-label={labelId || id ? undefined : label}
        className={className}
        inputClassName="min-w-0 truncate"
        disabled={disabled}
        placeholder={placeholder}
        triggerLabel={label}
        onFocus={selectAllOnFocus}
        onMouseDown={selectAllOnFocus}
        onMouseUp={selectAllOnFocus}
        onBlur={(event) => {
          if (!manageButtonRef.current || event.relatedTarget !== manageButtonRef.current) {
            setDraft(null);
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            event.preventBaseUIHandler();
            return;
          }
          if (event.key === 'Enter') {
            // 避免隐式提交外层表单。
            event.preventDefault();
            // 浮层打开且过滤后只剩一台时直接选中；已是当前值只关浮层，避免重复 onValueChange。
            if (open && rankedItems.length === 1) {
              const item = rankedItems[0]!;
              if (item.value !== value) {
                onValueChange(item.value);
              }
              closePopup();
              event.preventBaseUIHandler();
              return;
            }
            // 0 台或多台时仍由高亮项确认，无高亮时 Base UI 只关浮层。
          }
          if (open && event.key === 'Tab' && !event.shiftKey && manageButtonRef.current) {
            // 管理按钮位于 Portal 内，按 Tab 从输入框进入固定动作行。
            event.preventDefault();
            manageButtonRef.current.focus();
          }
        }}
      />
      <ComboboxContent className="flex flex-col">
        <ComboboxList
          className="min-h-0"
          aria-labelledby={labelId}
          aria-label={labelId ? undefined : label}
        >
          {(item: SourceOption) => (
            <ComboboxItem key={item.value} value={item}>
              <span className="truncate">{item.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{t('common.noMatches')}</ComboboxEmpty>
        {manage ? (
          <div className="shrink-0 border-t p-1 group-data-empty/combobox-content:border-t-0">
            <Button
              ref={manageButtonRef}
              type="button"
              variant="ghost"
              disabled={disabled || !open}
              className="w-full justify-start"
              onMouseDown={(event) => {
                // 点击管理时保持输入焦点，避免清除筛选后动作行移出指针位置。
                if (event.button === 0) event.preventDefault();
              }}
              onClick={() => {
                inputRef.current?.focus();
                closePopup();
                manage.onClick();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                inputRef.current?.focus();
                if (event.shiftKey) {
                  event.preventDefault();
                } else {
                  closePopup();
                }
              }}
            >
              <GearSix weight="regular" aria-hidden="true" />
              <span className="truncate">{manage.label}</span>
            </Button>
          </div>
        ) : null}
      </ComboboxContent>
    </Combobox>
  );
}
