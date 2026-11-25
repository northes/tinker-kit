---
target: 差异对比：从已打开标签填入与空侧选择
total_score: 33
max_score: 40
na_heuristics: "10"
p0_count: 0
p1_count: 0
target_identity: "commit:467c211 diff-tab-compare"
target_path: frontend/src/components/DiffTool.tsx
slug: frontend-src-components-difftool-tsx
timestamp: 2026-11-25T02-15-00Z
---
⚠️ DEGRADED: single-context（检查子代理无隔离子代理；Wails/WKWebView 无 CDP；未启动应用截图）

# 差异对比：标签填入、空侧选择与右键菜单

## 评审范围

对照 `docs/requirements/2026-11-24-diff-tab-compare-content.md` 与实现提交 `467c211`：`DiffTool` 空侧占位与来源选择器、`WorkspaceTabBar` 右键「对比内容」、`App.tsx` 来源汇聚与 `diff-compare-source` 纯函数。模式 **Operate**。设计评审在先；`impeccable detect --json` 扫 `DiffTool.tsx` / `WorkspaceTabBar.tsx` / `RemoteTextEditorDialog.tsx`：**0 条**。

## 设计健康（启发式 0–4）

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 4 | 填入侧 `filled.*` 提示落可见底角；空候选与无搜索匹配分文案 |
| 2 | 符合现实 | 3 | 中英文「open tabs / 已打开的tab」对齐 JSON 占位模式；中文混写 tab |
| 3 | 用户控制 | 4 | 右键不切换激活标签；选择器 CommandDialog 可 Esc 关闭；diff 失活自动关选择器 |
| 4 | 一致性 | 4 | 占位链接样式与 JSON `placeholder` 一致；SSH 不可用时整项禁用 |
| 5 | 错误预防 | 3 | 覆盖不确认（按需求）；空白来源禁用菜单 |
| 6 | 识别优于回忆 | 4 | 空侧显式链到「已打开的tab」；列表保标签栏序并附 SSH 文件名 |
| 7 | 灵活与效率 | 4 | 右键二级直达左/右；与全局命令面板隔离 |
| 8 | 简洁 | 3 | Command 标题重复一行可见文案 |
| 9 | 错误恢复 | 3 | 无候选空状态明确；SSH 关编辑器/关标签清 ref |
| 10 | 帮助 | n/a | 工具内操作，无独立文档 |
| **总分** | | **33/40** | **良好**（#10 n/a） |

## 设计特异性

路径贴合 TinkerKit 工作区标签 + 工具页模型：仅在「当前为 diff」时出现对比菜单；来源仅限 JSON 输入 / 文本 / SSH 编辑器；候选序跟 `workspace.tabs` 而非字母序。空侧占位通过 MergeView portal 定位，避免占位被 `overflow-hidden` 裁掉——与需求背景一致。

## 机械证据

- `impeccable detect --json`：0 findings（上述三文件）。
- 未使用 Playwright / agent-desktop 启动新构建截图；WKWebView 无 CDP overlay。**无截图结论。**

## 需求符合性（摘要）

| 条目 | 结论 |
| --- | --- |
| 激活 diff 时 JSON/文本/SSH 右键菜单 | 符合 |
| 有效文本填入当前 diff 对应侧 + filled 提示 | 符合（`PendingAction` fill + 侧角 2.2s 提示） |
| 无有效来源时菜单禁用 | 符合（`diffSourceIds` + 禁用项） |
| JSON 仅输入区 / 文本全文 / SSH 编辑器含未保存与 tail | 符合 |
| 空侧占位与独立 Command 选择器 | 符合 |
| 纯函数单测 + 构建 + i18n | 验证通过（见 Run Notes） |

## 优先问题

