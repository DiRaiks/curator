# Architecture (MVP)

## Layers

```
┌─────────────────────────────────────────────────────────┐
│  React + TypeScript (apps/desktop/src)                  │
│  - Welcome → picks a folder via @tauri-apps/plugin-dialog│
│  - Dashboard → renders ScanResult                       │
└──────────────────┬──────────────────────────────────────┘
                   │ invoke("scan_vault", { path })
                   ▼
┌─────────────────────────────────────────────────────────┐
│  Tauri shell (apps/desktop/src-tauri)                   │
│  - thin wrapper exposing two commands:                  │
│      scan_vault(path) → vault_core::scan_vault          │
│      demo_vault_path()                                  │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│  vault-core (crates/vault-core)                         │
│  - walkdir-based recursive scan                         │
│  - YAML frontmatter parser (serde_yaml_ng)              │
│  - Returns ScanResult (serde, camelCase)                │
└─────────────────────────────────────────────────────────┘
```

## Why split `vault-core` from `src-tauri`?

The Tauri shell only needs to know how to wire a command to a function. All
filesystem / parsing logic lives in a plain Rust library crate so it can be:

- unit-tested without Tauri
- reused later from a CLI, an LSP, or a different shell

## Vault conventions

| What                             | Where                                  |
| -------------------------------- | -------------------------------------- |
| vault config (presence-only)     | `.vault/config.yml`                    |
| skill definitions                | `.vault/skills/*.skill.md` (frontmatter) |
| projects                         | `02_projects/<slug>/_index.md`         |
| general content                  | any `*.md` anywhere in the vault       |

Pruned during scan: `node_modules/`, `target/`, `.git/`.

## Skill frontmatter

```yaml
---
id: <required, string>
title: <required, string>
version: <optional, string>
status: <optional, string>
order: <optional, integer>
output_file: <optional, string>
---
```

Missing `id` or `title` produces an error diagnostic and the skill is dropped.

## Diagnostics

Three severity levels (`info` / `warning` / `error`). The MVP emits:

- `warning`: `.vault/config.yml` missing
- `warning`: `02_projects/<slug>/_index.md` missing
- `warning`: duplicate skill id
- `error`: skill failed to parse (frontmatter problem)
- `warning`: filesystem walk errors

## Out of scope (do not add without updating the brief)

AI calls, Claude/Codex runner, git, repo connectors, Markdown editor, graph
view, benchmarks, arbitrary shell exec, plugin system, auth, cloud sync.
