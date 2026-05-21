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
//! - `--permission-mode acceptEdits` — auto-approves file-edit tools
//!   (Write/Edit/MultiEdit/NotebookEdit) without prompting; the user
//!   already authorised the run by clicking Run, and the vault is
//!   git-tracked so review happens via `git diff`. Other tools (Bash,
//!   network, etc.) still follow the user's global Claude Code config.
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

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::{
    PermissionRequest, RunEvent, RunHandle, RunRequest, Runner, RunnerError, RunnerKind,
    MAX_OUTPUT_BYTES,
};

const CLAUDE_BIN: &str = "claude";
const WAITER_POLL_MS: u64 = 50;

/// Resolve which binary to spawn for the Claude runner. Honors `CLAUDE_BIN`
/// as an escape hatch for non-standard installs (corporate wrappers,
/// pinned versions, custom paths); falls back to the bare `claude` name
/// which is resolved via `PATH` by the OS at spawn time.
fn resolve_claude_bin() -> String {
    std::env::var("CLAUDE_BIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| CLAUDE_BIN.to_string())
}

/// Request id of the initialize control_request. Claude echoes this back
/// in a control_response; we silently swallow that ack so it doesn't show
/// up in the user-facing output stream.
const INIT_REQUEST_ID: &str = "vide-init-1";

/// Request id we attach to the `end_session` control_request sent after
/// the turn's `result` event. Claude echoes a control_response with this
/// same id which the reader also silently swallows.
const END_SESSION_REQUEST_ID: &str = "vide-end-1";

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
        let args = build_args(&req);
        let init_messages = build_stdin_messages(&req);
        let bin = resolve_claude_bin();
        spawn_with_command(&bin, args, req, init_messages)
    }
}

fn build_args(req: &RunRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(10 + req.additional_dirs.len() * 2);
    // -p (print/non-interactive) is still required even when input comes
    // via stream-json — without it claude would open a TUI and ignore the
    // streamed messages.
    args.push("-p".to_string());

    // Bidirectional stream-json. Input carries the initialize handshake +
    // user message + control_response replies; output carries assistant
    // events + control_request can_use_tool prompts.
    args.push("--input-format".to_string());
    args.push("stream-json".to_string());
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    args.push("--verbose".to_string());

    // Authorise file-edit tools so claude doesn't hang on a permission
    // prompt mid-run. The user clicked Run with intent and the vault is
    // git-tracked; review via `git diff`. Other tools (Bash, MCP,
    // network) still go through the SDK canUseTool path activated by our
    // `initialize` control_request — those surface as
    // `RunEvent::PermissionRequest`.
    args.push("--permission-mode".to_string());
    args.push("acceptEdits".to_string());

    // Disable AskUserQuestion. It's a built-in tool that opens an
    // interactive multi-choice prompt; in `-p --input-format stream-json`
    // mode without a host-side dialog handler, claude calls the tool
    // and gets an immediate `is_error` tool_result back ("Answer
    // questions?"), which surfaces as a confusing error line in our
    // chat output. With the tool removed from the toolset, claude
    // adapts by asking the user inline in plain chat text — which
    // routes naturally through our bottom-drawer reply flow.
    args.push("--disallowed-tools".to_string());
    args.push("AskUserQuestion".to_string());

    // Resume an existing conversation when the caller asked. Claude
    // keeps prior turns under the session id; the next user message
    // (sent via stdin) becomes the next turn.
    if let Some(id) = req
        .resume_session_id
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        args.push("--resume".to_string());
        args.push(id.clone());
    }

    for d in &req.additional_dirs {
        args.push("--add-dir".to_string());
        args.push(d.to_string_lossy().to_string());
    }
    args
}

