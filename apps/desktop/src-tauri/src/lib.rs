use std::collections::{BTreeSet, HashMap};
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
    /// Snapshot of the `run:started` payload, kept so a frontend that
    /// remounts mid-run (HMR in dev, app restart during a long run) can
    /// re-sync via `get_run_status` and recover the context needed to
    /// resume the conversation. Without this, the mount-time sync
    /// installs a placeholder with empty fields and Reply later fails
    /// with "vault root not accessible: <empty>".
    started: RunStartedPayload,
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

    // Build the started payload once — it gets emitted to the frontend
    // AND stashed in RunState so a later `get_run_status` can return
    // the same context after a mount-time resync.
    let started_payload = RunStartedPayload {
        project_slug,
        prompt_id,
        vault_root: vault_path.to_string_lossy().to_string(),
        workdir: workdir.to_string_lossy().to_string(),
        runner: "claude-code",
        resume: is_resume,
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

// ---------- Recommendations + dismiss store ----------

/// Persistent storage for dismissed recommendation ids, per vault.
/// Keyed by canonical vault path (string form) → ordered set of rec ids.
/// Persisted to `app_local_data_dir/dismissed.json` on every write;
/// loaded once at startup.
#[derive(Default)]
struct DismissedStore {
    inner: Mutex<DismissedStoreInner>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct DismissedStoreInner {
    /// `BTreeSet` keeps the on-disk JSON stable across saves (no
    /// jitter from hashmap ordering).
    by_vault: HashMap<String, BTreeSet<String>>,
    /// Absolute path where this store persists. Set during init from
    /// `app_local_data_dir`; never written back to JSON.
    #[serde(skip)]
    persist_path: Option<PathBuf>,
}

impl DismissedStoreInner {
    fn load_from(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(s) => {
                let mut inner: DismissedStoreInner =
                    serde_json::from_str(&s).unwrap_or_default();
                inner.persist_path = Some(path.to_path_buf());
                inner
            }
            Err(_) => DismissedStoreInner {
                persist_path: Some(path.to_path_buf()),
                ..Default::default()
            },
        }
    }

    /// Best-effort persistence. Writes via a `.tmp` sibling + rename so a
    /// crash mid-write doesn't corrupt the file. Errors are swallowed —
    /// the IDE keeps working with the in-memory state even if persistence
    /// is broken (e.g. disk full).
    fn save(&self) {
        let Some(path) = self.persist_path.as_ref() else { return };
        let Ok(content) = serde_json::to_string_pretty(self) else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, content).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

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

/// Dismiss a recommendation by id for the given vault. Idempotent.
#[tauri::command]
fn dismiss_recommendation(
    vault_root: String,
    rec_id: String,
    store: State<'_, DismissedStore>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    let mut inner = lock_recovering(&store.inner);
    inner
        .by_vault
        .entry(key)
        .or_default()
        .insert(rec_id);
    inner.save();
    Ok(())
}

/// Restore a previously dismissed recommendation. Useful when the user
/// changes their mind.
#[tauri::command]
fn restore_recommendation(
    vault_root: String,
    rec_id: String,
    store: State<'_, DismissedStore>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    let mut inner = lock_recovering(&store.inner);
    if let Some(set) = inner.by_vault.get_mut(&key) {
        set.remove(&rec_id);
        if set.is_empty() {
            inner.by_vault.remove(&key);
        }
    }
    inner.save();
    Ok(())
}

/// List dismissed recommendation ids for the given vault. Returned as a
/// sorted vector so the frontend can use the value directly without
/// re-sorting.
#[tauri::command]
fn list_dismissed(
    vault_root: String,
    store: State<'_, DismissedStore>,
) -> Result<Vec<String>, String> {
    let key = vault_key(&vault_root)?;
    let inner = lock_recovering(&store.inner);
    Ok(inner
        .by_vault
        .get(&key)
        .map(|set| set.iter().cloned().collect())
        .unwrap_or_default())
}

/// Clear all dismissals for the given vault. Useful as a "show all
/// recommendations again" reset.
#[tauri::command]
fn clear_dismissals(
    vault_root: String,
    store: State<'_, DismissedStore>,
) -> Result<(), String> {
    let key = vault_key(&vault_root)?;
    let mut inner = lock_recovering(&store.inner);
    inner.by_vault.remove(&key);
    inner.save();
    Ok(())
}

/// Canonicalize the vault path so dismissals key off the same string
/// regardless of how the frontend supplied it (with/without trailing
/// slash, via symlink, etc.).
fn vault_key(vault_root: &str) -> Result<String, String> {
    let path = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("vault root not accessible: {vault_root}: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatchState::default());
            app.manage(RunState::default());

            // Load persisted dismissals (best-effort) and stash the
            // store so commands can mutate it. The persist path lives
            // under the OS-standard per-app data dir so it survives
            // across vault reopens and is private to this user/machine.
            let persist_path = app
                .path()
                .app_local_data_dir()
                .map(|d| d.join("dismissed.json"))
                .ok();
            let inner = match persist_path.as_ref() {
                Some(p) => DismissedStoreInner::load_from(p),
                None => DismissedStoreInner::default(),
            };
            app.manage(DismissedStore {
                inner: Mutex::new(inner),
            });

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
            get_run_status,
            compute_recommendations,
            dismiss_recommendation,
            restore_recommendation,
            list_dismissed,
            clear_dismissals
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
