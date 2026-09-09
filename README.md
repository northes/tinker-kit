# DevUtils

> 本地优先的开发者工具启动器 —— 一个常驻 macOS 菜单栏、随叫随到的开发调试工作台。

[![简体中文](https://img.shields.io/badge/简体中文-默认-3DA639)](README.md)
[![English](https://img.shields.io/badge/English-Read%20in%20English-0078D4)](README.en.md)

DevUtils 基于 [Wails v3](https://v3.wails.io/) 构建,把日常开发调试中高频的 JSON、时间戳、日期计算、文本、Base64、JWT、URL 与差异对比等小工具,集中到一个紧凑、本地运行的桌面应用里。所有数据只在你自己的设备上处理,不会上传到任何服务器。

![GitHub release](https://img.shields.io/github/v/release/northes/dev-utils?sort=semver&label=版本)
![license](https://img.shields.io/badge/license-MIT-3DA639)
![platform](https://img.shields.io/badge/platform-macOS-000000)
![Wails](https://img.shields.io/badge/Wails-v3%20beta-DF0D3F)
![React](https://img.shields.io/badge/React-19-61DAFB)

## 特性

- **本地优先,隐私安全** — 没有账号、没有遥测、没有上传。密钥、token、日志等敏感内容始终留在设备上,处理全程离线。
- **托盘常驻,随叫随到** — 应用常驻菜单栏(无 Dock 图标),关闭窗口即隐藏到托盘。复制内容后点击托盘图标,自动识别 JSON / 时间戳 / URL / JWT / Base64 / 文本并跳到对应工具(默认询问确认,可开启「自动覆盖」免确认)。
- **命令面板,键盘直达** — `⌘K` / `Ctrl+K` 打开,支持拼音与首字母搜索,按当前上下文过滤命令;几乎所有操作都可以不从鼠标完成。
- **历史记录,本机留存** — 工具操作自动记录在本机,支持按工具、时间范围过滤与分页,大内容按需加载,一键恢复。
- **简体中文优先,支持国际化** — 界面默认简体中文,内置 English,语言资源可扩展。
- **自动更新** — 通过 GitHub Releases 分发,启动时静默检查、每 24 小时复查,发现新版本才提示,一键下载并重启。

## 内置工具

| 工具 | 说明 | 亮点 |
| --- | --- | --- |
| JSON 工作区 | 格式化、压缩、校验 | 支持带注释与尾逗号的 JSON;JSONPath 路径提取;Schema 结构面板;可编排的工作流转换 |
| 时间转换器 | 时间戳与日期互转、日期计算 | 智能解析 Unix、ISO 8601、RFC3339 及常见中英文日期;时区搜索;日期差与日期加减;输出格式可拖拽排序、按需显隐 |
| 文本工具集 | 测量与规范化纯文本 | 字符 / 中文字符 / 英文 / 数字 / 单词 / 标点 / 行 / 字节统计;大小写转换;修剪与压缩 |
| Base64 编解码 | 文本、图片、文件 | 自动识别编码方向与内容类型;data URL 与图片预览;解码结果保存为文件 |
| 差异对比 | 原文与修改后并排比较 | 按词 / 按字符高亮;折叠相同行;剪贴板交替填入两侧 |
| JWT 解析 | 解码 Header 与 Payload | 纯前端解码,不展示签名,自动校验合法性 |
| URL 分析 | 实时拆解 URL | 基础地址 / 路径 / 哈希 / 查询参数;支持 http、https、rtsp、ws、wss |

<!--
  截图占位:发布前请在此处补充应用主界面与各工具的截图,
  便于用户快速了解产品形态。
-->

## 安装

从 [GitHub Releases](https://github.com/northes/dev-utils/releases) 下载最新版 `DevUtils-<version>-darwin-universal.dmg` 安装:

- Apple Silicon 与 Intel 均为同一 Universal 包,无需区分架构;
- 应用内更新使用同名 `-darwin-universal.zip` 与 `SHA256SUMS` 校验文件,安装后即可自动升级;
- 未配置 Apple Developer 证书的构建为 ad-hoc 签名,首次打开需在「系统设置 → 隐私与安全性」中手动允许。

## 快速上手

1. 首次启动后,DevUtils 驻留在菜单栏托盘,无 Dock 图标。
2. 复制一段 JSON、时间戳、URL、JWT 或 Base64,点击托盘图标 → 应用识别内容类型并询问是否填入对应工具(默认行为;在「设置 → 剪贴板」中可关闭托盘匹配或开启「自动覆盖」)。
3. 任意工具内按 `⌘K` / `Ctrl+K` 打开命令面板,搜索并执行操作。
4. 关闭窗口会隐藏到托盘;从托盘菜单「退出」才真正退出应用。

## 隐私与数据

- 所有工具(格式化、转换、解析、比较)均在本地执行,无任何网络请求;
- 历史记录与设置保存在本机:`~/Library/Application Support/DevUtils/`,可在「设置 → 隐私」中一键清除;
- 唯一可能发起网络请求的是「检查更新」,仅向 GitHub Releases 查询版本信息。

## 开发

### 环境要求

- macOS
- Go 1.25+
- Node.js 22+(仅 `frontend/` 内需要安装依赖)
- Wails v3 CLI(当前锁定 `v3.0.0-beta.9`):

  ```bash
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.9
  ```

### 常用命令

所有任务通过 `wails3 task <name>` 执行(wails3 CLI 自带 task runner,无需单独安装):

| 命令 | 说明 |
| --- | --- |
| `wails3 task dev` | 开发循环:编译 DEV 二进制,在 `http://localhost:9245` 启动 Vite,Go 变更热重载,前端由 Vite 热更新 |
| `wails3 task build` | 构建生产可执行文件(分发到 `build/{GOOS}/`) |
| `wails3 task package` | 打包安装包 |
| `wails3 task run` | 运行应用 |

前端类型检查(无 lint/format 配置):

```bash
cd frontend && npx tsc --noEmit
```

前端依赖只在 `frontend/` 内安装;前端构建产物被 `main.go` 通过 `//go:embed` 嵌入,因此任何 Go 构建前 `frontend/dist` 必须已存在。

### 项目结构

```
├── main.go              # Go 入口:窗口、系统托盘、已绑定服务与更新调度
├── configservice.go     # 配置服务:设置持久化到 ~/Library/Application Support/DevUtils/config.json
├── updateservice.go     # 更新轮询与调度(基于 Wails updater + GitHub Releases)
├── frontend/            # React 19 + TypeScript 前端
│   ├── src/App.tsx      # 布局、路由、命令面板、剪贴板识别
│   ├── src/components/  # 各工具组件(JsonTool / TimeTool / …)与共享原语
│   ├── src/locales/     # i18n 语言资源(zh-CN / en-US)
│   └── src/bindings/    # wails 自动生成的 TS 绑定(勿手改)
├── build/               # Wails 构建资源配置与平台 Taskfile
└── .github/workflows/   # macOS 发布流水线
```

### 技术栈

- 桌面壳:[Wails v3](https://v3.wails.io/)(Go),Go 层保持薄壳职责;
- 前端:React 19 + TypeScript + Vite;
- UI:shadcn/ui(源码内嵌)+ Tailwind CSS v4 + [Phosphor Icons](https://phosphoricons.com/);
- 编辑器:[CodeMirror 6](https://codemirror.net/)(JSON 等语法高亮);
- 国际化:react-i18next;
- 更新:Wails updater + GitHub Releases provider。

## 发布

推送语义化版本标签即可触发 [release-macos.yml](.github/workflows/release-macos.yml):

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流会构建 Apple Silicon + Intel 的 Universal 包,并在同一个 GitHub Release 中上传:

- `DevUtils-<version>-darwin-universal.dmg` — 首次安装;
- `DevUtils-<version>-darwin-universal.zip` — 应用内更新;
- `SHA256SUMS` — 文件完整性校验。

签名与公证可选:在仓库 Secrets 中配置 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_APP_PASSWORD`、`APPLE_TEAM_ID` 后,流水线自动签名并公证;未配置时生成 ad-hoc 签名包,仅适合测试。也可以从 Actions 页面手动运行工作流并输入版本标签。应用内更新固定读取公开仓库 `northes/dev-utils` 的最新 GitHub Release。

## 贡献

欢迎通过 [Issue](https://github.com/northes/dev-utils/issues) 报告问题、提出需求,通过 Pull Request 提交代码:

- 提交前请在 `frontend/` 内通过 `npx tsc --noEmit` 类型检查;
- 保持既有代码风格(紧凑单行风格,详见 `AGENTS.md`);
- 新增工具请遵循 `.agents/skills/tool-development/SKILL.md`,确保命令面板、历史记录、托盘匹配三处接线一致;
- 用户可见文案走 locale 文件,不硬编码。

## 许可证

本项目采用 [MIT License](LICENSE)。你可以自由使用、修改、分发本项目,包括用于商业用途,只需保留版权声明与许可声明。
