//! Generic async ACP runtime wrapping the `agent-client-protocol` crate.
//!
//! Per-runner files (claude.rs / codex.rs) describe **what** subprocess
//! to spawn (path, args, env) via [`AcpSpawnConfig`]; this module owns
//! the **how**: tokio runtime, JSON-RPC client setup, notification +
//! permission-request dispatch, sync `RunHandle` bridging.
//!
//! ## Channel topology
//!
//! ```text
//!   Tauri shell (sync)                Worker thread                  ACP subprocess
//!   ─────────────────                 ─────────────                  ──────────────
//!   RunHandle.recv()      ◄─────────  std::mpsc<RunEvent>  ◄───────  client task
//!                                            ▲
//!                                     tokio Runtime
//!                                            │
//!   respond_to_permission ───────►    std::mpsc                ┌──► request_permission
//!     (request_id, decision)          <PermissionResponse>     │    handler awakens its
//!                                            │                 │    oneshot, responds to
//!                                            ▼                 │    agent
//!                                     pump task → looks up     │
//!                                     oneshot in pending map  ─┘
//!
//!   kill()                ───────►    tokio::sync::oneshot   ─────► drop client + child
//! ```
//!
//! All four channels are unidirectional. The worker thread is the
//! only owner of the tokio runtime and the ACP `Client`; it bridges
//! every async event into the sync mpsc the Tauri shell consumes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use agent_client_protocol::schema::{
    ContentBlock, InitializeRequest, LoadSessionRequest, McpServer, McpServerStdio, ModelId,
    NewSessionRequest, PermissionOptionId, PromptRequest, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, SetSessionModelRequest, TextContent,
};
use agent_client_protocol::{
    on_receive_notification, on_receive_request, AcpAgent, Agent, Client, ConnectionTo,
};
use tokio::sync::oneshot;

use crate::runner::{
    PermissionDecision, PermissionRequest, PermissionResponse, RunEvent, RunHandle, RunRequest,
    RunnerError,
};

/// What subprocess to spawn for a given runner. Per-runner files
/// (`AcpClaudeRunner` / `AcpCodexRunner`) build one of these and
/// hand it to [`spawn_acp`]; the transport doesn't care which CLI it
/// drives as long as the binary speaks ACP over stdio.
pub(crate) struct AcpSpawnConfig {
    /// Display name forwarded into ACP's `McpServerStdio.name`. Shows
    /// up in error messages — keep it human-readable (`"claude-acp"`,
    /// `"codex-acp"`).
    pub name: String,
    /// Absolute path to the executable. For Claude this is `node`
    /// (we shell into the bundled JS wrapper via `args`); for Codex
    /// it's the bundled native binary directly.
    pub command: PathBuf,
    /// Command-line arguments. For Claude: the bundled
    /// `dist/index.js` path. For Codex: empty.
    pub args: Vec<String>,
    /// Environment variables to merge into the child's env. For
    /// Claude we set `CLAUDE_CODE_EXECUTABLE` here so the JS wrapper
    /// uses the system `claude` binary instead of trying to resolve
    /// the bundled SDK runtime (which we don't ship).
    pub env: Vec<(String, String)>,
}

/// Map of in-flight permission requests keyed by `request_id`. Shared
/// between the notification handler (inserts on incoming request) and
/// the host-decision pump (removes and fires the oneshot when the
/// host approves/denies). `Arc<Mutex<…>>` because the ACP client
/// invokes handler closures across its internal tasks — single owner
/// would force serialisation.
type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>>;

