import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { cn } from '../lib/utils';
import { Spinner } from './ui/spinner';

// 仅供已出现 WebView 旋转抖动的调用点使用；共享 Spinner 保持原图标和动画。
export function PixelAlignedSpinner({ className, ...props }: ComponentProps<typeof Spinner>) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    let frame = 0;
    const align = () => {
      const { left, top } = anchor.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      // 测量不旋转的外框，避免把旋转后的轴对齐包围盒误当作布局位置。
      content.style.left = `${Math.round(left * scale) / scale - left}px`;
      content.style.top = `${Math.round(top * scale) / scale - top}px`;
    };
    const scheduleAlign = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    };
    const observer = new ResizeObserver(scheduleAlign);
    // 祖先尺寸变化可能只改变图标的位置，例如窗口缩放和分栏拖动。
    for (let element: Element | null = anchor; element; element = element.parentElement) {
      observer.observe(element);
    }
    window.addEventListener('resize', scheduleAlign);
    window.addEventListener('scroll', scheduleAlign, true);
    align();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleAlign);
      window.removeEventListener('scroll', scheduleAlign, true);
    };
  }, []);

  return (
    <span ref={anchorRef} className={cn('inline-flex size-4 shrink-0', className)}>
      <span ref={contentRef} className="relative inline-flex size-full">
        <Spinner {...props} className="size-full motion-reduce:animate-none" />
      </span>
    </span>
  );
}
