# AGENTS.md

## 项目定位

- 本项目是 Wails v3 beta 桌面开发者工具启动器：Go 负责窗口、托盘和服务，React 19 前端是产品主体。
- 优先沿用现有数据流、组件、类型、事件和持久化机制；不要为局部需求创建平行抽象、兼容分支或第二套状态来源。

## 语言与国际化

- 始终使用简体中文与用户沟通；代码注释、报告和评审意见使用中文；Git commit subject/body 必须使用英文。
- 应用默认语言和回退语言为 `zh-CN`。前端用户可见文案必须通过 i18n 资源提供。

## Skill 加载

- 只加载 description 直接命中当前变更边界的 skill；禁止因“相关领域”顺带加载相邻 skill。
- `project-validation` 仅在实现完成后按 diff 执行一次；实现过程中不要加载。
- 修改现有工具的局部行为或样式，且不改变工具 ID、注册、导航、托盘、配置、事件或 bindings 时，不要加载 `tool-development`。
- 仅在持久化 Config、Wails 事件、托盘、Go 服务或 bindings 实际受影响时，才加载 `wails-integration`。
- 不要因为普通样式、布局或现有组件 `className` 调整加载 `shadcn`；仅在安装、更新、添加 shadcn 组件或修改 `components.json` 时加载。
- `migrate-radix-to-base` 仅在用户明确要求 Radix 到 Base UI 迁移时加载。
- 先检查直接生产者和消费者；发现跨界证据后再扩展检查范围，不做无依据的全仓扫描。

## 全局不变量

- `default-light` 和 `default-dark` 是持久化配置值，不得改名、复用或删除。
- 设置页配置由 Go `ConfigService` 管理，前端不得写入设置 localStorage。工作区标签和其中的输入只活在本次运行，退出或刷新后不恢复；不要写 `devutils.lastPage`。应用配置目录为 `TinkerKit`。
- `frontend/bindings/` 是 Wails 生成文件，永远不要手工编辑；Go 导出类型变化后必须重新生成 bindings。
- 所有项目开发、构建、打包和运行任务以根目录 `Taskfile.yml` 为准，通过 `wails3 task <name>` 执行。`main.go` 嵌入 `frontend/dist`，Go 构建前必须有前端产物。
- 不使用 Playwright、`playwright-cli` 或任何浏览器自动化进行测试和验证。
- 桌面 GUI 自动化只允许通过 `agent-desktop` 观察和操作正在运行的应用，且不得作为测试或验收依据；规则见「桌面观察（agent-desktop）」。
- 使用 shadcn/Base UI 组件时，优先直接使用组件提供的官方默认样式；局部视觉调整优先使用现有 Tailwind utility class。不得为单个控件新增局部 CSS 覆盖、专用选择器或单独样式文件，也不要通过局部 class 改写官方组件的默认外观，除非需求明确要求且无法用现有组件能力实现。

## 桌面观察（agent-desktop）

- 仅在需要看见或操作正在运行的应用界面时使用：确认现状、演示流程、复现用户报告的界面问题。不得用它判定改动是否正确；回归与验收仍以 `wails3 task` 和 `project-validation` 为准，动态交互只列出待人工验收步骤。
- 首次使用先执行 `agent-desktop status`、`agent-desktop skills get desktop`、`agent-desktop skills get platform`，按其中的 observe → act → verify 循环执行；参数以 `agent-desktop <command> --help` 为准，不凭记忆猜 flag。
- 先只读：用 `snapshot`、`screenshot` 拿到现状再决定是否动手；能靠只读快照回答的问题不要点击。
- 默认 headless 语义操作。只有用户明确允许物理输入时才加 `--headed`，也不得用 `--headed` 绕开 headless 失败。
- ref 只对当次 snapshot 有效，界面变化后重新 snapshot；异步结果用 `wait`，不用固定 sleep。
- 只有 `disposition.retry` 为 `safe`（`not_delivered`）时才可重试；其它情况先读活状态（`get`、`is` 或新快照）再判断，避免重复点击或重复输入。
- `TinkerKit.dev` 实例写入真实配置目录 `TinkerKit`：不要留下脏配置、历史记录或工具状态；操作结束时说明改变了哪些持久化状态，以及如何还原。
- 权限缺失用 `agent-desktop permissions` 判断，`--guide` 需要用户在系统设置里确认，此时停下来告知用户，不要反复重试。

## 发版流程

- 版本号用 SemVer annotated tag（`v<major>.<minor>.<patch>`），打在 `main` 的最新提交上；只依据「最近一个本地 tag → `HEAD`」的实际变更判断级别：用户可感知的新能力抬 minor，仅修复抬 patch，破坏兼容或需手动迁移抬 major。不要在发版时顺手改版本判定之外的代码。
- 打 tag 前先确认工作区干净、`HEAD` 已包含本次要发布的全部提交；`git rev-parse <tag>^{commit}` 必须等于 `HEAD`。已被推送的 tag 不移动、不删除、不重建，判错就补一个更高的版本。
- 推送到全部远程统一用 `wails3 task gp`（`Taskfile.yml` 的 `gp`：origin 和 github 各推一次分支与 tags）。不要自己拼 `git push` 组合。
- `gp` 报 github `main` 被拒（`fetch first`）时，通常是 github 侧有本地的 Homebrew cask chore 提交。先 `git fetch github`，确认差异只有 `Casks/` 更新后再 `git merge github/main`，然后重跑一次 `wails3 task gp`；不要用 `--force` 覆盖对方提交。
- `Casks/tinker-kit.rb` 的 `version` 与 `sha256` 只能在 GitHub 已存在对应 tag 的 Release 资产后更新；没有资产时保持上一版，不要提前改版本号留下不可安装的 cask。

## 工程质量

- 状态由真正拥有它的边界管理，副作用集中在生命周期边界，数据流、错误传播、取消语义和可访问性先于视觉优化。
- 修复问题必须定位并覆盖根因及相关边界；禁止用特殊分支、延迟、魔法值、选择器覆盖、异常吞掉或隐式重试掩盖错误。
- 抽象只服务于已经存在的重复、耦合或稳定变化点；优先组合和清晰职责，避免不断增加布尔 props、全局状态和隐式依赖。
