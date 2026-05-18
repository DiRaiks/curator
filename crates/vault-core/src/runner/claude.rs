//! Claude Code CLI runner.
//!
//! Spawns `claude -p "<prompt>" --output-format stream-json --verbose` with
//! cwd set to the project's source repo. The vault root (and any other
//! extra dirs) are passed as `--add-dir` flags so the agent can read vault
//! notes alongside the code.
//!
//! ## Flags currently passed
//!
//! - `-p <prompt>` — one-shot non-interactive mode.
//! - `--output-format stream-json` — one JSON event per line, emitted live
//!   as the agent works (tool calls, assistant text, final result).
//!   `--output-format text` would only flush the final response on exit,
//!   killing the streaming UX.
//! - `--verbose` — required by `claude` when stream-json is set.
//! - `--add-dir <dir>` — one per `additional_dirs` entry.
//!
//! ## Deliberately NOT passed in slice 1
//!
//! - `--allowed-tools` / `--disallowed-tools`: the spawned `claude` uses
//!   the user's global `~/.claude/settings.json`. Tool whitelisting from
//!   `claude-agent.tools[]` frontmatter is a slice 2 task — when we add
//!   it, also add the "approve dangerous tools" dialog.
//! - `--model`: defaults to whatever the user's config picks.
//!
//! ## Threading model
//!
//! Each `start_with_command` spawns three OS threads:
//!
//! - **stdout reader** — owns the stdout `PipeReader`, never touches `Child`.
//!   Forwards lines as `Stdout` events. On pipe-read IO error, emits a
//!   synthetic `Stderr("reader error: …")` event so the consumer never
//!   sees silent truncation. Exits on EOF or sender disconnect.
//! - **stderr reader** — same, for stderr.
//! - **coordinator** — joins both reader handles (guaranteeing all
//!   in-flight output reaches the consumer before `Exit`), then polls
//!   `try_wait` until the child reaps, and finally emits `Exit`.
//!
//! The output cap is enforced via a single `Mutex<TruncationState>` shared
//! between the two readers — atomics alone leave a race window where two
//! `fetch_add` calls both succeed past the cap. The lock is held only
//! while accounting for one line, so contention is negligible at any
//! realistic output rate.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::{RunEvent, RunHandle, RunRequest, Runner, RunnerError, RunnerKind, MAX_OUTPUT_BYTES};

const CLAUDE_BIN: &str = "claude";
const WAITER_POLL_MS: u64 = 50;

pub struct ClaudeRunner;

impl ClaudeRunner {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ClaudeRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for ClaudeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::ClaudeCode
    }

    fn start(&self, req: RunRequest) -> Result<RunHandle, RunnerError> {
        spawn_with_command(CLAUDE_BIN, build_args(&req), req)
    }
}

fn build_args(req: &RunRequest) -> Vec<String> {
    let mut args: Vec<String> =
        Vec::with_capacity(6 + req.additional_dirs.len() * 2);
    args.push("-p".to_string());

    let mut prompt = req.prompt.clone();
    if let Some(extra) = req.runtime_input.as_ref().filter(|s| !s.trim().is_empty()) {
        prompt.push_str("\n\n## Additional input\n\n");
        prompt.push_str(extra);
        prompt.push('\n');
    }
    args.push(prompt);

    // stream-json + verbose is the only combination that actually streams.
    // Plain `text` mode buffers everything until exit (claude returns the
    // full response in one chunk), which makes the live RunPanel useless.
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    args.push("--verbose".to_string());

    for d in &req.additional_dirs {
        args.push("--add-dir".to_string());
        args.push(d.to_string_lossy().to_string());
    }
    args
}