- **[P0]** 无。
- **[P1]** 无（检查阶段已修：`RemoteTextEditorDialog.dom.test.mjs` 缺 `onContentChange` 桩导致 5/5 DOM 测失败——已补空实现并通过）。
- **[P2]** 无有效来源时右键为**单个禁用**「对比内容」，而非「不可展开的二级结构仍占位」；与需求「子菜单仍显示但整体禁用」字面略有差异，但行为上与 SSH 未开编辑器一致。
- **[P2]** `RemoteTextEditorDialog.dom.test.mjs` 未挂入 `Taskfile.yml`，`wails3 task` 默认不跑该套 Esc/补全回归。
- **[P2]** 来源选择器搜索框复用 `palette.searchPlaceholder`，未提供 diff 专用引导文案。
- **[P3]** CommandDialog 内 `pickerTitle` 与可见标题重复渲染（对话框 title + 顶部一行）。
- **[P3]** 中文占位 `已打开的tab` 中英混排；英文为 `open tabs`，可接受但略不统一。

## 人物

**Alex：** 右键来源标签两次即可填左右，无需复制；列表顺序与标签条一致便于扫。**Jordan：** 空侧下划线链接可发现来源；无候选时 `pickSourceEmpty` 可读。**Riley：** SSH 加载失败 `ready: false` 不进候选；关标签 `forgetClosedTabData` 清来源 ref，避免填入幽灵内容。

## 变更记录

- 2026-11-25：检查子代理初版快照（单上下文）。

## 复核结论（2026-11-25，单上下文）

用户确认只处理一项：无可对比来源时，右键「对比内容」保留二级菜单箭头，整项（文字与箭头）置灰，鼠标与键盘都不可展开。上面初版的启发式分数、机械证据与人物段落保持原样不改。

### 已修

- **[P2 → 已修]** 无可对比来源时原为单个禁用「对比内容」，与需求「子菜单仍显示但整体禁用」字面不符。`WorkspaceTabBar` 现在始终渲染 `ContextMenuSub`，对同一个 `ContextMenuSubTrigger` 传 Base UI 的 `disabled={!compareAvailable}`：`MenuSubmenuTrigger` 的 `disabled` 会同时关掉 click、hover 展开、list navigation 与键盘激活（内部 `useMenuItem({ disabled })`），并输出 `data-disabled` / `aria-disabled`，因此不需要手造第二个箭头，也不存在「看着禁用但仍可点」的项。箭头由 `ContextMenuSubTrigger` 自带的 `CaretRightIcon` 渲染，置灰随之生效。
- **[P2 → 已修]** `components/ui/context-menu.tsx` 的 `ContextMenuSubTrigger` 补齐了 `data-disabled:pointer-events-none data-disabled:opacity-50`，与同文件 `ContextMenuItem` / `CheckboxItem` / `RadioItem` 的禁用写法一致。这是唯一consumer 的共享 primitive 修复，避免在 `WorkspaceTabBar` 里为禁用态另写一套局部 class。

### 复核后维持（非缺陷）

- **[误判，撤回]** `RemoteTextEditorDialog.dom.test.mjs` 未挂入 `Taskfile.yml`：`Taskfile.yml` 的 `test:editor-completion`（123 行）已包含该文件，`wails3 task test:editor-completion` 通过 5/5。撤回此条。
- **[P3，不改]** `pickerTitle` 与对话框可见标题重复：`DialogTitle` 承载无障碍名称（sr-only 语义），顶部一行是给明眼用户的可见标题，两者用途不同，删任一侧都会丢掉语义或可发现性。
- **[P3，不改]** 复用 `palette.searchPlaceholder` 与中文占位 `已打开的tab` 的中英混排：与 JSON 输入占位既有写法及需求第 7、11 条一致，属于已对齐的产品语言，不在本次范围内改文案。

### 本轮验证

- `wails3 task common:frontend:run SCRIPT=build` 通过（含 tsc）。
- `wails3 task test:editor-completion` 通过 5/5；`wails3 task test:text-affix` 4/4；`wails3 task test:json-preview` 31/31。
- `git diff --check` 无输出。
- 未使用 Playwright / agent-desktop；禁用态的实际悬停与键盘行为待人工验收（右键 JSON/文本/SSH 标签，来源为空或 SSH 未开编辑器时确认整项灰、箭头在、两者都点不开）。

### 变更记录

- 2026-11-25：追加复核结论；修 P2 禁用结构（保留箭头 + 整项置灰）；撤回 Taskfile 挂载误判，说明另外两条维持原因。
