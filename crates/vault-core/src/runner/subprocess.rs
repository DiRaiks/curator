//! Generic subprocess machinery shared between agent runners.
//!
//! Each runner (Claude, Codex, future variants) spawns a CLI subprocess
//! with piped stdio, reads stdout + stderr concurrently, emits typed
//! [`RunEvent`]s, enforces the global output cap, and tears down cleanly
//! on kill or natural exit. All of that is identical across runners —
//! the parts that differ are:
//!
//! - The flags passed on the command line (runner-specific).
//! - Whatever lines (if any) get written to stdin at startup or in
//!   response to specific stdout events (Claude's SDK control protocol
//!   uses this; Codex doesn't).
//! - How each stdout line classifies into `RunEvent::Stdout` /
//!   `RunEvent::PermissionRequest` / silently swallowed / end-of-turn
//!   handshake (Claude has rich stream-json; Codex emits its own JSONL
//!   shape; future runners may emit plain text).
//!
//! This module owns the shared machinery and exposes a
//! [`spawn_subprocess`] entry point that callers parameterize via the
//! [`LineClassifier`] trait. Runner-specific files stay thin —
//! `claude.rs` is the trait impl + flag building + initial stdin
//! handshake; same for `codex.rs`.
//!
//! ## Threading model (per active run)
//!
//! - One subprocess (`Child`) under `Arc<Mutex<Child>>` for safe shared
//!   access between the kill closure and the coordinator thread.
//! - Two reader threads — one each for stdout/stderr — that don't touch
//!   the `Child`, only the pipe handle taken via `Child::stdout.take()`.
//! - One coordinator thread that joins both reader threads (so all
//!   output is flushed before exit is reported), then polls `try_wait`
//!   until the child reaps. This ordering guarantees consumers see
//!   every `Stdout`/`Stderr` event before the terminal `Exit`.
//! - A `kill` closure that grabs the `Mutex` briefly and calls
//!   `Child::kill`.
//! - A stdin writer thread that owns `ChildStdin` and serializes
//!   line-by-line writes from a channel. Lets multiple producers
//!   (initial handshake, end-of-turn signal, host-side permission
//!   responses) share one writer without contending for the pipe.
//!
//! Output is capped at [`MAX_OUTPUT_BYTES`]. The cap is enforced by a
//! single `Mutex<TruncationState>` shared between both reader threads —
//! atomics alone leave a window where two `fetch_add`s race past the
//! cap. Reader threads keep draining the pipe past the cap (so the
//! child doesn't block on write) but stop emitting `Stdout` / `Stderr`
//! events; one final `Truncated` event tells the consumer how many
//! bytes were dropped at the moment the cap was first hit.
//!
//! ## Concurrency / soundness notes
//!
//! - `Child::try_wait` is non-blocking; the coordinator holds the mutex
//!   briefly per poll. The kill closure also grabs the mutex briefly.
//!   They serialize cleanly.
//! - Mutex poisoning is **recovered from** rather than collapsing the
//!   thread silently. A poisoned mutex usually means a panic happened
//!   while another thread held the lock; the contents are typically
//!   still well-formed, and silent return would leave the frontend
//!   stuck.
//! - Reader threads emit a synthetic `Stderr("reader error: …")` event
//!   before exiting on a pipe-read failure, so silent truncation in
//!   the UI is impossible.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::{RunEvent, RunHandle, RunRequest, RunnerError, MAX_OUTPUT_BYTES};

const WAITER_POLL_MS: u64 = 50;

/// What to do with a single classified stdout line. Yielded by
/// [`LineClassifier::classify_stdout`] and consumed by the stdout reader.
///
/// `event` — what (if anything) to forward to the consumer. `None` is
/// used to silently swallow control-protocol acks that would otherwise
/// pollute the chat log.
///
/// `end_of_turn` — flips true on the runner's "this turn is done"
/// marker (Claude's `result` event, Codex's `turn.completed`). When
/// set, the stdout reader invokes
/// [`LineClassifier::on_end_of_turn_line`] so the runner can write a
/// shutdown handshake to stdin. Set at most once per run by callers
/// that need a handshake; runners that exit naturally on EOF leave it
/// false everywhere.
pub(crate) struct LineHandled {
    pub event: Option<RunEvent>,
    pub end_of_turn: bool,
}

