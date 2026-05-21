# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  React + TypeScript (apps/desktop/src)                               │
│  - Welcome → picks a vault folder via @tauri-apps/plugin-dialog      │
│  - Dashboard: Projects / AI Artifacts / Drafts / Zones / Diagnostics │
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
│      deny_tool_use(run_id, request_id, …) — targeted by run id      │
│    get_runs() → Vec<RunStartedPayload> — snapshot of live runs       │
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
│  runner/       — Runner trait + ClaudeCode impl; coordinator-pattern │
│                  threading; output cap; --resume support             │
│  markdown_io   — vault-rooted read/write/create/promote/discard      │
│                  with path validation (deny-list of sensitive dirs)  │
│  source_repo   — read-only git inspection (branch, dirty, commit,    │
│                  detected files, shallow top-level listing)          │
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

pub enum RunnerKind { ClaudeCode /* + future variants */ }

pub struct RunRequest {
    pub workdir: PathBuf,
    pub additional_dirs: Vec<PathBuf>,
    pub prompt: String,
    pub runtime_input: Option<String>,
    pub resume_session_id: Option<String>,
}

pub enum RunEvent {
    Stdout(String),
    Stderr(String),
    Truncated { dropped_bytes: usize },
    Exit { code: Option<i32>, success: bool },
}
```

`runner/claude.rs` is the only implementation today. It spawns:

```
claude -p "<prompt>"
       --output-format stream-json
       --verbose
       --permission-mode acceptEdits
       [--resume <session_id>]
       [--add-dir <dir>] …
```

Threading model per run:
- One subprocess under `Arc<Mutex<Child>>` for safe access by kill +
  waiter
- Two reader threads (stdout, stderr) own only the pipe handle
- One coordinator thread `join`s both readers (guaranteeing every
  output line precedes the `Exit` event), then polls `try_wait` until
  the child reaps
- Output cap at 4 MiB total across stdout+stderr via
  `Mutex<TruncationState>`; readers keep draining past the cap so the
  child doesn't block on writes; one `Truncated` event fires at the
  first overflow

Permission mode `acceptEdits` only auto-approves file-edit tools
(Write / Edit / MultiEdit / NotebookEdit). Bash and other tools still
respect the user's global Claude Code config.

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
