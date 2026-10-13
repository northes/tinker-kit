---
name: wails-integration
description: 仅在修改 Go 服务、系统托盘、应用菜单与全局快捷键、窗口生命周期、Config 持久化、前后端事件或 Wails bindings 时使用。纯前端 UI、文案或样式修改不要使用本 skill。
user-invocable: false
---

# Wails 集成

Go 层是桌面壳层和服务边界。修改这些边界前先确认现有数据流，不创建第二套状态或通信机制。Config 所有权、bindings 不可手改、构建任务入口见 `AGENTS.md`。

## 服务与配置

- `main.go` 负责 Wails 应用启动、窗口、系统托盘、服务注册和事件广播；`configservice.go` 的 `ConfigService` 负责应用配置及历史记录服务。
- 能切换远程来源或主机的工具必须维护自己的来源实体和来源管理，以 SSH 文件管理和镜像管理的模式为准。可以引用共享 SSH 连接的 profile ID 作为连接凭据，但不能直接把 SSH profile 列表当作该工具的来源列表，也不能省略该工具自己的来源名称、类型和关联配置。前端交互规范见 [forms-and-controls.md](../layout-guidance/forms-and-controls.md)。Go 保存接口和配置规范化必须保留前端提交的来源列表顺序；本机来源只在缺失时补入，不得每次保存都强制移到首位。
- `greetservice.go` 是未使用的模板残留，除非需求明确要求，不要把它重新接入服务列表或围绕它建立新调用链。
- 应用配置持久化到 `os.UserConfigDir()/TinkerKit/config.json`，窗口位置和大小持久化到同目录的 `window-state.json`。
- 配置字段的规范化、默认值、白名单和旧配置迁移集中在 Go 层；新增字段必须考虑已有配置文件和非法值回退。
- 规范化不得把内部 ID 写入展示字段；展示名称应回退到被引用实体的名称，而不是被引用 ID。
- 规范化顺序：先规范化被引用实体，再规范化引用方，否则取不到用于默认名称的实体。
- 读取配置时要顺带修复历史坏数据（例如展示名等于被引用 ID 的旧值），不要只在下次写入时处理。
- 当前 `go.mod` 模块名仍为模板值 `changeme`，不要因单个功能随意重命名；新增依赖使用真实 import 路径。

## 事件与托盘

