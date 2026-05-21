//! Claude Code CLI runner.
//!
//! Spawns `claude -p` in bidirectional stream-json mode. cwd is the
//! project's source repo; the vault root (and any other extra dirs)
//! are passed as `--add-dir` flags so the agent can read vault notes
//! alongside the code.
//!
//! ## Flags currently passed
//!
//! - `-p` — non-interactive mode. Required even with stream-json
//!   input — without it claude opens a TUI and ignores stdin.
//! - `--input-format stream-json --output-format stream-json --verbose`
//!   — bidirectional event protocol. Input carries the SDK initialize
//!   handshake + user message + permission control_responses; output
//!   carries assistant events + can_use_tool control_requests.
//! - `--permission-mode acceptEdits` — auto-approves file-edit tools
//!   (Write/Edit/MultiEdit/NotebookEdit) without prompting; the user
//!   already authorised the run by clicking Run, and the vault is
//!   git-tracked so review happens via `git diff`. Other tools (Bash,
//!   network, MCP) still route through the SDK control protocol →
//!   frontend permission card.
//! - `--disallowed-tools AskUserQuestion` — disable the interactive
//!   multi-choice tool which would otherwise return an `is_error`
//!   tool_result we can't answer in non-interactive mode. The model
//!   adapts by asking inline in chat text instead.
//! - `--resume <session_id>` — when resuming a prior conversation.
//! - `--add-dir <dir>` — one per [`RunRequest::additional_dirs`] entry.
//! - `--model <name>` — when [`RunRequest::model`] is set; otherwise
//!   defaults to the user's global Claude Code config.
//!
//! ## Threading + truncation
//!
//! The generic spawn-and-pump machinery lives in `subprocess.rs`; this
//! file only contributes Claude-specific argument building, the
//! initial stdin handshake, and the [`ClaudeLineClassifier`] that
//! turns stream-json events into `RunEvent`s.

use super::subprocess::{spawn_subprocess, LineClassifier, LineHandled};
use super::{PermissionRequest, RunEvent, RunHandle, RunRequest, Runner, RunnerError, RunnerKind};

const CLAUDE_BIN: &str = "claude";

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
        spawn_subprocess(&bin, args, req, init_messages, ClaudeLineClassifier)
    }
}

fn build_args(req: &RunRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(12 + req.additional_dirs.len() * 2);
    // -p (print/non-interactive) is still required even when input
    // comes via stream-json — without it claude would open a TUI and
    // ignore the streamed messages.
    args.push("-p".to_string());

    // Bidirectional stream-json. Input carries the initialize handshake
    // + user message + control_response replies; output carries
    // assistant events + control_request can_use_tool prompts.
    args.push("--input-format".to_string());
    args.push("stream-json".to_string());
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    args.push("--verbose".to_string());

    // Authorise file-edit tools so claude doesn't hang on a permission
    // prompt mid-run. The user clicked Run with intent and the vault
    // is git-tracked; review via `git diff`. Other tools (Bash, MCP,
    // network) still go through the SDK canUseTool path activated by
    // our `initialize` control_request — those surface as
    // `RunEvent::PermissionRequest`.
    args.push("--permission-mode".to_string());
    args.push("acceptEdits".to_string());

    // Disable AskUserQuestion. It's a built-in tool that opens an
    // interactive multi-choice prompt; in `-p --input-format
    // stream-json` mode without a host-side dialog handler, claude
    // calls the tool and gets an immediate `is_error` tool_result
    // back ("Answer questions?"), which surfaces as a confusing error
    // line in our chat output. With the tool removed from the toolset,
    // claude adapts by asking the user inline in plain chat text —
    // which routes naturally through our bottom-drawer reply flow.
    args.push("--disallowed-tools".to_string());
    args.push("AskUserQuestion".to_string());

    // Optional model override. None = use the user's configured default.
    if let Some(model) = req.model.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(model.clone());
    }

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

