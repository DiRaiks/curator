---
title: Quick start
description: Build Curator from source and open your first vault.
order: 1
---

# Quick start

Curator is pre-release. There are no prebuilt binaries yet, so you build from
source.

## Prerequisites

- **Node** 20 or newer (developed against 24.x)
- **npm** — this repo is standardized on npm; do not switch managers
- **Rust** stable (developed against 1.95)
- **Claude Code CLI** (`claude`) on your `PATH` for the embedded runner
- **bash** — required to run the ACP fetch script (native on macOS/Linux; use
  WSL or Git Bash on Windows)
- Platform [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Install and run

From the repository root:

```bash
npm install
./scripts/fetch-acp-binaries.sh
npm run tauri:dev
```

`fetch-acp-binaries.sh` downloads the pinned per-platform `codex-acp` native
binary into `apps/desktop/src-tauri/binaries/`. It is a ~170 MB download per
platform and is gitignored rather than committed, so re-run it after pulling if
the pinned version changes. The `claude-agent-acp` JS wrapper is tiny and lives
committed in `apps/desktop/src-tauri/resources/acp/`.

## First launch

The Welcome screen offers two paths:

- **Open Vault…** — pick any local folder
- **Open Demo Vault** — opens `examples/demo-vault` (dev only; not bundled into
  release builds)

## Runner authentication

- **Claude** — the IDE delegates to your system `claude` via the vendored
  `claude-agent-acp` wrapper. Tool-use approval is interactive: each
  permission request surfaces an inline card in the chat tab, and your global
  `~/.claude/settings.json` allowlist still applies underneath.
- **Codex** — `codex-acp` ships as a self-contained binary, but authentication
  comes from `~/.codex/`. The easiest way to populate it is to install the
  upstream `codex` CLI once and run `codex login`.

## Build a release bundle

```bash
npm run tauri:build
```

This produces a platform-native `.app` / `.dmg` / `.msi` / AppImage under
`target/release/bundle/`.
