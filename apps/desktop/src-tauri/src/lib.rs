mod acp_paths;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::acp_paths::AcpPaths;

/// Walk the vault directory tree. Heavy I/O (walkdir + per-file head read +
/// six artifact passes) — must run off the main thread or the UI freezes on
/// large vaults. See `scan_project_vulnerabilities` for the same pattern.
#[tauri::command]
async fn scan_vault(path: String) -> Result<vault_core::ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_core::scan_vault(&PathBuf::from(path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("scan_vault task failed: {e}"))?
}

/// Turn a plain folder into a vault — writes `.vault/config.yml`, the
/// canonical zone dirs, and a seed `00_meta/AGENTS.md`. Caller is
/// expected to re-scan after.
///
/// `async` + `spawn_blocking` mirrors `scan_project_vulnerabilities`:
/// vault init touches disk (multiple `create_dir_all` + writes) and we
/// don't want a beachball if the target FS is slow / over the network.
#[tauri::command]
async fn init_vault(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_core::init_vault(&PathBuf::from(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("init_vault task failed: {e}"))?
}

/// Create the first project inside an existing vault. Returns the
/// vault-relative path of the new `_index.md` so the frontend can
/// open it in the editor without an extra round-trip.
#[tauri::command]
async fn init_project(
    vault_root: String,
    slug: String,
    my_role: String,
    repo: Option<String>,
    local_path: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = vault_core::InitProjectArgs {
            slug: &slug,
            my_role: &my_role,
            repo: repo.as_deref(),
            local_path: local_path.as_deref(),
        };
        vault_core::init_project(&PathBuf::from(&vault_root), &args).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("init_project task failed: {e}"))?
}

#[tauri::command]
async fn preview_context(
    vault_path: String,
    project_slug: String,
    prompt_id: String,
) -> Result<vault_core::ContextPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_core::preview_context(&PathBuf::from(vault_path), &project_slug, &prompt_id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("preview_context task failed: {e}"))?
}

/// Inspect the project's source repo (git status / branch / top-level files).
///
/// Security: `local_path` arrives from agent-written `_index.md` frontmatter,
/// so a hostile vault could declare `local_path: ~/.ssh`. We pass it through
/// `runner::validate_workdir` (same deny-list used for the agent cwd) before
/// calling `inspect_source_repo` — otherwise opening a malicious vault would
/// leak directory listings of `~/.ssh`, `~/.aws`, system paths, etc. via
/// `compute_recommendations` without any user interaction.
///
/// `async` + `spawn_blocking` — `inspect_source_repo` shells out to `git`
/// four times per call; offload from the main thread.
#[tauri::command]
async fn inspect_source_repo(
    local_path: String,
) -> Result<vault_core::SourceRepoInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = vault_core::runner::validate_workdir(&PathBuf::from(&local_path))
            .map_err(|e| e.to_string())?;
        Ok(vault_core::inspect_source_repo(&safe))
    })
    .await
    .map_err(|e| format!("inspect_source_repo task failed: {e}"))?
}

/// Scan a project's source repository for known vulnerabilities.
///
/// Parses any supported lock files (yarn.lock, package-lock.json) at
/// the repo root and queries OSV.dev for advisories. Returns a flat
/// list of `(package, vuln)` rows plus any non-fatal warnings.
///
/// Security: `local_path` is canonicalized AND passed through
/// `runner::validate_workdir` to enforce the same deny-list used by the
/// agent runner (no system dirs, no `~/.ssh`, etc.). A vault config
/// pointing at a sensitive path can't trick the IDE into reading lock
/// files from outside a real project workdir.
///
/// The OSV query is best-effort — network failures are downgraded to
/// warnings so the user still sees the package count and at least knows
/// what would have been scanned.
///
/// `async` + `spawn_blocking` is deliberate: Tauri 2 runs synchronous
/// commands on the main thread, which would freeze the UI (beachball,
/// stuck cursor) for the full 5–30 s of an OSV scan on a real-world
/// repo. Offloading to a blocking worker keeps the window responsive.
#[tauri::command]
async fn scan_project_vulnerabilities(
    local_path: String,
) -> Result<vault_core::cve::ProjectVulnerabilityScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = vault_core::runner::validate_workdir(&PathBuf::from(&local_path))
            .map_err(|e| e.to_string())?;
        vault_core::cve::scan_project_vulnerabilities(&safe).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("scan task failed: {e}"))?
}

// ---------- Vault git (Source Control panel) ----------
//
// These act on the *vault root itself*, not on a project's `local_path`
// (that's `inspect_source_repo`, read-only). The vault is the already-open,
// already-trusted workspace, so we canonicalize it (closing symlink escapes)
// the same way every other vault command does, rather than running it
// through the project deny-list in `runner::validate_workdir`.
//
// All five are `async` + `spawn_blocking`: each shells out to `git`, which
// can take longer than the 100 ms main-thread budget on a large vault, and
// Tauri 2 runs synchronous commands on the UI thread. See
// `scan_project_vulnerabilities` for the same rationale.

#[tauri::command]
async fn git_status(vault_root: String) -> Result<vault_core::git::GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::status(&safe).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_status task failed: {e}"))?
}

#[tauri::command]
async fn git_diff(vault_root: String, path: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::diff(&safe, &path, staged).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_diff task failed: {e}"))?
}

#[tauri::command]
async fn git_stage(vault_root: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::stage(&safe, &paths).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_stage task failed: {e}"))?
}

#[tauri::command]
async fn git_stage_all(vault_root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::stage_all(&safe).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_stage_all task failed: {e}"))?
}

#[tauri::command]
async fn git_unstage(vault_root: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::unstage(&safe, &paths).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_unstage task failed: {e}"))?
}

#[tauri::command]
async fn git_commit(
    vault_root: String,
    message: String,
) -> Result<vault_core::git::CommitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::commit(&safe, &message).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_commit task failed: {e}"))?
}

#[tauri::command]
async fn git_log(
    vault_root: String,
    limit: usize,
) -> Result<Vec<vault_core::git::CommitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = canonicalize_vault_root(&vault_root)?;
        vault_core::git::log(&safe, limit).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("git_log task failed: {e}"))?
}

