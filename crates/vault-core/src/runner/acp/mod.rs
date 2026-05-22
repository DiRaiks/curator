//! ACP-based runners.
//!
//! The Agent Client Protocol (ACP) is an open JSON-RPC stdio protocol
//! that abstracts over coding agents (Claude Code, Codex, Gemini, …).
//! Picking ACP as the transport gives us, for free:
//!
//! - **Interactive permission requests** (`session/request_permission`)
//!   — what our `PermissionRequestCard` is wired for. The earlier
//!   `claude -p` subprocess approach silently rejected Bash because
//!   no SDK control protocol was active; ACP fires real
//!   permission-request RPCs.
//! - **Structured streaming events** (`session/update`) — agent text,
//!   tool calls, plans, mode changes, all typed.
//! - **Single transport for both runners** — same event-rendering
//!   path on the frontend regardless of whether the underlying CLI
//!   is Claude or Codex.
//!
//! ## Module layout
//!
//! - [`transport`] — generic async runtime that spawns an ACP
//!   subprocess and bridges its events into our sync `RunHandle`
//!   channels. Used by both Claude and Codex runner impls.
//! - [`claude`] — `AcpClaudeRunner`: launches the vendored
//!   `claude-agent-acp` JS wrapper with `CLAUDE_CODE_EXECUTABLE`
//!   pointing at the system `claude` binary.
//! - [`codex`] — `AcpCodexRunner`: launches the vendored `codex-acp`
//!   native binary (172 MB sidecar, fetched via
//!   `scripts/fetch-acp-binaries.sh`).
//!
//! ## Why a tokio runtime inside a thread
//!
//! `agent-client-protocol` is built on tokio; our `Runner::start` is
//! a sync API returning a `RunHandle` with a `std::sync::mpsc`
//! receiver. The bridge is: `start` spawns a dedicated OS thread,
//! the thread owns a tokio runtime, the runtime drives the ACP
//! client, and a small pump task forwards ACP notifications into
//! the sync mpsc consumed by the Tauri shell.
//!
//! This keeps tokio confined to the runner subsystem — the rest of
//! `vault-core` stays sync, and the Tauri shell continues to receive
//! `RunEvent`s the same way it always did. No frontend or shell
//! changes are required to switch runner implementations.

pub(crate) mod transport;

mod claude;
mod codex;

pub use claude::AcpClaudeRunner;
pub use codex::AcpCodexRunner;
