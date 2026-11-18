import { createContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// 模糊层必须挂到这个节点，不能放进 .tool-slot-fade。
// 祖先 opacity 不是 1 时，backdrop-filter 在 WebKit 里会整段失效，过渡结束才突然回来。
export const ToolSlotOverlayContext = createContext<HTMLElement | null>(null);

// 外层只负责定位、裁切和 visibility；透明度过渡在内层 fade 上。
// overlay 是 fade 的兄弟，切走时由 CSS 立即 visibility:hidden，不跟着淡出。
export function ToolSlot({ className, children }: { className: string; children: ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setOverlay(overlayRef.current);
  }, []);
  return (
    <ToolSlotOverlayContext.Provider value={overlay}>
      <div className={className}>
        <div className="tool-slot-fade h-full min-h-0">{children}</div>
        <div
          ref={overlayRef}
          className="tool-slot-overlay pointer-events-none absolute inset-0 z-20"
        />
      </div>
    </ToolSlotOverlayContext.Provider>
  );
}
