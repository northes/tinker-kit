import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { Spinner } from './ui/spinner';

// ConfirmDialog 是应用内所有删除/危险确认弹窗的唯一实现。调用方负责在确认逻辑
// 完成后关闭（把 open 置为 false），组件只在 busy 时阻止关闭。
// 弹窗允许点击背景关闭（等同取消）；正文超出窗口高度时只滚动正文，标题与操作区保持可见。
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = false,
  busy = false,
  error,
  extraActions,
  className,
  descriptionClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
  error?: ReactNode;
  extraActions?: ReactNode;
  className?: string;
  descriptionClassName?: string;
}) {
  const { t } = useTranslation();
  const hasBody = description != null || children != null || error != null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          'flex max-h-[calc(100dvh-2rem)] min-h-0 min-w-0 max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-md',
          className,
        )}
      >
        <DialogHeader className="min-w-0 flex-none">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {hasBody ? (
          <ScrollArea
            className="-m-1 min-h-0 min-w-0 flex-auto overscroll-contain"
            options={{ overflow: { x: 'hidden' } }}
          >
            <DialogDescription
              render={<div />}
              className={cn(
                'w-full min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]',
                descriptionClassName,
              )}
            >
              {children ?? (description != null ? <p className="m-0">{description}</p> : null)}
              {error != null ? (
                <span className="mt-2 block text-xs text-destructive" role="alert">
                  {error}
                </span>
              ) : null}
            </DialogDescription>
          </ScrollArea>
        ) : null}
        <DialogFooter className="flex-none">
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {cancelLabel ?? t('common.cancel')}
          </DialogClose>
          {extraActions}
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