/// Runner-specific behaviour plugged into [`spawn_subprocess`].
///
/// Implementors decide how each stdout line maps to a [`RunEvent`] and
/// optionally how to react when a line signals end-of-turn (e.g. Claude
/// sends an `end_session` control_request so its subprocess unblocks).
///
/// Stderr lines bypass the classifier and surface directly as
/// `RunEvent::Stderr` — runners don't need to inspect them today, and
/// adding a hook would just be dead code.
pub(crate) trait LineClassifier: Send + Sync + 'static {
    /// Convert one decoded stdout line into a `LineHandled` outcome.
    fn classify_stdout(&self, line: String) -> LineHandled;

    /// Called once per run when the first end-of-turn line is seen.
    /// Implementors return the line(s) to write to stdin so the
    /// subprocess shuts down cleanly. Empty vec = "nothing to do; the
    /// subprocess exits on its own once stdin closes or EOF is hit."
    fn on_end_of_turn_line(&self) -> Vec<String> {
        Vec::new()
    }

    /// Whether the runner writes to subprocess stdin during its
    /// lifetime. Claude needs it for the SDK control protocol
    /// (initialize handshake, end_session, permission responses).
    /// Codex reads the prompt from a positional arg — for it stdin
    /// should be closed at spawn time so the CLI's "Reading
    /// additional input from stdin..." path sees EOF immediately
    /// instead of blocking forever on a pipe we'd never write to.
    fn needs_stdin(&self) -> bool {
        true
    }
}