/// Spawn an ACP-driven session. Returns the standard [`RunHandle`]
/// the rest of the codebase already knows how to consume; consumers
/// don't need to care that the underlying transport is async.
///
/// Lifecycle: spawns a worker thread that owns a tokio runtime,
/// initializes the agent, creates a fresh session, sends the prompt,
/// and streams every `session/update` notification back as
/// `RunEvent::Stdout` (serialized JSON for the frontend renderer).
/// On completion (or kill) emits `RunEvent::Exit` and tears down.
pub(crate) fn spawn_acp(
    config: AcpSpawnConfig,
    request: RunRequest,
) -> Result<RunHandle, RunnerError> {
    let (events_tx, events_rx) = mpsc::channel::<RunEvent>();
    let (perm_tx, perm_rx) = mpsc::channel::<PermissionResponse>();
    let (kill_tx, kill_rx) = mpsc::channel::<()>();

    let events_for_worker = events_tx.clone();
    thread::spawn(move || {
        // Each ACP run gets its own single-threaded tokio runtime so
        // shutdown is deterministic (drop the runtime ⇒ all tasks
        // cancelled). A shared multi-thread runtime would leak tasks
        // across runs if the IDE spawns several chats in parallel.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                let _ = events_for_worker.send(RunEvent::Stderr(format!(
                    "acp: failed to start tokio runtime: {e}"
                )));
                let _ = events_for_worker.send(RunEvent::Exit {
                    code: None,
                    success: false,
                });
                return;
            }
        };

        let exit_status = rt.block_on(run_session(
            config,
            request,
            events_for_worker.clone(),
            perm_rx,
            kill_rx,
        ));

        // Single source of truth for the terminal event so consumers
        // see exactly one `Exit` per run, regardless of which branch
        // (clean finish, kill, agent error) ran inside `run_session`.
        let (code, success) = match exit_status {
            Ok(()) => (Some(0), true),
            Err(msg) => {
                let _ = events_for_worker.send(RunEvent::Stderr(msg));
                (None, false)
            }
        };
        let _ = events_for_worker.send(RunEvent::Exit { code, success });
    });

    let kill: Box<dyn FnOnce() + Send> = Box::new(move || {
        // Best-effort: if the worker is already gone the send returns
        // Err which we drop — the channel closing is just one of
        // several signals that ends the session loop.
        let _ = kill_tx.send(());
    });

    Ok(RunHandle::new(events_rx, kill, Some(perm_tx)))
}

