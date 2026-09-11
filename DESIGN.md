---
name: TinkerKit
description: Quiet Instrument 风格的本地开发者操作台
colors:
  primary-light: "oklch(0.205 0 0)"
  on-primary-light: "oklch(0.985 0 0)"
  primary-dark: "oklch(0.922 0 0)"
  on-primary-dark: "oklch(0.205 0 0)"
  success-green: "oklch(73.29% 0.1941 150.81)"
  light-warning-amber: "oklch(78.19% 0.1590 72.33)"
  dark-warning-amber: "oklch(82.03% 0.1392 76.34)"
  light-danger-red: "oklch(65.32% 0.2335 25.74)"
  dark-danger-red: "oklch(59.40% 0.1973 24.63)"
  light-canvas: "oklch(1 0 0)"
  light-surface: "oklch(1 0 0)"
  light-surface-secondary: "oklch(0.97 0 0)"
  light-foreground: "oklch(0.145 0 0)"
  light-muted: "oklch(0.556 0 0)"
  light-border: "oklch(0.922 0 0)"
  dark-canvas: "oklch(0.145 0 0)"
  dark-surface: "oklch(0.205 0 0)"
  dark-surface-secondary: "oklch(0.269 0 0)"
  dark-foreground: "oklch(0.985 0 0)"
  dark-muted: "oklch(0.708 0 0)"
  dark-border: "oklch(1 0 0 / 10%)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, sans-serif"
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
  none: "0"
  control: "0.5rem"
  field: "0.75rem"
spacing:
  "1": "4px"
  "2": "6px"
  "3": "8px"
  "4": "12px"
  "5": "16px"
  "6": "20px"
  "7": "24px"
components:
  action-primary:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.on-primary-light}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "30px"
  action-primary-hover:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary-dark}"
    rounded: "{rounded.control}"
    height: "30px"
---

# Design System: TinkerKit

<!-- impeccable:design-schema 2 -->

## Overview

**Creative North Star: "Quiet Instrument（静默仪器）"**

TinkerKit 采用 Operate 模式：它是一台长期使用的本地调试仪器，不是营销页面。界面让开发者和运维人员快速定位工具、输入数据、执行动作并读取结果，视觉表达服从扫描效率、可预测性和桌面应用习惯。

视觉世界保持冷静、直接和高密度。层级由稳定网格、1px 边界、明度差和克制的中性焦点建立；不使用卡片堆叠、渐变、玻璃拟态或装饰性动效。shadcn/ui 默认浅色与默认深色是仅有的两个主题，Graphite、Paper、Pine、Ink 等旧色板不再属于现行系统。

**Key Characteristics:**

- Operate 优先的紧凑工作台，而非展示型界面。
- 扁平工作面、细分隔线和明确的内容作用域。
- 当前内置浅色 / 深色双主题（对应根节点 `.dark` 与 `data-theme`），共用中性 `primary` 焦点与克制的状态色；未来自定义主题遵循 `<name>-light` / `<name>-dark` 命名。
- 系统 UI 字体承载界面，等宽字体承载代码和技术值。
- 除 Toast 进出场外，默认无过渡、无入场动画；状态变化立即发生。

## Colors

色彩以低色度中性背景组织长时间工作：`primary` 在浅色主题为近黑、深色主题为近白，承担焦点、选中和主操作；绿色、琥珀和红色只承担结果状态。前置 token 是设计工具的提取快照，运行时完整主题值只由 `frontend/src/styles/globals.css`（shadcn `:root` / `.dark` 变量）定义。

### Primary

- **Neutral Focus：** 浅色主题下 `--primary` 为近黑 `oklch(0.205 0 0)`、深色主题下为近白 `oklch(0.922 0 0)`，用于焦点环、光标、选中状态与主动作；`--primary-foreground` 提供高对比前景。

### Secondary

