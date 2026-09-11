# TinkerKit

> A local-first developer utility launcher — a compact debugging workbench that lives in the macOS menu bar and is ready whenever you are.

[![English](https://img.shields.io/badge/English-Default-0078D4)](README.en.md)
[![简体中文](https://img.shields.io/badge/简体中文-阅读中文版-3DA639)](README.md)

Built with [Wails v3](https://v3.wails.io/), TinkerKit gathers the small, high-frequency utilities of everyday development and debugging — JSON, timestamps, date calculations, text, Base64, JWT, URL and diff comparison — into one compact desktop app that runs entirely on your machine. All data is processed only on your own device and is never uploaded to any server.

![GitHub release](https://img.shields.io/github/v/release/northes/tinker-kit?sort=semver&label=version)
![license](https://img.shields.io/badge/license-MIT-3DA639)
![platform](https://img.shields.io/badge/platform-macOS-000000)
![Wails](https://img.shields.io/badge/Wails-v3%20beta-DF0D3F)
![React](https://img.shields.io/badge/React-19-61DAFB)

## Features

- **Local-first, privacy-safe** — No accounts, no telemetry, no uploads. Sensitive content such as keys, tokens and logs stays on your device; everything runs fully offline.
- **Menu-bar resident, always on call** — Lives in the menu bar with no Dock icon; closing the window hides it to the tray. Copy anything, click the tray icon, and TinkerKit auto-detects JSON / timestamps / URL / JWT / Base64 / text and jumps to the matching tool (asks for confirmation by default; enable “auto overwrite” to skip it).
- **Command palette, keyboard-first** — Press `⌘K` / `Ctrl+K` to search every command with fuzzy matching, including pinyin and initial letters for Chinese, filtered by the current context. Nearly everything can be done without touching the mouse.
- **History kept on-device** — Tool activity is recorded locally, filterable by tool and time range, with pagination, on-demand loading for large entries, and one-click restore.
- **Simplified Chinese first, i18n-ready** — The UI defaults to Simplified Chinese with English built in, and the locale structure is easy to extend with more languages.
- **Auto-update** — Distributed through GitHub Releases; checks silently on launch and every 24 hours, prompts only when a new version is found, then downloads and restarts in one click.

## Built-in Tools

| Tool | Description | Highlights |
| --- | --- | --- |
| JSON Workspace | Format, minify, validate | Tolerant of comments and trailing commas; JSONPath extraction; schema panel; configurable pipeline transformations |
| Time Converter | Convert timestamps and dates, calculate dates | Smart parsing of Unix, ISO 8601, RFC3339 and common CN/EN date formats; timezone search; date differences and date arithmetic; drag-to-reorder and toggle output formats |
| Text Toolkit | Measure and normalize plain text | Character / Chinese / English / digit / word / punctuation / line / byte counts; case conversion; trimming and compressing |
| Base64 | Encode and decode text, images, files | Auto-detects encoding direction and content type; data URLs and image preview; save decoded files |
| Diff Compare | Side-by-side comparison | Word/character-level highlighting; collapse unchanged lines; alternate clipboard fills |
| JWT Decoder | Decode header and payload | Decoded entirely in the frontend; signature not shown; validity checked automatically |
| URL Analyzer | Parse URLs in real time | Base / path / hash / query parameters; supports http, https, rtsp, ws and wss |

<!--
  Screenshot placeholder: add screenshots of the main UI and each tool
  before publishing, so users can quickly see what the app looks like.
-->

## Installation

Download the latest `TinkerKit-<version>-darwin-universal.dmg` from [GitHub Releases](https://github.com/northes/tinker-kit/releases):

- One Universal build covers both Apple Silicon and Intel — no need to pick an architecture;
- In-app updates use the matching `-darwin-universal.zip` and `SHA256SUMS` checksum file, so the app can upgrade itself after install;
- Builds without Apple Developer credentials are ad-hoc signed: on first launch, allow them manually under “System Settings → Privacy & Security”.

## Quick Start

1. After the first launch, TinkerKit lives in the menu bar tray with no Dock icon.
2. Copy a snippet of JSON, a timestamp, URL, JWT or Base64, then click the tray icon — TinkerKit identifies the content type and asks whether to fill it into the matching tool (default behavior; disable tray matching or enable “auto overwrite” under “Settings → Clipboard”).
3. Press `⌘K` / `Ctrl+K` in any tool to open the command palette and search for actions.
4. Closing the window hides the app to the tray; use “Quit” in the tray menu to actually exit.

## Privacy & Data

- All tools (formatting, conversion, parsing, comparison) run locally with no network requests;
- History and settings are stored on your machine at `~/Library/Application Support/TinkerKit/` and can be cleared in one click under “Settings → Privacy”;
- The only possible network request is “Check for Updates”, which queries GitHub Releases for version info.

## Development

### Requirements

- macOS
- Go 1.25+
- Node.js 22+ (dependencies are installed only inside `frontend/`)
- Wails v3 CLI (currently pinned to `v3.0.0-beta.9`):

  ```bash
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.9
  ```

### Common Commands

All tasks run through `wails3 task <name>` (the wails3 CLI bundles its own task runner — no separate install needed):

| Command | Description |
| --- | --- |
| `wails3 task dev` | Dev loop: builds a DEV binary, starts Vite at `http://localhost:9245`, hot-reloads Go on change, and lets Vite hot-update the frontend |
| `wails3 task build` | Builds a production executable (dispatches to `build/{GOOS}/`) |
| `wails3 task package` | Packages an installer |
| `wails3 task run` | Runs the app |

Frontend type-check (no lint/format config):

```bash
cd frontend && npx tsc --noEmit
```

Frontend dependencies are installed only inside `frontend/`; the frontend build output is embedded by `main.go` via `//go:embed`, so `frontend/dist` must exist before any Go build.

### Project Structure

```
├── main.go              # Go entrypoint: window, system tray, bound services, update scheduler
├── configservice.go     # Config service: persists settings to ~/Library/Application Support/TinkerKit/config.json
├── updateservice.go     # Update polling and scheduling (Wails updater + GitHub Releases)
├── frontend/            # React 19 + TypeScript frontend
│   ├── src/App.tsx      # Layout, routing, command palette, clipboard detection
│   ├── src/components/  # Tool components (JsonTool / TimeTool / …) and shared primitives
│   ├── src/locales/     # i18n resources (zh-CN / en-US)
│   └── src/bindings/    # Auto-generated TS bindings (do not edit)
├── build/               # Wails build config and per-platform Taskfiles
└── .github/workflows/   # macOS release pipeline
```

### Tech Stack

- Desktop shell: [Wails v3](https://v3.wails.io/) (Go), kept as a thin layer;
- Frontend: React 19 + TypeScript + Vite;
- UI: shadcn/ui (vendored source) + Tailwind CSS v4 + [Phosphor Icons](https://phosphoricons.com/);
- Editor: [CodeMirror 6](https://codemirror.net/) (syntax highlighting for JSON and more);
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

Signing and notarization are optional: after configuring `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD` and `APPLE_TEAM_ID` in the repository Secrets, the pipeline signs and notarizes automatically; otherwise an ad-hoc signed build is produced for testing only. You can also run the workflow manually from the Actions page and enter a version tag. In-app updates always read the latest GitHub Release of the public `northes/tinker-kit` repository.

## Contributing

Issues and pull requests are welcome — report bugs or request features via [Issues](https://github.com/northes/tinker-kit/issues), and submit code via Pull Requests:

- Run `npx tsc --noEmit` inside `frontend/` before submitting;
- Keep the existing compact one-line code style (see `AGENTS.md` for details);
- When adding a new tool, follow the wiring checklist in `AGENTS.md` so the command palette, history and tray matching stay in sync;
- User-facing copy goes through locale files — no hardcoded strings.

## License

This project is licensed under the [MIT License](LICENSE). You are free to use, modify and distribute it, including for commercial purposes, as long as you retain the copyright and license notice.
