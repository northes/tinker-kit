---
name: TinkerKit
description: 融入日常开发工作的静默工具集
colors:
  primary-light: "oklch(0.205 0 0)"
  on-primary-light: "oklch(0.985 0 0)"
  primary-dark: "oklch(0.922 0 0)"
  on-primary-dark: "oklch(0.205 0 0)"
  success-green: "oklch(73.29% 0.1941 150.81)"
  light-warning-amber: "oklch(78.19% 0.159 72.33)"
  dark-warning-amber: "oklch(82.03% 0.1392 76.34)"
  light-destructive-red: "oklch(0.577 0.245 27.325)"
  dark-destructive-red: "oklch(0.704 0.191 22.216)"
  light-canvas: "oklch(1 0 0)"
  light-surface: "oklch(1 0 0)"
  light-surface-secondary: "oklch(0.97 0 0)"
  light-foreground: "oklch(0.145 0 0)"
  light-muted-foreground: "oklch(0.556 0 0)"
  light-border: "oklch(0.922 0 0)"
  light-ring: "oklch(0.708 0 0)"
  dark-canvas: "oklch(0.145 0 0)"
  dark-surface: "oklch(0.205 0 0)"
  dark-surface-secondary: "oklch(0.269 0 0)"
  dark-foreground: "oklch(0.985 0 0)"
  dark-muted-foreground: "oklch(0.708 0 0)"
  dark-border: "oklch(1 0 0 / 10%)"
  dark-input: "oklch(1 0 0 / 15%)"
  dark-ring: "oklch(0.556 0 0)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "SF Mono, JetBrains Mono, Menlo, Monaco, monospace"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.04em"
  code:
    fontFamily: "SF Mono, JetBrains Mono, Menlo, Monaco, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  "2xl": "1.125rem"
spacing:
  "1": "4px"
  "2": "6px"
  "3": "8px"
  "4": "12px"
  "5": "16px"
  "6": "20px"
  "7": "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.on-primary-light}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "color-mix(in oklch, {colors.primary-light}, transparent 20%)"
    textColor: "{colors.on-primary-light}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.light-canvas}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.light-surface-secondary}"
    textColor: "{colors.primary-light}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-ghost:
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-destructive:
    backgroundColor: "color-mix(in oklch, {colors.light-destructive-red}, transparent 90%)"
    textColor: "{colors.light-destructive-red}"
    rounded: "{rounded.lg}"
    height: "32px"
  input-field:
    backgroundColor: "{colors.light-canvas}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  tool-action-button:
    backgroundColor: "{colors.light-canvas}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 11px"
    height: "30px"
---

# Design System: TinkerKit

<!-- impeccable:design-schema 2 -->

## Overview

**Creative North Star: "静默工具集（Quiet Toolset）"**

TinkerKit 是一组融入开发者日常工作的工具：快速、好用、克制、优雅。它采用 Operate 模式——一台长期驻留、随取随用的本地调试仪器，而不是营销页面或展示型界面。用户通过侧栏、命令面板、系统托盘和剪贴板在工具之间切换，界面必须让定位工具、输入数据、执行动作、读取结果这一链路尽可能短。

视觉世界冷静、直接、高密度。层级由稳定网格、1px 边界、明度差和克制的焦点建立；不使用卡片堆叠、渐变、玻璃拟态或装饰性动效。shadcn/Base UI 的默认浅色与默认深色是仅有的两个主题，由 `frontend/src/styles/globals.css` 的 `data-theme` 变量定义。所有工具、设置与浮层共享同一套语义 token，品牌表达落在精确的间距、字体和状态色上，而不是装饰。

**Key Characteristics:**

