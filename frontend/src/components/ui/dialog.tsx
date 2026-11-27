import * as React from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';

import { ToolSlotDialogContext } from '@/app/tool-slot';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

const ScopedDialogPortalRef = React.createContext<React.RefObject<HTMLDivElement | null> | null>(
  null,
);

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  const scope = React.useContext(ToolSlotDialogContext);
  const portalRef = React.useRef<HTMLDivElement>(null);
  if (!scope) return <DialogPrimitive.Root data-slot="dialog" {...props} />;

  return (
    <ScopedDialogPortalRef.Provider value={portalRef}>
      <DialogPrimitive.Root
        data-slot="dialog"
        {...props}
        modal={false}
        onOpenChange={(open, details) => {
          const target = details.event.target;
          if (details.reason === 'outside-press' || details.reason === 'focus-out') {
            // 只有这个弹窗自己的遮罩能触发外部关闭，点击或聚焦标签栏时保留草稿。
            if (
              !scope.active ||
              details.reason === 'focus-out' ||
              !(target instanceof HTMLElement) ||
              target.parentElement !== portalRef.current ||
              target.dataset.slot !== 'dialog-overlay'
            ) {
              details.cancel();
              return;
            }
          }
          if (details.reason === 'escape-key') {
            // Base UI 在 document 上监听 Esc。只让当前标签最上层的弹窗响应。
            const container = scope.container;
            const openPortals = container?.querySelectorAll(
              ':scope > [data-slot="dialog-portal"]:has(> [data-slot="dialog-content"][data-open])',
            );
            if (
              !scope.active ||
              !container ||
              container.closest('[aria-hidden="true"]') ||
              details.event.defaultPrevented ||
              !(target instanceof Node) ||
              (target !== container.ownerDocument.body &&
                !container.parentElement?.contains(target)) ||
              !openPortals?.length ||
              openPortals[openPortals.length - 1] !== portalRef.current
            ) {
              details.cancel();
              details.allowPropagation();
              return;
            }
          }
          props.onOpenChange?.(open, details);
        }}
      />
    </ScopedDialogPortalRef.Provider>
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  const scope = React.useContext(ToolSlotDialogContext);
  const portalRef = React.useContext(ScopedDialogPortalRef);
  if (!scope) return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;

  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      {...props}
      ref={portalRef}
      container={scope.container}
      inert={!scope.active}
      className={cn(
        'absolute inset-0 z-50 flex flex-col items-center justify-center p-4',
        props.className,
      )}
    />
  );
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, children, ...props }: DialogPrimitive.Backdrop.Props) {
  const scoped = React.useContext(ToolSlotDialogContext) !== null;
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        'inset-0 isolate z-50 cursor-default bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        scoped ? 'pointer-events-auto absolute' : 'fixed',
        className,
      )}
      {...props}
      forceRender={scoped || props.forceRender}
    >
      {/* 背景本身点击即关闭弹窗，只有应用级弹窗的标题栏区域保留窗口拖动。 */}
      {!scoped && (
        <div
          data-wails-drag
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-(--app-titlebar-height) cursor-default [--wails-draggable:drag]"
        />
      )}
      {children}
    </DialogPrimitive.Backdrop>
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  const { t } = useTranslation();
  const scoped = React.useContext(ToolSlotDialogContext) !== null;
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'z-50 grid max-h-[calc(100dvh-2rem)] w-full gap-4 overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          scoped
            ? 'pointer-events-auto relative min-h-0 max-w-full'
            : 'fixed top-1/2 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon aria-hidden="true" />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          {t('common.close')}
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-base leading-none font-medium', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-xs leading-5 text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