#[tauri::command]
fn read_markdown_file(vault_root: String, relative_path: String) -> Result<String, String> {
    vault_core::read_markdown_file(&PathBuf::from(vault_root), &relative_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_markdown_file(
    vault_root: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    vault_core::write_markdown_file(&PathBuf::from(vault_root), &relative_path, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_markdown_file(vault_root: String, relative_path: String) -> Result<String, String> {
    vault_core::create_markdown_file(&PathBuf::from(vault_root), &relative_path)
        .map_err(|e| e.to_string())
}

/// Promote an agent-produced draft into its `proposed_destination`.
/// Returns the new vault-relative path on success.
#[tauri::command]
fn promote_draft(vault_root: String, draft_path: String) -> Result<String, String> {
    vault_core::promote_draft(&PathBuf::from(vault_root), &draft_path).map_err(|e| e.to_string())
}

/// Delete a draft from the vault. Idempotent on `NotFound`? No — the UI
/// can show the rescan stale-state, so we surface NotFound as an error.
#[tauri::command]
fn discard_draft(vault_root: String, draft_path: String) -> Result<(), String> {
    vault_core::discard_draft(&PathBuf::from(vault_root), &draft_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn demo_vault_path() -> Result<String, String> {
    // Resolves to <workspace>/examples/demo-vault during `tauri dev`.
    // For packaged builds the demo vault is not bundled; this command will fail.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let candidate = PathBuf::from(manifest_dir)
        .join("..")
        .join("..")
        .join("..")
        .join("examples")
        .join("demo-vault");
    candidate
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("demo vault not found at {}: {e}", candidate.display()))
}

/// Holds the active filesystem watcher (if any). Replacing it drops the
/// previous `WatchToken`, which stops the underlying notify watcher and
/// disconnects its emit thread on the next event read.
#[derive(Default)]
struct WatchState(Mutex<Option<vault_core::watch::WatchToken>>);

/// Start (or restart) the vault filesystem watcher for the given vault root.
/// Emits a `vault:changed` event to the frontend each time the debouncer
/// fires. Any previous watcher is stopped first.
#[tauri::command]
fn start_vault_watch(
    vault_root: String,
    app: AppHandle,
    state: State<'_, WatchState>,
) -> Result<(), String> {
    let root = PathBuf::from(&vault_root);
    let (token, rx) = vault_core::watch::start_watch(vec![root]).map_err(|e| e.to_string())?;

    {
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        // Dropping the old token stops the previous watcher.
        *slot = Some(token);
    }

    // Spawn the emit pump. Holds only an `AppHandle`, which is cheap to
    // clone, and the receiver. When the WatchState slot is replaced (or the
    // app exits) the sender end drops and `recv()` returns Err, ending the
    // loop.
    let app_for_thread = app.clone();
    thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            let _ = app_for_thread.emit("vault:changed", ev);
        }
    });

    Ok(())
}

/// Stop the active watcher, if any. Idempotent.
#[tauri::command]
fn stop_vault_watch(state: State<'_, WatchState>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    Ok(())
}

// ---------- Runner state + commands ----------

/// Active run identifier — incremented on every `start_run`. The emit
/// thread captures its own generation and only clears the slot on `Exit`
/// when the generation still matches; if the user has already stopped and
/// started a new run by then, the new run's killer survives the old
/// thread's tail.
type RunGen = u64;

/// Externally-visible run id. Minted per spawn, threaded through every
/// emitted event payload and accepted by `stop_run` / `approve_tool_use` /
/// `deny_tool_use` so the frontend can demultiplex events back to the
/// chat tab that owns a given run once multiple runs can be active at
/// once. Format is `r-{gen}-{unix_ms}` — `gen` keeps a tie-break order
/// within a single process lifetime, `unix_ms` survives across restarts.
type RunId = String;

fn mint_run_id(gen: RunGen) -> RunId {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("r-{gen}-{ms}")
}

/// Cap on concurrent CLI subprocesses. Picked to balance "user wants to
/// fan out work across a few chats" against "spawning N heavy claude
/// processes will gnaw through CPU + memory + rate limits". Exceeding
/// it surfaces a clear inline error rather than silently queueing —
/// the user is expected to close or wait on one of the existing runs.
const MAX_CONCURRENT_RUNS: usize = 3;

#[derive(Default)]
struct RunStateInner {
    next_gen: RunGen,
    /// All currently-spawned runs, keyed by their externally-visible
    /// [`RunId`]. Replaces the prior single-slot `Option<ActiveRun>`
    /// so the frontend can hold multiple chat tabs each owning their
    /// own subprocess. Membership is the source of truth for "is this
    /// run alive?" — the emit thread removes its own entry on `Exit`.
    runs: HashMap<RunId, ActiveRun>,
}

struct ActiveRun {
    gen: RunGen,
    killer: vault_core::runner::Killer,
    /// Snapshot of the `run:started` payload, kept so a frontend that
    /// remounts mid-run (HMR in dev, app restart during a long run) can
    /// re-sync via `get_run_status` and recover the context needed to
    /// resume the conversation. Without this, the mount-time sync
    /// installs a placeholder with empty fields and Reply later fails
    /// with "vault root not accessible: <empty>".
    started: RunStartedPayload,
    /// Pending `can_use_tool` requests claude is currently waiting on.
    /// Cleared when the user picks approve/deny via [`approve_tool_use`]
    /// / [`deny_tool_use`] (which both validate the id exists before
    /// writing to claude's stdin so a stale modal click doesn't desync
    /// the protocol).
    pending_permissions: HashSet<String>,
}

/// Holds the live CLI runs' kill switches plus a monotonic generation
/// counter to disambiguate concurrent stop/restart sequences (legacy
/// from the single-slot era; still useful as a tie-breaker if two
/// spawns happen to mint the same wall-clock millis). Up to
/// [`MAX_CONCURRENT_RUNS`] runs can be active simultaneously.
#[derive(Default)]
struct RunState(Mutex<RunStateInner>);

/// Lock a mutex, recovering from poisoning. Same pattern as in the runner
/// crate — poison usually means another thread panicked while holding the
/// lock; silently returning would leave the UI permanently stuck.
fn lock_recovering<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStartedPayload {
    /// Stable per-spawn id. Carried on every subsequent event for this
    /// run; the frontend uses it to demultiplex events back to the
    /// owning chat tab. See [`RunId`].
    run_id: String,
    project_slug: String,
    prompt_id: String,
    /// Absolute canonicalized vault root. The frontend stashes this so a
    /// later `resume_run` call doesn't have to re-derive it from the
    /// (now-stale) original input.
    vault_root: String,
    workdir: String,
    /// Extra read/edit roots passed via `--add-dir`. Echoed back so a
    /// freeform resume can re-spawn with the same access scope without
    /// re-deriving it from an artifact prompt (freeform runs don't have one).
    additional_dirs: Vec<String>,
    /// Runner backend id (`"claude-code"` / `"codex"`). Echoed back to
    /// the frontend so the panel renders the correct stream format
    /// and the per-tab agent picker stays locked to whichever runner
    /// the chat was started with.
    runner: String,
    /// Model passed via `--model` (Claude) / `-m` (Codex). `None` =
    /// the runner CLI's configured default. Persisted in session
    /// history so a `reopen` flow can show the same model on resume.
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// True when this run is a resume of a prior session (`--resume`).
    /// The frontend keeps prior output buffer + session state visible
    /// across resumes; a fresh start resets them.
    resume: bool,
    /// True when the run was launched via the bottom-panel chat (no artifact
    /// prompt). Frontend routes the Reply path to `resume_freeform_run`
    /// instead of `resume_run` so the spawn doesn't try to materialize a
    /// non-existent artifact prompt.
    freeform: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStdoutPayload {
    run_id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStderrPayload {
    run_id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunTruncatedPayload {
    run_id: String,
    dropped_bytes: usize,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunExitPayload {
    run_id: String,
    code: Option<i32>,
    success: bool,
}

/// `run:session-started` payload. Fired once per run when the ACP
/// agent has minted (or loaded) a session id. The frontend stashes
/// the id so a subsequent Reply / Stop can target it cleanly.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunSessionStartedPayload {
    run_id: String,
    session_id: String,
}

/// `run:permission-request` event payload. Mirrors the runner's
/// `PermissionRequest` struct one-for-one — separate type kept so the
/// shell's IPC surface is self-contained and the runner crate stays
/// Tauri-agnostic. Only the fields the modal actually renders surface
/// here; the rest of the SDK payload is dropped on the floor for now.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunPermissionRequestPayload {
    run_id: String,
    request_id: String,
    tool_name: String,
    tool_input: serde_json::Value,
    tool_use_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// Start a run. Resolves the materialized prompt and source-repo `cwd` via
/// `preview_context`, picks the workdir (project `local_path` when set,
/// vault root as fallback) and exposes the vault root as an `--add-dir`
/// when running inside a repo. Streams events back to the frontend as
/// `run:started` / `run:stdout` / `run:stderr` / `run:truncated` /
/// `run:exit`.
///
/// Refuses if a run is already active — the frontend should call
/// `stop_run` first or wait for the active run's `run:exit` event.
///
/// Security: both `vault_root` and the project's `local_path` are
/// canonicalized and the resolved workdir is checked against a deny-list
/// of sensitive paths (system dirs, `~/.ssh`, `~/.aws`, etc.) so a vault
/// can't redirect the agent into reading credentials.
///
/// `async` + `spawn_blocking` offloads the disk-touching prep work
/// (canonicalize + frontmatter parse in `preview_context` + workdir
/// validation) so the main thread stays responsive — see the
/// `scan_project_vulnerabilities` doc comment for the rationale.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn start_run(
    vault_root: String,
    project_slug: String,
    prompt_id: String,
    runtime_input: Option<String>,
    runner: Option<String>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<RunStartedPayload, String> {
    let prep_slug = project_slug.clone();
    let prep_prompt = prompt_id.clone();
    let (vault_path, workdir, additional_dirs, prompt) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let vault_path = canonicalize_vault_root(&vault_root)?;
            let preview = vault_core::preview_context(&vault_path, &prep_slug, &prep_prompt)
                .map_err(|e| e.to_string())?;
            let (workdir, additional_dirs) =
                resolve_workdir(&vault_path, preview.source_repo.local_path.as_deref());
            Ok((
                vault_path,
                workdir,
                additional_dirs,
                preview.external_runner_prompt.clone(),
            ))
        })
        .await
        .map_err(|e| format!("start_run task failed: {e}"))??;

    spawn_and_pump(SpawnArgs {
        vault_path,
        workdir,
        additional_dirs,
        prompt,
        runtime_input,
        resume_session_id: None,
        project_slug,
        prompt_id,
        freeform: false,
        runner: resolve_runner_kind(runner.as_deref()),
        model: clean_optional(model),
        app,
        state: &state,
    })
}

/// Continue an existing Claude session — `claude --resume <session_id>`.
/// The prompt slot carries the user's reply (next conversation turn),
/// not a fresh task description; claude already has the prior context
/// cached under the session id. Cwd and `--add-dir` are re-derived from
/// the same `(project, prompt)` pair so tool access keeps working.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn resume_run(
    vault_root: String,
    project_slug: String,
    prompt_id: String,
    session_id: String,
    reply: String,
    runner: Option<String>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<RunStartedPayload, String> {
    if !vault_core::runner::is_valid_session_id(session_id.trim()) {
        return Err("invalid session id".into());
    }
    if reply.trim().is_empty() {
        return Err("reply text is required to resume a run".into());
    }
    let prep_slug = project_slug.clone();
    let prep_prompt = prompt_id.clone();
    let (vault_path, workdir, additional_dirs) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let vault_path = canonicalize_vault_root(&vault_root)?;
            let preview = vault_core::preview_context(&vault_path, &prep_slug, &prep_prompt)
                .map_err(|e| e.to_string())?;
            let (workdir, additional_dirs) =
                resolve_workdir(&vault_path, preview.source_repo.local_path.as_deref());
            Ok((vault_path, workdir, additional_dirs))
        })
        .await
        .map_err(|e| format!("resume_run task failed: {e}"))??;

    spawn_and_pump(SpawnArgs {
        vault_path,
        workdir,
        additional_dirs,
        prompt: reply,
        runtime_input: None,
        resume_session_id: Some(session_id),
        project_slug,
        prompt_id,
        freeform: false,
        runner: resolve_runner_kind(runner.as_deref()),
        model: clean_optional(model),
        app,
        state: &state,
    })
}

/// Start a free-form chat run — no artifact prompt, just the user's text
/// wrapped with a short vault-context preamble. When `scope_repo_path` is
/// provided + safe, cwd is that repo and the vault is exposed via
/// `--add-dir`; otherwise cwd is the vault root.
///
/// `scope_project_slug` is purely a display label echoed back in the
/// `run:started` event so the panel can show "running · my-proj/chat" vs
/// "running · vault/chat". The backend does not validate it against the
/// scan — it never touches the filesystem with it.
// Tauri commands take fields as positional args by design; grouping
// runner+model into a struct would force a wrapper layer for every
// invoke from the frontend, so the long arg list is accepted here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn start_freeform_run(
    vault_root: String,
    prompt: String,
    scope_project_slug: Option<String>,
    scope_repo_path: Option<String>,
    runner: Option<String>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<RunStartedPayload, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".into());
    }
    let (vault_path, workdir, additional_dirs, wrapped) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let vault_path = canonicalize_vault_root(&vault_root)?;
            let (workdir, additional_dirs) =
                resolve_workdir(&vault_path, scope_repo_path.as_deref());
            let wrapped = build_freeform_prompt(&vault_path, &prompt, workdir != vault_path);
            Ok((vault_path, workdir, additional_dirs, wrapped))
        })
        .await
        .map_err(|e| format!("start_freeform_run task failed: {e}"))??;

    let project_slug = scope_project_slug
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "(vault)".to_string());

    spawn_and_pump(SpawnArgs {
        vault_path,
        workdir,
        additional_dirs,
        prompt: wrapped,
        runtime_input: None,
        resume_session_id: None,
        project_slug,
        prompt_id: "chat".to_string(),
        freeform: true,
        runner: resolve_runner_kind(runner.as_deref()),
        model: clean_optional(model),
        app,
        state: &state,
    })
}

