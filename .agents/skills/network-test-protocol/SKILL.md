---
name: network-test-protocol
description: 仅在为网络测试工具新增或修改协议实现时使用（后端 runner、协议识别与目标补全、阶段与链路时间线、代理/隧道与认证、重定向与序号）。纯 UI 样式、文案或其它工具的修改不要使用本 skill。
user-invocable: false
---

# 新增网络测试协议

网络测试工具的每个阶段既是进度也是结论：用户只看阶段列表与时间线来判断「这次成功意味着什么」。
新增协议时，先保证阶段的语义、顺序与时间都成立，再考虑功能本身。

现有协议：`http`、`websocket`、`tcp`、`udp`、`ntp`、`rtsp`。工具级接线（`ToolId`、导航、历史、托盘）
与协议扩展无关，见 [tool-development](../tool-development/SKILL.md)；布局细节见
[layout-guidance](../layout-guidance/SKILL.md)。

## 接线清单

后端 `networktestservice.go`：

1. `RunNetworkTest` 的协议分支；
2. `parseNetworkTarget`：目标形式（`host:port` 或 URL）、默认端口、scheme 校验与凭据规则；
3. 新阶段 ID 加入 `currentStageForHop` 的两个列表（运行中优先、失败回退），否则失败会被归到别的阶段；
4. `runXxx` runner（参考 `runTCP`、`runRTSP`）；
5. 系统代理 `proxyFor`；UDP 类协议要处理 `openUDPChannel` 对 HTTP 代理的不支持（给明确错误）。

前端 `NetworkTestTool.tsx` 与 `frontend/src/lib/network-target.ts`：

6. `Protocol`、`protocolItems`；
7. `stageOrder`：新阶段必须登记，否则会排到时间线末尾；
8. `detectTargetProtocol`（scheme + 端口启发式）与 `automaticTarget`（补全默认 scheme/端口）；
9. 高级选项**全部展示**，不按协议过滤（协议用不到不等于要藏起来：用户常常先配好再切协议）；
   校验只针对当前协议真正会用的项（TLS 跳过校验、重定向次数、UDP payload）；
10. locale：`protocol.*`、`target.placeholder.*`、`stages.*`（zh-CN 与 en-US 同步）。

## 协议实现规则（每条含真实原因）

### 1. 凭据规则按协议定义，且前后端各有一份

原因：RTSP 用 URL 内嵌凭据（`rtsp://user:pass@host/path`）做 Digest/Basic 认证是常态，HTTP/WebSocket
不应接受；只改后端会让前端自动识别显示「未识别」（同一规则在两处）。

做法：`parseNetworkTarget` 把 `user:pass` 提取到 `creds` 并从 URL 移除，其它协议仍拒绝；`detectTargetProtocol`
同步放行。凭据只经 `Authorization` 头发送，不进入请求行、阶段元信息或错误信息；错误里给脱敏目标与
`user:password@host` 形态示例，跳转跨主机时丢弃凭据并在 meta 标注。

### 2. 每个阶段先上报 running 再执行

原因：只在完成后上报，等待期间界面没有计时也没有时间线（表现为「失败后才冒出来」，且起点落在失败时刻）。

做法：发送前 `stage(id, "running", {Request: ..., Meta: ...})`，完成时再 success/error；失败会沿用 running 的
`StartedAt` 与 `Request`。TLS 握手、DNS 解析等短操作同样先 running。响应迟迟不来时，结论要说明
「服务端未回一个字节」而不是只显示 `i/o timeout`。

等待类阶段的起点是「请求写完」，不是「响应开始到达」：HTTP 的 `http-response` 在 `WroteRequest` 就置为
running（首个字节到达只更新元信息），WebSocket 握手在 `WroteHeaders`，RTSP/UDP 在发送后即置为 running，
HTTPS/WSS 经 HTTP 代理时在发出请求前就把 `proxy-tunnel` 置为 running——否则等待与超时的整段时间没有
阶段覆盖，失败项会以 0 毫秒贴在时间线末尾。

新增协议时按这条复核每一段：DNS 解析、拨号（含 SOCKS5/HTTP 代理）、TLS 握手、请求写出与等待响应、
CONNECT、数据报收发——每段都要能回答「谁在 running、失败落在哪个阶段、起点是不是这一段开始」。

