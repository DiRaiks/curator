import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getRunStatus,
  onRunEvents,
  resumeRun,
  stopRun,
  type RunExitEvent,
  type RunStartedEvent,
} from "../api";
import { Tooltip } from "./Tooltip";

/**
 * Persistent bottom drawer that streams the active run's output. The slice 1
 * shape is intentionally rigid:
 *
 * - fixed height (resize handle is slice 2)
 * - single run at a time (the Tauri shell rejects concurrent starts)
 * - in-memory output only, never persisted to disk
 * - manual collapse hides the panel; the next run auto-expands it again
 *
 * Lines are stored as `{ kind, text }` so the renderer can color stderr
 * differently. We don't word-wrap programmatically — the `<pre>` does it
 * via CSS so the renderer stays cheap on long outputs.
 */

type LineKind = "stdout" | "stderr" | "system";

interface OutputLine {
  kind: LineKind;
  text: string;
}

type RunStatus =
  | { kind: "idle" }
  | { kind: "running"; started: RunStartedEvent }
  | { kind: "stopping"; started: RunStartedEvent }
  | { kind: "exited"; exit: RunExitEvent; started: RunStartedEvent | null };

/**
 * Cumulative usage across all turns of the current Claude session.
 * Resets to `EMPTY_USAGE` on a fresh `start_run`, persists across
 * `resume_run` turns within the same `session_id`.
 *
 * Tokens are summed live from `message.usage` on every `assistant`
 * event. `costUsd` is summed from each turn's `result` event — claude
 * only reports cost at the end of a turn, so the header cost lags the
 * token counters by one turn boundary.
 */
interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string | null;
}

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  model: null,
};

const MAX_RETAINED_LINES = 5000;

