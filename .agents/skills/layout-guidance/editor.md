# 编辑器与分栏

## 编辑器与状态

- CodeMirror 实例不因切页、Schema 开关或工具状态切换而重建；实例保留撤销历史、滚动位置和尺寸状态。
- 切换工具或模式时，不挂载不可见的昂贵预览，不解析不可见结果；常驻 CodeMirror 可以保留实例，但隐藏时暂停可取消的后台预解析。重计算的位置、取消和过期结果保护由 [wails-integration](../wails-integration/SKILL.md) 的后台任务规则维护；仅在实际修改 Go 服务或 Wails 调用边界时读取。
- 全局快捷键执行编辑器命令时（如打开搜索替换），在窗口捕获阶段监听 `keydown`，并按可见性选择实例：焦点在编辑器内优先该实例，否则取当前可见的第一个；用 `visibility` 和布局排除常驻挂载的隐藏页，不要假设第一个 `.cm-editor` 可用。
- 模态弹窗打开时，把查找范围限制在 `[role="dialog"][data-open]`、`[role="alertdialog"][data-open]` 内，避免快捷键落到弹窗背后的编辑器。
- 监听用 `ViewPlugin` 跟随实例生命周期注册/卸载（引用计数），没有可见编辑器时不抢占按键；DOM 到实例的查找用 `EditorView.findFromDOM`，不要自建映射表。
- 打开面板后需要设置面板内部状态（如展开替换行）时，在面板构造函数用模块级 `WeakMap<EditorView, Panel>` 记录实例并调用其方法；不要打开后再查询面板 DOM 或模拟点击。
- 编辑器工具的主输入统一使用共享 CodeMirror 配置，不额外实现 textarea 历史或撤销拦截。
- 在 CodeMirror 上叠加提示或可点击内容（如空态「打开」链接）时，不要用固定内边距定位：自带 `placeholder` 强制 `pointer-events: none` 且带 `aria-hidden`，不可交互。改用绝对定位浮层，并用 `view.coordsAtPos(0)` 实测正文坐标，自动避开行号槽、内容内边距和滚动；浮层 `pointer-events-none`，仅可点击元素 `pointer-events-auto`。
- 纯 input/textarea 的程序化变更使用共享 `useHistory`；键盘撤销需要处理 `Mod/Ctrl+Z`、重做快捷键和 IME composing 状态。
- 切页滚动复位使用 `useLayoutEffect`；workspace 滚动容器增加 `overflow-x: hidden`。
- flex 中的图标按钮必须显式设置相等的 `width`/`min-width` 和 `flex: none`（或 `flex-shrink: 0`），必要时清除横向 padding，避免窄窗口或长输入压扁按钮。

## CodeMirror 补全弹框

- 所有 CodeMirror 补全入口复用 `frontend/src/components/codeMirrorCompletion.ts` 的 `editorCompletions(config)`，通过 config 传入业务候选源；统一维护补全、浮层定位与 Tab 键位，不在使用方重复装配。公共扩展显式导入样式；背景、圆角、候选行、选中态与图标样式统一维护在 `frontend/src/styles/tools/editor.css`。不依赖先打开 JSON 工具，也不复制工具专属选择器或另建补全外观。
- Tab 接受当前候选使用 `Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }]))`，优先于 React CodeMirror 默认缩进；直接返回命令结果，无可接受候选时交回原有缩进或焦点导航，禁止无条件返回 true 吞键。单行输入保留 `indentWithTab={false}`；方向键、回车、Esc 使用 CodeMirror 默认补全键位，业务捕获阶段的提交逻辑必须先处理补全。
- 使用 `tooltips({ position: 'fixed', parent: document.body })`，由 CodeMirror 根据光标和视口定位。不要把补全浮层留在带 `overflow: hidden` 的输入框、分栏、ScrollArea 或弹窗内容中，也不要靠取消容器裁切或手算坐标解决。
- 弹框外壳负责背景、边框、圆角与裁切，候选列表内部滚动；保持公共样式中的视口宽度限制、列表高度限制及 `scrollbar-gutter: auto`，确保滚动内容与选中背景不溢出圆角。
- 固定字号的输入框需要让挂到 body 的补全弹框使用同一字号，不能依赖输入框祖先的 CSS 变量继承。补全与历史浮层互斥时，以 CodeMirror 的补全状态协调；回车先接受当前补全，再由下一次回车提交输入。
- 人工验收覆盖直接进入该工具、暗色与亮色、分栏边缘及窗口底部、窄窗口、长候选与列表滚动，确认浮层不被裁切、候选可读，方向键、Tab、回车和 Esc 正常，并检查无候选时 Tab 缩进或焦点导航与 Shift+Tab 不受影响；遵守项目禁止浏览器自动化的限制。

## 可调整分栏

- `react-resizable-panels` 会按一组 panel `id` 缓存布局；同一组面板在单栏、左右分栏、上下分栏或不同业务模式下有不同约束时，各状态必须使用独立的 `id` 组合，避免关闭模式后复用旧尺寸。`id` 表示模式下的布局身份，React `key` 表示组件实例身份且保持稳定；不要为清空布局缓存改变 `key`，否则会丢失 CodeMirror 等子组件的撤销记录、滚动位置和内部状态。
- 隐藏面板用 `defaultSize={0}`、`minSize={0}`、`maxSize={0}` 表达布局约束；显示时恢复对应模式的默认值、最小值和最大值。显示中的内容面板不要设置 `collapsible`，两侧都必须受 `minSize` 约束，避免某一侧能被拖到 0。
- 不要在面板约束随模式变化时再通过 `groupRef.setLayout()` 强制同步尺寸。面板注册、约束重算和 effect 的执行顺序会互相覆盖，容易留下空白区域或恢复错误布局。让模式专属 `id` 负责隔离和恢复布局。
- 面板尺寸为 0 不等于内容一定不可见：panel 外壳可能允许内容溢出。隐藏宿主还要设置 `visibility:hidden`、`pointer-events:none`、`inert` 和 `aria-hidden`；需要保留编辑器状态时不要用条件渲染或 `display:none` 卸载实例。
- 验证至少覆盖：每种模式分别开启和关闭、模式之间直接切换、宽窄屏方向切换、反复往返、分隔条向两端拖到极限，以及重新打开后恢复该模式上次比例。类型检查和构建不能证明这些状态转换正确。
