/**
 * Pure helpers that transform ACP `SessionUpdate` JSON into displayable
 * chat lines, classify streaming-line visibility for replay
 * anticipation, and pull usage / content data out of nested payloads.
 *
 * Extracted from `components/RunPanel.tsx` so the unit tests have a
 * direct surface to import; the React component now consumes these
 * via plain imports and stays focused on lifecycle wiring.
 *
 * Everything here is side-effect-free except `extractAcpUsageDelta`,
 * which maintains a module-local cumulative-usage baseline (codex /
 * claude send running totals, not deltas, so we subtract). The
 * baseline is explicitly resettable via `resetAcpUsageBaseline()` —
 * tests must reset between cases or the baseline carries over.
 */

/** Visual kind of an output line — drives both styling and dedup
 *  scoping. Lines of different kinds never merge or dedup against
 *  each other. */
export type LineKind = "stdout" | "stderr" | "system" | "user";

/** Parsed ACP `SessionUpdate`. `obj` is the deserialized JSON when
 *  the line parses as an object; `null` for unparseable / non-JSON
 *  lines (those fall back to raw stdout in the consumer). `raw` is
 *  carried so the renderer can echo lines we don't recognise. */
export interface ParsedAcpUpdate {
  obj: Record<string, unknown> | null;
  raw: string;
}

/** Output of a renderer call. The consumer copies these into the
 *  chat buffer; the `streaming` / `toolCallId` / `hidden` fields
 *  drive coalescing, id-keyed replacement, and replay-anticipation
 *  visibility respectively. */
export interface RenderedLine {
  kind: LineKind;
  text: string;
  streaming?: boolean;
  toolCallId?: string;
  hidden?: boolean;
}

/** One stream-line's contribution to cumulative session usage.
 *  Tokens are deltas (already subtracted against the prior baseline);
 *  `costUsd` is also a delta (>= 0). `model` reports the model name
 *  when the agent identifies one, `null` otherwise. */
export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string | null;
}

/** Structural shape used by `classifyStreamingVisibility` —
 *  intentionally smaller than the full `OutputLine` so callers can
 *  pass slices of their state without importing component-internal
 *  types. */
export interface LineSnapshot {
  kind: LineKind;
  text: string;
}

// ---------- ACP `session/update` parsing ----------

export function parseAcpUpdate(raw: string): ParsedAcpUpdate | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed[0] !== "{") return { obj: null, raw };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return { obj: isRecord(parsed) ? parsed : null, raw };
  } catch {
    return { obj: null, raw };
  }
}

/** Normalise the `sessionUpdate` discriminator to a snake_case key
 *  so renderer switches don't have to enumerate both casings.
 *  Returns `null` when the discriminator field is missing entirely
 *  (caller renders the raw line as a fallback). */