export function RunPanel() {
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const outputRef = useRef<HTMLPreElement | null>(null);

  // Claude session id captured from the first `system init` event in the
  // stream. Once it's set, the user can resume the conversation via the
  // Reply box after the run exits. It survives `run:started` of a resumed
  // run (claude reuses the same session id under `--resume`).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage>(EMPTY_USAGE);

  // Append helper — caps the retained tail at MAX_RETAINED_LINES so a
  // pathological run doesn't blow up the DOM. The backend's own 4 MB cap
  // already bounds total bytes; this is a second-line guard against very
  // long output dominated by short lines.
  const appendLine = useCallback((line: OutputLine) => {
    setLines((prev) => {
      const next = prev.length >= MAX_RETAINED_LINES
        ? [...prev.slice(prev.length - MAX_RETAINED_LINES + 1), line]
        : [...prev, line];
      return next;
    });
  }, []);

  useEffect(() => {
    let detach: (() => void) | null = null;
    let cancelled = false;

    const attach = async () => {
      // Synchronise local state with backend on mount. The lifecycle
      // events tell us about transitions, but on a remount during an
      // active run we'd otherwise show "idle" until the next event
      // arrives — possibly never if the run is in a long quiet phase.
      try {
        const snapshot = await getRunStatus();
        if (cancelled) return;
        if (snapshot.active) {
          // Mount-time sync: the backend hands back the same payload
          // the original `run:started` carried, so a remount during an
          // active run (HMR in dev, IDE restart) recovers the full
          // context — including vaultRoot — needed for Reply / Resume.
          // Falls back to placeholders only when backend somehow lacks
          // the snapshot, which shouldn't happen but isn't fatal.
          setStatus({
            kind: "running",
            started: snapshot.started ?? {
              projectSlug: "(in progress)",
              promptId: "?",
              vaultRoot: "",
              workdir: "",
              runner: "claude-code",
              resume: false,
            },
          });
          setCollapsed(false);
        }
      } catch {
        // Best-effort sync. Non-fatal: events alone will recover.
      }

      const un = await onRunEvents({
        onStarted: (ev) => {
          if (ev.resume) {
            // Resume: keep the prior conversation buffer, append a
            // separator so the boundary is visible. Session id stays.
            setLines((prev) => [
              ...prev,
              {
                kind: "system",
                text: `▶ resume ${ev.runner} · ${ev.projectSlug}/${ev.promptId}`,
              },
            ]);
          } else {
            // Fresh run: drop the previous output buffer and the prior
            // session id (the new stream will emit a new system init
            // with its own session id). Usage counters also reset —
            // they're per-session.
            setLines([
              {
                kind: "system",
                text: `▶ start ${ev.runner} · ${ev.projectSlug}/${ev.promptId} · cwd: ${ev.workdir}`,
              },
            ]);
            setSessionId(null);
            setUsage(EMPTY_USAGE);
          }
          setReplyDraft("");
          setReplyError(null);
          setStatus({ kind: "running", started: ev });
          setCollapsed(false);
        },
        onStdout: (ev) => {
          // Capture the session id once per stream so the Reply box can
          // resume the conversation after exit. Subsequent system events
          // in the same run carry the same id; setSessionId is idempotent
          // on identical values.
          const sid = extractClaudeSessionId(ev.line);
          if (sid) setSessionId(sid);
          // Accumulate usage / cost from this line. Token deltas come
          // from `assistant.message.usage`; final per-turn cost comes
          // from the `result` event. Both contribute to the running
          // total displayed in the header.
          const delta = extractClaudeUsageDelta(ev.line);
          if (delta) {
            setUsage((prev) => mergeUsage(prev, delta));
          }
          for (const rendered of renderClaudeStreamLine(ev.line)) {
            appendLine({ kind: rendered.kind, text: rendered.text });
          }
        },
        onStderr: (ev) => appendLine({ kind: "stderr", text: ev.line }),
        onTruncated: (ev) =>
          appendLine({
            kind: "system",
            text: `… output capped — ${formatBytes(ev.droppedBytes)} dropped`,
          }),
        onExit: (ev) => {
          appendLine({
            kind: "system",
            text: ev.success
              ? `✔ exit 0`
              : `✘ exit ${ev.code === null ? "?" : ev.code}`,
          });
          setStatus((prev) => ({
            kind: "exited",
            exit: ev,
            started:
              prev.kind === "running" || prev.kind === "stopping"
                ? prev.started
                : null,
          }));
        },
      });
      if (cancelled) {
        un();
      } else {
        detach = un;
      }
    };

    // Surface listener-attach failures into the panel itself so a broken
    // IPC subscription doesn't manifest as "Run did nothing".
    attach().catch((err) => {
      if (cancelled) return;
      const text = err instanceof Error ? err.message : String(err);
      appendLine({
        kind: "system",
        text: `! failed to attach run listeners: ${text}`,
      });
      setCollapsed(false);
    });

    return () => {
      cancelled = true;
      if (detach) detach();
    };
  }, [appendLine]);

  // Stick the scroll to the bottom whenever a new line lands, unless the
  // user has scrolled up — detected by checking if we were already at the
  // bottom before the new line was appended. This is the standard
  // "follow tail unless I look away" pattern.
  const followTail = useRef(true);
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    if (followTail.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const onScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    followTail.current = atBottom;
  }, []);

  /**
   * Reply box is shown only when:
   * - the run has finished (so we're not racing with claude's stdin), AND
   * - we captured a session id from the stream (resume target known), AND
   * - we still know the (project, prompt) we ran against (so the backend
   *   can re-derive cwd / `--add-dir` for the resumed spawn).
   */
  const canReply =
    status.kind === "exited" &&
    sessionId !== null &&
    status.started !== null;

  const onSendReply = useCallback(async () => {
    if (status.kind !== "exited" || status.started === null || sessionId === null) {
      return;
    }
    const trimmed = replyDraft.trim();
    if (trimmed === "") return;
    const started = status.started;
    // Defensive: if mount-time sync ever fails to recover real context
    // (backend doesn't know about the run, ancient IDE state, etc.),
    // surface a clear error instead of relaying the cryptic
    // "vault root not accessible: <empty>" the spawn would emit.
    if (started.vaultRoot === "" || started.projectSlug === "(in progress)") {
      setReplyError(
        "Lost track of which vault this run started against — try a fresh run.",
      );
      return;
    }
    setSending(true);
    setReplyError(null);
    try {
      await resumeRun({
        vaultRoot: started.vaultRoot,
        projectSlug: started.projectSlug,
        promptId: started.promptId,
        sessionId,
        reply: trimmed,
      });
      // `run:started` flips status to "running" and clears replyDraft.
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [status, sessionId, replyDraft]);

  const onStop = useCallback(async () => {
    if (status.kind !== "running") return;
    const startedSnapshot = status.started;
    setStatus({ kind: "stopping", started: startedSnapshot });
    try {
      await stopRun();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      appendLine({ kind: "system", text: `! stop failed: ${text}` });
      // Roll back the optimistic "stopping" so the Stop button reappears
      // and the user isn't stuck looking at "Stopping…" forever. We don't
      // know whether the subprocess is dead or alive; treat it as still
      // running so the next click can try again.
      setStatus((prev) =>
        prev.kind === "stopping"
          ? { kind: "running", started: startedSnapshot }
          : prev,
      );
    }
  }, [status, appendLine]);

  const statusLabel = useMemo(() => describeStatus(status), [status]);

  if (collapsed && status.kind === "idle") return null;

  return (
    <aside
      className={
        "run-panel" + (collapsed ? " run-panel--collapsed" : "")
      }
      aria-label="Agent run output"
    >
      <header className="run-panel__header">
        <span className="run-panel__title">Run</span>
        <span className={"run-panel__status run-panel__status--" + status.kind}>
          {statusLabel}
        </span>
        {hasUsage(usage) && (
          <Tooltip
            content={formatUsageTooltip(usage)}
            placement="top"
            align="end"
            ariaLabel="Session usage"
          >
            <span className="run-panel__usage">
              {formatUsageSummary(usage)}
            </span>
          </Tooltip>
        )}
        {status.kind === "running" && (
          <button
            type="button"
            className="btn btn--small btn--danger"
            onClick={onStop}
          >
            Stop
          </button>
        )}
        {status.kind === "stopping" && (
          <button
            type="button"
            className="btn btn--small"
            disabled
          >
            Stopping…
          </button>
        )}
        <button
          type="button"
          className="btn btn--small"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Show" : "Hide"}
        </button>
      </header>
      {!collapsed && (
        <pre
          ref={outputRef}
          className="run-panel__output"
          onScroll={onScroll}
        >
          {lines.length === 0 ? (
            <span className="run-panel__empty">No output yet.</span>
          ) : (
            lines.map((l, i) => (
              <span
                key={i}
                className={"run-panel__line run-panel__line--" + l.kind}
              >
                {l.text}
                {"\n"}
              </span>
            ))
          )}
        </pre>
      )}
      {!collapsed && canReply && (
        <form
          className="run-panel__reply"
          onSubmit={(e) => {
            e.preventDefault();
            void onSendReply();
          }}
        >
          <textarea
            className="run-panel__reply-input"
            value={replyDraft}
            onChange={(e) => setReplyDraft(e.target.value)}
            placeholder="Reply to the agent — answer questions, refine, or continue. Cmd/Ctrl+Enter to send."
            rows={2}
            disabled={sending}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void onSendReply();
              }
            }}
            aria-label="Reply to the agent"
          />
          <div className="run-panel__reply-actions">
            {replyError && (
              <span className="run-panel__reply-error" role="alert">
                {replyError}
              </span>
            )}
            <button
              type="submit"
              className="btn btn--primary btn--small"
              disabled={sending || replyDraft.trim() === ""}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}

function describeStatus(status: RunStatus): string {
  switch (status.kind) {
    case "idle":
      return "idle";
    case "running":
      return `running · ${status.started.projectSlug}/${status.started.promptId}`;
    case "stopping":
      return "stopping…";
    case "exited":
      return status.exit.success
        ? "exited (success)"
        : `exited (code ${status.exit.code ?? "?"})`;
  }
}

/**
 * Pull `session_id` out of Claude's `system` init event without forcing
 * the renderer pipeline to surface it. Returns `null` on any shape we
 * don't recognise — the caller treats absence as "stick with whatever
 * we already had".
 */
// ---------- Session usage tracking ----------

/**
 * A single line's contribution to cumulative usage. Token deltas come
 * from `assistant.message.usage`; cost deltas come from `result.total_cost_usd`.
 * `model` is captured from the first `system init` event we see.
 */
interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string | null;
}