### 3. 同一操作跨多次尝试必须按跳次拆分阶段

原因：重连/重试复用同一阶段 ID 时，`stage()` 保留首次 `StartedAt`、采用最后一次耗时，拼出不对应任何
真实区间的「假时间条」，而重连的真实窗口消失——时间线因此显得不连贯。

做法：用 `networkRoute.hop`（HTTP 走 `requestTrace`）统一加 `-redirect-N` 后缀，覆盖 `dns-*`、`tcp-connect`、
`tls`、`proxy-tunnel` 与协议自身阶段；不变量：已完成阶段满足 `durationMillis == finishedAt - startedAt`。

### 4. 序号类协议按「消耗」返回下一个可用值

原因：认证重试复用 CSeq 会让后续请求重号；阶段展示首次序号会与响应回显不一致。

做法：exchange 返回 `nextSeq`（或消耗数），runner 用它排下一请求；阶段展示**最终被接受**的请求与响应；
测试服务端校验「同一连接内序号不重复」。

### 5. 认证：优先 Digest，只重试一次

做法：解析 `WWW-Authenticate`，Digest 优先（MD5/SHA-256、`qop=auth` 带 nc/cnonce、`opaque`、`-sess`），
Basic 仅在服务端只提供 Basic 时使用；同时下发两者时不回退明文。挑战重试一次即止；缺凭据与被拒要有
不同结论，认证过程单独记一条阶段。

### 6. 我们自己写的文案一律走多语言 key

原因：阶段错误、阶段说明与页脚结论都是产品文案，直接写英文字符串会让中文界面出现英文；而同一结论
在阶段与页脚两处各写一遍还会不一致（曾出现「页脚带系统代理提示、阶段里没有」）。

做法：按 `localizederror.go` 的约定返回 `{"key","params","detail"}`（`networkTestError*` /
`networkTestText`，key 形如 `networkTestTool.backend.*`，文案放 `frontend/src/locales/*` 的
`networkTestTool.backend.messages`）；`detail` 保留不翻译的外部文本（系统与库错误、协议原文），前端
`formatBackendError` 会递归渲染嵌套的 detail。阶段错误与页脚结论必须由**同一个**合成函数产生
（参考 `composeFailureHint`），不要在两处各拼一次。协议数据（状态行、头部、SDP、hex、体内容）保持
原样，不套 key。

### 7. 错误结论取自上下文，不从错误文本猜

原因：运行超时或取消会主动关闭连接，读操作返回 `use of closed network connection`；`EOF` 与
`ECONNRESET` 会随关闭时机交替出现。

做法：先看 `ctx.Err()`（超时/取消各给对应结论），再用「是否已收到过字节」区分「对端未响应即关闭」与
「响应中途关闭」，不要依赖平台错误码。

### 8. 「连接成功」不等于「设备可达」

原因：VPN/代理 TUN 会在本机应答 SYN——同网段不存在的地址也能「连上」；`connect` 成功只证明本机内核
完成了握手，用户会把「建立 TCP 连接 成功」读成设备可达。

做法：记录真实 `localAddress`（不要写 `automatic`）；用 `probeTunnelOutbound`（`networktestroute*.go`）
探测出口，识别隧道后按连接列出 `tunnel-route` 阶段，并在连接阶段标 `outbound=tunnel` /
`reachability=unverified`；界面用警示色与「经 X 出口 · 目标可达性未验证」提示。**每条经隧道的连接各有
一项**（按跳次加后缀），不要做「每次测试只列一条」的去重。

经代理的连接同理要有说明项：连到代理服务器的那次拨号在 `tcp-connect` 标 `outbound=proxy` / `proxy` /
`reachability=unverified`；只有 HTTPS/WSS 经 HTTP 代理才存在 CONNECT（`proxy-tunnel`），**明文 HTTP 经
HTTP 代理是绝对形式转发、没有隧道**，不要虚报 `proxy-tunnel`。

失败结论要给可执行的下一步：直连失败且本机配置了系统代理时，追加系统代理提示
（`directConnectionHint`，只针对连接被丢下类失败、用连接与代理配置作依据）。浏览器通常走系统代理、按
域名分流，而直连流量落到 TUN 后按 IP 处理，可能被接受连接后直接丢弃——这是「浏览器能访问、工具失败」
最常见的差异，不能用「连接成功」推断路径正确。

