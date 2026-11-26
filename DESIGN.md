---
name: TinkerKit
description: 静默、紧凑、可靠的本地开发工作台
colors:
  primary-light: "oklch(0.205 0 0)"
  on-primary-light: "oklch(0.985 0 0)"
  primary-dark: "oklch(0.922 0 0)"
  on-primary-dark: "oklch(0.205 0 0)"
  canvas-light: "oklch(1 0 0)"
  foreground-light: "oklch(0.145 0 0)"
  muted-light: "oklch(0.97 0 0)"
  muted-foreground-light: "oklch(0.556 0 0)"
  border-light: "oklch(0.922 0 0)"
  canvas-dark: "oklch(0.145 0 0)"
  surface-dark: "oklch(0.205 0 0)"
  secondary-dark: "oklch(0.269 0 0)"
  foreground-dark: "oklch(0.985 0 0)"
  muted-foreground-dark: "oklch(0.708 0 0)"
  border-dark: "oklch(1 0 0 / 10%)"
  input-dark: "oklch(1 0 0 / 15%)"
  success: "oklch(73.29% 0.1941 150.81)"
  success-foreground-light: "oklch(0.5 0.13 152)"
  success-foreground-dark: "oklch(0.84 0.17 152)"
  warning-light: "oklch(78.19% 0.159 72.33)"
  warning-dark: "oklch(82.03% 0.1392 76.34)"
  warning-foreground-light: "oklch(0.5 0.115 66)"
  warning-foreground-dark: "oklch(0.88 0.14 78)"
  info-light: "oklch(0.52 0.17 256)"
  info-dark: "oklch(0.72 0.14 254)"
  destructive-light: "oklch(0.577 0.245 27.325)"
  destructive-dark: "oklch(0.704 0.191 22.216)"
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
  button-outline:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.muted-light}"
    textColor: "{colors.primary-light}"
    rounded: "{rounded.lg}"
    height: "32px"
  input-field:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  tool-action-button:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.lg}"
    padding: "0 11px"
    height: "30px"
---

# Design System: TinkerKit

## Overview

**Creative North Star: “Quiet Toolset / 静默工具集”**

TinkerKit 是长期驻留的开发者工作台。它的界面专业、紧凑、可靠：让用户快速定位工具、输入数据、执行动作并读取结果，同时把界面本身留在背景。精确的网格、明确的内容层级和稳定的状态反馈建立秩序；品牌感来自一致的细节，而不是装饰。

浅色与深色主题共享同一套语义角色。中性焦点组织操作，状态色只在结果或过程需要被辨认时出现。静态工作区以平面表面、细边界和隔行淡底为主，只有真正脱离页面的浮层才表达悬浮层级。溢出内容用边缘渐隐提示，而不是装饰性渐变。

**Key Characteristics:**
- 面向任务的紧凑桌面工作台，优先保证扫描与操作效率。
- 明度、细边界、隔行淡底和留白建立层级，避免内容卡片化堆叠。
- 系统 UI 字体用于界面，系统等宽字体用于代码、值和技术标签。
- 浅色与深色主题共享语义 token，状态色承担明确且有限的含义。

## Colors

中性黑白构成界面主体；绿、琥珀、蓝、红作为受限的语义信号。运行时完整色值由 `frontend/src/styles/globals.css` 中的主题变量提供，前置 token 是当前实现的提取快照。

### Primary
- **中性焦点（浅色）**：近黑色承担浅色主题的主操作、选中与键盘焦点；前景使用高对比浅色。
- **中性焦点（深色）**：近白色承担深色主题的主操作、选中与键盘焦点；前景使用深色。

### Secondary
- **清晰绿**：成功结果、有效状态和差异新增；浅色底上的文字使用对应深色前景 token。
- **琥珀提示**：需要留意但不阻断的警告状态；文字使用与主题匹配的前景 token。
- **过程蓝**：只表示进行中或排队中的信息状态，不表示成功或失败。
- **错误红**：错误结果、差异删除和破坏性操作。

### Neutral
- **画布与工作面**：浅色主题以白色为底；深色主题以深灰画布和稍亮工作面区分层级。
- **窗底**：`--chrome` 只垫窗口和标题栏。浅色 `oklch(0.94 0 0)`，深色 `oklch(0.22 0 0)`。
- **正文与辅助文字**：使用当前主题的 foreground 与 muted-foreground，保持主要信息清楚、辅助信息退后。
- **结构边界与输入边界**：使用主题 border、input 和 ring token，不在消费组件中另造中性色。

**The Single Theme Authority Rule.** 完整运行时主题值只定义在 `globals.css`；组件消费语义 token，不自行建立色板或用硬编码颜色绕过主题。

**The Status Token Rule.** 状态只使用 success、warning、info、destructive 语义 token，并同时配合文字、图标或结构变化；不能只靠颜色传达结果。

