---
name: release
description: 为本仓库打 SemVer tag 并推送到 origin 与 github（含 tags）。在用户说「发版」「发布」、输入 `/skill:release` 或 `/release`、或明确要求执行 `wails3 task gp` 时使用；实现普通功能或修复时不要加载。
---

# 发版

在用户手动触发发版时执行本 skill 的步骤。不在此流程中改产品代码，除非工作区仅有待发版的文档且用户已要求一并提交。

## 前置条件

1. 在仓库根目录执行；`git` 可用，`wails3` 在 PATH 中。
2. 读取 `git status`：若有未提交改动，先向用户说明文件列表；默认**停止**，除非用户明确允许「只提交文档后发版」或「脏树也继续」（后者不推荐）。
3. 不要访问远端做同步以外的操作；不要 `git push --force` 到 `main`。

## 1. 判定版本并打 tag

按用户级 skill `version-tag`（`~/.agents/skills/version-tag/SKILL.md`）的「分析范围」「判断版本」「创建 tag」执行，对象为本仓库 `HEAD`：

- 基准为可达历史上最近的 SemVer tag（与本地惯例一致，当前为 `v*`）。
- 分析 `<tag>..HEAD` 的 log 与 diff，取 **major / minor / patch** 中最高合理级别。
- 若最新 tag 已指向当前 `HEAD`，报告「无需新版本」并**不要**重复打 tag；若用户仍要推送，跳到「3. 推送」。
- 创建 **annotated tag**：`git tag -a <tag> HEAD -m "Release <tag>"`，并验证 `git rev-parse <tag>^{commit}` 等于 `git rev-parse HEAD`。
- **不要**移动、覆盖或删除已存在的 tag。

汇报：比较范围、升级依据、新 tag 名与 commit SHA。

## 2. 合并 github 上领先的 cask（如有）

本仓库 `github` 远程有时会单独提交 `Casks/tinker-kit.rb`。

1. `git fetch github`
2. 若 `github/main` 领先本地 `main`：查看 `git log --oneline HEAD..github/main`。若提交仅涉及 `Casks/`（Homebrew cask chore），执行 `git merge github/main` 并写说明性 merge commit；若包含产品代码且与本地冲突，**停止**并交用户处理。
3. 若 merge 后 `HEAD` 前进且**尚未**打 tag，回到步骤 1 用新的 `HEAD` 重新分析（通常 tag 应打在 merge 之后的 `HEAD` 上；若 tag 已打在 merge 前，不要移动 tag，改打更高 patch 或向用户说明）。

**推荐顺序**：先 merge cask，再打 tag，再推送，避免 tag 落在未包含 cask 同步的提交上。

## 3. 推送

仅使用：

```bash
wails3 task gp
```

其含义见根目录 `Taskfile.yml` 的 `gp`：`git push --tags -f` 与分支推送到 `origin` 和 `github`。

- 若 `github` 的 `main` 再次 `fetch first`：重复步骤 2，再执行 `wails3 task gp`。
- 推送成功后汇报：tag、两个远程的 `main` 是否已更新。

## 4. Cask 与 GitHub Release

- `Casks/tinker-kit.rb` 的 `version` / `sha256` 应对齐 **已发布** 的 GitHub Release 资产，不要凭 tag 臆造 sha256。
- 若远程仅有 cask chore、尚无新版本 DMG/zip，在汇报中说明 cask 与 tag 的对应关系，不要在本流程中擅自改 `sha256`。

## 5. 不做的事

- 不运行完整构建矩阵（除非用户另要求）；发版 skill 不负责替代 `project-validation`。
- 不替用户创建 GitHub Release 网页或上传产物（无 CLI 任务时只提醒用户后续步骤）。
- 不把发版步骤写进 commit message 以外的产品代码。