### 9. 重定向：跟随、限额、拆阶段

做法：复用 HTTP 的「重定向次数」（按请求链计数，0–10）；重建连接后重发同一请求、序号继续递增；
`Location` 支持绝对地址与相对路径；指向非本协议 scheme 报错；超限时错误写明「被上限拦住」；跳转本身
记在发起跳转的那一跳，跟随后的请求用 `-redirect-N` 后缀；前端 3xx 用警示色而非失败色。

### 10. 共享拨号路径的重构要覆盖所有协议分支

原因：`runTCP` 曾改为无条件调用 HTTP CONNECT 隧道函数，无代理时 `proxyURL` 为 nil → panic；当时只有
RTSP 有测试，问题不会被发现。

做法：改动 `dialContext` / `openXxxStream` / `dialDirect` 后，为「直连」「HTTP 代理」「SOCKS5」「指定
出站网卡」各留一条测试。

### 11. UDP 类协议

HTTP CONNECT 不转发数据报，要在路由阶段给明确错误；没有回包的结论必须说明「UDP 不保证回复，不代表
目标不可达」（参考 `exchangeDatagram`）。

### 12. 明文请求没有任何响应时要判定「端口是否只接受加密连接」

原因：只提供 TLS 的设备（摄像头、NVR 常把 rtsps 绑在 554 这类端口上）收到明文请求会直接关闭连接，
明文协议侧只看得到「一个字节都没收到 + EOF」。把它写成「对端关闭了连接」会把用户引向设备，而真正
的原因是协议前缀——真实案例：`rtsp://…:554` 对 Dahua 设备返回 EOF，换成 `rtsps://…:554` 立刻成功；
`http://…:443` 同理。

做法（`networktestsecure.go`）：明文 scheme（`http`/`ws`/`rtsp`）已经写出请求、却一个响应字节都没收到
（`WroteRequest`/`WroteHeaders` + 首字节标记，不要从错误文本猜）时，走同一条链路再做一次连接，完成
TLS 握手并重放同一份请求，**只有读到该协议自己的状态行才算证据**；然后给出「该端口只接受加密连接，
改用 `https`/`wss`/`rtsps`」的结论与可直接替换的示例目标（端口必须显式保留，密码只占位）。

- 证据单独成阶段 `tls-probe`：先 running 再收尾，拿不到证据也要收尾（说明「没有证据说明失败来自加密
  前缀」，原始失败文本放元信息），不能停在 running，也不能在末尾贴 0 毫秒项；
- 探测固定跳过证书校验：自签名证书是这类设备的常态，这一步判断的是「端口是否提供 TLS」而不是信任；
  它不发送凭据，重放的请求与用户刚以明文发往同一地址的请求完全相同；
- 探测期限由运行上下文派生（`secureEndpointProbeTimeout` 只是上限）：运行期限已用完或用户已取消时
  不再探测，否则会把一次「失败」拖成「超时」，也会让结果多等一段诊断时间；
- 给出加密结论后不再叠加系统代理提示（`secureEndpointReported`）：原因已经确定，通用建议只会分散
  注意力；
- 直接用 `tls.Client` 的路径（rtsps、探测）必须显式给 `ServerName`：`http.Transport` 会自己补，缺了它
  启用证书校验会直接失败（`tls: either ServerName or InsecureSkipVerify must be specified`）。
- 证书校验失败（自签名、主机名不符）要给可操作结论（`tlsCertificateUntrusted` + 高级选项里的「跳过
  TLS 证书校验」），不要把 x509 原文直接抛给用户；翻译函数要幂等，因为同一次握手可能在阶段上报与最终
  结论里各经过一次。

`tls-probe` 只承载诊断，永远不是本次运行失败的原因，因此不进 `currentStageForHop` 的两个列表。

### 13. 请求身份头（User-Agent）由用户决定，按协议发出

原因：设备与中间盒常按 User-Agent 分流（同一个地址用浏览器可以、用工具不行就是这个原因）；工具的
默认标识（`TinkerKit Network Test`）必须可替换，否则这类差异无法复现或对照。

