//! Claude runner backed by the bundled `claude-agent-acp` JS wrapper.
//!
//! Spawn shape:
//!
//! ```text
//! node <bundled>/claude-agent-acp/dist/index.js
//!   env CLAUDE_CODE_EXECUTABLE=<system claude binary>
//! ```
//!
//! The JS wrapper resolves the `CLAUDE_CODE_EXECUTABLE` env var
//! before falling back to its own bundled SDK runtime (which we
//! deliberately do NOT ship — the SDK binary alone is ~208 MB per
//! platform, and the user already has `claude` installed via npm
//! to drive the existing chat features). This keeps the agent
//! resource footprint at 1.6 MB instead of 200+ MB.
//!
//! Everything else — JSON-RPC framing, session lifecycle, event
//! pumping into the sync `RunEvent` channel, kill signal — is
//! shared with the Codex variant in [`super::transport`].

use std::path::PathBuf;

use super::transport::{spawn_acp, AcpSpawnConfig};
use crate::runner::{RunHandle, RunRequest, Runner, RunnerError, RunnerKind};

/// Concrete [`Runner`] implementation. The three paths are resolved
/// by the Tauri shell at startup:
///
/// - [`node_bin`](Self::node_bin) — usually `/usr/bin/env node` or
///   a path discovered via `which`; users without a recent Node
///   installed get a clear `BinaryNotFound` at spawn time.
/// - [`wrapper_js`](Self::wrapper_js) — the absolute path to the
///   bundled `claude-agent-acp/dist/index.js` (vendored under
///   `apps/desktop/src-tauri/resources/acp/`).
/// - [`claude_bin`](Self::claude_bin) — the system `claude`
///   binary discovered via PATH (priming for macOS GUI launches
///   happens in `vault-workflow-ide`'s `prime_user_path`).
pub struct AcpClaudeRunner {
    pub node_bin: PathBuf,
    pub wrapper_js: PathBuf,
    pub claude_bin: PathBuf,
}

impl AcpClaudeRunner {
    pub fn new(node_bin: PathBuf, wrapper_js: PathBuf, claude_bin: PathBuf) -> Self {
        Self {
            node_bin,
            wrapper_js,
            claude_bin,
        }
    }
}

impl Runner for AcpClaudeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::ClaudeCode
    }

    fn start(&self, req: RunRequest) -> Result<RunHandle, RunnerError> {
        // Use lossy conversion for the env var value: a path with
        // invalid UTF-8 surrogates is exceptionally rare on macOS,
        // and the alternative (returning an error) would block
        // perfectly normal runs over a theoretical edge case. The
        // wrapper validates the path itself on first read and will
        // surface a clear error if the file actually doesn't exist.
        let config = AcpSpawnConfig {
            name: "claude-agent-acp".to_string(),
            command: self.node_bin.clone(),
            args: vec![self.wrapper_js.to_string_lossy().into_owned()],
            env: vec![(
                "CLAUDE_CODE_EXECUTABLE".to_string(),
                self.claude_bin.to_string_lossy().into_owned(),
            )],
        };
        spawn_acp(config, req)
    }
}
