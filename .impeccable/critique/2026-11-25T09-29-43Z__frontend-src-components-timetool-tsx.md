---
target: 时间工具拆成时间转换、日期计算、真实时间
total_score: 30
max_score: 40
na_heuristics: ""
p0_count: 1
p1_count: 0
target_identity: "file:/Users/northes/.local/share/herdr-agents/worktrees/d94b701a94d91f63/f61331c2-b4d0-4a34-bebc-5a63af6912f6/frontend/src/components/TimeTool.tsx"
target_fingerprint: "sha256:827b5f53f13bb9562dce359b4580128328c86f9bdbedbb867b7b811ccd1dc7da"
target_path: /Users/northes/.local/share/herdr-agents/worktrees/d94b701a94d91f63/f61331c2-b4d0-4a34-bebc-5a63af6912f6/frontend/src/components/TimeTool.tsx
timestamp: 2026-11-25T09-29-43Z
slug: frontend-src-components-timetool-tsx
---
⚠️ DEGRADED: single-context (检查子代理禁止再派子代理；Wails/WKWebView 无 CDP)

# 时间工具拆成三个工具页

## 评审范围

对照 `docs/requirements/2026-11-25-split-time-tool.md` 与 `f1cb8d1`。表面是 `TimeTool.tsx`（时间转换）、`DateCalculatorTool.tsx`、`RealTimeTool.tsx`，以及它们在 `App.tsx` 的挂载。模式 Operate。设计评审在检测器之前完成。`impeccable detect --json` 扫上述三个外壳加上 `DateCalculator.tsx`、`RealTimePanel.tsx`：0 条（exit 0）。

## 设计健康（启发式 0–4）

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 2 | 页内预置、空状态、NTP 状态点仍在；托盘填入和命令动作在 `clearPending` 处抛错，没有成功或失败提示 |
| 2 | 符合现实 | 4 | 三个名字、简介、Clock / CalendarBlank / GlobeHemisphereWest 与需求一致，开发者用语保留在转换结果行 |
| 3 | 用户控制 | 3 | 输入撤销、结果显隐、周起始、时区对话框仍在；失败的填入没有可重试的可见状态 |
| 4 | 一致性 | 3 | 三页都用 `ToolLayout`，不再套 `ToolLayoutTabs`；唯独时间转换把 `clearDelivered` 传进只接受 `clearPending` 的组件 |
| 5 | 错误预防 | 3 | 日期非法、NTP 主机校验、周起始单选未改 |
| 6 | 识别优于回忆 | 3 | 快捷填入是带文字的按钮；目录和命令文案就是工具名 |
| 7 | 灵活与效率 | 3 | 页内「现在」和系统时区按钮仍可用；命令面板同名动作目前走不到 |
| 8 | 简洁 | 3 | 去掉模式页签是这次的目标；内容比旧 `TabsContent` 的 `p-1` 紧 4px，不另做视觉 |
| 9 | 错误恢复 | 3 | 复制失败、非法日期、NTP 错误态还在；pending effect 抛错后 `consumed` 已记下，同一次投递不会再试 |
| 10 | 帮助 | 3 | 空状态标题和说明、输入占位仍在，没有独立文档页 |
| **总分** | | **30/40** | **良好，有一条阻断** |

## 设计特异性

**LLM：** 这不是一套可挪到别的产品的通用表单。时间转换仍是时间戳输入、快捷填入、结果行排序；日期计算仍是日期间隔和加减；真实时间仍是 NTP 状态加多时区时钟。拆开之后每个工具只做一件事，和目录里其它单职工具一致。没有为拆分重做视觉语言。

**确定性扫描：** `impeccable detect --json` 对五个 tsx 返回 `[]`，exit 0。没有检测器另抓到的问题，也没有需要标成误报的条目。

**可视化叠层：** 不适用。Wails 用 WKWebView，没有 CDP。正在运行的 `TinkerKit.dev` 来自 `/Users/northes/workspace/tinker-kit` 的 vite/dev 进程，不是这份检查 worktree，因此没有把它的截图当作这次改动的渲染证据。

## 总体印象

三页的结构接得上原来的内容区：转换页网格仍是 `h-full`，日期计算外套原来的 `ScrollArea`，真实时间面板自己有 `h-full`。最大的问题不在版式，而在时间转换收不到已经投递的 pending。

## 做得好的地方

- 去掉页签后没有再造第二套标题栏，工具名留在工作区标签和命令里。
- 日期计算和真实时间沿用原来的滚动容器，没有把面板直接塞进会裁切的父级而不给高度。
- 托盘可选列表只有 `time-convert`，另外两个工具不会出现在识别名单里。

## 优先问题

### [P0] 时间转换收不到 pending，命令和剪贴板填入都中断

- **为什么重要：** `App.tsx` 给 `TimeTool` 传了 `clearDelivered`，组件只声明 `clearPending`。effect 先把这次 pending 记成已消费，再调用 `clearPending()`。属性是 `undefined`，调用抛错，`refresh`、`timezone` 和剪贴板 `open` 都不会写到输入框。标签会打开，但时间戳不会填进去，也没有 toast。验收要求这两条命令仍作用于转换页。
- **修复：** 与其它工具一样写成 `clearPending={clearDelivered}`。
- **建议命令：** `$impeccable harden`

没有 P1。没有需要在本次自动改动的 P2。

## 人物红旗

**Alex（熟练用户）：** 命令面板里「插入当前时间戳」「使用系统时区」只在时间转换标签下出现，这点是对的；选中后 effect 抛错，快捷键等于没做。页内按钮仍能插入「现在」和切换系统时区，所以不是完全没有出口。

**Riley（边界）：** 托盘识别到时间戳会打开时间转换并 toast「已填入」，但输入框保持空白。`consumed` 已写入，同一次投递不会重试。看起来像识别成功、数据丢掉。

## 次要观察

- **[P3]** 旧的 `TabsContent` 带 `p-1`。三页现在直接放进 `ToolLayoutContent`，四周少了这 4px。需求是只去掉页签、不重做布局，不单为对齐旧内边距去改。
- `TimeTool.tsx` 去掉页签后网格仍留着多一层缩进，不影响渲染。

## 可以再想的问题

- 托盘 toast 写「已填入」时，如果 pending 没有真正落地，用户是否应该看到失败而不是成功？
- 真实时间在标签隐藏后仍保持 NTP 轮询，这是工作区不卸载隐藏标签的既有行为；这次不必改。

## 问题

Questions skipped: 检查子代理必须做完即停，不能等用户选择后续改动。P0 按任务直接修。