/// Generic spawn entry point — `bin` is normally `"claude"` but tests pass
/// `"echo"` / a fixture binary to exercise the pipeline without needing the
/// real Claude CLI.
pub(crate) fn spawn_with_command(
    bin: &str,
    args: Vec<String>,
    req: RunRequest,
) -> Result<RunHandle, RunnerError> {
    let mut cmd = Command::new(bin);
    cmd.args(&args)
        .current_dir(&req.workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            RunnerError::BinaryNotFound(bin.to_string())
        } else {
            RunnerError::Spawn(e.to_string())
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RunnerError::Spawn("stdout pipe missing".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| RunnerError::Spawn("stderr pipe missing".into()))?;

    let child_arc: Arc<Mutex<Child>> = Arc::new(Mutex::new(child));
    let (tx, rx) = mpsc::channel::<RunEvent>();
    let trunc = Arc::new(Mutex::new(TruncationState::default()));

    let stdout_handle = spawn_reader(
        stdout,
        tx.clone(),
        Arc::clone(&trunc),
        ReaderKind::Stdout,
    );
    let stderr_handle = spawn_reader(
        stderr,
        tx.clone(),
        Arc::clone(&trunc),
        ReaderKind::Stderr,
    );

    spawn_coordinator(
        Arc::clone(&child_arc),
        stdout_handle,
        stderr_handle,
        tx,
    );

    let kill_arc = Arc::clone(&child_arc);
    let kill: Box<dyn FnOnce() + Send> = Box::new(move || {
        let mut guard = lock_recovering(&kill_arc);
        // Errors are usually ESRCH (already exited) — fine.
        let _ = guard.kill();
    });

    Ok(RunHandle::new(rx, kill))
}

// ---------- Truncation state ----------

#[derive(Default, Debug)]
struct TruncationState {
    bytes_emitted: usize,
    bytes_dropped: usize,
    truncated_emitted: bool,
}

enum AccountResult {
    Emit,
    FirstDrop { dropped_bytes: usize },
    SubsequentDrop,
}

impl TruncationState {
    fn account(&mut self, len: usize) -> AccountResult {
        if self.bytes_emitted.saturating_add(len) <= MAX_OUTPUT_BYTES {
            self.bytes_emitted += len;
            AccountResult::Emit
        } else {
            self.bytes_dropped = self.bytes_dropped.saturating_add(len);
            if !self.truncated_emitted {
                self.truncated_emitted = true;
                AccountResult::FirstDrop {
                    dropped_bytes: self.bytes_dropped,
                }
            } else {
                AccountResult::SubsequentDrop
            }
        }
    }
}

// ---------- Reader threads ----------

#[derive(Copy, Clone)]
enum ReaderKind {
    Stdout,
    Stderr,
}

fn spawn_reader<R: Read + Send + 'static>(
    src: R,
    tx: mpsc::Sender<RunEvent>,
    trunc: Arc<Mutex<TruncationState>>,
    kind: ReaderKind,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(src);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    // Surface the IO error instead of silently truncating.
                    // The synthetic Stderr event is intentionally NOT
                    // routed through truncation accounting — error
                    // signaling must always make it through to the
                    // consumer.
                    let _ = tx.send(RunEvent::Stderr(format!("reader error: {e}")));
                    break;
                }
            };
            // +1 for the trailing newline that BufRead::lines strips.
            let len = line.len() + 1;
            let outcome = {
                let mut state = lock_recovering(&trunc);
                state.account(len)
            };
            match outcome {
                AccountResult::Emit => {
                    let event = match kind {
                        ReaderKind::Stdout => RunEvent::Stdout(line),
                        ReaderKind::Stderr => RunEvent::Stderr(line),
                    };
                    if tx.send(event).is_err() {
                        // Receiver dropped — the consumer no longer cares.
                        break;
                    }
                }
                AccountResult::FirstDrop { dropped_bytes } => {
                    let _ = tx.send(RunEvent::Truncated { dropped_bytes });
                    // Keep reading to drain the pipe so the child doesn't
                    // block on write.
                }
                AccountResult::SubsequentDrop => {
                    // Keep reading silently — one Truncated event is
                    // enough; the total dropped count lives in
                    // TruncationState if a future event ever needs it.
                }
            }
        }
    })
}

// ---------- Coordinator thread ----------

/// Joins both reader threads (guaranteeing all output is flushed),
/// then polls `try_wait` until the child reaps and emits `Exit`. This
/// ordering is what makes "you see every Stdout/Stderr line before the
/// terminal Exit" a hard guarantee rather than a hope.
fn spawn_coordinator(
    child_arc: Arc<Mutex<Child>>,
    stdout_handle: JoinHandle<()>,
    stderr_handle: JoinHandle<()>,
    tx: mpsc::Sender<RunEvent>,
) {
    thread::spawn(move || {
        // Wait for readers to drain. They exit on pipe EOF, which happens
        // when the child closes its stdout/stderr handles — typically at
        // process exit. A thread panic inside a reader is unusual but
        // recoverable here: we don't care about the panic payload, only
        // that the thread is done.
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // Now collect the exit status. Poll `try_wait` so we never hold
        // the mutex while blocking — otherwise the kill closure (which
        // also locks `child_arc`) would deadlock.
        loop {
            let status = {
                let mut guard = lock_recovering(&child_arc);
                guard.try_wait()
            };
            match status {
                Ok(Some(s)) => {
                    let _ = tx.send(RunEvent::Exit {
                        code: s.code(),
                        success: s.success(),
                    });
                    return;
                }
                Ok(None) => thread::sleep(Duration::from_millis(WAITER_POLL_MS)),
                Err(_) => {
                    // try_wait itself failed (rare OS-level issue). Emit a
                    // synthetic non-success Exit so the consumer's state
                    // machine still progresses.
                    let _ = tx.send(RunEvent::Exit {
                        code: None,
                        success: false,
                    });
                    return;
                }
            }
        }
    });
}

