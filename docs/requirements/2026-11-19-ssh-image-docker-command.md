# SSH 镜像来源可配置远端 Docker 命令

状态：已对齐，尚未实现。实现时以本文「已定决策」与「需求条目」为准。

## 背景与目标

镜像管理的 SSH 来源在 `imageservice.go` 的 `sourceSnapshot` 里把远端 CLI 写死为 `docker`，不使用全局 `DockerCLIPath`（该字段只给本机来源）。连接探测是一次非交互 `sh -c 'uname -m && exec docker --version'`。远端默认 PATH 里没有 `docker` 时，用户看到：`远程命令 "sh" 执行失败：sh: line 0: exec: docker: not found`。

服务管理已经会先经登录 shell 解析 PATH（`servicemanagerservice.go` 的 `probeRemoteCommandEnv` / `remoteCommandLine`），镜像管理没有这条路径。另一类机器上，`docker` 必须以 `sudo` 执行；当前会话不分配终端，也不能代填 sudo 密码。

目标：SSH 镜像来源可以留空（走与服务管理相同的登录 PATH），也可以填写一条不经 shell 的命令前缀（例如绝对路径，或 `/usr/bin/sudo -n /usr/bin/docker`）。不保存 sudo 密码，不改服务管理。

## 需求条目

1. `ImageSource` 新增持久化字段 `dockerCommand`（字符串，空为默认）。只在 SSH 来源上保留；本机来源与 Registry 来源在归一化时清空。Go 导出类型变化后重新生成 `frontend/bindings/`，禁止手工编辑该目录。
2. 字段挂在镜像来源上，不挂在 `SSHProfile`。同一 SSH 配置的不同镜像来源可以各自填写。服务管理不读取该字段。
3. 留空：用与服务管理相同的方式探测远端登录 shell PATH，再执行 `docker`。
   - 探测：依次 `bash` / `zsh` / `sh` 的 `-lc`，超时 8 秒；先取登录 PATH，再补 `/usr/local/bin`、`/opt/homebrew/bin`、`$HOME/.local/bin` 以及 asdf / fnm / volta / nvm 等与服务管理相同的目录；确认命令名 `docker` 是否存在。
   - 镜像管理自己缓存探测结果 10 分钟。缓存键包含连接身份（主机、端口、用户、跳板）和命令前缀（此处为空）。不与服务管理共用缓存，也不要改服务管理的命令列表、TTL 或缺失命令时的行为。可以抽取共用探测函数，但抽取不得改变服务管理的对外行为。
   - 探测过程失败（连不上、shell 都失败、输出解析失败）：退回不带 PATH 前缀的裸 `docker`，不因为探测失败把来源判死。
   - 探测成功但 PATH 中没有 `docker`：不执行 docker。错误文案与服务管理一致：「远端未找到命令 docker；请确认已在远端安装并加入登录 shell PATH」。
   - 探测成功且找到 `docker`：执行 `PATH=<探测到的 PATH> docker <原有子命令>`。
4. 非空：按 Unicode 空白拆成 argv（与 `strings.Fields` 相同），不解析引号，不再套登录 PATH。这些 token 后面原样接上现有 docker 子命令。例如前缀 `/usr/bin/sudo -n /usr/bin/docker` 加 `images` 得到 `/usr/bin/sudo -n /usr/bin/docker images`。不经过 shell，不支持管道、重定向、命令替换。
5. 镜像管理的 SSH 调用共用 Docker 命令解析和提权规则，覆盖列表、详情、拉取、推送、打标签、删除、导出和导入。未配置 sudo 密码时，输入直接交给用户配置的命令。
6. 连接探测改为验证 daemon 可访问：SSH 与本地来源都执行一条 `<命令> info --format '{{.ServerVersion}}'`（SSH 前面拼 `uname -m &&` 以同时取架构），daemon 不可访问即判为不可用。状态里的版本改用 `ServerVersion`。`registry` 来源不变。
   - 测试连接改为在 dialog 内分步展示：「连接」用 `uname -m && <命令> --version`（SSH）或 `<命令> --version`（本地）；「daemon 探测」用上述 info 命令。两步都通过才算测试成功。
