---
target: SSH 镜像来源表单（Docker 命令 / sudo 密码 / 测试连接面板）
total_score: 27
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 0
target_identity: "files:frontend/src/components/ImageManagerTool.tsx + frontend/src/components/image-manager/ConnectionTestPanel.tsx"
target_fingerprint: "sha256:f45dd3af770dc050dd6b299f02a5875682bcf174135064ad24678dabc72f20e7"
target_path: /private/tmp/tk-sudo-test.T1GOvVlL/frontend/src/components/ImageManagerTool.tsx
timestamp: 2026-11-20T07-20-06Z
slug: imagemanagertool-ssh-source-form-sudo
---
# SSH 镜像来源表单评审（sudo 密码与 Docker 命令）

> ⚠️ DEGRADED: single-context（本检查不能再派隔离评审代理，按 AGENTS.md 单上下文降级路径完成）
>
> 范围：提交 9b38805 引入的 SSH 镜像来源编辑表单（`ImageManagerTool.tsx` 约 2400–2490 行的「Docker 命令」与「sudo 密码」输入、`ConnectionTestPanel.tsx` 的分步测试面板）。
> 方法：先基于 diff 与表单源码做设计评审，再跑机械 detector，最后做源码级手动 audit。
> 渲染：WKWebView 无 CDP，未截图；本机存在 TinkerKit dev 进程，但无法确认其为本工作树构建，且本轮未与应用交互，因此布局、间距、颜色与动效不作判断。

## 设计健康度

| # | Nielsen 启发式 | 分 | 证据 |
|---|---|---:|---|
| 1 | 系统状态可见性 | 3 | 测试面板分「连接 / daemon 探测」两行，`aria-live="polite"`；取消与跳过态都有文案。 |
| 2 | 与现实世界匹配 | 2 | 第二段说明「导入与详情会把密码单独拆出，避免混入 Docker 的输入」是实现细节，普通用户看不懂。 |
| 3 | 用户控制与自由 | 3 | 测试可取消；编辑任一字段、切换来源类型、关闭弹窗都清空面板结果。 |
| 4 | 一致性与标准 | 3 | 复用 `Label` / `Input` / `Button` 与既有 SSH 表单字段网格；密码框与 Registry 密码一致。 |
| 5 | 错误预防 | 2 | 占位符示例 `/usr/bin/sudo -n /usr/bin/docker` 与 sudo 密码互斥，界面没有提示，只能在保存时被拒绝。 |
| 6 | 识别而非回忆 | 3 | 标签、占位符与说明齐全。 |
| 7 | 灵活与效率 | 3 | 留空即走登录 PATH，填写即走自定义前缀，两条路径都清晰。 |
| 8 | 审美与极简 | 3 | 说明为两段灰色小字，偏长但层级清楚。 |
| 9 | 错误恢复 | 3 | 失败原因单行截断，点击整行复制完整错误（含远端 stderr），弹「已复制」提示。 |
| 10 | 帮助与文档 | 2 | sudo 密码输入没有自己的说明；与前缀互斥的规则没有写在界面上。 |
| | **合计** | **27/40** | 结构与数据流正确，问题集中在文案与可访问性细节。 |

## 设计特异性判断

表单围绕 TinkerKit 的 SSH 与 Docker 工作流设计：留空即使用登录 shell 的 PATH，填写即按空白拆分命令；sudo 密码与测试面板都嵌在同一个来源弹窗里，没有通用模板味道。问题在于说明文字把内部实现暴露给用户，并且没有把前缀与密码的互斥关系讲清楚。

## 机械证据

- `impeccable detect --json frontend/src/components/ImageManagerTool.tsx frontend/src/components/image-manager/ConnectionTestPanel.tsx`：返回 `[]`，0 条发现，未使用忽略规则。
- 当前安装的 CLI 没有 `audit` 子命令（可用命令：detect、ignores、help、install、link、update、check、telemetry），因此 audit 为源码级手动检查。

## 问题清单（P0–P3）

### P0
无。

### P1
无。源码与 detector 都没有发现功能阻断、数据丢失、误导状态或不可达问题。

### P2
1. **[文案]** `imageManagerTool.dockerCommandSudoHelp`（zh-CN / en-US）第二段包含「导入与详情…拆出…避免混入 Docker 的输入」这类实现细节，与需求第十条「两段说明」不一致，应收敛为「填了 sudo 密码时由应用负责认证，密码只经 SSH 会话输入传输」。
2. **[错误预防 / 帮助]** 占位符 `/usr/bin/sudo -n /usr/bin/docker` 含 sudo，而填了 sudo 密码会被拒绝。界面没有说明二者互斥，用户只能在保存时看到错误。
3. **[可访问性]** `ConnectionTestPanel.tsx` 失败行的按钮设置了 `aria-label`，会覆盖可访问名称。失败原因文本不在名称里，读屏焦点停留时只能听到「复制 …错误」，听不到原因。

### P3
4. **[表单]** sudo 密码 `Input` 没有 `autoComplete` 标注（同表单的 SSH 密码是 `current-password`，两个密码框可能被自动填充混淆），也没有 `aria-describedby` 关联说明。
5. **[表单]** Docker 命令 `Input` 没有 `spellCheck={false}` 与 `autoCapitalize="off"`。同文件 271 行的其他输入已有先例。
6. **[格式]** `ConnectionTestPanel.tsx` 第 56 行 `{steps.map((step) => {` 与 `const label` 同行，未经 prettier 格式化，`format:check` 会报错。本轮未运行 `format:check`。

## 修复策略

本轮只自动修 P0 与 P1，P2 与 P3 留给用户决定。P0、P1 均为零，因此没有修改 UI 代码，也没有读取 `craft-floor.md`。

## 与本次代码修复的关系

本快照针对表单源码，不针对 `df9b065` 的 Go 修复；`df9b065` 未改动 UI 文件。