- Go 到前端使用 `app.Event.Emit`，前端使用生成的 `Events.On` 订阅。现有事件包括 `navigate`、`tray:analyze`、`mouse:navigate`、`files-dropped` 和 `ssh-files:tasks`；新增事件前先确认不能复用已有事件。
- 窗口启用 `EnableFileDrop`；`main.go` 将原生拖入统一转成 `files-dropped` 事件（`files` 路径数组 + `details` 元素信息），触发元素需带 `data-file-drop-target`。前端的拖入、选择器和文件读取接入规范见 [tool-development 的文件拖入与打开](../tool-development/SKILL.md#文件拖入与打开)，仅在新增文件接收能力时读取该节，不扩展到工具注册清单。
- 托盘左键唤回窗口；右键在 `trayMatchEnabled` 开启时分析剪贴板，关闭时展开菜单。设置菜单先唤回窗口再发出 `navigate`。事件名和 payload 必须与 `App.tsx` 的订阅一致。
- 托盘附件窗口不要使用 `tray.ShowWindow()`，沿用现有 `showFromTray`：显示窗口、聚焦，并在需要时临时提升层级后恢复普通层级，使窗口回到保存的位置。
- 普通关闭窗口只隐藏窗口并取消关闭事件；只有托盘“退出”或明确的真实退出流程才调用 `app.Quit()`。窗口关闭前必须保存最新 bounds。
- 当前 `main.go` 的 macOS `ActivationPolicy` 是 `Regular`。不要依据旧文档假设应用一定是 accessory；改变该行为必须同时评估 Dock、托盘和窗口唤回流程。
- 窗口 bounds 的防抖保存必须在 `app.OnShutdown` 中 flush，不能因为退出发生在防抖计时器触发前而丢失最后一次位置或尺寸变化。

- Wails 标题栏拖拽使用 CSS 的 `--wails-draggable: drag/no-drag` 和 `data-wails-drag`，不要用 JavaScript 监听鼠标模拟拖拽。

## 应用菜单与全局快捷键

- macOS 应用菜单的键盘等价键在 WebView 之前拦截按键：默认应用菜单把 `Cmd+R` 绑定为 Reload 时，前端 `keydown` 根本收不到。需要前端接管已被占用的快捷键时，在 Go 层重建应用菜单，不要试图用前端 `preventDefault` 拦截原生菜单。
- 重建应用菜单要保留 `AppMenu`/`FileMenu`/`EditMenu`/`WindowMenu`/`HelpMenu` 与 View 的其余角色（Force Reload、缩放、全屏），只移除冲突项，否则复制粘贴、缩放、全屏、退出等系统快捷键会失效。macOS 应用菜单是全局菜单，不随窗口的 `Menu`/`UseApplicationMenu` 选项改变。
- DevTools 菜单项按 Wails 的构建标签分支（辅助文件用 `//go:build !production || devtools`），生产构建不要出现无效项。
- 改应用菜单或构建标签辅助文件后，分别用默认、`-tags production`、`-tags production,devtools` 编译，确认三种分支都通过。

## Bindings 与构建

- 修改导出的 Go service、`Config` 或其他绑定类型后运行：

  ```sh
  wails3 task common:generate:bindings
  ```

- Go 结构体变更后检查生成的 TypeScript 类型和调用方，不要用手写兼容类型掩盖绑定不同步。
- `FileService.ReadFile(path, maxBytes)` 按路径读取本地文件为 data URL 与元数据，是拖入与文件选择器的共用读取入口；`ReadImageFile` 保持图片专用校验。新增文件读取能力优先复用 `ReadFile`。
- 不要根据过时 README 使用旧的 `wails3 dev` 流程。
- 修改 `build/config.yml` 的 `info` 或 `fileAssociations` 后运行 `wails3 task common:update:build-assets`，并检查生成的资源变化。
- 当前 `build/config.yml` 的资源元数据仍含模板占位信息；修改这些字段时以配置文件为准，并接受更新任务会重新生成相关资源。

## 后台任务与远程命令

- 会明显占用 WebView 主线程的本地计算（大文本解析、JSON 修复与路径求值、压缩、批量转换等）必须放到 Go 后端，通过生成的 Wails binding 异步调用；禁止用前端 Web Worker 作为规避主线程卡顿的实现。若已有服务拥有对应数据或解析能力，扩展该服务，不新建平行计算通道。
- 前端发起可被输入、模式或页面切换淘汰的计算时，保存 Wails `CancellablePromise` 并在清理时调用 `cancel()`；同时使用修订号、请求 ID 或服务端版本对结果做精确匹配。取消只负责停止或丢弃旧请求，过期结果保护仍是必需的，不能假设取消一定在 Go 计算完成前生效。
- Go 返回大结果时，避免为了统计信息或展示再次在前端完整解析；行数、字符数、字节数、错误码等随结果由 Go 一并计算返回。结果特别大且无需一次展示时，沿用 JSON Pipeline 的结果句柄、预览和分页读取模式，避免反复跨 Wails bridge 传输完整文本。
- 迁移前端算法到 Go 时必须保留既有输入容错、错误码、格式化语义和取消/竞态行为，并把原前端用例迁到 Go 测试。完成后删除对应前端算法、Worker、依赖和测试，不能保留双实现或回退分支。
- 后台任务异步执行：任务开始时刷新只能拿到旧结果，完成后由服务端触发来源重扫；前端只负责进度和终态提示，不要在启动任务时刷新列表。
- 通过 SSH 执行需要 stdin 的命令必须设置 `session.Stdin`；共享的 SSH 执行入口支持 stdin/stdout/stderr 三路，只读 stdout 的命令复用同一实现。
- 命令只输出状态行、不提供细粒度进度时，进度展示遵循 [lists.md](../layout-guidance/lists.md) 的不确定进度规则，不要伪造百分比。

## 生命周期与配置验收

- 配置默认值、规范化、迁移、持久化和前端绑定形成一条完整数据流。
- 窗口关闭、托盘唤回、真实退出和 shutdown flush 的生命周期行为保持可推理。

后台计算按上方规则核对实现，行为测试由 `project-validation` 选择执行。
