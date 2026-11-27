# SSH 文件：远程图片预览

## 背景与目标

SSH 文件管理器对已知图片后缀仅展示图标，单击非文本文件会走文本嗅探或下载，无法在应用内查看远程图片。用户希望在标签内用与远程文本编辑器相同的浮层 Dialog 预览图片，并具备缩放、平移及常用辅助操作。

后端目前只有 `ReadRemoteTextFile`（`sshfiletext.go`），没有通过 SFTP 读取远程二进制图片并返回 data URL 的接口。本地 `FileService.ReadImageFile`（`fileservice.go`）仅服务本地路径，上限 10 MiB，格式子集与前端 `imageFileExtensions` 不一致，不能直接复用。

## 需求条目

1. **识别为图片则单击打开预览**：文件行单击时，若条目不是目录、不是符号链接，且路径后缀被识别为图片（见下文「图片后缀判定」），则打开图片预览浮层，不走文本嗅探、不自动下载。目录仍导航；符号链接保持单击下载。
2. **右键「预览图片」**：对同一图片判定为真的非目录、非符号链接文件，在右键菜单中增加显式「预览图片」项，放在「复制路径/收藏」分组之后、分隔线之后操作组内，紧挨或紧邻「用编辑器打开」逻辑位置（图片行可同时出现「预览图片」；已知文本后缀仍只显示「用编辑器打开」）。图标沿用 14px `weight="regular"`。多选时只作用于右键那一行（与编辑器菜单一致）。
3. **收藏夹打开图片**：收藏的非目录、非符号链接项若为图片后缀，打开行为与文件行单击一致，进入预览；不再对图片使用 `favoriteFileNotEditable` 或下载替代。
4. **预览壳层与文本编辑器一致**：新建 `RemoteImagePreviewDialog`（命名可微调），在 `ToolSlotOverlayContext` 内 portal，遮罩模糊、点击遮罩关闭、不盖住工作区标签栏、Esc 关闭；默认高度与远程文本编辑器同类（如 `h-[min(72vh,720px)]`），打开时即固定高度，不随图片加载后撑开。
5. **缩放与平移**：默认「适应窗口」整图可见；提供「适应窗口」「100%」切换；滚轮缩放（以指针或视口中心为参考，需 predictable）；缩放大于适应比例后可拖拽平移查看；不提供裁剪、画笔等编辑能力。
6. **底部工具条**：展示远程文件大小（来自列表已有 `entry.size` 或读取结果元数据）；**关闭**；**下载**（调用现有 `downloadSelected`，单文件）；**复制图片**（将当前预览图复制到系统剪贴板，失败时 toast）。
7. **加载与错误**：打开后显示 loading；读取失败在弹窗内展示错误（沿用 `formatBackendError`），连接类错误不回退下载；用户可通过下载按钮主动下载。
8. **后端 `ReadRemoteImageFile`**：新增 `FileService` 方法并通过 Wails 生成 bindings。通过持久 SFTP 读取远程 regular file，返回 data URL 及元数据（至少含 `mimeType`、`size`、可选 `name`）。单文件上限 **10 MiB**；超时、取消语义与 `ReadRemoteTextFile` 对齐（含 `context.Canceled` 不向已关闭弹窗抛错）。
9. **图片后缀与 MIME（后端）**：允许的后缀覆盖前端 `frontend/src/components/ssh-files/model.ts` 中 `imageFileExtensions` 全集，并补齐常用项 **`png`、`jpg`、`jpeg`**（图标映射里已有、集合里未列入）。按扩展名映射 MIME；浏览器无法解码的格式（如部分 `heic`/`raw`）允许读取成功但前端以解码失败类错误展示，不回退下载。
10. **前端图片判定**：抽出并导出 `isPreviewableImageFile(path)`（或等价），与第 9 条后缀列表一致，供单击、右键、收藏、图标逻辑共用；`svg` 若在扩展名白名单内则一并预览（MIME `image/svg+xml`）。
11. **与文本嗅探优先级**：单击时顺序为：目录 → 图片预览 → `isEditableTextFile` 或未知后缀文本嗅探 → 下载。已知图片后缀永不进入 `ReadRemoteTextFile` 嗅探。
12. **i18n**：新增文案同时写入 `zh-CN` / `en-US`（如预览标题、菜单项「预览图片」、缩放按钮、复制成功/失败等）。
13. **绑定与测试**：改动 Go 导出后运行项目既定 bindings 生成流程；为 `ReadRemoteImageFile` 增加与 `sshfilecancel_test` / 文本读取类似的取消与路径校验测试（可用现有 SFTP 测试替身，不引入 Playwright）。

## 已定决策

- **壳层对齐 `RemoteTextEditorDialog`**：同一标签内浮层 + portal，不用全屏路由页；用户已明确要 dialog 式查看与缩放平移。
- **单击图片直接预览**，不单靠右键；右键仍提供显式「预览图片」以满足与编辑器对称的心智模型。
- **10 MiB + 前端 `imageFileExtensions` 全集 + png/jpg/jpeg**：比本地 `ReadImageFile` 格式更宽，与列表图标策略一致；大于 10 MiB 报错，由用户点下载。
- **预览内提供下载与复制**，不只读关闭：复制失败用 toast，不 silent fail。
- **收藏图片走预览**，与文件行一致，避免「能看不能收藏开」的割裂。
- **需新 Go 接口并重新生成 bindings**：远程二进制不能复用文本读取管线。

## 非目标

- 不改 `remoteTextFileLimit`、不为图片复用 `ReadRemoteTextFile`。
- 不提供图片编辑、旋转、幻灯片、批量预览、侧边栏缩略图墙。
- 不处理视频/音频内嵌播放（仍下载或其它既有行为）。
- 不改变非图片文件的文本嗅探与右键「用编辑器打开」规则（`docs/requirements/2026-11-27-ssh-file-text-probe.md` 仍然有效）。
- 不使用 Playwright / `agent-desktop` 作为验收依据。

## 验收标准

1. 单击远程 `photo.png`（&lt; 10 MiB）→ 标签内预览弹窗，适应窗口显示，滚轮可放大，放大后可拖移；不触发下载。
2. 右键 `diagram.webp` → 有「预览图片」，行为与单击一致。
3. 收藏的图片文件从收藏栏打开 → 进入预览，无 `favoriteFileNotEditable`。
4. 超过 10 MiB 的图片 → 弹窗内错误，可点下载成功拉起现有下载任务。
5. `app.json` 等非图片已知文本、无后缀嗅探、符号链接、目录行为与改动前一致。
6. 预览中「复制图片」在支持剪贴板写入的环境成功并 toast；下载按钮与列表下载同源任务流。
7. 弹窗打开时可切换工作区标签；切回后状态符合 `layout-guidance` 工具弹窗约定。
8. `wails3 task` 相关类型检查/构建与项目 `project-validation` 对本次 diff 的要求通过。

## 待定问题

- 无。

## 变更记录

- 2026-11-27：初稿，对齐用户选择（dialog 预览、缩放平移、10 MiB、全 imageFileExtensions、菜单与收藏、下载与复制）。