7. 保存与测试连接都先校验 `dockerCommand`，非法则拒绝，不写配置，也不发起 SSH，不得悄悄清空：
   - 整段 trim 后为空：合法，表示默认。
   - 原始字符串最长 4096。
   - 含控制字符（含换行）、shell 元字符 `|` `&` `;` `<` `>` `` ` `` `$` `\`，或单双引号：拒绝。
   - 路径中不能有空格（空白只作分隔，不保留）。
   - 第一个 token 不能以 `-` 开头；其后的参数（如 `-n`）可以。
8. `imageSourceFingerprint` 纳入 `dockerCommand` 原文，避免改前缀后仍命中旧镜像缓存。
9. 存量 SSH 来源没有该字段时视为留空，开始走第 3 条的登录 PATH，不做单独迁移。本机继续只用全局 `DockerCLIPath`；SSH 来源继续忽略全局路径。
10. SSH 来源编辑表单增加一项，Registry 与本机不显示。从 SSH 改成 Registry 时清空草稿里的该字段。
    - 标签：`Docker 命令` / `Docker command`。
    - 占位：`/usr/bin/sudo -n /usr/bin/docker`。
    - 说明：改成两段——留空则使用登录 shell PATH 中的 docker，填写则按空格拆成命令且不经过 shell；填了 sudo 密码时由应用负责认证，密码通过 SSH 会话输入传输。英文表达同一含义。
11. SSH 来源编辑表单提供「测试连接」，与 Registry 的测试一样不落盘。用当前草稿（含 SSH 配置解析和 `dockerCommand`）做与进入来源时相同的连接探测。失败展示远端或校验错误。
    - 测试结果展示在编辑弹窗内的面板里，分「连接」「daemon 探测」两行；成功行显示成功，失败行显示单行截断（不换行、末尾省略号）的原因，点击该行把完整错误（含远端 stderr）复制到剪贴板，并弹出应用现有的「已复制」提示。
    - 不再弹「连接成功 / 连接失败」toast。面板在编辑任一字段、切换来源类型或关闭弹窗时清空。
    - Registry 来源只有「连接」一步（registry 探活），不显示 daemon 行。
12. 新增用户可见文案同时写入 `zh-CN` 与 `en-US`。
13. SSH 来源可保存 sudo 密码（`sudoPassword`，本机配置持久化，仅 SSH 来源保留）：
    - 非空时应用通过 sudo 执行 Docker。探测等无 Docker 输入的调用使用 `sudo -S -p '' <CLI 路径> <子命令>`。需要 Docker 输入的导入和详情使用 `sudo -A` 和独立的认证通道。
    - 「Docker 命令」留空但填了密码：用登录 PATH 探测到的 docker 绝对路径作为 `<CLI 路径>`；探测结论是「PATH 中没有 docker」时按第 3 条同一文案报未找到，不再执行。
    - 「Docker 命令」非空但含 `sudo` token，同时密码非空：保存与测试连接都拒绝，要求二选一（用户不写密码，或去掉前缀里的 sudo）。
    - Go SSH 与系统 `ssh` 都通过会话 stdin 传输密码。导入和详情的远端入口从会话输入拆出首行，按需交给临时 askpass 助手。Docker 直接读取剩余输入。密码不进入远端 argv、环境变量或磁盘文件。
    - 远端助手及其私有管道随调用创建和清理，sudo 直接执行 Docker。sudo 免密、缓存命中或认证失败时，密码也不会进入 Docker 的输入。
    - 密码框回显已保存值（与 Registry 密码一致）；从 SSH 改成 Registry 时清空。
    - 密码校验：最长 4096；不允许换行、回车与其它非空白控制字符；不做 trim（首尾空格是密码的一部分）。
    - 密码进入 `imageSourceFingerprint`（与既有 SSH 密码、私钥口径一致），改密码后旧缓存指纹失效。

## 已定决策

### 配置位置（第一轮）

- 挂在镜像来源，且仅 SSH。不挂在全局 SSH 配置上。
- 服务管理本轮不读这项，继续用它现有的登录 PATH。
- 本机仍用全局 Docker CLI 路径。
- 同一 SSH 配置可以给不同镜像来源配不同命令。

### 命令形状（第一轮）

- 用户填写的是命令前缀，不是单个路径，也不是「sudo -n」开关。
- 留空走登录 PATH；填写则按 argv 执行，不再套 PATH。
- 不保存 sudo 密码（已由下方「sudo 密码（第五轮）」取代）。sudo 仍要密码时命令失败，错误带远端 stderr。
- 探测过程失败则退回裸 `docker`。

### 找不到 docker（第二轮）

- 前缀留空、探测成功、但 PATH 中没有 `docker`：直接报未找到，不执行。与服务管理一致。
- 这与「探测过程失败则退回裸 docker」不是同一条：前者是探测有结论且命令不存在，后者是探测本身没有结论。

### 非法前缀（第二轮）

- 保存时拒绝，不像全局 Docker CLI 路径那样把非法值悄悄变成空。
- 按空白拆分，不解析引号。校验规则见需求条目 7。测试连接使用同一套校验。

### 表单与测试（第二轮）

- SSH 来源表单同时加输入框和测试连接。
- 说明必须写明不会询问 sudo 密码、需要免密 sudo。

### 探测深度（第三轮，已由下方「daemon 探测」取代）

- ~~测试连接和来源状态都继续只检查客户端 `--version`，不跑 `docker info`。~~

### daemon 探测与测试面板（第四轮）

- 起因：`docker --version` 无法暴露 daemon socket 权限问题，导致测试连接成功、加载列表报 `permission denied`。
- 进入或切换来源时的自动检查改成一条命令同时拿架构与服务端版本：`uname -m && <docker 命令> info --format '{{.ServerVersion}}'`。本机来源同理（不带 `uname`）。
- 测试连接在弹窗内分两步展示，失败原因单行截断、点击复制完整原因；不再弹 toast。
- 不为 socket 权限错误额外追加可操作提示，保持原样。
- 本机来源与 SSH 来源口径一致。

### sudo 密码（第五轮）

- 需要 sudo 密码的机器不改服务器：密码存在镜像来源上，随本机配置保存，与 SSH 密码同等对待。
- 命令前缀与密码拆成两个字段；填了密码就自动加 `sudo -S`，用户不再写管道。
- 原「不保存 sudo 密码」「不经过 shell」的限制仅适用于不带密码的场景；仍然不引入 shell，密码只走 stdin。
- `docker load` 用「密码行 + 镜像数据」的单一 stdin 流。

### sudo 密码实现细则（第六轮）

- 仅填写密码时，使用登录 PATH 探测到的 Docker 绝对路径，避免 sudo 重置 PATH 后选择到其他版本。登录 PATH 里没有 docker 时按第 3 条报未找到。
- 前缀自带 sudo + 密码：口径冲突，保存与测试连接都拒绝，不默默忽略任何一侧。
- 无保存凭据、走系统 `ssh` 的来源：密码行走 `ssh` 的 stdin，与 Go SSH 客户端路径口径一致，不降级成 `sudo -n`。
- 「Docker 命令」说明文案改成不带密码 / 带密码两段：留空使用登录 shell PATH、填写按空格拆分且不经 shell；填了密码则自动 `sudo -S -p ''`，密码只走 stdin。

### 流式操作认证（第七轮）

- 远端临时 askpass 助手将 sudo 密码和 Docker 输入分开。导入和详情走这一认证通道，普通调用继续走 `sudo -S`。

## 非目标

- 不分配 PTY，不做交互式 sudo 提示。远端 sudoers 继续授权 Docker 命令。
- 不支持 shell 语法（管道、重定向、引号、变量替换）。需要更复杂的包装时，用户在远端放脚本，并把脚本路径填进前缀。
- 不改服务管理的目标、探测命令列表、缓存和错误行为。
- 不把全局 `DockerCLIPath` 应用到 SSH 来源，也不为本机来源增加单独的命令前缀。
- 不为 daemon socket 权限错误追加专门的可操作文案，保持现有错误展示。
- 不支持 shell 语法和管道；需要密码时用来源上的 sudo 密码字段。
- 不为 Podman 或其他 CLI 另做子命令兼容；前缀写成别的可执行文件时，仍追加现有 docker 子命令。
- 不改 Registry 传输、镜像业务操作的其它语义，或 SSH 配置对话框。

## 验收标准

- 已有 SSH 来源仍只检查版本：若登录 PATH 能找到 `docker`，列表与探测使用该 PATH；若探测成功但找不到，状态为不可用，文案为远端未找到命令 `docker`。
- 当前用户可执行 docker 但不能访问 daemon socket（未入 docker 组、无 `sudo -n` 前缀）时：切换来源立即显示不可用，原因包含 `permission denied` 与 socket 路径；测试连接的「daemon 探测」行失败并可点击复制完整原因，不再出现「测试成功但加载失败」。
- 探测用的登录 shell 全部失败时，仍尝试裸 `docker`，来源不因探测步骤本身被标死。
- SSH 来源填写 `/usr/bin/docker`：远端执行该绝对路径，不依赖 PATH 探测。
- SSH 来源填写 `/usr/bin/sudo -n /usr/bin/docker`：列表、探测、`docker load` 的 argv 都以此前缀开头；load 的镜像数据仍从会话 stdin 送入，应用不改写为 `sudo -S`。sudo 需要密码时失败信息包含远端 stderr。
- 含空格路径、引号、`$()`、管道、第一个 token 以 `-` 开头，或超过 4096：保存失败，配置不变；测试连接同样失败且不发起 SSH。`-n` 作为后续参数可以保存。
- Registry 或本机来源即使传入 `dockerCommand`，保存后也为空。本机仍只认全局 Docker CLI 路径。
- 修改 `dockerCommand` 后镜像缓存指纹变化，不继续使用旧前缀的缓存结果。
- SSH 来源只填 sudo 密码、不填前缀：登录 PATH 能探测到 docker 时执行的 argv 为 `sudo -S -p '' <docker 绝对路径> <子命令>`，密码只作为 stdin 首行；登录 PATH 没有 docker 时报未找到。
- 前缀 `/usr/bin/sudo -n /usr/bin/docker` 与密码同时存在：保存失败且配置不变，测试连接也不发起 SSH。
- Go SSH 和系统 `ssh` 都能在 sudo 要求密码、免密和认证缓存命中时将 tar 或 HTTP 请求原样交给 Docker。密码错误时保留 sudo 的错误，避免启动 Docker 或让重试卡住。
- 密码含换行或超过 4096 时保存失败；密码为首尾带空格的字符串时按原样保存与使用。
- 表单仅 SSH 来源显示「Docker 命令」、占位符和 sudo 密码输入框；测试连接不写入配置。中英文 locale 都有对应文案。
- 服务管理相关测试与行为保持不变。
- `frontend/bindings/` 只由生成命令更新。`wails3 task test:i18n`、`wails3 task test:go`、`wails3 task common:frontend:run SCRIPT=build` 无新增失败；`git diff --check` 干净。

## 待定问题

无。

## 变更记录

- 2026-11-19：对齐首版。命令前缀挂在 SSH 镜像来源；留空走登录 PATH；不保存 sudo 密码；探测仍只检查客户端版本。
- 2026-11-19（后续）：探测改为验证 daemon（`info --format '{{.ServerVersion}}'`，SSH 拼 `uname -m`），本机同步；测试连接改为弹窗内「连接 / daemon 探测」两步面板，失败原因单行截断并可点击复制，不再弹 toast。早先「只检查客户端版本」的结论作废。
- 2026-11-19（再后续）：测试连接支持中途取消（按钮原地变取消，取消后已完成步骤保留、其余标未执行）。
- 2026-11-19（再后续）：SSH 来源新增 sudo 密码字段，应用自动以 `sudo -S` 执行、密码只走 stdin；`docker load` 使用「密码行 + 镜像数据」单一流。早先「不保存 sudo 密码」的限制作废。
- 2026-11-20（第六轮）：落实 sudo 密码实现细则。空前缀 + 密码用登录 PATH 探测到的绝对路径；前缀自带 sudo 又填密码则保存报错；系统 `ssh` 路径也把密码行写进 stdin；表单说明改成不带密码 / 带密码两段；密码不 trim，进指纹。
- 2026-11-20（第七轮）：确认 sudo 可以跳过读取密码。导入和详情采用独立的 askpass 认证通道，Docker 始终收到原始输入。其他调用继续使用 `sudo -S`。
