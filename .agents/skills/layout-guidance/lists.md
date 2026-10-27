# 列表与批量操作

## 长列表虚拟化

- 主内容为列表时统一用 `@tanstack/react-virtual`，不以当前数据量少为理由改用全量 DOM 渲染。滚动容器加 `ref`，`useVirtualizer` 只渲染 `getVirtualItems()` 的可视行；`<table>` 用上下占位 `<tr><td colSpan={n} style={{ height }} />` 撑出滚动高度。唯一例外是需要拖动排序的列表：`SortableContext` 依赖完整行参与，这类配置型短列表全量渲染并关闭虚拟化，规则见 [drag-and-drop.md](./drag-and-drop.md#顺序语义)。
- 列表表头固定，各列使用明确的固定宽度。单元格内容超出时不换行、不截断，保留水平滚动能力；支持滚轮的水平滚动，但单元格内不显示水平或垂直滚动条。
- 所有业务上可排序的列都必须提供排序交互：未激活使用 Regular `CaretUpDown`，升序使用 Regular `CaretUp`，降序使用 Regular `CaretDown`；不用空白代替未激活状态。支持拖动排序的列表把列排序当临时视图，默认顺序与手柄规则见 [drag-and-drop.md](./drag-and-drop.md#顺序语义)。
- 主列表工具的 footer 左侧放置当前统计；统计基于搜索和筛选后的可见结果，条件变化时立即同步，不显示未过滤的总数冒充当前结果数。
- 占位行用普通 `<tr>/<td>`，不要复用 `TableRow`/`TableCell`，否则会带上 hover 和边框样式。
- 行高不固定时（例如搜索态文件名下多一行父路径）用 `measureElement` 测量：把 `ref={virtualizer.measureElement}` 和 `data-index` 挂到行元素上，否则按 `estimateSize` 布局会产生错位。
- Base UI 组件通过 `render` 接收元素时会与该元素自身的 `ref` 合并，测量 ref 可直接写在 `render={<TableRow ref={...} data-index={...} />}` 上，不必改组件。
- 任务进度分母会随发现新项回退，或命令不提供细粒度进度时，用不确定进度（脉动）而不是会跳动的百分比，成功后再置 100%；不要用会先冲到 100% 再掉回来的 `completed/total`。

## 搜索、右键与复制

- 表格/列表右键不应改变选中项；右键菜单操作在目标行未被选中时回退到该行，已选中时作用于整个选择集，不要靠右键来建立选中。
- 批量复制多项内容用「1. 值 / 2. 值 / … / 共 N 个」的编号格式（每项一行、末行汇总数量）；单选取原始值。
- 搜索输入默认回车才触发（本地 `draft` + `onKeyDown` Enter），不要实时过滤，也不要引入防抖或 `useDeferredValue`。
- 搜索输入在内部靠右放置 phosphor `XCircle` 清空按钮，使用 `weight="duotone"`；仅在有输入时可用，需有可访问名称，且清空后按搜索的触发语义同步更新结果。

## 列表勾选与批量操作

- 勾选框列支持按住滑动多选时：在勾选框列按下即切换起始行，指针滑过的行按各自当前状态各切换一次；用本次拖选的 `handled` 集合去重，回滑不重复切换，不要用统一目标状态覆盖所有经过的行。
- 切换由前端接管：在窗口捕获阶段吞掉按下后浏览器补发的 `click`，用标志位 + 常驻捕获监听，并在下一次 `pointerdown`/`keydown` 重置；不要用 `setTimeout` 摘监听或引入激活阈值，否则切换会被反向改回，表现为只能取消、不能选中。
- 拖选范围限定在勾选框列：用 `document.elementFromPoint` 加首列 `getBoundingClientRect` 判断指针是否仍在列内，行 key 从行元素的 `data-row-key` 读取，兼容虚拟化列表；仅响应鼠标主键，避免与触摸滚动冲突，窗口外丢失 `pointerup` 时由下一次 `pointerdown` 清理状态。
- 勾选框列保持默认箭头光标（`cursor-default`），不要出现手型或文本光标。
- 多选后右键菜单作用于整个选择集时，操作项使用批量文案；批量入口放在该右键菜单，不要再在 footer 增加“批量操作”下拉。
