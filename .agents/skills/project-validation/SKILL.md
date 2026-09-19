---
name: project-validation
description: 实现完成后按 git diff 选择并执行类型检查、构建、测试和差异检查。实现过程中不要加载本 skill。不要用于编写功能或接线。
user-invocable: false
---

# 项目验证

本 skill 是项目命令验证的唯一入口。按本轮 `git diff` 和实际变更边界选择一次命令集并执行；同一轮已执行的命令不得重复。在验证结果中记录实际执行的命令。

## 命令

- 前端依赖只在 `frontend/` 内安装。npm 项目使用 `npm install`，不要在仓库根目录寻找或创建 `package.json`。
- `frontend/.npmrc` 的 `minimum-release-age=10080` 是供应链策略；安装依赖时不要删除或绕过它。
- 前端脚本在 `frontend/` 执行：

  ```sh
  npx tsc --noEmit
  npm run build
  npm run format:check
  ```

  不要用 `npx tsc --no-emit`，正确参数是 `--noEmit`。

- Go 验证在仓库根目录执行：

  ```sh
  go test ./...
  git diff --check
  ```

- 当前没有独立的前端测试套件；Go 至少有 `configservice_test.go` 和 `updateservice_test.go`。不要把“没有前端测试”写成“项目没有测试”。

## 验证矩阵

- 只改 Markdown 或 skill：运行 `git diff --check`，并检查路径、命令、文件名和现有架构描述一致。
- 改 React 组件、locale、样式或现有工具内部行为：运行前端类型检查、生产构建，必要时格式检查。
- 新增工具或改变 `ToolId`、注册、导航、常驻挂载、命令、历史或托盘识别：在前端验证之外，静态核对工具 ID 出现在侧栏、路由、常驻挂载、命令面板、历史记录和 locale；pending 不被其他常驻工具抢消费。
- 改工具页高度链、CodeMirror 尺寸、浮层滚动或 `ScrollArea` 滚动容器：静态核对受影响页面的尺寸链和常驻挂载不卸载。若改 `ScrollArea` 或 `ToolLayoutScrollableContent`，确认宿主不残留 `overflow-*`、原 `overflow-x: hidden` 的容器传了 `overflow.x: 'hidden'`，且未在全局隐藏原生滚动条。
- 改 Go 服务、配置、窗口、托盘或事件：运行 Go 测试和前端类型检查/构建；若导出类型改变，先确认已重新生成 bindings，再检查生成文件和调用方。
- 改 `build/config.yml` 的资源元数据：先运行 `wails3 task common:update:build-assets`，检查生成资源，再执行对应的构建验证。
- 改 `main.go` 的嵌入资源、构建流程或分发配置：确认 `frontend/dist` 已生成，再运行 `wails3 task build` 或用户要求的目标任务。

## 失败处理

- 验证失败时先确认失败属于本次修改还是基线问题，继续追到数据流、生命周期、类型或构建配置的根因。
- 基线已有未格式化文件：`fileservice.go`（gofmt）、`App.tsx`/`HistoryPage.tsx`/`ImageTool.tsx`/`ui/color-picker.tsx` 等（Prettier）。它们本就失败，不要当成本次引入，也不要顺手格式化无关文件制造噪声。
- 不通过额外 CSS 覆盖、特殊判断、异常吞掉、隐式重试或延迟执行来让命令表面通过。
- 代码改动完成后，验证应覆盖原始复现和相关边界；文档改动则检查是否留下过时的文件路径、API 名称、底层 primitive 或命令。