// ---------- Mutex helper ----------

/// Lock a mutex, recovering from poisoning. Poisoning happens when another
/// thread panicked while holding the lock; the inner data is almost always
/// still well-formed, and silently propagating the poison error here would
/// leave the run stuck (waiter returns without Exit → UI hangs forever).
fn lock_recovering<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Empty `RunRequest` skeleton — workdir set to `/tmp` which exists on
    /// every unix system. Tests fill in the body manually.
    fn req() -> RunRequest {
        RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: String::new(),
            runtime_input: None,
        }
    }

    fn collect_until_exit(
        mut handle: RunHandle,
        timeout: Duration,
    ) -> (Vec<RunEvent>, Option<RunEvent>) {
        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        let mut exit = None;
        while Instant::now() < deadline {
            match handle.recv_timeout(Duration::from_millis(200)) {
                Ok(ev) => {
                    let is_exit = matches!(ev, RunEvent::Exit { .. });
                    if is_exit {
                        exit = Some(ev);
                        break;
                    }
                    events.push(ev);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if exit.is_none() {
            handle.stop();
        }
        (events, exit)
    }

    #[test]
    fn echo_streams_stdout_and_exits_zero() {
        let handle = spawn_with_command(
            "echo",
            vec!["hello-from-runner".to_string()],
            req(),
        )
        .expect("spawn echo");
        let (events, exit) = collect_until_exit(handle, Duration::from_secs(5));
        let stdout: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::Stdout(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            stdout.iter().any(|l| l.contains("hello-from-runner")),
            "stdout was: {:?}",
            stdout
        );
        match exit {
            Some(RunEvent::Exit {
                code: Some(0),
                success: true,
            }) => {}
            other => panic!("expected Exit{{success:true}}, got {:?}", other),
        }
    }

    #[test]
    fn output_arrives_before_exit() {
        // Regression guard for the "Exit emitted before reader flush"
        // class of bugs. After the coordinator-joins-readers refactor,
        // every Stdout line must arrive strictly before Exit.
        let handle = spawn_with_command(
            "sh",
            vec![
                "-c".into(),
                "for i in 1 2 3 4 5 6 7 8; do echo line-$i; done".into(),
            ],
            req(),
        )
        .expect("spawn sh");

        let mut saw_lines: Vec<String> = Vec::new();
        let mut saw_exit_after_lines = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match handle.recv_timeout(Duration::from_millis(200)) {
                Ok(RunEvent::Stdout(l)) => saw_lines.push(l),
                Ok(RunEvent::Exit { .. }) => {
                    // Must have seen all 8 lines by the time Exit arrives.
                    saw_exit_after_lines = saw_lines.len() == 8;
                    break;
                }
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(
            saw_exit_after_lines,
            "Exit arrived with only {} of 8 lines seen: {:?}",
            saw_lines.len(),
            saw_lines
        );
    }

    #[test]
    fn non_zero_exit_code_propagates() {
        let handle = spawn_with_command(
            "sh",
            vec!["-c".into(), "exit 3".into()],
            req(),
        )
        .expect("spawn sh");
        let (_, exit) = collect_until_exit(handle, Duration::from_secs(5));
        match exit {
            Some(RunEvent::Exit {
                code: Some(3),
                success: false,
            }) => {}
            other => panic!("expected Exit{{code:3,success:false}}, got {:?}", other),
        }
    }

    #[test]
    fn stop_terminates_long_running_subprocess() {
        let mut handle = spawn_with_command(
            "sleep",
            vec!["60".into()],
            req(),
        )
        .expect("spawn sleep");
        // Give the child a moment to actually be running.
        thread::sleep(Duration::from_millis(100));
        handle.stop();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got_exit = false;
        while Instant::now() < deadline {
            match handle.recv_timeout(Duration::from_millis(200)) {
                Ok(RunEvent::Exit { .. }) => {
                    got_exit = true;
                    break;
                }
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(got_exit, "stop() did not produce an Exit event in 5s");
    }

    #[test]
    fn missing_binary_is_a_typed_error() {
        let result = spawn_with_command(
            "this-binary-definitely-does-not-exist-xyz",
            vec![],
            req(),
        );
        match result {
            Err(RunnerError::BinaryNotFound(_)) => {}
            Err(other) => panic!("expected BinaryNotFound, got {:?}", other),
            Ok(_) => panic!("expected spawn to fail"),
        }
    }

    #[test]
    fn truncated_event_fires_when_output_exceeds_cap() {
        // `yes` outputs "y\n" forever. The reader will hit MAX_OUTPUT_BYTES
        // (4 MiB) within a fraction of a second and emit Truncated once.
        let mut handle = spawn_with_command(
            "yes",
            vec![],
            req(),
        )
        .expect("spawn yes");

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got_truncated = false;
        let mut dropped_so_far = 0usize;
        while Instant::now() < deadline {
            match handle.recv_timeout(Duration::from_millis(200)) {
                Ok(RunEvent::Truncated { dropped_bytes }) => {
                    got_truncated = true;
                    dropped_so_far = dropped_bytes;
                    break;
                }
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        handle.stop();
        assert!(got_truncated, "Truncated event was not emitted in 10s");
        assert!(
            dropped_so_far > 0,
            "Truncated reported 0 dropped bytes; cap logic likely wrong"
        );
    }

    #[test]
    fn truncated_event_fires_at_most_once_under_contention() {
        // Two concurrent readers should not produce two Truncated events
        // for the same overflow event. `sh -c` emits some on stdout, some
        // on stderr concurrently — both readers race to update the cap.
        let mut handle = spawn_with_command(
            "sh",
            vec![
                "-c".into(),
                "yes >&1 & yes >&2 & wait".into(),
            ],
            req(),
        )
        .expect("spawn sh");

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut truncated_count = 0usize;
        while Instant::now() < deadline {
            match handle.recv_timeout(Duration::from_millis(100)) {
                Ok(RunEvent::Truncated { .. }) => {
                    truncated_count += 1;
                    // Wait a moment longer to see if a second one arrives.
                }
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if truncated_count >= 1 {
                        // Saw at least one — give the second reader a
                        // chance to (incorrectly) emit a duplicate.
                        thread::sleep(Duration::from_millis(500));
                        // Drain any pending events.
                        while let Ok(ev) =
                            handle.recv_timeout(Duration::from_millis(50))
                        {
                            if matches!(ev, RunEvent::Truncated { .. }) {
                                truncated_count += 1;
                            }
                        }
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        handle.stop();
        assert_eq!(
            truncated_count, 1,
            "expected exactly one Truncated event, got {truncated_count}"
        );
    }

    #[test]
    fn runtime_input_appended_to_prompt_section() {
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "base prompt".into(),
            runtime_input: Some("PR-42".into()),
        };
        let args = build_args(&req);
        // Position 0 is "-p", position 1 is the prompt.
        assert_eq!(args[0], "-p");
        let combined = &args[1];
        assert!(combined.contains("base prompt"));
        assert!(combined.contains("## Additional input"));
        assert!(combined.contains("PR-42"));
    }

    #[test]
    fn streaming_flags_are_set() {
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "p".into(),
            runtime_input: None,
        };
        let args = build_args(&req);
        // stream-json without --verbose is rejected by claude; we must
        // pass both. Guard against accidental regressions.
        assert!(args.iter().any(|a| a == "stream-json"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(!args.iter().any(|a| a == "text"));
    }

    #[test]
    fn additional_dirs_become_add_dir_flags() {
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: vec![
                std::path::PathBuf::from("/tmp/vault"),
                std::path::PathBuf::from("/tmp/notes"),
            ],
            prompt: "p".into(),
            runtime_input: None,
        };
        let args = build_args(&req);
        let pairs: Vec<(&str, &str)> = args
            .windows(2)
            .filter_map(|w| {
                if w[0] == "--add-dir" {
                    Some((w[0].as_str(), w[1].as_str()))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(pairs.len(), 2);
        assert!(pairs.iter().any(|(_, v)| *v == "/tmp/vault"));
        assert!(pairs.iter().any(|(_, v)| *v == "/tmp/notes"));
    }
}
