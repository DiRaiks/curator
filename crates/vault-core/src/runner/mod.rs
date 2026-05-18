//! External CLI runner abstraction.
//!
//! The IDE doesn't embed Claude / Codex / Zed Agent — it spawns the user's
//! own CLI as a subprocess with a generated prompt and forwards stdout /
//! stderr as a stream of [`RunEvent`]s. This crate stays Tauri-agnostic; the
//! Tauri shell wires the receiver to frontend events.
//!
//! Architecture (per active run):
//!
//! - One subprocess (`Child`) under `Arc<Mutex<Child>>` for safe shared
//!   access between the kill closure and the coordinator thread.
//! - Two reader threads — one each for stdout/stderr — that don't touch the
//!   `Child`, only the pipe handle taken via `Child::stdout.take()`.
//! - One coordinator thread that joins both reader threads (so all output is
//!   flushed before exit is reported), then polls `try_wait` until the
//!   child reaps. This ordering guarantees consumers see every
//!   `Stdout`/`Stderr` event before the terminal `Exit`.
//! - A `kill` closure that grabs the `Mutex` briefly and calls `Child::kill`.
//!
//! Output is capped at [`MAX_OUTPUT_BYTES`]. The cap is enforced by a single
//! `Mutex<TruncationState>` shared between both reader threads — atomics
//! alone leave a window where two `fetch_add`s race past the cap. Reader
//! threads keep draining the pipe past the cap (so the child doesn't block
//! on write) but stop emitting `Stdout` / `Stderr` events; one final
//! `Truncated` event tells the consumer how many bytes were dropped at the
//! moment the cap was first hit.
//!
//! ## Concurrency / soundness notes
//!
//! - `Child::try_wait` is non-blocking; the coordinator holds the mutex
//!   briefly per poll. The kill closure also grabs the mutex briefly. They
//!   serialize cleanly.
//! - Mutex poisoning is **recovered from** rather than collapsing the
//!   thread silently — see `with_lock_recovering` callsites in
//!   [`claude`]. A poisoned mutex usually means a panic happened while
//!   another thread held the lock; the contents are typically still
//!   well-formed, and silent return would leave the frontend stuck.
//! - Reader threads emit a synthetic `Stderr("reader error: …")` event
//!   before exiting on a pipe-read failure, so silent truncation in the UI
//!   is impossible.

use std::sync::mpsc;

use thiserror::Error;

mod claude;

pub use claude::ClaudeRunner;

/// Soft cap on total bytes emitted across stdout + stderr per run, before
/// further output is dropped (with one `Truncated` event).
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// Identifier for a runner backend. The MVP only ships `ClaudeCode`; this
/// enum exists so the Tauri shell can route by id and so future runners
/// (Codex, Zed Agent, Cursor Agent) plug into the same surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerKind {
    ClaudeCode,
}

impl RunnerKind {
    pub fn id(self) -> &'static str {
        match self {
            RunnerKind::ClaudeCode => "claude-code",
        }
    }
}

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("runner binary not found: {0}")]
    BinaryNotFound(String),
    #[error("failed to spawn subprocess: {0}")]
    Spawn(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// What to run and where. `additional_dirs` map to Claude's `--add-dir` flag
/// and equivalent on other runners — used to give the subprocess access to
/// the vault when its cwd is the project repo.
#[derive(Debug, Clone)]
pub struct RunRequest {
    pub workdir: std::path::PathBuf,
    pub additional_dirs: Vec<std::path::PathBuf>,
    pub prompt: String,
    /// Optional free-text the user types at run time (a PR number, a
    /// question, a CVE id). Appended to the prompt as an `## Additional
    /// input` section by the caller, not the runner — keep the runner
    /// dumb about prompt shape.
    pub runtime_input: Option<String>,
}

/// Streaming event from an active run. Consumers should treat unknown
/// variants conservatively if new ones are added later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    /// One line of stdout (newline stripped).
    Stdout(String),
    /// One line of stderr (newline stripped). Reader-side IO errors are
    /// surfaced here as `"reader error: <details>"` so the consumer
    /// always knows when output was cut short for non-process reasons.
    Stderr(String),
    /// Output cap exceeded; subsequent stdout/stderr is dropped. Emitted
    /// at most once per run.
    Truncated { dropped_bytes: usize },
    /// Subprocess exited. The final event of the stream; the channel
    /// becomes disconnected shortly after. By construction, every prior
    /// `Stdout` / `Stderr` line has been emitted before this — the
    /// coordinator joins both reader threads before sending `Exit`.
    Exit { code: Option<i32>, success: bool },
}

/// Handle to a live run. Owns both the event receiver and the kill switch
/// in a single struct so a single owner can manage both. Use
/// [`RunHandle::into_parts`] when the receiver and kill switch need to live
/// in different threads / storage slots (typical for the Tauri shell).
pub struct RunHandle {
    events: mpsc::Receiver<RunEvent>,
    kill: Option<Box<dyn FnOnce() + Send>>,
}

impl RunHandle {
    pub(crate) fn new(
        events: mpsc::Receiver<RunEvent>,
        kill: Box<dyn FnOnce() + Send>,
    ) -> Self {
        Self {
            events,
            kill: Some(kill),
        }
    }

    /// Receive the next event, blocking until one is available.
    pub fn recv(&self) -> Result<RunEvent, mpsc::RecvError> {
        self.events.recv()
    }

    /// Receive the next event, blocking up to `timeout`.
    pub fn recv_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<RunEvent, mpsc::RecvTimeoutError> {
        self.events.recv_timeout(timeout)
    }

