# 镜像管理支持本地 Registry（明文 / 跳过校验 / 自定义 CA）

状态：已对齐。实现时以本文「已定决策」与「需求条目」为准。

## 背景与目标

镜像管理的 Registry 来源目前只接受 https 且强制标准证书校验：

- `configservice.go:331` `normalizeRegistryURL` 要求 `u.Scheme == "https"`，规范化后强制拼回 `https://<host>`，并拒绝凭据、查询参数、路径。
- `imageregistry.go:25` `registryEndpoint` 只把 Host 交给 `name.NewRegistry(...)`，不带 `name.Insecure`，所以 remote 一律走 https scheme。
- `imageservice.go:658` `pingRegistry` 用同一个 normalize 的结果拼 `/v2/` 探活，明文 registry 连状态都探不出来，直接报 `errors.image.registryURLHTTPSOnly`。
- `imageregistrytransfer.go:57` 反推来源时硬编码 `"https://" + registry`。

结果是本地/内网的常见形态全都用不了：`registry:2` 默认的明文 HTTP、自签证书、内网 CA 签发的证书。IP 和端口本身不是障碍（`https://192.168.1.10:5000` 能过校验），挡住的是 scheme 和证书校验。

目标：每个 Registry 来源可选四种传输模式，让明文 HTTP、跳过校验、自定义 CA 三种本地形态真的能连通，同时不改变现有 https 来源的行为与安全默认值。

## 需求条目

1. `ImageSource` 新增三个持久化字段（Go 导出 + 重新生成 bindings，不手工编辑 `frontend/bindings/`）：
   - `registryTransport`：`"tls"` | `"tlsSkipVerify"` | `"tlsCustomCA"` | `"plaintext"`；空值等同于 `"tls"`。
   - `registryCAPath`：CA 证书 PEM 文件路径。
   - `registryCAPEM`：直接粘贴的 CA 证书 PEM 文本。
2. 传输模式互斥单选，语义如下：
   - `tls`：https + 标准证书链与主机名校验（= 今天的唯一行为）。
   - `tlsSkipVerify`：https，跳过证书链与主机名校验。项目内已有同类先例：网络测试的 `SkipTLSVerify` → `networkTLSConfig`（`networktesthttp.go:419`）。
   - `tlsCustomCA`：https，用 `registryCAPath`（优先）或 `registryCAPEM` 作为根证书池，仍校验主机名。
   - `plaintext`：http 明文，允许 Basic Auth（密码明文传输，需提示）。
3. 地址必须显式带 scheme（`http://` 或 `https://`），IP 与端口直接写在主机后（`http://192.168.1.10:5000`）。
4. scheme 必须与传输模式一致：`plaintext` 只能配 `http://`，其余三种只能配 `https://`；不一致保存报错，不自动改写地址。
5. 明文 HTTP 不限主机范围（不限制回环/私网），靠 UI 风险提示告知。
6. 自定义 CA 必须有所给：选 `tlsCustomCA` 时 `registryCAPath` 与 `registryCAPEM` 至少填一个，两者都空保存报错；两者都填时以路径优先，且不报错。
7. CA 路径保存时只校验路径格式（非空、长度上限、不以 `-` 开头），不读文件；文件读不到或 PEM 解析不出证书，在连接/探活阶段报错。与现有 SSH 私钥路径的处理一致（`configservice.go:480`）。
8. 非 `tlsCustomCA` 模式归一化时清空 `registryCAPath` 与 `registryCAPEM`，同现有「ssh 分支清空 registry 字段」的做法。
9. `imageSourceFingerprint` 必须把传输模式与用于建链的 CA 内容（或路径）纳入指纹，避免缓存 key 在信任策略变化后不变。
10. 前端表单：Registry 来源编辑弹窗新增「传输安全」单选（4 项）；选 `tlsCustomCA` 时显示「CA 证书文件路径」输入与「或粘贴 CA 证书（PEM）」多行输入；选 `plaintext` 或 `tlsSkipVerify` 时在该控件下显示一行风险提示（`plaintext` 额外说明用户名密码会以 Basic Auth 明文传输）。
11. 前端来源列表：非 `tls` 模式的 Registry 来源显示标记（`HTTP` / `跳过校验` / `自定义 CA`），一眼能看出哪些来源不是标准校验。
12. 文案中英双份，`zh-CN` 与 `en-US` 都补齐，key 结构对齐（`test:i18n` 必须通过）。