function extractClaudeUsageDelta(raw: string): UsageDelta | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const type = readString(parsed, "type");

  if (type === "system") {
    // System init carries the model — capture it once so the tooltip can
    // show what's running. No token deltas here.
    const model = readString(parsed, "model");
    if (model) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        model,
      };
    }
    return null;
  }

  if (type === "assistant") {
    const message = parsed["message"];
    if (!isRecord(message)) return null;
    const usage = message["usage"];
    if (!isRecord(usage)) return null;
    return {
      inputTokens: readNumber(usage, "input_tokens") ?? 0,
      outputTokens: readNumber(usage, "output_tokens") ?? 0,
      cacheCreationTokens: readNumber(usage, "cache_creation_input_tokens") ?? 0,
      cacheReadTokens: readNumber(usage, "cache_read_input_tokens") ?? 0,
      costUsd: 0,
      model: null,
    };
  }

  if (type === "result") {
    // Final cost arrives at the end of each turn. We add it to the
    // session running total. The result envelope's `usage` block
    // repeats per-turn token counts that are already accounted for by
    // assistant events, so we don't double-count tokens here.
    const cost = readNumber(parsed, "total_cost_usd");
    if (cost == null) return null;
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: cost,
      model: null,
    };
  }

  return null;
}

function mergeUsage(prev: SessionUsage, delta: UsageDelta): SessionUsage {
  return {
    inputTokens: prev.inputTokens + delta.inputTokens,
    outputTokens: prev.outputTokens + delta.outputTokens,
    cacheCreationTokens: prev.cacheCreationTokens + delta.cacheCreationTokens,
    cacheReadTokens: prev.cacheReadTokens + delta.cacheReadTokens,
    costUsd: prev.costUsd + delta.costUsd,
    model: delta.model ?? prev.model,
  };
}

