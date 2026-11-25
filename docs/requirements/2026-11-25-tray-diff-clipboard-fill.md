# 托盘识别：当前聚焦差异对比时按设置填入剪贴板

## 背景与目标

用户在**当前激活标签为差异对比**时，通过**托盘右键识别**希望剪贴板内容按设置项「托盘识别后填入」进入左右侧（关闭 / 交替填入 / 总是左边 / 总是右边），而不是按内容类型跳转到 JSON、文本等其它工具。

目标是：在托盘识别已开启且模式非「关闭」时，若工作区当前聚焦标签为差异对比，托盘右键走 diff 填入路径，尊重 `diffClipboardTargetMode`；其余情况保持现有内容匹配逻辑。

## 需求条目

1. 前置条件：用户已开启「托盘识别」（`trayMatchEnabled`），且差异对比在设置中的「托盘识别后填入」不为 `off`。
2. 触发：Go 端托盘右键在识别开启时仍发送 `tray:analyze` 与剪贴板文本；行为变更在前端 `analyzeClipboard`。
3. 当且仅当**当前激活工作区标签**为工具且 `toolId === 'diff'` 时，优先执行差异对比填入，**不**再执行时间/URL/JWT/Base64/JSON/文本的工具匹配与 `openTool` 跳转。
4. 填入规则（与命令面板的交替语义对齐，但状态按 diff 标签实例隔离）：
   - `before`：每次覆盖左侧（原文）。
   - `after`：每次覆盖右侧（修改后）。
   - `alternate`：每个 diff 标签独立维护下一次目标侧；首次为该标签填入时从左侧开始，之后在该标签内左右交替；仅进程内有效，不落盘。
   - `off`：不走本条路径，回退到现有托盘内容匹配（且设置 UI 中 `off` 会将 diff 移出可匹配工具列表，与现有一致）。
5. 剪贴板文本经 `trim` 后为空：不填入、不推进交替计数、不 toast。
6. 非空填入：向当前聚焦的 diff 标签投递 `PendingAction`（`tool: 'diff', action: 'fill', input: 原始剪贴板字符串或 trim 前全文——与现有 fill 一致取用户可见的整段文本；实现上与现有 tray 填入其它工具一致使用 event 传入的 string），并带 `target: 'before' | 'after'`。
7. 填入后：保留现有 diff 侧内「已填入…」短暂提示（`DiffTool` filled）；托盘 toast 文案沿用「已将剪贴板内容填入{{tool}}」且 tool 为差异对比。
8. 填入**不切换**当前激活标签（本来就是 diff）。
9. 若当前激活不是 diff，或模式为 `off`，或托盘识别关闭：逻辑与改前完全一致。
10. 实现建议：将「解析 diff 托盘填入目标侧」抽成可单测纯函数（输入：mode、tabId、当前 alternate 映射；输出：本次 target 与更新后的映射），`App.tsx` 的 `analyzeClipboard` 与命令面板 `run` 中的 alternate 可共用或并行维护一致语义（命令面板继续用现有 `nextDiffTarget` 全局 ref 仅服务 palette 即可，托盘 diff 用 per-tab 状态）。
11. 中英文 locale：若新增用户可见文案则同步；本需求预期可不新增 key。

## 已定决策

- 用户确认（m00075 一轮）：当前激活为 diff 且模式非关闭时，托盘右键整段覆盖进 diff，不跳转其它工具；alternate 按标签会话内先左后右；空白剪贴板无操作无提示；关闭或非 diff 时保持原匹配。
- 与 `docs/requirements/2026-11-24-diff-tab-compare-content.md` 一致：托盘/全局命令面板不在该需求的「非目标」扩展范围内，但本条明确**只**改托盘 analyze 在「聚焦 diff」时的分支。
- `diff` 在设置里「关闭」托盘匹配时，不会出现在 `trayMatchTools`，不影响本条；用户选 alternate/before/after 时 diff 仍在可匹配列表中。

## 非目标

- 修改托盘右键菜单结构或 Go 端 `main.go` 右键分支（除非前端无法实现，默认不改 Go）。
- 命令面板 diff 填入行为变更。
- 持久化 alternate 状态到 Config。
- 多 diff 标签时让用户选择目标（始终为当前聚焦 diff）。

## 验收标准

1. 激活 diff、托盘识别开、`diffClipboardTargetMode` 为 `alternate`：连续两次非空剪贴板托盘右键 → 左、右各填入一次，第三次 → 左；切换激活到另一 diff 标签后，该标签 alternate 从左侧重新开始。
2. 模式为 `before` / `after`：托盘右键始终只填对应侧。
3. 模式为 `off` 或当前激活非 diff：行为与改动前一致（例如 JSON 剪贴板仍打开 JSON）。
4. 空白剪贴板：无填入、无 alternate 推进、无成功 toast。
5. 填入后出现 diff 既有 filled 提示与托盘 toast。
6. `wails3 task test:diff-compare-source` 或新增 `test:tray-diff-fill`（若有纯函数单测）通过；`wails3 task common:frontend:run SCRIPT=build` 通过。

## 待定问题

- 无。

## 变更记录

- 2026-11-25：初稿，对齐用户确认的托盘 diff 填入规则。
