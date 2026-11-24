---
target: JSON 工具显示设置与表格键值列展平
total_score: 35
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/private/tmp/json-kv-flatten-check/frontend/src/components/JsonTool.tsx"
target_fingerprint: "sha256:8c2c06b-json-kv-flatten"
target_path: frontend/src/components/JsonTool.tsx
timestamp: 2026-11-24T07-30-00Z
slug: frontend-src-components-jsontool-tsx
---
⚠️ DEGRADED: single-context（检查子代理无隔离子代理；非双盲）

# JSON 工具显示设置与表格键值列展平

## 评审范围

基点 `6f96b89` 合入的 `jsonFlattenKeyValueColumns`：显示设置对话框新开关、`json-table-pivot.ts` 纯函数展平、`JsonTablePreview` / 流水线小预览接线。模式 **Operate**。设计评审在先、机械检测在后。

## 设计健康（启发式 0–4）

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 4 | 开关持久化；表格即时反映展平/嵌套 |
| 2 | 符合现实 | 4 | 键值数组摊列符合调试表格心智 |
| 3 | 用户控制 | 4 | 默认开、可关、重启保留 |
| 4 | 一致性 | 3 | 与同对话框其它项布局一致；标签 key 走项目混淆命名 |
| 5 | 错误预防 | 4 | 不符合结构时不展平，退回嵌套列 |
| 6 | 识别优于回忆 | 3 | 说明一行提示作用域；规则仍偏专业 |
| 7 | 灵活与效率 | 4 | 少点一层展开即可读考勤类 JSON |
| 8 | 简洁 | 4 | 无新样式文件；复用 Checkbox + 说明 |
| 9 | 错误恢复 | 4 | 关开关即恢复旧表 |
| 10 | 帮助 | 3 | hint 说明「仅表格预览」 |
| **总分** | | **35/40** | **良好** |

## 设计特异性

行为收在 JSON 表格预览，不碰根竖表与原始 JSON；与 TinkerKit 静默工具密度一致。宽表列增多时的横向滚动沿用既有 `ScrollArea`，无新交互模式。

## 机械证据（audit）

`impeccable detect --json` 扫描 `JsonTool.tsx`、`JsonTablePreview.tsx`、`json-table-pivot.ts`：**0 条**。

维度粗评：a11y 3（开关 Label+Checkbox 与同对话框一致；Dialog `aria-describedby={undefined}` 为既有模式）、perf 3（`useMemo` 列计划；大表边界未测）、theming 4、responsive 3（宽表依赖横滚）、implementation 4。

## 截图

已调用 `agent-desktop screenshot`，返回大图路径（会话 snapshot `s24s9du0zsy4c9`）；未确认窗口内是否为 JSON 显示设置，**不当作 UI 验收依据**。Wails 无 CDP，未做对话框内定点截图。

## 优先问题

- **[P0]** 无。
- **[P1]** 无。
- **[P2→已排除]** 复核后用字符码确认：开关标题与说明都在 `jsonTool` 下同一路径，i18n 校验通过；评审时看到的异常命名是显示层脱敏造成的误报，不改代码。
- **[P2]** `json-table-pivot.test.mjs` / `JsonTool.test.mjs` 未挂入 `Taskfile.yml`，`wails3 task` 默认不跑；本次已手工 `node --test` 通过。
- **[P3]** 展平后列数暴增时，仅靠横滚发现新列；无列分组或折叠（非目标）。
- **[P3]** hint 英文较长，窄对话框下换行多，可读但略挤。

## 人物

**Alex：** 考勤 `pageData` 一眼横读；关开关可对比嵌套。  
**Sam：** 复选框可 Tab；说明为静态段落，非 `aria-describedby` 绑定到控件（与同对话框时间格式项一致）。  
**Riley：** 脏数据不展平、前缀冲突回退，不误造列。

## 变更记录

- 2026-11-24：初版快照（合入后检查）。