/// Serialize a SDK `PermissionResult` into the control_response JSON
/// line claude expects on stdin. The `request_id` MUST match the one
/// from the incoming `control_request can_use_tool` envelope or claude
/// won't correlate the answer with the pending tool call.
///
/// Tauri commands use this to keep the wire format in one place — the
/// shell only sees a typed `(request_id, PermissionDecision)`, never
/// the raw JSON.
pub fn build_permission_response_line(
    request_id: &str,
    decision: &super::PermissionDecision,
) -> String {
    // `PermissionDecision` is `#[derive(Serialize)]` over plain owned
    // data; serialization is infallible. `unwrap_or(Null)` would mask
    // the very unlikely failure as a malformed `control_response` that
    // desyncs the claude protocol and hangs the turn — `expect` lets
    // that surface loudly during testing instead.
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

/// JSON line telling claude to break its stream-json input loop and
/// shut down cleanly. Without this, the runner spawned with
/// `--input-format stream-json` would hang after a single turn —
/// claude waits indefinitely for another user message on stdin and the
/// subprocess never exits, leaving the IDE stuck in "running" state.
///
/// The reader queues this line right after parsing the first
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

/// Stateless classifier. Held as the runner's plug-in for the generic
/// subprocess pipeline; one shared instance per run is fine because
/// the logic only depends on the line being classified.
struct ClaudeLineClassifier;

impl LineClassifier for ClaudeLineClassifier {
    fn classify_stdout(&self, line: String) -> LineHandled {
        classify_stdout_line(line)
    }

    fn on_end_of_turn_line(&self) -> Vec<String> {
        vec![build_end_session_line()]
    }
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
    // Cheap byte-level prefix check — most stream-json lines start
    // with '{' but log lines from claude may not. Avoids paying for a
    // parse attempt on every non-JSON line.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn req_skeleton() -> RunRequest {
        RunRequest {
            workdir: std::env::temp_dir(),
            additional_dirs: Vec::new(),
            prompt: String::new(),
            runtime_input: None,
            resume_session_id: None,
            model: None,
        }
    }

    #[test]
    fn runtime_input_appended_to_user_message() {
        // The prompt is delivered via stream-json on stdin now, so
        // build_args is flag-only; the prompt content + runtime input
        // live in the second stdin line (after the initialize handshake).
        let req = RunRequest {
            prompt: "base prompt".into(),
            runtime_input: Some("PR-42".into()),
            ..req_skeleton()
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
            prompt: "p".into(),
            ..req_skeleton()
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
            prompt: "p".into(),
            ..req_skeleton()
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
            prompt: "p".into(),
            ..req_skeleton()
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
            prompt: "p".into(),
            ..req_skeleton()
        };
        let args = build_args(&req);
        // Without this flag, claude prompts on Write/Edit. With the
        // SDK control protocol the prompt routes through canUseTool —
        // but we keep auto-accept on file edits so the modal only
        // fires for Bash / network / MCP. Regression guard.
        let pos = args
            .iter()
            .position(|a| a == "--permission-mode")
            .expect("--permission-mode flag is required");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("acceptEdits"));
    }

    #[test]
    fn additional_dirs_become_add_dir_flags() {
        let req = RunRequest {
            additional_dirs: vec![
                std::path::PathBuf::from("/tmp/vault"),
                std::path::PathBuf::from("/tmp/notes"),
            ],
            prompt: "p".into(),
            ..req_skeleton()
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
            prompt: "follow-up reply".into(),
            resume_session_id: Some("abc-123-xyz".into()),
            ..req_skeleton()
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
            prompt: "p".into(),
            resume_session_id: Some("   ".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "whitespace-only session id should be ignored"
        );
    }

    #[test]
    fn model_flag_emitted_when_set() {
        let req = RunRequest {
            prompt: "p".into(),
            model: Some("opus".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        let pos = args.iter().position(|a| a == "--model");
        let model = pos.and_then(|p| args.get(p + 1)).map(String::as_str);
        assert_eq!(model, Some("opus"));
    }

    #[test]
    fn empty_model_does_not_emit_flag() {
        let req = RunRequest {
            prompt: "p".into(),
            model: Some("   ".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert!(
            !args.iter().any(|a| a == "--model"),
            "whitespace-only model should be ignored"
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
