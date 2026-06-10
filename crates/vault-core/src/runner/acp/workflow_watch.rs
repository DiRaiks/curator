//! Surface `Workflow`-tool subagent progress that never crosses the ACP
//! wire.
//!
//! When an agent calls the `Workflow` tool, the CLI orchestrates its
//! subagents *inside its own process* and persists them only to
//! `~/.claude/projects/<project>/<session-id>/subagents/workflows/<run>/`
//! — a `journal.jsonl` (one `started` / `result` event per subagent)
//! plus per-agent transcripts. None of that is emitted as a
//! `session/update`, so the host sees a single `→ Workflow` tool call
//! and then silence until the parent turn finishes (or hangs).
//!
//! This module closes that gap without inventing a new event channel.
//! A lightweight poll loop tails each run's `journal.jsonl` and, for
//! every new `started` / `result` transition, synthesises an ACP
//! `tool_call` / `tool_call_update` notification tagged with
//! `_meta.claudeCode.parentToolUseId`. Those ride the existing stdout
//! `RunEvent` channel and render through the same path as real tool
//! calls — the frontend already indents anything carrying a
//! `parentToolUseId` (see `acpRender.ts`), so each workflow subagent
//! shows up as a nested, in-place-updating line under the run.
//!
//! The watch runs on its own `std::thread` (spawned by the transport)
//! rather than a tokio task: the per-run runtime is single-threaded, so
//! doing blocking journal I/O there would stall the ACP notification
//! pipe. A dedicated OS thread keeps that I/O off the async path and is
//! stopped via the `shutdown` flag the transport flips when the turn
//! ends. Everything above [`watch_workflows`] is pure (no I/O) so the
//! journal→notification transform is unit-tested against the real
//! on-disk schema.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::runner::RunEvent;

/// How often the journal directory is swept. A progress view doesn't
/// need sub-second latency; 750 ms keeps the loop cheap while feeling
/// live.
const POLL_INTERVAL: Duration = Duration::from_millis(750);

/// Max characters of a subagent's `result` payload surfaced inline.
const SUMMARY_MAX: usize = 200;

/// Which lifecycle point we've already surfaced for a given
/// `(run, agent)` pair. The journal is append-only and re-read in full
/// each sweep, so this gate is what keeps the loop from re-emitting a
/// line for every agent on every poll.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AgentPhase {
    Started,
    Done,
}

/// Pure, I/O-free tracker that turns journal lines into synthetic ACP
/// notification JSON. One instance lives for the duration of a watch.
#[derive(Default)]
pub(crate) struct WorkflowProgress {
    /// `<run_id>\0<agent_id>` → highest phase already surfaced.
    seen: HashMap<String, AgentPhase>,
}

impl WorkflowProgress {
    /// Feed one raw `journal.jsonl` line for `run_id`. Returns a
    /// synthetic ACP `session/update` JSON string to forward when the
    /// line is a genuine new transition, or `None` for duplicates,
    /// unrelated event types, or unparseable input.
    pub(crate) fn ingest(&mut self, run_id: &str, line: &str) -> Option<String> {
        let v: Value = serde_json::from_str(line.trim()).ok()?;
        let kind = v.get("type")?.as_str()?;
        let agent_id = v.get("agentId")?.as_str()?;
        let key = format!("{run_id}\u{0}{agent_id}");

        match kind {
            "started" => {
                // First `started` wins. Retries re-emit `started` with
                // the same agent id — skip those.
                if self.seen.contains_key(&key) {
                    return None;
                }
                self.seen.insert(key, AgentPhase::Started);
                Some(synth_tool_call(run_id, agent_id))
            }
            "result" => {
                if self.seen.get(&key) == Some(&AgentPhase::Done) {
                    return None;
                }
                self.seen.insert(key, AgentPhase::Done);
                let summary = v.get("result").map(summarize_result).unwrap_or_default();
                Some(synth_tool_call_update(run_id, agent_id, &summary))
            }
            _ => None,
        }
    }
}

/// Build the synthetic `tool_call` for a subagent that just started.
/// `kind: "think"` is the closest neutral [`ToolKind`] the renderer
/// knows; `parentToolUseId` is a synthetic `wf:<run>` id whose only job
/// is to trip the frontend's subagent-indent (it need not match a real
/// tool-call id — the renderer treats the field as a presence flag).
fn synth_tool_call(run_id: &str, agent_id: &str) -> String {
    json!({
        "sessionUpdate": "tool_call",
        "toolCallId": format!("wf:{run_id}:{agent_id}"),
        "title": format!("workflow · {}", short_id(agent_id)),
        "kind": "think",
        "_meta": { "claudeCode": { "parentToolUseId": format!("wf:{run_id}") } },
    })
    .to_string()
}

