use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn scan_vault(path: String) -> Result<vault_core::ScanResult, String> {
    vault_core::scan_vault(&PathBuf::from(path)).map_err(|e| e.to_string())
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
        vault_core::init_project(&PathBuf::from(&vault_root), &args)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("init_project task failed: {e}"))?
}

#[tauri::command]
fn preview_context(
    vault_path: String,
    project_slug: String,
    prompt_id: String,
) -> Result<vault_core::ContextPreview, String> {
    vault_core::preview_context(&PathBuf::from(vault_path), &project_slug, &prompt_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn inspect_source_repo(local_path: String) -> Result<vault_core::SourceRepoInspection, String> {
    Ok(vault_core::inspect_source_repo(&PathBuf::from(local_path)))
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

#[tauri::command]
fn read_markdown_file(
    vault_root: String,
    relative_path: String,
) -> Result<String, String> {
    vault_core::read_markdown_file(&PathBuf::from(vault_root), &relative_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_markdown_file(
    vault_root: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    vault_core::write_markdown_file(
        &PathBuf::from(vault_root),
        &relative_path,
        &content,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_markdown_file(
    vault_root: String,
    relative_path: String,
) -> Result<String, String> {
    vault_core::create_markdown_file(&PathBuf::from(vault_root), &relative_path)
        .map_err(|e| e.to_string())
}

/// Promote an agent-produced draft into its `proposed_destination`.
/// Returns the new vault-relative path on success.
#[tauri::command]
fn promote_draft(
    vault_root: String,
    draft_path: String,
) -> Result<String, String> {
    vault_core::promote_draft(&PathBuf::from(vault_root), &draft_path)
        .map_err(|e| e.to_string())
}

/// Delete a draft from the vault. Idempotent on `NotFound`? No — the UI
/// can show the rescan stale-state, so we surface NotFound as an error.
#[tauri::command]
fn discard_draft(
    vault_root: String,
    draft_path: String,
) -> Result<(), String> {
    vault_core::discard_draft(&PathBuf::from(vault_root), &draft_path)
        .map_err(|e| e.to_string())
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
    let (token, rx) = vault_core::watch::start_watch(vec![root])
        .map_err(|e| e.to_string())?;

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

#[derive(Default)]
struct RunStateInner {
    next_gen: RunGen,
    active: Option<ActiveRun>,
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
    /// Keyed by `request_id`. Cleared when the user picks approve/deny
    /// via [`approve_tool_use`] / [`deny_tool_use`] (which both
    /// validate the id exists before writing to claude's stdin so a
    /// stale modal click doesn't desync the protocol).
    pending_permissions: HashMap<String, ()>,
}

/// Holds the active CLI run's kill switch (if any) plus a monotonic
/// generation counter to disambiguate concurrent stop/restart sequences.
/// The receiver lives on the emit thread; this slot exists only as a
/// "stop button" + presence flag. The shell allows at most one run at a
/// time; concurrent runs are rejected up front.
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
    runner: &'static str,
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
    line: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStderrPayload {
    line: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunTruncatedPayload {
    dropped_bytes: usize,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunExitPayload {
    code: Option<i32>,
    success: bool,
}

/// `run:permission-request` event payload. Mirrors the runner's
/// `PermissionRequest` struct one-for-one — separate type kept so the
/// shell's IPC surface is self-contained and the runner crate stays
/// Tauri-agnostic. Only the fields the modal actually renders surface
/// here; the rest of the SDK payload is dropped on the floor for now.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunPermissionRequestPayload {
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
#[tauri::command]
fn start_run(
    vault_root: String,
    project_slug: String,
    prompt_id: String,
    runtime_input: Option<String>,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<(), String> {
    let vault_path = canonicalize_vault_root(&vault_root)?;
    let preview = vault_core::preview_context(&vault_path, &project_slug, &prompt_id)
        .map_err(|e| e.to_string())?;
    let (workdir, additional_dirs) =
        resolve_workdir(&vault_path, preview.source_repo.local_path.as_deref());

    spawn_and_pump(SpawnArgs {
        vault_path,
        workdir,
        additional_dirs,
        prompt: preview.external_runner_prompt.clone(),
        runtime_input,
        resume_session_id: None,
        project_slug,
        prompt_id,
        freeform: false,
        app,
        state: &state,
    })
}

/// Continue an existing Claude session — `claude --resume <session_id>`.
/// The prompt slot carries the user's reply (next conversation turn),
/// not a fresh task description; claude already has the prior context
/// cached under the session id. Cwd and `--add-dir` are re-derived from
/// the same `(project, prompt)` pair so tool access keeps working.
#[tauri::command]
fn resume_run(
    vault_root: String,
    project_slug: String,
    prompt_id: String,
    session_id: String,
    reply: String,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session id is required to resume a run".into());
    }
    if reply.trim().is_empty() {
        return Err("reply text is required to resume a run".into());
    }
    let vault_path = canonicalize_vault_root(&vault_root)?;
    let preview = vault_core::preview_context(&vault_path, &project_slug, &prompt_id)
        .map_err(|e| e.to_string())?;
    let (workdir, additional_dirs) =
        resolve_workdir(&vault_path, preview.source_repo.local_path.as_deref());

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
#[tauri::command]
fn start_freeform_run(
    vault_root: String,
    prompt: String,
    scope_project_slug: Option<String>,
    scope_repo_path: Option<String>,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".into());
    }
    let vault_path = canonicalize_vault_root(&vault_root)?;
    let (workdir, additional_dirs) =
        resolve_workdir(&vault_path, scope_repo_path.as_deref());

    let project_slug = scope_project_slug
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "(vault)".to_string());
    let wrapped = build_freeform_prompt(&vault_path, &prompt, workdir != vault_path);

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
#[tauri::command]
fn resume_freeform_run(
    vault_root: String,
    workdir: String,
    additional_dirs: Vec<String>,
    project_slug: String,
    session_id: String,
    reply: String,
    app: AppHandle,
    state: State<'_, RunState>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session id is required to resume a run".into());
    }
    if reply.trim().is_empty() {
        return Err("reply text is required to resume a run".into());
    }
    let vault_path = canonicalize_vault_root(&vault_root)?;
    let workdir = vault_core::runner::validate_workdir(&PathBuf::from(workdir))
        .map_err(|e| e.to_string())?;
    let additional_dirs: Vec<PathBuf> =
        additional_dirs.into_iter().map(PathBuf::from).collect();

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
fn resolve_workdir(
    vault_path: &Path,
    local_path: Option<&str>,
) -> (PathBuf, Vec<PathBuf>) {
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
    app: AppHandle,
    state: &'s State<'s, RunState>,
}

/// Shared core of `start_run` / `resume_run`: build the `RunRequest`,
/// claim the run slot atomically, spawn the subprocess, kick off the
/// emit-pump thread.
fn spawn_and_pump(args: SpawnArgs<'_>) -> Result<(), String> {
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
    };

    // Build the started payload once — it gets emitted to the frontend
    // AND stashed in RunState so a later `get_run_status` can return
    // the same context after a mount-time resync.
    let started_payload = RunStartedPayload {
        project_slug,
        prompt_id,
        vault_root: vault_path.to_string_lossy().to_string(),
        workdir: workdir.to_string_lossy().to_string(),
        additional_dirs: additional_dirs_str,
        runner: "claude-code",
        resume: is_resume,
        freeform,
    };

    // Hold the RunState lock across the spawn so the "is_some" check and
    // the killer insert are atomic. The spawn itself is synchronous; no
    // async / await in this block. This closes the TOCTOU window where
    // two concurrent `start_run` calls could both pass the guard.
    let (events, gen) = {
        let mut inner = lock_recovering(&state.0);
        if inner.active.is_some() {
            return Err(
                "another run is already active — stop it before starting a new one".into(),
            );
        }

        use vault_core::runner::Runner as _;
        let runner = vault_core::runner::ClaudeRunner::new();
        let handle = runner.start(req).map_err(|e| e.to_string())?;
        let (events, killer) = handle.into_parts();

        let gen = inner.next_gen.wrapping_add(1);
        inner.next_gen = gen;
        inner.active = Some(ActiveRun {
            gen,
            killer,
            started: started_payload.clone(),
            pending_permissions: HashMap::new(),
        });
        (events, gen)
    };

    let _ = app.emit("run:started", started_payload);

    // Emit pump. Drains the receiver and forwards each event as a typed
    // Tauri event. On `Exit` the slot is cleared, but only if this thread
    // still owns it (matching generation) — protects against a fast
    // stop+restart sequence where this thread's tail would otherwise
    // delete the new run's killer.
    let app_for_thread = app.clone();
    thread::spawn(move || {
        use vault_core::runner::RunEvent;
        while let Ok(ev) = events.recv() {
            match ev {
                RunEvent::Stdout(line) => {
                    let _ = app_for_thread.emit(
                        "run:stdout",
                        RunStdoutPayload { line },
                    );
                }
                RunEvent::Stderr(line) => {
                    let _ = app_for_thread.emit(
                        "run:stderr",
                        RunStderrPayload { line },
                    );
                }
                RunEvent::Truncated { dropped_bytes } => {
                    let _ = app_for_thread.emit(
                        "run:truncated",
                        RunTruncatedPayload { dropped_bytes },
                    );
                }
                RunEvent::PermissionRequest(req) => {
                    // Record the pending request so approve/deny can
                    // validate the id before responding. We don't
                    // serialize the whole struct into state (the runner
                    // also keeps no buffer); just the id presence is
                    // enough to reject stale modal clicks after a
                    // restart.
                    if let Some(state) = app_for_thread.try_state::<RunState>() {
                        let mut inner = lock_recovering(&state.0);
                        if let Some(active) = inner.active.as_mut() {
                            if active.gen == gen {
                                active.pending_permissions
                                    .insert(req.request_id.clone(), ());
                            }
                        }
                    }
                    let _ = app_for_thread.emit(
                        "run:permission-request",
                        RunPermissionRequestPayload {
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
                RunEvent::Exit { code, success } => {
                    let _ = app_for_thread.emit(
                        "run:exit",
                        RunExitPayload { code, success },
                    );
                    if let Some(state) = app_for_thread.try_state::<RunState>() {
                        let mut inner = lock_recovering(&state.0);
                        // Only clear the slot if it's still OUR run. A
                        // newer run with a higher generation must not have
                        // its killer dropped by us.
                        if inner.active.as_ref().map(|a| a.gen) == Some(gen) {
                            inner.active = None;
                        }
                    }
                    break;
                }
            }
        }
    });

    Ok(())
}

/// Stop the active run, if any. Idempotent.
#[tauri::command]
fn stop_run(state: State<'_, RunState>) -> Result<(), String> {
    let active = {
        let mut inner = lock_recovering(&state.0);
        inner.active.take()
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
    request_id: String,
    updated_input: Option<serde_json::Value>,
    updated_permissions: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut inner = lock_recovering(&state.0);
    let active = inner
        .active
        .as_mut()
        .ok_or_else(|| "no active run".to_string())?;
    if active.pending_permissions.remove(&request_id).is_none() {
        return Err(format!("unknown or already-resolved request_id: {request_id}"));
    }
    let decision = vault_core::runner::PermissionDecision::Allow {
        updated_input,
        updated_permissions,
    };
    let line = vault_core::runner::build_permission_response_line(&request_id, &decision);
    if !active.killer.send_stdin(line) {
        return Err("failed to send control_response — subprocess closed stdin".into());
    }
    Ok(())
}

/// Deny a pending tool-use permission request. Writes a deny
/// `control_response` to claude's stdin; the model receives an
/// `is_error` tool_result with `message` and can adapt its plan.
#[tauri::command]
fn deny_tool_use(
    state: State<'_, RunState>,
    request_id: String,
    message: Option<String>,
) -> Result<(), String> {
    let mut inner = lock_recovering(&state.0);
    let active = inner
        .active
        .as_mut()
        .ok_or_else(|| "no active run".to_string())?;
    if active.pending_permissions.remove(&request_id).is_none() {
        return Err(format!("unknown or already-resolved request_id: {request_id}"));
    }
    let decision = vault_core::runner::PermissionDecision::Deny {
        message: message.unwrap_or_else(|| "user denied".to_string()),
    };
    let line = vault_core::runner::build_permission_response_line(&request_id, &decision);
    if !active.killer.send_stdin(line) {
        return Err("failed to send control_response — subprocess closed stdin".into());
    }
    Ok(())
}

/// Query whether a run is currently active, and if so return the full
/// `run:started` context (project_slug, prompt_id, vault_root, workdir,
/// runner). Used by the frontend on mount to recover state across
/// remounts (HMR in dev) and IDE restarts during a long run —
/// without the started context, Reply / Resume would fail with
/// "vault root not accessible: <empty>".
#[tauri::command]
fn get_run_status(state: State<'_, RunState>) -> Result<RunStatusPayload, String> {
    let inner = lock_recovering(&state.0);
    Ok(RunStatusPayload {
        active: inner.active.is_some(),
        started: inner.active.as_ref().map(|a| a.started.clone()),
    })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStatusPayload {
    active: bool,
    /// Present when `active` is `true`. Same payload shape as the
    /// `run:started` event so the frontend can drop it in directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    started: Option<RunStartedPayload>,
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
#[tauri::command]
fn compute_recommendations(
    vault_root: String,
) -> Result<Vec<vault_core::recommendations::Recommendation>, String> {
    let path = PathBuf::from(&vault_root).canonicalize().map_err(|e| {
        format!("vault root not accessible: {}: {e}", vault_root)
    })?;
    let scan = vault_core::scan_vault(&path).map_err(|e| e.to_string())?;

    // Inspect each project that declares a `local_path`. Sequential is
    // fine — a typical vault has <30 projects and git ops are fast.
    let mut repo_states: HashMap<String, vault_core::SourceRepoInspection> =
        HashMap::new();
    for project in &scan.projects {
        if let Some(lp) = project.local_path.as_deref() {
            let inspection =
                vault_core::inspect_source_repo(&PathBuf::from(lp));
            repo_states.insert(project.slug.clone(), inspection);
        }
    }

    Ok(vault_core::recommendations::compute_recommendations(
        &path,
        &scan,
        &repo_states,
    ))
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
    db.dismiss_recommendation(&key, &rec_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_recommendation(
    vault_root: String,
    rec_id: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    db.restore_recommendation(&key, &rec_id).map_err(|e| e.to_string())
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
fn record_recent_vault(
    path: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("vault path not accessible: {path}: {e}"))?
        .to_string_lossy()
        .to_string();
    db.record_recent_vault(&canonical).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_recent_vaults(
    db: State<'_, vault_core::db::AppDb>,
) -> Result<Vec<vault_core::db::recents::RecentVault>, String> {
    db.list_recent_vaults().map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_recent_vault(
    path: String,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    db.remove_recent_vault(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn pin_recent_vault(
    path: String,
    pinned: bool,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    db.pin_recent_vault(&path, pinned).map_err(|e| e.to_string())
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
    db.list_sessions(&key, include_archived).map_err(|e| e.to_string())
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
fn delete_session(
    id: i64,
    db: State<'_, vault_core::db::AppDb>,
) -> Result<(), String> {
    db.delete_session(id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatchState::default());
            app.manage(RunState::default());

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
            if let Some(data_dir) = app.path().app_local_data_dir().ok() {
                init_app_db(app, &data_dir);
            } else {
                eprintln!("no app_local_data_dir available — persistence disabled");
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
            get_run_status,
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
