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
  /**
   * 在纵向两端叠加渐变，提示还能继续滚动。
   * 用独立图层而不是 mask，避免把吸顶表头和斑马纹一起淡掉。
   */
  edgeOverlay?: boolean;
  /**
   * 顶部渐变的 top。吸顶表头（h-10）在滚动区内时传 top-10，否则贴顶。
   * 吸顶块比一行表头更高时（例如搜索框加分段标题），改用调用方自己的
   * `--scroll-edge-top-inset` 传整块高度，渐变从块下方开始，不淡掉块本身。
   */
  edgeOverlayTopClass?: string;
  /** 真实的滚动元素（OverlayScrollbars viewport）。虚拟化列表等需要依赖它获取滚动状态。 */
  onViewport?: (viewport: HTMLElement | null) => void;
};

export function ScrollArea<T extends ElementType = 'div'>({
  element,
  className,
  options,
  scrollFade,
  edgeOverlay = false,
  edgeOverlayTopClass = 'top-0',
  onViewport,
  children,
  ...props
}: ScrollAreaProps<T>) {
  const syncRef = useRef<(() => void) | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const overlayTopRef = useRef<HTMLDivElement | null>(null);
  const overlayBottomRef = useRef<HTMLDivElement | null>(null);
  const scrollFadeRef = useRef(scrollFade);
  const edgeOverlayRef = useRef(edgeOverlay);
  const edgeOverlayTopClassRef = useRef(edgeOverlayTopClass);
  const onViewportRef = useRef(onViewport);
  scrollFadeRef.current = scrollFade;
  edgeOverlayRef.current = edgeOverlay;
  edgeOverlayTopClassRef.current = edgeOverlayTopClass;
  onViewportRef.current = onViewport;

  const ensureMetricsRef = useRef<
    (target: HTMLElement, viewport: HTMLElement, content: HTMLElement) => void
  >(() => {});
  const mountEdgeOverlayRef = useRef<(target: HTMLElement, viewport: HTMLElement) => void>(
    () => {},
  );

  ensureMetricsRef.current = (target, viewport, content) => {
    if (!scrollFadeRef.current && !edgeOverlayRef.current) {
      cleanupRef.current?.();
      return;
    }
    if (!syncRef.current) {
      const sync = () => {
        const fade = scrollFadeRef.current;
        if (fade === 'x') {
          target.style.setProperty(
            '--scroll-area-overflow-x-start',
            `${Math.max(0, viewport.scrollLeft)}px`,
          );
          target.style.setProperty(
            '--scroll-area-overflow-x-end',
            `${Math.max(0, viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft)}px`,
          );
        }
        if (fade === 'y' || edgeOverlayRef.current) {
          target.style.setProperty(
            '--scroll-area-overflow-y-start',
            `${Math.max(0, viewport.scrollTop)}px`,
          );
          target.style.setProperty(
            '--scroll-area-overflow-y-end',
            `${Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)}px`,
          );
        }
        if (edgeOverlayRef.current) {
          const origin =
            viewport.offsetParent instanceof HTMLElement ? viewport.offsetParent : target;
          target.style.setProperty(
            '--scroll-edge-viewport-top',
            `${Math.max(0, viewport.offsetTop)}px`,
          );
          target.style.setProperty(
            '--scroll-edge-viewport-left',
            `${Math.max(0, viewport.offsetLeft)}px`,
          );
          target.style.setProperty(
            '--scroll-edge-viewport-right',
            `${Math.max(0, origin.clientWidth - viewport.offsetLeft - viewport.offsetWidth)}px`,
          );
          target.style.setProperty(
            '--scroll-edge-viewport-bottom',
            `${Math.max(0, origin.clientHeight - viewport.offsetTop - viewport.offsetHeight)}px`,
          );
        }
      };
      const observer = new ResizeObserver(sync);
      observer.observe(viewport);
      if (content !== viewport) observer.observe(content);
      viewport.addEventListener('scroll', sync, { passive: true });
      syncRef.current = sync;
      cleanupRef.current = () => {
        viewport.removeEventListener('scroll', sync);
        observer.disconnect();
        syncRef.current = null;
        cleanupRef.current = null;
      };
    }
    syncRef.current?.();
  };

  mountEdgeOverlayRef.current = (target, viewport) => {
    if (!edgeOverlayRef.current) {
      overlayTopRef.current?.remove();
      overlayBottomRef.current?.remove();
      overlayTopRef.current = null;
      overlayBottomRef.current = null;
      return;
    }
    if (!target.contains(viewport)) return;
    let top = overlayTopRef.current;
    let bottom = overlayBottomRef.current;
    if (!top || !top.isConnected || !bottom || !bottom.isConnected) {
      top?.remove();
      bottom?.remove();
      top = document.createElement('div');
      bottom = document.createElement('div');
      top.setAttribute('aria-hidden', 'true');
      bottom.setAttribute('aria-hidden', 'true');
      bottom.className = 'scroll-edge-overlay-bottom';
      // 插在 viewport 与滚动条之间：盖住内容，但不盖住滚动条。
      viewport.after(top, bottom);
      overlayTopRef.current = top;
      overlayBottomRef.current = bottom;
    }
    top.className = cn('scroll-edge-overlay-top', edgeOverlayTopClassRef.current || 'top-0');
  };

  const events = useMemo<EventListeners>(() => {
    return {
      initialized: (instance) => {
        const { target, viewport, content } = instance.elements();
        content.classList.add('p-1');
        targetRef.current = target;
        viewportRef.current = viewport;
        contentRef.current = content;
        onViewportRef.current?.(viewport);
        ensureMetricsRef.current(target, viewport, content);
        mountEdgeOverlayRef.current(target, viewport);
      },
      destroyed: () => {
        onViewportRef.current?.(null);
        cleanupRef.current?.();
        overlayTopRef.current?.remove();
        overlayBottomRef.current?.remove();
        overlayTopRef.current = null;
        overlayBottomRef.current = null;
        targetRef.current = null;
        viewportRef.current = null;
        contentRef.current = null;
      },
    };
  }, []);
  useEffect(() => {
    const target = targetRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!target || !viewport || !content) return;
    ensureMetricsRef.current(target, viewport, content);
    mountEdgeOverlayRef.current(target, viewport);
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
