---
target: SSH 镜像本机中转拉取与任务中心
total_score: 31
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 0
target_identity: "file:/private/tmp/tk-relay-verify.yOPw08rQ/frontend/src/components/ImageManagerTool.tsx"
target_fingerprint: "sha256:32cfc5ce988961f40634c05c1eb9ce94be8fcb11f93297980ea57140a8265958"
target_path: /private/tmp/tk-relay-verify.yOPw08rQ/frontend/src/components/ImageManagerTool.tsx
timestamp: 2026-11-20T08-25-02Z
slug: frontend-src-components-imagemanagertool-tsx
---
# SSH 镜像本机中转评审

⚠️ DEGRADED: single-context（用户禁止再派代理）。模式：Operate。Wails macOS WKWebView 无 CDP；本轮只评审本机中转拉取弹窗与其任务展示，不重评 SSH 来源管理表单。

## 设计评审（先于 detector，修复前记录）

界面沿用 TinkerKit 的紧凑任务表单：拉取位置紧邻镜像与平台，选择只在 SSH 来源出现，复用有标签的 Select、主题 token、加载与错误文案。架构解析可取消且以修订号丢弃过期响应，任务中心保留取消和重试入口。没有新增控件的必要。

| 启发式 | 分数 | 证据 |
|---|---:|---|
| 系统状态可见性 | 2 | 后端阶段存在，但任务中心只展示 running，且层进度可能在中转阶段假满。 |
| 与现实世界匹配 | 3 | 目标机器/本机中转与运维操作一致。 |
| 用户控制与自由 | 2 | 再打开遗忘选择；切换位置残留平台。 |
| 一致性与标准 | 3 | 沿用 Label、Select、Button 和任务中心。 |
| 错误预防 | 2 | 位置改变后旧平台仍可被提交。 |
| 识别而非回忆 | 3 | 控件均有可见标签。 |
| 灵活与效率 | 2 | 每次打开都需重新选择中转。 |
| 审美与极简 | 3 | 无新增装饰，字段顺序清晰；未评估像素。 |
| 错误恢复 | 3 | 解析错误、取消与任务重试有既有入口。 |
| 帮助与文档 | 4 | 需求已明确中转行为、范围与取消边界。 |
| 合计 | 27/40 | 源码评审，渲染相关结论保留。 |

## 完整 P0–P3 清单（设计评审）

- P0：无。
- P1-1：`ImageManagerTool.tsx` 每次打开 relay=false，切换拉取位置不清平台选择。违反会话记忆，可能把目标平台选择带到另一执行主机。修复：按 SSH 来源在本次运行的内存保存选择，切换时取消旧请求、提升 pullRevision，并清平台、列表及错误。
- P1-2：`TaskCenter.tsx` 不展示 transferring；后端沿用拉取层数，且 `TaskMeasureView.tsx` 在字节总量未知时隐藏已传输字节，导致用户误判阶段或看不到实际计量。修复：显示本地化的传输阶段，切换为字节单位，清层计数，总量未知时显示已传输字节、不显示百分比。
- P2（设计评审阶段）：本次边界未发现。
- P3：本次边界未发现。

Alex：重复选择中转降低效率（P1-1）。Sam：位置控件有 Label/ID，解析状态有 role=status，任务阶段需要可见文字（P1-2）。Riley：快速切位置后提交旧平台，以及 transfer 阶段假满（P1-1、P1-2）。

## 机械证据与 audit

设计清单已在首次 detector 前写全。首次 detector 对 `ImageManagerTool.tsx`、`TaskCenter.tsx` 返回 `[]`。随后源码 audit 顺着计量的直接消费者发现未知总量下隐藏字节，按 P1-2 补修 `TaskMeasureView.tsx`；最终扫描需覆盖这三份文件。

源码 audit 新增完整清单：

- P0：无。
- P1：只有上文 P1-1、P1-2，已修复。
- P2-1（既有，已修复）：`TaskMeasureView.tsx` 计量行原使用 `text-[10px]`，在任务中心 Dialog 内低于项目规定的 12px。经用户选择授权，已调整为 `text-xs leading-5`（12px / 20px）；其它 class、布局、颜色与文案保持原样。
- P3：无。


## 修复后综合结论

本轮已修 P1-1、P1-2；后续经用户选择授权，P2-1 已按 Dialog 文字层级调整为 `text-xs leading-5`。本次仅更新已授权项的修复状态，未重跑评审或更改评分。修复后系统状态、用户控制、错误预防和效率分别由 2 提升为 3，设计分数为 31/40（源码评估，无法替代渲染评估）。任务标题使用「传输镜像到目标 / Transfer image to target」；进入 transferring 时清 completed/total，改用 bytes 单位，总量为零；已传输字节保持可见，百分比和 ETA 不作推算。

最终 detector 对 ImageManagerTool.tsx、TaskCenter.tsx、TaskMeasureView.tsx 返回 []，0 条发现，无新增 ignore。首次扫描后因直接消费者新增 P1 修复而重扫；没有在设计评审之前使用检测器结论。

| Audit 维度 | 分数 | 证据与限制 |
|---|---:|---|
| 可访问性 | 3/4 | 拉取位置 Label/ID、Base UI 键盘语义、架构状态 role=status、任务标题文字；P2-1 已将计量字号与行高统一为 12px / 20px，保留原评分。 |
| 性能 | 3/4 | 不新增依赖或同步重计算；字节事件仍节流，终态冲刷尾部。 |
| 主题 | 3/4 | 复用现有语义 token；未运行渲染对比，不声称对比度已测。 |
| 响应式 | 3/4 | 复用既有 grid 和窄屏分支；未运行真实窗口与缩放验证。 |
| 实现一致性 | 3/4 | 现有任务/来源/取消机制，无第二套持久化来源；detector 零发现。 |
| 合计 | 15/20 | 源码 audit，渲染验证未运行。 |

