# 滚动条

仅在新增或修改滚动容器（`ScrollArea`、`ToolLayoutScrollableContent`、浮层滚动层等）时使用。本项目滚动条由 `overlayscrollbars` 接管，统一封装在 `frontend/src/components/ui/scroll-area.tsx` 的 `ScrollArea`，不再使用自绘 fixed overlay。

## 规则

- `ScrollArea` 基于 `overlayscrollbars` 与 `overlayscrollbars-react`，默认 `scrollbars.autoHide: 'leave'`（指针移入显示、移出隐藏）。调用处不要重复配置滚动条行为。
- 滚动职责交给 `ScrollArea`：宿主元素不要保留 `overflow-*`；原本 `overflow-x: hidden` 的容器要传 `options={{ overflow: { x: 'hidden' } }}`，否则 OverlayScrollbars 默认允许横向滚动。
- `ScrollArea` 会在宿主内创建 viewport，子元素不再直接挂在宿主下。容器若依赖 `flex`/`grid` 布局子项，必须在内层保留一层同职责的 wrapper，不要把 `flex`/`grid` 留在宿主上。
- 命中区与滑块视觉统一由 `frontend/src/styles/foundation.css` 的 `.os-scrollbar` 变量控制；调整外观改这些变量，不要为单个容器新增局部覆盖。
- 不要在全局隐藏原生滚动条。CodeMirror 的 `.cm-scroller` 保持原生滚动条；Base UI 浮层（Select/Dropdown/ContextMenu/Combobox）与命令面板（cmdk）内部滚动用 `.no-scrollbar` 隐藏滚动条，只保留滚动能力。
- 虚拟化列表（`@tanstack/react-virtual`）也要用 `ScrollArea`：用 `onViewport` 拿到 OverlayScrollbars 的 viewport 元素，让 `getScrollElement` 指向它（`instance.elements().viewport`），不要把宿主当滚动元素，也不要用原生 `ref` 直连宿主。
- `workspace`（App 主内容区）保留原生滚动条：它是按标签 id 常驻的 `.tool-slot` 的高度和定位参照。不要改成 `ScrollArea`。工具侧栏已经不存在，不要再为它保留滚动容器。
- 溢出提示用 `ScrollArea` 的两个现成能力，不要自绘渐变：
  - `scrollFade="x" | "y"`：用 mask 在滚动方向边缘渐隐内容。没有吸顶表头时用它（工作区标签条横向 20px、纵向 16px，其余默认 24px）。滚到头的一侧遮罩收到 0。
  - `edgeOverlay`：在纵向两端叠加渐变，不使用 mask，避免淡掉吸顶表头和斑马纹。吸顶表头在滚动区内时用 `edgeOverlayTopClass` 把顶部渐变让到表头之下（表头高 40px 时为 `top-10`）。底色跟所在表面走，卡片或弹窗上不要沿用页面 `background`。

## 列表加载与空态

- 远程工具的加载、已取消和空态复用 `shared.tsx` 的 `ToolLoadingState`、`ToolCanceledState` 和 `ToolEmptyState`，取消回调沿用工具已有的请求生命周期。
- 无数据时需要居中的状态块，应与列表的 `ScrollArea` 在同一层条件渲染，直接占满工具栏下方的剩余内容区域；有数据时再渲染滚动表格。
- 不要把状态块追加在 `ScrollArea` 内的表格后面。viewport 内的普通文档流不会给它剩余高度，`flex-1` 或增加上下 padding 都不能实现整个内容区域的垂直居中。
- 必须保留滚动容器内的状态块时，先建立明确占满 viewport 的内层 flex/grid 高度链，再让状态块占据剩余空间；不要用固定高度、绝对定位或局部选择器补偿。

## 静态检查

- 宿主是否残留 `overflow-*`，是否需要 `overflow.x: 'hidden'`。
- 是否遗漏内层 wrapper，导致 flex/grid 子项布局丢失。
- 无数据的加载、已取消和空态是否真正占满剩余内容高度，而不是跟在表格后面靠 padding 撑开；状态切换后滚动表格是否仍拿到正确的 viewport。
- 虚拟化列表是否通过 `onViewport` 把 `getScrollElement` 指向 viewport，而不是宿主或原生 ref。
- 浮层与命令面板内部滚动是否用 `.no-scrollbar` 隐藏滚动条。
- 是否误在全局隐藏原生滚动条，导致未接管区域没有滚动条。
- 主题调整是否只落在 `.os-scrollbar` 变量层。