/// Continue a free-form chat run. Unlike `resume_run`, this does not
/// re-derive the workdir from an artifact prompt (freeform runs have
/// none) — the frontend passes back the `(workdir, additional_dirs,
/// project_slug)` triple stashed from the original `run:started` event.
///
/// Security: `workdir` is re-validated via `runner::validate_workdir` on
/// every resume so a stale or tampered echo can't redirect the agent
/// into a denied path (`~/.ssh`, system dirs, etc.).
// Tauri commands take the request fields as positional args by design;
// grouping them into a struct would force a wrapper layer for every
// invoke from the frontend.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn resume_freeform_run(
    vault_root: String,
    workdir: String,
    additional_dirs: Vec<String>,
    project_slug: String,
    session_id: String,
    reply: String,
    runner: Option<String>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<RunStartedPayload, String> {
    if !vault_core::runner::is_valid_session_id(session_id.trim()) {
        return Err("invalid session id".into());
    }
    if reply.trim().is_empty() {
        return Err("reply text is required to resume a run".into());
    }
    let (vault_path, workdir, additional_dirs) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let vault_path = canonicalize_vault_root(&vault_root)?;
            let workdir = vault_core::runner::validate_workdir(&PathBuf::from(workdir))
                .map_err(|e| e.to_string())?;
            // Validate every echoed-back add-dir, not just the workdir. A
            // tampered `run:started` event in the webview could otherwise
            // smuggle in `~/.ssh` etc. as a read root for `claude`.
            let additional_dirs: Vec<PathBuf> = additional_dirs
                .into_iter()
                .map(|d| {
                    vault_core::runner::validate_workdir(&PathBuf::from(d))
                        .map_err(|e| e.to_string())
                })
                .collect::<Result<_, _>>()?;
            Ok((vault_path, workdir, additional_dirs))
        })
        .await
        .map_err(|e| format!("resume_freeform_run task failed: {e}"))??;

    let display_slug = if project_slug.trim().is_empty() {
        "(vault)".to_string()
    } else {
        project_slug
    };

    spawn_and_pump(SpawnArgs {
        vault_path,
        workdir,
        additional_dirs,
        prompt: reply,
        runtime_input: None,
        resume_session_id: Some(session_id),
        project_slug: display_slug,
        prompt_id: "chat".to_string(),
        freeform: true,
        runner: resolve_runner_kind(runner.as_deref()),
        model: clean_optional(model),
        app,
        state: &state,
    })
}