/// JSON lines to write to claude's stdin immediately after spawn.
///
/// Order matters: the `initialize` control_request goes first so claude
/// registers us as an SDK host (enables the canUseTool path); the user
/// message follows as the first conversation turn. Both are single-line
/// JSON — newline is appended by the writer thread.
///
/// `runtime_input` is concatenated into the message content here (under
/// `## Additional input`) instead of into a CLI argument, since stream-
/// json input mode has no positional prompt slot.
fn build_stdin_messages(req: &RunRequest) -> Vec<String> {
    let mut content = req.prompt.clone();
    if let Some(extra) = req.runtime_input.as_ref().filter(|s| !s.trim().is_empty()) {
        content.push_str("\n\n## Additional input\n\n");
        content.push_str(extra);
        content.push('\n');
    }

    let init = serde_json::json!({
        "type": "control_request",
        "request_id": INIT_REQUEST_ID,
        "request": { "subtype": "initialize" }
    });
    let user = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    });

    vec![init.to_string(), user.to_string()]
}

/// Generic spawn entry point — `bin` is normally `"claude"` but tests pass
/// `"echo"` / a fixture binary to exercise the pipeline without needing the
/// real Claude CLI. `initial_stdin_lines` is written to the child's stdin
/// in order immediately after spawn; pass an empty vec for fixtures that
/// don't speak the stream-json input protocol.
pub(crate) fn spawn_with_command(
    bin: &str,
    args: Vec<String>,
    req: RunRequest,
    initial_stdin_lines: Vec<String>,
) -> Result<RunHandle, RunnerError> {
    let mut cmd = Command::new(bin);
    cmd.args(&args)
        .current_dir(&req.workdir)
        .stdin(Stdio::piped())
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
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| RunnerError::Spawn("stdin pipe missing".into()))?;

    let child_arc: Arc<Mutex<Child>> = Arc::new(Mutex::new(child));
    let (tx, rx) = mpsc::channel::<RunEvent>();
    let trunc = Arc::new(Mutex::new(TruncationState::default()));

    // Spawn the stdin writer first so the initial messages are queued
    // before claude starts reading. The writer holds the only owner of
    // ChildStdin; senders that bypass it (or a dropped sender) would
    // close the pipe and stall claude on its first stdin.read.
    let (stdin_tx, stdin_writer_handle) = spawn_stdin_writer(stdin);
    for line in initial_stdin_lines {
        // Errors here mean the writer thread already died; the run will
        // fail loudly via reader/coordinator events shortly after.
        let _ = stdin_tx.send(line);
    }
    // The writer handle is intentionally orphaned — it exits naturally
    // when the channel closes or when ChildStdin write fails (child
    // exited). The coordinator doesn't need to join it because the child
    // wait already accounts for input pipe closure.
    drop(stdin_writer_handle);

    let stdout_handle = spawn_reader(
        stdout,
        tx.clone(),
        Arc::clone(&trunc),
        ReaderKind::Stdout,
        // Hand the stdout reader its own clone of the stdin tx so it
        // can queue an end_session control_request after seeing the
        // turn's `result` event. The writer thread serializes the
        // shutdown line behind any in-flight permission responses.
        Some(stdin_tx.clone()),
    );
    let stderr_handle = spawn_reader(
        stderr,
        tx.clone(),
        Arc::clone(&trunc),
        ReaderKind::Stderr,
        None,
    );

    spawn_coordinator(Arc::clone(&child_arc), stdout_handle, stderr_handle, tx);

    let kill_arc = Arc::clone(&child_arc);
    let kill: Box<dyn FnOnce() + Send> = Box::new(move || {
        let mut guard = lock_recovering(&kill_arc);
        // Errors are usually ESRCH (already exited) — fine.
        let _ = guard.kill();
    });

    Ok(RunHandle::new(rx, kill, Some(stdin_tx)))
}