export function acpUpdateKind(obj: Record<string, unknown>): string | null {
  const k = readString(obj, "sessionUpdate") ?? readString(obj, "session_update");
  if (!k) return null;
  return k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

// ---------- Usage delta extraction ----------

/** Module-private baseline. Agents report cumulative-per-session
 *  totals via `usage_update`; we subtract the previous snapshot to
 *  produce a per-event delta. Cleared on every new session via
 *  [`resetAcpUsageBaseline`]. */
let _lastAcpUsage: {
  in: number;
  out: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number;
} | null = null;

export function extractAcpUsageDelta(parsed: ParsedAcpUpdate): UsageDelta | null {
  if (parsed.obj === null) return null;
  if (acpUpdateKind(parsed.obj) !== "usage_update") return null;
  const ctx = parsed.obj["contextWindow"];
  const inputTokens = isRecord(ctx) ? readNumber(ctx, "inputTokens") ?? 0 : 0;
  const outputTokens = isRecord(ctx) ? readNumber(ctx, "outputTokens") ?? 0 : 0;
  const cacheCreation = isRecord(ctx) ? readNumber(ctx, "cacheCreationTokens") ?? 0 : 0;
  const cacheRead = isRecord(ctx) ? readNumber(ctx, "cacheReadTokens") ?? 0 : 0;
  const cost = readNumber(parsed.obj, "costUsd") ?? 0;

  const prev = _lastAcpUsage ?? { in: 0, out: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
  const delta: UsageDelta = {
    inputTokens: Math.max(0, inputTokens - prev.in),
    outputTokens: Math.max(0, outputTokens - prev.out),
    cacheCreationTokens: Math.max(0, cacheCreation - prev.cacheCreate),
    cacheReadTokens: Math.max(0, cacheRead - prev.cacheRead),
    costUsd: Math.max(0, cost - prev.cost),
    model: null,
  };
  _lastAcpUsage = {
    in: inputTokens,
    out: outputTokens,
    cacheCreate: cacheCreation,
    cacheRead: cacheRead,
    cost,
  };
  return delta;
}

export function resetAcpUsageBaseline(): void {
  _lastAcpUsage = null;
}

// ---------- Replay-anticipation visibility ----------

/**
 * Decide whether an in-flight streaming line should be visible, and
 * what visible text to show.
 *
 * On `session/load` ACP agents replay the prior turn's events —
 * including agent_message_chunk streams that re-build the previous
 * assistant response chunk by chunk. Without intervention the user
 * sees the prior text flash before the new turn's content begins.
 *
 * Resolution rules:
 *  - `text` exactly equals a prior line's text → HIDE (replay
 *    completed, may extend with new content next).
 *  - `text` strictly extends a prior line (longest such prior wins)
 *    → REVEAL with the matched prefix trimmed (replay finished, new
 *    content started).
 *  - `text` is a strict prefix of a prior line → HIDE (replay in
 *    progress, still building up).
 *  - No prior line matches → REVEAL as-is (genuine new content).
 */
export function classifyStreamingVisibility(
  text: string,
  kind: LineKind,
  earlier: readonly LineSnapshot[],
): { hidden: boolean; text: string } {
  let longestPriorAsPrefix = "";
  let priorWeAreAPrefixOf: string | null = null;
  for (const l of earlier) {
    if (l.kind !== kind) continue;
    if (l.text === text) {
      return { hidden: true, text };
    }
    if (text.startsWith(l.text) && l.text.length > longestPriorAsPrefix.length) {
      longestPriorAsPrefix = l.text;
    } else if (l.text.startsWith(text)) {
      priorWeAreAPrefixOf = l.text;
    }
  }
  if (longestPriorAsPrefix.length > 0) {
    return {
      hidden: false,
      text: text.slice(longestPriorAsPrefix.length).replace(/^[\s]+/, ""),
    };
  }
  if (priorWeAreAPrefixOf !== null) {
    return { hidden: true, text };
  }
  return { hidden: false, text };
}

// ---------- Update → RenderedLine[] dispatcher ----------

export function renderAcpUpdate(parsed: ParsedAcpUpdate): RenderedLine[] {
  const { obj, raw } = parsed;
  if (obj === null) {
    if (raw.trim() === "") return [];
    return [{ kind: "stdout", text: raw }];
  }
  const kind = acpUpdateKind(obj);
  switch (kind) {
    case "user_message_chunk":
      // The chat host echoes the user's message locally before
      // invoking the runner; the agent's echo would duplicate it.
      return [];
    case "agent_message_chunk": {
      const text = readContentText(obj["content"]);
      if (!text) return [];
      // Mark as streaming so `appendLine` coalesces adjacent chunks
      // into one paragraph. claude-agent-acp emits incremental
      // fragments; codex-acp emits cumulative growing snapshots —
      // the coalesce step picks the right merge strategy via
      // prefix-relation between consecutive chunks.
      return [{ kind: "stdout", text, streaming: true }];
    }
    case "agent_thought_chunk": {
      const text = readContentText(obj["content"]);
      if (!text) return [{ kind: "system", text: "🧠 thinking…" }];
      const head = truncate(text.replace(/\s+/g, " ").trim(), 200);
      return [{ kind: "system", text: `🧠 ${head}` }];
    }
    case "tool_call":
      return renderAcpToolCall(obj);
    case "tool_call_update":
      return renderAcpToolCallUpdate(obj);
    case "plan":
      return renderAcpPlan(obj);
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      // Metadata — extracted by other handlers (usage delta) or
      // ignored for rendering.
      return [];
    default:
      // Unknown variant — pass through so a future agent capability
      // we haven't taught the renderer about doesn't silently
      // disappear.
      return [{ kind: "stdout", text: raw }];
  }
}

// ---------- Tool call rendering ----------

export function renderAcpToolCall(obj: Record<string, unknown>): RenderedLine[] {
  const title = readString(obj, "title");
  const kind = readString(obj, "kind") ?? "tool";
  const label = title ?? toolKindLabel(kind);
  const summary = summariseToolInput(obj["rawInput"]);
  const toolCallId = toolCallDedupKey(obj, "start");
  return [{ kind: "system", text: `→ ${label}${summary}`, toolCallId }];
}

export function renderAcpToolCallUpdate(obj: Record<string, unknown>): RenderedLine[] {
  // `ToolCallUpdate` is a patch: every field is optional. Codex
  // sends updates that carry only `content` (output streaming in
  // without a status change); Claude tends to send one terminal
  // `status: completed` update including content. Render either
  // case; silence only the in-flight chatter that has nothing
  // visible to show (status: in_progress without content).
  const status = readString(obj, "status");
  const fullOutput = extractToolCallFullText(obj["content"]);

  if (fullOutput === null && status !== "completed" && status !== "failed") {
    return [];
  }

  const isFailed = status === "failed";
  const tag: LineKind = isFailed ? "stderr" : "system";
  const prefix = isFailed ? "✘" : "←";
  const statusLabel = status ?? (fullOutput !== null ? "output" : "update");
  const toolCallId = toolCallDedupKey(obj, "end");

  const text =
    fullOutput === null
      ? `${prefix} ${statusLabel}`
      : `${prefix} ${statusLabel}\n${clipToolOutput(fullOutput)}`;
  return [{ kind: tag, text, toolCallId }];
}

export function renderAcpPlan(obj: Record<string, unknown>): RenderedLine[] {
  const entries = obj["entries"];
  if (!Array.isArray(entries)) return [];
  const out: RenderedLine[] = [{ kind: "system", text: "▤ plan:" }];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const status = readString(entry, "status") ?? "pending";
    const content = readString(entry, "content") ?? "";
    const glyph =
      status === "completed" ? "✓" : status === "in_progress" ? "•" : "▢";
    out.push({ kind: "system", text: `  ${glyph} ${truncate(content, 200)}` });
  }
  return out;
}

/** Build a dedup key for a tool-call event. `tool_call` and
 *  `tool_call_update` share the same `toolCallId` but render distinct
 *  lines (`→` start vs `←` end), so the key namespaces them with a
 *  `start:` / `end:` prefix. `undefined` when the event has no id
 *  (defensive — malformed agent emissions skip the dedup gate). */
export function toolCallDedupKey(
  obj: Record<string, unknown>,
  side: "start" | "end",
): string | undefined {
  const id = readString(obj, "toolCallId") ?? readString(obj, "tool_call_id");
  return id ? `${side}:${id}` : undefined;
}

// ---------- Content extraction ----------

/** Pull human-readable text out of an ACP `ContentBlock`. Only `text`
 *  carries inline text we can render in a `<pre>` cleanly; other
 *  variants get a placeholder so the user knows non-text content was
 *  produced. */
export function readContentText(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const type = readString(content, "type");
  if (type === "text") {
    return readString(content, "text") ?? null;
  }
  if (type === "image") return "(image)";
  if (type === "audio") return "(audio)";
  if (type === "resource_link") {
    const uri = readString(content, "uri");
    return uri ? `(resource: ${uri})` : "(resource)";
  }
  if (type === "embedded_resource") return "(embedded resource)";
  return null;
}

/** Concatenate every text-bearing entry of a `ToolCallContent[]`
 *  without whitespace collapsing — the user wants tool output
 *  verbatim. Returns `null` when the array carries no text payload
 *  we can render (e.g. diff-only updates). */
export function extractToolCallFullText(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const itemType = readString(item, "type");
    if (itemType === "content") {
      const inner = item["content"];
      const text = readContentText(inner);
      if (text) parts.push(text);
    } else if (itemType === "diff") {
      const path = readString(item, "path") ?? "?";
      parts.push(`diff ${path}`);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

export const MAX_TOOL_OUTPUT_CHARS = 4096;

export function clipToolOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_TOOL_OUTPUT_CHARS - 1) + "…";
}

// ---------- Tool input summarisation ----------

/** Short label for a ToolKind enum value (`execute` / `read` / …).
 *  Default branch returns the kind unchanged so an unknown future
 *  variant still renders meaningfully. */
export function toolKindLabel(kind: string): string {
  switch (kind) {
    case "execute":
      return "Bash";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Search";
    case "fetch":
      return "Fetch";
    case "think":
      return "Think";
    default:
      return kind;
  }
}

/** Pick a representative one-liner from the raw_input JSON. Probes
 *  common fields (command / filePath / pattern / url / prompt) and
 *  handles codex's `command` array shape (`["/bin/zsh","-lc",<cmd>]`).
 *  Returns an empty string when nothing matches. */
export function summariseToolInput(input: unknown): string {
  if (!isRecord(input)) return "";
  const fields = [
    "command",
    "filePath",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
  ];
  for (const f of fields) {
    const v = input[f];
    if (typeof v === "string" && v.length > 0) return ` ${truncate(v, 200)}`;
    if (Array.isArray(v) && v.every((it) => typeof it === "string")) {
      const arr = v as string[];
      const meaningful =
        arr.length >= 3 && (arr[0] === "/bin/zsh" || arr[0] === "/bin/bash")
          ? arr[arr.length - 1]
          : arr.join(" ");
      if (meaningful.length > 0) return ` ${truncate(meaningful, 200)}`;
    }
  }
  return "";
}

// ---------- Small generic JSON helpers ----------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

export function readNumber(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