/// The core async session body. Returns Ok(()) on natural completion,
/// Err(msg) on protocol / IO failure. Either way the outer worker
/// thread emits the terminal `RunEvent::Exit` — we don't emit it from
/// here so the exit path stays single-source.
async fn run_session(
    config: AcpSpawnConfig,
    request: RunRequest,
    events_tx: mpsc::Sender<RunEvent>,
    perm_rx: mpsc::Receiver<PermissionResponse>,
    kill_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let workdir = request.workdir.clone();
    let additional_directories = request.additional_dirs.clone();
    let model_override = request
        .model
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Resume request id, if any. Stored as SessionId here so the
    // session-creation branch can plug it straight into LoadSession.
    let resume_session_id = request
        .resume_session_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(SessionId::from);
    let prompt = build_prompt(&request);

    // Build the agent transport. `McpServerStdio` is the canonical
    // stdio transport every ACP agent must speak; HTTP/SSE are
    // optional and we don't use them.
    let mut stdio = McpServerStdio::new(config.name.clone(), config.command.clone());
    stdio.args = config.args;
    stdio.env = config
        .env
        .into_iter()
        .map(|(name, value)| agent_client_protocol::schema::EnvVariable::new(name, value))
        .collect();
    let agent = AcpAgent::new(McpServer::Stdio(stdio));

    // Pending permission map. Shared between:
    //  - the `on_receive_request` handler (inserts new entries when
    //    the agent asks for permission)
    //  - the host-decision pump (drains entries when the user clicks
    //    approve/deny in the frontend)
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

    // Pump task: drains the host's `permissions` mpsc and signals
    // the matching pending oneshot. `spawn_blocking` lets us await
    // the sync std::mpsc::Receiver without poisoning the runtime.
    // The task ends when either the channel closes (Killer dropped)
    // or the runtime itself shuts down.
    let pending_for_pump = Arc::clone(&pending);
    let pump_handle = tokio::task::spawn_blocking(move || {
        while let Ok((request_id, decision)) = perm_rx.recv() {
            let entry = {
                let mut map = pending_for_pump.lock().unwrap_or_else(|p| p.into_inner());
                map.remove(&request_id)
            };
            if let Some(tx) = entry {
                // If the receiver was already dropped (agent
                // cancelled the turn first), fire-and-forget. The
                // host's UI will see a stale modal which clears on
                // the next `run:exit` payload.
                let _ = tx.send(decision);
            }
            // Unknown request_id: the host clicked approve on a
            // request the agent already cancelled (or one that
            // belonged to a different run). Drop silently — the
            // host's `approve_tool_use` Tauri command already
            // validates request_id presence before invoking us.
        }
    });

    let events_for_notifications = events_tx.clone();
    let events_for_permissions = events_tx.clone();
    let pending_for_handler = Arc::clone(&pending);

    // The closure passed to `connect_with` is the entire session
    // body — once it returns (or errors), the client tears down and
    // the subprocess receives EOF on its stdin.
    let result = Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                // Serialize the whole notification update to JSON and
                // forward as Stdout. The frontend renderer parses the
                // shape — keeping the transport dumb means schema
                // evolution in `agent-client-protocol` only requires
                // a frontend update, not a Rust release.
                if let Ok(json) = serde_json::to_string(&notification.update) {
                    let _ = events_for_notifications.send(RunEvent::Stdout(json));
                }
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |req: agent_client_protocol::schema::RequestPermissionRequest,
                        responder,
                        _connection| {
                // Park a oneshot for this request. The host's
                // approve/deny eventually fires it via the pump task.
                let request_id = format!("{}", req.tool_call.tool_call_id.0);
                let (decision_tx, decision_rx) = oneshot::channel::<PermissionDecision>();

                // Capture the agent-provided permission option ids so
                // we can echo the right id back on Allow. The agent
                // is the source of truth for which options are
                // available — kind "allow_once" / "allow_always" /
                // "reject_once" etc. We pick the first matching
                // affirmative for Allow, first denial for Deny.
                let allow_option = req
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            agent_client_protocol::schema::PermissionOptionKind::AllowOnce
                                | agent_client_protocol::schema::PermissionOptionKind::AllowAlways
                        )
                    })
                    .or_else(|| req.options.first())
                    .map(|o| o.option_id.clone());
                let deny_option = req
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            agent_client_protocol::schema::PermissionOptionKind::RejectOnce
                                | agent_client_protocol::schema::PermissionOptionKind::RejectAlways
                        )
                    })
                    .or_else(|| req.options.last())
                    .map(|o| o.option_id.clone());

                {
                    let mut map = pending_for_handler
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    map.insert(request_id.clone(), decision_tx);
                }

                // Surface the request to the host. The frontend
                // renders a permission card; on click it calls
                // `approve_tool_use`/`deny_tool_use` → pump task →
                // decision_rx fires below.
                emit_permission_request(&events_for_permissions, &request_id, &req);

                match decision_rx.await {
                    Ok(PermissionDecision::Allow { .. }) => {
                        if let Some(id) = allow_option {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(id),
                                ),
                            ))
                        } else {
                            // Malformed agent request with no options
                            // — defensive cancel rather than allowing
                            // by accident.
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            ))
                        }
                    }
                    Ok(PermissionDecision::Deny { .. }) => {
                        if let Some(id) = deny_option {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(id),
                                ),
                            ))
                        } else {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            ))
                        }
                    }
                    Err(_) => responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    )),
                }
            },
            on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            // Step 1: handshake. We declare protocol V1 — that's the
            // only stable version both claude-agent-acp 0.36 and
            // codex-acp 0.14 support.
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;

            // Step 2: create or restore a session rooted at the
            // run's workdir.
            //
            // When `resume_session_id` is set the agent already has
            // the prior conversation transcript under that id —
            // `session/load` rehydrates it so the next prompt
            // continues the same chat. Both claude-agent-acp 0.36
            // and codex-acp 0.14 advertise `loadSession: true` in
            // their initialize response, so this branch is safe to
            // take unconditionally on resume; the connection error
            // is surfaced below if an older agent rejects it.
            //
            // `additional_directories` extends the session's
            // filesystem scope (claude-agent-acp consumes it,
            // codex-acp doesn't advertise the capability and will
            // ignore the field). Forwarding `request.additional_dirs`
            // here preserves the same "vault is accessible from a
            // project repo cwd" behaviour the pre-ACP runner had via
            // `--add-dir`.
            let session_id = if let Some(prior) = resume_session_id {
                let mut load_req = LoadSessionRequest::new(prior.clone(), workdir.clone());
                load_req.additional_directories = additional_directories;
                connection
                    .send_request(load_req)
                    .block_task()
                    .await?;
                // LoadSessionResponse currently carries no payload
                // worth surfacing (modes / models snapshots live on
                // its `_meta`); the session id we should keep using
                // is the one we passed in.
                prior
            } else {
                let mut new_session_req = NewSessionRequest::new(workdir.clone());
                new_session_req.additional_directories = additional_directories;
                let new_session = connection
                    .send_request(new_session_req)
                    .block_task()
                    .await?;
                new_session.session_id
            };

            // Surface the session id immediately so the host can
            // stash it for resume. Pre-ACP runners exposed this via a
            // `system init` JSON line in stdout; ACP returns it
            // structurally, and emitting a dedicated event keeps the
            // frontend free of runner-specific parsing.
            let _ = events_tx.send(RunEvent::SessionStarted {
                session_id: format!("{}", session_id.0),
            });

            // Optional model override. Send only if the host actually
            // picked a non-default model — issuing `session/set_model`
            // on agents that don't advertise the capability (codex-acp
            // 0.14) returns a method-not-found error which the
            // `agent-client-protocol` client surfaces; the model picker
            // UI is informational for codex anyway (codex chooses its
            // own model from `~/.codex/config.toml`). Errors here are
            // demoted to a Stderr event rather than aborting the turn.
            if let Some(model) = model_override {
                let req = SetSessionModelRequest::new(session_id.clone(), ModelId::from(model));
                if let Err(e) = connection.send_request(req).block_task().await {
                    let _ = events_tx.send(RunEvent::Stderr(format!(
                        "acp: set_model rejected (agent may not support per-session model selection): {e}"
                    )));
                }
            }

            // Step 3: send the user message. `connect_with`'s closure
            // returns once this future resolves — the prompt request
            // awaits the agent's full turn (every chunk arrives via
            // the notification handler, the final stop reason is the
            // response).
            tokio::select! {
                resp = connection
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new(prompt))],
                    ))
                    .block_task() => {
                    // resp is Result<PromptResponse, _>; we don't
                    // currently surface the stop reason — the
                    // frontend reads it from the agent_message
                    // chunks. Surface only failures.
                    let _ = resp?;
                }
                _ = wait_for_kill(kill_rx) => {
                    // Drop the connection by returning early — the
                    // client teardown will close the child's stdin
                    // and the subprocess exits on its own.
                    return Ok(());
                }
            }

            Ok(())
        })
        .await;

    // Drop the pump task — its inner blocking recv exits when the
    // sender side (Killer / RunHandle) is dropped, which happens
    // shortly after we return.
    pump_handle.abort();

    result.map_err(|e| format!("acp: {e}"))
}

