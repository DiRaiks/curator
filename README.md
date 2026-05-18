# vault-workflow-ide

Desktop workflow IDE for Markdown vaults. **Not** a code editor — a small tool
that opens a local folder, detects projects/skills/diagnostics, and surfaces
them in a dashboard.

See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the full brief and
[`docs/architecture.md`](./docs/architecture.md) for the layout.

## Stack

- Tauri v2 (desktop shell, no backend server, no cloud)
- React + TypeScript + Vite (frontend)
- Rust (`crates/vault-core` does the scanning)

## Layout

```
apps/desktop/          # Tauri app
  src/                 # React + TS frontend
  src-tauri/           # Tauri Rust shell
crates/vault-core/     # Vault scanner / parser
examples/demo-vault/   # Sample vault used by "Open Demo Vault"
docs/                  # Architecture notes
```

## Prerequisites

- **Node** ≥ 20 (developed against 24.x)
- **npm** (this repo is standardized on npm — do not switch managers; see
  [`AGENTS.md`](./AGENTS.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md))
- **Rust** stable (developed against 1.95)
- Platform Tauri prerequisites (macOS / Linux / Windows): see
  https://v2.tauri.app/start/prerequisites/

## First-time setup

```bash
npm install
```

That's it — `cargo` deps are fetched on first `npm run tauri:dev`.

## Run the desktop app

```bash
npm run tauri:dev
```

The Welcome screen opens with two buttons:

- **Open Vault…** — pick any local folder
- **Open Demo Vault** — opens `examples/demo-vault` (works in dev mode only)

## Other scripts

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Same as `tauri:dev` (alias)                           |
| `npm run typecheck`    | `tsc --noEmit` on the frontend                        |
| `npm run tauri:build`  | Production bundle (see icon note below)               |

## Building a real bundle

The repo ships **placeholder icons** so `tauri dev` works on a fresh checkout.
Before `tauri build`, replace them with real ones:

```bash
cd apps/desktop
npx @tauri-apps/cli icon path/to/your-icon.png
```

This generates proper `.icns` (macOS), `.ico` (Windows), and PNGs.

## Supply-chain rules

This repo is standardized on **npm** for governance reasons. Do not switch to
pnpm/yarn/bun. Do not add dependencies (npm or cargo) without the explanation
template in [`CONTRIBUTING.md`](./CONTRIBUTING.md). Do not run install commands
in CI / automation without explicit approval.

## What this MVP does NOT include

AI calls, Claude/Codex runner, git integration, repo connectors, Markdown
editor, graph view, benchmark runner, arbitrary shell execution, plugin
system, authentication, cloud sync. All deliberately out of scope.
