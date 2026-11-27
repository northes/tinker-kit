---
target: SourceCombobox 回车选中唯一可见主机
total_score: 36
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:frontend/src/components/SourceCombobox.tsx"
target_fingerprint: "sha256:commit-2ce84f7-source-combobox-enter"
target_path: frontend/src/components/SourceCombobox.tsx
timestamp: 2026-11-27T09-18-31Z
slug: frontend-src-components-sourcecombobox-tsx
---
⚠️ DEGRADED: single-context (spawn_agent unavailable in this session)

# SourceCombobox：过滤后仅一台时回车选中

## 评审范围

提交 `2ce84f7` 在 `frontend/src/components/SourceCombobox.tsx` 的 `ComboboxInput.onKeyDown` 中增加 Enter 分支：浮层打开、`rankedItems.length === 1` 时选中该项并 `closePopup()`；与当前 `value` 相同时只关浮层；`preventDefault` 防外层表单提交；组字中拦截；多台 / 零台时不 `preventBaseUIHandler`，保留 Base UI 高亮确认路径。模式 Operate。纯键盘行为，无视觉变更。先设计评审，再 `impeccable detect --json frontend/src/components/SourceCombobox.tsx`。

## 设计健康

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 4 | 唯一可见项与回车选中一一对应；多于一哈仍靠高亮/关浮层，与旧行为一致 |
| 2 | 符合现实 | 4 | 对齐各工具「目标主机」筛到只剩一台即可回车进入 |
| 3 | 用户控制 | 4 | 不自动高亮第一项；0/多台不抢选；重复值不关业务只关浮层 |
| 4 | 一致性 | 3 | 本提交只覆盖 SourceCombobox；SSHProfileSelect 尚未同步（范围外） |
| 5 | 错误预防 | 4 | `isComposing` / keyCode 229 不触发；`preventDefault` 避免隐式提交表单 |
| 6 | 识别优于回忆 | 3 | 仍无「为何只剩一台」的说明，依赖列表本身 |
| 7 | 灵活与效率 | 4 | 键盘流在单命中时少一次显式点击 |
| 8 | 简洁 | 4 | 无新 UI，逻辑局部 |
| 9 | 错误恢复 | 3 | 无匹配时 Enter 不强行选中 |
| 10 | 帮助 | 3 | 可发现性靠用户经验；无新文案 |
| **总分** | | **36/40** | **良好** |

## 设计特异性（检测器前）

交互在输入框内完成，与现有 Combobox 浮层、管理行 Tab 行为并存。`rankedItems` 与 `filteredItems` 同源（`orderBySourceSearch` + `matchesSource`），「可见一台」与列表展示一致。焦点未离开输入即可完成切换，符合静默工具集。无截图：Wails WKWebView、无视觉 diff。

## 机械证据

`impeccable detect --json frontend/src/components/SourceCombobox.tsx` → `[]`，退出码 0。无 ignore 登记。

## 优先问题

- **[P0]** 无。
- **[P1]** 无。
- **[P2]** SSHProfileSelect 与其它来源下拉若需同一回车语义，须单独跟进（本检查范围仅 SourceCombobox）。
- **[P3]** 单命中与多命中在界面上仍无差异提示；与产品非目标一致。

## P0/P1 修复

无需改码；实现满足需求条目，未发现阻断或误导状态。

## 验证备注

`wails3 task common:frontend:run SCRIPT=build` 因 `SshFilesTool.tsx` 的 `PreviewingImage.viewKey` 类型错误失败（主仓库同样失败），与本次文件无关；`tsc` 无 SourceCombobox 报错。`git diff --check` 通过。
