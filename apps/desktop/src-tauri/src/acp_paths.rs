//! Path resolution for the bundled ACP agent assets.
//!
//! At runtime we need four absolute paths to spawn an ACP-driven run:
//!
//! 1. `node` — runs the JS wrapper for Claude. Resolved through
//!    `PATH` (the user already has it for the standalone `claude`
//!    CLI; `prime_user_path` in `lib.rs` ensures macOS GUI launches
//!    see it).
//! 2. `claude-agent-acp/dist/index.js` — the vendored JS wrapper
//!    under our Tauri `resource_dir()`. Hardcoded relative path:
//!    `resources/acp/claude-agent-acp/dist/index.js`.
//! 3. `claude` — the user's system Claude Code CLI, also via `PATH`.
//!    We forward this as `CLAUDE_CODE_EXECUTABLE` so the wrapper
//!    skips its own bundled SDK runtime (the bundled binary is
//!    208 MB per platform — we deliberately don't ship it).
//! 4. `codex-acp` — the bundled native binary, fetched into
//!    `apps/desktop/src-tauri/binaries/codex-acp-<triple>` by
//!    `scripts/fetch-acp-binaries.sh`. Tauri's `externalBin` slot
//!    copies it next to the app executable at bundle time; in
//!    dev mode we fall back to the source path.
//!
//! Resolution happens once at `setup()` and the result is stashed in
//! Tauri State so per-spawn dispatch in `spawn_and_pump` is just a
//! struct read.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// All paths the ACP runners need. Resolved once and cached as Tauri
/// state.
#[derive(Clone)]
pub(crate) struct AcpPaths {
    /// `node` binary, defaults to bare `"node"` (PATH-resolved by
    /// the OS at spawn time). We don't pin an absolute path because
    /// different installs (nvm, volta, system) put `node` in
    /// different places; relying on PATH matches how `claude` is
    /// already resolved.
    pub node_bin: PathBuf,
    /// Absolute path to the bundled `claude-agent-acp/dist/index.js`
    /// inside our Tauri resources.
    pub claude_wrapper_js: PathBuf,
    /// `claude` system binary. Same resolution policy as `node_bin`.
    pub claude_bin: PathBuf,
    /// Absolute path to the bundled `codex-acp` native binary.
    /// Tauri externalBin places it next to `current_exe()` in
    /// production; in dev mode we resolve from the source
    /// `binaries/` directory using the compile-time host triple.
    pub codex_acp_bin: PathBuf,
}

/// Resolve all paths from the live AppHandle. Returns an error
/// describing the first missing asset so the user gets a clear
/// message on misconfiguration (rare — only happens if the
/// `fetch-acp-binaries.sh` step was skipped or the bundled
/// resources got stripped).
///
/// The caller is expected to log + abort the app on `Err` since the
/// runners cannot function without these paths. In dev we crash
/// fast; in prod we surface the error in the splash screen.
pub(crate) fn resolve(app: &AppHandle) -> Result<AcpPaths, String> {
    let claude_wrapper_js = resolve_claude_wrapper(app)?;
    let codex_acp_bin = resolve_codex_acp_bin(app)?;
    Ok(AcpPaths {
        node_bin: PathBuf::from("node"),
        claude_wrapper_js,
        claude_bin: PathBuf::from("claude"),
        codex_acp_bin,
    })
}

/// Resolve the claude-agent-acp JS wrapper. The vendored layout is a
/// full npm-style `node_modules/` tree under `resources/acp/` so the
/// wrapper's runtime `import '@anthropic-ai/claude-agent-sdk'` walks
/// up from its own `dist/index.js`, finds the sibling node_modules,
/// and resolves the SDK without touching the user's npm cache.
///
/// Without this layout, Node's resolver would fail at module load —
/// the wrapper imports the SDK as a hard ESM dep, BEFORE
/// `CLAUDE_CODE_EXECUTABLE` ever gets consulted. Flat vendoring of
/// just the wrapper (no transitive deps) broke spawn with
/// `ERR_MODULE_NOT_FOUND`.
///
/// Tries the production Tauri resource dir first; falls back to the
/// source-tree path for `cargo tauri dev`.
fn resolve_claude_wrapper(app: &AppHandle) -> Result<PathBuf, String> {
    const REL: &str =
        "resources/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    const REL_NO_PREFIX: &str =
        "acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";

    if let Ok(base) = app.path().resource_dir() {
        for rel in [REL, REL_NO_PREFIX] {
            let candidate = base.join(rel);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // Dev fallback. CARGO_MANIFEST_DIR points at apps/desktop/src-tauri
    // at compile time, where `resources/` is committed.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(REL);
    if dev.is_file() {
        return Ok(dev);
    }

    Err(format!(
        "claude-agent-acp wrapper not found. Tried Tauri resource dir + dev path \
         (CARGO_MANIFEST_DIR/{REL}). Verify that apps/desktop/src-tauri/resources/acp/ \
         is populated."
    ))
}

/// Resolve the `codex-acp` native binary. Production path is
/// alongside `current_exe()` (Tauri externalBin convention strips the
/// target-triple suffix at bundle time). Dev fallback is the
/// fetch-script output with the host triple suffix.
fn resolve_codex_acp_bin(_app: &AppHandle) -> Result<PathBuf, String> {
    let exec_name = if cfg!(target_os = "windows") {
        "codex-acp.exe"
    } else {
        "codex-acp"
    };

    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            let candidate = parent.join(exec_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // Dev fallback — the fetch script names the file with the host
    // target triple suffix. Construct it from the cfg() values so a
    // future cross-host dev setup picks up the right binary.
    let triple = host_target_triple()?;
    let dev_name = format!("codex-acp-{triple}");
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&dev_name);
    if dev.is_file() {
        return Ok(dev);
    }

    Err(format!(
        "codex-acp binary not found. Tried {} (production) and {} (dev). \
         Run `./scripts/fetch-acp-binaries.sh` from the repo root to populate the dev path.",
        exec_name,
        dev.display()
    ))
}

/// Construct the host target triple from compile-time cfg attributes.
/// Keep this in sync with `scripts/fetch-acp-binaries.sh`'s map —
/// both must agree on the suffix to use for the host platform.
fn host_target_triple() -> Result<&'static str, String> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        (os, arch) => {
            return Err(format!(
                "unsupported host platform: os={os}, arch={arch}; \
                 no codex-acp binary mapping configured"
            ));
        }
    })
}
