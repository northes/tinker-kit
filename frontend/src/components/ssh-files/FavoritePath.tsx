import { useCallback, useLayoutEffect, useState } from 'react';
import { ScrollArea } from '../ui/scroll-area';

// 收藏菜单默认展示路径尾部；滚轮只控制当前路径，不滚动整个菜单。
export function FavoritePath({ path }: { path: string }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const onViewport = useCallback((element: HTMLElement | null) => setViewport(element), []);

  useLayoutEffect(() => {
    if (!viewport) return;
    let followEnd = true;
    const alignEnd = () => {
      if (followEnd) viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
    };
    const onScroll = () => {
      followEnd = viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft <= 1;
    };
    const onWheel = (event: WheelEvent) => {
      if (viewport.scrollWidth <= viewport.clientWidth || event.ctrlKey) return;
      const delta = event.deltaX || event.deltaY;
      if (!delta) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? parseFloat(getComputedStyle(viewport).lineHeight) || 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? viewport.clientWidth
            : 1;
      event.preventDefault();
      event.stopPropagation();
      followEnd = false;
      viewport.scrollLeft += delta * unit;
    };
    alignEnd();
    const observer = new ResizeObserver(alignEnd);
    observer.observe(viewport);
    const content = viewport.firstElementChild;
    if (content) observer.observe(content);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('wheel', onWheel);
    };
  }, [viewport, path]);

  return (
    <ScrollArea
      className="min-w-0 flex-1"
      onViewport={onViewport}
      scrollFade="x"
      options={{ overflow: { x: 'scroll', y: 'hidden' }, scrollbars: { visibility: 'hidden' } }}
      title={path}
    >
      <span className="block w-max whitespace-nowrap">{path}</span>
    </ScrollArea>
  );
}
