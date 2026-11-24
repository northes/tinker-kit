---
target: 主机与地址输入框聚焦全选
total_score: 37
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/Users/northes/workspace/tinker-kit-selectall-check/frontend/src/lib/select-all-on-focus.ts"
target_fingerprint: "sha256:264835def823eeb03f179d10b15822514c589df36e38217913f1b30deaf25c28"
target_path: /Users/northes/workspace/tinker-kit-selectall-check/frontend/src/lib/select-all-on-focus.ts
timestamp: 2026-11-24T06-50-25Z
slug: frontend-src-lib-select-all-on-focus-ts
---
⚠️ DEGRADED: single-context（检查子代理没有可再派的隔离子代理；不是双盲）

# 主机与地址输入框聚焦全选

## 评审范围

对象是 `e6b3566` 的聚焦全选：共享函数 `frontend/src/lib/select-all-on-focus.ts`，以及 `SourceCombobox`、`SSHProfileSelect`、网络测试目标地址、端口转发 `listenHost` / `targetHost`。模式是 Operate。先读源码和 Base UI 1.7 的 Combobox 输入实现，再跑检测器。没有 WKWebView 的 CDP，也没有截图；布局、颜色和动效只按「这次没有改样式」判断，不假装看过渲染结果。

## 设计健康

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 4 | 全选高亮本身就是「下一键能替换」的反馈，没有另加工具条 |
| 2 | 符合现实 | 4 | 与地址栏一致：第一次聚焦全选，再点才放光标 |
| 3 | 用户控制 | 4 | 再次点击不拦截；Combobox 的 Esc / 失焦恢复仍在 |
| 4 | 一致性 | 4 | 四个入口挂的是同一个函数，没有各写一套选区 |
| 5 | 错误预防 | 3 | 空值和禁用直接返回；误敲会整段替换，这是需求本身，普通输入框靠系统撤销 |
| 6 | 识别优于回忆 | 4 | 不要求记住快捷键，选区看得见 |
| 7 | 灵活与效率 | 4 | 鼠标点入和 Tab 进入都会全选，已经聚焦后仍可局部编辑 |
| 8 | 简洁 | 4 | 不新增按钮、文案或装饰，符合静默工具集 |
| 9 | 错误恢复 | 3 | 来源框失焦丢弃草稿并回到已选项；纯文本框没有额外恢复 |
| 10 | 帮助 | 3 | 没有新说明，选区已经说明行为；产品其它字段也不另写帮助 |
| **总分** | | **37/40** | **优秀** |

## 设计特异性

**人工判断（检测器之前）：** 这次没有新的视觉语言。行为收在主机和地址上，借用用户已经会的地址栏习惯，而不是给所有输入框套同一套。范围和「点一下就能换主机」的目标一致，没有为了好看加控件。

**检测器：** `impeccable detect --json` 扫了四个组件和共享函数，结果是 `[]`，0 条。没有需要 `ignore-value` 的误报。

**渲染：** 未做。macOS 上的 Wails 是 WKWebView，没有 CDP；任务禁止用浏览器自动化当验收。没有用户可见的检测叠加层。

## 总体印象

该全选的字段走了同一条根因路径：聚焦时 `select()`，第一次按下的 `mouseup` 再补一次并 `preventDefault`，用来挡住浏览器把选区收成光标。没有定时器，也没有吞掉异常。视觉上无变化，最大的剩余只是既有的截断样式，不属于这次要修的行为。

## 做得好的地方

- 选区逻辑只在 `select-all-on-focus.ts`。调用方只挂 `onFocus` / `onMouseDown` / `onMouseUp`。
- 已经聚焦时清掉 pending，不 `preventDefault`，光标仍落在点击处。空字符串和 `disabled` 在动选区之前返回。
- Base UI 打开浮层走的是 `mousedown`（`event: 'mousedown-only'`），用户处理函数先执行且不调用 `preventBaseUIHandler`，筛选、Enter、Esc 和失焦恢复不被这条鼠标补救打断。

## 优先问题

- **[P0]** 无。
- **[P1]** 无。
- **[P2]** 无。
- **[P3] 长主机名在来源框里全选后仍可能只看见截断的一段。** 位置：`frontend/src/components/SourceCombobox.tsx:105` 的 `inputClassName="min-w-0 truncate"`，本次提交没改它。全选后直接键入就会替换，不依赖先看全旧值。不改截断，避免动六个工具的工具栏宽度。建议命令：`$impeccable polish`（仅当以后要让长主机在聚焦时滚到可见时）。

## 认知负荷与情绪

主路径是点一下再打字，没有新增选项。去掉的是三击或逐字删除的摩擦。高风险动作（换掉主机）有选区作为预告；Combobox 失焦会回到已选标签。

## 人物

**Alex（熟手）：** Tab 或点一下即可整段替换，再点一下仍能改中间几个字符。Esc 关闭浮层的旧路径还在。没有多余确认。

**Sam（键盘 / 读屏）：** Tab 进入会全选，不依赖鼠标。没有新的无标签控件，焦点环沿用原来的 ring。右键或虚拟点击若不经过「未聚焦的 mousedown」，仍会落到 focus 上的 `select()`。没有把全选做成只有点击才能用的行为。

**Riley（边界）：** 空值和禁用在 `canSelect` 处返回；非主键的 mousedown 会清掉 pending，避免下一次 mouseup 误全选。失焦恢复和禁用时关掉来源浮层都是原逻辑。

## 次要观察

- 新测试 `frontend/src/lib/select-all-on-focus.test.mjs` 没有登记进 `Taskfile.yml`。现有 `wails3 task` 不会跑它。补任务要改任务文件，超出本次可改路径，所以没改。本次用与 `test:shared-logic` 相同的 `node --experimental-strip-types --test` 跑过，5 项通过。
- 代理地址、DNS 地址和 SSH 配置表单里的 host 字段没有全选。需求条目只点名工具栏来源、网络测试目标地址、端口转发的两个主机和 `SSHProfileSelect`。

## 待追问

Questions skipped: 优先问题里没有需要取舍的 P0–P2（仅 1 条不修的既有 P3）。
