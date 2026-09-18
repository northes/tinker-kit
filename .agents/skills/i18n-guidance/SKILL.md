---
name: i18n-guidance
description: 仅在新增或修改用户可见文案、locale 资源、语言设置或 Go 托盘中英文文案时使用。无文案变化的布局、样式或算法修改不要使用本 skill。
user-invocable: false
---

# 国际化

默认语言、回退语言，以及“用户可见文案必须走 i18n 资源”见 `AGENTS.md`。本 skill 只覆盖资源文件、key 组织和托盘语言分支。

## 资源与初始化

- i18n 在 `frontend/src/i18n.ts` 初始化；`frontend/src/main.tsx` 只通过 `import './i18n'` 确保初始化发生在渲染前。
- 语言资源统一放在 `frontend/src/locales/`，当前维护 `zh-CN.json` 和 `en-US.json`。
- 新增语言时同步更新 `SUPPORTED_LANGUAGES`、资源注册和设置页语言选项。
- 不把持久化 ID、工具 ID、主题 ID 或事件名直接作为用户可见文本；显示名称使用 locale key。

## 组件与文案

- React 组件、`App.tsx`、命令面板、历史记录和设置页使用 `useTranslation()` 或 `t()`。
- 新增或修改用户可见文案时先定义稳定的 key，再同步更新 `zh-CN.json` 和 `en-US.json`；不得只修改单一语言资源。
- 命令面板的 `labelKey` 复用实际界面按钮文案；只有切换型命令才使用独立的 `commands.toggleXxx` key。
- locale key 按领域组织，例如 `tools.<id>`、`<tool>Tool.*`、`commands.*`、`settings.*`；不要为同一文案建立重复 key。
- 同一操作的单选/多选文案使用成对 key（`xxx` 与 `batchXxx`），仅当操作作用于整个选择集时才用批量版本；批量语义由 key 表达，不要在组件里拼接“批量”前缀。
- 翻译缺失应在资源层修复，不在组件中增加英文、中文或默认字符串兜底分支。
- 插值变量不要命名为 `count`：i18next 会把它当成复数选择器，缺少 `_other` 变体时整条文案回退成 key。数量类文案改用 `total`、`matched`、`suffix` 等命名。
- 移除某处 UI 时同步删除只为它存在的 locale key；新增或改名 key 时保持中英资源 key 结构一致，不留单语 key。

## 名称与失效引用

- 来源、配置等实体的显示名称不得回退为内部 ID（例如把 slug 或主键当作名称）；名称为空时用所引用实体的名称。
- 关联实体已失效时显示专门的 locale 文案，不要显示原始 ID。
- 名称可留空的表单，用 placeholder 展示将要采用的默认名称，让“留空即默认”可预期。
- Go 层做展示名的默认值与规范化时同样遵守本节，见 `wails-integration`。

## Go 托盘文案

- Go 托盘菜单不运行 React i18next；文案必须遵循当前配置的语言分支，并保持默认中文可用。
- 修改托盘菜单或 tooltip 时同步检查中文和英文分支；不要把前端 locale key 当作托盘显示文本。
- 托盘文案和前端对应功能使用相同的产品术语；新增菜单项必须接通实际事件。

## 静态检查

- 搜索新增代码中的硬编码用户可见字符串，确认已迁到 locale；允许日志、错误类型、协议值和内部 ID 保持代码常量。
- 检查中英文资源的 key 结构一致；文案变更时确认对应 key 在两种语言资源中均已更新。