## Typography

**Display Font:** 系统 UI 字体栈（`-apple-system, BlinkMacSystemFont, system-ui, sans-serif`）
**Body Font:** 系统 UI 字体栈（`-apple-system, BlinkMacSystemFont, system-ui, sans-serif`）
**Label/Mono Font:** 系统等宽字体栈（`SF Mono, JetBrains Mono, Menlo, Monaco, monospace`）

**Character:** 界面文字紧凑、中性，贴近桌面工具的阅读习惯。等宽字体为代码与技术数据提供稳定对齐，不用于替代普通界面文案。

### Hierarchy
- **Title**（600，19px，1.25 行高）：工具页与设置页标题。
- **Body**（400，12px，1.6 行高）：导航、设置项和常规说明。
- **Label**（500，10px，1 行高，0.04em 字距）：字段标签、编辑区标签和元信息。
- **Code**（400，16px，1.6 行高）：编辑器内容、代码与结构化值；编辑器字号可由用户设置。

**The Technical Voice Rule.** 等宽字体只表达代码、值、计量和短标签；界面说明使用系统 UI 字体。

## Layout

应用壳是固定桌面网格，不再使用工具侧栏、后退前进或居中标题。标签条只有横向：铺满标题栏并使用窗底色，占原生标题栏高度（通常 38px，macOS 高标题栏 52px），从红绿灯右侧排到更新提示。没有窗口按钮的平台不为红绿灯留白。下面的工作区是一块 xl 圆角面板，左、右、底各 8px 露出窗底，顶边贴住标签条。工具页仍是 Header / Toolbar / Content / Footer 四行骨架，内容区由内部编辑器或列表负责滚动。

工具页内边距通常为顶部 20px、水平 28px、底部 16px；宽度不超过 700px 时收至水平 18px、顶部 14px。常用间距节奏为 4、6、8、12、16、20、24px。空白标签的工具网格放在居中窄列里，列宽不超过 52rem，搜索框不超过 32rem。内容直接使用页面工作面；只有真实集合或确有独立边界的区域才使用容器包裹。

平铺的数据行用隔行淡底区分，不用行间分割线。层级导航和设置分组仍可用 1px 分隔。列表溢出时在边缘渐隐，滚到头的一侧不渐隐；吸顶表头用叠加渐变，避免被遮罩淡掉。

**The Working Surface Rule.** 工具内容落在页面工作面上；避免把每个区域都装进独立圆角卡片。

**The Row Stripe Rule.** 平铺的数据行用隔行淡底和两端小圆角区分，不用行间分割线。层级导航、设置分组和定义列表仍可用 1px 分隔。

**The Edge Fade Rule.** 溢出用边缘渐隐提示还有内容，滚到头则该侧消失。吸顶内容用叠加渐变，不用遮罩把表头淡掉。

## Elevation & Depth

系统扁平优先。静态工作区不使用阴影；通过背景明度差、细边界和内容分组传达层级。命令面板、菜单、Popover、Dialog 和 Toast 等脱离文档流的浮层使用实体表面、细环线和紧凑结构阴影，明确表达遮挡关系。

### Shadow Vocabulary
- **结构浮层**（`--shadow-md` / `--shadow-lg`）：只用于确实悬浮在任务内容之上的浮层和瞬时通知。

**The Flat-by-Default Rule.** 静态内容保持扁平；阴影只用于说明浮层与页面之间的遮挡关系。

**The Shared Motion Rule.** 状态过渡共用 `--motion-duration`（120ms）和 `--motion-ease`（ease-out）。不要为单个控件另设时长或曲线。

## Shapes

基础圆角为 0.625rem，控件消费由基础半径派生的阶梯。边界通常为 1px。唯一的大圆角是这层工作区面板（xl）；面板内部的工具内容仍然落在工作面上，不把每个区域装进圆角卡片。浮层使用实体表面与边界分离背景，输入框则保持透明或主题输入底色。

**The Single Radius Authority Rule.** 圆角来自 `--radius` 及其派生阶梯；组件不得另立独立半径值。

## Components

组件气质克制、紧凑、清晰。交互状态使用主题色、边界和焦点环表达，并保留 Base UI / shadcn 的键盘与语义行为。

### Buttons
- **Shape：** 柔和小圆角（0.625rem），常规控件高 32px。
- **Primary：** 中性主色底与高对比前景；常规按钮水平内边距约 10px。
- **Outline：** 主题边界和工作面底色，hover 转为 muted 表面。
- **Secondary / Ghost：** 次级表面或无底色，hover 以 muted 提示可操作性。
- **Focus：** 使用 ring token 的可见焦点环；禁用态保留布局并降低可用性表现。
- **工具动作：** 工具栏和底部动作栏高 30px、11px 内边距；使用图标加文字。纯图标按钮只用于语义明确且空间受限的入口，例如关闭标签、新建标签和搜索选项。

