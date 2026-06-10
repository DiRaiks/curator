# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  React + TypeScript (apps/desktop/src)                               │
│  - Welcome → picks a vault folder via @tauri-apps/plugin-dialog      │
│  - Dashboard: Projects / AI Artifacts / Drafts / Zones /             │
│    Diagnostics / Security / Source Control                           │
│  - EditorPanel (CodeMirror + react-markdown), FrontmatterForm        │
│  - RunPanelHost + RunPanel × N (tabbed multi-chat drawer; each       │
│    tab streams its own backend run; inline permission card per tab)  │
│  - ContextPreview / ExternalRunnerPromptCard (run plan + Run button) │
└──────────────────────┬───────────────────────────────────────────────┘
                       │ Tauri commands (invoke + listen)
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Tauri shell (apps/desktop/src-tauri/src/lib.rs)                     │
│  Commands:                                                           │
│    scan_vault, preview_context, inspect_source_repo                  │
│    read_markdown_file, write_markdown_file, create_markdown_file     │
│    promote_draft, discard_draft                                      │
│    start_vault_watch / stop_vault_watch                              │
│    start_run / resume_run / start_freeform_run /                     │
│      resume_freeform_run — all return RunStartedPayload (incl. runId)│
│    stop_run(run_id) / approve_tool_use(run_id, request_id, …) /      │
│      deny_tool_use(run_id, request_id, …) — targeted by run id       │
│    get_runs() → Vec<RunStartedPayload> — snapshot of live runs       │
│    git_status / git_diff / git_stage / git_stage_all /               │
│      git_unstage / git_commit / git_log — vault SCM                  │
│  State:                                                              │
│    WatchState — active filesystem watcher token                      │
│    RunState — HashMap<RunId, ActiveRun>; up to                       │
│      MAX_CONCURRENT_RUNS=3 simultaneous claude subprocesses          │
│  Threads:                                                            │
│    Watcher emit pump → run:vault:changed                             │
│    Runner emit pumps (one per run) → run:started / stdout / stderr / │
│      truncated / permission-request / exit — every payload carries a │
│      `runId` so the frontend can demultiplex by chat tab             │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  vault-core (crates/vault-core)                                      │
│                                                                      │
│  scan.rs       — walkdir scan; produces ScanResult                   │
│  watch.rs      — notify + notify-debouncer-full; coalesced events    │
│  config.rs     — .vault/config.yml + format-version policy           │
│  scope.rs      — privacy-zone classification                         │
│  artifacts/    — discovery + parsing of agent-prompts / claude-      │
│                  skills / agents / commands / rules / vault-skills   │
│  preview/      — `preview_context` + runner-agnostic prompt builder  │
│  runner/       — Runner trait + ACP-driven Claude/Codex impls;       │
│                  tokio-based transport over `agent-client-protocol`; │
│                  permission flow + session resume                    │
│  markdown_io   — vault-rooted read/write/create/promote/discard      │
│                  with path validation (deny-list of sensitive dirs)  │
│  source_repo   — read-only git inspection (branch, dirty, commit,    │
│                  detected files, shallow top-level listing)          │
│  git          — vault-root SCM: status / diff / stage /              │
│                 unstage / commit / log (write-capable)               │
│  frontmatter.rs — YAML helpers                                       │
│  types.rs      — serializable data types (ScanResult, Draft, etc.)   │
└──────────────────────────────────────────────────────────────────────┘
```

## Why split `vault-core` from `src-tauri`?

The Tauri shell is a thin wrapper that wires commands to functions in
the core crate. All filesystem / parsing / runner logic lives in a
plain Rust library crate so it can be:

- unit-tested without Tauri
- reused later from a CLI, an LSP, or a different shell
- audited as a single security boundary

## Vault conventions

| What                                  | Where                                                |
| ------------------------------------- | ---------------------------------------------------- |
| vault config (parsed)                 | `.vault/config.yml` — declares `version:`            |
| projects                              | `02_projects/<slug>/_index.md`                       |
| per-machine project overlay (optional)| `02_projects/<slug>/_local.md` (merged on top of index)|
| agent-produced drafts                 | `01_inbox/_drafts/*.md` (by convention)              |
| vault-skills                          | `.vault/skills/*.skill.md`                           |
| agent-prompts                         | `00_meta/agent-tasks/prompts/*.md`                   |
| claude-skills                         | `00_meta/_claude/skills/<name>/SKILL.md`             |
| claude-agents                         | `00_meta/_claude/agents/*.md`                        |
| claude-commands                       | `00_meta/_claude/commands/*.md`                      |
| claude-rules                          | `00_meta/_claude/rules/*.md`                         |

Pruned during scan: `node_modules/`, `target/`, `dist/`, `build/`,
`.next/`, `.git/`, `.obsidian/`, `.claude/`, plus `._*` and
`.DS_Store`.

## Privacy zones

Each markdown file gets a `scope` derived from path segments + optional
frontmatter overrides. Used to filter what AI workflows include by
default:

| Scope             | Default treatment                                          |
| ----------------- | ---------------------------------------------------------- |
| `project`         | Included in project workflows                              |
| `meta`            | Included (vault conventions, AGENTS.md, etc.)              |
| `personal-work`   | Excluded by default                                        |
| `team-management` | Excluded by default                                        |
| `inbox`           | Excluded by default                                        |
| `resource`        | Excluded by default                                        |
| `archive`         | Excluded by default                                        |
| `unknown`         | Excluded by default                                        |

Explicit `scope:` in frontmatter overrides path classification.
`include_in_ai_context: false` demotes to `personal-work` unless the
path already classifies as `team-management`.

## Artifact kinds and runnability

| Kind             | Source location                              | Runnable |
| ---------------- | -------------------------------------------- | -------- |
| `agent-prompt`   | `00_meta/agent-tasks/prompts/*.md`           | yes      |
| `claude-command` | `00_meta/_claude/commands/*.md`              | yes      |
| `claude-agent`   | `00_meta/_claude/agents/*.md`                | yes      |
| `claude-skill`   | `00_meta/_claude/skills/*/SKILL.md`          | yes      |
| `vault-skill`    | `.vault/skills/*.skill.md`                   | yes      |
| `claude-rule`    | `00_meta/_claude/rules/*.md`                 | no       |

Rules are policy fragments auto-loaded by Claude Code based on path
globs; they are not stand-alone invokables. Everything else can be
selected in the ProjectDetail "Runnable on this project" list and
spawned via the embedded runner.

## Runner

`runner/mod.rs` defines the abstraction:

```rust
pub trait Runner: Send + Sync {
    fn kind(&self) -> RunnerKind;
    fn start(&self, req: RunRequest) -> Result<RunHandle, RunnerError>;
}

pub enum RunnerKind { ClaudeCode, Codex }

pub struct RunRequest {
    pub workdir: PathBuf,
    pub additional_dirs: Vec<PathBuf>,
    pub prompt: String,
    pub runtime_input: Option<String>,
    pub resume_session_id: Option<String>,
    pub model: Option<String>,
}

pub enum RunEvent {
    Stdout(String),               // one ACP `session/update` JSON per line (agent- or watcher-emitted)
    Stderr(String),
    Truncated { dropped_bytes: usize },
    PermissionRequest(PermissionRequest), // from ACP `session/request_permission`
    SessionStarted { session_id: String }, // post `session/new` or `session/load`
    Exit { code: Option<i32>, success: bool },
}
```

Both runners (`AcpClaudeRunner`, `AcpCodexRunner`) speak the open
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP) over
JSON-RPC on a subprocess's stdio. We don't drive `claude -p` or
`codex exec` directly anymore — instead we spawn the vendored
ACP-server wrappers, which give us interactive permission requests,
edit-review, terminal streaming, and the same wire shape for both
agents.

### Spawn shapes

**Claude** (`AcpClaudeRunner`):

```
node <bundled>/resources/acp/claude-agent-acp/dist/index.js
  env CLAUDE_CODE_EXECUTABLE=<system claude>
```

The JS wrapper is small (1.6 MB, committed) and delegates to the
user's system `claude` binary via `CLAUDE_CODE_EXECUTABLE`. We
explicitly do not ship the SDK's bundled platform binary (208 MB per
platform); requiring `claude` already on `PATH` matches how the IDE
behaved pre-ACP.

**Codex** (`AcpCodexRunner`):

```
<bundled>/binaries/codex-acp           (Tauri externalBin sidecar)
```

The codex-acp binary is a standalone 172 MB native executable that
embeds its own codex runtime. It's `.gitignored` and fetched into
`apps/desktop/src-tauri/binaries/codex-acp-<target-triple>` by
`scripts/fetch-acp-binaries.sh` (pinned npm version). Tauri's
externalBin slot then strips the triple suffix at bundle time and
ships the binary alongside the .app.

### Threading model

The transport (`runner/acp/transport.rs`) spawns one worker OS thread
per run. The thread owns a single-threaded tokio runtime which
drives the `agent-client-protocol` Rust crate's `Client`. The
async-to-sync bridge is three `std::sync::mpsc` channels:

- `events` — `RunEvent`s flow from ACP notification handlers / the
  coordinator into the sync receiver the Tauri shell consumes.
- `permissions` — host approval decisions (`PermissionDecision`) flow
  in via a `spawn_blocking`-bridged pump task; an internal
  `HashMap<request_id, oneshot::Sender>` correlates them with the
  pending `request_permission` callback waiting to respond.
- `kill` — `oneshot` signal; dropping the runtime cancels every
  outstanding task and the child receives EOF on stdin.

### Session lifecycle (per turn)

1. `initialize` — protocol V1 handshake.
2. `session/new` (fresh chat) or `session/load` (resume by
   `resume_session_id`). Both branches forward
   `additional_directories` so the agent can read the vault from a
   project-repo cwd.
3. `session/set_model` (optional, if `RunRequest.model` is set).
   Demoted to a Stderr event on unsupported agents.
4. Emit `RunEvent::SessionStarted { session_id }` so the host can
   stash the id for the next resume.
5. `session/prompt` — the user's message. The await resolves when
   the agent's turn completes; every chunk, tool call, plan, and
   permission request arrives via `session/update` notifications or
   the `session/request_permission` RPC in the meantime.
6. Emit `RunEvent::Exit` when the prompt response arrives or the
   kill signal fires.

### Permission flow

`PermissionRequestCard` in the frontend renders an inline approval
prompt whenever the agent sends a `session/request_permission` RPC.
The Tauri shell's `approve_tool_use` / `deny_tool_use` commands
forward the user's choice through the typed
`Killer::respond_to_permission(request_id, decision)` API into the
runner's pump task. This is what the pre-ACP `claude -p` integration
couldn't do — the legacy Claude CLI didn't activate `canUseTool`
from a non-SDK host, so the permission card was dead code.

### Subagent visibility

Subagent activity renders nested under its parent tool call, but reaches
the host two different ways:

- **`Task` / `Agent` subagents** stream on the wire: claude-agent-acp
  tags their `session/update`s with `_meta.claudeCode.parentToolUseId`.
  The frontend renderer (`acpRender.ts`) reads it and indents those
  lines under the spawning call.
- **`Workflow`-tool subagents** never emit `session/update`s — the CLI
  orchestrates them in-process and persists them only to
  `~/.claude/projects/<proj>/<session-id>/subagents/workflows/<run>/journal.jsonl`.
  A dedicated-thread watcher (`runner/acp/workflow_watch.rs`) tails that
  journal and *synthesises* ACP `tool_call` / `tool_call_update`
  notifications — tagged with the same `parentToolUseId` — onto the
  `events` channel, so they render through the identical nesting path.
  This is the one place a `RunEvent::Stdout` line originates from the
  host rather than the agent. The watcher runs on its own OS thread (so
  blocking journal I/O can't stall the single-threaded runtime's
  notification pipe) and baselines pre-existing runs, so a resumed
  session doesn't re-surface workflows from earlier turns.

## Drafts workflow (inbox-to-review)

Agents produce reusable knowledge notes as side-output by writing into
`01_inbox/_drafts/` with two required frontmatter fields:

```yaml
status: draft-from-agent
proposed_destination: 03_areas/patterns/<topic>/<name>.md
```

The scanner detects these and surfaces them as `ScanResult.drafts:
Vec<Draft>` separately from the regular file list. The UI's Drafts
tab lists each draft and exposes:

- **Promote** — `markdown_io::promote_draft`. Reads the draft, drops
  `proposed_destination` from frontmatter, sets `status: promoted`
  and `promoted_from: <draft path>`, writes to the destination
  (refuses to overwrite an existing file), deletes the draft on
  success.
- **Discard** — `markdown_io::discard_draft`. Path-validated delete.
- **Preview** — opens the draft in the existing markdown editor.

Both operations go through the same path validation used by
`read_markdown_file` / `write_markdown_file`, so a stray promote/discard
can't escape the vault or touch `.git/` / `.ssh/` / etc.

## Source Control (vault git)

The **Source Control** sidebar view lets the user review and commit
changes to the **vault itself** without leaving Curator — distinct from
`source_repo` (read-only, project `local_path`). `SourceControlPanel`
renders a VS Code-style SCM view: Staged / Changes file groups with
per-file stage toggles, a syntax-coloured diff pane, a commit box, and a
History tab listing recent commits. Editable (`.md`, non-deleted) files
open straight into the editor from a diff so the user can fix and re-stage.

It is backed by `vault-core/git.rs`, which shells out to the `git` CLI
(no `git2`/`libgit2` dependency — `AGENTS.md` supply-chain policy):

- `status` — `git status --porcelain=v1 --untracked-files=all -z`. The
  `-uall` flag is load-bearing: without it git collapses an untracked
  subtree to its top directory, so a new file in a new folder would show
  as a directory path that can't be diffed/staged/opened.
- `diff` — `git diff [--cached]`; untracked files fall back to
  `git diff --no-index` against `/dev/null` to render as additions.
- `stage` / `stage_all` / `unstage` — `git add` / `git add -A` /
  `git restore --staged` (`git rm --cached` on an unborn branch).
- `commit` — commits staged changes only; signing is the user's git
  config. The IDE never *auto*-commits — every commit is an explicit
  button press, preserving the human-in-the-loop safety model.
- `log` — recent commits for the History tab.

The Tauri layer (`git_status` / `git_diff` / `git_stage` /
`git_stage_all` / `git_unstage` / `git_commit` / `git_log`) is
`async` + `spawn_blocking` (git can exceed the main-thread budget) and
applies the path-containment guard described under Security boundaries.

## Diagnostics

Three severity levels (`info` / `warning` / `error`). Current emitters:

| Level     | Trigger                                                          |
| --------- | ---------------------------------------------------------------- |
| `info`    | `.bak` file detected (not indexed)                               |
| `info`    | Markdown file with no YAML frontmatter (capped to 50)            |
| `info`    | Private zone summary (`personal-work` / `team-management` / …)   |
| `warning` | `.vault/config.yml` missing                                      |
| `warning` | `.vault/config.yml` has no `version:` field                      |
| `warning` | Vault format major version exceeds IDE-supported major           |
| `warning` | `02_projects/<slug>/_index.md` missing                           |
| `warning` | Duplicate artifact id within a kind                              |
| `warning` | Filesystem walk errors                                           |
| `error`   | `.vault/config.yml` `version:` field is not a parseable major    |
| `error`   | Skill / artifact failed to parse (frontmatter problem)           |

## Security boundaries

- **Subprocess spawn** — args are always passed as `Vec<String>` to
  `Command::args()`; no shell, no `sh -c` indirection.
- **Workdir** — canonicalized + checked against a deny-list of
  sensitive paths (`/etc`, `/Library`, `/Applications`, `~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, etc.) before being
  passed to `Command::current_dir`.
- **Vault root** — canonicalized before being passed as `--add-dir`
  so symlink-based escape is closed.
- **Markdown writes** — vault-rooted; deny `.git/`, `.obsidian/`,
  `node_modules/`, `target/`, `dist/`, `build/`, `.next/` at any
  depth; deny root `.claude/`; deny `.vault/cache/` and
  `.vault/tmp/`; deny `.bak` / `.pem` / `.key` suffixes.
- **Vault git ops** — the `git_*` commands canonicalize the vault root,
  and every caller-supplied file path is run through
  `git::validate_repo_relative` (rejects absolute, `..`-traversal, and
  flag-shaped `-…` paths) before reaching `git`. This contains
  stage/diff to the vault and stops `git diff --no-index` from being
  used to read files outside it. Commit signing is left to the user's
  git config; the IDE never passes `-S` or `--no-gpg-sign`.
- **Bounded concurrency** — `RunState` caps simultaneous claude
  subprocesses at `MAX_CONCURRENT_RUNS = 3`; the fourth `start_run`
  is rejected with a clear inline error. Each run is identified by a
  stable `RunId` (`r-{gen}-{epoch_ms}`) carried on every event payload
  and required by `stop_run` / `approve_tool_use` / `deny_tool_use`
  so a frontend tab can only target its own subprocess. Generation
  counter on each run still guards a fast stop+restart from having
  an old emit thread evict a newer run's killer. See
  [multi-chat.md](./multi-chat.md).

## Out of scope today

- Cloud sync, telemetry, multi-user features
- Embedded vector retrieval / semantic search across the vault
- Per-artifact `--allowed-tools` whitelisting (tracked follow-up)
- Conversation persistence across app restarts (history rows survive
  in the local DB but in-progress chat state does not)
- Recommendations engine UI (rule-based slice is in flight; LLM-powered
  layer is future work)
