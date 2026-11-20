# SSH 镜像来源的 sudo 认证与 Docker 输入

## 现象

- 工作区的 `imageenv.go` 引用了尚未定义的 `ImageSource.SudoPassword`，Wails 构建在 Go 编译阶段失败。
- 补齐配置和 SSH 执行逻辑后，统一把密码行放到会话 stdin 的起始位置会导致流式输入损坏。远端 sudo 在免密或认证缓存有效时可以跳过读取密码，Docker 随后会把密码行当成镜像归档或 HTTP 请求的一部分。
- SSH 来源的拉取弹窗解析 `cloudflare/cloudflared:latest` 架构时，显示 `unknown flag: --raw` 和 Docker 帮助。

## 根因

`sudo -S` 从 stdin 读取密码的前提是 sudo 确实发起认证。Docker 同样从这个描述符读取 `image load` 的归档或 `system dial-stdio` 的请求。调用方无法依赖 sudo 消耗固定字节数，认证失败时 sudo 还可能再次读取。

架构解析在执行拉取的机器上调用 `docker buildx imagetools inspect --raw`。本机使用空 Docker 配置复现了相同的报错。执行身份的 Docker CLI 无法加载 Buildx 时，会把 `--raw` 当作未知标志。

## 尝试与误区

- 整仓 `go build ./...` 会把 iOS 依赖脚本目录也纳入构建，产生额外的 `function main is undeclared in the main package`。桌面构建和启动应使用根目录的 Wails 任务。
- 在客户端把「密码行 + 原始流」直接传给 `sudo -S`，只在 sudo 恰好读取一行密码时能保证输入正确。

## 最终方案

- `ImageSource` 持久化每个 SSH 镜像来源的密码，保存和测试连接复用校验，bindings 通过 Wails 任务生成。
- 无 Docker 输入的命令使用 `sudo -S`。镜像导入和详情的固定远端入口先读取密码行，再通过私有 FIFO 和一次性 askpass 助手把密码交给 sudo。sudo 直接执行原有 Docker argv，Docker 读取剩余的原始输入。Go SSH 与系统 `ssh` 使用同一远端命令生成逻辑。
- 用假 sudo 执行生成的远端命令，覆盖请求密码、跳过认证和失败后重试三种行为，并验证原始输入及临时目录清理。
- SSH 来源可显式选择本机中转。本机解析架构并拉取镜像，`docker save` 的 stdout 直接进入目标 `docker load`。选择全部架构时向 `save --platform` 传入完整的平台列表，Docker 无法导出全部平台时显示错误。
- 目标 `load` 提前退出时关闭输入读端并取消本机 `save`，再等待进程和复制协程退出。保留目标加载和本机导出各自的错误。回环 SSH 测试覆盖原始字节传输、提前退出、取消和资源回收。

## 预防与检索关键词

- 审查通过 SSH 传输二进制或协议数据的调用时，验证接收端拿到的完整字节序列，并覆盖认证被跳过的分支。
- 检索词：`ImageSource.SudoPassword`、`sudo -S`、`sudo -A`、`SUDO_ASKPASS`、`NOPASSWD`、`docker image load`、`docker system dial-stdio`。
- [SSH sudo 需求与验收标准](../requirements/2026-11-19-ssh-image-docker-command.md)
- [本机中转需求与验收标准](../requirements/2026-11-20-local-relay-image-pull.md)

## 变更记录

- 2026-11-20：记录桌面编译阻塞及流式 sudo 认证方案。
- 2026-11-20：补充远端 Buildx 错误、本机中转和流式传输的退出处理。
