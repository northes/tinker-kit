import { useMemo, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from 'react';
import type { EventListeners, PartialOptions } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';

import { cn } from '@/lib/utils';

const defaultOptions: PartialOptions = {
  scrollbars: {
    autoHide: 'leave',
    autoHideDelay: 400,
    autoHideSuspend: false,
  },
};

export type ScrollAreaProps<T extends ElementType = 'div'> = Omit<
  ComponentPropsWithoutRef<T>,
  'children'
> & {
  children?: ReactNode;
  element?: T;
  options?: PartialOptions;
  /** 真实的滚动元素（OverlayScrollbars viewport）。虚拟化列表等需要依赖它获取滚动状态。 */
  onViewport?: (viewport: HTMLElement | null) => void;
};

export function ScrollArea<T extends ElementType = 'div'>({
  element,
  className,
  options,
  onViewport,
  children,
  ...props
}: ScrollAreaProps<T>) {
  const events = useMemo<EventListeners | undefined>(
    () =>
      onViewport
        ? {
            initialized: (instance) => onViewport(instance.elements().viewport),
            destroyed: () => onViewport(null),
          }
        : undefined,
    [onViewport],
  );

  return (
    <OverlayScrollbarsComponent
      element={(element ?? 'div') as ElementType}
      className={cn('relative', className)}
      options={{
        ...defaultOptions,
        ...options,
        scrollbars: { ...defaultOptions.scrollbars, ...options?.scrollbars },
      }}
      events={events}
      defer
      {...(props as ComponentPropsWithoutRef<'div'>)}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
}
