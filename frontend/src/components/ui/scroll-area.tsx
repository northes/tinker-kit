import {
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
} from 'react';
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
  /** 在可滚动方向的边缘渐隐内容，作为还能继续滚动的提示。 */
  scrollFade?: 'x' | 'y';
  /** 真实的滚动元素（OverlayScrollbars viewport）。虚拟化列表等需要依赖它获取滚动状态。 */
  onViewport?: (viewport: HTMLElement | null) => void;
};

export function ScrollArea<T extends ElementType = 'div'>({
  element,
  className,
  options,
  scrollFade,
  onViewport,
  children,
  ...props
}: ScrollAreaProps<T>) {
  const syncRef = useRef<(() => void) | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const events = useMemo<EventListeners | undefined>(() => {
    if (!onViewport && !scrollFade) return undefined;
    return {
      initialized: (instance) => {
        const { target, viewport, content } = instance.elements();
        onViewport?.(viewport);
        if (!scrollFade) return;
        const sync = () => {
          if (scrollFade === 'x') {
            target.style.setProperty('--scroll-area-overflow-x-start', `${viewport.scrollLeft}px`);
            target.style.setProperty(
              '--scroll-area-overflow-x-end',
              `${viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft}px`,
            );
          } else {
            target.style.setProperty('--scroll-area-overflow-y-start', `${viewport.scrollTop}px`);
            target.style.setProperty(
              '--scroll-area-overflow-y-end',
              `${viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop}px`,
            );
          }
        };
        const observer = new ResizeObserver(sync);
        observer.observe(viewport);
        observer.observe(content);
        viewport.addEventListener('scroll', sync, { passive: true });
        syncRef.current = sync;
        cleanupRef.current = () => {
          viewport.removeEventListener('scroll', sync);
          observer.disconnect();
          syncRef.current = null;
          cleanupRef.current = null;
        };
        sync();
      },
      destroyed: () => {
        onViewport?.(null);
        cleanupRef.current?.();
      },
    };
  }, [onViewport, scrollFade]);
  useEffect(() => {
    syncRef.current?.();
  });

  return (
    <OverlayScrollbarsComponent
      element={(element ?? 'div') as ElementType}
      className={cn(
        'relative',
        scrollFade === 'x' && 'scroll-fade-x',
        scrollFade === 'y' && 'scroll-fade-y',
        className,
      )}
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