/// Spawn the configured subprocess and wire it up to the shared event
/// pipeline. Returns a [`RunHandle`] streaming `RunEvent`s as the
/// child produces output.
///
/// `bin` is the executable to run (resolved via `PATH` unless absolute).
/// `args` are passed verbatim — never join into a shell string.
/// `initial_stdin_lines` are written to the child's stdin immediately
/// after spawn, before stdout starts being read; pass an empty vec for
/// runners that don't speak a startup protocol.
pub(crate) fn spawn_subprocess<C: LineClassifier>(
    bin: &str,
    args: Vec<String>,
    req: RunRequest,
    initial_stdin_lines: Vec<String>,
    classifier: C,
) -> Result<RunHandle, RunnerError> {
    // Stdin handling differs per runner — see `LineClassifier::needs_stdin`.
    // When a runner doesn't write to stdin (Codex), point stdin at
    // /dev/null so the child sees EOF immediately. Leaving stdin piped
    // and never writing to it deadlocks runners that block on a stdin
    // read (Codex's "Reading additional input from stdin..." path
    // waits for EOF before proceeding — without it the chat hangs
    // before the first turn ever streams).
    let needs_stdin = classifier.needs_stdin();
    let mut cmd = Command::new(bin);
    cmd.args(&args)
        .current_dir(&req.workdir)
        .stdin(if needs_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // initial_stdin_lines on a no-stdin runner is a wiring bug —
    // there's no writer to receive them. Reject loudly rather than
    // silently dropping the lines, which would mask a future
    // misconfiguration.
    if !needs_stdin && !initial_stdin_lines.is_empty() {
        return Err(RunnerError::Spawn(
            "runner declared needs_stdin=false but supplied initial stdin lines".into(),
        ));
    }

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

    // Spawn the stdin writer only when the runner needs it. Writers
    // are claude-style state — the writer thread owns ChildStdin and
    // exits when the channel closes. Codex skips the whole pipeline.
    let stdin_tx: Option<mpsc::Sender<String>> = if needs_stdin {
        let stdin = {
            let mut guard = lock_recovering(&child_arc);
            guard
                .stdin
                .take()
                .ok_or_else(|| RunnerError::Spawn("stdin pipe missing".into()))?
        };
        let (tx, handle) = spawn_stdin_writer(stdin);
        for line in initial_stdin_lines {
            // Errors here mean the writer thread already died; the
            // run will fail loudly via reader/coordinator events
            // shortly after.
            let _ = tx.send(line);
        }
        // The writer handle is intentionally orphaned — it exits
        // naturally when the channel closes or when ChildStdin write
        // fails (child exited). The coordinator doesn't need to join
        // it because the child wait already accounts for input pipe
        // closure.
        drop(handle);
        Some(tx)
    } else {
        None
    };

    let classifier_arc: Arc<C> = Arc::new(classifier);

    let stdout_handle = spawn_reader(
        stdout,
        tx.clone(),
        Arc::clone(&trunc),
        ReaderKind::Stdout,
        // Stdout reader needs its own clone of the stdin tx so it can
        // queue an end-of-turn shutdown handshake (if the runner needs
        // one). The writer thread serializes the shutdown line behind
        // any in-flight permission responses. `None` for runners
        // without a stdin pipe — `on_end_of_turn_line` is a no-op
        // there anyway.
        stdin_tx.clone(),
        Some(Arc::clone(&classifier_arc)),
    );
    let stderr_handle = spawn_reader::<_, C>(
        stderr,
        tx.clone(),
        Arc::clone(&trunc),
        ReaderKind::Stderr,
        None,
        None,
    );

    spawn_coordinator(Arc::clone(&child_arc), stdout_handle, stderr_handle, tx);

    let kill_arc = Arc::clone(&child_arc);
    let kill: Box<dyn FnOnce() + Send> = Box::new(move || {
        let mut guard = lock_recovering(&kill_arc);
        // Errors are usually ESRCH (already exited) — fine.
        let _ = guard.kill();
    });

    Ok(RunHandle::new(rx, kill, stdin_tx))
}

/// Owns the child's stdin handle and writes one line per message
/// received on the channel. Each message gets a trailing `\n` (so
/// callers pass single-line JSON without the newline). Exits when the
/// channel closes (Sender dropped) or a write fails — both signal
/// that the subprocess has gone away or the host is done writing.
fn spawn_stdin_writer(mut stdin: ChildStdin) -> (mpsc::Sender<String>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<String>();
    let handle = thread::spawn(move || {
        while let Ok(line) = rx.recv() {
            if stdin.write_all(line.as_bytes()).is_err() {
                break;
            }
            if stdin.write_all(b"\n").is_err() {
                break;
            }
            if stdin.flush().is_err() {
                break;
            }
        }
        // stdin drops here, closing the pipe — subprocess sees EOF and
        // stops waiting for more user turns. The coordinator's wait()
        // will unblock naturally.
    });
    (tx, handle)
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

/// Spawn one reader thread.
///
/// `stdin_tx` + `classifier` are `Some` for the stdout reader so it
/// can classify lines + queue end-of-turn handshake writes; both are
/// `None` for the stderr reader (which just forwards verbatim) and
/// for fixtures that don't speak any runner protocol.
fn spawn_reader<R: Read + Send + 'static, C: LineClassifier>(
    src: R,
    tx: mpsc::Sender<RunEvent>,
    trunc: Arc<Mutex<TruncationState>>,
    kind: ReaderKind,
    stdin_tx: Option<mpsc::Sender<String>>,
    classifier: Option<Arc<C>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        // Send end-of-turn handshake at most once per run. Defensive —
        // most runners emit exactly one end-of-turn marker per turn,
        // but a stray duplicate from a buggy version shouldn't
        // double-queue the shutdown signal.
        let mut end_of_turn_sent = false;
        let reader = BufReader::new(src);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    // Surface the IO error instead of silently
                    // truncating. The synthetic Stderr event is
                    // intentionally NOT routed through truncation
                    // accounting — error signaling must always make it
                    // through to the consumer.
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
                    let handled = match kind {
                        ReaderKind::Stdout => match classifier.as_ref() {
                            Some(c) => c.classify_stdout(line),
                            None => LineHandled {
                                event: Some(RunEvent::Stdout(line)),
                                end_of_turn: false,
                            },
                        },
                        ReaderKind::Stderr => LineHandled {
                            event: Some(RunEvent::Stderr(line)),
                            end_of_turn: false,
                        },
                    };
                    if let Some(event) = handled.event {
                        if tx.send(event).is_err() {
                            // Receiver dropped — the consumer no longer cares.
                            break;
                        }
                    }
                    if handled.end_of_turn && !end_of_turn_sent {
                        if let (Some(stdin_tx), Some(c)) =
                            (stdin_tx.as_ref(), classifier.as_ref())
                        {
                            for shutdown_line in c.on_end_of_turn_line() {
                                // Fire-and-forget: if the writer
                                // thread is already gone (subprocess
                                // crashed), the coordinator will
                                // surface that via Exit.
                                let _ = stdin_tx.send(shutdown_line);
                            }
                        }
                        end_of_turn_sent = true;
                    }
                }
                AccountResult::FirstDrop { dropped_bytes } => {
                    let _ = tx.send(RunEvent::Truncated { dropped_bytes });
                    // Keep reading to drain the pipe so the child
                    // doesn't block on write.
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
        // Wait for readers to drain. They exit on pipe EOF, which
        // happens when the child closes its stdout/stderr handles —
        // typically at process exit. A thread panic inside a reader
        // is unusual but recoverable here: we don't care about the
        // panic payload, only that the thread is done.
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // Now collect the exit status. Poll `try_wait` so we never
        // hold the mutex while blocking — otherwise the kill closure
        // (which also locks `child_arc`) would deadlock.
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
                    // try_wait itself failed (rare OS-level issue).
                    // Emit a synthetic non-success Exit so the
                    // consumer's state machine still progresses.
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

/// Lock a mutex, recovering from poisoning. Poisoning happens when
/// another thread panicked while holding the lock; the inner data is
/// almost always still well-formed, and silently propagating the
/// poison error here would leave the run stuck (waiter returns without
/// Exit → UI hangs forever).
pub(crate) fn lock_recovering<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(all(test, unix))]
mod tests {
    //! Regression coverage for the generic subprocess machinery. Uses
    //! `echo` / `sh` / `sleep` / `yes` as stand-ins for a real runner
    //! so the tests don't depend on Claude or Codex being installed.

    use super::*;
    use std::time::Instant;

    /// Pass-through classifier — every stdout line surfaces as a
    /// `RunEvent::Stdout`, no end-of-turn signaling.
    struct PassthroughClassifier;
    impl LineClassifier for PassthroughClassifier {
        fn classify_stdout(&self, line: String) -> LineHandled {
            LineHandled {
                event: Some(RunEvent::Stdout(line)),
                end_of_turn: false,
            }
        }
    }

    /// Same as PassthroughClassifier but declares no need for stdin.
    /// Used by the no-stdin regression test below.
    struct NoStdinClassifier;
    impl LineClassifier for NoStdinClassifier {
        fn classify_stdout(&self, line: String) -> LineHandled {
            LineHandled {
                event: Some(RunEvent::Stdout(line)),
                end_of_turn: false,
            }
        }
        fn needs_stdin(&self) -> bool {
            false
        }
    }

    /// Empty `RunRequest` skeleton — workdir set to `/tmp` which exists
    /// on every unix system. Tests fill in the body manually.
    fn req() -> RunRequest {
        RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: String::new(),
            runtime_input: None,
            resume_session_id: None,
            model: None,
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
        let handle = spawn_subprocess(
            "echo",
            vec!["hello-from-runner".to_string()],
            req(),
            Vec::new(),
            PassthroughClassifier,
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
        // class of bugs. Every Stdout line must arrive strictly before
        // Exit because the coordinator joins both readers first.
        let handle = spawn_subprocess(
            "sh",
            vec![
                "-c".into(),
                "for i in 1 2 3 4 5 6 7 8; do echo line-$i; done".into(),
            ],
            req(),
            Vec::new(),
            PassthroughClassifier,
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
        let handle = spawn_subprocess(
            "sh",
            vec!["-c".into(), "exit 3".into()],
            req(),
            Vec::new(),
            PassthroughClassifier,
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
        let mut handle = spawn_subprocess(
            "sleep",
            vec!["60".into()],
            req(),
            Vec::new(),
            PassthroughClassifier,
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
        let result = spawn_subprocess(
            "this-binary-definitely-does-not-exist-xyz",
            vec![],
            req(),
            Vec::new(),
            PassthroughClassifier,
        );
        match result {
            Err(RunnerError::BinaryNotFound(_)) => {}
            Err(other) => panic!("expected BinaryNotFound, got {:?}", other),
            Ok(_) => panic!("expected spawn to fail"),
        }
    }

    #[test]
    fn truncated_event_fires_when_output_exceeds_cap() {
        // `yes` outputs "y\n" forever. The reader will hit
        // MAX_OUTPUT_BYTES (4 MiB) within a fraction of a second and
        // emit Truncated once.
        let mut handle = spawn_subprocess(
            "yes",
            vec![],
            req(),
            Vec::new(),
            PassthroughClassifier,
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
    fn no_stdin_runner_does_not_block_on_stdin_reading_subprocess() {
        // Regression: Codex `exec` reads stdin to EOF before
        // streaming its first event. Earlier the runner piped stdin
        // unconditionally and the writer thread held it open forever
        // (waiting on an empty channel) — the chat hung with a stuck
        // "Reading additional input from stdin..." banner. Marking
        // `needs_stdin = false` must close stdin at spawn so the
        // child sees EOF and proceeds.
        //
        // We fake the codex behaviour by running `cat`, which reads
        // stdin until EOF then exits. If stdin is /dev/null (as it
        // should be), cat exits immediately. If stdin is left piped,
        // cat blocks and we'll time out.
        let handle = spawn_subprocess(
            "cat",
            Vec::new(),
            req(),
            Vec::new(),
            NoStdinClassifier,
        )
        .expect("spawn cat");
        let (_, exit) = collect_until_exit(handle, Duration::from_secs(3));
        match exit {
            Some(RunEvent::Exit {
                code: Some(0),
                success: true,
            }) => {}
            other => panic!(
                "expected cat to exit cleanly with stdin closed, got {:?}",
                other
            ),
        }
    }

    #[test]
    fn initial_stdin_lines_with_no_stdin_classifier_errors() {
        // Wiring guard — passing initial_stdin_lines together with
        // a no-stdin classifier silently drops the lines, which
        // would mask the real bug (the runner expected stdin but
        // told the subprocess module otherwise). Reject loudly.
        let result = spawn_subprocess(
            "echo",
            vec!["hi".into()],
            req(),
            vec!["stray".into()],
            NoStdinClassifier,
        );
        match result {
            Ok(_) => panic!("spawn should refuse when initial lines + needs_stdin=false"),
            Err(RunnerError::Spawn(msg)) => {
                assert!(msg.contains("needs_stdin"), "got: {msg}");
            }
            Err(other) => panic!("expected Spawn error, got {:?}", other),
        }
    }

    #[test]
    fn truncated_event_fires_at_most_once_under_contention() {
        // Two concurrent readers should not produce two Truncated
        // events for the same overflow event. `sh -c` emits some on
        // stdout, some on stderr concurrently — both readers race to
        // update the cap.
        let mut handle = spawn_subprocess(
            "sh",
            vec!["-c".into(), "yes >&1 & yes >&2 & wait".into()],
            req(),
            Vec::new(),
            PassthroughClassifier,
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
                        // Saw at least one — give the second reader
                        // a chance to (incorrectly) emit a duplicate.
                        thread::sleep(Duration::from_millis(500));
                        // Drain any pending events.
                        while let Ok(ev) = handle.recv_timeout(Duration::from_millis(50)) {
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
}