## 已定决策

### 支持范围

- 必须真的连通三种本地形态：明文 HTTP（如 `http://192.168.1.10:5000`、`http://localhost:5000`）、自签证书 HTTPS（如 `https://192.168.1.10:5000`）、内网 CA 签发的 HTTPS。不是只放过校验。
- 不改公共证书 + https 这条默认路径的行为。

### 传输安全表达方式

- 用互斥的「信任模式」单选，不做「scheme + 跳过校验开关 + CA 路径」的可组合字段。原因：可组合字段会出现 `http` 配「跳过校验」这类无意义组合，还要额外校验。
- 模式取值固定为 `tls` / `tlsSkipVerify` / `tlsCustomCA` / `plaintext`，其中 `tls` 是零值等价物。

### 自定义 CA 的提供方式

- 路径与粘贴 PEM 两者都支持：有路径用路径，否则用粘贴内容。
- 路径只存字符串，不复制文件内容进配置；粘贴的 PEM 直接存配置文件的 `registryCAPEM`。
- 两者都空时保存报错，不退化为别的信任方式。
- 前端沿用现有输入习惯，使用文本框填路径（项目内没有系统文件选择器调用先例，SSH 私钥路径同样是文本输入）。

### 地址与校验

- 必须显式带 scheme，不学 Docker 的「不写就猜」隐式降级。
- scheme 与模式矛盾时报错，不自动纠正。
- 明文 HTTP 不限主机，不做回环/私网白名单（会挡住 Tailscale 100.64/10、内网域名等）。
- CA 路径保存时只校验形状；文件读取与 PEM 解析放在建链阶段，报错信息要能定位到具体来源。

### 风险提示

- 表单内联提示 + 来源列表标记，两处都要有；只在表单里提示不够。

### 存量配置

- 老配置没有这三个字段，零值解析为 `tls`，URL 原本就是 `https://...`，因此与今天行为完全一致，不做迁移、不写默认值到磁盘。

## 非目标

- 不支持匿名/其他认证方式变更，不引入 token/refresh token 手填。
- 不做「不写 scheme 自动推断」，不做明文/自签的主机白名单。
- 不改 registry 的仓库列表、tag、manifest、删除、拉取等既有功能语义。
- 不改 SSH 来源、本地 Docker 来源、镜像导出/导入的其它路径。
- 不新增全局 `TLS 跳过校验` 配置项，也不改网络测试工具的 `SkipTLSVerify`。
- 不引入系统文件选择器、不改设置页其它控件。
- 不调整应用范围内其它工具的传输层。

## 验收标准

- 现有只配置了 `https://registry-1.docker.io` 之类来源的用户升级后行为完全不变：连接、探活、拉取、缓存指纹与今天一致（全新指纹导致一次缓存失效可接受，但要说明）。
- 新增 `http://<ip>:<port>` + `plaintext` 的本地 registry 来源：保存成功，探活走 http `/v2/`，能列出仓库和 tag，能拉取镜像。
- 新增自签证书 registry + `tlsSkipVerify`：保存成功并能连通；同一地址在 `tls` 模式下报证书错误而不是泛化的「不可达」。
- 新增内网 CA 签发的 registry + `tlsCustomCA` + CA 文件路径：能连通；把路径改成不存在的文件时，报错明确指出 CA 文件读取失败并带来源标识。
- `tlsCustomCA` 只填粘贴 PEM 也能连通；路径与 PEM 都填时实际使用路径里的证书。
- 选 `tlsCustomCA` 但路径与 PEM 都空 → 保存失败，错误文案说明必须提供其一。
- `plaintext` 配 `https://...`、或 `tls` 配 `http://...` → 保存失败并说明 scheme 与模式不一致。
- 非 `tlsCustomCA` 模式下保存后 `registryCAPath` / `registryCAPEM` 被清空（检查配置文件内容）。
- 表单：选 `plaintext` 或 `tlsSkipVerify` 时出现风险提示；选 `tlsCustomCA` 时出现路径与 PEM 两个输入；来源列表里这三个非默认模式都有对应标记。
- 中英文两份 locale 都有新文案，`wails3 task test:i18n` 通过；`frontend/bindings/` 由 `wails3 task common:generate:bindings` 重新生成，不手工编辑。
- `wails3 task common:frontend:run SCRIPT=build`、`wails3 task test:go` 无新增失败；`git diff --check` 干净。

## 待定问题

无。