/// Serialize a SDK `PermissionResult` into the control_response JSON
/// line claude expects on stdin. The `request_id` MUST match the one
/// from the incoming `control_request can_use_tool` envelope or claude
/// won't correlate the answer with the pending tool call.
///
/// Tauri commands use this to keep the wire format in one place — the
/// shell only sees a typed `(request_id, PermissionDecision)`, never the
/// raw JSON.
/// JSON line telling claude to break its stream-json input loop and
/// shut down cleanly. Without this, the runner spawned with
/// `--input-format stream-json` would hang after a single turn —
/// claude waits indefinitely for another user message on stdin and the
/// subprocess never exits, leaving the IDE stuck in "running" state.
///
/// The reader thread queues this line right after parsing the first
/// `type: "result"` event (turn complete). Claude acks via a
/// `control_response` (silently swallowed by `classify_stdout_line`),
/// shuts down, and the coordinator's `wait()` finally unblocks.
fn build_end_session_line() -> String {
    serde_json::json!({
        "type": "control_request",
        "request_id": END_SESSION_REQUEST_ID,
        "request": { "subtype": "end_session", "reason": "result-emitted" }
    })
    .to_string()
}

pub fn build_permission_response_line(
    request_id: &str,
    decision: &super::PermissionDecision,
) -> String {
    // `PermissionDecision` is `#[derive(Serialize)]` over plain owned data;
    // serialization is infallible. `unwrap_or(Null)` would mask the very
    // unlikely failure as a malformed `control_response` that desyncs the
    // claude protocol and hangs the turn — `expect` lets that surface
    // loudly during testing instead.
    let response =
        serde_json::to_value(decision).expect("PermissionDecision is always serializable");
    let envelope = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        }
    });
    envelope.to_string()
}

/// Owns the child's stdin handle and writes one line per message
/// received on the channel. Each message gets a trailing `\n` (so callers
/// pass single-line JSON without the newline). Exits when the channel
/// closes (Sender dropped) or a write fails — both signal that the
/// subprocess has gone away or the host is done writing.
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
        // stdin drops here, closing the pipe — claude sees EOF and stops
        // waiting for more user turns. The coordinator's wait() will
        // unblock naturally.
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

/// What to do with a single line after classification: optionally emit
/// an event, and optionally signal that this line ended the turn
/// (claude's `result` event in stream-json mode) so the reader can ask
/// claude to break its input loop.
struct LineHandled {
    event: Option<RunEvent>,
    end_of_turn: bool,
}

