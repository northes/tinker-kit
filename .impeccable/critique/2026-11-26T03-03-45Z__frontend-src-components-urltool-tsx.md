---
target_identity: "file:/Users/northes/workspace/tinker-kit/frontend/src/components/UrlTool.tsx"
target_fingerprint: "sha256:2dd6de9fd6fc1b7b83d8f843f68020528c13eb3c84d1f241ff1533f715aa80e9"
target_path: /Users/northes/workspace/tinker-kit/frontend/src/components/UrlTool.tsx
timestamp: 2026-11-26T03-03-45Z
slug: frontend-src-components-urltool-tsx
---
⚠️ DEGRADED: single-context (检查子代理禁止再派子代理；Wails/WKWebView 无 CDP)

# 斑马纹数据行左右留白（def6d99）

## 评审范围

对照 `docs/requirements/2026-11-26-striped-row-spacing.md` 与 `def6d99`（`fix(ui): unify striped row horizontal insets`，11 文件）。表面是 `UrlTool.tsx`、`TimeTool.tsx`、`NetworkTestTool.tsx`、`SettingsPage.tsx`（known hosts 对话框）、`SSHProfileManagerDialog.tsx`、`ServiceManagerTool.tsx`（容器选择对话框）、`image-manager/ImageManagerDetailView.tsx`、`app/ToolOrderList.tsx`、`styles/tools/json.css`。模式 Operate。设计评审先读源码完成，随后才跑检测器。

## 设计健康（启发式 0–4）

本次只评审留白与对齐；与应用状态、错误恢复相关的维度沿用既有行为，未做二次深挖。

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 3 | 行悬停/选中/条纹层级未被本次改动影响 |
| 2 | 符合现实 | 4 | 12px 普通行、8px 紧凑表格，与开发者工作台的密度预期一致 |
| 3 | 用户控制 | 3 | 拖拽排序、显隐、编辑切换都保持原结构 |
| 4 | 一致性 | 3 | 修前网络阶段表头比数据行多 4px；修后表头/正文同列，镜像详情仍有三种缩进 |
| 5 | 错误预防 | 3 | 留白改动不触碰校验与禁用态 |
| 6 | 识别优于回忆 | 3 | 标签列 104/128px 固定，行内标题位置稳定 |
| 7 | 灵活与效率 | 3 | 行泡点密度与改动前一致，虚拟列表占位行零内边距未变 |
| 8 | 简洁 | 3 | 条纹仍是唯一定位线索，没有叠加分割线 |
| 9 | 错误恢复 | 3 | 与本次留白改动无关，沿用现有错误态 |
| 10 | 帮助 | 3 | 未新增帮助文案需求 |
| **总分** | | **31/40** | **良好，无阻断** |

## 设计特异性

**LLM：** 这次改的是行泡的呼吸感，不是视觉身份。条纹 + 12px 内衬 + 紧凑表格 8px 的组合服务于高密度开发者工具，换成消费级应用会显得拥挤，因此选择是贴产品的。风险在于「12px 规则」落地时与各页已有的容器内边距（工具内容 4–8px、对话框 24px、ScrollArea 滚动条预留 8px）叠加后实际缩进在 12/18/20px 之间浮动，这是页面级留白差异，本次未纳入范围。

**确定性扫描：** `impeccable detect --json` 扫上述 8 个 tsx（css 不参与），返回 `[]`，exit 0。无误报可标，也没有检测器另抓到的条目。

**可视化叠层：** 不适用。Wails 用 WKWebView，无 CDP。`agent-desktop screenshot --app TinkerKit` 截到的窗口内容为空白灰面（应用当前没有可用界面），不作为渲染证据。

## 总体印象

12px 的主体改动方向正确：URL 字段行的标题和复制按钮不再贴边，时间/网络/对话框列表读起来更稳。唯一的实际问题出在网络阶段的网格表头上——它被多推了 4px，且随附注释描述了一个并不存在的 4px 内衬。

## 做得好的地方

- 普通行统一加在行容器上，条纹仍然铺满行宽、圆角只在条纹上，符合 DESIGN.md 的测量口径。
- 紧凑表格没有被一起放大：JSON 表只把容器内衬从 10px 收到 8px，单元格 `8px` 密度不变。
- 专用列（拖动手柄、勾选框）保留按控件宽度定的留白，没有为了「统一」把可点区域挤窄。

## 优先问题

### [P1] 网络阶段表头比数据行左右各多 4px（已修）

- **位置：** `frontend/src/components/NetworkTestTool.tsx` 阶段表头与 `stages.map` 行。
- **为什么重要：** 表头与正文共用同一列网格，却整体右移 4px，阶段名、时间轴、时长的列首字符在滚动时明显错位；且注释声称行内容注入 4px `p-1`，实际 `ToolLayoutContent` 是 `px-2`，数据行只是 `px-3`，没有 `p-1`。错误注释会让后续维护者按错误前提再调一次。
- **修法：** 表头 `pl-4 pr-6` → `pl-3 pr-5`（右侧 20px = 行内 12px + ScrollArea 预留的 8px 滚动条宽度），并把注释改成真实口径。

### [P2] 镜像详情三种缩进并存

- **位置：** `frontend/src/components/image-manager/ImageManagerDetailView.tsx` 四个 `<h3>`、`renderDetailRows` 条纹行、`dl.divide-y` 内的 Labels 行。
- **为什么重要：** 条纹行内容 12px，区块标题与 Labels 行仍在 0px，同一区块里标题、条纹行标签、表格首列（8px）三种基线，扫描时眼睛要在三条竖线之间跳。
- **修法：** 给四个 `h3` 和未加水平内边距的标签行补 `px-3`；层表保持 8px 紧凑口径。

### [P3] 时间工具列表上方操作行仍是 4px

- **位置：** `frontend/src/components/TimeTool.tsx` 编辑提示/编辑按钮行 `px-1`。
- **为什么重要：** 结果行右端内容在 12px，编辑按钮右端在 4px，列尾差 8px，切换编辑态时右边缘会「弹」一下。
- **修法：** 操作行改 `px-3`，或按钮侧用 `me-2` 补到与行内衬同线。

### [P3] DESIGN.md 的 8px 口径与 JSON 表实际 16px 并存

- **位置：** `DESIGN.md` Data Rows · Inset 与 `frontend/src/styles/tools/json.css:70-75`。
- **为什么重要：** 容器 `padding-inline: 8px` 与单元格 `padding-inline: 8px` 叠加，首尾列文字实际距卡片边缘 16px；文档只写了 8px，后来者容易以为多出来的是 bug。
- **修法：** 只在文档补一句「紧凑表格的 8px 由容器内衬 + 单元格内衬分担；条纹圆角靠容器内衬留白」。
- **误报提示：** 不是视觉缺陷，条纹圆角确实需要容器内衬，代码不用改。

## 已验证不属于问题（避免下轮重复）

- `SSHProfileManagerDialog` 与 `SettingsPage` known hosts 的 `ScrollArea` 已有 `px-6`：条纹起于 24px、文字在条纹内 12px，与搜索框外框共线，符合「条纹铺满行宽、内容相对条纹内缘对齐」。
- `ServiceManagerTool` 容器选择列表只有 `ScrollArea` 的 8px 滚动条预留，无表头，行内 12px 自洽。
- `ToolOrderList` 拖动手柄列 0px、名称列 12px，属 DESIGN.md 允许的专用列例外。

## 问题（留给主代理裁决）

- 是否要在本轮就把镜像详情与时间工具操作行一起对齐（P2/P3），还是等下一次留白需求统一处理？
