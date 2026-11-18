# 输入框不展示清空按钮

状态：已对齐。实现时以本文「已定决策」与「需求条目」为准。

## 背景与目标

部分搜索框与单行输入在右侧内嵌了「清空」图标按钮（多为 `X` / `XCircle`），与键盘删除、全选删除等原生输入方式重复，且在带 `trailingAddon` 的搜索框里占用右侧空间、增加布局分支。

目标：全应用统一——**凡属文本类输入控件，不再展示附着在输入框内的清空按钮**；调用方也不再新增此类按钮。

## 需求条目

1. **范围**：下列控件在「有内容」时也不得在输入框内侧（含 `InputGroup` 尾缀区）显示用于一键清空内容的图标按钮：
   - `Input` / `InputGroupInput` / 多行 `Textarea`
   - 共享组件 `ToolSearchField`（工具页搜索框）
   - `ComboboxInput` 通过 `showClear` 挂载的 `ComboboxClear`
   - 各工具内自行实现的、与输入框同行的清空图标按钮（例如 JSON Schema 预览内搜索条）
2. **共享实现**：从 `ToolSearchField` 移除清空按钮、`onClear`、`clearLabel`，以及仅为清空按钮服务的右侧 `padding` / `trailingAddon` 位移。Esc 不清空输入内容。
3. **调用点**：端口工具、SSH 文件管理、SSH 配置管理弹窗不再传 `onClear` / `clearLabel`。SSH 文件管理里只服务于该按钮的 `clearSearch` 一并删除。JSON Schema 预览搜索条去掉清空按钮，Esc 也不再清空。
4. **i18n**：删除只服务于输入内清空按钮的文案 key（中英 locale 同步）：`portTool.clearSearch`、`sshFilesTool.clearSearch`、`sshProfiles.clearSearch`、`jsonTool.schemaPreviewSearchClear`。
5. **组件库**：删除 `ComboboxInput` 的 `showClear` 与 `ComboboxClear`，不留死代码。触发器上为「有清空时隐藏箭头」准备的 class 一并去掉。
6. **布局**：去掉清空按钮后，搜索框右侧内嵌控件（如 SSH 文件搜索方式菜单）恢复为不预留「清空列」的间距规则。

## 已定决策

- **产品原则**：用户通过退格、全选删除、剪切等方式清空内容；不依赖输入框上的清空按钮。
- **与「清空」无关的尾缀控件保留**：密码显示/隐藏、Combobox 下拉触发、单位标签等不属于「清空按钮」，本需求不删。
- **非输入框上的清空操作不波及**：例如筛选历史弹窗里的「清空历史」、日志面板的「清空日志」、下拉菜单中的「清除筛选」、任务中心的「清除已完成」等，仍可为独立按钮或菜单项。
- **Esc 不清空输入**：搜索框和其它文本输入按 Esc 不把内容清掉。关掉浮层、补全、命令面板这类既有 Esc 行为保留，它们不清输入内容。
- **Combobox 清空能力删除**：不保留 `showClear` / `ComboboxClear` 死代码。下拉箭头仍在。

## 非目标

- 不改变输入框 placeholder、搜索提交（回车）、即时过滤等现有交互。
- 不禁止用户在输入框**外侧**工具栏/表头上的「重置」「清除筛选」等独立操作（只要不是嵌在输入框右侧缘内）。
- 不改造 CodeMirror / 远程编辑器等非标准 `<input>` 编辑面板的业务按钮（除非其上另行挂了与单行 `Input` 同类的内嵌清空图标）。
- 不要求为所有输入统一增加「全选快捷键」等替代能力。

## 验收标准

- 端口工具、SSH 文件管理、SSH 配置管理、JSON Schema 预览搜索、空白页工具搜索等场景：输入有内容时，输入框右侧**不出现**清空图标按钮。
- `ToolSearchField` 源码中无清空 `Button` 渲染分支；`trailingAddon` 在无清空列时的对齐与改前「从未传 onClear」的页面一致。
- 全仓检索无对已删除 i18n key 的引用；`zh-CN` / `en-US` 无 `portTool.clearSearch`、`sshFilesTool.clearSearch`、`sshProfiles.clearSearch`、`jsonTool.schemaPreviewSearchClear`。
- 搜索框有内容时按 Esc 不会清空；输入框内没有清空按钮。
- `ComboboxInput` 源码中没有 `showClear` 与 `ComboboxClear`。
- 密码框「显示/隐藏」、Combobox 展开箭头等行为与改前一致。

## 待定问题

无。

## 变更记录

- 2026-11-18：初稿，记录「所有输入框不加清空按钮」全应用规则及已知影响面（`ToolSearchField`、JsonSchema 预览、`ComboboxInput`）。
- 2026-11-18：待定落定。Esc 不清空输入内容；删除 `ComboboxClear` / `showClear`，不留死代码。
