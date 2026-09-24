import { cn } from '@/lib/utils';
import * as ResizablePrimitive from 'react-resizable-panels';

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  variant = 'line',
  withHandle = true,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  /**
   * 分隔线样式：`line` 为一条线，`handle` 为无分隔线、只保留拖拽手柄。
   */
  variant?: 'line' | 'handle';
  /** 是否显示分隔线中部的拖拽手柄；`variant` 为 `handle` 时始终显示。 */
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      data-variant={variant}
      className={cn(
        'relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90',
        variant === 'handle' && 'bg-transparent',
        className,
      )}
      {...props}
    >
      {(variant === 'handle' || withHandle) && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
