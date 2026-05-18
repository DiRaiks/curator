use std::path::PathBuf;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatchState::default());
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
            start_vault_watch,
            stop_vault_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
