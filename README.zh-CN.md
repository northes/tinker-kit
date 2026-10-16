<div align="center">

<h1>
  <img src="assets/logo/tinkerkit-logo.svg" alt="TinkerKit" height="52" align="middle">
  TinkerKit
</h1>

<img src="https://skillicons.dev/icons?i=go,react,ts,vite,tailwind,docker&perline=8" alt="Go、React、TypeScript、Vite、Tailwind CSS、Docker" height="44">

### 一个工作台,覆盖每一项开发调试任务

拆解 JSON、时间戳、JWT、SSH 主机、容器与网络请求:15 个工具收在一个本地优先的 macOS 应用里,无需部署任何服务。

[![版本](https://img.shields.io/github/v/release/northes/tinker-kit?sort=semver&label=版本)](https://github.com/northes/tinker-kit/releases)
[![下载](https://img.shields.io/github/downloads/northes/tinker-kit/total?label=下载)](https://github.com/northes/tinker-kit/releases)
[![license](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-000000)](#安装)
[![Wails](https://img.shields.io/badge/Wails-v3%20beta-DF0D3F)](https://v3.wails.io/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)

[下载](https://github.com/northes/tinker-kit/releases) · [安装说明](#安装) · [内置工具](#内置工具) · [隐私与网络](#隐私与网络) · [English](README.md)

<img src="assets/screenshot.png" alt="TinkerKit 主窗口" width="100%">

</div>


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

## 许可证

本项目采用 [MIT License](LICENSE)。你可以自由使用、修改、分发本项目,包括用于商业用途,只需保留版权声明与许可声明。
