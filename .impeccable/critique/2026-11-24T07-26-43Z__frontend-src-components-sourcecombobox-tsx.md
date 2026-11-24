---
target: 主机与来源选择器的按顺序匹配
total_score: 33
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:/Users/northes/workspace/tinker-kit-fuzzy-check/frontend/src/components/SourceCombobox.tsx"
target_fingerprint: "sha256:91baef7e54995cd95e947f03610fc3bf09d85334e06ae7c7ef5be8ee9f637c14"
target_path: /Users/northes/workspace/tinker-kit-fuzzy-check/frontend/src/components/SourceCombobox.tsx
timestamp: 2026-11-24T07-26-43Z
slug: frontend-src-components-sourcecombobox-tsx
---
⚠️ DEGRADED: single-context (spawn_agent unavailable in this session)

# 主机与来源选择器的按顺序匹配

## 评审范围

对象是 `2dc8c16` 的来源 / SSH 配置选择器匹配：`frontend/src/components/SourceCombobox.tsx`、`frontend/src/components/SSHProfileSelect.tsx`，逻辑在 `frontend/src/lib/source-search.ts`。模式是 Operate。先读这两个组件、共享函数和 Base UI 1.7 的 `filteredItems` 行为，再跑检测器。单上下文评审，不是双盲。

## 设计健康

| # | 启发式 | 得分 | 要点 |
| --- | --- | --- | --- |
| 1 | 状态可见性 | 3 | 输入会立刻改列表，无命中有空状态；连续命中和按顺序命中看起来一样 |
| 2 | 符合现实 | 4 | 按主机名里的分隔习惯匹配：`orb zot`、`l240_prod`、`user@host:port` |
| 3 | 用户控制 | 4 | 清空查询恢复原顺序；Esc 仍取消过滤而不清掉已选配置 |
| 4 | 一致性 | 4 | 两个选择器共用一个纯函数；六个工具的来源下拉走同一个组件 |
| 5 | 错误预防 | 3 | 删筛选文字不会取消选中；很短的顺序查询仍可能把松散命中排到可回车确认的位置 |
| 6 | 识别优于回忆 | 3 | 不用记完整分隔就能搜到；命中字符没有标出来，仍要扫列表 |
| 7 | 灵活与效率 | 3 | 打字即筛选是这次的加速器；没有新的快捷键，原有键盘路径还在 |
| 8 | 简洁 | 4 | 不新增按钮、徽章或说明，符合静默工具集，也符合需求里的非目标 |
| 9 | 错误恢复 | 3 | 无命中有「没有匹配」文案；失效配置命中时仍留在末尾，并保留名称 |
| 10 | 帮助 | 2 | 没有说明「字符按顺序出现即可」；只能靠试出来 |
| **总分** | | **33/40** | **良好** |

## 设计特异性

**人工判断（检测器之前）：** 没有新的视觉语言。下拉仍是现有的紧凑浮层：名称截断，SSH 地址用次要色等宽字。特异的是匹配规则，不是外观。规则对着这类主机名（空格、下划线、连字符拆开的短名），而且只挂在来源和 SSH 配置选择器上，没有铺到文件搜索或镜像筛选。这是给这个工作台的主机挑选写的，不是一个随处可贴的模糊搜索皮肤。

**检测器：** `impeccable detect --json` 分别扫了 `SourceCombobox.tsx` 和 `SSHProfileSelect.tsx`，两次都是 `[]`，退出码 0。没有漏网的机械问题，也没有需要记 ignore 的误报。

**渲染：** 未做。macOS 上的 Wails 是 WKWebView，没有 CDP，按桌面壳只做设计评审加源码扫描。这次没有改布局、颜色、字号或动效，不靠截图判断排序是否正确。没有用户可见的检测叠加层。

## 总体印象

排序藏在原来的列表里：连续子串在前，按顺序命中在后，同档保持原顺序。打开时输入框里的已选名称不当作查询，Base UI 在选中标签未改前也会忽略外部 `filteredItems`，两条路径都回到原顺序。最大的剩余不是视觉，而是顺序命中为什么排在后面，界面上没有解释。需求明确不要高亮和命中计数，所以不改。

## 做得好的地方

- 匹配和排序只在 `source-search.ts`。组件只提供字段和「失效项钉在末尾」。
- SSH 的名称、`user@host:port`、本机别名取最好的一档：地址连续命中可以压过名称的顺序命中。
- 关闭浮层时冻住打开期间的排序，避免退出动画闪回全量列表；空查询和只含分隔符的查询都回到原顺序，和归一化后的旧行为一致。

## 优先问题

- **[P0]** 无。
- **[P1]** 无。
- **[P2]** 无。
- **[P3] 连续命中和按顺序命中没有视觉差别。** 位置：两个选择器的 `ComboboxItem`，本次没有改条目结构。输入 `oz` 时 `ozone` 会排在 `orb zot` 前面，但用户只能靠位置猜原因。需求非目标写明不新增高亮和命中计数。不修。若以后要解释排序，用一句辅助说明，不要加第二套徽章。建议命令：`$impeccable clarify`。

## 认知负荷与情绪

清单 8 项里只有「同时看见的选项可能超过 4 个」算失败：短查询的顺序命中会把更多主机会进同一列表。这是可筛选列表的固有负荷，不是新的决策墙。其余项通过：一个输入框、名称和地址分组、清空即回到原列表。情绪上，原先 `orbz` / `l2p` 搜不到是低谷；现在命中出现，收尾仍是原来的选择动作。失效配置不会插到普通结果前面。

## 人物

**Alex（熟手）：** 记得大致字符就能打 `l2p` 或 `orbz`，连续命中仍在最上面，回车确认的还是第一项。Esc 不丢已选配置。没有新的确认步骤。

**Sam（键盘 / 读屏）：** 两个输入都有标签（来源用 `aria-label` / `aria-labelledby`，SSH 用占位对应的 `aria-label`）。地址文字在条目里，不是只靠颜色。焦点环仍是组件库的 ring。没有新增只可点击的控件。读屏听不出「这是顺序命中」，和视觉上没有标记是同一件事。

**Riley（边界）：** 空查询、纯空白、纯分隔符都保持原顺序。不命中的失效配置会被剔除，命中则留在末尾。`bro` 对 `orb zot` 不命中，避免无序乱配。大小写和 `_` / `-` / 空格仍先归一化。

## 次要观察

- `filter` 和 `filteredItems` 同时传入。Base UI 在使用外部列表时不再调用 `filter`；选中标签未改时会忽略外部列表并显示原 `items`。和「未输入时保持原顺序」一致，不是两套结果。
- 来源下拉只搜展示名。地址和本机别名只在 SSH 配置选择器的三个字段里。来源的展示名本身就是用户给主机起的名字。
- 仓库里原先没有 `source-search` 的 `wails3 task`。检查时临时加过 `test:source-search` 并跑通，随后撤回 `Taskfile.yml`，因为该文件不在本次可改路径里。

## 待追问

不把「要不要给顺序命中加标记」做成必答题：需求已经写成非目标。
