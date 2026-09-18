import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Spinner } from './ui/spinner';

// ConfirmDialog 是应用内所有删除/危险确认弹窗的唯一实现。调用方负责在确认逻辑
// 完成后关闭（把 open 置为 false），组件只在 busy 时阻止关闭。
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
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent className={cn('min-w-0 max-w-[calc(100vw-2rem)] sm:max-w-md', className)}>
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {hasBody ? (
            <AlertDialogDescription
              render={<div />}
              className={cn(
                'w-full min-w-0 max-w-full text-left whitespace-normal break-words [overflow-wrap:anywhere]',
                descriptionClassName,
              )}
            >
              {children ?? (description != null ? <p className="m-0">{description}</p> : null)}
              {error != null ? (
                <span className="mt-2 block text-xs text-destructive" role="alert">
                  {error}
                </span>
              ) : null}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel ?? t('common.cancel')}</AlertDialogCancel>
          {extraActions}
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