- Operate 优先的紧凑工作台，长期驻留、即取即用。
- 扁平工作面、1px 分隔线、明确的内容作用域，内容直接落在页面上而非卡片里。
- 浅色 / 深色双主题，共用中性 `primary` 焦点与克制的状态色；自定义主题遵循 `<name>-light` / `<name>-dark` 命名。
- 系统 UI 字体承载界面，系统等宽字体承载代码、值和技术标签。
- 统一的自定义滚动条系统（OverlayScrollbars），滚动条只作为定位提示，不争夺注意力。
- 除 Toast 进出场与主题切换揭示外，默认无过渡、无入场动画；状态变化立即发生。

## Colors

色彩以低色度中性背景组织长时间工作。`primary` 在浅色主题为近黑、深色主题为近白，承担焦点、选中和主操作；绿色、琥珀、红色只承担结果状态。完整运行时主题值只由 `frontend/src/styles/globals.css`（`:root[data-theme='default-light' | 'default-dark']`）定义，前置 token 是其提取快照。

### Primary

- **Neutral Focus：** 浅色主题 `--primary` 为近黑 `oklch(0.205 0 0)`、深色主题为近白 `oklch(0.922 0 0)`，用于焦点环、选中、光标与主动作；`--primary-foreground` 提供高对比前景。

### Secondary

- **Success Green（`oklch(73.29% 0.1941 150.81)`）：** 仅用于成功结果、差异新增与有效状态。
- **Warning Amber（浅色 `oklch(78.19% 0.159 72.33)` / 深色 `oklch(82.03% 0.1392 76.34)`）：** 仅用于警告、需要注意但不阻断的状态。
- **Danger Red（浅色 `oklch(0.577 0.245 27.325)` / 深色 `oklch(0.704 0.191 22.216)`）：** 仅用于错误、差异删除和破坏性动作。

### Neutral

- **Canvas / Surface：** 浅色为纯白画布与白色工作面；深色为 `oklch(0.145 0 0)` 画布与 `oklch(0.205 0 0)` 工作面，次级表面为 `oklch(0.269 0 0)`。
- **Foreground / Muted / Border / Input / Ring：** 正文、辅助信息、1px 结构边界、输入边界与焦点环都必须使用当前主题对应 token，不直接写颜色常量。
- **Overlay：** 浮层使用当前主题的实体表面（`--popover`）与 `ring-1 ring-foreground/10`，保持与页面内容的可读分离。

**The Single Theme Authority Rule.** `globals.css` 是完整 OKLCH 主题变量的唯一运行时权威；消费层不得建立另一套色板，不得用硬编码颜色绕过它。

**The Derived Token Ownership Rule.** shadcn/Base UI 与 Tailwind v4 负责 hover、soft colors、二级边框、半径阶梯等派生 token；项目不得用同名变量覆盖，只能消费。

**The One Primary Rule.** 每个动作作用域最多一个 primary，且位于动作序列最右端；状态色只随结果出现，且必须配合文字或图标，不能只靠颜色。

## Typography

界面字体走系统 UI 字体栈（macOS 上即 `-apple-system` 系统字体），不加载仓库字体文件。代码、计量值、分组标签和技术元数据使用系统等宽字体栈（`SF Mono / JetBrains Mono / Menlo / Monaco`）。

**Character:** 界面用系统 UI 字体保持中性、可读、贴近桌面应用；等宽字体只出现在编辑器、路径、时间值和结构化数据上，形成清晰的技术层与界面层分工。

### Hierarchy

- **Title：** 19px、600、1.25 行高，用于工具页与设置页标题（`ToolLayoutHeader`），可带 10px 辅助说明。
- **Body：** 12px、常规字重、1.6 行高，用于导航、设置项与常规信息。
- **Label：** 10px、500、`0.04em` 字距，用于编辑区标签、分组和元信息；必要时大写。
- **Code：** 等宽字体，基准字号由 `--code-editor-font-size` 控制（默认 16px，用户可在设置中调整），行高 1.6。

**The Technical Voice Rule.** 等宽字体只表达代码、值、计量和短标签，不替代界面正文。

## Layout

