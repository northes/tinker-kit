# TinkerKit

> 常驻 macOS 菜单栏的开发者工作台 —— 本地工具离线即用,SSH、容器与网络联调伸手可及。

[![English](https://img.shields.io/badge/English-Default-0078D4)](README.md)
[![简体中文](https://img.shields.io/badge/简体中文-中文文档-3DA639)](README.zh-CN.md)

TinkerKit 基于 [Wails v3](https://v3.wails.io/) 构建,把日常开发调试中高频的小工具与远程联调能力集中到一个常驻 macOS 菜单栏的桌面应用里:JSON、时间、文本、编码解析、图片与二维码等本地工具全程离线运行;SSH 文件管理、端口转发、容器与服务、镜像管理和网络测试只连接你显式指定的目标。相比零散的在线小工具或一次性脚本,它常驻菜单栏、离线可用,并把联调所需的能力收在同一处。

![GitHub release](https://img.shields.io/github/v/release/northes/tinker-kit?sort=semver&label=版本)
![license](https://img.shields.io/badge/license-MIT-3DA639)
![platform](https://img.shields.io/badge/platform-macOS-000000)
![Wails](https://img.shields.io/badge/Wails-v3%20beta-DF0D3F)
![React](https://img.shields.io/badge/React-19-61DAFB)

## 特性

- **本地优先,默认不联网** — 没有账号、没有遥测,工具不会采集或上传你的内容。密钥、token、日志等敏感数据只在本机处理与保存。
- **托盘常驻,随叫随到** — 应用常驻菜单栏,关闭窗口即隐藏到托盘(再次唤回窗口时会显示 Dock 图标)。复制内容后右键托盘图标,可自动识别 JSON / 时间戳 / URL / JWT / Base64 / 文本并跳到对应工具(默认询问确认,可开启「自动填充」免确认)。
- **命令面板,键盘直达** — `⌘K` / `Ctrl+K` 打开,支持拼音与首字母搜索,按当前上下文过滤命令;几乎所有操作都可以不从鼠标完成。
- **远程与容器联调** — SSH 文件管理、端口转发、容器与服务、镜像管理和网络测试共用同一套连接配置,不用在终端与多个 GUI 之间来回切换。
- **历史记录,本机留存** — 工具操作自动记录在本机,支持按工具、时间范围过滤与分页,大内容按需加载,一键恢复。
- **配置可迁移** — 设置、自定义来源与连接凭据可导出、导入与重置,历史记录可一键清除;支持开机自启与任务通知。
- **简体中文优先,支持国际化** — 界面默认简体中文,内置 English,语言资源可扩展。
- **自动更新** — 通过 GitHub Releases 分发,启动时静默检查、每 24 小时复查,发现新版本才提示,一键下载并重启。

## 内置工具

本地工具不发起任何网络请求,断网可用。

| 工具 | 说明 | 亮点 |
| --- | --- | --- |
| JSON 工作区 | 格式化、压缩、校验、修复 | 支持带注释与尾逗号的 JSON;一键修复;JSONPath 路径提取;Schema 结构面板;表格预览;可编排的工作流转换 |
| 时间工具 | 时间戳与日期互转、日期计算 | 智能解析 Unix、ISO 8601、RFC3339 及常见中英文日期;真实时间面板;时区搜索;日期差与日期加减;输出格式可拖拽排序、按需显隐 |
| 文本工具集 | 测量与规范化纯文本 | 字符 / 中文字符 / 英文 / 数字 / 标点 / 词 / 句 / 段 / 行 / 字节统计;大小写转换;修剪、空格与空行压缩 |
| 文本生成 | 生成随机文本 | UUID、内置字符集与自定义字符集;长度、数量、分隔符与引号可调 |
| Base64 编解码 | 文本、图片、文件 | 自动识别编码方向与内容类型;data URL 与图片预览;解码结果保存为文件 |
| 差异对比 | 原文与修改后并排比较 | 按词 / 按字符高亮;折叠相同行;剪贴板交替填入两侧 |
| JWT 解析 | 解码 Header、Payload 与签名 | 纯前端解码,不发送任何请求;自动校验结构合法性 |
| URL 分析 | 实时拆解 URL | 基础地址 / 路径 / 哈希 / 查询参数;参数增删;URI 与 URIComponent 编解码 |
| 二维码 | 文本与二维码互转 | 生成并导出 PNG;粘贴或选择图片自动识别 |
| 图片处理 | 裁剪、扩充、压缩与格式导出 | 导出 PNG / JPG / WebP / ICO / SVG;按质量或目标体积压缩;查看尺寸、格式与体积 |

以下工具会连接你显式指定的目标(SSH 主机、容器宿主机、镜像仓库、被测地址或代理),使用前需先在工具内或「设置 → 连接」中配置连接。

| 工具 | 说明 | 亮点 |
| --- | --- | --- |
| SSH 文件管理 | 浏览、上传与下载远程文件 | 多连接与来源管理;按文件名或内容搜索;收藏目录;批量复制 / 移动 / 重命名 / 解压 / 压缩 / 下载;内置文本编辑;后台任务中心 |
| 端口工具 | 查看本机与远程端口占用 | 按协议 / 用户 / 方向 / 状态过滤;SSH 本地与远程端口转发的新增、启停与编辑 |
| 容器与服务 | 管理 Docker、PM2 与 Systemd 服务 | 本机或 SSH 目标;compose 分组;日志高亮与正则过滤;资源与性能指标;拉取镜像更新并重启 |
| 镜像管理 | 查看、推送、重命名与删除镜像 | 本地 Docker、SSH 主机与镜像仓库三类来源;架构、分层与运行时详情;导出 / 导入 tar;拉取更新;批量操作与后台任务 |
| 网络测试 | HTTP(S)、TCP、WebSocket、UDP、NTP、RTSP 连通性测试 | 粘贴 curl 导入请求;代理、DNS、出站网卡与重定向设置;阶段耗时与链路时间线;也可从 SSH 发起端发起(仅 HTTP / HTTPS) |

<!--
  截图占位:发布前请在此处补充应用主界面与各工具的截图,
  便于用户快速了解产品形态。
-->

## 安装

从 [GitHub Releases](https://github.com/northes/tinker-kit/releases) 下载最新版 `TinkerKit-<version>-darwin-universal.dmg` 安装(要求 macOS 12.0 以上):

- Apple Silicon 与 Intel 均为同一 Universal 包,无需区分架构;
- 应用内更新使用同名 `-darwin-universal.zip` 与 `SHA256SUMS` 校验文件,安装后即可自动升级;
- 本项目未使用 Apple Developer 证书,安装包为 ad-hoc 签名。若首次打开提示「已损坏,无法打开」或「无法验证开发者」,任选其一:
  - 打开 DMG,先运行其中的「修复工具」脚本(英文系统为 `Repair`),它会清除隔离标记并重新签名,之后即可正常打开;
  - 在终端执行 `sudo xattr -rd com.apple.quarantine /Applications/TinkerKit.app`,再到「系统设置 → 隐私与安全性」点击「仍要打开」。

## 快速上手

1. 首次启动后,TinkerKit 驻留在菜单栏托盘;关闭窗口只是隐藏,从托盘菜单选择「退出」才真正退出应用。
2. 复制一段 JSON、时间戳、URL、JWT 或 Base64,右键托盘图标 → 应用识别内容类型并询问是否填入对应工具(默认行为;可在「设置 → 自动化与通知」中关闭托盘识别、勾选可匹配的工具或开启「自动填充」)。
3. 任意工具内按 `⌘K` / `Ctrl+K` 打开命令面板,搜索并执行操作。
4. 使用 SSH、容器与服务、镜像管理、端口工具或网络测试前,先在「设置 → 连接」添加 SSH 配置,或直接在工具内添加连接与来源。

## 隐私与网络

- 本地工具(格式化、转换、解析、比较、图片与二维码)全程离线执行,不发起任何网络请求;应用不含账号体系与遥测。
- 唯一自动发生的后台联网行为是「检查更新」:启动后静默检查、每 24 小时复查,可在「设置 → 关于」中关闭自动检查或手动触发。
- 联调类工具只在你触发操作时连接你指定的目标;SSH 密码与私钥口令、镜像仓库密码等凭据保存在本机配置文件中。
- 配置、历史与来源保存在 `~/Library/Application Support/TinkerKit/`(`config.json`、`history.json` 与 `history-data/`),可在「设置 → 数据与安全」中清除历史,或导出 / 导入 / 重置配置(重置会恢复默认设置并删除所有自定义来源与连接凭据)。

## 开发

### 环境要求

- macOS
- Go 1.26+(以 `go.mod` 声明为准)
- Node.js 24+(仅 `frontend/` 内需要安装依赖)
- Wails v3 CLI(与 `go.mod` 中的库版本保持一致,当前为 `v3.0.0-beta.29`):

  ```bash
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.29
  ```

首次检出后需安装前端依赖:

```bash
cd frontend && npm install
```

### 常用命令

所有任务通过 `wails3 task <name>` 执行(wails3 CLI 自带 task runner,无需单独安装):

| 命令 | 说明 |
| --- | --- |
| `wails3 task dev` | 开发循环:编译 DEV 二进制,默认在 `http://localhost:9245` 启动 Vite,Go 变更热重载,前端由 Vite 热更新 |
| `wails3 task build` | 构建生产可执行文件(输出到 `bin/`) |
| `wails3 task package` | 打包 macOS 应用包(输出到 `bin/TinkerKit.app`) |
| `wails3 task darwin:package:dmg` | 生成安装镜像(输出到 `bin/TinkerKit.dmg`) |
| `wails3 task run` | 以 DEV 应用包启动已构建的二进制(需先执行一次构建) |
| `wails3 task test:go` | 运行全部 Go 测试 |
| `wails3 task test:json-repair` | 运行 JSON 修复相关的 Go 测试 |

`Taskfile.yml` 中还有若干前端共享逻辑与协议解析的单元测试任务(`test:shared-logic`、`test:ansi`、`test:image-tasks`、`test:network-target` 等),可直接单独执行。

前端类型检查与格式检查:

```bash
cd frontend
npx tsc --noEmit     # 类型检查
npm run format:check # Prettier 格式检查(npm run format 自动修复)
```

前端依赖只在 `frontend/` 内安装;前端构建产物被 `main.go` 通过 `//go:embed all:frontend/dist` 嵌入,因此任何 Go 构建前 `frontend/dist` 必须已存在。

### 项目结构

```
├── main.go                # Go 入口:窗口、系统托盘、服务注册与更新调度
├── appmenu_*.go           # 应用菜单与中英文菜单文案
├── configservice*.go      # 设置与历史持久化(ConfigService)
├── updateservice.go       # 更新轮询与调度(基于 Wails updater + GitHub Releases)
├── fileservice.go         # 本地文件读取与另存
├── json*.go               # JSON 解析、修复、工作流转换与校验
├── ssh*.go                # SSH 配置、连接、远程文件操作与命令
├── image*.go              # 镜像来源、拉取 / 推送 / 导出 / 导入与详情
├── networktest*.go        # 网络测试协议实现与阶段时间线
├── servicemanager*.go     # Docker / PM2 / Systemd 服务管理
├── portservice.go         # 端口占用扫描与 SSH 端口转发
├── frontend/              # React 19 + TypeScript 前端
│   ├── src/App.tsx        # 布局、路由与工具挂载
│   ├── src/app/           # 工具注册表、命令面板、导航与剪贴板识别
│   ├── src/components/    # 各工具组件(JsonTool / NetworkTestTool / …)与共享原语
│   ├── src/lib/           # 纯函数与共享逻辑的 *.test.mjs 单元测试
│   ├── src/locales/       # i18n 语言资源(zh-CN / en-US)
│   └── bindings/          # wails 自动生成的 TS 绑定(勿手改)
├── build/                 # Wails 构建资源配置与各平台 Taskfile
├── tools/                 # 构建期小工具(如 DMG 生成)
└── .github/workflows/     # macOS 发布流水线
```

### 技术栈

- 桌面壳:[Wails v3](https://v3.wails.io/)(Go),Go 层保持薄壳职责;
- 前端:React 19 + TypeScript + Vite;
- UI:shadcn/ui(源码内嵌,基于 Base UI)+ Tailwind CSS v4 + [Phosphor Icons](https://phosphoricons.com/);
- 编辑器:[CodeMirror 6](https://codemirror.net/)(JSON、日志、远程文本等语法高亮与差异合并视图);
- 国际化:react-i18next;
- 更新:Wails updater + GitHub Releases provider。

## 发布

推送语义化版本标签即可触发 [release-macos.yml](.github/workflows/release-macos.yml):

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流会构建 Apple Silicon + Intel 的 Universal 包,并在同一个 GitHub Release 中上传:

- `TinkerKit-<version>-darwin-universal.dmg` — 首次安装;
- `TinkerKit-<version>-darwin-universal.zip` — 应用内更新;
- `SHA256SUMS` — 文件完整性校验。

构建产物为 ad-hoc 签名的 Universal 包(当前未接入 Apple Developer 证书与公证),DMG 内附带「修复工具」/`Repair` 脚本,供首次安装时绕过 Gatekeeper。若之后需要正式分发,可在工作流中补充 Developer ID 签名与 `notarytool` 公证步骤。应用内更新固定读取公开仓库 `northes/tinker-kit` 的最新 GitHub Release。

## 贡献

欢迎通过 [Issue](https://github.com/northes/tinker-kit/issues) 报告问题、提出需求,通过 Pull Request 提交代码:

- 提交前在 `frontend/` 内通过 `npx tsc --noEmit` 类型检查与 `npm run format:check` 格式检查,并在仓库根目录执行 `wails3 task test:go`;
- 保持既有代码风格,提交信息使用英文 Conventional Commits 前缀(详见 `AGENTS.md`);
- 新增工具请遵循 `.agents/skills/tool-development/SKILL.md`,确保命令面板、历史记录、托盘匹配三处接线一致;
- 用户可见文案走 locale 文件,不硬编码。

## 许可证

本项目采用 [MIT License](LICENSE)。你可以自由使用、修改、分发本项目,包括用于商业用途,只需保留版权声明与许可声明。