    /// Signal the subprocess to terminate. Idempotent; safe to call after
    /// the child has already exited. Returns immediately — the eventual
    /// `Exit` event still flows through the channel.
    pub fn stop(&mut self) {
        if let Some(kill) = self.kill.take() {
            kill();
        }
    }

    /// Split the handle into its receiver and a one-shot kill switch.
    /// Lets the caller stash the killer in long-lived state while moving
    /// the receiver to a worker thread.
    ///
    /// Panics if called after [`Self::stop`] consumed the kill closure.
    /// Callers that may stop first should hold the handle whole.
    pub fn into_parts(self) -> (mpsc::Receiver<RunEvent>, Killer) {
        let RunHandle { events, kill } = self;
        let kill = kill.expect(
            "RunHandle::into_parts called after stop(); use the handle directly instead",
        );
        (events, Killer { inner: Some(kill) })
    }
}

/// One-shot kill switch for a [`RunHandle`] whose receiver lives elsewhere.
/// Calling [`Killer::kill`] consumes the switch and signals the subprocess
/// to terminate. Subsequent calls on a separately-held `Option<Killer>`
/// would naturally no-op once the slot is empty.
pub struct Killer {
    inner: Option<Box<dyn FnOnce() + Send>>,
}

impl Killer {
    pub fn kill(mut self) {
        if let Some(kill) = self.inner.take() {
            kill();
        }
    }
}

/// External CLI runner. Implementations are responsible for spawning the
/// subprocess, plumbing pipes, and emitting [`RunEvent`]s into the
/// receiver returned in [`RunHandle`].
pub trait Runner: Send + Sync {
    fn kind(&self) -> RunnerKind;
    fn start(&self, req: RunRequest) -> Result<RunHandle, RunnerError>;
}

// ---------- Workdir policy ----------

/// Reject directories known to leak sensitive data when used as the cwd of
/// an AI agent. Allowlist would be ideal but for a dev tool that runs
/// projects from arbitrary user paths a blacklist is what users actually
/// ship.
///
/// The caller must canonicalize `p` first — this is enforced by the API
/// shape ([`validate_workdir`]).
pub fn is_safe_workdir(p: &std::path::Path) -> bool {
    // Reject the filesystem root and immediate children of `/Volumes`
    // (mount points themselves). `parent()` on `/` returns None.
    match p.parent() {
        None => return false,
        Some(parent) if parent.as_os_str().is_empty() => return false,
        _ => {}
    }

    let s = p.to_string_lossy();

    // System directories the user has no reason to spawn an agent into.
    // Listing both the bare and `/private/...` macOS-canonical forms so a
    // post-canonicalize path can't sneak past via the symlinked alias.
    let forbidden_system_prefixes: &[&str] = &[
        "/etc/",
        "/private/etc/",
        "/usr/",
        "/private/usr/",
        "/bin/",
        "/sbin/",
        "/var/db/",
        "/private/var/db/",
        "/var/root/",
        "/private/var/root/",
        "/Library/",
        "/System/",
        "/Applications/",
        "/boot/",
        "/root/",
    ];
    for prefix in forbidden_system_prefixes {
        if s.starts_with(prefix) || s == prefix.trim_end_matches('/') {
            return false;
        }
    }

    // Sensitive home subdirectories.
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::PathBuf::from(home);
        let canonical_home = home.canonicalize().unwrap_or(home);
        let sensitive_subdirs = [
            ".ssh",
            ".aws",
            ".gnupg",
            ".kube",
            ".docker",
            ".cargo/credentials",
            ".npmrc",
            ".pypirc",
            ".password-store",
            ".config/gh",
        ];
        for sub in &sensitive_subdirs {
            let bad = canonical_home.join(sub);
            if p == bad || p.starts_with(&bad) {
                return false;
            }
        }
    }

    true
}

/// Canonicalize `p` and check it against [`is_safe_workdir`]. Returns the
/// canonical form on success — callers should pass that to
/// `Command::current_dir`, not the original input, so symlink-based escapes
/// are closed.
pub fn validate_workdir(
    p: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("workdir not accessible: {}: {e}", p.display()))?;
    if !is_safe_workdir(&canonical) {
        return Err(format!(
            "workdir `{}` is in a forbidden location (system / sensitive)",
            canonical.display()
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn safe_workdir_accepts_user_paths() {
        // User home itself is fine (we only block specific subdirs).
        if let Ok(home) = std::env::var("HOME") {
            assert!(is_safe_workdir(&PathBuf::from(&home)));
        }
        // /tmp is fine — actively used for test fixtures.
        let tmp = std::env::temp_dir().canonicalize().unwrap_or_default();
        assert!(is_safe_workdir(&tmp));
    }

    #[test]
    fn safe_workdir_rejects_root_and_system() {
        assert!(!is_safe_workdir(&PathBuf::from("/")));
        assert!(!is_safe_workdir(&PathBuf::from("/etc")));
        assert!(!is_safe_workdir(&PathBuf::from("/etc/")));
        assert!(!is_safe_workdir(&PathBuf::from("/etc/hosts")));
        assert!(!is_safe_workdir(&PathBuf::from("/usr/local/bin")));
        assert!(!is_safe_workdir(&PathBuf::from("/private/etc/passwd")));
        assert!(!is_safe_workdir(&PathBuf::from("/System/Library")));
    }

    #[test]
    fn safe_workdir_rejects_sensitive_home_subdirs() {
        if let Ok(home) = std::env::var("HOME") {
            let home_path = PathBuf::from(&home);
            assert!(!is_safe_workdir(&home_path.join(".ssh")));
            assert!(!is_safe_workdir(&home_path.join(".ssh/id_rsa")));
            assert!(!is_safe_workdir(&home_path.join(".aws")));
            assert!(!is_safe_workdir(&home_path.join(".gnupg")));
        }
    }
}