/// Wrap the user's chat prompt with a short context preamble.
///
/// We point the agent at the vault's root `README.md` (17 lines, just a
/// table of contents) instead of eagerly loading `00_meta/AGENTS.md`
/// (280 lines + cascading references). The README itself routes to
/// AGENTS.md when the task warrants — so a "read these 10 files"
/// request stays cheap, while a "create a new note" task still finds
/// the conventions via one extra cheap hop. Previously the eager
/// AGENTS.md read kicked off broad vault exploration (every freeform
/// chat ran `ls 02_projects/*` then `ls -la` on every project), eating
/// millions of cached input tokens.
fn build_freeform_prompt(vault_path: &Path, user_prompt: &str, has_repo_scope: bool) -> String {
    let vault = vault_path.display();
    let preamble = if has_repo_scope {
        format!(
            "You're in a project source repository (cwd). A Markdown knowledge vault \
is available at `{vault}` via `--add-dir`. For vault layout and pointers to \
conventions, see `{vault}/README.md` (small file at the vault root) — read it \
only if the task touches the vault."
        )
    } else {
        format!(
            "You're inside a Markdown knowledge vault at `{vault}` (cwd). For vault \
layout and pointers to conventions, see `./README.md` (small file at the vault \
root) — read it only if the task needs vault structure."
        )
    };
    format!("{preamble}\n\nUser request:\n{user_prompt}")
}

fn canonicalize_vault_root(raw: &str) -> Result<PathBuf, String> {
    PathBuf::from(raw)
        .canonicalize()
        .map_err(|e| format!("vault root not accessible: {raw}: {e}"))
}

/// Pick the cwd for the agent + the `--add-dir` list. Repo cwd when the
/// project's `local_path` is set + accessible + safe; vault root as
/// fallback. When cwd is the repo, the vault is added explicitly so the
/// agent can read KB; when cwd is already the vault, nothing extra.
fn resolve_workdir(vault_path: &Path, local_path: Option<&str>) -> (PathBuf, Vec<PathBuf>) {
    let workdir = match local_path {
        Some(declared) => match vault_core::runner::validate_workdir(&PathBuf::from(declared)) {
            Ok(safe) => safe,
            Err(_) => vault_path.to_path_buf(),
        },
        None => vault_path.to_path_buf(),
    };
    let additional_dirs = if workdir == vault_path {
        Vec::new()
    } else {
        vec![vault_path.to_path_buf()]
    };
    (workdir, additional_dirs)
}

/// Inputs to `spawn_and_pump`. Grouped as a struct because the function
/// runs both code paths (`start_run` + `resume_run` + freeform variants)
/// and a 10-arg call site is unreadable.
struct SpawnArgs<'s> {
    vault_path: PathBuf,
    workdir: PathBuf,
    additional_dirs: Vec<PathBuf>,
    prompt: String,
    runtime_input: Option<String>,
    resume_session_id: Option<String>,
    project_slug: String,
    prompt_id: String,
    /// Marks the run as freeform (chat) so the frontend routes its Reply
    /// path to `resume_freeform_run`. Plain artifact runs pass `false`.
    freeform: bool,
    /// Which CLI backend to spawn for this run. Picked per-tab on the
    /// frontend; once a chat tab has started, its runner is fixed and
    /// every subsequent resume on that tab passes the same kind.
    runner: vault_core::runner::RunnerKind,
    /// Optional model override forwarded to the runner CLI. `None` =
    /// the CLI picks its configured default.
    model: Option<String>,
    app: AppHandle,
    state: &'s State<'s, RunState>,
}

