# TinkerKit

> A developer workbench that lives in the macOS menu bar — local tools work offline, while SSH, container and network debugging are always a click away.

[![English](https://img.shields.io/badge/English-Default-0078D4)](README.en.md)
[![简体中文](https://img.shields.io/badge/简体中文-阅读中文版-3DA639)](README.md)

Built with [Wails v3](https://v3.wails.io/), TinkerKit gathers the high-frequency utilities of everyday development and debugging together with remote debugging capabilities into one app that lives in the macOS menu bar: JSON, time, text, encoding, image and QR tools run fully offline, while SSH file management, port forwarding, containers and services, image management and network tests only connect to targets you specify explicitly. Compared with scattered online utilities or one-off scripts, it stays resident in the menu bar, works without a network, and keeps everything you need for debugging in one place.

![GitHub release](https://img.shields.io/github/v/release/northes/tinker-kit?sort=semver&label=version)
![license](https://img.shields.io/badge/license-MIT-3DA639)
![platform](https://img.shields.io/badge/platform-macOS-000000)
![Wails](https://img.shields.io/badge/Wails-v3%20beta-DF0D3F)
![React](https://img.shields.io/badge/React-19-61DAFB)

## Features

- **Local-first, offline by default** — No accounts, no telemetry, and no collection or upload of your content. Keys, tokens and logs are processed and stored only on your machine.
- **Menu-bar resident, always on call** — TinkerKit lives in the menu bar; closing the window hides it to the tray (the Dock icon reappears while the window is shown). Copy anything, right-click the tray icon, and TinkerKit auto-detects JSON / timestamps / URL / JWT / Base64 / text and jumps to the matching tool (asks for confirmation by default; enable “auto fill” to skip it).
- **Command palette, keyboard-first** — Press `⌘K` / `Ctrl+K` to search every command with fuzzy matching, including pinyin and initial letters for Chinese, filtered by the current context. Nearly everything can be done without touching the mouse.
- **Remote and container debugging** — SSH file management, port forwarding, containers and services, image management and network tests share one set of connection profiles, so you don’t have to switch between the terminal and several GUIs.
- **Portable configuration** — Settings, custom sources and connection credentials can be exported, imported and reset; launch at login and background notifications are supported.
- **Simplified Chinese first, i18n-ready** — The UI defaults to Simplified Chinese with English built in, and the locale structure is easy to extend with more languages.
- **Auto-update** — Distributed through GitHub Releases; checks silently on launch and every 24 hours, prompts only when a new version is found, then downloads and restarts in one click.

## Built-in Tools

Local tools make no network requests and work fully offline.

| Tool | Description | Highlights |
| --- | --- | --- |
| JSON Workspace | Format, minify, validate, repair | Tolerant of comments and trailing commas; one-click repair; JSONPath extraction; schema panel; table preview; configurable pipeline transformations |
| Time Tools | Convert timestamps and dates, calculate dates | Smart parsing of Unix, ISO 8601, RFC3339 and common CN/EN date formats; real-time panel; timezone search; date differences and date arithmetic; drag-to-reorder and toggle output formats |
| Text Toolkit | Measure and normalize plain text | Character / Chinese / English / digit / punctuation / word / sentence / paragraph / line / byte counts; case conversion; trimming, space and blank-line compression |
| Text Generator | Generate random text | UUIDs, built-in and custom character sets; adjustable length, quantity, separator and quoting |
| Base64 | Text, images, files | Auto-detects encoding direction and content type; data URLs and image preview; save decoded files |
| Diff Compare | Side-by-side comparison | Word/character-level highlighting; collapse unchanged lines; alternate clipboard fills |
| JWT Decoder | Decode header, payload and signature | Decoded entirely in the frontend with no requests sent; structure validity checked automatically |
| URL Analyzer | Parse URLs in real time | Base / path / hash / query parameters; add and remove parameters; URI and URIComponent encoding |
| QR Code | Convert between text and QR codes | Generate and export PNG; paste or pick an image to decode |
| Image Tools | Crop, expand, compress and export | Export PNG / JPG / WebP / ICO / SVG; compress by quality or target size; inspect dimensions, format and size |

The tools below connect to targets you specify (SSH hosts, container hosts, registries, the endpoint under test or a proxy). Configure connections in the tool itself or under “Settings → Connections” before use.

| Tool | Description | Highlights |
| --- | --- | --- |
| SSH Files | Browse, upload and download remote files | Multiple connections and sources; search by name or content; favorite directories; batch copy / move / rename / extract / compress / download; built-in text editor; background task center |
| Ports | Inspect local and remote port usage | Filter by protocol / user / direction / status; add, start, stop and edit SSH local and remote port forwards |
| Containers & Services | Manage Docker, PM2 and Systemd services | Local or SSH targets; compose grouping; log highlighting and regex filtering; resource and performance metrics; pull image updates and restart |
| Image Manager | Inspect, push, rename and delete images | Local Docker, SSH hosts and registries as sources; architecture, layer and runtime details; export and import tar; pull updates; batch operations and background tasks |
| Network Test | HTTP(S), TCP, WebSocket, UDP, NTP and RTSP connectivity | Paste a curl command to import a request; proxy, DNS, outbound interface and redirect settings; per-stage timings and link timeline; can also run from an SSH source (HTTP / HTTPS only) |

<!--
  Screenshot placeholder: add screenshots of the main UI and each tool
  before publishing, so users can quickly see what the app looks like.
-->

## Installation

### Homebrew

```bash
brew tap northes/tinker-kit https://github.com/northes/tinker-kit.git
brew install --cask northes/tinker-kit/tinker-kit
```

支持 macOS 12 及以上版本，兼容 Apple Silicon 和 Intel。升级与卸载：

```bash
brew update
brew upgrade --cask --greedy northes/tinker-kit/tinker-kit
brew uninstall --cask northes/tinker-kit/tinker-kit
```

应用支持内置更新，因此通过 Homebrew 升级时使用 `--greedy`。卸载保留本地配置。首次启动遇到安全提示时，按下方说明处理。

### DMG 安装

Download the latest `TinkerKit-<version>-darwin-universal.dmg` from [GitHub Releases](https://github.com/northes/tinker-kit/releases) (macOS 12.0 or later):

- One Universal build covers both Apple Silicon and Intel — no need to pick an architecture;
- In-app updates use the matching `-darwin-universal.zip` and `SHA256SUMS` checksum file, so the app can upgrade itself after install;
- Builds are ad-hoc signed without an Apple Developer certificate. If the first launch reports “is damaged and can’t be opened” or “unidentified developer”, do either of the following:
  - Open the DMG and run the `Repair` script (Chinese systems: `修复工具`) first; it clears the quarantine flag and re-signs the app;
  - Or run `sudo xattr -rd com.apple.quarantine /Applications/TinkerKit.app` in Terminal, then click “Open Anyway” under “System Settings → Privacy & Security”.

## Quick Start

1. After the first launch, TinkerKit lives in the menu bar tray; closing the window only hides it, and “Quit” in the tray menu is the real exit.
2. Copy a snippet of JSON, a timestamp, URL, JWT or Base64, then right-click the tray icon — TinkerKit identifies the content type and asks whether to fill it into the matching tool (default behavior; turn tray recognition off, pick which tools are matchable, or enable “auto fill” under “Settings → Automation & notifications”).
3. Press `⌘K` / `Ctrl+K` in any tool to open the command palette and search for actions.
4. Before using SSH Files, Containers & Services, Image Manager, Ports or Network Test, add an SSH profile under “Settings → Connections”, or add connections and sources directly inside the tool.

## Privacy & Network

- Local tools (formatting, conversion, parsing, comparison, images and QR codes) run fully offline and make no network requests; the app has no accounts and no telemetry.
- The only automatic background network activity is “Check for updates”: it runs silently after launch and every 24 hours, and can be turned off or triggered manually under “Settings → About”.
- Debugging tools only connect to the targets you specify when you trigger an operation; credentials such as SSH passwords, key passphrases and registry passwords are stored in your local configuration file.
- Configuration and sources live in `~/Library/Application Support/TinkerKit/` (`config.json`). Export / import / reset the configuration under “Settings → Data & security” (reset restores defaults and removes all custom sources and connection credentials).

## Development

### Requirements

- macOS
- Go 1.26+ (as declared in `go.mod`)
- Node.js 24+ (dependencies are installed only inside `frontend/`)
- Wails v3 CLI, matching the library version in `go.mod` (currently `v3.0.0-beta.29`):

  ```bash
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.29
  ```

Install frontend dependencies after the first checkout:

```bash
cd frontend && npm install
```

### Common Commands

All tasks run through `wails3 task <name>` (the wails3 CLI bundles its own task runner — no separate install needed):

| Command | Description |
| --- | --- |
| `wails3 task dev` | Dev loop: builds a DEV binary, starts Vite at `http://localhost:9245` by default, hot-reloads Go on change, and lets Vite hot-update the frontend |
| `wails3 task build` | Builds a production executable (output goes to `bin/`) |
| `wails3 task package` | Packages the macOS app bundle (output: `bin/TinkerKit.app`) |
| `wails3 task darwin:package:dmg` | Creates the installer image (output: `bin/TinkerKit.dmg`) |
| `wails3 task run` | Launches the built binary as a DEV app bundle (run a build first) |
| `wails3 task test:go` | Runs all Go tests |
| `wails3 task test:json-repair` | Runs the JSON repair Go tests |

`Taskfile.yml` also holds several unit-test tasks for shared frontend logic and protocol parsing (`test:shared-logic`, `test:ansi`, `test:image-tasks`, `test:network-target` and more) that can be run individually.

Frontend type and format checks:

```bash
cd frontend
npx tsc --noEmit     # type check
npm run format:check # Prettier format check (npm run format fixes it)
```

Frontend dependencies are installed only inside `frontend/`; the frontend build output is embedded by `main.go` via `//go:embed all:frontend/dist`, so `frontend/dist` must exist before any Go build.

### Project Structure

```
├── main.go                # Go entrypoint: window, system tray, service registration, update scheduler
├── appmenu_*.go           # Application menu and localized menu copy
├── configservice*.go      # Settings persistence (ConfigService)
├── updateservice.go       # Update polling and scheduling (Wails updater + GitHub Releases)
├── fileservice.go         # Local file reading and save-as
├── json*.go               # JSON parsing, repair, pipeline transforms and validation
├── ssh*.go                # SSH profiles, connections, remote file operations and commands
├── image*.go              # Image sources, pull / push / export / import and details
├── networktest*.go        # Network test protocol implementations and stage timeline
├── servicemanager*.go     # Docker / PM2 / Systemd service management
├── portservice.go         # Port usage scanning and SSH port forwarding
├── frontend/              # React 19 + TypeScript frontend
│   ├── src/App.tsx        # Layout, routing and tool mounting
│   ├── src/app/           # Tool registry, command palette, navigation, clipboard detection
│   ├── src/components/    # Tool components (JsonTool / NetworkTestTool / …) and shared primitives
│   ├── src/lib/           # Pure helpers plus *.test.mjs unit tests for shared logic
│   ├── src/locales/       # i18n resources (zh-CN / en-US)
│   └── bindings/          # Auto-generated TS bindings (do not edit)
├── build/                 # Wails build config and per-platform Taskfiles
├── tools/                 # Build-time helpers (e.g. DMG generation)
└── .github/workflows/     # macOS release pipeline
```

### Tech Stack

- Desktop shell: [Wails v3](https://v3.wails.io/) (Go), kept as a thin layer;
- Frontend: React 19 + TypeScript + Vite;
- UI: shadcn/ui (vendored source, built on Base UI) + Tailwind CSS v4 + [Phosphor Icons](https://phosphoricons.com/);
- Editor: [CodeMirror 6](https://codemirror.net/) (syntax highlighting for JSON, logs and remote text, plus the diff merge view);
- i18n: react-i18next;
- Updates: Wails updater + GitHub Releases provider.

## Releasing

Push a semver tag to trigger [release-macos.yml](.github/workflows/release-macos.yml):

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds a Universal package for both Apple Silicon and Intel and uploads it to a single GitHub Release:

- `TinkerKit-<version>-darwin-universal.dmg` — first-time installation;
- `TinkerKit-<version>-darwin-universal.zip` — in-app updates;
- `SHA256SUMS` — file integrity verification.

稳定版 Release 发布成功后，工作流会将 `Casks/tinker-kit.rb` 的版本与 DMG SHA256 同步到仓库默认分支；预发布版本不更新 Cask。仓库需允许 GitHub Actions 写入默认分支；分支保护规则若禁止直接推送，同步任务会失败，需要调整对应规则。首次启用需要先将 Cask 和工作流合并到默认分支。

Releases are ad-hoc signed Universal builds (no Apple Developer certificate or notarization yet); the DMG ships a `Repair` / `修复工具` script so first-time installs can get past Gatekeeper. Should formal distribution be needed later, add Developer ID signing and a `notarytool` step to the workflow. In-app updates always read the latest GitHub Release of the public `northes/tinker-kit` repository.

## Contributing

Issues and pull requests are welcome — report bugs or request features via [Issues](https://github.com/northes/tinker-kit/issues), and submit code via Pull Requests:

- Before submitting, run `npx tsc --noEmit` and `npm run format:check` inside `frontend/`, and `wails3 task test:go` from the repository root;
- Keep the existing code style, and use English Conventional Commits prefixes in commit messages (see `AGENTS.md`);
- When adding a new tool, follow `.agents/skills/tool-development/SKILL.md` so the command palette and tray matching stay in sync;
- User-facing copy goes through locale files — no hardcoded strings.

## License

This project is licensed under the [MIT License](LICENSE). You are free to use, modify and distribute it, including for commercial purposes, as long as you retain the copyright and license notice.
