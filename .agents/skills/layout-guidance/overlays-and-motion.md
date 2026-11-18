# 浮层与动画

## 动画与浮层

- `translateY(+12px)` 的入场动画会造成底部瞬时溢出和滚动条闪烁；使用 `.tool-slot` 的 `overflow: hidden` 裁切，或改为向上移动。
- 浮层滚动分为外壳和真实滚动层：外壳负责背景、边框、圆角和 `overflow: hidden`，内部负责尺寸收缩、`overflow: auto`、滚动条和内容。
- `scrollbar-gutter` 只作用于真实滚动层；外壳和内部滚动层需要时都显式使用 `scrollbar-gutter: auto !important`。
- Popover/Select 会 Portal 到 `body`，局部父级选择器不能可靠定位；通过组件 `className` 或实际 `data-state`/`data-side` 定位。
- 浮层背景统一使用 `bg-popover`；搜索框需要覆盖组件默认暗色输入背景时显式使用 `dark:bg-transparent`。
- `AlertDialogHeader` 是 `grid place-items-center`，子项会收缩为内容宽度；描述里的块级预览要占满整行时给描述容器加 `w-full`，块级内容放进 `render={<div />}` 的描述里，避免块级元素嵌套在 `<p>` 中。
- 剪贴板或长文本预览用固定高度 + 自动换行 + 垂直滚动（如 `h-24 whitespace-pre-wrap break-all overflow-y-auto`），不要按字符截断成不可滚动，也不要只靠 `max-h` 裁切。
- 圆角统一使用 shadcn 的 `--radius` 和既有组件圆角，不新增全局圆角覆盖层。

### 命令面板

- `CommandDialog` 内按 `Command` → `CommandInput` + `CommandList` → `CommandEmpty` + `CommandGroup` → `CommandItem` 组织；每个 `CommandItem` 都必须放在 `CommandGroup` 中。`CommandGroup` 提供列表内边距，避免选中高亮贴住列表边缘。
- 键盘上下移动、首尾循环、鼠标移动高亮、列表变化后选中第一项及将高亮项滚入视口，统一由 `frontend/src/components/ui/command.tsx` 的共享 `Command` 实现。各面板不要单独维护高亮状态、指针移动处理或重复设置这些行为属性。

### WebView 小尺寸旋转图标

- Wails WebView 中，小尺寸 SVG 即使是正方形且 `transform-origin` 正确，落在半物理像素位置时仍可能因逐帧栅格化出现约 1px 的视觉跳动，看起来像旋转中心偏移。先检查静态外框坐标乘以 `devicePixelRatio` 是否为整数，再判断是否属于此问题。
- 不要仅凭旋转后的 `getBoundingClientRect()` 或 `getScreenCTM()` 判断中心漂移：旋转会改变轴对齐包围盒，变换矩阵也会反映正在执行的动画。用未旋转的固定尺寸外层记录布局位置，并以原生 WebView 的连续截图或像素重心对比验证实际绘制结果。
- 只有确认是设备像素对齐问题后，才在具体调用处增加固定尺寸、非旋转的外层，并在 `useLayoutEffect` 中按 `round(position * dpr) / dpr - position` 平移承载原 Spinner 的内层。窗口缩放、滚动、分栏拖动可能只改变位置而不改变图标尺寸，因此通过 `ResizeObserver`、`resize` 和捕获阶段 `scroll` 重新对齐。
- 保留共享 `Spinner` 的官方实现和动画；不要用 `transform-box`、额外 `transform-origin`、文字基线调整或写死 `0.25px` 掩盖问题。修复后在目标 WebView 连续采样，确认中心波动消失，并移除诊断代码。

## 会话切换

- 工作区标签切换、页面切换不要用 `document.startViewTransition`。它先把整页截成快照再播动画，而主题切换留在 `globals.css` 的 `::view-transition-old(root)` 遮罩会顺带盖住这张快照约 750ms：标签高亮比点击晚一大截才动，后续点击也落在快照上，连续点标签会像卡住。
- 切换直接改状态，用真实 DOM 的短过渡表达变化：`.tool-slot-fade` 过渡 `opacity`，`.tool-slot` 在过渡结束后才切 `visibility`。不要把 `opacity` 加在 `.tool-slot` 上：祖先 `opacity` 不是 1 时 WebKit 会整段丢掉子孙 `backdrop-filter`，模糊会先消失再在过渡结束时出现。带 `backdrop-filter` 的浮层（远程文本编辑器）要 portal 到 `.tool-slot-overlay`，切走时这一层立即 `visibility: hidden`，不要跟着淡出，模糊层自身也不要做 `opacity` 动画。标签过渡 `background-color`、`color` 和 `opacity`，新建标签用 `@starting-style` 入场。过渡时长与曲线走 `--motion-duration` / `--motion-ease`，`prefers-reduced-motion` 下不播。
- 关闭标签不要为了播完离场动画而延迟卸载或排队下一次点击。先保证当次点击立即生效，再谈动画。
