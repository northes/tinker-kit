---
name: wails-integration
description: 仅在修改 Go 服务、系统托盘、窗口生命周期、Config 持久化、前后端事件或 Wails bindings 时使用。纯前端 UI、文案或样式修改不要使用本 skill。
user-invocable: false
---

# Wails 集成

Go 层是桌面壳层和服务边界。修改这些边界前先确认现有数据流，不创建第二套状态或通信机制。Config 所有权、bindings 不可手改、构建任务入口见 `AGENTS.md`。

## 服务与配置

- `main.go` 负责 Wails 应用启动、窗口、系统托盘、服务注册和事件广播；`configservice.go` 的 `ConfigService` 负责应用配置及历史记录服务。
- `greetservice.go` 是未使用的模板残留，除非需求明确要求，不要把它重新接入服务列表或围绕它建立新调用链。
- 应用配置持久化到 `os.UserConfigDir()/TinkerKit/config.json`，窗口位置和大小持久化到同目录的 `window-state.json`。
- 配置字段的规范化、默认值、白名单和旧配置迁移集中在 Go 层；新增字段必须考虑已有配置文件和非法值回退。
- 当前 `go.mod` 模块名仍为模板值 `changeme`，不要因单个功能随意重命名；新增依赖使用真实 import 路径。

## 事件与托盘

- Go 到前端使用 `app.Event.Emit`，前端使用生成的 `Events.On` 订阅。现有事件包括 `navigate`、`tray:analyze` 和 `mouse:navigate`；新增事件前先确认不能复用已有事件。
- 托盘点击触发剪贴板分析，设置菜单先唤回窗口再发出 `navigate`。事件名和 payload 必须与 `App.tsx` 的订阅一致。
- 托盘附件窗口不要使用 `tray.ShowWindow()`，沿用现有 `showFromTray`：显示窗口、聚焦，并在需要时临时提升层级后恢复普通层级，使窗口回到保存的位置。
- 普通关闭窗口只隐藏窗口并取消关闭事件；只有托盘“退出”或明确的真实退出流程才调用 `app.Quit()`。窗口关闭前必须保存最新 bounds。
- 当前 `main.go` 的 macOS `ActivationPolicy` 是 `Regular`。不要依据旧文档假设应用一定是 accessory；改变该行为必须同时评估 Dock、托盘和窗口唤回流程。
- 窗口 bounds 的防抖保存必须在 `app.OnShutdown` 中 flush，不能因为退出发生在防抖计时器触发前而丢失最后一次位置或尺寸变化。

## Bindings 与构建

- 修改导出的 Go service、`Config` 或其他绑定类型后运行：

  ```sh
  wails3 generate bindings -clean=true -ts -i
  ```

- Go 结构体变更后检查生成的 TypeScript 类型和调用方，不要用手写兼容类型掩盖绑定不同步。
- 不要根据过时 README 使用旧的 `wails3 dev` 流程。
- 修改 `build/config.yml` 的 `info` 或 `fileAssociations` 后运行 `wails3 task common:update:build-assets`，并检查生成的资源变化。
- 当前 `build/config.yml` 的资源元数据仍含模板占位信息；修改这些字段时以配置文件为准，并接受更新任务会重新生成相关资源。

## 静态检查

- 配置默认值、规范化、迁移、持久化和前端绑定形成一条完整数据流。
- 窗口关闭、托盘唤回、真实退出和 shutdown flush 的生命周期行为保持可推理。