function hasUsage(u: SessionUsage): boolean {
  return (
    u.inputTokens > 0 ||
    u.outputTokens > 0 ||
    u.cacheReadTokens > 0 ||
    u.cacheCreationTokens > 0 ||
    u.costUsd > 0
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatUsageSummary(u: SessionUsage): string {
  const totalIn =
    u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  const parts: string[] = [];
  if (totalIn > 0) parts.push(`${formatTokens(totalIn)} in`);
  if (u.outputTokens > 0) parts.push(`${formatTokens(u.outputTokens)} out`);
  if (u.costUsd > 0) parts.push(formatCost(u.costUsd));
  return parts.join(" · ");
}

function formatUsageTooltip(u: SessionUsage): string {
  const lines: string[] = [];
  lines.push("Session usage (cumulative across resume turns)");
  if (u.model) lines.push(`Model: ${u.model}`);
  lines.push("");
  const totalIn =
    u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  lines.push(`Input total: ${totalIn.toLocaleString()} tokens`);
  if (u.inputTokens > 0)
    lines.push(`  Fresh: ${u.inputTokens.toLocaleString()}`);
  if (u.cacheCreationTokens > 0)
    lines.push(`  Cache create: ${u.cacheCreationTokens.toLocaleString()}`);
  if (u.cacheReadTokens > 0)
    lines.push(`  Cache read: ${u.cacheReadTokens.toLocaleString()}`);
  lines.push(`Output: ${u.outputTokens.toLocaleString()} tokens`);
  if (u.costUsd > 0) {
    lines.push(`Cost so far: ${formatCost(u.costUsd)}`);
  } else {
    // Subscription accounts (Claude Pro / Max / Team / Enterprise)
    // don't get per-call billing; claude omits `total_cost_usd` or
    // emits 0. Token counters still work because `message.usage` is
    // always populated. Make the absence explicit instead of leaving
    // the user wondering whether the run was free.
    lines.push("Cost: not reported (subscription plan)");
  }
  return lines.join("\n");
}

function extractClaudeSessionId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (readString(parsed, "type") !== "system") return null;
  return readString(parsed, "session_id") ?? null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

// ---------- Claude stream-json renderer ----------

interface RenderedLine {
  kind: LineKind;
  text: string;
}

/**
 * Claude Code's `--output-format stream-json --verbose` emits one JSON
 * object per line, each with a `type` field. This function turns the raw
 * line into one or more display-friendly lines. Unknown shapes fall
 * through as plain stdout so we never silently drop output.
 *
 * Format reference (approximate, may change between claude versions):
 *   { type: "system", subtype: "init", ... }            // session start
 *   { type: "assistant", message: { content: [...] } }  // model turn
 *   { type: "user", message: { content: [...] } }       // tool results
 *   { type: "result", subtype: "success"|"error_...", result?: "..." }
 *
 * Inside `message.content[]`:
 *   { type: "text", text: "..." }
 *   { type: "tool_use", name: "Bash", input: {...} }
 *   { type: "tool_result", content: "..." | [...] }
 */
function renderClaudeStreamLine(raw: string): RenderedLine[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [{ kind: "stdout", text: raw }];
  }

  if (!isRecord(obj)) return [{ kind: "stdout", text: raw }];
  const type = readString(obj, "type");

  switch (type) {
    case "system": {
      const subtype = readString(obj, "subtype") ?? "init";
      const model = readString(obj, "model");
      const cwd = readString(obj, "cwd");
      const parts = [`◆ system: ${subtype}`];
      if (model) parts.push(`model=${model}`);
      if (cwd) parts.push(`cwd=${cwd}`);
      return [{ kind: "system", text: parts.join(" · ") }];
    }
    case "assistant":
      return renderMessageContent(obj, "assistant");
    case "user":
      return renderMessageContent(obj, "user");
    case "result": {
      const subtype = readString(obj, "subtype") ?? "?";
      const result = readString(obj, "result");
      const duration = readNumber(obj, "duration_ms");
      const cost = readNumber(obj, "total_cost_usd");
      const parts = [`◆ result: ${subtype}`];
      if (duration != null) parts.push(`${Math.round(duration / 1000)}s`);
      if (cost != null) parts.push(`$${cost.toFixed(4)}`);
      const out: RenderedLine[] = [{ kind: "system", text: parts.join(" · ") }];
      if (result) out.push({ kind: "stdout", text: result });
      return out;
    }
    case "rate_limit_event": {
      // Top-level rate-limit pings — too chatty to show inline and
      // they're not actionable to the user mid-run.
      const info = obj["rate_limit_info"];
      if (isRecord(info)) {
        const status = readString(info, "status");
        if (status && status !== "allowed") {
          return [{ kind: "stderr", text: `⚠ rate limit: ${status}` }];
        }
      }
      return [];
    }
    case "stream_event":
      // Internal stream-level event (e.g. partial-message deltas in newer
      // claude versions). Not interesting at this rendering level.
      return [];
    default:
      return [{ kind: "stdout", text: raw }];
  }
}

function renderMessageContent(
  envelope: Record<string, unknown>,
  role: "assistant" | "user",
): RenderedLine[] {
  const message = envelope["message"];
  if (!isRecord(message)) return [];
  const content = message["content"];
  if (!Array.isArray(content)) return [];

  const out: RenderedLine[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const btype = readString(block, "type");
    switch (btype) {
      case "text": {
        const text = readString(block, "text");
        if (text) out.push({ kind: "stdout", text });
        break;
      }
      case "thinking": {
        // Extended-thinking blocks are verbose chain-of-thought — render
        // a tiny one-line marker so the user sees "the agent is thinking"
        // without flooding the panel. First ~120 chars of the content
        // are enough to confirm something is happening.
        const text = readString(block, "thinking") ?? "";
        const head = truncate(text.replace(/\s+/g, " ").trim(), 120);
        out.push({
          kind: "system",
          text: head === "" ? `🧠 thinking…` : `🧠 ${head}`,
        });
        break;
      }
      case "tool_use": {
        const name = readString(block, "name") ?? "?";
        const input = block["input"];
        const summary = summarizeToolInput(name, input);
        out.push({ kind: "system", text: `→ ${name}${summary}` });
        break;
      }
      case "tool_result": {
        const c = block["content"];
        const isError = readBool(block, "is_error") === true;
        const summary = summarizeToolResult(c);
        out.push({
          kind: isError ? "stderr" : "system",
          text: `← ${isError ? "error: " : ""}${summary}`,
        });
        break;
      }
      default: {
        // Unknown block kind — show role + a hint so debugging is possible.
        out.push({
          kind: "system",
          text: `(${role}: unknown block ${btype ?? "?"})`,
        });
      }
    }
  }
  return out;
}

function summarizeToolInput(_name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  // Common cases: command/file_path/pattern for first-class tools.
  const fields = ["command", "file_path", "path", "pattern", "url", "prompt"];
  for (const f of fields) {
    const v = readString(input, f);
    if (v) return ` ${truncate(v, 200)}`;
  }
  return "";
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return truncate(content, 240);
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .map((b) => readString(b, "text") ?? "")
      .filter((s) => s !== "")
      .join(" ");
    return truncate(text || "(no text)", 240);
  }
  return "(non-text result)";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function readNumber(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}
