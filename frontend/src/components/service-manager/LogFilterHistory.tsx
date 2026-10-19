import { acceptCompletion, closeCompletion, completionStatus } from '@codemirror/autocomplete';
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { Trash } from '@phosphor-icons/react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { LogFilterInput } from './LogFilterInput';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScrollArea } from '../ui/scroll-area';

export function LogFilterHistoryMenu({
  items,
  names,
  value,
  regex,
  onChange,
  children,
  onSelect,
  onDelete,
  onClear,
}: {
  items: string[];
  names: string[];
  value: string;
  regex: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
  onSelect: (value: string) => void;
  onDelete: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [completing, setCompleting] = useState(false);
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const popupID = useId();
  const triggerID = useId();
  const firstHistoryItem = useRef<HTMLButtonElement | null>(null);
  const focusFirstHistoryItem = useRef(false);
  const matchingItems = items.filter((item) => item.toLowerCase().includes(value.toLowerCase()));
  const historyVisible = open && !completing && matchingItems.length > 0;
  return (
    <Popover
      open={historyVisible}
      triggerId={triggerID}
      onOpenChange={(nextOpen, details) => {
        // 输入区域重复点击只保持展开，关闭由选择、Esc 或移出交互区域负责。
        if (!nextOpen && details.reason === 'trigger-press') {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <div
        ref={anchor}
        className="flex h-8 min-w-0 flex-1 overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      >
        <PopoverTrigger
          id={triggerID}
          nativeButton={false}
          render={<div />}
          role="group"
          tabIndex={-1}
          className="min-w-0 flex-1"
          onKeyDownCapture={(event) => {
            if (event.nativeEvent.isComposing) return;
            const view = editorRef.current?.view;
            if (!view?.hasFocus) return;
            if (event.key === 'ArrowDown' && !completing && matchingItems.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              focusFirstHistoryItem.current = true;
              setOpen(true);
              if (firstHistoryItem.current) {
                focusFirstHistoryItem.current = false;
                firstHistoryItem.current.focus();
              }
              return;
            }
            if (event.key === 'Escape') {
              if (view) closeCompletion(view);
              setOpen(false);
              event.stopPropagation();
            }
            if (event.key === 'Enter') {
              if (view && completionStatus(view.state) === 'active') {
                event.preventDefault();
                event.stopPropagation();
                acceptCompletion(view);
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onSelect(value);
              setOpen(false);
            }
          }}
        >
          <LogFilterInput
            names={names}
            editorRef={editorRef}
            onCompletionChange={setCompleting}
            value={value}
            regex={regex}
            label={t('serviceManagerTool.logFilter')}
            open={historyVisible}
            popupID={popupID}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(next) => {
              onChange(next);
              setOpen(true);
            }}
          />
        </PopoverTrigger>
        <div
          className="flex h-full shrink-0"
          onPointerDownCapture={() => setOpen(false)}
          onFocusCapture={() => setOpen(false)}
        >
          {children}
        </div>
      </div>
      <PopoverContent
        id={popupID}
        anchor={anchor}
        align="start"
        className="w-(--anchor-width) max-w-(--available-width)"
        initialFocus={false}
        finalFocus={false}
      >
        <div className="flex items-center justify-between">
          <span>{t('serviceManagerTool.filterHistory')}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!items.length}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClear}
          >
            {t('serviceManagerTool.clearFilterHistory')}
          </Button>
        </div>
        <ScrollArea
          className="max-h-64 min-h-0"
          scrollFade="y"
          options={{ overflow: { x: 'hidden' }, scrollbars: { visibility: 'hidden' } }}
        >
          {matchingItems.length ? (
            matchingItems.map((item, index) => (
              <div key={item} className="flex min-w-0 items-center gap-1">
                <Button
                  ref={
                    index === 0
                      ? (node) => {
                          firstHistoryItem.current = node;
                          if (node && focusFirstHistoryItem.current) {
                            focusFirstHistoryItem.current = false;
                            node.focus();
                          }
                        }
                      : undefined
                  }
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  title={item}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect(item);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{item}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('serviceManagerTool.deleteFilterHistory', { query: item })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onDelete(item)}
                >
                  <Trash />
                </Button>
              </div>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('serviceManagerTool.noFilterHistory')}
            </p>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
