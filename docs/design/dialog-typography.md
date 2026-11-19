# 对话框文字层级

本文是 `DESIGN.md`「Dialog 文字层级」的展开版，记录对话框内每类文字的规格、落点与本次统一的逐处对照。改对话框文案或新增对话框时按本文取值，不要临时指定字号。

## 标准

对话框内只用三档字号，次要信息靠颜色、字体和字距区分，不靠字号递减。

| 角色 | 字号 / 行高 | 颜色与字体 | 典型 class |
|---|---|---|---|
| 标题 `DialogTitle` | 16px / 1（`text-base leading-none font-medium`） | 正文色，medium | 组件默认，不覆盖 |
| 字段标签 `Label`、行标题 | 14px / 1 | 正文色，medium | 组件默认，不覆盖 |
| 描述 `DialogDescription` | 12px / 20px | muted | `text-xs leading-5 text-muted-foreground`（组件默认） |
| 字段提示、状态行、空态 | 12px / 20px | muted | `text-xs leading-5 text-muted-foreground` |
| 校验错误、错误状态 | 12px / 20px | destructive | `text-xs leading-5 text-destructive` |
| 小节标签 | 12px / 20px | muted，medium，必要时等宽大写加字距 | `text-xs font-medium text-muted-foreground` |
| 代码与技术值（路径、引用、指纹、Tag、架构） | 12px / 20px | 等宽；主值用正文色，辅助值 muted | `font-mono text-xs leading-5` |
| 行内元信息（时间、进度、状态、注释） | 12px / 20px | muted，数字 `tabular-nums` | `text-xs tabular-nums text-muted-foreground` |

### 硬性规则

- 对话框内不出现 `text-[10px]`、`text-[11px]`。
- 说明文字不用 14px（`text-sm`）；14px 只属于字段标签和行标题。
- 新增对话框不单独写描述字号：`DialogDescription` 的默认值就是标准值。
- 提示文字与输入框的间距沿用既有 `gap`，不因字号变化调整间距。

### 为什么不把 10px 留在对话框里

10px 是工具页里等宽大写结构标签的档位（`DESIGN.md` 的 label 层），用于 12px 正文旁边的辅助刻度。对话框是窄幅、居中的决策表面，内容以句子为主，10px 会让同一句话在 12px 提示旁明显偏小；因此对话框内统一升到 12px，等宽大写与字距保留，作为层级信号。

## 本次统一的逐处对照

| 文件 | 位置 | 改前 | 改后 |
|---|---|---|---|
| `components/ui/dialog.tsx` | `DialogDescription` 默认样式 | `text-sm` | `text-xs leading-5`（颜色仍为 muted） |
| `components/TaskCenter.tsx` | 并发设置说明 | `text-[10px] leading-tight` | `text-xs leading-5` |
| `components/TaskCenter.tsx` | 任务行元信息、失败详情、时间与进度行 | `text-[10px]` | `text-xs`（进度行保留 `tabular-nums`） |
| `components/JsonTool.tsx` | 格式化时间提示 | `text-sm` | `text-xs leading-5` |
| `components/SettingsPage.tsx` | 主机匹配项提示、备注行 | `text-[10px] leading-4` | `text-xs leading-5` |
| `components/SettingsPage.tsx` | 指纹列表空态 | `text-sm` | `text-xs leading-5` |
| `components/SettingsPage.tsx` | 指纹复制按钮 | `text-[11px]` 局部覆盖 | 去掉覆盖，恢复 Button `size="sm"` 官方尺寸 |
| `components/TextGeneratorTool.tsx` | 自定义源空态 | 继承 14px | `text-xs leading-5` |
| `components/ImageManagerTool.tsx` | 重命名预览里的单项错误 | `text-[10px]` | `text-xs` |
| `components/PortForwardTool.tsx` | 转发表单错误 | `text-sm` | `text-xs leading-5` |
| `components/NetworkTestTool.tsx` | 高级选项 5 段说明、请求体开关说明 | `text-[10px] leading-relaxed` | `text-xs leading-5` |
| `components/SshFilesTool.tsx` | 上传目标提示、同名冲突提示 | `text-[10px] leading-4` | `text-xs leading-5` |
| `components/SshFilesTool.tsx` | 上传目标、目录树字段标签 | `Label text-xs text-muted-foreground` | `Label` 默认（14px medium） |
| `components/SSHProfileManagerDialog.tsx` | 配置行地址与来源 | `text-[10px]` | `text-xs` |
| `components/TargetHostManagerDialog.tsx` | 目标主机行副信息 | `text-[10px]` | `text-xs` |
| `components/ssh-files/CreateEntryDialog.tsx` | 名称提示与创建错误 | `text-sm` | `text-xs leading-5` |
| `components/service-manager/LogFilterHelp.tsx` | 示例查询代码 | `text-sm` | `text-xs` |
| `components/service-manager/ResourcePanel.tsx` | 日志高亮说明 | `text-sm` | `text-xs leading-5` |
| `components/service-manager/ResourceInfo.tsx` | 原始 JSON 预览 | `text-[11px]` | `text-xs` |

保持不变：`DialogTitle`（16px）、`Label`（14px）、列表行标题（14px）、对话框内按钮（组件自带尺寸）、日志语法帮助里的示例标题 `dt`（14px medium，属行标题）。
## 检查方式

- 搜索：在 `frontend/src/components` 中查 `text-[10px]`、`text-[11px]`、`text-sm`，只允许出现在非对话框结构或字段标签上。
- 中英资源同步：改字号不改文案，不涉及 locale。
- 构建：`wails3 task common:frontend:run SCRIPT=build`。
