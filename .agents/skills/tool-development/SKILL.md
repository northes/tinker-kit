---
name: tool-development
description: 仅在新增开发者工具，或改变 ToolId、工具注册、导航、常驻挂载、命令面板或托盘识别时使用。现有工具的算法、文案或样式修改不要使用本 skill。
user-invocable: false
---

# 新增工具

新增工具必须完成完整接线，不能只新增一个组件并把导航逻辑留在旧代码中。工具组件使用 `ToolLayout`、`ToolActionBar` 和共享类型，遵循现有工具的数据流。

新工具支持本机与 SSH 来源切换时，按 [forms-and-controls.md](../layout-guidance/forms-and-controls.md) 接入来源 UI，按 [wails-integration 的服务与配置](../wails-integration/SKILL.md#服务与配置) 接入来源模型与持久化。

调查发现变更跨越 `ToolId`、注册、导航、常驻挂载、命令或托盘识别时，再升级到完整接线清单。编解码类工具（例如 JWT）的产品特例见 [examples.md](./examples.md)，仅在新增同类工具时读取。

在**已有工具内部**新增协议、算法或数据格式分支（例如网络测试工具新增协议）不属于本清单，见 [network-test-protocol](../network-test-protocol/SKILL.md)。

## 必需接线

按以下顺序检查：

1. `frontend/src/components/shared.tsx`
   - 将新工具 ID 加入 `ToolId` 联合类型。
   - 复用 `ToolLayout`、`ToolActionBar`、`Reveal`、`PendingAction` 和共享 helper。
2. 新组件 `frontend/src/components/<Tool>Tool.tsx`
   - 每个工具独立文件。
   - 编辑器工具使用 `ToolLayout`；CodeMirror 工具通常使用 `contentMode="fixed"`。
   - pending effect 必须校验 `pending.tool === '<id>'`。
   - 工具动作使用 `ToolActionBar`，不要自行拼装 `.tool-actions` 或 footer。
   - 仅确需工具专属样式时放在组件旁并由组件引入；不得为单个控件新增 CSS 覆盖（见 `AGENTS.md`）；`.cm-*` 覆盖必须收敛在工具根类作用域下。
3. `frontend/src/App.tsx`
   - `tools` 数组加入侧栏和路由定义。
   - 加入常驻 `tool-slot` 渲染，切页只隐藏不卸载。
   - `paletteItems` 加入 `open:<id>` 导航命令和实际存在的工具动作命令。
4. locale
   - `frontend/src/locales/zh-CN.json` 和 `frontend/src/locales/en-US.json` 同步增加 `tools.<id>`、导航命令和工具文案。
5. 页面恢复
   - 不要为新工具新增设置类 localStorage；页面恢复 key 见 `AGENTS.md`。

## 命令面板

- 命令必须与界面实际功能一一对应；自动实时行为没有按钮时不要添加命令。
- 使用 `context` 表达 Schema、编辑区、模式等上下文；统一由命令面板过滤，不为单个工具增加特殊字段。
- 命令索引同时包含 label、group、subgroup 和 keywords，并支持项目已有的拼音/首字母匹配。
- 右侧归属显示为两级“工具名 - 子分组”；无子分组时只显示工具名。
- 排序优先级为当前工具命令、工具命令、导航命令、设置命令，组内再按匹配分数。
- 不消费输入的切换命令必须在 pending effect 中先处理并 `return`，不能先把空输入写回编辑器。

## 文件拖入与打开

工具需要接收本地文件时，统一使用 `frontend/src/components/fileDrop.tsx`，不要各自实现 HTML5 drop、隐藏 `<input type=file>` 或 window 级监听：

- `useFileDrop({ id, enabled, pick, onPaths, onError })` 同时接入 Wails 原生拖入事件 `files-dropped` 与 Wails 文件选择器 `Dialogs.OpenFile`，两者都以本地路径回调 `onPaths`。把返回的 `dropProps` 展开到一个常驻的 drop target 容器（`enabled=false` 时不注册），用 `over` 做悬停反馈。
- 每个工具使用唯一 `id`（连同 `data-file-drop-target` 由 `dropProps` 提供）；只有当前可见工具会被命中，常驻挂载的隐藏页不会误触发。
- 空态使用共享 `FileDropEmpty`：`onChooseFile` 传 `fileDrop.pick`，`over` 传 `fileDrop.over`。
- 剪贴板文件粘贴使用共享 `useClipboardFilePaste({ enabled, accept, onFile })`，不要各自监听 `paste`。
- 按路径读取内容使用共享 `readLocalFile(path, maxBytes)`（Go `FileService.ReadFile`，返回 data URL 与元数据）；文本工具用 `dataUrlToText`，剪贴板文件用 `fileToDataUrl`。
- 拖入与选择器都产出路径，因此不要再依赖 `dataTransfer.files` 或隐藏 file input。
- 打开成功后必须弹 toast，并把后端返回的文件名带进文案（例如 `jsonTool.fileLoaded`）。

## 空态提示与「打开」链接

支持打开文件的工具，空态提示文案统一为「粘贴、打开或拖入文件」，其中「打开」必须是可点击的链接，点击调用同一个 `fileDrop.pick`，不要只写成纯文本。文案走 i18n（如 `jsonTool.placeholder` 用 `<open>…</open>` 标记链接），通过 react-i18next 的 `<Trans components={{ open: <button … /> }} />` 渲染。

CodeMirror 可点击空态的坐标测量、指针和可访问性规则见 [editor.md](../layout-guidance/editor.md)，仅在实现编辑器空态时读取。

## 托盘和剪贴板匹配

若新工具支持托盘识别，必须同时更新：

- Go `configservice.go` 的 `defaultConfig`、`normalizeConfig` 和迁移逻辑。
- 前端 `App.tsx` 的默认 `trayMatchTools`、检测 helper 和 `analyzeClipboard` 检测顺序。
- `SettingsPage` 的 `trayTools` 和 `toggleTrayTool` 兜底集合。

三处工具 ID 必须一致。新支持的工具默认开启；已有用户配置通过一次性迁移加入，之后用户手动关闭必须持久化，不能每次启动重新开启。

## 验收

按上方必需接线和托盘清单核对实际变更；编辑器状态保留见 [editor.md](../layout-guidance/editor.md)，命令验证交给 `project-validation`。
