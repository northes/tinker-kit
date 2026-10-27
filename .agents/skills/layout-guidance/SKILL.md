---
name: layout-guidance
description: 仅在改工具页布局/高度链、CodeMirror 尺寸与交互、浮层与 footer 对齐、列表勾选与批量操作、列表拖动排序、弹窗表单提交等 UI 细节或 `ScrollArea` 滚动容器时使用。纯颜色或文案修改不要使用本 skill。
user-invocable: false
---

# 布局指导

布局优先保证数据流、尺寸链、滚动责任和状态保留，再处理视觉细节。工具页面必须遵循现有 `ToolLayout` 与 `Reveal` 结构，不创建平行布局系统。本项目滚动条统一使用 OverlayScrollbars 的 `ScrollArea`，仅在修改滚动容器时读取 [overlay-scrollbar.md](./overlay-scrollbar.md)。

## 按变更读取

只读取直接命中的参考，不默认加载全部文件：

- CodeMirror、编辑器快捷键、空态定位或可调整分栏：[editor.md](./editor.md)。
- 设置页层级、Select、来源管理、复制反馈、删除确认或弹窗表单：[forms-and-controls.md](./forms-and-controls.md)。
- 虚拟列表、搜索、排序、右键和拖选批量操作：[lists.md](./lists.md)。
- 列表拖动排序、被拖项视觉、手柄与键盘调序、顺序持久化：[drag-and-drop.md](./drag-and-drop.md)。
- 浮层定位、命令面板结构或 WebView 旋转图标诊断：[overlays-and-motion.md](./overlays-and-motion.md)。
- `ScrollArea` 或其他滚动容器：[overlay-scrollbar.md](./overlay-scrollbar.md)。

## 工具页布局

- 所有工具页使用 `shared.tsx` 的 `ToolLayout`，不要在工具组件中自行创建 `.tool-page` 外壳。
- 工具页头部只保留工具标题，不显示副标题；操作提示应放在对应内容附近，避免重复标题或说明。
- `ToolLayout` 固定为三行网格：`header auto / content minmax(0,1fr) / footer auto`。
- 工具对应的 `Reveal` 使用 `fill`，`.tool-slot` 占满 workspace 高度；高度链上的每层都设置 `height: 100%` 或 `min-height: 0`。
- content 默认使用自身滚动；CodeMirror 等内部管理滚动的工具使用 `contentMode="fixed"`。
- footer 只由 `ToolLayout` 渲染，`ToolActionBar` 是 footer 内的 `role="toolbar"`，禁止嵌套 `<footer>`。
- 主编辑区使用 `height: 100%`、`min-height: 0` 和 `minmax(0,1fr)`，禁止写死编辑区高度。
- 响应式切换分栏方向时同步调整 grid rows；宽屏左右分栏共用一行，窄屏上下分栏平分可用高度。
- 工具内容直接落在页面背景上，用 1px 分隔线表达层次，不使用带边框、圆角和独立背景的工具卡片。
- 页面切换使用常驻挂载：隐藏工具使用 `position:absolute; inset:0; visibility:hidden; pointer-events:none`，不要用 `display:none` 卸载编辑器。

## footer band 与共享分割线

- 侧栏底部（`.sidebar-footer`，命令面板入口）与工具页 footer 共用同一条水平分割线时，两侧 band 的几何必须一致：底部内边距、分隔线到内容的顶部间距、控件高度三者取同一套值。
- 锚点是 `ToolLayout`：`pb-4` 页面底部内边距 + footer `pt-3` + 30px 控件高度。侧栏 `.sidebar` 的底部内边距、`.sidebar-footer` 的 `pt` 与命令面板按钮高度按同一套值设置，改一侧必须同步另一侧。
- `ToolLayout` 的底部内边距是页面级留白，收紧它会同时影响所有工具页和设置页，不要只按单个页面调整。
- 底部留白只由 `ToolLayout` 的页面 `pb` 决定，不要给 footer 内容加负 margin 或第二层 padding 来“挤出”对齐。

## 静态检查

- 核对直接尺寸链、响应式布局、滚动责任和受影响页面。
- 按所读参考核对对应交互边界；命令验证统一交给 `project-validation`。
- 动态交互需要人工验收时给出具体步骤，区分已验证和待人工验收；遵守 `AGENTS.md` 的自动化限制。
