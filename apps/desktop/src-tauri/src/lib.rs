use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn scan_vault(path: String) -> Result<vault_core::ScanResult, String> {
    vault_core::scan_vault(&PathBuf::from(path)).map_err(|e| e.to_string())
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
    runner: &'static str,
    /// True when this run is a resume of a prior session (`--resume`).
    /// The frontend keeps prior output buffer + session state visible
    /// across resumes; a fresh start resets them.
    resume: bool,
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
        app,
        state: &state,
    })
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
/// runs both code paths (`start_run` + `resume_run`) and a 9-arg call
/// site is unreadable.
struct SpawnArgs<'s> {
    vault_path: PathBuf,
    workdir: PathBuf,
    additional_dirs: Vec<PathBuf>,
    prompt: String,
    runtime_input: Option<String>,
    resume_session_id: Option<String>,
    project_slug: String,
    prompt_id: String,
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
        app,
        state,
    } = args;

    // Capture the resume flag before constructing the request so it
    // survives the move into `Runner::start`.
    let is_resume = resume_session_id.is_some();

    let req = vault_core::runner::RunRequest {
        workdir: workdir.clone(),
        additional_dirs,
        prompt,
        runtime_input,
        resume_session_id,
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
        inner.active = Some(ActiveRun { gen, killer });
        (events, gen)
    };

    let _ = app.emit(
        "run:started",
        RunStartedPayload {
            project_slug,
            prompt_id,
            vault_root: vault_path.to_string_lossy().to_string(),
            workdir: workdir.to_string_lossy().to_string(),
            runner: "claude-code",
            resume: is_resume,
        },
    );

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

/// Query whether a run is currently active. Used by the frontend on
/// mount to synchronise its local `running` flag with reality — without
/// this, a component remounting while a run is alive would show the Run
/// button enabled.
#[tauri::command]
fn get_run_status(state: State<'_, RunState>) -> Result<RunStatusPayload, String> {
    let inner = lock_recovering(&state.0);
    Ok(RunStatusPayload {
        active: inner.active.is_some(),
    })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStatusPayload {
    active: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatchState::default());
            app.manage(RunState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_vault,
            demo_vault_path,
            preview_context,
            inspect_source_repo,
            read_markdown_file,
            write_markdown_file,
            create_markdown_file,
            promote_draft,
            discard_draft,
            start_vault_watch,
            stop_vault_watch,
            start_run,
            resume_run,
            stop_run,
            get_run_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