应用壳为两行网格：38px 原生拖拽标题栏（macOS 27 起系统红绿灯区域更高，切到 `data-titlebar-variant='tall'` 时标题栏升至 52px）加自适应工作区。工作区由侧栏与内容区组成：完整侧栏 `232px`、图标侧栏 `56px`、隐藏 `0`。

工具页和长页面统一使用 `ToolLayout`：`grid-rows-[auto_auto_minmax(0,1fr)_auto]` 的 Header / Toolbar（可选）/ Content / Footer（可选）骨架。固定 `ToolLayoutContent` 不滚动，内部编辑器、表格自行滚动；长页面与设置页使用 `ToolLayoutScrollableContent`（真实滚动层预留 `padding-inline-end: var(--overlay-scrollbar-size)`）。工具页常驻挂载以保留编辑器测量、滚动与撤销状态。

页面内边距为 20px 顶部、28px 水平、16px 底部（`px-7 pt-5 pb-4`）；700px 以下收缩为 18px 水平、14px 顶部。间距节奏为 4、6、8、12、16、20、24px。底部 `ToolActionBar` 右对齐、6px 间距、控件高 30px，窄窗口允许自然换行但不压缩控件。

**The Working Surface Rule.** 工具内容直接落在页面工作面上；除统计组等真实集合外，不用独立圆角卡片包装每一块内容。

**The Resident Mount Rule.** 工具页切换不卸载编辑器；隐藏工具使用 `visibility: hidden` 与绝对定位保留尺寸与状态，而不是 `display: none`。

## Elevation & Depth

系统扁平优先。静态工具面、编辑器、表格和设置分组不使用阴影；深度由背景/表面明度差、1px 边界和遮罩建立。只有脱离文档流的浮层（命令面板、Popover、Select、Dialog、AlertDialog、Toast）使用结构性阴影与 `ring-1`，表面保持实色，不使用 blur 或玻璃效果。

### Shadow Vocabulary

- **None：** 静态工作面使用 `none`。
- **Overlay（`--shadow-md` / `--shadow-lg`）：** 浮层使用 shadcn 派生的紧凑结构阴影配合 `ring-1 ring-foreground/10`，只表达遮挡关系，不作为装饰。
- **Toast（`--shadow-lg`）：** 仅在瞬时通知上使用。

**The Flat-by-Default Rule.** 静态内容必须保持扁平；阴影只证明浮层确实悬浮在当前任务之上。

## Shapes

主题基础圆角为 `0.625rem`（`--radius`）。按钮、输入、侧栏项、浮层统一消费基础圆角（`rounded-lg`）；更小的 `radius-sm`（0.375rem）、`radius-md`（0.5rem）等由 `index.css` 的 `@theme inline` 从基础圆角按比例派生，项目只消费、不另立阶梯。编辑器与差异面板使用细边框加派生圆角；页面结构本身不做大面积圆角裁切。

**The Single Radius Authority Rule.** 圆角只来自 `--radius` 及其派生阶梯，禁止为单个组件引入独立圆角值。

## Components

### Buttons

- **Shape：** 默认高 32px（`h-8`）、圆角 `rounded-lg`、11px 水平内边距、`text-sm`；图标按钮为正方形（`icon-sm` 28px）。
- **Primary：** `bg-primary text-primary-foreground`，hover 为 `bg-primary/80`；每个作用域最多一个，位于动作序列最右端。
- **Outline：** `border-border bg-background`，hover 提升为 `bg-muted`；深色下使用 `border-input bg-input/30`。
- **Secondary：** `bg-secondary text-secondary-foreground`，hover 混入少量 foreground。
- **Ghost：** 无边框，hover 使用 `bg-muted`。
- **Destructive：** `bg-destructive/10 text-destructive`，只用于破坏性动作，并由确认对话框承接二次确认。
- **Tool Action Button：** 工具页底部动作栏使用 30px 高、`px-[11px]`、`text-[11px]` 的紧凑尺寸，`ToolActionBar` 统一右对齐。

### Inputs / Fields

