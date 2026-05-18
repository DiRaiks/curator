# vault-workflow-ide

Desktop **memory-augmented agentic workspace**. Open a markdown vault,
work on projects with an embedded AI runner (Claude Code subprocess),
and let the vault accumulate reusable knowledge across sessions.

See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the full vision and
[`docs/architecture.md`](./docs/architecture.md) for the layered split.

## Stack

- Tauri v2 (desktop shell; no backend server, no cloud)
- React + TypeScript + Vite (frontend)
- Rust — `crates/vault-core` does scanning, watching, the runner
  abstraction, and vault-rooted file IO

## Layout

```
apps/desktop/          # Tauri app
  src/                 # React + TS frontend
  src-tauri/           # Tauri Rust shell
crates/vault-core/     # Vault scanner / runner / markdown IO
examples/demo-vault/   # Sample vault used by "Open Demo Vault"
docs/                  # Architecture notes
```

## Prerequisites

- **Node** ≥ 20 (developed against 24.x)
- **npm** (this repo is standardized on npm — do not switch managers;
  see [`AGENTS.md`](./AGENTS.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md))
- **Rust** stable (developed against 1.95)
- **Claude Code CLI** (`claude`) on `PATH` if you want to use the
  embedded runner. Set up your global allowlist in
  `~/.claude/settings.json`; the IDE passes
  `--permission-mode acceptEdits` so file writes don't hang, but
  Bash / network / MCP still respect your config.
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
- **Open Demo Vault** — opens `examples/demo-vault` (works in dev
  mode only; not bundled into release builds)

## What you can do today

- **Browse** projects, artifacts (skills / commands / agents /
  prompts), drafts, and privacy zones; tree + frontmatter pills give
  you the vault state at a glance.
- **Edit** Markdown notes in CodeMirror with rendered preview,
  frontmatter form, and wikilink navigation (`[[target]]` or
  `[[target|alias]]`).
- **Run** any artifact (except `claude-rule`) against a project — the
  IDE spawns `claude` in the repo with the vault as `--add-dir`,
  streams events into a bottom Run panel, and lets you Stop or Reply
  (to resume the conversation via `--resume <session_id>`).
- **Curate drafts** — agents drop proposed knowledge notes into
  `01_inbox/_drafts/` with `status: draft-from-agent` and
  `proposed_destination`; you review them in the Drafts tab and
  Promote (moves to destination + rewrites frontmatter) or Discard.
- **Watch** the vault — `notify`-based file watcher fires
  `vault:changed` and triggers automatic rescans.

## Scripts

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Same as `tauri:dev` (alias)                           |
| `npm run typecheck`    | `tsc --noEmit` on the frontend                        |
| `npm run tauri:build`  | Production bundle (see icon note below)               |

Rust:

```bash
cargo test --workspace            # full test suite (unit + integration)
cargo clippy --workspace          # lint
```

## Building a real bundle

The repo ships **placeholder icons** so `tauri dev` works on a fresh
checkout. Before `tauri build`, replace them with real ones:

```bash
cd apps/desktop
npx @tauri-apps/cli icon path/to/your-icon.png
```

This generates proper `.icns` (macOS), `.ico` (Windows), and PNGs.

## Supply-chain rules

This repo is standardized on **npm** for governance reasons. Do not
switch to pnpm/yarn/bun. Do not add dependencies (npm or cargo) without
the explanation template in [`CONTRIBUTING.md`](./CONTRIBUTING.md). Do
not run install commands in CI / automation without explicit approval.

## Privacy and security model

- No telemetry, no cloud sync, no auth — single-user desktop tool.
- Vault writes by the agent are auto-approved (`--permission-mode
  acceptEdits`) because the vault is expected to be git-tracked and
  the user reviews via `git diff` before committing. Other tools
  (Bash, MCP, network) follow the user's global Claude Code config.
- Workdir for spawned subprocesses is canonicalized and checked
  against a deny-list of sensitive paths (`/etc`, `/Library`,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, etc.) so a
  vault-declared `local_path` can't redirect the agent into
  credential locations.
- Personal-work / team-management zones are excluded from default
  AI context. A per-zone opt-in toggle is on the roadmap.
- Promoting drafts and writing files always goes through vault-rooted
  path validation — symlinks-escape, `..` traversal, and writes into
  `.git/` / `node_modules/` / `target/` / `.next/` / `dist/` /
  `build/` / root `.claude/` are rejected.

## Out of scope today

Cloud sync, multi-vault workspaces, embedded vector retrieval,
multi-tab chats, branch history, conversation persistence across
restarts. See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the
in-flight roadmap.