/// Resolve a runner-id string from the frontend into the typed kind.
/// Unknown / missing strings fall back to ClaudeCode (the default for
/// new chats). Defensive — a tampered persisted history row should
/// not crash the spawn.
fn resolve_runner_kind(id: Option<&str>) -> vault_core::runner::RunnerKind {
    id.and_then(|s| vault_core::runner::RunnerKind::from_id(s.trim()))
        .unwrap_or(vault_core::runner::RunnerKind::ClaudeCode)
}

/// Trim + drop empty / whitespace-only strings. Used so the frontend
/// can pass `""` to mean "no model override" without the runner CLI
/// receiving an empty argument that confuses argv parsing.
fn clean_optional(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Shared core of `start_run` / `resume_run`: build the `RunRequest`,
/// claim the run slot atomically, spawn the subprocess, kick off the
/// emit-pump thread. Returns the full `RunStartedPayload` (including
/// `run_id`) so the frontend can drive its "is this run mine?"
/// filter from the invoke-return path directly, instead of racing the
/// asynchronously-delivered `run:started` event. Without this the
/// frontend would lose `run:started` events that won the race against
/// the invoke promise resolution, leaving the panel stuck in `idle`
/// even though the backend run is streaming.
fn spawn_and_pump(args: SpawnArgs<'_>) -> Result<RunStartedPayload, String> {
    let SpawnArgs {
        vault_path,
        workdir,
        additional_dirs,
        prompt,
        runtime_input,
        resume_session_id,
        project_slug,
        prompt_id,
        freeform,
        runner: runner_kind,
        model,
        app,
        state,
    } = args;

    // Capture the resume flag before constructing the request so it
    // survives the move into `Runner::start`.
    let is_resume = resume_session_id.is_some();

    // Snapshot add-dirs as strings before they're moved into `RunRequest`;
    // the started payload echoes them so a freeform resume can re-spawn
    // with the same access scope.
    let additional_dirs_str: Vec<String> = additional_dirs
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let req = vault_core::runner::RunRequest {
        workdir: workdir.clone(),
        additional_dirs,
        prompt,
        runtime_input,
        resume_session_id,
        model: model.clone(),
    };

    // Hold the RunState lock across the spawn so the cap check and the
    // killer insert are atomic. The spawn itself is synchronous; no
    // async / await in this block. This closes the TOCTOU window where
    // two concurrent `start_run` calls could both pass the cap guard.
    let (events, gen, run_id, started_payload) = {
        let mut inner = lock_recovering(&state.0);
        if inner.runs.len() >= MAX_CONCURRENT_RUNS {
            return Err(format!(
                "Maximum {MAX_CONCURRENT_RUNS} concurrent chats reached — \
                 stop or finish one before starting another."
            ));
        }

        // Pick the runner backend at the dispatch site so the
        // per-runner state machine (Claude vs Codex) stays a switch
        // here rather than a trait-object indirection. Both runners
        // implement the same `Runner` trait and produce the same
        // `RunHandle` shape, so the rest of the pipeline is agnostic.
        //
        // The bundled ACP agent paths were resolved once during
        // `setup` and stashed in Tauri state. A missing entry means
        // resolution failed at boot (logged to stderr); surface the
        // same error inline so the user sees actionable feedback in
        // the chat rather than an opaque crash.
        let acp_paths: AcpPaths = app
            .try_state::<AcpPaths>()
            .map(|s| (*s).clone())
            .ok_or_else(|| {
                "ACP agent paths not resolved at startup — see logs. \
                 Verify `apps/desktop/src-tauri/resources/acp/` and run \
                 `./scripts/fetch-acp-binaries.sh` from the repo root."
                    .to_string()
            })?;

        use vault_core::runner::Runner as _;
        let handle = match runner_kind {
            vault_core::runner::RunnerKind::ClaudeCode => vault_core::runner::AcpClaudeRunner::new(
                acp_paths.node_bin.clone(),
                acp_paths.claude_wrapper_js.clone(),
                acp_paths.claude_bin.clone(),
            )
            .start(req)
            .map_err(|e| e.to_string())?,
            vault_core::runner::RunnerKind::Codex => {
                vault_core::runner::AcpCodexRunner::new(acp_paths.codex_acp_bin.clone())
                    .start(req)
                    .map_err(|e| e.to_string())?
            }
        };
        let (events, killer) = handle.into_parts().map_err(|e| e.to_string())?;

        let gen = inner.next_gen.wrapping_add(1);
        inner.next_gen = gen;
        let run_id = mint_run_id(gen);

        // Build the started payload once — it gets emitted to the
        // frontend AND stashed in RunState so a later `get_runs` /
        // `get_run_status` can return the same context (including the
        // run_id) after a mount-time resync.
        let started_payload = RunStartedPayload {
            run_id: run_id.clone(),
            project_slug,
            prompt_id,
            vault_root: vault_path.to_string_lossy().to_string(),
            workdir: workdir.to_string_lossy().to_string(),
            additional_dirs: additional_dirs_str,
            runner: runner_kind.id().to_string(),
            model,
            resume: is_resume,
            freeform,
        };

        inner.runs.insert(
            run_id.clone(),
            ActiveRun {
                gen,
                killer,
                started: started_payload.clone(),
                pending_permissions: HashSet::new(),
            },
        );
        (events, gen, run_id, started_payload)
    };

    let _ = app.emit("run:started", started_payload.clone());

    // Emit pump. Drains the receiver and forwards each event as a typed
    // Tauri event. On `Exit` the slot is cleared, but only if this thread
    // still owns it (matching generation) — protects against a fast
    // stop+restart sequence where this thread's tail would otherwise
    // delete the new run's killer.
    let app_for_thread = app.clone();
    let run_id_for_thread = run_id.clone();
    thread::spawn(move || {
        use vault_core::runner::RunEvent;
        while let Ok(ev) = events.recv() {
            match ev {
                RunEvent::Stdout(line) => {
                    let _ = app_for_thread.emit(
                        "run:stdout",
                        RunStdoutPayload {
                            run_id: run_id_for_thread.clone(),
                            line,
                        },
                    );
                }
                RunEvent::Stderr(line) => {
                    let _ = app_for_thread.emit(
                        "run:stderr",
                        RunStderrPayload {
                            run_id: run_id_for_thread.clone(),
                            line,
                        },
                    );
                }
                RunEvent::Truncated { dropped_bytes } => {
                    let _ = app_for_thread.emit(
                        "run:truncated",
                        RunTruncatedPayload {
                            run_id: run_id_for_thread.clone(),
                            dropped_bytes,
                        },
                    );
                }
                RunEvent::PermissionRequest(req) => {
                    // Record the pending request so approve/deny can
                    // validate the id before responding. We don't
                    // serialize the whole struct into state (the runner
                    // also keeps no buffer); just the id presence is
                    // enough to reject stale modal clicks after a
                    // restart. Looked up directly by run_id now that
                    // multiple runs coexist — the gen check is no
                    // longer needed (run_id is unique per spawn) but
                    // we keep it as defense in depth: a future restart
                    // sequence that recycles ids should still be
                    // rejected.
                    if let Some(state) = app_for_thread.try_state::<RunState>() {
                        let mut inner = lock_recovering(&state.0);
                        if let Some(active) = inner.runs.get_mut(&run_id_for_thread) {
                            if active.gen == gen {
                                active.pending_permissions.insert(req.request_id.clone());
                            }
                        }
                    }
                    let _ = app_for_thread.emit(
                        "run:permission-request",
                        RunPermissionRequestPayload {
                            run_id: run_id_for_thread.clone(),
                            request_id: req.request_id,
                            tool_name: req.tool_name,
                            tool_input: req.tool_input,
                            tool_use_id: req.tool_use_id,
                            title: req.title,
                            display_name: req.display_name,
                            description: req.description,
                        },
                    );
                }
                RunEvent::SessionStarted { session_id } => {
                    let _ = app_for_thread.emit(
                        "run:session-started",
                        RunSessionStartedPayload {
                            run_id: run_id_for_thread.clone(),
                            session_id,
                        },
                    );
                }
                RunEvent::Exit { code, success } => {
                    let _ = app_for_thread.emit(
                        "run:exit",
                        RunExitPayload {
                            run_id: run_id_for_thread.clone(),
                            code,
                            success,
                        },
                    );
                    if let Some(state) = app_for_thread.try_state::<RunState>() {
                        let mut inner = lock_recovering(&state.0);
                        // Remove our entry. The gen check guards a
                        // theoretical recycle where a stopped run's
                        // id might be re-inserted by a later spawn
                        // (mint_run_id includes wall-clock millis so
                        // this can't happen within the same process,
                        // but the assertion costs ~nothing).
                        if inner.runs.get(&run_id_for_thread).map(|a| a.gen) == Some(gen) {
                            inner.runs.remove(&run_id_for_thread);
                        }
                    }
                    break;
                }
            }
        }
    });

    Ok(started_payload)
}

/// Stop the run identified by `run_id`. Idempotent: if no run with
/// that id exists (already exited, never existed) this is a no-op and
/// returns `Ok`. A frontend tab targets its own run without affecting
/// sibling runs in other tabs.
#[tauri::command]
fn stop_run(run_id: String, state: State<'_, RunState>) -> Result<(), String> {
    let active = {
        let mut inner = lock_recovering(&state.0);
        inner.runs.remove(&run_id)
    };
    if let Some(active) = active {
        active.killer.kill();
    }
    Ok(())
}

/// Approve a pending tool-use permission request. Writes the
/// corresponding `control_response` back to claude's stdin, unblocking
/// the paused turn. The frontend invokes this when the user clicks
/// "Allow" / "Allow for this session" in the approve-tools modal.
///
/// `updated_permissions` carries session-scoped permission rules (the
/// SDK's `PermissionUpdate[]`) so claude doesn't ask again for this
/// tool within the session. None = ask-each-time (Allow once).
///
/// Rejects unknown `request_id`s up front — a stale modal click after
/// restart shouldn't pollute the stdin protocol.
#[tauri::command]
fn approve_tool_use(
    state: State<'_, RunState>,
    run_id: String,
    request_id: String,
    updated_input: Option<serde_json::Value>,
    updated_permissions: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut inner = lock_recovering(&state.0);
    let active = inner
        .runs
        .get_mut(&run_id)
        .ok_or_else(|| format!("no active run with id {run_id}"))?;
    if !active.pending_permissions.remove(&request_id) {
        return Err(format!(
            "unknown or already-resolved request_id: {request_id}"
        ));
    }
    let decision = vault_core::runner::PermissionDecision::Allow {
        updated_input,
        updated_permissions,
    };
    if !active.killer.respond_to_permission(request_id, decision) {
        return Err("failed to deliver approval — runner has no live permission channel".into());
    }
    Ok(())
}

/// Deny a pending tool-use permission request. Writes a deny
/// `control_response` to claude's stdin; the model receives an
/// `is_error` tool_result with `message` and can adapt its plan.
#[tauri::command]
fn deny_tool_use(
    state: State<'_, RunState>,
    run_id: String,
    request_id: String,
    message: Option<String>,
) -> Result<(), String> {
    let mut inner = lock_recovering(&state.0);
    let active = inner
        .runs
        .get_mut(&run_id)
        .ok_or_else(|| format!("no active run with id {run_id}"))?;
    if !active.pending_permissions.remove(&request_id) {
        return Err(format!(
            "unknown or already-resolved request_id: {request_id}"
        ));
    }
    let decision = vault_core::runner::PermissionDecision::Deny {
        message: message.unwrap_or_else(|| "user denied".to_string()),
    };
    if !active.killer.respond_to_permission(request_id, decision) {
        return Err("failed to deliver denial — runner has no live permission channel".into());
    }
    Ok(())
}

/// Snapshot every currently-running spawn. Used by the frontend on
/// mount to recover panel state across remounts (HMR in dev) and IDE
/// restarts during a long run — without the started context, Reply /
/// Resume would fail with "vault root not accessible: <empty>".
///
/// Each entry mirrors the `run:started` event so the caller can drop
/// it straight into its per-tab state. Order is unspecified — callers
/// that need stability (e.g. "which run is oldest") should sort by
/// the gen prefix in `run_id`.
#[tauri::command]
fn get_runs(state: State<'_, RunState>) -> Result<Vec<RunStartedPayload>, String> {
    let inner = lock_recovering(&state.0);
    Ok(inner.runs.values().map(|a| a.started.clone()).collect())
}

/// Open the consolidated [`AppDb`] in `data_dir/app.db`, run the
/// pre-open file rename (legacy `sessions.db` → `app.db`) and the
/// post-open JSON migration (`dismissed.json`, `recent_vaults.json`),
/// then stash the store as Tauri State.
///
/// All failures are logged but non-fatal: the IDE remains usable; the
/// affected features (History tab, dismiss persistence, recent-vaults
/// list) simply won't have a backing store and the corresponding
/// commands will return errors when invoked.
fn init_app_db<R: tauri::Runtime>(app: &tauri::App<R>, data_dir: &Path) {
    let target = data_dir.join("app.db");
    let legacy_sessions = data_dir.join("sessions.db");

    // Pre-open rename: earlier we called the file `sessions.db`. If
    // the user already has data there and no `app.db` yet, move it
    // into place so their session history survives the rename. If
    // both exist (shouldn't normally happen — only via manual file
    // restore) we leave the legacy file alone to avoid clobbering.
    if legacy_sessions.is_file() && !target.exists() {
        if let Err(e) = std::fs::rename(&legacy_sessions, &target) {
            eprintln!(
                "could not rename {} → {}: {e}",
                legacy_sessions.display(),
                target.display()
            );
        }
    }

    let db = match vault_core::db::AppDb::open(&target) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("failed to open AppDb at {}: {e}", target.display());
            return;
        }
    };

    // Post-open: migrate the legacy JSON stores into their new
    // tables. Idempotent — empty tables import, then the source file
    // is deleted; subsequent starts find no files and do nothing.
    match vault_core::db::migrate_legacy_json(&db, data_dir) {
        Ok(report) => {
            if report.dismissed_imported > 0 || report.recents_imported > 0 {
                eprintln!(
                    "AppDb: migrated legacy JSON — dismissed={}, recents={}",
                    report.dismissed_imported, report.recents_imported
                );
            }
        }
        Err(e) => {
            eprintln!("AppDb: legacy JSON migration error (non-fatal): {e}");
        }
    }

    app.manage(db);
}

