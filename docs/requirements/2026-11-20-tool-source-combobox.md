# 工具头部来源/目标切换改为可输入 combobox

## 背景与目标

各工具界面左上角（`ToolLayoutToolbar`）切换「来源」「目标」用的是纯 `Select`，机器一多只能滚动查找。目标是把这些目标机器切换器统一换成可输入过滤的 combobox：输入即过滤、选中即写入原有来源/目标 id，行为与已改造的 SSH 配置选择器一致，但不改动任何工具的数据流与管理弹窗。

## 需求条目

1. 新增一个共享组件（`frontend/src/components/SourceCombobox.tsx`，命名可按实现调整）承载这次改造，不要在每个调用处复制一份过滤、输入还原、`管理` 动作行逻辑。它接受的入参至少覆盖：`id` / `labelId`、`value`、`items`（`{ value, label }` 列表）、`onValueChange`、可选的管理动作（文案 + 回调）、`placeholder`、`disabled`、`className`。
2. 用该共享组件替换以下 6 处（数据源都是来源/目标机器列表）：
   - `PortTool.tsx` 头部「来源」
   - `PortForwardTool.tsx` 新增转发表单里的「来源」
   - `NetworkTestTool.tsx` 头部「来源」
   - `ServiceManagerTool.tsx` 头部「目标」
   - `ImageManagerTool.tsx` 头部「来源」
   - `SshFilesTool.tsx` 头部「来源」
3. 输入内容只作为过滤条件：按选项现有单行文案匹配，忽略大小写、空格、下划线和连字符（与 `SSHProfileSelect` 同一规则；把归一化逻辑放到共享位置复用，不留两份实现）。
4. 选项仍单行显示现有文案，不新增 `user@host:port` 副行。
5. 「管理」动作在浮层底部固定一行（带齿轮图标），不参与过滤，输入过滤时依然可见；点击后打开原有管理弹窗/对话框，不改写当前选中值。
6. 不产生自由值：输入不会被当作来源/目标值；失焦或 Esc 后输入框还原为当前选中项文案（无选中则为空），Esc 关闭浮层后继续向外传递。
7. 保留各调用处现有行为：`disabled` 条件（网络测试运行中、SSH 文件加载中、服务管理 picked 视图等）、占位文案（如 SSH 文件工具的「暂无来源」）、`aria-labelledby`/标签关联、宽度 class（`toolHeaderControlClassName`、`w-full` 等）与容器自适应。
8. 选中后的回调语义不变：端口/端口转发/镜像管理/网络测试仍写来源记忆并更新来源，服务管理仍走 `selectTarget`，SSH 文件仍重置搜索与加载状态。
9. 无匹配项时在浮层里显示统一空态文案，新增 `common.noMatches`（中英同步），沿用组件默认的空态渲染位置。
10. 键盘操作沿用组件能力：上下移动高亮、回车选中、Esc 关闭。

## 已定决策

- 范围限定为上述 6 处来源/目标切换；协议、状态过滤、行数、字符集等参数下拉不在本次范围（`TextGeneratorTool` 的「来源」是字符集复选菜单，也不改）。
- 「管理」入口留作浮层底部的固定动作行，不改成输入框旁的独立图标按钮。
- 匹配按现有单行文案，选项保持单行显示，不引入地址副行。

## 非目标

- 不修改各工具的来源/目标管理弹窗（`TargetHostManagerDialog`、各 `ManageSources`/`ManageTargets` 对话框）与其保存逻辑。
- 不修改来源/目标的数据结构、Go 服务、Wails bindings 或持久化格式。
- 不修改 `SSHProfileSelect`（SSH 配置选择器）的现有两行显示与齿轮按钮形态，只复用其匹配规则。
- 不新增「用输入内容新建来源」之类入口。

## 验收标准

1. 上述 6 处在界面上都是可输入的 combobox，外观与 `SSHProfileSelect` 一致（`InputGroup` 触发框 + 浮层），宽度按各自容器自适应，头部工具栏在 700px 以下折行表现不变。
2. 输入名称片段、大小写差异、`gxprod` 形式的片段都能命中 `gx_prod` 之类的来源/目标；
   过滤不影响原有选中值。
3. 点「管理」动作打开原管理弹窗，选中值不变；输入过滤时该动作行仍可见。
4. 输入无匹配时显示 `common.noMatches`；点击外部或按 Esc 后输入框恢复为当前选中文案。
5. 各工具原有的 `disabled` 条件、占位文案、`aria-labelledby` 关联保持不变。
6. 选择来源/目标后的行为与改动前一致（来源记忆、服务管理 `selectTarget`、SSH 文件重置搜索并加载等）。
7. 新增文案在 `zh-CN.json` 与 `en-US.json` 同步存在。
8. 类型检查与前端构建通过（按 `project-validation` 以 diff 选择实际命令）。

## 待定问题

无。

## 变更记录

- 2026-11-20：评审发现 NetworkTestTool 与 SshFilesTool 的 label id 写死，同一工具多标签可能导致 `aria-labelledby` 串到另一个实例；选定改成 `useId`。保留检查阶段对共享 combobox 空态播报的修复，并接受来源输入框 Enter 不提交外层表单；浮层宽度 P2 暂不处理，留待界面实测。