// `stdin_tx`: sender into the per-run stdin writer. Only the stdout
// reader gets it — when that reader sees claude's `result` event it
// queues an `end_session` control_request so the subprocess exits
// cleanly. `None` for the stderr reader and for fixtures that don't
// speak the SDK protocol.
fn spawn_reader<R: Read + Send + 'static>(
    src: R,
    tx: mpsc::Sender<RunEvent>,
    trunc: Arc<Mutex<TruncationState>>,
    kind: ReaderKind,
    stdin_tx: Option<mpsc::Sender<String>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        // Send `end_session` at most once per run. Defensive — claude in
        // `-p` mode emits exactly one `result` per turn and we feed it
        // one user message, so multiple result events shouldn't occur,
        // but a stray duplicate from a buggy version shouldn't double-
        // queue the shutdown signal.
        let mut end_session_sent = false;
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
                    let handled = match kind {
                        ReaderKind::Stdout => classify_stdout_line(line),
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
                    if handled.end_of_turn && !end_session_sent {
                        if let Some(stdin_tx) = &stdin_tx {
                            // Fire-and-forget: if the writer thread is
                            // already gone (subprocess crashed), the
                            // coordinator will surface that via Exit.
                            let _ = stdin_tx.send(build_end_session_line());
                        }
                        end_session_sent = true;
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

/// Inspect one stdout line and decide what RunEvent (if any) it maps to.
///
/// Non-JSON lines and ordinary assistant/system messages flow through
/// as `Stdout` so the frontend's existing stream-json renderer keeps
/// working. Three control-protocol shapes are intercepted:
///
/// - `control_request` with `subtype: "can_use_tool"` becomes a typed
///   `PermissionRequest` event — that's how the modal-flow Tauri shell
///   learns claude is paused awaiting a decision.
/// - `control_response` (claude acknowledging our own control_requests,
///   e.g. initialize / end_session) is swallowed silently — protocol
///   metadata that would otherwise pollute the chat log.
/// - `result` is forwarded as `Stdout` AND flagged `end_of_turn = true`
///   so the reader can fire the `end_session` control_request that
///   tells claude to break its stream-json input loop. Without that
///   the subprocess would hang waiting for another user message and
///   the IDE would stay stuck in "running" forever.
///
/// Any unrecognised JSON or parse failure falls through to `Stdout` so
/// we never silently drop legitimate output. The frontend handles
/// unknown shapes gracefully.
fn classify_stdout_line(line: String) -> LineHandled {
    // Cheap byte-level prefix check — most stream-json lines start with
    // '{' but log lines from claude may not. Avoids paying for a parse
    // attempt on every non-JSON line.
    let trimmed = line.trim_start();
    if !trimmed.starts_with('{') {
        return LineHandled {
            event: Some(RunEvent::Stdout(line)),
            end_of_turn: false,
        };
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            return LineHandled {
                event: Some(RunEvent::Stdout(line)),
                end_of_turn: false,
            };
        }
    };
    let ty = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ty {
        "control_response" => LineHandled {
            event: None,
            end_of_turn: false,
        },
        "control_request" => {
            let subtype = parsed
                .get("request")
                .and_then(|r| r.get("subtype"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if subtype == "can_use_tool" {
                if let Some(req) = parse_permission_request(&parsed) {
                    return LineHandled {
                        event: Some(RunEvent::PermissionRequest(req)),
                        end_of_turn: false,
                    };
                }
                // Malformed — surface the raw JSON so we don't drop it.
                LineHandled {
                    event: Some(RunEvent::Stdout(line)),
                    end_of_turn: false,
                }
            } else {
                LineHandled {
                    event: Some(RunEvent::Stdout(line)),
                    end_of_turn: false,
                }
            }
        }
        "result" => {
            // Turn complete. Emit the line so the frontend renders the
            // result summary, and flag end_of_turn so the reader can
            // hand-shake the shutdown.
            LineHandled {
                event: Some(RunEvent::Stdout(line)),
                end_of_turn: true,
            }
        }
        _ => LineHandled {
            event: Some(RunEvent::Stdout(line)),
            end_of_turn: false,
        },
    }
}

/// Extract the SDK `SDKControlPermissionRequest` payload from a parsed
/// control_request envelope. Returns `None` if required fields are
/// missing — the caller falls back to surfacing the raw line so the
/// debugging tail still works.
fn parse_permission_request(envelope: &serde_json::Value) -> Option<PermissionRequest> {
    let request_id = envelope.get("request_id")?.as_str()?.to_string();
    let request = envelope.get("request")?;
    let tool_name = request.get("tool_name")?.as_str()?.to_string();
    let tool_use_id = request.get("tool_use_id")?.as_str()?.to_string();
    let tool_input = request
        .get("input")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let title = request
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let display_name = request
        .get("display_name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let description = request
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some(PermissionRequest {
        request_id,
        tool_name,
        tool_input,
        tool_use_id,
        title,
        display_name,
        description,
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
            resume_session_id: None,
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
            Vec::new(),
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
            Vec::new(),
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
        let handle =
            spawn_with_command("sh", vec!["-c".into(), "exit 3".into()], req(), Vec::new())
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
        let mut handle =
            spawn_with_command("sleep", vec!["60".into()], req(), Vec::new()).expect("spawn sleep");
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
            Vec::new(),
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
        let mut handle = spawn_with_command("yes", vec![], req(), Vec::new()).expect("spawn yes");

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
            vec!["-c".into(), "yes >&1 & yes >&2 & wait".into()],
            req(),
            Vec::new(),
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

    #[test]
    fn runtime_input_appended_to_user_message() {
        // The prompt is delivered via stream-json on stdin now, so
        // build_args is flag-only; the prompt content + runtime input
        // live in the second stdin line (after the initialize handshake).
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "base prompt".into(),
            runtime_input: Some("PR-42".into()),
            resume_session_id: None,
        };
        let lines = build_stdin_messages(&req);
        assert_eq!(lines.len(), 2, "expected initialize + user message");
        let user_json: serde_json::Value =
            serde_json::from_str(&lines[1]).expect("user message is valid JSON");
        let content = user_json["message"]["content"]
            .as_str()
            .expect("user message has string content");
        assert!(content.contains("base prompt"));
        assert!(content.contains("## Additional input"));
        assert!(content.contains("PR-42"));
    }

    #[test]
    fn initialize_handshake_is_first_stdin_line() {
        // The Claude Agent SDK requires an `initialize` control_request
        // BEFORE the first user turn — otherwise claude won't activate
        // the canUseTool callback path and our permission modal never
        // fires. Regression guard.
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "p".into(),
            runtime_input: None,
            resume_session_id: None,
        };
        let lines = build_stdin_messages(&req);
        let init: serde_json::Value = serde_json::from_str(&lines[0]).expect("first line is JSON");
        assert_eq!(init["type"], "control_request");
        assert_eq!(init["request"]["subtype"], "initialize");
    }

    #[test]
    fn streaming_flags_are_set() {
        // stream-json input + output + verbose is the only combination
        // that gives us bidirectional events. Guard against accidental
        // regressions to text mode or one-way streaming.
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "p".into(),
            runtime_input: None,
            resume_session_id: None,
        };
        let args = build_args(&req);
        assert!(args.iter().any(|a| a == "--input-format"));
        assert!(args.iter().any(|a| a == "--output-format"));
        assert!(args.iter().any(|a| a == "stream-json"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(!args.iter().any(|a| a == "text"));
        // -p (print/non-interactive) is still required.
        assert!(args.iter().any(|a| a == "-p"));
    }

    #[test]
    fn ask_user_question_disabled() {
        // Regression guard for the "Answer questions?" tool_result
        // error that surfaced when claude tried the interactive
        // AskUserQuestion tool without a host-side dialog handler.
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "p".into(),
            runtime_input: None,
            resume_session_id: None,
        };
        let args = build_args(&req);
        let pos = args
            .iter()
            .position(|a| a == "--disallowed-tools")
            .expect("--disallowed-tools flag is required");
        assert_eq!(
            args.get(pos + 1).map(String::as_str),
            Some("AskUserQuestion"),
        );
    }

    #[test]
    fn permission_mode_accepts_edits() {
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "p".into(),
            runtime_input: None,
            resume_session_id: None,
        };
        let args = build_args(&req);
        // Without this flag, claude prompts on Write/Edit. With the SDK
        // control protocol the prompt routes through canUseTool — but we
        // keep auto-accept on file edits so the modal only fires for
        // Bash / network / MCP. Regression guard.
        let pos = args
            .iter()
            .position(|a| a == "--permission-mode")
            .expect("--permission-mode flag is required");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("acceptEdits"));
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
            resume_session_id: None,
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

    #[test]
    fn resume_session_id_emits_resume_flag() {
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "follow-up reply".into(),
            runtime_input: None,
            resume_session_id: Some("abc-123-xyz".into()),
        };
        let args = build_args(&req);
        let pairs: Vec<(&str, &str)> = args
            .windows(2)
            .filter_map(|w| {
                if w[0] == "--resume" {
                    Some((w[0].as_str(), w[1].as_str()))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].1, "abc-123-xyz");
        // The follow-up reply lives in the stream-json user message now.
        let lines = build_stdin_messages(&req);
        let user_json: serde_json::Value =
            serde_json::from_str(&lines[1]).expect("user message is valid JSON");
        assert_eq!(user_json["message"]["content"], "follow-up reply");
    }

    #[test]
    fn empty_resume_session_id_does_not_emit_flag() {
        let req = RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: "p".into(),
            runtime_input: None,
            resume_session_id: Some("   ".into()),
        };
        let args = build_args(&req);
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "whitespace-only session id should be ignored"
        );
    }

    // ---------- control-protocol parsing ----------

    #[test]
    fn classify_stdout_passes_through_plain_lines() {
        let h = classify_stdout_line("hello".into());
        match h.event {
            Some(RunEvent::Stdout(s)) => assert_eq!(s, "hello"),
            other => panic!("expected Stdout, got {:?}", other),
        }
        assert!(!h.end_of_turn);
    }

    #[test]
    fn classify_stdout_passes_through_non_control_json() {
        let line = r#"{"type":"assistant","message":{"content":[]}}"#.to_string();
        let h = classify_stdout_line(line.clone());
        match h.event {
            Some(RunEvent::Stdout(s)) => assert_eq!(s, line),
            other => panic!("expected Stdout, got {:?}", other),
        }
        assert!(!h.end_of_turn);
    }

    #[test]
    fn classify_stdout_swallows_control_response() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"vide-init-1"}}"#;
        let h = classify_stdout_line(line.into());
        assert!(
            h.event.is_none(),
            "control_response (init / end_session ack) must not surface as Stdout"
        );
        assert!(!h.end_of_turn);
    }

    #[test]
    fn classify_stdout_extracts_can_use_tool_request() {
        let line = r#"{
            "type":"control_request",
            "request_id":"perm-7",
            "request":{
                "subtype":"can_use_tool",
                "tool_name":"Bash",
                "input":{"command":"ls -la"},
                "tool_use_id":"toolu_42",
                "title":"Claude wants to run ls",
                "display_name":"Run shell command",
                "description":"Read directory listing"
            }
        }"#
        .to_string();
        let h = classify_stdout_line(line);
        match h.event {
            Some(RunEvent::PermissionRequest(req)) => {
                assert_eq!(req.request_id, "perm-7");
                assert_eq!(req.tool_name, "Bash");
                assert_eq!(req.tool_use_id, "toolu_42");
                assert_eq!(req.title.as_deref(), Some("Claude wants to run ls"));
                assert_eq!(req.display_name.as_deref(), Some("Run shell command"));
                assert_eq!(req.tool_input["command"], "ls -la");
            }
            other => panic!("expected PermissionRequest, got {:?}", other),
        }
        assert!(!h.end_of_turn);
    }

    #[test]
    fn classify_stdout_flags_result_as_end_of_turn() {
        // Regression: before this flag, the runner kept stdin open
        // forever after `result` and the subprocess hung in `-p` mode.
        let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.1}"#.to_string();
        let h = classify_stdout_line(line.clone());
        match h.event {
            Some(RunEvent::Stdout(s)) => assert_eq!(s, line),
            other => panic!("expected Stdout, got {:?}", other),
        }
        assert!(
            h.end_of_turn,
            "result event must flag end_of_turn so the reader can fire end_session"
        );
    }

    #[test]
    fn build_end_session_line_has_correct_shape() {
        let line = build_end_session_line();
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["type"], "control_request");
        assert_eq!(parsed["request_id"], END_SESSION_REQUEST_ID);
        assert_eq!(parsed["request"]["subtype"], "end_session");
    }

    #[test]
    fn build_permission_response_line_allow_shape() {
        let line = build_permission_response_line(
            "perm-7",
            &super::super::PermissionDecision::Allow {
                updated_input: None,
                updated_permissions: None,
            },
        );
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["type"], "control_response");
        assert_eq!(parsed["response"]["subtype"], "success");
        assert_eq!(parsed["response"]["request_id"], "perm-7");
        assert_eq!(parsed["response"]["response"]["behavior"], "allow");
    }

    #[test]
    fn build_permission_response_line_deny_carries_message() {
        let line = build_permission_response_line(
            "perm-8",
            &super::super::PermissionDecision::Deny {
                message: "user denied via modal".into(),
            },
        );
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["response"]["response"]["behavior"], "deny");
        assert_eq!(
            parsed["response"]["response"]["message"],
            "user denied via modal"
        );
    }
}