// ---------- Recommendations ----------

/// Compute recommendations for the current vault. Re-scans + inspects
/// repo state per project, then applies the rule set in
/// `vault_core::recommendations`. Returns all rules' output; the frontend
/// filters out dismissed ids client-side using `list_dismissed`.
/// Compute recommendations for the current vault. Re-scans + inspects repo
/// state per project, then applies the rule set in `recommendations`.
///
/// `async` + `spawn_blocking` is mandatory here — this calls `scan_vault`
/// (full walk) AND loops `git` subprocesses for every project with a
/// `local_path`. Easily the heaviest single command in the shell.
///
/// Security: each project's `local_path` is passed through
/// `runner::validate_workdir` before inspection; an entry that resolves to a
/// denied path is silently skipped (rather than aborting the whole compute)
/// so one bad project frontmatter doesn't block recommendations for the rest.
#[tauri::command]
async fn compute_recommendations(
    vault_root: String,
) -> Result<Vec<vault_core::recommendations::Recommendation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&vault_root)
            .canonicalize()
            .map_err(|e| format!("vault root not accessible: {vault_root}: {e}"))?;
        let scan = vault_core::scan_vault(&path).map_err(|e| e.to_string())?;

        let mut repo_states: HashMap<String, vault_core::SourceRepoInspection> = HashMap::new();
        for project in &scan.projects {
            if let Some(lp) = project.local_path.as_deref() {
                if let Ok(safe) = vault_core::runner::validate_workdir(&PathBuf::from(lp)) {
                    let inspection = vault_core::inspect_source_repo(&safe);
                    repo_states.insert(project.slug.clone(), inspection);
                }
            }
        }

        Ok(vault_core::recommendations::compute_recommendations(
            &path,
            &scan,
            &repo_states,
        ))
    })
    .await
    .map_err(|e| format!("compute_recommendations task failed: {e}"))?
}

