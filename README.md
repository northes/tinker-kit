<div align="center">

<h1>
  <img src="assets/logo/tinkerkit-logo.svg" alt="TinkerKit" height="52" align="absmiddle">
  TinkerKit
</h1>

### One workbench for every dev task

Look inside JSON, timestamps, JWT, SSH hosts, containers and network calls: 15 tools in one local-first macOS app, with nothing to deploy.

[![release](https://img.shields.io/github/v/release/northes/tinker-kit?sort=semver&label=release)](https://github.com/northes/tinker-kit/releases)
[![downloads](https://img.shields.io/github/downloads/northes/tinker-kit/total?label=downloads)](https://github.com/northes/tinker-kit/releases)
[![license](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-000000)](#installation)
[![Wails](https://img.shields.io/badge/Wails-v3%20beta-DF0D3F)](https://v3.wails.io/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)

[Download](https://github.com/northes/tinker-kit/releases) · [Install guide](#installation) · [Tools](#built-in-tools) · [Privacy](#privacy--network) · [简体中文](README.zh-CN.md)

<img src="assets/screenshot.png" alt="TinkerKit main window" width="100%">

</div>


## Features

- **Local-first, offline by default** — No accounts, no telemetry, and no collection or upload of your content. Keys, tokens and logs are processed and stored only on your machine.
- **Menu-bar resident, always on call** — TinkerKit lives in the menu bar; closing the window hides it to the tray (the Dock icon reappears while the window is shown). Copy anything, right-click the tray icon, and TinkerKit auto-detects JSON / timestamps / URL / JWT / Base64 / text and jumps to the matching tool (asks for confirmation by default; enable “auto fill” to skip it).
- **Command palette, keyboard-first** — Press `⌘K` / `Ctrl+K` to search every command with fuzzy matching, including pinyin and initial letters for Chinese, filtered by the current context. Nearly everything can be done without touching the mouse.
- **Remote and container debugging** — SSH file management, port forwarding, containers and services, image management and network tests share one set of connection profiles, so you don’t have to switch between the terminal and several GUIs.
- **History kept on-device** — Tool activity is recorded locally, filterable by tool and time range, with pagination, on-demand loading for large entries, and one-click restore.
- **Portable configuration** — Settings, custom sources and connection credentials can be exported, imported and reset, and history can be cleared in one click; launch at login and background notifications are supported.
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

Requires macOS 12 or later; supports Apple Silicon and Intel. Upgrade or uninstall:

```bash
brew update
brew upgrade --cask --greedy northes/tinker-kit/tinker-kit
brew uninstall --cask northes/tinker-kit/tinker-kit
```

The app also updates itself, so Homebrew upgrades use `--greedy`. Uninstalling preserves local configuration and history. For first-launch security warnings, follow the instructions below.

### DMG installation

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
- Configuration, history and sources live in `~/Library/Application Support/TinkerKit/` (`config.json`, `history.json` and `history-data/`). Clear history or export / import / reset the configuration under “Settings → Data & security” (reset restores defaults and removes all custom sources and connection credentials).

## License

This project is licensed under the [MIT License](LICENSE). You are free to use, modify and distribute it, including for commercial purposes, as long as you retain the copyright and license notice.