- **Success Green：** 仅用于成功结果、差异新增与有效状态。
- **Warning Amber：** 仅用于警告、数字或需要注意但不阻断的状态；浅色和深色各有对比度适配。
- **Danger Red：** 仅用于错误、差异删除和破坏性动作；浅色和深色各有对比度适配。

### Neutral

- **Light Canvas / Surface：** 浅色模式用纯白画布与白色工作面区分应用壳和编辑内容。
- **Dark Canvas / Surface：** 深色模式用低明度画布、工作面和次级表面形成克制层次。
- **Foreground / Muted / Border：** 正文、辅助信息和 1px 结构边界必须使用当前主题对应角色，不直接写颜色常量。
- **Overlay：** 浮层使用当前主题的实体表面（`--popover` / `--muted`），保持与页面内容的可读分离。

**The Single Theme Authority Rule.** `globals.css` 是完整 OKLCH 主题变量的唯一运行时权威；消费层不得建立另一套色板，不得用硬编码颜色绕过它。

**The Derived Token Ownership Rule.** shadcn/ui 与 Tailwind v4 负责 hover、soft colors、二级边框、滚动条和半径阶梯等派生 token；项目不得用同名变量覆盖它们，只能消费。

**The Semantic Adapter Rule.** 项目自有 `success-soft` / `warning-soft` / `danger-soft` / `accent-soft` 等派生色与 `action-*` 语义只用于对比度适配和既有组件语义，不扩展为第三套主题色。

## Typography

界面字体通过系统 UI 字体栈接入（`--font-sans` 映射为 macOS 系统字体）；不加载仓库中的 Inter 字体文件。代码、计量值、分组标签和技术元数据使用系统等宽字体栈。运行时 token 由 `frontend/src/styles/tokens/primitives.css` 与 `frontend/src/styles/globals.css` 分层提供。

### Hierarchy

- **Title：** 19px、600，用于工具页标题和主要页面标题（`ToolHeader` / `.page-title`）；可带 10px 辅助说明。
- **Body：** 12px、常规字重，用于导航、设置项与常规信息。
- **Label：** 10px、500、轻微字距，用于编辑区标签、分组和元信息；必要时使用大写。
- **Code：** 默认 16px、1.6 行高，用于 CodeMirror、时间值和结构化数据；用户可在 12/14/16/18px 间调整编辑器字号。

**The Technical Voice Rule.** 等宽字体只表达代码、值、计量和短标签，不替代界面正文。

## Layout

应用壳为两行网格：38px 原生拖拽标题栏加剩余工作区。工作区由 188px 侧栏与可收缩内容区组成，图标侧栏宽 52px；页面使用 20px 顶部、28px 水平和 26px 底部的紧凑内边距。工具页和长页面统一使用 Header / Toolbar（可选）/ `minmax(0, 1fr)` Content / Footer（可选）骨架；固定 Content 不提供滚动，编辑器、表格等内部区域自行滚动，设置页使用可滚动 Content。工具页常驻挂载以保留编辑器测量、滚动与撤销状态。应用壳和页面均以 Wails WebView 的桌面工作台为前提，不依赖 workspace 页面滚动。

布局以 4、6、8、12、16、20、24px 的实际间距阶梯组织。双栏编辑器通常使用 12–14px 间距；底部动作栏右对齐、6px 间距、30px 控件高度。700px 以下，页面内边距收缩为 14px/18px/16px，多栏编辑区转为单列或上下等分，动作栏允许从右侧自然换行。

**The Working Surface Rule.** 工具内容直接落在页面工作面上；除统计组等真实集合外，不用独立圆角卡片包装每一块内容。

## Elevation & Depth

系统默认扁平，静态工具面、编辑器、表格和设置分组不使用阴影。深度主要由背景/表面明度、1px 边界和遮罩建立；只有命令面板、弹窗、选择器、Toast 等脱离文档流的浮层使用结构性阴影（`--overlay-shadow`），且表面保持实色，不使用 blur 或玻璃效果。

### Shadow Vocabulary

