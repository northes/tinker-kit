# 滚动条

仅在新增或修改滚动容器（`ScrollArea`、`ToolLayoutScrollableContent`、浮层滚动层等）时使用。本项目滚动条由 `overlayscrollbars` 接管，统一封装在 `frontend/src/components/ui/scroll-area.tsx` 的 `ScrollArea`，不再使用自绘 fixed overlay。

## 规则

- `ScrollArea` 基于 `overlayscrollbars` 与 `overlayscrollbars-react`，默认 `scrollbars.autoHide: 'leave'`（指针移入显示、移出隐藏）。调用处不要重复配置滚动条行为。
- 滚动职责交给 `ScrollArea`：宿主元素不要保留 `overflow-*`；原本 `overflow-x: hidden` 的容器要传 `options={{ overflow: { x: 'hidden' } }}`，否则 OverlayScrollbars 默认允许横向滚动。
- `ScrollArea` 会在宿主内创建 viewport，子元素不再直接挂在宿主下。容器若依赖 `flex`/`grid` 布局子项，必须在内层保留一层同职责的 wrapper，不要把 `flex`/`grid` 留在宿主上。
- 命中区与滑块视觉统一由 `frontend/src/styles/foundation.css` 的 `.os-scrollbar` 变量控制；调整外观改这些变量，不要为单个容器新增局部覆盖。
- 不要在全局隐藏原生滚动条。CodeMirror 的 `.cm-scroller` 保持原生滚动条；Base UI 浮层（Select/Dropdown/ContextMenu/Combobox）与命令面板（cmdk）内部滚动用 `.no-scrollbar` 隐藏滚动条，只保留滚动能力。
- 虚拟化列表（`@tanstack/react-virtual`）也要用 `ScrollArea`：用 `onViewport` 拿到 OverlayScrollbars 的 viewport 元素，让 `getScrollElement` 指向它（`instance.elements().viewport`），不要把宿主当滚动元素，也不要用原生 `ref` 直连宿主。
- `workspace`（App 主内容区）和 `sidebar` 保留原生滚动条：前者是 `.tool-slot` 常驻挂载的高度/定位参照并承载切页滚动复位，后者是 `flex-col` + `sticky` 结构。不要改成 `ScrollArea`，除非一并重构这些耦合。

## 静态检查

- 宿主是否残留 `overflow-*`，是否需要 `overflow.x: 'hidden'`。
- 是否遗漏内层 wrapper，导致 flex/grid 子项布局丢失。
- 虚拟化列表是否通过 `onViewport` 把 `getScrollElement` 指向 viewport，而不是宿主或原生 ref。
- 浮层与命令面板内部滚动是否用 `.no-scrollbar` 隐藏滚动条。
- 是否误在全局隐藏原生滚动条，导致未接管区域没有滚动条。
- 主题调整是否只落在 `.os-scrollbar` 变量层。