/// Build the synthetic `tool_call_update` marking a subagent done. An
/// empty `summary` yields a bare `← completed`; a non-empty one renders
/// the text beneath it.
fn synth_tool_call_update(run_id: &str, agent_id: &str, summary: &str) -> String {
    let content = if summary.is_empty() {
        json!([])
    } else {
        json!([{ "type": "content", "content": { "type": "text", "text": summary } }])
    };
    json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": format!("wf:{run_id}:{agent_id}"),
        "status": "completed",
        "content": content,
        "_meta": { "claudeCode": { "parentToolUseId": format!("wf:{run_id}") } },
    })
    .to_string()
}

/// First 8 characters (not bytes) of an agent id, for a compact label.
fn short_id(agent_id: &str) -> &str {
    let end = agent_id
        .char_indices()
        .nth(8)
        .map(|(i, _)| i)
        .unwrap_or(agent_id.len());
    &agent_id[..end]
}

/// Pick a short human summary from a subagent's `result` payload. The
/// shape is workflow-defined and arbitrary, so prefer a few common
/// descriptive keys, then any string field, then a compact JSON dump —
/// always clipped to [`SUMMARY_MAX`].
fn summarize_result(v: &Value) -> String {
    const PREFERRED: [&str; 5] = ["surface", "summary", "title", "verdict", "description"];
    let raw = match v {
        Value::String(s) => s.clone(),
        Value::Object(map) => PREFERRED
            .iter()
            .find_map(|k| map.get(*k).and_then(Value::as_str).map(str::to_string))
            .or_else(|| map.values().find_map(|x| x.as_str().map(str::to_string)))
            .unwrap_or_else(|| v.to_string()),
        other => other.to_string(),
    };
    clip(&raw, SUMMARY_MAX)
}

/// Flatten newlines and clip to `max` *characters* (UTF-8 safe).
fn clip(s: &str, max: usize) -> String {
    let s = s.replace(['\n', '\r'], " ");
    if s.chars().count() <= max {
        return s;
    }
    let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{truncated}…")
}

/// Resolve a session's workflow directory by globbing
/// `<home>/.claude/projects/*/<session_id>/subagents/workflows`. The
/// session id is a UUID, so this matches at most one project dir —
/// avoiding any need to reproduce Claude's cwd-path encoding. Returns
/// `None` until the directory exists (i.e. until the first workflow
/// run writes to it).
fn find_session_workflows_dir(home: &str, session_id: &str) -> Option<PathBuf> {
    let projects = Path::new(home).join(".claude").join("projects");
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let candidate = entry
            .path()
            .join(session_id)
            .join("subagents")
            .join("workflows");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// Names of the `wf_*` run directories currently present under `dir`.
fn existing_run_ids(dir: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    set.insert(name.to_string());
                }
            }
        }
    }
    set
}

/// Read newly-appended *complete* lines from `journal`, advancing the
/// per-file byte offset in `offsets`. Partial trailing lines (no
/// newline yet) are left for the next sweep. A shrunken file (rotation
/// / truncation) resets the offset to 0. A non-UTF-8 read advances the
/// offset to end-of-file so the loop doesn't retry the same bad bytes
/// forever.
fn read_new_lines(journal: &Path, offsets: &mut HashMap<PathBuf, u64>) -> Vec<String> {
    let mut file = match std::fs::File::open(journal) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let prev = *offsets.get(journal).unwrap_or(&0);
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = if len < prev { 0 } else { prev };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        // Non-UTF-8 / IO error: skip the unreadable range so the next
        // sweep makes forward progress instead of re-failing on it.
        offsets.insert(journal.to_path_buf(), len);
        return Vec::new();
    }
    // Only consume through the last newline so a half-written final
    // line isn't parsed mid-flush.
    let consumed = match buf.rfind('\n') {
        Some(i) => i + 1,
        None => 0,
    };
    offsets.insert(journal.to_path_buf(), start + consumed as u64);
    buf[..consumed]
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// One sweep over every `wf_*` run directory not present in `baseline`
/// (those belong to earlier turns in a resumed session). Returns
/// `false` if the event channel has disconnected (consumer gone) so the
/// caller stops.
fn sweep_once(
    dir: &Path,
    baseline: &HashSet<String>,
    progress: &mut WorkflowProgress,
    offsets: &mut HashMap<PathBuf, u64>,
    events_tx: &mpsc::Sender<RunEvent>,
) -> bool {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return true,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let run_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Skip runs that predate this turn.
        if baseline.contains(&run_id) {
            continue;
        }
        let journal = path.join("journal.jsonl");
        for line in read_new_lines(&journal, offsets) {
            if let Some(notification) = progress.ingest(&run_id, &line) {
                if events_tx.send(RunEvent::Stdout(notification)).is_err() {
                    return false;
                }
            }
        }
    }
    true
}

