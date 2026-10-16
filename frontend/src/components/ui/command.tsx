import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group';
import { MagnifyingGlassIcon, CheckIcon } from '@phosphor-icons/react';

const CommandDialogOpenContext = React.createContext(true);
const CommandResetSelectionContext = React.createContext<() => void>(() => {});

function Command({
  className,
  onValueChange,
  onPointerMoveCapture,
  initialValue,
  ...props
}: React.ComponentProps<typeof CommandPrimitive> & { initialValue?: string }) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const itemSignature = React.useRef('');
  const lastPointerPosition = React.useRef<{ x: number; y: number } | null>(null);
  const [activeValue, setActiveValue] = React.useState<string | undefined>();
  const dialogOpen = React.useContext(CommandDialogOpenContext);
  // 打开时的初始高亮只消费一次，之后的筛选仍落回首个匹配项。
  const pendingInitialValue = React.useRef<string | undefined>(undefined);

  React.useLayoutEffect(() => {
    if (!dialogOpen) return;
    pendingInitialValue.current = initialValue;
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        '[cmdk-item][data-value]:not([hidden]):not([aria-disabled="true"])',
      ) ?? [],
    );
    const preferred = items.find((item) => item.dataset.value === initialValue);
    setActiveValue((preferred ?? items[0])?.dataset.value);
    if (!preferred) return;
    // 打开时把初始项滚到列表中间，而不是只贴在可视区边缘。
    const frame = requestAnimationFrame(() => preferred.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [dialogOpen]);

  React.useLayoutEffect(() => {
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[cmdk-item][data-value]:not([hidden])') ?? [],
    ).filter((item) => item.getAttribute('aria-disabled') !== 'true');
    const values = items.map((item) => item.dataset.value ?? '');
    const signature = values.join('\0');
    if (signature !== itemSignature.current) {
      itemSignature.current = signature;
      const initial = pendingInitialValue.current;
      pendingInitialValue.current = undefined;
      setActiveValue(initial || values[0] || undefined);
      return;
    }

    if (activeValue && !values.includes(activeValue)) setActiveValue(values[0] || undefined);
  });

  React.useEffect(() => {
    if (!activeValue) return;
    const frame = requestAnimationFrame(() => {
      const selected = rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      selected.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeValue]);

  const handlePointerMoveCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerMoveCapture?.(event);
    const previous = lastPointerPosition.current;
    const hasMoved =
      event.movementX !== 0 ||
      event.movementY !== 0 ||
      (previous !== null && (event.clientX !== previous.x || event.clientY !== previous.y));
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    if (!hasMoved) return;
    const item =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[cmdk-item][data-value]')
        : null;
    const value = item?.dataset.value;
    if (value && item?.getAttribute('aria-disabled') !== 'true') setActiveValue(value);
  };

  return (
    <CommandResetSelectionContext.Provider
      value={() => {
        requestAnimationFrame(() => {
          const first = rootRef.current?.querySelector<HTMLElement>(
            '[cmdk-item][data-value]:not([hidden]):not([aria-disabled="true"])',
          );
          setActiveValue(first?.dataset.value);
        });
      }}
    >
      <CommandPrimitive
        ref={rootRef}
        data-slot="command"
        className={cn(
          'flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground',
          className,
        )}
        {...props}
        loop
        disablePointerSelection
        value={activeValue}
        onValueChange={(value) => {
          setActiveValue(value);
          onValueChange?.(value);
        }}
        onPointerMoveCapture={handlePointerMoveCapture}
      />
    </CommandResetSelectionContext.Provider>
  );
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  open,
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, 'children'> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  children: React.ReactNode;
}) {
  return (
    <CommandDialogOpenContext.Provider value={open ?? true}>
      <Dialog open={open} {...props}>
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogContent
          className={cn('top-[12vh] translate-y-0 overflow-hidden rounded-xl! p-0', className)}
          showCloseButton={showCloseButton}
        >
          {children}
        </DialogContent>
      </Dialog>
    </CommandDialogOpenContext.Provider>
  );
}

function CommandInput({
  className,
  onValueChange,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  const resetSelection = React.useContext(CommandResetSelectionContext);
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            'w-full select-text text-sm outline-hidden dark:bg-transparent disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          onValueChange={(value) => {
            onValueChange?.(value);
            resetSelection();
          }}
          {...props}
        />
        <InputGroupAddon>
          <MagnifyingGlassIcon className="size-4 shrink-0 opacity-50" weight="duotone" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  listRef,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & {
  listRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive.List
      ref={listRef}
      data-slot="command-list"
      className={cn(
        'no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none',
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm', className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4 data-[selected=true]:*:[svg]:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground group-data-[selected=true]/command-item:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
