# Agent Instructions

## Package manager policy

This repository is standardized on **npm** for supply-chain governance.

Rules:

1. Do **not** use pnpm, yarn, or bun. Do not create `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `yarn.lock`, or `bun.lockb`. If one appears, delete it.
2. The only lockfile is `package-lock.json`.
3. `package.json` must declare `"packageManager": "npm@<current-version>"`.
4. Do **not** switch package managers without explicit maintainer approval.
5. Do **not** add a dependency (runtime or dev, npm or cargo) without first
   explaining all of:
   - package name
   - why it is needed
   - whether it is runtime or dev
   - alternatives considered
   - supply-chain risk (maintainership, popularity, transitive footprint)
6. Do **not** run install commands (`npm install`, `npm i`, `cargo build`,
   `cargo add`, etc.) without maintainer approval.
7. Do not modify lockfiles casually.

## Security posture

This is a security-first project. Prefer boring, widely adopted, well-governed
tools over faster or more convenient alternatives.

## Subsystem docs — read before changing

Code-level comments cover the **what** + immediate **why**; the docs
below explain the **architecture**, the historical bugs that shaped
current design, and the cross-file data flow. Read the relevant one
before non-trivial work in that area.

- [`docs/architecture.md`](docs/architecture.md) — top-level layer map
  (React → Tauri shell → `vault-core`), command surface, threading,
  vault conventions, security boundaries.
- [`docs/shell.md`](docs/shell.md) — shell v2 frontend: rail/panel
  layout, state + persistence keys, resize rules, editor theming, CSS
  conventions (`.ide` scope, bridge vars, the `:where()` reset
  gotcha), popover positioning hook.
- [`docs/multi-chat.md`](docs/multi-chat.md) — agent panel chats:
  `RunState` as a `HashMap<RunId, ActiveRun>` (cap = 3), how `runId`
  is minted and threaded through every event, the strict
  `isMine(runId)` filter that keeps sibling chat tabs isolated, the
  invoke-return race fix, inline `PermissionRequestCard` (replaces the
  old global `ApproveToolsModal`), and the status aggregation that
  feeds the AI handle / StatusBar.

When you change something documented there, update the doc in the
same PR. Stale architecture docs are worse than no docs.
