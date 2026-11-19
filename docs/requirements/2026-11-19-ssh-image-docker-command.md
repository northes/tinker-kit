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
5. 镜像管理里所有走 SSH 的 docker 调用都用同一条规则，包括列表、详情、拉取、推送、打标签、删除、导出，以及 `docker load` 的 stdin。应用不插入 `sudo -S`，不自行消费 stdin；stdin 仍交给远端会话，由用户写在前缀里的命令接收。
6. 连接探测保持现在的深度：SSH 为 `uname -m` 再 exec 上述命令的 `--version`；本机仍只跑 CLI `--version`。不额外跑 `docker info`。状态徽标仍表示客户端能执行，不表示 daemon 可用。前缀留空且已判定找不到 `docker` 时，探测按第 3 条直接失败，不 exec。
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
    - 说明：留空则使用登录 shell PATH 中的 docker；填写则按空格拆成命令，不经过 shell，也不会询问 sudo 密码，需要免密 sudo（`sudo -n`）。英文表达同一含义。
11. SSH 来源编辑表单提供「测试连接」，与 Registry 的测试一样不落盘。用当前草稿（含 SSH 配置解析和 `dockerCommand`）做与进入来源时相同的连接探测。失败展示远端或校验错误。免密 sudo 或 socket 权限不足时，测试可能成功，加载镜像列表才会失败。
12. 新增用户可见文案同时写入 `zh-CN` 与 `en-US`。

## 已定决策

### 配置位置（第一轮）

- 挂在镜像来源，且仅 SSH。不挂在全局 SSH 配置上。
- 服务管理本轮不读这项，继续用它现有的登录 PATH。
- 本机仍用全局 Docker CLI 路径。
- 同一 SSH 配置可以给不同镜像来源配不同命令。

### 命令形状（第一轮）

- 用户填写的是命令前缀，不是单个路径，也不是「sudo -n」开关。
- 留空走登录 PATH；填写则按 argv 执行，不再套 PATH。
- 不保存 sudo 密码。sudo 仍要密码时命令失败，错误带远端 stderr。
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

### 探测深度（第三轮）

- 测试连接和来源状态都继续只检查客户端 `--version`（SSH 另加 `uname -m`），不跑 `docker info`。
- 连接徽标不改成「daemon 可用」。

## 非目标

- 不保存 sudo 密码，不分配 PTY，不做交互式 sudo，不使用 `sudo -S`。
- 不支持 shell 语法（管道、重定向、引号、变量替换）。需要更复杂的包装时，用户在远端放脚本，并把脚本路径填进前缀。
- 不改服务管理的目标、探测命令列表、缓存和错误行为。
- 不把全局 `DockerCLIPath` 应用到 SSH 来源，也不为本机来源增加单独的命令前缀。
- 不把连接探测升级为 daemon 检查，不改变「已连接」的含义。
- 不为 Podman 或其他 CLI 另做子命令兼容；前缀写成别的可执行文件时，仍追加现有 docker 子命令。
- 不改 Registry 传输、镜像业务操作的其它语义，或 SSH 配置对话框。

## 验收标准

- 已有 SSH 来源不填 `dockerCommand`：若登录 PATH 能找到 `docker`，列表与 `--version` 探测使用该 PATH；若探测成功但找不到，状态为不可用，文案为远端未找到命令 `docker`，且不再出现一次 `exec: docker: not found`。
- 探测用的登录 shell 全部失败时，仍尝试裸 `docker`，来源不因探测步骤本身被标死。
- SSH 来源填写 `/usr/bin/docker`：远端执行该绝对路径，不依赖 PATH 探测。
- SSH 来源填写 `/usr/bin/sudo -n /usr/bin/docker`：列表、探测、`docker load` 的 argv 都以此前缀开头；load 的镜像数据仍从会话 stdin 送入，应用不改写为 `sudo -S`。sudo 需要密码时失败信息包含远端 stderr。
- 含空格路径、引号、`$()`、管道、第一个 token 以 `-` 开头，或超过 4096：保存失败，配置不变；测试连接同样失败且不发起 SSH。`-n` 作为后续参数可以保存。
- Registry 或本机来源即使传入 `dockerCommand`，保存后也为空。本机仍只认全局 Docker CLI 路径。
- 修改 `dockerCommand` 后镜像缓存指纹变化，不继续使用旧前缀的缓存结果。
- 表单仅 SSH 来源显示「Docker 命令」、占位符和免密 sudo 说明；测试连接不写入配置。中英文 locale 都有这些文案。
- 服务管理相关测试与行为保持不变。
- `frontend/bindings/` 只由生成命令更新。`wails3 task test:i18n`、`wails3 task test:go`、`wails3 task common:frontend:run SCRIPT=build` 无新增失败；`git diff --check` 干净。

## 待定问题

无。

## 变更记录

- 2026-11-19：对齐首版。命令前缀挂在 SSH 镜像来源；留空走登录 PATH；不保存 sudo 密码；探测仍只检查客户端版本。
