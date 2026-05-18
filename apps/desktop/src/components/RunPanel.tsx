import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getRunStatus,
  onRunEvents,
  stopRun,
  type RunExitEvent,
  type RunStartedEvent,
} from "../api";

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

const MAX_RETAINED_LINES = 5000;

export function RunPanel() {
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const outputRef = useRef<HTMLPreElement | null>(null);

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
          setStatus({
            kind: "running",
            started: {
              projectSlug: "(in progress)",
              promptId: "?",
              workdir: "",
              runner: "claude-code",
            },
          });
          setCollapsed(false);
        }
      } catch {
        // Best-effort sync. Non-fatal: events alone will recover.
      }

      const un = await onRunEvents({
        onStarted: (ev) => {
          // New run: clear any leftover output from the previous one and
          // surface a header line so the user sees what's actually running.
          setLines([
            {
              kind: "system",
              text: `▶ start ${ev.runner} · ${ev.projectSlug}/${ev.promptId} · cwd: ${ev.workdir}`,
            },
          ]);
          setStatus({ kind: "running", started: ev });
          setCollapsed(false);
        },
        onStdout: (ev) => {
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