### Chips
- **Style：** 状态徽标高 20px，使用紧凑文字、胶囊形轮廓和语义化状态变体。
- **State：** 成功、警告、进行中和错误分别使用对应状态 token；必要时同时显示文字说明。

### Inputs / Fields
- **Style：** 32px 高，约 10px 水平内边距，圆角随基础半径；背景透明或采用当前主题的 input 表面。
- **Focus：** ring 与边界颜色共同标记焦点。
- **Error / Disabled：** 错误使用 destructive 语义；禁用态保留布局并减弱表面与文字。

### Navigation
- **Style：** 工作区标签高 28px，12px 系统文字，小圆角（0.5rem），横向内边距 8px。横向标签宽度固定：无图标 128px，打开图标后 148px。图标默认关闭；打开时为 14px，放在名称左侧。名称超出截断，全文放在提示和无障碍名称里。
- **State：** 默认态只用辅助文字色；悬停只把文字提亮到正文色，不加底。当前标签使用工作面色（`--background`）与正文色，不使用主色块。
- **Close：** 关闭按钮浮在标签末端，不占名称宽度；末端用与标签底色相接的短渐变盖住文字。新建标签是固定在可见区末端的图标按钮，不跟着标签滚动。

### Data Rows
- **Style：** 平铺数据行的偶数行使用 muted 的 30% 淡底，行两端小圆角（`rounded-md`；表格行为基础半径减 4px）。这些行之间不画分割线。
- **Inset：** 普通网格/块条纹行在行容器上使用左右各 12px（Tailwind `px-3`），奇偶行相同；条纹仍铺满行宽，内容相对条纹内缘对齐。紧凑 HTML 表格的首尾列外侧各 8px（`ps-2` / `pe-2` 或由 `json.css` / `TableCell` 默认 `p-2` 承担）；勾选列、拖动手柄列等专用列保留按控件宽度定的留白。JSON 预览除 `TableCell` 的 8px 外，`.json-table-layer` 容器还有 `padding-inline: 8px`，因此条纹相对滚动视口内缘约 16px；这是嵌套表格的容器内衬，与紧凑表首尾列 8px 规则并存。
- **State：** 悬停改为 muted 的 50%；选中使用 muted 实底。悬停和选中盖住条纹。
- **Header：** 数据表头是一块不透明淡底横栏（muted 约 45% 混入所在表面），两端同档圆角，不用底部分割线，以便吸顶时盖住滚过的行。
- **Edge：** 列表边缘渐隐默认 24px；标签条横向 20px、纵向 16px。滚到头的一侧收到 0。

### Overlay Surface
- **Style：** 实色 popover 表面、细环线和结构阴影；内容在自身滚动区域内滚动，不使用玻璃效果。

### Dialog 文字层级
- **档位：** 对话框内只用三档字号。标题 16px（`text-base`）；字段标签与行标题 14px（`Label` 默认）；其余全部 12px（`text-xs`）配 20px 行高（`leading-5`）。
- **12px 覆盖：** 描述（`DialogDescription` 默认已是 `text-xs leading-5 text-muted-foreground`）、字段下方提示、校验错误（destructive）、状态行、小节标签、行内元信息、代码与技术值（同时用等宽字体）。
- **禁用：** 对话框内不出现 10px（`text-[10px]`）与 11px（`text-[11px]`）；说明文字不使用 14px，14px 只给字段标签和行标题。
- **层级信号：** 不再靠字号递减表达次要信息，改用颜色（muted）、等宽字体、大写与字距区分。
- **详情：** 逐项角色与例外见 `docs/design/dialog-typography.md`。

## Do's and Don'ts

### Do:
- **Do** 使用主题语义 token 表达表面、文字、边界、焦点与状态。
- **Do** 通过网格、1px 边界、明度差、隔行淡底和内容分组组织高密度工具界面。
- **Do** 在每个操作作用域保留一个主要动作，并让它位于动作序列末端。
- **Do** 将系统 UI 字体用于界面，将系统等宽字体用于代码和技术值。
- **Do** 复用现有圆角、间距和控件尺寸阶梯。
- **Do** 让工具页维持固定内容骨架，由内部滚动容器承载长列表与编辑器。

### Don't:
- **Don't** 在组件中硬编码主题色或创建平行色板。
- **Don't** 用单独颜色作为成功、警告、进行中或错误的唯一提示。
- **Don't** 给静态工作区添加装饰性阴影、装饰渐变、玻璃效果或卡片堆叠。溢出提示用的边缘渐隐除外。
- **Don't** 为单个组件引入新的圆角、阴影或过渡参数。
- **Don't** 用等宽字体排普通界面说明，或用图标替代必要的动作文字。
- **Don't** 在对话框内用 10px、11px 或 14px 排说明文字，也不要为单个对话框单独指定说明文字字号。
