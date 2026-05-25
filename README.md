<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Curator icon" />

# Curator

**Agents work. The vault remembers.**

A desktop **memory-augmented agentic IDE** for Markdown knowledge
vaults. Open a vault, work on projects with an embedded AI runner
(Claude Code subprocess), and let the vault accumulate reusable
knowledge across sessions.

![Tauri](https://img.shields.io/badge/tauri-v2-orange?style=flat-square)
![Rust](https://img.shields.io/badge/rust-stable-orange?style=flat-square)
![TypeScript](https://img.shields.io/badge/typescript-5-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Status](https://img.shields.io/badge/status-pre--release-yellow?style=flat-square)

</div>

---

## Why

Most agentic tools forget. Each new chat starts from zero, even when
last week's session learned exactly what this one needs to know. The
value evaporates with the conversation.

Curator inverts that: the **vault** — a plain git-tracked Markdown
folder you already keep — is the persistent memory. The IDE is the
**curation surface** that makes accumulated patterns, decisions, and
findings navigable across projects and sessions. Each task starts
from more context than the last.

Target user: someone who works across many projects and wants
accumulated knowledge to outlive individual chat sessions — security
researchers, audit firms, internal sec teams, consultants.

## Stack

- **Tauri v2** — desktop shell. No backend server, no cloud.
- **React + TypeScript + Vite** — frontend.
- **Rust** — `crates/vault-core` does scanning, watching, the runner
  abstraction, and vault-rooted file IO.

## What you can do today

- **Browse** — projects, artifacts (skills / commands / agents /
  prompts), drafts, and privacy zones. Tree + frontmatter pills give
  vault state at a glance.
- **Edit** — Markdown notes in CodeMirror with rendered preview,
  frontmatter form, and wikilink navigation (`[[target]]` /
  `[[target|alias]]`).
- **Run** — any artifact (except `claude-rule`) against a project. The
  IDE drives a vendored ACP server (`claude-agent-acp` for Claude,
  `codex-acp` for Codex) over JSON-RPC, with the vault forwarded as
  ACP `additional_directories` and cwd set to the project repo.
  Up to 3 chats run concurrently in a tabbed bottom drawer; each tab
  can Stop, Reply (resume by session id), or approve / deny tool calls
  inline.
- **Curate drafts** — agents drop proposed knowledge notes into
  `01_inbox/_drafts/` with `status: draft-from-agent` and
  `proposed_destination`. Review in the Drafts tab and Promote (moves
  to destination + rewrites frontmatter) or Discard.
- **Watch** — `notify`-based file watcher fires `vault:changed` and
  triggers automatic rescans.
- **Track** — session history, recent vaults, CVE scan against project
  dependencies (OSV.dev), and a rule-based recommendations engine.

## Layout

```
apps/desktop/          # Tauri app
  src/                 # React + TS frontend
  src-tauri/           # Tauri Rust shell
crates/vault-core/     # Vault scanner / runner / markdown IO
examples/demo-vault/   # Sample vault used by "Open Demo Vault"
docs/                  # Architecture notes
```

See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the full vision and
[`docs/architecture.md`](./docs/architecture.md) for the layered split.

## Prerequisites

- **Node** ≥ 20 (developed against 24.x)
- **npm** — this repo is standardized on npm. Do not switch managers;
  see [`AGENTS.md`](./AGENTS.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Rust** stable (developed against 1.95)
- **Claude Code CLI** (`claude`) on `PATH` for the embedded runner.
  The IDE delegates to your system `claude` via the vendored
  `claude-agent-acp` wrapper (`CLAUDE_CODE_EXECUTABLE` env). Tool-use
  approval is interactive: the agent's `session/request_permission`
  RPC surfaces an inline card in the chat tab. Your global
  `~/.claude/settings.json` allowlist still applies underneath.
- **Codex** runner — `codex-acp` ships as a self-contained native
  binary fetched by `scripts/fetch-acp-binaries.sh`, so you don't need
  `codex` on `PATH` at runtime. Authentication, however, comes from
  `~/.codex/` (config.toml + login state). The easiest way to populate
  it is to install the upstream `codex` CLI once and run `codex login`
  (or write `~/.codex/config.toml` with an OpenAI API key yourself);
  after that codex-acp reuses the same auth.
- **bash** — required to run `scripts/fetch-acp-binaries.sh`. Native
  on macOS / Linux; on Windows use WSL or Git Bash.
- Platform Tauri prerequisites — see
  https://v2.tauri.app/start/prerequisites/

## Quick start

```bash
npm install
./scripts/fetch-acp-binaries.sh
npm run tauri:dev
```

`fetch-acp-binaries.sh` downloads the pinned per-platform `codex-acp`
native binary from npm into `apps/desktop/src-tauri/binaries/`. It's a
~170 MB download per platform and is `.gitignored` rather than
committed (re-run after pulling if the pinned version changes).
The `claude-agent-acp` JS wrapper is tiny and lives in
`apps/desktop/src-tauri/resources/acp/` committed directly.

The Welcome screen offers two paths:

- **Open Vault…** — pick any local folder
- **Open Demo Vault** — opens `examples/demo-vault` (dev only; not
  bundled into release builds)

## Scripts

| Command                | What it does                              |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Alias for `tauri:dev`                     |
| `npm run typecheck`    | `tsc --noEmit` on the frontend            |
| `npm run tauri:build`  | Production bundle                         |

Rust:

```bash
cargo test --workspace            # full test suite
cargo clippy --workspace          # lint
```

## Building a release bundle

```bash
npm run tauri:build
```

Produces a platform-native `.app` / `.dmg` / `.msi` / AppImage with
the bundled Curator icon set under `target/release/bundle/`.

## Privacy & security model

- **No telemetry, no cloud sync, no auth** — single-user desktop tool.
- Tool-use approval is interactive via the inline permission card
  driven by ACP's `session/request_permission` RPC. The vault is
  expected to be git-tracked, so you review agent writes via
  `git diff` before committing. Persistent allow/deny rules per chat
  are on the roadmap.
- Workdir for spawned subprocesses is canonicalized and checked
  against a deny-list of sensitive paths (`/etc`, `/Library`,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, etc.) so a
  vault-declared `local_path` can't redirect the agent into
  credential locations.
- Personal-work / team-management zones are excluded from default AI
  context. A per-zone opt-in toggle is on the roadmap.
- Promoting drafts and writing files always goes through vault-rooted
  path validation — symlink escape, `..` traversal, and writes into
  `.git/` / `node_modules/` / `target/` / `.next/` / `dist/` /
  `build/` / root `.claude/` are rejected.

## Supply-chain policy

This repo is standardized on **npm**. Do not switch to pnpm/yarn/bun.
Do not add dependencies (npm or cargo) without the explanation
template in [`CONTRIBUTING.md`](./CONTRIBUTING.md). Do not run install
commands in CI / automation without explicit approval.

## Out of scope today

Cloud sync, multi-vault workspaces, embedded vector retrieval,
multi-tab chats, branch history. See
[`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the in-flight roadmap.

## License

MIT.