/// Translate ACP's `RequestPermissionRequest` into our
/// `PermissionRequest` event shape and emit it. Done in a helper to
/// keep the handler closure compact and so we have one place to
/// adjust the ad-hoc field synthesis (ACP's `tool_call.title` →
/// our `title`, etc.) when the schema grows.
fn emit_permission_request(
    events_tx: &mpsc::Sender<RunEvent>,
    request_id: &str,
    req: &agent_client_protocol::schema::RequestPermissionRequest,
) {
    let tool_call = &req.tool_call;
    let tool_name = tool_call
        .fields
        .kind
        .as_ref()
        .map(|k| format!("{:?}", k))
        .unwrap_or_else(|| "Tool".to_string());
    // The `_meta` and tool_input round-trip as opaque JSON for the
    // frontend renderer — it reads `tool_input.command` etc. but
    // doesn't care about the discriminator.
    let tool_input = tool_call
        .fields
        .raw_input
        .clone()
        .unwrap_or(serde_json::Value::Null);
    let title = tool_call.fields.title.clone();
    let payload = PermissionRequest {
        request_id: request_id.to_string(),
        tool_name,
        tool_input,
        tool_use_id: format!("{}", tool_call.tool_call_id.0),
        title,
        display_name: None,
        description: None,
    };
    let _ = events_tx.send(RunEvent::PermissionRequest(payload));
}

