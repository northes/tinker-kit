# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要用户是开发者或运维人员，主要在日常开发调试过程中使用。

## Product Purpose

TinkerKit 是一个本地优先的开发者工具启动器，集中提供常用的数据处理与调试工具，帮助用户快速完成格式化、转换、解析、比较和剪贴板处理等工作。产品成功的标准是让开发调试中的常见小任务能够快速完成，同时不增加敏感数据外泄风险。

## Positioning

TinkerKit 通过桌面端、本地执行、命令面板和剪贴板联动，把多个开发调试工具整合为一个无需上传数据的快速工作台。

## Operating Context

用户在日常开发、接口调试、日志排查、配置处理和运维工作中，需要频繁处理 JSON、时间戳、文本、Base64、JWT、URL、两段文本差异、二维码、图片，以及本机/远程的 Docker 镜像、系统服务与 SSH 文件。用户通常通过侧栏、命令面板、系统托盘和剪贴板在工具之间快速切换。

## Capabilities and Constraints

- 数据处理工具：JSON（格式化、校验、路径提取、流水线、表格预览）、时间与日期计算、文本、Base64、JWT、URL、差异对比、二维码。
- 资源工具：图片处理（裁剪、扩充、导出）、镜像管理（本机 Docker 与远程 Registry）、服务管理（Docker / PM2 / systemd 与远程日志）、SSH 文件管理。
- 支持命令面板、工具页导航、历史记录、侧栏工具顺序与显隐自定义、剪贴板自动识别填入，以及系统托盘联动。
- 纯本地运行，用户数据默认不上传到远程服务；仅在用户主动配置并触发时，才通过 SSH / Registry 连接远端。
- 前端使用 React + TypeScript，桌面壳使用 Wails，Go 后端保持薄层职责。
- 提供简体中文与英文两套界面文案（默认回退 `zh-CN`，可选 `en-US`），文案统一走国际化资源。
- 产品是运行在 Wails WebView 中的桌面 Web UI，当前以 macOS 为主要运行平台，未来计划支持 Windows 和 Linux。

## Brand Commitments

- 产品名称为 TinkerKit。
- 用户可见文案默认使用简体中文。
- 产品应保持开发者工具的直接、高密度和高效率特征。

## Evidence on Hand

- 现有前端工具组件位于 `frontend/src/components/`。
- 现有应用入口和工具导航位于 `frontend/src/App.tsx`。
- 现有本地化资源位于 `frontend/src/locales/`。
- 当前没有需要虚构的客户、指标、推荐语或远程服务证明。

## Product Principles

- 本地优先：敏感数据默认只在用户设备上处理。
- 快速完成：常见开发调试任务应减少切换和重复操作。
- 工具集中：相关的小工具应在统一工作台中保持一致体验。
- 可恢复：工具输入、历史和页面状态应尽量避免意外丢失。
- 桌面跨平台演进：macOS 优先，但产品能力和交互应为 Windows/Linux 支持保留空间。