- **Style：** 高 32px（`h-8`）、`rounded-lg`、`border-input`、透明背景（深色下 `bg-input/30`）、10px 水平内边距；文本使用 foreground，placeholder 使用 `text-muted-foreground`。
- **Focus：** `focus-visible:border-ring` 加 3px `ring-ring/50`，不保留 CodeMirror 原生虚线 outline。
- **Disabled：** 保持布局，背景降为 `bg-input/50`、透明度 0.5，并使用不可用光标。

### Navigation

- 侧栏是紧凑索引：12px 文本、17px duotone 图标（`[&_svg]:size-[17px]`）、图标与文字间距 10px、项内 `px-2 py-1.5`、项间 `gap-0.5`（2px）。
- 默认态为 `text-muted-foreground`，hover 使用 `bg-muted`，当前页使用 `bg-primary text-primary-foreground`。
- 标题栏保留 macOS 交通灯空间与拖拽区，显式交互控件标记为不可拖拽。

### Editors and Tool Layout

- CodeMirror 使用主题 surface、border、foreground 与状态 token，字号由 `--code-editor-font-size` 控制。
- `ToolLayout` 是所有工具页与设置页的共享 Header / Toolbar / Content / Footer 骨架；固定 Content 不滚动，`ToolLayoutScrollableContent` 只用于长页面。
- 状态色必须同时配合文字、图标或结构变化，不能只依赖颜色。

### Scrollbars

- 自定义滚动条由 OverlayScrollbars 统一接管，命中区与预留宽度同为 `--overlay-scrollbar-size`（12px），视觉滑块 6px 圆角，颜色取 `muted-foreground` 42%，hover/active 提升到 68%。
- 默认 `autoHide: 'leave'`：指针移入或滚动时出现，移出后隐藏。
- 需要真实滚动元素 ref 的虚拟化列表（`@tanstack/react-virtual`）通过 `ScrollArea` 的 `onViewport` 指向 viewport，而不是宿主。
- 浮层与命令面板内部滚动、CodeMirror 的 `.cm-scroller` 保持原生滚动行为；浮层用 `.no-scrollbar` 隐藏滚动条但保留滚动能力。

### Overlays

- 命令面板、Popover、Select、ContextMenu、Dialog、AlertDialog 使用实体 overlay 表面、1px 边界与结构性阴影；禁止透明玻璃。
- 浮层保留 shadcn/Base UI wrapper 的焦点、键盘和语义行为，项目样式只调整视觉消费层。

## Do's and Don'ts

### Do:

- **Do** 只提供 shadcn 默认浅色和默认深色两个主题，并让所有组件从当前主题语义 token 取色。
- **Do** 用布局、1px 分隔线、明度差和明确作用域组织高密度工具界面。
- **Do** 保持每个操作作用域最多一个 primary，并让清空到主要结果的顺序由左向右推进。
- **Do** 使用系统 UI 字体和系统等宽字体，保持 4–24px 的既有间距节奏。
- **Do** 让滚动条统一走 `ScrollArea`（OverlayScrollbars），并复用 `--overlay-scrollbar-size`，不要另建滚动条样式。
- **Do** 默认关闭过渡和入场动画（Toast 进出场、主题切换揭示除外），并继续尊重 `prefers-reduced-motion`。

### Don't:

- **Don't** 恢复 Graphite、Paper、Pine、Ink 或任何新的命名色板。
- **Don't** 覆盖 shadcn/Base UI 的同名派生 token，尤其是 hover、soft color、二级边框与半径阶梯。
- **Don't** 使用渐变、玻璃拟态、装饰性阴影、营销式大标题或卡片堆叠。
- **Don't** 用硬编码颜色绕过 `globals.css`，也不要把项目语义适配 token 当作独立主题。
- **Don't** 为视觉反馈增加位移、缩放或持续动效；状态应通过即时颜色、边界和内容变化表达。
- **Don't** 在全局隐藏原生滚动条，或为单个容器写局部滚动条覆盖。