- **None：** 静态工作面使用 `none`。
- **Overlay：** 浮层使用紧凑的 0 10px 24px / 18% 黑色结构阴影（`--overlay-shadow`）；它只表达遮挡关系，不作为装饰。

**The Flat-by-Default Rule.** 静态内容必须保持扁平；阴影只证明浮层确实悬浮在当前任务之上。

## Shapes

主题基础圆角为 0.625rem（`--radius`），字段圆角沿用 shadcn 派生值。按钮和一般控件消费基础圆角，浮层消费字段圆角；更小的 `radius-sm`、`radius-md` 等比例值由 Tailwind `@theme inline` 从基础圆角派生，项目只消费。编辑器与差异面板使用细边框和小派生圆角，页面结构本身不做大面积圆角裁切。

## Components

### Buttons

- **Shape：** 工具动作高 30px，使用基础控件圆角，图标 14px；窄窗口可换行但不压缩。
- **Primary：** 每个作用域最多一个，使用项目 `primary` 与高对比前景，位于动作序列最右侧。
- **Secondary：** 透明背景加二级边框，hover 时提高边框与文字对比度。
- **Tertiary：** 无边框、低强调，用于清空、取消等 dismissive 动作。
- **Danger：** 只用于不可恢复操作，并由确认对话框承接二次确认。

### Inputs / Fields

- **Style：** 使用当前主题 surface/field 背景、1px 边界和字段或小派生圆角；文本必须使用 foreground，placeholder 使用对比度适配后的 `text-muted`。
- **Focus：** 使用 `focus` 派生的清晰边框或聚焦环，不保留 CodeMirror 原生虚线 outline。
- **Disabled：** 保持布局，透明度降至约 0.5，并显示不可用光标。

### Navigation

- 侧栏是紧凑索引：12px 文本、17px duotone 图标、2px 行间距；hover 使用 shadcn 派生 accent 表面，active 使用项目 `primary` 与 `primary-foreground` 前景。
- 标题栏保留 macOS 交通灯空间和拖拽区；显式交互控件标记为不可拖拽。

### Editors and Tool Layout

- CodeMirror 使用主题 surface、border、foreground 与状态 token；代码字体为系统等宽栈。
- `ToolLayout` 是所有工具和设置页的共享 Header/Toolbar/Content/Footer 骨架；布局通过显式组合组件声明区域，固定 Content 不滚动，`ScrollableContent` 只用于长页面，底部 `ToolActionBar` 必须按动作作用域对齐。
- 状态色必须同时配合文字、图标或结构变化，不能只依赖颜色。

### Overlays

- 命令面板、Popover、Select 和 AlertDialog 使用实体 overlay 表面、边界与结构性阴影；禁止透明玻璃。
- 浮层保留 shadcn/Base UI wrapper 的焦点、键盘和语义行为，项目样式只调整视觉消费层。

## Do's and Don'ts

### Do:

- **Do** 只提供 shadcn 默认浅色和默认深色两个主题，并让所有组件从当前主题语义 token 取色。
- **Do** 用布局、1px 分隔线、明度差和明确作用域组织高密度工具界面。
- **Do** 保持每个操作作用域最多一个 primary，并让清空到主要结果的顺序由左向右推进。
- **Do** 使用系统 UI 字体和系统等宽字体，保持 4–24px 的既有间距节奏。
- **Do** 默认关闭过渡和入场动画（Toast 进出场除外），并继续尊重 `prefers-reduced-motion`。

### Don't:

- **Don't** 恢复 Graphite、Paper、Pine、Ink 或任何新的命名色板。
- **Don't** 覆盖 shadcn 的同名派生 token，尤其是 hover、soft color、二级边框、滚动条与半径阶梯。
- **Don't** 使用渐变、玻璃拟态、装饰性阴影、营销式大标题或卡片堆叠。
- **Don't** 用硬编码颜色绕过 `globals.css`，也不要把项目语义适配 token 当作独立主题。
- **Don't** 为视觉反馈增加位移、缩放或持续动效；状态应通过即时颜色、边界和内容变化表达。
