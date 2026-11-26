# 列表与批量操作

## 平铺数据行

- 平铺的数据行（文件、端口、镜像、时间、URL、阶段、JSON 表和对话框里的可选列表）用隔行淡底区分：偶数行 `bg-muted/30`，行两端 `rounded-md`（表格单元格用基础半径减 4px）。这些行之间不要 `border-b` 或 `divide-y`。
- 普通块/网格条纹行在行容器上使用 `px-3`（左右 12px），不按奇偶区分留白。紧凑表格首尾列外侧 8px：沿用 shadcn `TableCell`/`TableHead` 默认 `p-2`（或 `json.css` 中 `padding-inline: 8px`）；行号列等特殊列可更窄（例如 JSON 表 `padding-inline: 4px 8px`）。勾选框列、拖动手柄列不强行改成 12px。
- 悬停用 `bg-muted/50`，选中用 `bg-muted` 实底，两者盖住条纹。JSON 表的斑马纹限定在 `:not(:hover)`，避免压过单元格悬停色。
- 数据表头是一块不透明淡底横栏（muted 约 45% 混入所在表面），两端同档圆角，不要底部分割线，以便吸顶时盖住滚过的行。
- 层级导航、设置分组和定义列表仍可用 1px 分隔，不要为了统一改成条纹。

## 长列表虚拟化

- 主内容为列表时统一用 `@tanstack/react-virtual`，不以当前数据量少为理由改用全量 DOM 渲染。滚动容器加 `ref`，`useVirtualizer` 只渲染 `getVirtualItems()` 的可视行；`<table>` 用上下占位 `<tr><td colSpan={n} style={{ height }} />` 撑出滚动高度。唯一例外是需要拖动排序的列表：`SortableContext` 依赖完整行参与，这类配置型短列表全量渲染并关闭虚拟化，规则见 [drag-and-drop.md](./drag-and-drop.md#顺序语义)。
- 列表表头固定，各列使用明确的固定宽度。单元格内容超出时不换行、不截断，保留水平滚动能力；支持滚轮的水平滚动，但单元格内不显示水平或垂直滚动条。
- 所有业务上可排序的列都必须提供排序交互：未激活使用 Regular `CaretUpDown`，升序使用 Regular `CaretUp`，降序使用 Regular `CaretDown`；不用空白代替未激活状态。支持拖动排序的列表把列排序当临时视图，默认顺序与手柄规则见 [drag-and-drop.md](./drag-and-drop.md#顺序语义)。
- 占位行用普通 `<tr>/<td>`，不要复用 `TableRow`/`TableCell`，否则会带上 hover 和边框样式。
- 行高不固定时（例如搜索态文件名下多一行父路径）用 `measureElement` 测量：把 `ref={virtualizer.measureElement}` 和 `data-index` 挂到行元素上，否则按 `estimateSize` 布局会产生错位。
- Base UI 组件通过 `render` 接收元素时会与该元素自身的 `ref` 合并，测量 ref 可直接写在 `render={<TableRow ref={...} data-index={...} />}` 上，不必改组件。
- 任务进度分母会随发现新项回退，或命令不提供细粒度进度时，用不确定进度（脉动）而不是会跳动的百分比，成功后再置 100%；不要用会先冲到 100% 再掉回来的 `completed/total`。

## 列表 footer 统计

- 锚点是 SSH 文件管理的 footer。适用于主列表工具 footer 左侧的条数（端口列表、端口转发、SSH 文件、镜像管理）。
- 容器类名：外层 `flex items-center justify-between gap-3 pt-3`；统计组 `flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground`。不要用 `text-xs`，不要用 `pb-2` 把统计往下挤。
- 只显示搜索和筛选之后的可见条数，条件一变立即更新。禁止「匹配数 / 未过滤总数」。
- 没有已提交搜索、也没有非默认筛选：用 `common.itemCount`（「{{total}} 项」）。底层列表本身为空时不显示这条。
- 搜索已提交，或任一筛选离开默认值：用 `common.foundCount`（「找到 {{total}} 项」），0 也显示。
- 插值变量名用 `total`，不要用 `count`。
- 同一行可以继续放附属统计（总大小、已选、进行中的任务、快照时间），字号和颜色跟条数同一组，不要为它们另起一套字号。
- 运行结果状态（网络测试 footer 的成功/失败和耗时）不是列表条数，保持自己的字号和颜色，不要套这套统计样式。
- 主列表的创建类主按钮与筛选/搜索同一行，靠右（`ml-auto`）。不要为了放按钮把统计行做成「左边计数、右边主按钮」。footer 动作栏（清空、复制这类编辑器动作）不受这条约束。

## 搜索、右键与复制

- 表格/列表右键不应改变选中项；右键菜单操作在目标行未被选中时回退到该行，已选中时作用于整个选择集，不要靠右键来建立选中。
- 批量复制多项内容用「1. 值 / 2. 值 / … / 共 N 个」的编号格式（每项一行、末行汇总数量）；单选取原始值。
- 搜索输入默认回车才触发（本地 `draft` + `onKeyDown` Enter），不要实时过滤，也不要引入防抖或 `useDeferredValue`。
- 搜索输入在内部靠右放置 phosphor `XCircle` 清空按钮，使用 `weight="regular"`；仅在有输入时可用，需有可访问名称，且清空后按搜索的触发语义同步更新结果。

## 列表勾选与批量操作

- 勾选框列支持按住滑动多选时：在勾选框列按下即切换起始行，指针滑过的行按各自当前状态各切换一次；用本次拖选的 `handled` 集合去重，回滑不重复切换，不要用统一目标状态覆盖所有经过的行。
- 切换由前端接管：在窗口捕获阶段吞掉按下后浏览器补发的 `click`，用标志位 + 常驻捕获监听，并在下一次 `pointerdown`/`keydown` 重置；不要用 `setTimeout` 摘监听或引入激活阈值，否则切换会被反向改回，表现为只能取消、不能选中。
- 拖选范围限定在勾选框列：用 `document.elementFromPoint` 加首列 `getBoundingClientRect` 判断指针是否仍在列内，行 key 从行元素的 `data-row-key` 读取，兼容虚拟化列表；仅响应鼠标主键，避免与触摸滚动冲突，窗口外丢失 `pointerup` 时由下一次 `pointerdown` 清理状态。
- 勾选框列保持默认箭头光标（`cursor-default`），不要出现手型或文本光标。
- 多选后右键菜单作用于整个选择集时，操作项使用批量文案；批量入口放在该右键菜单，不要再在 footer 增加“批量操作”下拉。