/// Watch one ACP session's workflow journals on a dedicated thread.
/// Tails any run directory created *after* the watch started (prior
/// runs in a resumed session are baselined out) and forwards synthetic
/// notifications onto `events_tx`. Exits when `shutdown` is set — doing
/// one last sweep first to catch journal writes that landed just before
/// the turn ended — or when the event consumer disconnects.
pub(crate) fn watch_workflows(
    home: String,
    session_id: String,
    events_tx: mpsc::Sender<RunEvent>,
    shutdown: Arc<AtomicBool>,
) {
    let mut progress = WorkflowProgress::default();
    let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
    // Snapshot the runs that already exist as the turn begins; they're
    // from earlier turns in this (resumed) session and must not be
    // re-surfaced. The workflow tool only ever creates fresh `wf_*`
    // dirs, so anything not in this set is this turn's work.
    let baseline = find_session_workflows_dir(&home, &session_id)
        .map(|dir| existing_run_ids(&dir))
        .unwrap_or_default();

    loop {
        let stopping = shutdown.load(Ordering::Relaxed);
        if let Some(dir) = find_session_workflows_dir(&home, &session_id) {
            if !sweep_once(&dir, &baseline, &mut progress, &mut offsets, &events_tx) {
                return;
            }
        }
        if stopping {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn started_emits_nested_tool_call_then_dedups() {
        let mut p = WorkflowProgress::default();
        let line = r#"{"type":"started","key":"v2:abc","agentId":"a11456e4d6e246b6c"}"#;

        let out = p.ingest("wf_run1", line).expect("first started emits");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sessionUpdate"], "tool_call");
        assert_eq!(v["toolCallId"], "wf:wf_run1:a11456e4d6e246b6c");
        assert_eq!(v["_meta"]["claudeCode"]["parentToolUseId"], "wf:wf_run1");
        assert_eq!(v["title"], "workflow · a11456e4");

        // Same agent started again (a retry) is a no-op.
        assert!(p.ingest("wf_run1", line).is_none());
    }

    #[test]
    fn result_emits_completion_with_summary_then_dedups() {
        let mut p = WorkflowProgress::default();
        let line = r#"{"type":"result","key":"v2:def","agentId":"a81ef15262b29c88d","result":{"surface":"RPC proxy"}}"#;

        let out = p.ingest("wf_run1", line).expect("result emits");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sessionUpdate"], "tool_call_update");
        assert_eq!(v["toolCallId"], "wf:wf_run1:a81ef15262b29c88d");
        assert_eq!(v["status"], "completed");
        assert_eq!(v["content"][0]["content"]["text"], "RPC proxy");
        assert_eq!(v["_meta"]["claudeCode"]["parentToolUseId"], "wf:wf_run1");

        assert!(p.ingest("wf_run1", line).is_none());
    }

    #[test]
    fn result_without_summary_yields_empty_content() {
        let mut p = WorkflowProgress::default();
        let line = r#"{"type":"result","key":"v2:def","agentId":"a1"}"#;
        let out = p.ingest("wf_run1", line).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["content"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn unrelated_and_malformed_lines_are_ignored() {
        let mut p = WorkflowProgress::default();
        assert!(p.ingest("r", r#"{"type":"phase","agentId":"x"}"#).is_none());
        assert!(p.ingest("r", "not json").is_none());
        assert!(p.ingest("r", r#"{"type":"started"}"#).is_none()); // no agentId
        assert!(p.ingest("r", "").is_none());
    }

    #[test]
    fn distinct_agents_each_emit() {
        let mut p = WorkflowProgress::default();
        let a = r#"{"type":"started","key":"v2:k","agentId":"agentA"}"#;
        let b = r#"{"type":"started","key":"v2:k","agentId":"agentB"}"#;
        assert!(p.ingest("run", a).is_some());
        assert!(
            p.ingest("run", b).is_some(),
            "same key, different agent still emits"
        );
    }

    #[test]
    fn summarize_prefers_descriptive_keys_then_falls_back() {
        assert_eq!(
            summarize_result(&json!({"surface": "amount math"})),
            "amount math"
        );
        assert_eq!(summarize_result(&json!({"other": "lonely"})), "lonely");
        assert_eq!(summarize_result(&json!("plain string")), "plain string");
        // Non-string, no string fields → compact JSON dump.
        let n = summarize_result(&json!({"count": 3}));
        assert!(n.contains("count"));
    }

    #[test]
    fn summarize_clips_and_flattens_newlines() {
        let long = "x".repeat(500);
        let out = summarize_result(&json!({ "surface": long }));
        assert!(out.chars().count() <= SUMMARY_MAX);
        assert!(out.ends_with('…'));
        assert_eq!(summarize_result(&json!({"surface": "a\nb"})), "a b");
    }

    #[test]
    fn short_id_is_utf8_safe() {
        // Multi-byte chars must not panic or split a code point.
        assert_eq!(short_id("☃☃☃☃☃☃☃☃☃☃"), "☃☃☃☃☃☃☃☃");
        assert_eq!(short_id("abc"), "abc");
    }

    #[test]
    fn read_new_lines_returns_only_appended_complete_lines() {
        let tmp = std::env::temp_dir().join(format!("curator-wf-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let journal = tmp.join("journal.jsonl");
        let mut offsets = HashMap::new();

        std::fs::write(&journal, "line-1\nline-2\n").unwrap();
        assert_eq!(
            read_new_lines(&journal, &mut offsets),
            vec!["line-1", "line-2"]
        );

        // Append one complete + one partial line; only the complete one
        // is returned, the partial waits.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&journal)
                .unwrap();
            f.write_all(b"line-3\npartial").unwrap();
        }
        assert_eq!(read_new_lines(&journal, &mut offsets), vec!["line-3"]);

        // Finish the partial line; now it comes through.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&journal)
                .unwrap();
            f.write_all(b"-done\n").unwrap();
        }
        assert_eq!(read_new_lines(&journal, &mut offsets), vec!["partial-done"]);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_new_lines_resets_on_truncation() {
        let tmp = std::env::temp_dir().join(format!("curator-wf-trunc-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let journal = tmp.join("journal.jsonl");
        let mut offsets = HashMap::new();

        std::fs::write(&journal, "old-a\nold-b\nold-c\n").unwrap();
        assert_eq!(read_new_lines(&journal, &mut offsets).len(), 3);

        // File shrinks (rotation / rewrite) — offset must reset to 0 so
        // the new, shorter content is read from the top.
        std::fs::write(&journal, "fresh\n").unwrap();
        assert_eq!(read_new_lines(&journal, &mut offsets), vec!["fresh"]);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn find_session_workflows_dir_matches_uuid_under_any_project() {
        let home = std::env::temp_dir().join(format!("curator-home-test-{}", std::process::id()));
        let session = "11111111-2222-3333-4444-555555555555";
        let wf = home
            .join(".claude")
            .join("projects")
            .join("-Some-Encoded-Project")
            .join(session)
            .join("subagents")
            .join("workflows");
        std::fs::create_dir_all(&wf).unwrap();

        let found = find_session_workflows_dir(home.to_str().unwrap(), session);
        assert_eq!(found.as_deref(), Some(wf.as_path()));

        assert!(find_session_workflows_dir(home.to_str().unwrap(), "no-such-session").is_none());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn sweep_skips_baselined_runs() {
        let tmp = std::env::temp_dir().join(format!("curator-wf-base-{}", std::process::id()));
        let wf = tmp.join("workflows");
        let old_run = wf.join("wf_old");
        let new_run = wf.join("wf_new");
        std::fs::create_dir_all(&old_run).unwrap();
        std::fs::create_dir_all(&new_run).unwrap();
        std::fs::write(
            old_run.join("journal.jsonl"),
            "{\"type\":\"started\",\"key\":\"k\",\"agentId\":\"old1\"}\n",
        )
        .unwrap();
        std::fs::write(
            new_run.join("journal.jsonl"),
            "{\"type\":\"started\",\"key\":\"k\",\"agentId\":\"new1\"}\n",
        )
        .unwrap();

        // Baseline captured "wf_old" — only "wf_new" should surface.
        let baseline: HashSet<String> = ["wf_old".to_string()].into_iter().collect();
        let mut progress = WorkflowProgress::default();
        let mut offsets = HashMap::new();
        let (tx, rx) = mpsc::channel();

        assert!(sweep_once(&wf, &baseline, &mut progress, &mut offsets, &tx));
        drop(tx);

        let emitted: Vec<String> = rx
            .iter()
            .map(|e| match e {
                RunEvent::Stdout(s) => s,
                _ => String::new(),
            })
            .collect();
        assert_eq!(emitted.len(), 1, "only the non-baselined run emits");
        assert!(emitted[0].contains("new1"));
        assert!(!emitted[0].contains("old1"));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
