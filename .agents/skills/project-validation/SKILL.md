---
name: project-validation
description: 实现完成后按 git diff 选择并执行类型检查、构建、测试和差异检查。实现过程中不要加载本 skill。不要用于编写功能或接线。
user-invocable: false
---

# 项目验证

本 skill 是实现完成后的项目命令验证入口。按本轮实际修改及相关边界选择命令集；已通过且相关代码未再改变的检查不重复，修复失败或新增相关改动后允许重跑。记录实际命令及结果，区分本次失败、基线失败和未验证项。

## 命令入口

开发、依赖安装、bindings、构建和测试通过根目录 `Taskfile.yml` 及其 includes 的 `wails3 task <name>` 执行，不另列绕过任务的 npm、Go 命令。

- 前端生产构建（包含 TypeScript 检查）：`wails3 task common:frontend:run SCRIPT=build`。
- 前端格式检查（必要时）：`wails3 task common:frontend:run SCRIPT=format:check`。
- Go 测试：`wails3 task test:go`；针对性测试通过 `GO_TEST_FLAGS` 传递，例如 `GO_TEST_FLAGS='-run TestRepairJSON'`。
- bindings：`wails3 task common:generate:bindings`。实现阶段仅在导出服务或绑定类型变化时生成，验证时不无条件再次生成。
- 完整前端产物及 bindings 构建：`wails3 task common:build:frontend`；应用构建使用 `wails3 task build` 或用户指定目标。
- 已有前端行为测试：`test:image-tasks`、`test:image-architectures`、`test:ansi`、`test:network-target`、`test:network-user-agent`，按变更使用 `wails3 task <name>` 执行。
- JSON 修复测试：`wails3 task test:json-repair`。
- 差异检查：`git diff --check`，同时检查新增未跟踪文件的内容及引用。

任务和脚本以当前 `Taskfile.yml`、`build/Taskfile.yml`、`frontend/package.json` 为准；需要独立检查而现有任务无法表达时，先补最小任务再执行，不假设不存在的任务可用。前端依赖只在 `frontend/` 内安装，保留 `.npmrc` 的 `minimum-release-age` 策略。

Go 测试前确保 `frontend/dist` 存在；需要更新产物时先完成前端构建，再串行运行 Go 测试，避免构建清空嵌入目录时测试失败。

## 验证矩阵

- 只改 Markdown 或 skill：运行差异检查；检查 frontmatter、相对链接、任务名和架构描述，不运行应用构建。
- 改 React 组件、locale、样式或现有工具内部行为：运行前端生产构建（含类型检查），命中现有行为测试时执行对应任务，必要时格式检查。
- 删除或移除操作：按 [forms-and-controls.md](../layout-guidance/forms-and-controls.md) 核对确认边界。
- 工具注册、导航、命令或托盘识别：前端验证，并按 [tool-development](../tool-development/SKILL.md) 的接线清单验收。
- 布局、编辑器、浮层或滚动容器：前端验证，并按 [layout-guidance](../layout-guidance/SKILL.md) 路由到实际命中的参考验收。
- Go 服务、配置、窗口、托盘或事件：Go 测试与前端构建；按 [wails-integration](../wails-integration/SKILL.md) 核对配置、生命周期和绑定同步。
- WebView 重计算迁移到 Go：按 wails-integration 的后台任务规则核对实现；Go 行为测试覆盖原始大输入、取消、过期结果保护、返回文本和统计字段，不以类型检查替代行为测试。
- 网络协议：按 [network-test-protocol](../network-test-protocol/SKILL.md#验证) 选择协议行为与时间线测试；目标识别或 UA 变化时执行对应前端测试任务。
- 改 `build/config.yml` 的资源元数据：先运行 `wails3 task common:update:build-assets`，检查生成资源，再执行对应的构建验证。
- 改 `main.go` 的嵌入资源、构建流程或分发配置：确认 `frontend/dist` 已生成，再运行 `wails3 task build` 或用户要求的目标任务。

## 失败处理

- 验证失败时先确认失败属于本次修改还是基线问题，继续追到数据流、生命周期、类型或构建配置的根因。
- 基线问题现场核对，不维护永久失败文件名单，不把旧问题当成本次引入，也不顺手格式化无关文件。
- 代码改动完成后，验证应覆盖原始复现和相关边界；文档改动则检查是否留下过时的文件路径、API 名称、底层 primitive 或命令。
- 动态交互需要人工验收时列出具体步骤，区分已通过检查与待人工验收；遵守 `AGENTS.md`，不使用 Playwright、Computer Use 或浏览器自动化。
