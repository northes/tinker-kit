# 设置、控件与表单

## 设置页信息层级

- 统一称为「一级分类 → 二级分组 → 设置项 → 选项」；例如「自动化与通知 → 后台任务通知 → 通知时机 → 关闭 / 始终 / 未专注时」。
- 一级分类负责导航；二级分组是分类面板内的小节标题；设置项是具体控件或操作的名称；选项是单选、选择器等控件中的可选值。
- 二级分组标题放在设置内容的左侧标题列，设置项控件放在右侧列。设置项标签与选项应在同一行呈现，选项靠右对齐；窄屏切为纵向排列后改为靠左。
- 只有一个设置项的分组仍保留二级分组标题位置，但标题应使用该设置项的名称，避免出现重复路径（如「关于 → 关于 → 项目主页」）。当标题已表达设置项名称时，不在右侧重复显示同名标签。
- 多个相关设置项共用一个二级分组标题时，各设置项仍保留各自标签；不要为了减少标题而隐藏不同设置项的名称。
- 设置项标签应直接、易懂地说明控制对象或操作；能通过标签和控件本身理解的内容不添加描述。只有确有必要补充影响或条件时才加简短描述，且不得重复标签、分组标题或选项含义。

## 组件与交互细节

- `DialogFooter` 自带 `border-t`；dialog 主体不要再加 `border-b`，否则相邻两条 1px 边框叠成 2px，分割线看起来比官方粗。
- 焦点环（Base UI 控件默认的 `focus-visible:ring-*`）是画在边框盒外的 box-shadow，会被最近的 `overflow: auto/hidden/scroll` 容器裁掉。凡是承担滚动的容器（对话框内作为滚动层的 `<form>`、`ScrollArea` 视口等），都必须为边缘控件的焦点环预留空间：给滚动层加内边距，至少覆盖 `ring-3` 的 3px（默认取 4px）；要保持与相邻内容对齐时用等量负 margin 抵消，如 `-m-1 p-1`。不要用删除焦点环、叠加阴影/描边或给单个输入写局部覆盖来回避裁切。
- Base UI `Select`：条目必须包在 `SelectGroup` 内；浮层内边距来自 `SelectGroup` 的 `p-1`，不要给 Popup 另加 padding 覆盖官方样式。
- Base UI `Select`：受控值使用内部 key 时，根组件必须同时提供 `items={[{ value, label }]}` 映射（动态/本地化选项按当前文案构建），仅渲染带文字的 `SelectItem` 不足以保证关闭后的 trigger 显示 label。验收时要实际选择并关闭下拉框，确认 trigger 显示本地化 label 而不是内部 key。
- 保持 `SelectContent` 的 `alignItemWithTrigger` 默认值（原生对齐：选中项与 trigger 对齐）；不要为了“展开在下方”而设为 `false`，也不要在各处混用两种定位。
- 允许切换来源或主机的 `Select` 必须在列表底部固定提供“管理”项，左侧带语义匹配的 phosphor icon；该项不随来源/主机数据排序或滚动，选中后打开对应的管理界面，不写入业务选中值。
- 选择全局 SSH 配置时复用 `SSHProfileSelect`；表单需要完整 profile 对象时用 `SSHProfileFormField`，不要重造 profile 下拉框或旁边的管理按钮。工具来源切换仍使用工具自己的来源选择器和 `TargetHostManagerDialog`，来源实体与 SSH profile 的模型边界见 [wails-integration](../wails-integration/SKILL.md#服务与配置)。
- SSH 来源表单选中 profile 时立即写入 `sshProfileID`；来源名称为空或仅含空白时同步填入 `profile.name`，已有手工名称保持不变。使用 `SSHProfileFormField` 的完整 profile 回调处理，不能只在提交时补名称，否则表单里不会即时显示来源名称。
- 来源管理弹窗只保留标题，不加副标题或重复说明。列表页 footer 的添加按钮使用 `common.add`（中文“添加”），放在左侧，保存放在右侧；编辑表单页沿用现有返回、操作和保存布局。
- 来源模型包含“本机”时，管理列表必须显示该项，并禁用编辑和删除；拖动排序仍可用。若列表项使用 `itemDisabled`，只禁用编辑/删除操作，不要把该状态传给 sortable/DnD。新条目追加到末尾，编辑条目保留原位置。删除当前来源后，有本机的工具回退到本机；没有本机的工具选择首项或清空。保存时提交完整有序列表，后端来源顺序与规范化规则由 [wails-integration](../wails-integration/SKILL.md) 的服务与配置节维护。
- 工具页 header 中的字段 label 与控件纵向排列时，复用 `shared.tsx` 的 `ToolHeaderField`；需要通过 `aria-labelledby` 关联控件时传入 `labelId`。尺寸、字重、颜色和间距以镜像管理 header 的 label 为基准；不要在各工具内重复拼接 label 样式，也不要把标签的 muted 颜色放在包住控件的容器上。
- 浮层在暗色下“没有阴影”通常是主题 token 问题：`--shadow-*` 明暗同值（10% 黑），在深色背景上不可见；要改的是暗色 token，不要改组件或加局部阴影覆盖。
- 图标默认使用 phosphor 的 `weight="duotone"`（按钮、下拉项等装饰性图标）；表格排序图标例外使用 Regular 的 `CaretUpDown` / `CaretDown` / `CaretUp`。新增或调整控件时不要遗漏个别图标。
- 工具页操作栏中的清空按钮统一使用 phosphor `Trash`，复制按钮统一使用 `Copy`，由 `ToolActionBar` 以 `weight="duotone"` 渲染；同类操作跨工具保持图标一致，不使用 `X` 或 `ClipboardText` 替代。
- 复制成功只通过 toast 反馈；按钮文案、`aria-label`、`title` 始终保持复制操作名称，图标保持 `Copy`，不要切换成“已复制”等成功态文案、对勾图标或延时复原状态。既有复制入口若缺少成功 toast，应补上。
- 多个工具重复的同类字段抽为共享组件（如来源或配置选择字段），由各工具共同使用，不要在工具内各写一套 Select + 管理入口。
- 与下拉框相关的管理入口放进该下拉框（如来源下拉框底部的「管理」项，内部哨兵值触发实际动作），不再额外放独立管理按钮；空列表时也不渲染多余的分隔线。
- 所有用户触发的删除或移除数据、资源的操作（包括单项和批量、持久化数据和本次会话数据）都必须先显示确认框；按钮、菜单项和快捷键只打开确认框，不直接执行删除。确认内容应明确对象及影响，用户确认后才执行。
- 删除确认统一使用共享组件 `ConfirmDialog`（`frontend/src/components/ConfirmDialog.tsx`），不要在工具或设置页内重复拼 `AlertDialog`；标题、描述、确认文案、危险态、busy、错误和额外正文通过 props 传入，组件在 `busy` 时阻止关闭，调用方在操作完成后自行关闭。

## 原生表单与弹窗提交

- 弹窗表单优先用原生 `<form onSubmit>` 承载字段，回车提交、Tab 顺序和 `disabled` 语义交给浏览器；不要只给主按钮挂 `onClick`，再给每个输入补 Enter 监听。
- 主按钮在 `DialogFooter`（字段区之外）时，把字段容器直接改成带唯一 `id` 的 `<form>`，页脚按钮设 `type="submit" form="<id>"` 关联；Base UI `Button` 默认 `type="button"`，非提交按钮保持默认，避免包进表单后误提交。
- 同一弹窗按模式或类型切换字段时，各分支渲染同一个 `id` 的 form（同一时刻只渲染一个）；对话框打开期间必须始终存在该 form，否则外部 submit 按钮会失效。
- `onSubmit` 里先 `preventDefault()`，提交动作复用已有的 busy/禁用守卫；禁用态的默认提交按钮会阻止隐式提交，不必为 Enter 写额外分支；Textarea 回车换行是原生行为，不要拦截。
