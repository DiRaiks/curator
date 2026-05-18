use std::path::PathBuf;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_vault,
            demo_vault_path,
            preview_context,
            inspect_source_repo,
            read_markdown_file,
            write_markdown_file,
            create_markdown_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
