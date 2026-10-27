# 拖动排序

列表拖动排序统一复用项目已有的 `@dnd-kit`（`@dnd-kit/core` + `@dnd-kit/sortable`），不新增拖拽依赖，也不用原生 HTML5 DnD 或 JS 模拟拖拽。参考实现：`frontend/src/app/Sidebar.tsx`、`components/TimeTool.tsx`、`components/JsonPipeline.tsx`、`components/PortTool.tsx`、`components/TargetHostManagerDialog.tsx`。

## 视觉状态

- 传感器与碰撞统一为 `PointerSensor`（`activationConstraint: { distance: 4 }`）+ `KeyboardSensor(sortableKeyboardCoordinates)`、`closestCenter`、`verticalListSortingStrategy`。
- 把 `useSortable` 的 `transform`、`transition`、`zIndex` 透传给可排序元素本身：被拖项跟手，其他项平滑让位。不要用 `DragOverlay` 或额外浮层模拟行位移；侧边栏管理态的预览浮层是唯一例外。
- 拖动中的提示用本列表已有的状态样式表达（`bg-accent`、`shadow-md`，纵向卡片列表也可用降透明度突出位移），选与选中态不冲突的那种，不要临时新增边框、圆角或单独样式覆盖。
- 纵向列表位于横向可滚动容器或表格中时，只透传 y 轴位移：`transform ? \`translate3d(0, ${Math.round(transform.y)}px, 0)\` : undefined`。完整的 dnd-kit transform 会带上指针 x 偏移，在这类容器里撑出横向滚动条。
- 表格行同样适用：把 `transform` 放到 `TableRow` 上，行本身跟手。table-row 在 CSS Transforms 规范里属于可 transform 元素，不要为此把表格改成 div 布局或重写行结构。
- 有吸顶表头的表格，被拖行的 `zIndex` 必须高于表头（表头 `z-10`，行用 `20`），否则拖动经过表头时行会被压住。
- 可排序元素的内联 `transition` 会覆盖类上的 `transition-colors`，拖动期间颜色过渡失效属预期行为，不要为此加第二套过渡。

## 手柄与键盘

- 手柄是独立按钮：`setNodeRef` 交给可排序元素，`setActivatorNodeRef` + `{...attributes} {...listeners}` 交给 `Button`（`variant="ghost"`、`size="icon-sm"` 或 `icon-xs`、`DotsSixVertical`、`cursor-grab active:cursor-grabbing touch-none`）。不要给整行挂 drag 监听。
- 手柄必须有可访问名称（如 `拖动{{name}}以调整顺序`）；`ArrowUp`/`ArrowDown` 自行 `preventDefault` 并调序，其余按键转交 `listeners?.onKeyDown`，同时声明 `aria-keyshortcuts="ArrowUp ArrowDown"`。
- 调序后用常驻 `aria-live="polite"` 区域播报「{{name}} 已移到第 N 位，共 M 项」，插值变量用 `position`/`total`，名称与位置走 i18n。
- 列表项业务上被禁用（例如内置来源）只禁用编辑和删除，不要把这个状态传给 sortable 或隐藏手柄。

## 顺序语义

- 支持拖动排序的列表默认按持久化顺序展示：新增项追加到末尾，编辑项保持原位；列排序只是临时视图。来源管理列表的其余规则见 [forms-and-controls.md](./forms-and-controls.md)。
- 列排序激活时定义顺序不可见，此时隐藏拖动手柄，并提供回到默认顺序的入口（如「默认顺序」按钮），不要让人在排序视图里拖动。
- 顺序必须写回后端配置，不维护只存在于前端内存或 localStorage 的顺序：保存接口按 ID 列表重排，并保留未出现在列表中的项，避免并发新增被丢弃。
- 需要 dnd 的列表关闭虚拟化：`SortableContext` 的位移与放置判定依赖完整行参与，虚拟化窗口外的行无法接收拖动。配置型短列表（转发规则、端口来源）全量渲染；端口占用、日志等长数据列表不提供拖动排序，见 [lists.md](./lists.md#长列表虚拟化)。

## 验收

拖动属于动态交互，类型检查和构建不能证明手感正确，完成后必须在真实 WebView 中核对：被拖项跟手且有明确状态样式、其他行平滑让位、经过吸顶表头不被压住、容器不新增横向滚动条、松手后顺序写回并刷新不变、键盘 `↑`/`↓` 与播报可用。
