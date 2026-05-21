//! OpenAI Codex CLI runner.
//!
//! Spawns `codex exec --json` (or `codex exec resume <session_id> --json`
//! on resume) with cwd set to the project's source repo. The vault root
//! (and any other extra dirs) are forwarded via `--add-dir` so the
//! agent can read + write vault notes alongside the code — same scope
//! as Claude.
//!
//! ## Flags currently passed
//!
//! - `exec` / `exec resume <id>` — non-interactive subcommand. Resume
//!   continues a recorded session by id (codex thread_id, persisted
//!   under `$CODEX_HOME` by default).
//! - `--json` — JSONL streaming output (one event per line). Without
//!   it codex emits ANSI-styled text fit for a TUI but not for our
//!   structured chat log.
//! - `--skip-git-repo-check` — codex normally refuses to run outside
//!   a git repo; we want it to work in vault-only chats too.
//! - `--sandbox workspace-write` — codex enforces an OS-level sandbox
//!   on every shell command it invokes: reads allowed anywhere, writes
//!   restricted to cwd + the dirs we pass via `--add-dir`, network
//!   blocked by default. This is the security floor — codex doesn't
//!   speak a permission-request protocol like Claude's SDK, so we
//!   can't surface a "may I run X?" modal; the sandbox acts in lieu
//!   of approvals. When a command exceeds the sandbox, codex reports
//!   it inline ("I couldn't create that file — filesystem is
//!   read-only") rather than hanging on approval.
//! - `-m <model>` — when [`RunRequest::model`] is set; defaults to
//!   the user's `config.toml`-configured model otherwise.
//! - `--add-dir <dir>` — one per [`RunRequest::additional_dirs`] entry
//!   on fresh runs. NOT passed on `exec resume` (codex inherits
//!   writable dirs from the original session).
//! - `--` followed by the prompt — terminates options so prompts
//!   beginning with `-` aren't parsed as flags.
//!
//! ## Stream-json shape (codex 0.132)
//!
//! ```jsonl
//! {"type":"thread.started","thread_id":"<uuid>"}
//! {"type":"turn.started"}
//! {"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"...","status":"in_progress"}}
//! {"type":"item.completed","item":{"id":"item_0","type":"command_execution","exit_code":0,"status":"completed"}}
//! {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
//! {"type":"turn.completed","usage":{"input_tokens":..,"cached_input_tokens":..,"output_tokens":..,"reasoning_output_tokens":..}}
//! ```
//!
//! Unlike Claude there's no control protocol, no permission requests,
//! and no end-of-turn handshake — codex exits naturally on `turn.completed`
//! since it doesn't loop waiting for more user messages in `exec` mode.

use super::subprocess::{spawn_subprocess, LineClassifier, LineHandled};
use super::{RunEvent, RunHandle, RunRequest, Runner, RunnerError, RunnerKind};

const CODEX_BIN: &str = "codex";

/// Default sandbox policy. Read everywhere, write only inside the
/// workspace (cwd + `--add-dir`), network blocked. Mirrors Claude's
/// `--permission-mode acceptEdits` — auto-allow edits inside the
/// project scope, deny escapes outright. NOT user-configurable yet;
/// the agent permissions UI (tracked follow-up) will let the user
/// upgrade to `danger-full-access` on a per-tab basis.
const CODEX_SANDBOX: &str = "workspace-write";

/// Resolve which binary to spawn for the Codex runner. Honors
/// `CODEX_BIN` as an escape hatch for non-standard installs.
fn resolve_codex_bin() -> String {
    std::env::var("CODEX_BIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| CODEX_BIN.to_string())
}

pub struct CodexRunner;

impl CodexRunner {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CodexRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for CodexRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Codex
    }

    fn start(&self, req: RunRequest) -> Result<RunHandle, RunnerError> {
        let args = build_args(&req);
        let bin = resolve_codex_bin();
        // Codex reads the prompt from the positional argument, so no
        // initial stdin lines are needed. Closing stdin via EOF (the
        // writer thread shuts down once we drop the sender) is fine —
        // codex doesn't loop waiting for more input in `exec` mode.
        spawn_subprocess(&bin, args, req, Vec::new(), CodexLineClassifier)
    }
}

