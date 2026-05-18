# Vault Workflow IDE — Project Brief

## What this is

Vault Workflow IDE is a **desktop workflow tool for Markdown vaults**. It is not
a code editor. It opens a local folder of Markdown files that follows a simple
convention (`.vault/`, `02_projects/`, skills, etc.), and surfaces the structure
so the user can navigate projects and skills inside the vault.

## Tech stack

- Tauri (v2) — desktop shell, no backend server, no cloud
- React + TypeScript + Vite — frontend
- Rust — vault scanning / parsing (`crates/vault-core`)
- Local filesystem only

## Repository layout

- `apps/desktop/` — Tauri app
  - `src/` — React + TypeScript frontend
  - `src-tauri/` — Tauri Rust shell (re-exports `vault-core` via a `scan_vault` command)
- `crates/vault-core/` — Rust crate that does the actual scan/parse work
- `examples/demo-vault/` — sample vault used by the "Open Demo Vault" button
- `docs/` — architecture notes

## Vault convention (what the scanner looks for)

- `.vault/config.yml` — vault config (presence detected, not parsed in MVP)
- `.vault/skills/*.skill.md` — skill files with YAML frontmatter
- `02_projects/<slug>/_index.md` — project index files
- all `*.md` files anywhere in the vault

## Scan result shape

```ts
type ScanResult = {
  vaultRoot: string;
  configExists: boolean;
  markdownFiles: string[];          // paths relative to vault root
  skills: Skill[];
  projects: Project[];
  diagnostics: Diagnostic[];
};

type Skill = {
  id: string;
  title: string;
  version: string | null;
  status: string | null;
  order: number | null;
  outputFile: string | null;
  path: string;                     // relative to vault root
};

type Project = {
  slug: string;
  path: string;                     // relative to vault root
  indexFile: string;                // relative to vault root
};

type Diagnostic = {
  level: "info" | "warning" | "error";
  message: string;
  path: string | null;              // relative to vault root if applicable
};
```

## MVP scope (this slice)

1. Tauri + React + TS app scaffolded.
2. Rust command `scan_vault(path: string)` returns `ScanResult`.
3. `scan_vault` walks the folder, detects the items above, parses skill
   frontmatter, and surfaces basic diagnostics.
4. UI:
   - Welcome screen with "Open Vault" + "Open Demo Vault"
   - Dashboard with left file tree, project list, skill list, diagnostics panel

## Out of scope (do NOT add)

AI calls, Claude/Codex runner, git integration, code-repo connector,
Markdown editor, graph view, benchmark runner, arbitrary shell execution,
plugin system, auth, cloud sync.

Keep scope small. Working vertical slice over broad abstractions.