做法：高级选项里的 User-Agent 有「工具默认 / Chrome 与 Firefox 预设（macOS、Windows 各一份）/
自定义」三种来源，空值表示默认；HTTP、WebSocket 与 RTSP 都按设置发送，**加密探测的重放也用同一个
值**，否则重放的不是同一份请求。预设放在 `frontend/src/lib/network-test-user-agent.ts`：版本号只
写在预设的 `version` 字段里，UA 串与下拉标签（locale 里的 `{{version}}`）都由它生成，避免标签与串
版本不一致；纯函数的往返与格式由 `wails3 task test:network-user-agent` 覆盖。WebSocket 握手默认带 Go 的
User-Agent，要显式覆盖。值里的 CR/LF 一律去掉（`sanitizeHeaderValue`，配置规范化与请求构造两处都
要）：它直接写进手写的 RTSP 请求文本，不能让它切断报文或插入头部行。

## 呈现规则

- 阶段标签只由 `stages.<id>` 提供；带状态码的阶段按状态码取色（`stageResponseTone`）：HTTP 响应阶段始终
  按状态码，协议请求阶段仅在非失败时按状态码，3xx 用警示色。
- 有前提的「成功」要显式标注（例如经隧道的握手）；同一信息不要既标警示又不解释。
- footer 的「文案 + 复制图标」按钮用 `w-fit` 紧贴（配 `min-w-0 max-w-*` 与 `shrink`），不要用 `flex-1`
  撑满，否则图标会被推到最右端、文本与图标之间出现大段空白。
- 阶段行的说明文字（DNS 解析摘要、重定向标记、经隧道/经代理提示）可能长于行宽：用无滚动条的横向滚动
  元素展示，两端按实际溢出量渐隐（`.no-scrollbar` + `.scroll-fade-x`，照 `StageHintLine` 自更新
  `--scroll-area-overflow-x-*`），不要截断成省略号。**不要在这里套 `ScrollArea`**：它固定给内容加 4px
  内边距（为焦点环预留），用负 margin 抵消会把文字压到裁切边缘，并在左端留下假渐隐（左端应完全可见）。
- 工具页标题与提示位置沿用 [layout-guidance 的工具页布局](../layout-guidance/SKILL.md#工具页布局)。

## 验证

1. 本地最小协议服务端（参考 `networktestservice_test.go` 的 `serveTestRTSP`、`serveAuthenticatedTestRTSP`、
   `serveRedirectingTestRTSP`），至少覆盖：正常、认证挑战、凭据被拒、缺凭据、接受连接但不回包（超时）、
   对端立即关闭、取消、重定向（含跨主机与超限）、时间线不变量。
2. 真实服务端/设备交叉验证：临时脚本放在 scratch 目录，验证后删除；**不要把仅测试用的依赖写进
   `go.mod`**（例如临时 module 里跑 gortsplib 做对照）。
3. 命令验证在实现完成后由 `project-validation` 按 diff 统一执行，不在此处另跑构建或格式检查。协议识别与补全属纯函数，放
   `frontend/src/lib/network-target.ts`，用 `wails3 task test:network-target` 覆盖。
4. 每个协议都要留一条时间线用例，并用 `assertStageTimeline`（`networktestservice_test.go`）复核
   「耗时 == finishedAt - startedAt」：这条不变量一旦被破坏，界面就会出现假时间条。
5. 定位真实设备问题时的取证顺序（结论必须来自证据）：
   `route -n get <ip>` 看谁应答 → 同网段不存在地址做对照 → `arp -n` → 绑定物理接口重试（macOS
   `IP_BOUND_IF`，只影响该 socket，不改系统路由）→ 原始报文探测（`OPTIONS *`、完整 URL、不同 UA 对照）。
   不要用「连接成功」推断设备可达，也不要在缺少对照实验时把超时归因于协议实现。

## 提交前的静态检查

- 协议 ID 在后端分支、前端 `Protocol`/`protocolItems`、`stageOrder`、`detectTargetProtocol`、
  `automaticTarget`、locale 中一致出现；
- 每个新阶段都能回答：何时上报 running、失败时归到哪个阶段、经隧道/经代理时是否额外列出说明项；
- 有重定向或重试的协议：阶段按跳次拆分，序号不重复，跨主机不带凭据。