fn build_args(req: &RunRequest) -> Vec<String> {
    // Prompt + runtime input concatenation mirrors Claude's behaviour
    // so both runners see the same final prompt shape.
    let mut prompt = req.prompt.clone();
    if let Some(extra) = req.runtime_input.as_ref().filter(|s| !s.trim().is_empty()) {
        prompt.push_str("\n\n## Additional input\n\n");
        prompt.push_str(extra);
        prompt.push('\n');
    }

    let resume_id = req
        .resume_session_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let mut args: Vec<String> = Vec::with_capacity(12 + req.additional_dirs.len() * 2);
    args.push("exec".to_string());

    if let Some(id) = resume_id {
        // `codex exec resume <id> <prompt>` — same flags as fresh
        // exec, but additional_dirs is omitted because codex remembers
        // the original session's writable scope.
        args.push("resume".to_string());
        args.push(id.to_string());
    }

    // JSONL events — same role as `--output-format stream-json` for
    // Claude. Without this, codex emits styled text we can't structure.
    args.push("--json".to_string());

    // Run outside a git repo when the workdir isn't tracked (vault-only
    // chats). Codex defaults to refusing.
    args.push("--skip-git-repo-check".to_string());

    // OS-level sandbox is only settable on fresh `exec` — `exec
    // resume` inherits the original session's sandbox and rejects
    // `--sandbox` outright ("unexpected argument '--sandbox' found").
    // Same story for `--add-dir`: writable scope is sticky to the
    // session that minted the thread.
    if resume_id.is_none() {
        args.push("--sandbox".to_string());
        args.push(CODEX_SANDBOX.to_string());
    }

    // Optional model override. Accepted by both fresh and resume —
    // codex allows swapping models between turns.
    if let Some(model) = req.model.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    // Writable scope. Codex's resume subcommand doesn't accept
    // `--add-dir` — the original session's scope is sticky.
    if resume_id.is_none() {
        for d in &req.additional_dirs {
            args.push("--add-dir".to_string());
            args.push(d.to_string_lossy().to_string());
        }
    }

    // `--` terminates option parsing so a prompt starting with `-`
    // (rare but possible — "- list every TODO") isn't mistaken for a
    // flag. The prompt is the final positional arg in both fresh and
    // resume call shapes.
    args.push("--".to_string());
    args.push(prompt);
    args
}

/// Stateless classifier. Codex has no end-of-turn handshake — once
/// `turn.completed` arrives the subprocess exits on its own.
struct CodexLineClassifier;

impl LineClassifier for CodexLineClassifier {
    fn classify_stdout(&self, line: String) -> LineHandled {
        classify_stdout_line(line)
    }
    // Default `on_end_of_turn_line` returns empty — we don't flag
    // end_of_turn anyway, but make the no-handshake intent explicit
    // by leaving the override out.

    fn needs_stdin(&self) -> bool {
        // Codex `exec` reads the prompt from a positional argument
        // and, when stdin is piped, blocks on it until EOF
        // ("Reading additional input from stdin..."). Telling the
        // subprocess module to point stdin at /dev/null gives codex
        // immediate EOF so it proceeds straight to streaming the
        // turn.
        false
    }
}

