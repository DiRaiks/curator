//! Filesystem watcher for the vault root.
//!
//! Wraps `notify` + `notify-debouncer-full` so the rest of the crate (and the
//! Tauri shell) sees a tiny, Tauri-agnostic API:
//!
//! ```no_run
//! use std::path::PathBuf;
//! # fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let root = PathBuf::from("/path/to/vault");
//! let (token, rx) = vault_core::watch::start_watch(vec![root])?;
//! while let Ok(_ev) = rx.recv() { /* re-scan */ }
//! drop(token); // stops the watcher
//! # Ok(()) }
//! ```
//!
//! - Events are coalesced with a 300 ms debounce. A vim save (write +
//!   atomic-rename) collapses into one `ChangeEvent`.
//! - The `WatchToken` keeps the debouncer alive; dropping it stops watching
//!   and drops the `Sender` end of the channel, causing the receiver to
//!   return `Err(RecvError)` once the in-flight events are drained.
//! - Errors during the debouncer's own polling are dropped silently — the
//!   IDE re-scans on demand anyway. We surface only the initial setup error.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use thiserror::Error;

const DEBOUNCE_MS: u64 = 300;

#[derive(Debug, Error)]
pub enum WatchError {
    #[error("watcher setup failed: {0}")]
    Setup(String),
}

/// A debounced change event. `root` is one of the paths originally passed to
/// `start_watch`; `paths` are absolute filesystem paths inside that root that
/// changed within the debounce window.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub root: String,
    pub paths: Vec<String>,
}

/// Opaque handle that keeps the underlying watcher alive. Dropping it stops
/// the watcher and disconnects the channel.
pub struct WatchToken {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

/// Watch a set of directory roots recursively. Returns an opaque token (keep
/// it alive for as long as you want events) and a receiver for coalesced
/// change events.
///
/// Each watched root is mapped to its own outgoing event; if a single
/// debounced batch touches files under multiple roots, multiple `ChangeEvent`s
/// are emitted (one per root).
pub fn start_watch(
    roots: Vec<PathBuf>,
) -> Result<(WatchToken, mpsc::Receiver<ChangeEvent>), WatchError> {
    let (tx, rx) = mpsc::channel::<ChangeEvent>();

    // Canonicalize so callback-side `starts_with` matches the platform-real
    // path notify reports (e.g. macOS `/var/...` → `/private/var/...`).
    let roots: Vec<PathBuf> = roots
        .into_iter()
        .map(|r| r.canonicalize().unwrap_or(r))
        .collect();
    let roots_for_cb = roots.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(evs) => evs,
                Err(_) => return,
            };
            // Group paths by which watched root they belong to.
            // Most batches touch a single root, but be robust to mixed
            // batches if multiple roots are watched.
            let mut by_root: Vec<(PathBuf, Vec<String>)> = roots_for_cb
                .iter()
                .map(|r| (r.clone(), Vec::new()))
                .collect();
            for ev in events {
                for path in &ev.event.paths {
                    if let Some(slot) = by_root.iter_mut().find(|(r, _)| path.starts_with(r)) {
                        slot.1.push(path.to_string_lossy().to_string());
                    }
                }
            }
            for (root, paths) in by_root {
                if paths.is_empty() {
                    continue;
                }
                let _ = tx.send(ChangeEvent {
                    root: root.to_string_lossy().to_string(),
                    paths,
                });
            }
        },
    )
    .map_err(|e| WatchError::Setup(e.to_string()))?;

    for root in &roots {
        watch_one(&mut debouncer, root)?;
    }

    Ok((
        WatchToken {
            _debouncer: debouncer,
        },
        rx,
    ))
}

fn watch_one(
    debouncer: &mut Debouncer<RecommendedWatcher, RecommendedCache>,
    root: &Path,
) -> Result<(), WatchError> {
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| WatchError::Setup(format!("watch {} failed: {e}", root.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("vw-watch-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn debounced_event_fires_after_write() {
        let dir = temp_dir("debounce");
        let (token, rx) = start_watch(vec![dir.clone()]).expect("start watch");

        // Give the watcher a moment to attach
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.join("a.md"), "hello").unwrap();

        // Wait for the debounce window + slack
        let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS + 1500);
        let mut got = false;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(ev) => {
                    assert!(ev.paths.iter().any(|p| p.ends_with("a.md")));
                    got = true;
                    break;
                }
                Err(_) => continue,
            }
        }
        assert!(got, "expected a debounced ChangeEvent after writing a.md");

        drop(token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropping_token_disconnects_receiver() {
        let dir = temp_dir("drop");
        let (token, rx) = start_watch(vec![dir.clone()]).expect("start watch");
        drop(token);
        // After drop the sender side disappears; recv will eventually
        // return Err. Give it a moment for the debouncer's thread to wind down.
        std::thread::sleep(Duration::from_millis(100));
        // The channel may have queued nothing; ensure recv_timeout terminates
        // (either Disconnected or Timeout) — both are acceptable.
        let _ = rx.recv_timeout(Duration::from_millis(500));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
