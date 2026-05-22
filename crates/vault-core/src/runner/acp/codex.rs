//! Codex runner backed by the bundled `codex-acp` native binary.
//!
//! Spawn shape:
//!
//! ```text
//! <bundled>/codex-acp     (Tauri externalBin sidecar)
//! ```
//!
//! Unlike the Claude wrapper which is JS + delegates to the user's
//! system `claude` binary, codex-acp is a 172 MB standalone Mach-O
//! that embeds its own codex runtime. Per-platform binaries are
//! fetched at dev-setup time by `scripts/fetch-acp-binaries.sh` and
//! placed in `apps/desktop/src-tauri/binaries/codex-acp-<triple>`,
//! which Tauri's externalBin slot maps into the .app at build time.
//!
//! ## Capability gaps vs claude-agent-acp
//!
//! As of codex-acp 0.14:
//! - `additionalDirectories`: NOT advertised. The transport sends
//!   the field anyway; codex-acp silently ignores it. For
//!   `(workdir = project-repo, vault accessible via add-dir)` runs
//!   this means codex doesn't see the vault outside cwd. Vault-only
//!   chats (cwd = vault root) are unaffected.
//! - `set_session_model`: NOT advertised. The transport sends the
//!   RPC anyway; codex-acp returns method-not-found, which we
//!   demote to a Stderr event. The model picker for codex is
//!   informational — codex picks from `~/.codex/config.toml`.

use std::path::PathBuf;

use super::transport::{spawn_acp, AcpSpawnConfig};
use crate::runner::{RunHandle, RunRequest, Runner, RunnerError, RunnerKind};

pub struct AcpCodexRunner {
    /// Absolute path to the bundled `codex-acp` binary. Resolved by
    /// the Tauri shell at startup from the externalBin sidecar
    /// location; see `apps/desktop/src-tauri/tauri.conf.json` →
    /// `bundle.externalBin`.
    pub binary: PathBuf,
}

impl AcpCodexRunner {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }
}

impl Runner for AcpCodexRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Codex
    }

    fn start(&self, req: RunRequest) -> Result<RunHandle, RunnerError> {
        let config = AcpSpawnConfig {
            name: "codex-acp".to_string(),
            command: self.binary.clone(),
            args: Vec::new(),
            // codex-acp picks up auth (ChatGPT login / API key) from
            // its own `~/.codex/` data dir — no env vars needed from
            // our side. Anything we add here would be misleading
            // since codex-acp's behaviour is fully driven by
            // config.toml + the embedded codex runtime.
            env: Vec::new(),
        };
        spawn_acp(config, req)
    }
}