/// Forward every codex JSONL line as `Stdout` so the frontend renderer
/// can deserialize the event shapes. Non-JSON lines (stray banners,
/// errors codex prints unstructured) also surface as `Stdout` so we
/// never silently drop output.
///
/// Unlike Claude, codex has no control protocol → no permission
/// requests, no end-of-turn shutdown handshake. Everything is plain
/// data for the renderer; classification stays minimal.
fn classify_stdout_line(line: String) -> LineHandled {
    LineHandled {
        event: Some(RunEvent::Stdout(line)),
        end_of_turn: false,
    }
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
    fn fresh_run_uses_exec_subcommand_with_prompt_and_sandbox() {
        let req = RunRequest {
            prompt: "fix the bug".into(),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert_eq!(args[0], "exec");
        // resume subcommand absent on fresh runs.
        assert!(!args.iter().any(|a| a == "resume"));
        // JSONL + sandbox + skip-git-repo-check are all required for
        // the streaming UX + vault-only chats.
        assert!(args.iter().any(|a| a == "--json"));
        assert!(args.iter().any(|a| a == "--skip-git-repo-check"));
        let pos = args
            .iter()
            .position(|a| a == "--sandbox")
            .expect("--sandbox flag required");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some(CODEX_SANDBOX));
        // Prompt is the last positional, terminated by `--`.
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args[args.len() - 1], "fix the bug");
    }

    #[test]
    fn resume_run_uses_exec_resume_with_session_id() {
        let req = RunRequest {
            prompt: "next turn".into(),
            resume_session_id: Some("019e4b50-70c2-75b1-8db3-5c5b8c5f2fee".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "resume");
        assert_eq!(args[2], "019e4b50-70c2-75b1-8db3-5c5b8c5f2fee");
        // Prompt still ends as the final positional after `--`.
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args[args.len() - 1], "next turn");
    }

    #[test]
    fn empty_resume_session_id_does_not_emit_resume_subcommand() {
        let req = RunRequest {
            prompt: "p".into(),
            resume_session_id: Some("   ".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert!(
            !args.iter().any(|a| a == "resume"),
            "whitespace-only session id should be ignored"
        );
    }

    #[test]
    fn additional_dirs_emit_add_dir_on_fresh_run() {
        let req = RunRequest {
            additional_dirs: vec![
                std::path::PathBuf::from("/tmp/vault"),
                std::path::PathBuf::from("/tmp/notes"),
            ],
            prompt: "p".into(),
            ..req_skeleton()
        };
        let args = build_args(&req);
        let dirs: Vec<&str> = args
            .windows(2)
            .filter_map(|w| (w[0] == "--add-dir").then_some(w[1].as_str()))
            .collect();
        assert_eq!(dirs.len(), 2);
        assert!(dirs.contains(&"/tmp/vault"));
        assert!(dirs.contains(&"/tmp/notes"));
    }

    #[test]
    fn sandbox_omitted_on_resume() {
        // `codex exec resume` rejects `--sandbox` ("unexpected
        // argument '--sandbox' found"). Sandbox is sticky to the
        // session that minted the thread, so we must omit it on
        // every resume turn. Regression guard.
        let req = RunRequest {
            prompt: "p".into(),
            resume_session_id: Some("019e4b50-70c2-75b1-8db3-5c5b8c5f2fee".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert!(
            !args.iter().any(|a| a == "--sandbox"),
            "--sandbox must be omitted on resume; got {:?}",
            args
        );
    }

    #[test]
    fn additional_dirs_omitted_on_resume() {
        // Codex `exec resume` does not accept --add-dir. Codex
        // remembers the original session's writable scope from when
        // the thread was first created.
        let req = RunRequest {
            additional_dirs: vec![std::path::PathBuf::from("/tmp/vault")],
            prompt: "p".into(),
            resume_session_id: Some("019e4b50-70c2-75b1-8db3-5c5b8c5f2fee".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        assert!(
            !args.iter().any(|a| a == "--add-dir"),
            "--add-dir must be omitted on resume; got {:?}",
            args
        );
    }

    #[test]
    fn model_flag_emitted_when_set() {
        let req = RunRequest {
            prompt: "p".into(),
            model: Some("gpt-5-codex".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        let pos = args.iter().position(|a| a == "--model");
        let model = pos.and_then(|p| args.get(p + 1)).map(String::as_str);
        assert_eq!(model, Some("gpt-5-codex"));
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

    #[test]
    fn runtime_input_appended_to_prompt() {
        let req = RunRequest {
            prompt: "base prompt".into(),
            runtime_input: Some("PR-42".into()),
            ..req_skeleton()
        };
        let args = build_args(&req);
        let prompt = args.last().expect("prompt is the final positional arg");
        assert!(prompt.contains("base prompt"));
        assert!(prompt.contains("## Additional input"));
        assert!(prompt.contains("PR-42"));
    }

    #[test]
    fn classify_stdout_passes_through_any_line() {
        // Codex emits well-structured JSONL but the runner forwards
        // it verbatim — the frontend renderer does the structured
        // parsing. Plain text lines also pass through (so unstructured
        // codex banners survive).
        let h = classify_stdout_line(r#"{"type":"thread.started"}"#.into());
        match h.event {
            Some(RunEvent::Stdout(s)) => assert_eq!(s, r#"{"type":"thread.started"}"#),
            other => panic!("expected Stdout, got {:?}", other),
        }
        assert!(!h.end_of_turn);

        let h2 = classify_stdout_line("plain banner line".into());
        match h2.event {
            Some(RunEvent::Stdout(s)) => assert_eq!(s, "plain banner line"),
            other => panic!("expected Stdout, got {:?}", other),
        }
    }
}
