---
title: Architecture
description: How the desktop shell, Rust core, and ACP runner fit together.
order: 2
---

# Architecture

Curator is a layered desktop app: a thin Tauri shell, a React frontend, and a
Rust core that owns everything that touches the filesystem.

## Repository layout

```
apps/desktop/
  src/           # React + TS frontend
  src-tauri/     # Tauri Rust shell (wires vault-core into commands)
crates/vault-core/
  scan.rs        # vault scan entry point
  watch.rs       # notify-based filesystem watcher
  config.rs      # .vault/config.yml + format-version policy
  artifacts/     # artifact discovery + parsing (per kind)
  preview/       # run plan + runner-agnostic prompt builder
  runner/        # ACP-driven runner abstraction (Claude + Codex)
  markdown_io.rs # vault-rooted read / write / create / promote / discard
  source_repo.rs # read-only repo inspection (project local_path)
  git.rs         # vault git: status / diff / stage / commit / log
  scope.rs       # privacy-zone classification
examples/demo-vault/
docs/
```

## The three layers

- **Tauri shell**: desktop window, native dialogs, and the command bridge that
  exposes `vault-core` functions to the frontend. No backend server.
- **React frontend**: the curation surface: an activity rail, swappable
  left panels (including the agent panel), a CodeMirror editor, the
  always-docked vault file tree, drafts review, and tracking dashboards.
- **vault-core (Rust)**: scanning, the `notify`-based watcher, the runner
  abstraction, and all vault-rooted file IO. Every write goes through path
  validation here.

## The embedded runner

Curator drives a vendored ACP server over JSON-RPC on subprocess stdio:

- `claude-agent-acp` (a JS wrapper) for Claude
- `codex-acp` (a native binary) for Codex

The vault is forwarded via ACP `additional_directories`; the working directory
is set to the project repo and validated against a deny-list of sensitive
paths. The agent panel runs up to three chats concurrently. Each streams
`session/update` events, surfaces an inline card on `session/request_permission`,
and supports resume by session id.

## Vault convention

| What | Where |
| --- | --- |
| vault config | `.vault/config.yml` (declares `version:`) |
| projects | `02_projects/<slug>/_index.md` |
| per-machine overlay | `02_projects/<slug>/_local.md` |
| vault-skills | `.vault/skills/*.skill.md` |
| agent-prompts | `00_meta/agent-tasks/prompts/*.md` |
| claude-skills | `00_meta/_claude/skills/<name>/SKILL.md` |
| claude-agents | `00_meta/_claude/agents/*.md` |
| claude-commands | `00_meta/_claude/commands/*.md` |
| agent-produced drafts | `01_inbox/_drafts/*.md` |

## Design principles

- **The vault is the git-tracked source of truth.** The IDE never auto-commits;
  you review every agent write with `git diff` — in the built-in Source Control
  view (diff / stage / commit) or an external editor. Commits are always
  explicit; there is no automatic commit path.
- **Curation, not auto-promote.** Agents propose knowledge into an inbox;
  promotion to permanent zones is always a human decision.
- **Skills are first-class**: versioned content in the vault, not hard-coded
  behaviour. Fork, customize, and share via git.
