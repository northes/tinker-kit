---
name: layout-guidance
description: 仅在改工具页布局/高度链、CodeMirror 尺寸、浮层与 footer 对齐等 UI 细节或 OverlayScrollbar 时使用。纯颜色或文案修改不要使用本 skill。
user-invocable: false
---

# 布局指导

布局优先保证数据流、尺寸链、滚动责任和状态保留，再处理视觉细节。工具页面必须遵循现有 `ToolLayout` 与 `Reveal` 结构，不创建平行布局系统。本项目滚动条以本节和 [overlay-scrollbar.md](./overlay-scrollbar.md) 为准，不要改成 `ScrollArea`。

## 工具页布局

- 所有工具页使用 `shared.tsx` 的 `ToolLayout`，不要在工具组件中自行创建 `.tool-page` 外壳。
- `ToolLayout` 固定为三行网格：`header auto / content minmax(0,1fr) / footer auto`。
- 工具对应的 `Reveal` 使用 `fill`，`.tool-slot` 占满 workspace 高度；高度链上的每层都设置 `height: 100%` 或 `min-height: 0`。
- content 默认使用自身滚动；CodeMirror 等内部管理滚动的工具使用 `contentMode="fixed"`。
- footer 只由 `ToolLayout` 渲染，`ToolActionBar` 是 footer 内的 `role="toolbar"`，禁止嵌套 `<footer>`。
- 主编辑区使用 `height: 100%`、`min-height: 0` 和 `minmax(0,1fr)`，禁止写死编辑区高度。
- 响应式切换分栏方向时同步调整 grid rows；宽屏左右分栏共用一行，窄屏上下分栏平分可用高度。
- 工具内容直接落在页面背景上，用 1px 分隔线表达层次，不使用带边框、圆角和独立背景的工具卡片。
- 页面切换使用常驻挂载：隐藏工具使用 `position:absolute; inset:0; visibility:hidden; pointer-events:none`，不要用 `display:none` 卸载编辑器。
- 工具页不要为了分组套用圆角卡片；需要表达层级时使用现有语义 token 和 1px 分隔线，按视觉密度删除多余的标题、编辑区和 footer 边线。

## 编辑器与状态

- CodeMirror 实例不因切页、Schema 开关或工具状态切换而重建；实例保留撤销历史、滚动位置和尺寸状态。
- 文本工具主输入使用 CodeMirror，不额外实现 textarea 历史或撤销拦截。
- 纯 input/textarea 的程序化变更使用共享 `useHistory`；键盘撤销需要处理 `Mod/Ctrl+Z`、重做快捷键和 IME composing 状态。
- pending action 必须先校验所属 `tool`，避免常驻挂载后多个工具抢消费同一操作。
- 切页滚动复位使用 `useLayoutEffect`；workspace 滚动容器增加 `overflow-x: hidden`。
- flex 中的图标按钮必须显式设置相等的 `width`/`min-width` 和 `flex: none`（或 `flex-shrink: 0`），必要时清除横向 padding，避免窄窗口或长输入压扁按钮。
- Wails 标题栏拖拽使用 CSS 的 `--wails-draggable: drag/no-drag` 和 `data-wails-drag`，不要用 JavaScript 监听鼠标模拟拖拽。

## 动画与浮层

- `translateY(+12px)` 的入场动画会造成底部瞬时溢出和滚动条闪烁；使用 `.tool-slot` 的 `overflow: hidden` 裁切，或改为向上移动。
- 浮层滚动分为外壳和真实滚动层：外壳负责背景、边框、圆角和 `overflow: hidden`，内部负责尺寸收缩、`overflow: auto`、滚动条和内容。
- `scrollbar-gutter` 只作用于真实滚动层；外壳和内部滚动层需要时都显式使用 `scrollbar-gutter: auto !important`。
- Popover/Select 会 Portal 到 `body`，局部父级选择器不能可靠定位；通过组件 `className` 或实际 `data-state`/`data-side` 定位。
- 浮层背景统一使用 `bg-popover`；搜索框需要覆盖组件默认暗色输入背景时显式使用 `dark:bg-transparent`。
- 圆角统一使用 shadcn 的 `--radius` 和既有组件圆角，不新增全局圆角覆盖层。

## footer band 与共享分割线

- 侧栏底部（`.sidebar-footer`，命令面板入口）与工具页 footer 共用同一条水平分割线时，两侧 band 的几何必须一致：底部内边距、分隔线到内容的顶部间距、控件高度三者取同一套值。
- 锚点是 `ToolLayout`：`pb-4` 页面底部内边距 + footer `pt-3` + 30px 控件高度。侧栏 `.sidebar` 的底部内边距、`.sidebar-footer` 的 `pt` 与命令面板按钮高度按同一套值设置，改一侧必须同步另一侧。
- `ToolLayout` 的底部内边距是页面级留白，收紧它会同时影响所有工具页和设置页，不要只按单个页面调整。
- 底部留白只由 `ToolLayout` 的页面 `pb` 决定，不要给 footer 内容加负 margin 或第二层 padding 来“挤出”对齐。

## 组件与交互细节

- `DialogFooter` 自带 `border-t`；dialog 主体不要再加 `border-b`，否则相邻两条 1px 边框叠成 2px，分割线看起来比官方粗。
- Base UI `Select`：条目必须包在 `SelectGroup` 内；浮层内边距来自 `SelectGroup` 的 `p-1`，不要给 Popup 另加 padding 覆盖官方样式。
- 保持 `SelectContent` 的 `alignItemWithTrigger` 默认值（原生对齐：选中项与 trigger 对齐）；不要为了“展开在下方”而设为 `false`，也不要在各处混用两种定位。
- 浮层在暗色下“没有阴影”通常是主题 token 问题：`--shadow-*` 明暗同值（10% 黑），在深色背景上不可见；要改的是暗色 token，不要改组件或加局部阴影覆盖。
- 图标统一使用 phosphor 的 `weight="duotone"`（按钮、下拉项等装饰性图标），新增或调整控件时不要遗漏个别图标。
- 表格/列表右键不应改变选中项；右键菜单操作在目标行未被选中时回退到该行，已选中时作用于整个选择集，不要靠右键来建立选中。
- 搜索输入默认回车才触发（本地 `draft` + `onKeyDown` Enter），不要实时过滤，也不要引入防抖或 `useDeferredValue`。
- 多个工具重复的同类字段抽为共享组件（如 SSH 配置字段 `SSHProfileSelect`），由各工具共同使用，不要在工具内各写一套 Select + 管理入口。
- 与下拉框相关的管理入口放进该下拉框（如来源下拉框底部的「管理」项，内部哨兵值触发实际动作），不再额外放独立管理按钮；空列表时也不渲染多余的分隔线。

## 自绘滚动条

仅在修改 `OverlayScrollbar`、`ScrollableContent` 或 `ToolLayoutScrollableContent` 时读取 [overlay-scrollbar.md](./overlay-scrollbar.md)。

## 静态检查

按变更类型分层；跨多个边界时组合对应层级，不扩大到无关工具页：

- **普通布局**：直接尺寸链、响应式切换和受影响页面。
- **滚动容器**：按 [overlay-scrollbar.md](./overlay-scrollbar.md) 检查。
- **浮层**：Portal 挂载位置、实际滚动层，以及 Dialog 内浮层的滚动与定位关系。
- **CodeMirror/常驻工具页**：隐藏页面不卸载、撤销历史和滚动位置保留、尺寸链，以及编辑器自身滚动责任。
