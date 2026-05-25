# Curator — Project Brief

## What this is

A **memory-augmented agentic workspace**. You work on projects (code +
knowledge), an embedded AI runner does the heavy lifting, and your
vault accumulates reusable patterns / decisions / findings so each
next task starts from more context than the last.

Unlike Claude desktop / Cursor / Zed agent, the value compounds over
time — the vault is your persistent memory across sessions and
projects. The IDE itself is the curation surface that makes that
memory navigable.

Target user: someone who works across many projects and wants
accumulated knowledge to outlive individual chat sessions. Security
researchers, audit firms, internal sec teams, and consultants /
contractors are the strongest fits.

## Tech stack

- Tauri v2 — desktop shell, no backend server, no cloud
- React + TypeScript + Vite — frontend
- Rust — vault-core (scanning, watching, runner abstraction)
- Local filesystem only; no telemetry; no cloud sync

## Repository layout

```
apps/desktop/
  src/                 # React + TS frontend
  src-tauri/           # Tauri Rust shell (wires vault-core into commands)
crates/vault-core/
  src/
    scan.rs            # vault scan entry point
    watch.rs           # notify-based filesystem watcher
    config.rs          # .vault/config.yml + format-version policy
    artifacts/         # artifact discovery + parsing (per kind)
    preview/           # run plan + runner-agnostic prompt builder
    runner/            # CLI runner abstraction + ClaudeCode impl
    markdown_io.rs     # vault-rooted read / write / create / promote / discard
    source_repo.rs     # read-only repo inspection (git status, detected files)
    scope.rs           # privacy-zone classification
    frontmatter.rs     # YAML helpers
    types.rs           # serializable data types
examples/demo-vault/   # sample vault used by "Open Demo Vault"
docs/                  # architecture notes
```

## Vault convention

| What                                  | Where                                                   |
| ------------------------------------- | ------------------------------------------------------- |
| vault config (parsed)                 | `.vault/config.yml` — declares `version:`               |
| projects                              | `02_projects/<slug>/_index.md`                          |
| per-machine project overlay (optional)| `02_projects/<slug>/_local.md` (merged on top of index) |
| zones (privacy classification)        | top-level folders + frontmatter `scope:`                |
| vault-skills                          | `.vault/skills/*.skill.md`                              |
| agent-prompts                         | `00_meta/agent-tasks/prompts/*.md`                      |
| claude-skills                         | `00_meta/_claude/skills/<name>/SKILL.md`                |
| claude-agents                         | `00_meta/_claude/agents/*.md`                           |
| claude-commands                       | `00_meta/_claude/commands/*.md`                         |
| claude-rules                          | `00_meta/_claude/rules/*.md`                            |
| agent-produced drafts                 | `01_inbox/_drafts/*.md` (by convention)                 |

## Core capabilities (current)

1. **Vault scan + watch** — Rust scanner produces a `ScanResult`
   (projects, artifacts, zones, drafts, diagnostics); a `notify`-based
   watcher fires `vault:changed` events on debounced file activity.
2. **Markdown editor** — CodeMirror 6 source mode + `react-markdown`
   preview with GFM. Frontmatter renders as an editable form (or
   read-only metadata in preview). Wikilinks (`[[target]]`,
   `[[target|alias]]`) navigate by path or filename stem.
3. **Embedded CLI runner** — spawns `claude -p <prompt>
   --output-format stream-json --verbose --permission-mode acceptEdits
   --add-dir <vault>` with cwd set to the project repo (validated via
   a deny-list of sensitive paths). Streams events to a Run panel.
   Supports `--resume <session_id>` for back-and-forth conversation.
4. **All artifact kinds runnable** — skills, commands, agents,
   vault-skills, and agent-prompts are all invokable. Only
   `claude-rule` is read-only (rules are policy fragments, not
   stand-alone tasks).
5. **Drafts workflow (inbox-to-review)** — agents propose reusable
   knowledge notes by writing into `01_inbox/_drafts/` with
   `status: draft-from-agent` + `proposed_destination`. User curates
   via the Drafts tab: Promote moves the file to the proposed
   destination and rewrites frontmatter (`status: promoted`,
   `promoted_from: <draft path>`); Discard deletes it.
6. **Source-repo inspection** — read-only snapshot (git branch /
   dirty / commit / detected files / top-level listing) for the
   project's declared `local_path`.
7. **Vault format versioning** — `.vault/config.yml` declares
   `version:`; IDE warns when the vault is newer than it supports.

## Scan result shape (current; see `crates/vault-core/src/types.rs`)

```ts
interface ScanResult {
  vaultRoot: string;
  homeDir: string | null;
  hasMeta: boolean;
  hasAgentsMd: boolean;
  hasAboutMe: boolean;
  hasMetaReadme: boolean;
  hasGit: boolean;
  hasVaultConfig: boolean;
  vaultFormatVersion: string | null;
  vaultFormatSupported: boolean;
  markdownFiles: MarkdownFile[];
  zones: Zone[];
  artifacts: WorkflowArtifact[];
  projects: Project[];
  drafts: Draft[];
  diagnostics: Diagnostic[];
}
```

## Out of scope (deliberate, current)

- Multi-vault workspaces (one vault open at a time)
- Branch / multi-tab conversation management
- Built-in tool whitelisting per-artifact (uses `~/.claude/settings.json`
  for now; per-artifact `--allowed-tools` is a tracked follow-up)
- Cloud sync, telemetry, multi-user features
- Embedded vector retrieval (frontmatter / wikilink-based for now)

## What's next on the roadmap

Tracked separately, but the major pieces in flight:

- **Recommendations engine** — rule-based hints in ProjectDetail
  ("no domain.md yet — try the `01-domain` skill", "git changes
  since last KB entry — try `session-reflect`", etc.)
- **CVE feed integration** — pluggable feed sources, match against
  project deps, surface as actionable suggestions
- **Per-zone agent access toggles** — opt-in expansion of agent
  read/write into personal zones via `.vault/config.yml`
- **Tool whitelisting from `claude-agent.tools[]` frontmatter** + an
  Approve-tools dialog for dangerous capabilities
- **Persistent agent permission rules** — the inline permission card
  (via ACP `session/request_permission`) handles ad-hoc approvals
  today; a follow-up adds persistent allow/deny lists per chat or
  globally (`Bash(curl:*) allow`, `Read(~/.ssh/**) deny`), per-runner
  sandbox levels for codex (`read-only` / `workspace-write` /
  `danger-full-access`), and a UI surface to manage them. Storage
  likely co-located with session history in `app.db`.
- **Conversation persistence** — keep the last N session transcripts
  on disk so reopening the IDE restores context

## Design principles

- **Vault is git-tracked source of truth** — IDE never auto-commits;
  user reviews via `git diff`. This is the entire safety model for
  agent writes.
- **Curation, not auto-promote** — agents propose knowledge into
  `01_inbox/_drafts/`; promotion to permanent zones is always a
  human decision.
- **Skills are first-class** — they're versioned content in the
  vault, not hard-coded behaviour. Any user can fork / customize /
  share via git.
- **No cloud, no telemetry, no auth** — single-user desktop tool.
- **Boring, governed dependencies** — see `AGENTS.md` and
  `CONTRIBUTING.md` for the supply-chain policy.