/// Concatenate the request prompt + any runtime input under an
/// `## Additional input` heading. Mirrors the same shape both
/// `ClaudeRunner` and `CodexRunner` produced before the ACP move —
/// the on-the-wire user message stays consistent so chat history
/// from pre-ACP sessions still parses sensibly.
fn build_prompt(req: &RunRequest) -> String {
    let mut s = req.prompt.clone();
    if let Some(extra) = req.runtime_input.as_ref().filter(|s| !s.trim().is_empty()) {
        s.push_str("\n\n## Additional input\n\n");
        s.push_str(extra);
        s.push('\n');
    }
    s
}

/// Park a tokio task on a sync `mpsc::Receiver<()>` without blocking
/// the runtime. `spawn_blocking` is the canonical bridge: tokio
/// moves the blocking recv onto its blocking-pool thread, then yields
/// the join result back into the async select.
async fn wait_for_kill(rx: mpsc::Receiver<()>) {
    let _ = tokio::task::spawn_blocking(move || rx.recv()).await;
}

#[allow(dead_code)]
fn _silence_unused_imports() {
    // Touch SessionUpdate + PermissionOptionId so a future evolution
    // of the renderer / option discrimination keeps these imports
    // grounded.
    let _ = std::any::type_name::<SessionUpdate>();
    let _ = std::any::type_name::<PermissionOptionId>();
}

#[cfg(test)]
mod wire_shape_tests {
    //! Snapshot the wire shape `SessionUpdate` variants serialise to.
    //! This grounds the frontend's renderer expectations (`toolCallId`
    //! vs `tool_call_id`, where the tool id lives, etc.) — if the
    //! crate ever changes serde semantics the assertions below catch
    //! it before users see broken dedup.

    use agent_client_protocol::schema::{
        SessionUpdate, ToolCall, ToolCallId, ToolCallUpdate, ToolCallUpdateFields,
    };

    #[test]
    fn tool_call_serialises_with_tool_call_id_at_top_level() {
        let tc = ToolCall::new(ToolCallId::from("tc-abc"), "mkdir foo");
        let json = serde_json::to_value(SessionUpdate::ToolCall(tc)).unwrap();
        assert_eq!(json["sessionUpdate"], "tool_call");
        // The field we dedup on. If this ever moves the frontend
        // dedup needs to follow.
        assert_eq!(json["toolCallId"], "tc-abc");
        assert_eq!(json["title"], "mkdir foo");
    }

    #[test]
    fn tool_call_update_serialises_with_tool_call_id_at_top_level() {
        let upd = ToolCallUpdate::new(ToolCallId::from("tc-abc"), ToolCallUpdateFields::default());
        let json = serde_json::to_value(SessionUpdate::ToolCallUpdate(upd)).unwrap();
        assert_eq!(json["sessionUpdate"], "tool_call_update");
        assert_eq!(json["toolCallId"], "tc-abc");
    }
}