// ---------- AppDb-backed commands (dismissed / recents / sessions) ----------

/// Canonicalize the vault path so dismissals + sessions key off the
/// same string regardless of how the frontend supplied it
/// (with/without trailing slash, via symlink, etc.).
fn vault_key(vault_root: &str) -> Result<String, String> {
    let path = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("vault root not accessible: {vault_root}: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn dismiss_recommendation(
    vault_root: String,
    rec_id: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    db.dismiss_recommendation(&key, &rec_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_recommendation(
    vault_root: String,
    rec_id: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    db.restore_recommendation(&key, &rec_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dismissed(
    vault_root: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<Vec<String>, String> {
    let key = vault_key(&vault_root)?;
    db.list_dismissed(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_dismissals(
    vault_root: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    db.clear_dismissals(&key).map_err(|e| e.to_string())
}

// ---------- Recent vaults ----------

#[tauri::command]
fn record_recent_vault(path: String, db: State<'_, vault_core::db::AppDb>) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("vault path not accessible: {path}: {e}"))?
        .to_string_lossy()
        .to_string();
    db.record_recent_vault(&canonical)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_recent_vaults(
    db: State<'_, vault_core::db::AppDb>,
) -> Result<Vec<vault_core::db::recents::RecentVault>, String> {
    db.list_recent_vaults().map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_recent_vault(path: String, db: State<'_, vault_core::db::AppDb>) -> Result<(), String> {
    db.remove_recent_vault(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn pin_recent_vault(
    path: String,
    pinned: bool,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    db.pin_recent_vault(&path, pinned)
        .map_err(|e| e.to_string())
}

// ---------- Session history ----------

/// Upsert a chat / artifact-run session into the history store. Called
/// from the frontend on `run:exit` (and on subsequent resume turns) so
/// the conversation can be reopened later from the History tab.
#[tauri::command]
fn save_session(
    input: vault_core::db::sessions::SaveSessionInput,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<i64, String> {
    db.save_session(input).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_sessions(
    vault_root: String,
    include_archived: bool,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<Vec<vault_core::db::sessions::SessionSummary>, String> {
    let key = vault_key(&vault_root)?;
    db.list_sessions(&key, include_archived)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_session(
    id: i64,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<vault_core::db::sessions::SessionFull, String> {
    db.get_session(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn archive_session(
    id: i64,
    archived: bool,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    db.archive_session(id, archived).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session(id: i64, db: State<'_, vault_core::db::AppDb>) -> Result<(), String> {
    db.delete_session(id).map_err(|e| e.to_string())
}

/// PNG bytes embedded at compile time. macOS uses a template image
/// (pure-black on transparent) that the OS inverts for light/dark
/// menubars; other platforms get the colored amber variant.
#[cfg(target_os = "macos")]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray/tray-template-64.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray/tray-amber-64.png");

/// Build the system tray: amber/template icon + Show/Quit menu on
/// right-click, left-click toggles the main window.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::image::Image;
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray:show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray:quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = Image::from_bytes(TRAY_ICON_BYTES)?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Curator")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray:show" => show_main_window(app),
            "tray:quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let visible = w.is_visible().unwrap_or(false);
    let focused = w.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// On macOS, a `.app` launched via Finder / LaunchServices inherits only
/// the system default `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), missing
/// the directories where the user installs CLI tools (`/opt/homebrew/bin`,
/// `~/.npm-global/bin`, `~/.bun/bin`, nvm/volta/mise shims, …). Without
/// this, `Command::new("claude")` — and anything the runner shells out to
/// (git, node, bun) — fails with `NotFound` even though the binary is
/// installed.
///
/// Fix: spawn the user's login shell once at startup with `-lc` so it
/// sources `~/.zprofile` / `~/.bash_profile` (where PATH exports
/// conventionally live), capture its `$PATH`, and merge it into the
/// current process.
///
/// **Must be called from `main()` BEFORE any thread is spawned.**
/// `std::env::set_var` is unsound when other threads may call `getenv`
/// concurrently (Rust 1.81+ marks the underlying syscall unsafe for this
/// reason); Tauri's `run()` creates worker threads as part of setup, so
/// calling this after `run()` starts is racy. Hence the `pub fn` exposed
/// to `main.rs`.
///
/// Two-pass strategy:
///   1. `-lc` (login) sources `~/.zprofile` / `~/.bash_profile` — cheap,
///      covers users who put `export PATH=…` there.
///   2. If after pass 1 `node` or `claude` still aren't findable, retry
///      with `-ilc` (interactive login) which additionally sources
///      `~/.zshrc` / `~/.bashrc` — that's where nvm / mise / volta / asdf
///      init scripts live and where most dev installs of `node` end up.
///      Pays the ~0.5–1s interactive-init cost only when the cheap pass
///      isn't enough.
///
/// Users with non-standard PATH setups can still set `CLAUDE_BIN` to an
/// absolute path.
#[cfg(target_os = "macos")]
pub fn prime_user_path() {
    use std::collections::HashSet;
    use std::process::Command;

    const START: &str = "__CURATOR_PATH_START__";
    const END: &str = "__CURATOR_PATH_END__";

    // Reject shells with whitespace / unusual characters — `$SHELL` is
    // attacker-controllable via Launch Services env injection, and a
    // value like `/tmp/evil; rm` would otherwise be spawned as the
    // shell. We deliberately accept any absolute path (users may run
    // fish, nu, etc.) — just not values that look like shell syntax.
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| {
            let t = s.trim();
            !t.is_empty()
                && t.starts_with('/')
                && !t
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '`' | '$'))
        })
        .unwrap_or_else(|| "/bin/zsh".to_string());

    // Capture PATH from a shell invocation. Sentinels bracket the value
    // so banner output from a chatty shell doesn't corrupt parsing.
    fn capture_path(shell: &str, flags: &str) -> Option<String> {
        let out = Command::new(shell)
            .args([flags, &format!("printf '{START}%s{END}' \"$PATH\"")])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let s = stdout.find(START)?;
        let e = stdout.find(END)?;
        let value = stdout[s + START.len()..e].to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    fn merge_path(shell_path: &str) {
        let current = std::env::var("PATH").unwrap_or_default();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut parts: Vec<&str> = Vec::new();
        for p in shell_path.split(':').chain(current.split(':')) {
            if p.is_empty() {
                continue;
            }
            if seen.insert(p) {
                parts.push(p);
            }
        }
        // SAFETY: called from `main()` before any thread is spawned. See
        // the doc comment above for why this matters. `set_var` was
        // marked `unsafe` in Rust 1.81; current toolchains accept it as
        // safe still but will error in a future edition.
        std::env::set_var("PATH", parts.join(":"));
    }

    fn path_can_find(name: &str) -> bool {
        let path = match std::env::var_os("PATH") {
            Some(p) => p,
            None => return false,
        };
        std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
    }

    // Pass 1: cheap login shell.
    let Some(login_path) = capture_path(&shell, "-lc") else {
        eprintln!("prime_user_path: -lc capture failed for {shell}");
        return;
    };
    merge_path(&login_path);

    // Pass 2: only if the cheap pass didn't land the tools we need.
    // nvm / mise / volta init lives in ~/.zshrc, not ~/.zprofile — pay
    // the interactive-init cost once to pick them up.
    if !path_can_find("node") || !path_can_find("claude") {
        if let Some(interactive_path) = capture_path(&shell, "-ilc") {
            merge_path(&interactive_path);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn prime_user_path() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatchState::default());
            app.manage(RunState::default());

            // Resolve the bundled ACP agent paths once at startup.
            // Failure here means the bundled JS wrapper or the
            // fetched codex-acp binary is missing — fatal for the
            // runner subsystem. We log the precise error and let the
            // app boot anyway: every spawn attempt will then return
            // the same error inline in the chat, which beats a silent
            // crash on launch.
            match acp_paths::resolve(app.app_handle()) {
                Ok(paths) => {
                    app.manage(paths);
                }
                Err(e) => {
                    eprintln!("acp_paths: {e}");
                }
            }

            // Consolidated SQLite store. One file under
            // app_local_data_dir holds sessions, dismissed
            // recommendations, and the recent-vaults list. Before
            // consolidation these were three separate persistence
            // mechanisms; opening here also runs the one-shot
            // migration from the legacy `sessions.db` filename plus
            // any leftover JSON files.
            //
            // Failure to open is logged and the IDE keeps working;
            // commands relying on the store will surface their own
            // "store unavailable" errors.
            if let Ok(data_dir) = app.path().app_local_data_dir() {
                init_app_db(app, &data_dir);
            } else {
                eprintln!("no app_local_data_dir available — persistence disabled");
            }

            // Failure to install the tray is non-fatal — log and
            // keep going. The app is still usable via the dock.
            if let Err(e) = setup_tray(app) {
                eprintln!("failed to install system tray: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_vault,
            init_vault,
            init_project,
            demo_vault_path,
            preview_context,
            inspect_source_repo,
            scan_project_vulnerabilities,
            git_status,
            git_diff,
            git_stage,
            git_stage_all,
            git_unstage,
            git_commit,
            git_log,
            read_markdown_file,
            write_markdown_file,
            create_markdown_file,
            promote_draft,
            discard_draft,
            start_vault_watch,
            stop_vault_watch,
            start_run,
            resume_run,
            start_freeform_run,
            resume_freeform_run,
            stop_run,
            approve_tool_use,
            deny_tool_use,
            get_runs,
            compute_recommendations,
            dismiss_recommendation,
            restore_recommendation,
            list_dismissed,
            clear_dismissals,
            save_session,
            list_sessions,
            get_session,
            archive_session,
            delete_session,
            record_recent_vault,
            list_recent_vaults,
            remove_recent_vault,
            pin_recent_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