## 后端根因与最终方案

1. pull 子进程取消可返回 signal: killed，不能仅依赖 errors.Is(err, context.Canceled)。runImagePull 优先检查 ctx.Err，取消终态不保留错误。
2. load 先退出时，exec.Cmd.Wait 或 ssh.Session.Wait 会等待内部 stdin 复制；save 若还没输出，复制在 PipeReader 上阻塞，导致无法取消 save。改用 StdinPipe，由独立复制协程持有输入写端；命令退出后关闭可关闭的生产者并等待复制收尾。progressReader 和 sudo 密码前缀包装均保留 io.Closer。首次 race 检查发现 SSH CloseWrite 与 Write 并发，最终把写端关闭权限定为复制协程，race 已通过。
3. save 完成时记录其是否已取消。目标 load 失败优先于 save 因取消或关闭管道引发的错误；save 独立失败仍返回本机 stderr。save 的 stdout 只传二进制数据，stderr 单独收集。取消关闭 pipe、进程、SSH 会话，并等待工作协程退出。
4. Docker save 默认只导出现有存储平台；本机逐平台 pull 不意味着全部平台仍同时保留在本机 tag 下。保留现有本机/目标 CLI 的 all（逐平台 pull）与 Registry all（复制索引）的语义，只为 relay all 添加显式 save --platform linux/amd64,linux/arm64 等完整解析列表。缺平台、旧 CLI/daemon 不支持时明确失败，中英文错误说明恢复方式并保留 Docker stderr，不隐式回退或加控件。本机只读能力检查：Docker client/server 29.8.2，daemon API 1.56；save --help 显示 --platform strings 支持逗号分隔的平台列表。未在用户 Docker 存储中创建测试镜像。
5. 字节进度原节流逻辑会丢掉最后一窗；4.2 MB 的红测试只记录 32768 bytes。结束时用 progress(0) 冲刷尾部，失败和取消也保留实际读出的字节。

## 验证记录

| 命令 | 结果 |
|---|---|
| wails3 task common:frontend:run SCRIPT=build | 通过，含 tsc 与生产构建。 |
| wails3 task build PREBUILT_FRONTEND=true | 通过，未启动应用；任务重生成的两个图标已恢复，不进入提交。 |
| wails3 task test:go | 最终仅 TestNormalizeConfigImageSourcesAndSidebar 已知基线失败；其测试和配置实现与 17226cc 一致，未改侧栏。 |
| wails3 task test:i18n | 2/2 通过，中英文 key 一致。 |
| wails3 task test:image-tasks | 4/4 通过。 |
| wails3 task test:image-architectures | 2/2 通过。 |
| wails3 task test:shared-logic | 19/19 通过，含任务计量/不确定进度。 |
| wails3 task test:go GO_TEST_FLAGS='-race -run TestImagePullCanceledProcessIsCanceled\|TestRelay -count=1 -timeout=60s' | 通过，覆盖新增真实进程 seam 和临时回环 SSH 服务端；未连接用户 SSH。 |
| git diff --check | 通过。 |

全量 Go 某次复跑出现 TestWatchSnapshotCacheKeyedByFingerprint 偶发失败，最终全量未复现；该测试单独连续 30 次通过。源码显示 diffWatchRound 先发 snapshot，而 storeWatchSnapshot 随后才写缓存；测试只等 snapshot 就立即断言缓存，有时序窗口。imagesync.go 与 imagesync_test.go 均与起点一致；不在本轮修改范围内，未更改。

新增 imagerelay_test.go 用当前测试二进制模拟真实子进程，覆盖 4.2 MB 含 NUL/非 ASCII 字节的原样传输与 stderr 分离、阻塞 save 时 load 先失败、大流管道提前退出、save 独立失败、pull/transfer 取消、完整平台列表/缺平台/旧 CLI、进程 Wait 回收与真实回环 SSH 会话的提前失败/取消回收。夹具只用临时目录、内存配置和 127.0.0.1 临时服务端，不用私有 Registry、真实应用 config 或用户 SSH。

## 观察限制与待人工验收

agent-desktop status 显示可访问性和录屏权限已授予；已阅读 desktop/platform 指南。list-windows --app TinkerKit.dev 返回 APP_NOT_FOUND，因此没有截图，没有额外启动方式、浏览器自动化、CDP、overlay 或 GUI 操作。WKWebView 按源码评审降级，未判断实际布局、颜色、间距、对比度与动效；未改变任何 GUI 持久化状态。

真实 SSH 目标上的 sudo/命令前缀/加载结果、真实多架构远端加载仍未验证。动态交互需人工检查：首次 SSH 弹窗默认目标机器；切本机中转后重开/切来源再返回仍记住；解析期间切位置不回写旧响应，平台与错误被重置；重启应用默认恢复目标机器；传输标题/实际 bytes 可见且总量未知时无百分比。

本目标首次评审，无同一 slug 的历史趋势。初轮只自动修 P0/P1；后续用户已选择修复 P2-1，现已完成，无待处理 P2 项。本次未重跑评审，原评分、检测器结果与观察限制保持不变。
