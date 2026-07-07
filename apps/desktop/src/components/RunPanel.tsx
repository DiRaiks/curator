import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  listSessions,
  onRunEvents,
  resumeFreeformRun,
  resumeRun,
  saveSession,
  startFreeformRun,
  stopRun,
  type AgentRunnerId,
  type RunExitEvent,
  type RunPermissionRequestEvent,
  type RunStartedEvent,
} from "../api";
import {
  DEFAULT_RUNNER,
  normalizeModelValue,
  normalizeRunnerId,
} from "../agents";
import {
  classifyStreamingVisibility,
  extractAcpUsageSnapshot,
  parseAcpUpdate,
  PLAN_DEDUP_KEY,
  renderAcpUpdate,
  type LineKind,
  type UsageSnapshot,
} from "../acpRender";
import type { Draft, Project, SessionFull, SessionSummary } from "../types";
import { isSessionLineKind } from "../types";
import { AgentPicker } from "./AgentPicker";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { AgentConversation } from "./shell/AgentConversation";
import { formatCost, formatTokens } from "./shell/chatFormat";
import { Tooltip } from "./Tooltip";

/**
 * One chat conversation inside the agent panel (shell v2). Streams the
 * active run's output as turn-grouped conversation view and hosts the
 * composer.
 *
 * The composer is always visible — Send either starts a fresh freeform
 * run (idle / fresh state) or replies to the captured session (exited +
 * session id available); while a run streams the button becomes Stop.
 * Chats keep streaming when the panel is hidden — the host keeps every
 * RunPanel mounted (`visible={false}` → `display: none`).
 *
 * Lines are stored as `{ kind, text }`; the turn/bubble view is derived
 * per render by `AgentConversation`.
 */

// `LineKind` is re-exported from `../acpRender` so the ACP renderer
// and the chat buffer share one source of truth for line styling.
// Local OutputLine extends it with chat-only fields (streaming,
// dedup id, replay-anticipation visibility).

interface OutputLine {
  kind: LineKind;
  text: string;
  /** Marks lines that are part of an in-flight streaming chunk
   *  (currently only ACP `agent_message_chunk`). Adjacent streaming
   *  lines of the same kind get concatenated into one buffer line
   *  rather than rendered as N stray entries — codex-acp ships text
   *  in word-sized fragments which otherwise produced one-token-per-
   *  line waterfall output. A non-streaming line breaks the chain. */
  streaming?: boolean;
  /** ACP `tool_call_id` for lines that represent a tool invocation
   *  or its completion update. Used to dedup replays: ACP agents
   *  (notably claude-agent-acp) re-emit prior turn events on
   *  `session/load` to rehydrate the client view; we already have
   *  those rows in `lines` from when the original turn streamed, so
   *  appending again would show duplicates above each resume reply. */
  toolCallId?: string;
  /** Set when the line came from a subagent (ACP
   *  `_meta.claudeCode.parentToolUseId`). Rendered with an indent so
   *  subagent activity is visually attributed to its parent tool call
   *  rather than interleaved flat with the main thread. */
  parentToolUseId?: string;
  /** When true, the line is hidden from the DOM (CSS `display: none`).
   *  Set on streaming lines whose accumulated text matches the start
   *  of an earlier line — likely a replay being rebuilt by the agent
   *  on `session/load`. The flag flips off (and the visible text gets
   *  trimmed of the matched prefix) once the stream grows past the
   *  prior content, revealing only the genuinely-new tail. Without
   *  this, every resume reply briefly flashed a duplicate of the
   *  previous turn's text before finalisation dedup spliced it out. */
  hidden?: boolean;
}

type RunStatus =
  | { kind: "idle" }
  | { kind: "running"; started: RunStartedEvent }
  | { kind: "stopping"; started: RunStartedEvent }
  | { kind: "exited"; exit: RunExitEvent; started: RunStartedEvent | null };

/**
 * Latest usage snapshot for the current Claude session. Reset to
 * `EMPTY_USAGE` on a fresh `start_run`; survives `resume_run` turns
 * within the same `session_id`.
 *
 * The shape mirrors ACP's `usage_update` notification:
 * - `contextUsed` / `contextSize` describe the model's context window
 *   fill at the moment the agent emitted the event. They're snapshots,
 *   not deltas — `contextUsed` can drop back near zero after the agent
 *   compacts context. We track latest-wins.
 * - `costUsd` is cumulative spend across the whole session. The agent
 *   only reports it on `result` events (end-of-turn), so this lags the
 *   context counters by one turn boundary. We track monotonically
 *   (`Math.max`) so a mid-stream update with no cost field doesn't
 *   reset the running total to zero.
 */
interface SessionUsage {
  contextUsed: number;
  contextSize: number;
  costUsd: number;
  model: string | null;
}

const EMPTY_USAGE: SessionUsage = {
  contextUsed: 0,
  contextSize: 0,
  costUsd: 0,
  model: null,
};

const MAX_RETAINED_LINES = 5000;

/** Sentinel scope value for "no project — run inside the vault". */
const VAULT_SCOPE = "__vault__";

interface RunPanelProps {
  /** Canonical vault root. Forwarded to `start_freeform_run`. */
  vaultRoot: string;
  /** All projects from the current scan. The scope dropdown filters down
   *  to those with a `localPath` (the rest can't be a cwd target). */
  projects: Project[];
  /** Current drafts from the latest scan. Diffed against a snapshot
   *  taken when a run starts — anything present now but not in the
   *  snapshot was written during the run, surfacing the "N drafts"
   *  notice. The vault watcher's rescans keep this prop fresh while
   *  the run streams. */
  drafts?: Draft[];
  /** Open the Drafts panel — target of the drafts-notice button. */
  onOpenDrafts?: () => void;
  /** Optional id supplied by the host when multiple panels coexist
   *  (multi-chat). Used purely as a React key + status-report tag — the
   *  panel itself doesn't care, but the host needs to demultiplex
   *  `onStatusChange` callbacks back to the right tab. When omitted (old
   *  single-panel mode, e.g. early-bootstrap render) we just use the
   *  string `"default"` so refs and callbacks stay stable. */
  chatId?: string;
  /** Optional bootstrap state injected by the host. Two flavours:
   *  - `adopt`: the host's mount-sync found this run alive in the
   *    backend; the panel inherits the `started` payload and runs in
   *    "running" mode without re-invoking a spawn.
   *  - `reopen`: a saved session was opened from History; the panel
   *    hydrates output + session id into an `exited` state ready for
   *    Reply. */
  initialState?:
    | { kind: "adopt"; started: RunStartedEvent }
    | { kind: "reopen"; session: SessionFull };
  /** When false, the panel renders into the DOM but is hidden via
   *  `display: none`. Used by the multi-chat host to keep inactive tabs
   *  mounted (so their state, listeners, and output buffer survive) while
   *  only the active one is visible — including while the whole agent
   *  panel is closed. Default true. */
  visible?: boolean;
  /** Publishes a coarse status snapshot to the host whenever this
   *  panel's state changes. Lets the host build the tab-bar indicators
   *  (running dot, pending-permission badge), the aggregate
   *  "N chats running" counter for StatusBar, and the inferred title
   *  for the tab label. Called with no args if absent. */
  onStatusChange?: (info: ChatTabStatusInfo) => void;
}

/**
 * Per-tab status snapshot pushed to the multi-chat host. Lightweight
 * by design — the host needs just enough to render its tab-bar chip
 * and aggregate cross-panel counters into a vault-wide
 * [`RunStatusInfo`]. Richer per-panel data stays inside the panel
 * where it can't leak across tabs.
 */
export interface ChatTabStatusInfo {
  chatId: string;
  state: "idle" | "running" | "stopping" | "exited";
  /** Skill / prompt id when running an artifact run (`"session-reflect"`),
   *  `"chat"` for freeform, or `null` when idle / no project context. */
  runningSkill: string | null;
  /** Project slug, or `null` for pure vault-scope runs. */
  runningProject: string | null;
  /** User-friendly tab title — first 200 chars of the pending freeform
   *  message, or `projectSlug/promptId` for artifact runs, or
   *  `"New chat"` while idle and untyped. */
  title: string;
  /** True when a `can_use_tool` request is currently pending. Drives
   *  the tab badge so the user can spot which tab is waiting on them. */
  hasPendingPermission: boolean;
  /** Latest usage snapshot for this conversation (post-resume turns
   *  included). `contextUsed` / `contextSize` are per-conversation
   *  context-window state; `costUsd` is cumulative session spend.
   *  Aggregated by the host into the vault-wide cost total shown in
   *  StatusBar / AI handle. */
  contextUsed: number;
  contextSize: number;
  costUsd: number;
  /** Total saved sessions for the vault — vault-wide, not per-tab,
   *  but reported via the per-tab channel because each panel runs
   *  `listSessions()` to fill its own cache. The host takes the
   *  maximum across reporting tabs (they all see the same DB; a
   *  newly-mounted tab may briefly lag with `null`). */
  savedCount: number | null;
}

/** Snapshot of the live run state suitable for ambient UI surfaces
 *  outside the panel itself (TitleBar AI handle, StatusBar). Keep this
 *  derived view minimal — the RunPanel internals carry richer state,
 *  but Dashboard / chrome consumers should never reach into that. */
export interface RunStatusInfo {
  /** Compressed lifecycle. `running` covers both the live-streaming
   *  state and the brief `stopping` window (cosmetic distinction not
   *  worth exposing to ambient UI). Under multi-chat this is `running`
   *  iff *any* tab is running. */
  state: "idle" | "running" | "exited";
  /** Number of tabs currently in `running` or `stopping`. The
   *  StatusBar surfaces this as "N chats running". */
  runningCount: number;
  /** Skill / prompt id of a running tab (e.g. `"session-reflect"`). When
   *  multiple tabs are running this is one representative — the
   *  StatusBar pairs it with `runningCount` so the user still knows
   *  there's more than one. `null` for freeform chats / when idle. */
  runningSkill: string | null;
  /** Project slug of a running tab (e.g. `"subgraph"`). `null` for
   *  vault-scope freeform runs or when idle. */
  runningProject: string | null;
  /** Aggregated usage across every reporting tab. `cost` is summed
   *  (total spend right now); context isn't aggregated — a single
   *  representative running tab's context is exposed when one exists.
   *  `null` before any usage event has arrived in any tab. */
  lastUsage: {
    contextUsed: number;
    contextSize: number;
    cost: number;
  } | null;
  /** Total saved sessions for this vault. `null` before the first
   *  `listSessions` call resolves. Each tab reports the same
   *  vault-wide count; the host takes the max. */
  savedCount: number | null;
}

/** Imperative handle exposed to Dashboard. Used today for three things:
 *  reopening a saved session into the agent panel, letting ambient
 *  surfaces subscribe to run-status updates so the rail agent icon /
 *  statusbar can pulse in lockstep with the panel, and staging an
 *  artifact-generated prompt into the chat input so the user can review
 *  / edit / grant permissions before sending. Opening/closing the agent
 *  panel itself is Dashboard's `activePanel` state, not a handle call. */
export interface RunPanelHandle {
  reopenSession: (session: SessionFull) => void;
  /** Subscribe to live status updates. The callback fires once
   *  immediately with the current snapshot, then on every transition
   *  thereafter. Returns an unsubscribe function. */
  subscribeToStatus: (cb: (info: RunStatusInfo) => void) => () => void;
  /** Stage a materialized artifact prompt into the chat input. Expands
   *  the panel, sets the chat scope to the given project (if it has a
   *  local path — otherwise vault scope), populates the draft, and
   *  focuses the textarea. Returns an error string when staging is
   *  refused (e.g. a run is in-flight) so the caller can surface it. */
  stagePrompt: (args: {
    text: string;
    projectSlug: string;
    promptId: string;
  }) => string | null;
}

export const RunPanel = forwardRef<RunPanelHandle, RunPanelProps>(
  function RunPanel(
    {
      vaultRoot,
      projects,
      drafts = [],
      onOpenDrafts,
      chatId = "default",
      initialState,
      visible = true,
      onStatusChange,
    },
    ref,
  ) {
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const [lines, setLines] = useState<OutputLine[]>([]);
  const outputRef = useRef<HTMLDivElement | null>(null);

  // Draft paths present when the current conversation's first run
  // started. `null` = no run yet (no notice). Read through a ref by
  // the start handlers so they don't need `drafts` in their deps.
  const [draftBaseline, setDraftBaseline] =
    useState<ReadonlySet<string> | null>(null);
  const draftPathsRef = useRef<string[]>([]);
  draftPathsRef.current = drafts.map((d) => d.path);

  // Claude session id captured from the first `system init` event in the
  // stream. Once it's set, the user can continue the conversation via the
  // chat input after the run exits. It survives `run:started` of a resumed
  // run (claude reuses the same session id under `--resume`).
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Backend-minted run id for the *currently spawned* subprocess. Distinct
  // from `sessionId` (Claude's logical conversation id, survives across
  // resume turns): `runId` is one-shot per spawn — every resume mints a
  // new one. We track it so the event handlers below can demultiplex
  // payloads that belong to *this* panel's run versus stale tails of a
  // prior run still draining or — once Срез 2 lands — siblings running
  // concurrently in other tabs. Captured from the spawn-command return
  // and re-confirmed on the matching `run:started` event.
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  currentRunIdRef.current = currentRunId;

  /** Ref holding the most recent `started` payload so the long-lived
   *  `onStdout` listener can pick the runner-specific parser without
   *  re-subscribing on every status change. Synced by `adoptStarted`
   *  + the listener's own `onStarted` handler. */
  const currentStartedRef = useRef<RunStartedEvent | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage>(EMPTY_USAGE);
  const [selectedScope, setSelectedScope] = useState<string>(VAULT_SCOPE);

  /** Per-tab agent backend. Defaults to the catalog default for fresh
   *  tabs; on adoption (mount-sync / reopen) we re-sync from the
   *  incoming `started.runner`. Locked once the chat has started
   *  (status ≠ idle) — switching runner mid-conversation would lose
   *  the session because Claude and Codex maintain separate stores. */
  const [selectedRunner, setSelectedRunner] =
    useState<AgentRunnerId>(DEFAULT_RUNNER);

  /** Per-tab model override (forwarded as `--model`). `null` = let
   *  the CLI's own config decide. Pickable even between turns on the
   *  same conversation — both runners accept changing the model on
   *  resume. */
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // Session-history bookkeeping. `pendingTitle` is set when the user
  // sends a fresh freeform message — it survives the run lifecycle and
  // becomes the History row's title at save time. `startedAtMs` marks
  // the wall-clock origin so the History view can sort by recency
  // independent of run order.
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);

  /** When a project artifact is staged (clicked Run on a skill/agent), the
   *  prompt lands in `chatDraft` and we display a chip above the input so
   *  the user knows the draft was generated, not typed. Cleared as soon as
   *  the user sends it or starts editing meaningfully (we only clear on
   *  send — typing-clear would feel jumpy). Also cleared on New chat. */
  const [stagedSource, setStagedSource] = useState<{
    projectSlug: string;
    promptId: string;
  } | null>(null);

  /** The artifact this conversation is EXECUTING — captured from
   *  `stagedSource` at send time (staged runs go through
   *  `startFreeformRun`, whose `promptId` is the "chat" sentinel).
   *  Feeds the status broadcast's `runningSkill` so artifact cards can
   *  show a live running chip. Survives the run; cleared on New chat /
   *  re-stage. */
  const [stagedRun, setStagedRun] = useState<{
    projectSlug: string;
    promptId: string;
  } | null>(null);

  /** Ref to the chat textarea so `stagePrompt` can focus it after writing
   *  the draft. The user expects to land in the input ready to edit. */
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the composer with its content (VSCode/Zed behaviour):
  // reset to auto so shrinking works, then size to content; the CSS
  // max-height caps it and flips on the scrollbar. Re-measured on
  // draft changes and on visibility flips — a hidden textarea reports
  // scrollHeight 0, so sizing while hidden would collapse it.
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el || !visible) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [chatDraft, visible]);

  /** Current permission request awaiting a user decision, scoped to
   *  *this panel's* run via the same `isMine(runId)` filter the stream
   *  events use. Replaces the prior global pendingPermission state that
   *  lived on Dashboard — moving it down here is what unblocks
   *  multi-chat: when chats can each independently pause for a tool
   *  permission, each chat owns its own slot rather than fighting over
   *  one global modal. The card is rendered inline above the textarea
   *  so the user always sees which conversation is paused. */
  const [pendingPermission, setPendingPermission] =
    useState<RunPermissionRequestEvent | null>(null);

  // Mirrors of the values the save effect needs to read at exit. The effect
  // only depends on `status` (so the user typing in the chat input doesn't
  // re-fire the save), but the bare closure would capture whatever `lines`
  // / `usage` happened to be on the render that flipped status to exited —
  // and Tauri's event listeners deliver `setUsage` from the last
  // `onStdout` and `setStatus("exited")` from `onExit` as separate
  // callbacks, so they can land in different microtask batches. Reading
  // through refs (updated below on every render) inside a deferred
  // `queueMicrotask` makes the save effect always see the latest values.
  const linesRef = useRef<OutputLine[]>([]);
  const usageRef = useRef<SessionUsage>(EMPTY_USAGE);
  const pendingTitleRef = useRef<string | null>(null);
  const startedAtMsRef = useRef<number | null>(null);
  linesRef.current = lines;
  usageRef.current = usage;
  pendingTitleRef.current = pendingTitle;
  startedAtMsRef.current = startedAtMs;

  // Saved-session cache — drives the vault-wide saved count reported
  // via status broadcasts. Eager-fetched on mount; refreshed after
  // every save. (The session history list itself lives in the host's
  // history pane now.)
  const [lastSessions, setLastSessions] = useState<SessionSummary[] | null>(null);

  // Projects eligible as a chat scope. Without a `localPath` the backend
  // can't validate/canonicalize a cwd, so the project can't be a target.
  const scopeOptions = useMemo(
    () => projects.filter((p) => p.localPath != null),
    [projects],
  );

  // Append helper — caps the retained tail at MAX_RETAINED_LINES so a
  // pathological run doesn't blow up the DOM. The backend's own 4 MB cap
  // already bounds total bytes; this is a second-line guard against very
  // long output dominated by short lines.
  //
  // Streaming-chunk coalescing: if the incoming line is marked
  // `streaming` and the last buffer line is also a streaming line of
  // the same kind, the new text is concatenated into that line
  // rather than pushed as a new entry. This keeps agent messages
  // that arrive as many tiny chunks (codex-acp emits word-sized
  // fragments via `agent_message_chunk`) readable as paragraphs
  // instead of a one-token-per-line waterfall. Any non-streaming
  // line breaks the chain — subsequent streaming text starts a
  // fresh coalesced line.
  const appendLine = useCallback((line: OutputLine) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];

      // Coalesce path: streaming chunks of the same logical message
      // merge into one buffer line rather than rendering as a
      // word-per-line waterfall.
      //
      // ACP doesn't standardise whether `agent_message_chunk` events
      // carry incremental deltas or cumulative growing-prefix
      // snapshots, and the wrappers disagree:
      //  - claude-agent-acp 0.37 emits incremental fragments
      //    ("Соз", "дал", " пап") — concatenate naively.
      //  - codex-acp 0.14 emits cumulative snapshots ("Соз",
      //    "Создал", "Создал папку") — naive concatenation here
      //    produces a visible doubling ("СозСоздалСоздал папку").
      //
      // Disambiguate by checking the prefix relationship between
      // `last.text` and `line.text`:
      //  - `line.text` extends `last.text` → cumulative; the new
      //    chunk already contains everything we'd have built
      //    incrementally, so replace.
      //  - `last.text` extends `line.text` → an out-of-order older
      //    snapshot arrived after a newer one; ignore it, keep
      //    `last.text` as-is.
      //  - Neither is a prefix → genuine incremental delta, append.
      const isContinuation =
        line.streaming &&
        last &&
        last.streaming &&
        last.kind === line.kind &&
        // Never coalesce streaming chunks from different sources — two
        // concurrent subagents' text must not merge into one attributed
        // line.
        last.parentToolUseId === line.parentToolUseId &&
        (!line.toolCallId || last.toolCallId === line.toolCallId);
      if (isContinuation) {
        let mergedText: string;
        if (line.text.startsWith(last.text)) {
          mergedText = line.text;
        } else if (last.text.startsWith(line.text)) {
          mergedText = last.text;
        } else {
          mergedText = last.text + line.text;
        }
        // Apply replay-anticipation: if the accumulated text is
        // a prefix-or-equal of an earlier line, hide it until the
        // stream grows past the match. When it does grow past, the
        // visible text gets trimmed of the matched prefix so only
        // the genuinely-new tail appears. See
        // `classifyStreamingVisibility` for the rules.
        const earlier = prev.slice(0, prev.length - 1);
        const vis = classifyStreamingVisibility(mergedText, line.kind, earlier);
        const merged: OutputLine = {
          ...last,
          text: vis.text,
          hidden: vis.hidden,
        };
        const head = prev.slice(0, prev.length - 1);
        return prev.length >= MAX_RETAINED_LINES
          ? [...head.slice(head.length - MAX_RETAINED_LINES + 1), merged]
          : [...head, merged];
      }

      // Id-keyed replace path. Lines carrying a `toolCallId` (ACP
      // `tool_call` start markers and `tool_call_update` content
      // updates) replace any existing line with the same id rather
      // than appending. This unifies three flows behind one rule:
      //  - In-flight updates: codex emits multiple `tool_call_update`
      //    events as a command's stdout streams in. Each carries
      //    the same id; each "replace" overwrites the prior partial
      //    output with the latest cumulative state.
      //  - Final status update: when status flips to completed/failed,
      //    the line updates in place with the terminal marker — the
      //    user sees a single `← completed\n<output>` line that
      //    grows then closes, not N separate lines.
      //  - Resume replay: claude-agent-acp re-emits the prior turn's
      //    tool_call + tool_call_update events on `session/load`
      //    with their original ids. The replace path overwrites the
      //    already-rendered line with itself — visually a no-op,
      //    structurally clean.
      if (line.toolCallId) {
        const existing = prev.findIndex((l) => l.toolCallId === line.toolCallId);
        if (existing !== -1) {
          const replaced = [...prev];
          replaced[existing] = line;
          return replaced;
        }
        // Fall through to the append path below for first-time ids.
      }

      // Finalize-and-dedup-streaming path. When a non-streaming
      // line arrives and the prior line was streaming, the prior
      // line is now "done" — neither claude-agent-acp 0.37 nor
      // codex-acp 0.14 emits a stable `messageId` on
      // `agent_message_chunk`, so id-based dedup is unavailable for
      // assistant text. Fall back to text-prefix matching against
      // earlier lines of the same kind:
      //  - If the finalised line is verbatim equal to an earlier
      //    one → full replay, splice it out.
      //  - If the finalised line STARTS WITH an earlier one →
      //    partial replay merged with new content (codex emits
      //    replay-chunks and new-chunks in one unbroken stream so
      //    they coalesce). Trim the replay prefix, keep the new
      //    tail.
      //
      // False-positive risk: an agent that legitimately starts a
      // new message with the same opening as an earlier one will
      // get the duplicated prefix silently stripped. Acceptable
      // for chat-flow agents that rarely repeat themselves; the
      // alternative (no dedup) is a much worse UX bug.
      let working = prev;
      if (
        !line.streaming &&
        line.kind !== "stderr" &&
        last &&
        last.streaming &&
        working.length >= 2
      ) {
        const finalised = last;
        const earlier = working.slice(0, working.length - 1);
        let bestPrefix = "";
        for (const l of earlier) {
          if (l.kind !== finalised.kind) continue;
          if (
            finalised.text.startsWith(l.text) &&
            l.text.length > bestPrefix.length
          ) {
            bestPrefix = l.text;
          }
        }
        if (bestPrefix.length > 0) {
          const remainder = finalised.text.slice(bestPrefix.length);
          if (remainder.length === 0) {
            working = earlier;
          } else {
            const trimmed: OutputLine = {
              ...finalised,
              text: remainder.replace(/^[\s]+/, ""),
            };
            working = [...earlier, trimmed];
          }
        }
      }

      // First streaming chunk of a fresh line (no coalesce match
      // above) — apply replay-anticipation here too so the very
      // first chunk of a replayed message is hidden from frame 1.
      let lineToAppend = line;
      if (line.streaming) {
        const vis = classifyStreamingVisibility(line.text, line.kind, working);
        lineToAppend = { ...line, text: vis.text, hidden: vis.hidden };
      }

      const next = working.length >= MAX_RETAINED_LINES
        ? [...working.slice(working.length - MAX_RETAINED_LINES + 1), lineToAppend]
        : [...working, lineToAppend];
      return next;
    });
  }, []);

  useEffect(() => {
    let detach: (() => void) | null = null;
    let cancelled = false;

    const attach = async () => {
      // Mount-time sync moved out: with multiple chat panels mounted in
      // parallel, only the host knows which panel should adopt which
      // backend run. The host calls `getRuns()` once and injects matched
      // payloads via the `initialState` prop (handled in a sibling
      // effect below). Without that hoist, every mounted panel would
      // race for the first live run and clobber each other.

      // Every event from `onRunEvents` carries a backend-minted `runId`.
      // Strict filter: `onStarted` accepts only when the run id matches
      // the one *this* panel invoked (we set `currentRunIdRef.current`
      // synchronously from the spawn-command's resolved value, and from
      // the host's `initialState.adopt`). Stream events use the same
      // gate. Without strict gating on `onStarted` a sibling tab's
      // started event would overwrite this tab's run id and corrupt
      // every following filter check.
      const isMine = (runId: string) => currentRunIdRef.current === runId;
      const un = await onRunEvents({
        onSessionStarted: (ev) => {
          // ACP mints the session id structurally and emits it
          // before the first stdout. Pre-ACP we extracted it by
          // parsing Claude's `system init` JSON out of stdout —
          // that path is gone.
          if (!isMine(ev.runId)) return;
          setSessionId(ev.sessionId);
        },
        onStarted: (ev) => {
          // Strict run-id match: only adopt this `run:started` if we
          // already have its id (set by the spawn-command optimistic
          // path or by the host's `initialState.adopt` injection).
          // Without this filter a sibling tab's `run:started` would
          // overwrite our state — Tauri broadcasts to every listener.
          if (!isMine(ev.runId)) return;
          // No-op write keeps the ref in sync if state had drifted
          // (e.g. mount-time race where the optimistic set fired
          // before the event listener attached). setState is
          // idempotent on identical values.
          setCurrentRunId(ev.runId);
          // Mirror the started payload into the runner-dispatch ref
          // so onStdout knows which parser to pick. Same idempotency
          // story as setCurrentRunId.
          currentStartedRef.current = ev;
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
            // Fresh run: APPEND (don't replace) so the just-echoed
            // user message survives. The "New chat" button is the only
            // path that clears the buffer; by the time a fresh
            // `run:started` arrives, the only content in `lines` is
            // the user's prompt that `onSend` echoed locally moments
            // ago. The prior session id and usage counters DO reset —
            // those belong to a different Claude session.
            setLines((prev) => [
              ...prev,
              {
                kind: "system",
                text: `▶ start ${ev.runner} · ${ev.projectSlug}/${ev.promptId} · cwd: ${ev.workdir}`,
              },
            ]);
            setSessionId(null);
            setUsage(EMPTY_USAGE);
            // Mark the wall-clock start so the History row's
            // started_at_ms matches the user's perception of when the
            // conversation began.
            setStartedAtMs(Date.now());
          }
          // Snapshot drafts at run start so anything appearing later
          // is attributable to the agent. Resume keeps the earlier
          // baseline — the conversation is still "one piece of work".
          setDraftBaseline((prev) =>
            ev.resume && prev !== null
              ? prev
              : new Set(draftPathsRef.current),
          );
          setChatDraft("");
          setChatError(null);
          // Staging chip belongs to the pre-send moment — once the run
          // actually starts, drop the marker so the panel reads as a
          // regular conversation again.
          setStagedSource(null);
          setStatus({ kind: "running", started: ev });
        },
        onStdout: (ev) => {
          if (!isMine(ev.runId)) return;
          // Every ACP `session/update` notification arrives as a
          // JSON line on stdout — the Rust transport intentionally
          // doesn't decode it, so schema evolution upstream doesn't
          // force a Rust release. The single ACP renderer below
          // handles every variant uniformly across Claude + Codex.
          const update = parseAcpUpdate(ev.line);
          if (update === null) {
            // Non-JSON line or unparseable update. Surface raw so a
            // wrapper banner / debug print still shows up.
            const trimmed = ev.line.trim();
            if (trimmed !== "") {
              appendLine({ kind: "stdout", text: ev.line });
            }
            return;
          }
          const snap = extractAcpUsageSnapshot(update);
          if (snap) {
            setUsage((prev) => mergeUsage(prev, snap));
          }
          for (const rendered of renderAcpUpdate(update)) {
            appendLine({
              kind: rendered.kind,
              text: rendered.text,
              streaming: rendered.streaming,
              toolCallId: rendered.toolCallId,
              parentToolUseId: rendered.parentToolUseId,
            });
          }
        },
        onStderr: (ev) => {
          if (!isMine(ev.runId)) return;
          appendLine({ kind: "stderr", text: ev.line });
        },
        onTruncated: (ev) => {
          if (!isMine(ev.runId)) return;
          appendLine({
            kind: "system",
            text: `… output capped — ${formatBytes(ev.droppedBytes)} dropped`,
          });
        },
        onPermissionRequest: (ev) => {
          if (!isMine(ev.runId)) return;
          // Latest request wins. Claude only pauses on one tool call at
          // a time per session, so this never silently drops a queued
          // request. If the user closes the chat without deciding, the
          // backend's `pending_permissions` removal is idempotent (the
          // stdin write fails harmlessly when the subprocess is gone).
          setPendingPermission(ev);
        },
        onExit: (ev) => {
          if (!isMine(ev.runId)) return;
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
          // A Stop / crash mid-prompt could leave a stale permission
          // card up; clear it on every exit so the next run starts
          // clean. Idempotent if nothing was pending.
          setPendingPermission(null);
          // The run is over; further events would belong to a new spawn
          // that will set its own currentRunId via `onStarted`. Clear
          // the ref so a never-stopped stale tail can't sneak in.
          currentRunIdRef.current = null;
          currentStartedRef.current = null;
          setCurrentRunId(null);
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

  // Re-snap to the bottom when the tab becomes visible again. While a
  // chat is hidden (`display: none` on the aside in multi-chat mode)
  // the output element's `scrollHeight` reports 0, so every
  // `lines`-update above writes `scrollTop = 0`. On the return,
  // `<pre>` regains its real height but `scrollTop` is stuck at 0 —
  // the user sees the buffer's oldest lines instead of the live tail
  // and concludes "logs stopped" even though they kept arriving. This
  // effect snaps to the latest line on the visibility flip, but only
  // when we were already following the tail (manual scroll-up is
  // preserved).
  useEffect(() => {
    if (!visible) return;
    const el = outputRef.current;
    if (!el) return;
    if (followTail.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible]);

  const onScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    followTail.current = atBottom;
  }, []);

  /**
   * Whether the chat input is currently continuing an existing session
   * (Reply path) vs. starting a fresh freeform run. True iff:
   * - the previous run has exited, AND
   * - we captured a session id from its stream, AND
   * - we still know what context that run ran against.
   */
  const canResume =
    status.kind === "exited" &&
    sessionId !== null &&
    status.started !== null;

  // The scope dropdown locks to the active session's scope when resuming —
  // switching scope mid-conversation would change cwd / --add-dir for the
  // spawned process and almost certainly confuse the agent.
  const effectiveScope = useMemo(() => {
    if (canResume && status.kind === "exited" && status.started !== null) {
      const slug = status.started.projectSlug;
      // "(vault)" is the sentinel `start_freeform_run` uses when no
      // project scope was selected. Artifact runs carry the real slug.
      if (slug === "(vault)") return VAULT_SCOPE;
      if (scopeOptions.some((p) => p.slug === slug)) return slug;
      // Original scope project isn't in the current scan (renamed,
      // removed); fall back to vault so the dropdown still has a value.
      return VAULT_SCOPE;
    }
    return selectedScope;
  }, [canResume, status, scopeOptions, selectedScope]);

  const scopeLocked =
    canResume ||
    status.kind === "running" ||
    status.kind === "stopping";

  /**
   * Discard the captured session and clear the output / usage so the
   * next Send starts a fresh freeform run. Only available when there's
   * an exited run to discard — the button just doesn't render otherwise.
   */
  const onNewChat = useCallback(() => {
    setStatus({ kind: "idle" });
    setLines([]);
    setSessionId(null);
    setUsage(EMPTY_USAGE);
    setChatDraft("");
    setChatError(null);
    setPendingTitle(null);
    setStartedAtMs(null);
    setStagedSource(null);
    setStagedRun(null);
    setPendingPermission(null);
    setDraftBaseline(null);
    // Fresh chat — restore picker defaults so the next conversation
    // starts on the catalog's "no opinion" model. Keeping the prior
    // selection here would surprise users who explicitly hit "New
    // chat" expecting a clean slate.
    setSelectedRunner(DEFAULT_RUNNER);
    setSelectedModel(null);
    currentRunIdRef.current = null;
    setCurrentRunId(null);
  }, []);

  /**
   * Apply a `run:started` payload to this panel synchronously — used
   * by `onSend` after a spawn-command invoke resolves. Does the same
   * work the listener's `onStarted` handler does, just driven from a
   * known-mine payload rather than a filtered broadcast event. The
   * listener's `onStarted` becomes idempotent on the same payload
   * (sees `isMine === true`, re-applies the same state — React
   * dedupes the no-op).
   */
  const adoptStarted = useCallback(
    (ev: RunStartedEvent) => {
      currentRunIdRef.current = ev.runId;
      currentStartedRef.current = ev;
      setCurrentRunId(ev.runId);
      // Sync the per-tab runner + model from the backend's echoed
      // payload. Picker selections survive the round-trip; on
      // mount-sync after restart they're re-derived from whichever
      // runner the live subprocess belongs to.
      setSelectedRunner(normalizeRunnerId(ev.runner));
      setSelectedModel(normalizeModelValue(ev.model));
      if (ev.resume) {
        setLines((prev) => [
          ...prev,
          {
            kind: "system",
            text: `▶ resume ${ev.runner} · ${ev.projectSlug}/${ev.promptId}`,
          },
        ]);
      } else {
        setLines((prev) => [
          ...prev,
          {
            kind: "system",
            text: `▶ start ${ev.runner} · ${ev.projectSlug}/${ev.promptId} · cwd: ${ev.workdir}`,
          },
        ]);
        setSessionId(null);
        setUsage(EMPTY_USAGE);
        setStartedAtMs(Date.now());
      }
      // Same baseline rule as the listener's onStarted (which will
      // re-apply this idempotently when the broadcast arrives).
      setDraftBaseline((prev) =>
        ev.resume && prev !== null ? prev : new Set(draftPathsRef.current),
      );
      setChatDraft("");
      setChatError(null);
      setStagedSource(null);
      setStatus({ kind: "running", started: ev });
    },
    [],
  );

  const onSend = useCallback(async () => {
    if (sending) return;
    if (status.kind === "running" || status.kind === "stopping") return;
    const text = chatDraft.trim();
    if (text === "") return;

    setChatError(null);
    setSending(true);

    // Echo the user's message into the output buffer BEFORE the IPC
    // fires so the buffer reads as a back-and-forth conversation. Done
    // up front (not after the await) because once `startFreeformRun` /
    // `resumeRun` resolves, the run is already streaming and the
    // model's reply may interleave with anything we'd append late.
    appendLine({ kind: "user", text });

    try {
      // Continue an existing session.
      if (
        canResume &&
        status.kind === "exited" &&
        status.started !== null &&
        sessionId !== null
      ) {
        const started = status.started;
        // Defensive: if mount-time sync ever fails to recover real
        // context (backend doesn't know about the run, ancient IDE
        // state), surface a clear error instead of relaying the cryptic
        // "vault root not accessible: <empty>" the spawn would emit.
        if (started.vaultRoot === "" || started.projectSlug === "(in progress)") {
          throw new Error(
            "Lost track of which vault this run started against — click New chat.",
          );
        }
        // The spawn-command returns the full `run:started` payload. We
        // adopt it synchronously as the source of truth for "the run
        // is live" — the asynchronously-broadcast `run:started` event
        // is a confirmation that may arrive before OR after this
        // resolution, and the panel must not depend on it (a race
        // where the event won would otherwise leave status stuck on
        // `exited`/`idle` despite a streaming backend run — exactly
        // the bug Срез 4 first shipped with).
        // Resume continues the same conversation, so the runner is
        // fixed to whatever the original session was started against
        // (forwarded back from `started.runner`). The model, in
        // contrast, can be swapped per turn — the user may bump
        // Sonnet → Opus on a tricky follow-up.
        const resumeRunnerId = normalizeRunnerId(started.runner);
        const resumeModel = selectedModel ?? undefined;
        const startedNew = started.freeform
          ? await resumeFreeformRun({
              vaultRoot: started.vaultRoot,
              workdir: started.workdir,
              additionalDirs: started.additionalDirs,
              projectSlug: started.projectSlug,
              sessionId,
              reply: text,
              runner: resumeRunnerId,
              model: resumeModel,
            })
          : await resumeRun({
              vaultRoot: started.vaultRoot,
              projectSlug: started.projectSlug,
              promptId: started.promptId,
              sessionId,
              reply: text,
              runner: resumeRunnerId,
              model: resumeModel,
            });
        adoptStarted(startedNew);
        return;
      }

      // Fresh freeform run. Capture the title BEFORE startFreeformRun
      // resolves and the onStarted handler clears the draft. The title
      // persists across the run lifecycle and surfaces as the tab chip
      // and History row's heading.
      //
      // For staged artifacts ("Open in chat" on a skill/agent) the
      // prompt body starts with a verbose `# Vault Workflow Run: …`
      // header followed by section scaffolding — slicing the first 200
      // chars would fill the chip with that boilerplate. Use the
      // compact `project/prompt` pair instead, matching the fallback
      // already applied in the status broadcast below.
      setPendingTitle(
        stagedSource !== null
          ? `${stagedSource.projectSlug}/${stagedSource.promptId}`
          : text.slice(0, 200),
      );
      // Remember which artifact this conversation is executing —
      // staged runs spawn through `startFreeformRun` (promptId
      // "chat"), so without this the status broadcast can't report
      // the skill id and artifact cards can't show a running chip.
      setStagedRun(stagedSource);
      const scopeProject =
        effectiveScope === VAULT_SCOPE
          ? null
          : scopeOptions.find((p) => p.slug === effectiveScope) ?? null;
      const startedNew = await startFreeformRun({
        vaultRoot,
        prompt: text,
        scopeProjectSlug: scopeProject?.slug,
        scopeRepoPath: scopeProject?.localPath ?? undefined,
        runner: selectedRunner,
        model: selectedModel ?? undefined,
      });
      adoptStarted(startedNew);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [
    appendLine,
    sending,
    status,
    chatDraft,
    canResume,
    sessionId,
    effectiveScope,
    scopeOptions,
    vaultRoot,
    selectedRunner,
    selectedModel,
    stagedSource,
  ]);

  const onStop = useCallback(async () => {
    if (status.kind !== "running") return;
    const startedSnapshot = status.started;
    // Stop targets a specific runId on the backend. Use the snapshot's
    // id rather than `currentRunId` state so we kill *this* run even if
    // the panel state has been re-pointed mid-flight (no path does that
    // today, but defensive against future tab-switch races).
    const targetRunId = startedSnapshot.runId;
    if (!targetRunId) {
      // Mount-time-recovered run that lacked a runId in the snapshot
      // (older backend, future-compat fallback). Nothing to target.
      return;
    }
    setStatus({ kind: "stopping", started: startedSnapshot });
    try {
      await stopRun({ runId: targetRunId });
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

  // ---------- Session persistence ----------

  // Memo of the last save we wrote so a status re-entry into "exited"
  // (e.g. reopening a saved session) doesn't trigger a duplicate UPSERT
  // with identical data. Tracks `(sessionId, linesCount)` because the
  // resume path legitimately grows `linesCount` and must re-save, while
  // a re-entry without any new turns must not.
  const lastSavedSessionRef = useRef<{
    sessionId: string;
    linesCount: number;
  } | null>(null);

  // Persist the run when it exits. Upserts by `(vault_root,
  // claude_session_id)` so reply turns within the same Claude session
  // overwrite the same DB row, growing the saved output buffer with
  // each turn. We run on every transition INTO "exited" — including
  // user-initiated Stop, which also lands here via the `run:exit`
  // event after the runner shuts the subprocess down.
  //
  // After the save resolves we re-fetch the session list so the count
  // surfaced via `RunStatusInfo.savedCount` (and through it the
  // TitleBar AI handle + StatusBar) reflects the newly-written row.
  // Critically, the refetch is sequenced AFTER `saveSession`'s promise
  // resolves — otherwise the count could read the table from before
  // the UPSERT landed.
  useEffect(() => {
    if (status.kind !== "exited") return;
    if (sessionId === null) return;
    if (status.started === null) return;
    // Skip placeholder context from a failed mount-time sync — saving
    // with empty vault_root would create a junk row keyed under "".
    if (status.started.vaultRoot === "") return;

    const started = status.started;
    const exit = status.exit;

    // Defer one microtask so the last `setUsage` / `setLines` from
    // `onStdout` (delivered as a sibling Tauri callback to `onExit`)
    // lands in the refs before we read them. Without this, an
    // exited-status flip that arrives in a different microtask batch
    // than the final usage update would persist a row with stale
    // (pre-final-turn) cost/tokens.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;

      const finalLines = linesRef.current;
      const finalUsage = usageRef.current;
      const finalPendingTitle = pendingTitleRef.current;
      const finalStartedAtMs = startedAtMsRef.current;

      // Idempotency guard against re-entry. If status flips out of
      // "exited" (resume turn, New chat) and back without any new
      // lines, the on-disk row hasn't moved — skip the round-trip.
      const last = lastSavedSessionRef.current;
      if (
        last !== null &&
        last.sessionId === sessionId &&
        last.linesCount === finalLines.length
      ) {
        return;
      }

      const title =
        finalPendingTitle ?? `${started.projectSlug}/${started.promptId}`;
      const started_at = finalStartedAtMs ?? Date.now();

      lastSavedSessionRef.current = {
        sessionId,
        linesCount: finalLines.length,
      };

      void saveSession({
        vaultRoot: started.vaultRoot,
        claudeSessionId: sessionId,
        projectSlug: started.projectSlug,
        promptId: started.promptId,
        workdir: started.workdir,
        additionalDirs: started.additionalDirs,
        freeform: started.freeform,
        title,
        outputLines: finalLines.map((l) => ({ kind: l.kind, text: l.text })),
        startedAtMs: started_at,
        endedAtMs: Date.now(),
        exitCode: exit.code,
        exitSuccess: exit.success,
        // The persistence wire format (SessionUsageSnapshot) still uses
        // the legacy input/output/cache fields — we keep the schema
        // unchanged and overload them: contextUsed → inputTokens,
        // contextSize → outputTokens. Cache buckets are unused under
        // the new ACP shape (the agent reports only used+size, not the
        // breakdown). reopenSession reverses this mapping.
        usage: {
          inputTokens: finalUsage.contextUsed,
          outputTokens: finalUsage.contextSize,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: finalUsage.costUsd,
          model: finalUsage.model,
        },
        // Persist which agent backend served this session so the
        // History row can restore the same runner picker on reopen.
        // `started.runner` is the backend's echo — authoritative over
        // the panel's local selection because the panel may have
        // adopted a mount-sync run started by a now-removed runner id.
        runner: normalizeRunnerId(started.runner),
      })
        .then(async () => {
          try {
            const list = await listSessions(started.vaultRoot, false);
            setLastSessions(list);
          } catch {
            // Refetch is best-effort — the count just stays at its
            // previous value until the next idle eager-fetch.
          }
        })
        .catch((err) => {
          // Persistence is best-effort — don't blow up the UI. Roll
          // the memo back so a retry on the next render isn't blocked
          // by the optimistic update we wrote above.
          lastSavedSessionRef.current = last;
          const text = err instanceof Error ? err.message : String(err);
          appendLine({
            kind: "system",
            text: `! failed to save chat to history: ${text}`,
          });
        });
    });

    return () => {
      cancelled = true;
    };
    // We deliberately depend only on `status` and `sessionId` here.
    // The other inputs (lines/usage/etc.) are read through refs above,
    // which are updated on every render — adding them to deps would
    // trigger spurious re-saves while exited (e.g. user typing in the
    // chat input).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sessionId]);

  // ---------- Reopen flow ----------

  const reopenSession = useCallback((session: SessionFull) => {
    // Restore the run state as if the saved run had just exited. The
    // Reply path then handles `resume_*_run` using the captured session
    // id and stashed context.
    const restoredRunner = normalizeRunnerId(session.summary.runner);
    const restoredModel = normalizeModelValue(session.summary.model);
    const synthStarted: RunStartedEvent = {
      // No backend run is associated with a freshly-reopened session —
      // the panel is in `exited` state and only the next Reply will
      // spawn (and mint) one. Empty string sentinels "no live runId".
      runId: "",
      projectSlug: session.summary.projectSlug,
      promptId: session.summary.promptId,
      vaultRoot: session.summary.vaultRoot,
      workdir: session.workdir,
      additionalDirs: session.additionalDirs,
      runner: restoredRunner,
      model: restoredModel,
      resume: false,
      freeform: session.summary.freeform,
    };
    // Sync the picker to the saved session's backend so the next
    // Reply targets the same CLI. Without this, reopening a Codex
    // session and clicking Reply would silently spawn Claude (the
    // panel's default selectedRunner from mount).
    setSelectedRunner(restoredRunner);
    setSelectedModel(restoredModel);
    // Pre-register the saved state so the persistence effect, which
    // fires when we flip status to "exited" below, sees a matching
    // memo and skips the redundant UPSERT. Reopening a saved session
    // doesn't change the on-disk row; only the subsequent resume turn
    // (which appends lines) needs to re-save.
    lastSavedSessionRef.current = {
      sessionId: session.summary.claudeSessionId,
      linesCount: session.outputLines.length,
    };
    setStatus({
      kind: "exited",
      exit: {
        // Reopen synthesizes an exit event for the saved session. We
        // don't have a live runId here (the original spawn is long
        // gone), so use the synth started's empty-string sentinel so
        // the discriminator is at least *present* and type-checks.
        runId: synthStarted.runId,
        code: session.summary.exitSuccess === false ? 1 : 0,
        success: session.summary.exitSuccess ?? true,
      },
      started: synthStarted,
    });
    setLines(
      session.outputLines.map((l) => ({
        // Narrow the persisted string. A row written by a future runner
        // with a new kind (or a corrupted DB) falls back to `stdout` so
        // the renderer's CSS class lookup can't accept arbitrary input.
        kind: isSessionLineKind(l.kind) ? l.kind : "stdout",
        text: l.text,
      })),
    );
    setSessionId(session.summary.claudeSessionId);
    setUsage({
      // Reverse the save-side mapping: legacy inputTokens/outputTokens
      // columns hold contextUsed/contextSize for sessions written by
      // the ACP-era code. Older rows (pre-ACP) stored true input/output
      // token counts here — they'll restore as a contextUsed-like
      // value with no meaningful size, displayed as "X ctx" with no
      // denominator until the next live `usage_update` fixes it.
      contextUsed: session.summary.inputTokens,
      contextSize: session.summary.outputTokens,
      costUsd: session.summary.costUsd,
      model: session.summary.model,
    });
    setPendingTitle(session.summary.title);
    setStartedAtMs(session.summary.startedAtMs);
    setChatDraft("");
    setStagedSource(null);
    setPendingPermission(null);
    setChatError(null);
  }, []);

  // Apply host-injected `initialState` exactly once on mount. The two
  // flavours both replace the entire panel state, so re-running on prop
  // change would be incorrect (would clobber any user-driven edits). We
  // explicitly leave `initialState` out of the deps array — the host is
  // expected to supply it only at construction time per chatId; a later
  // change to the same panel's initialState is not a supported flow.
  useEffect(() => {
    if (!initialState) return;
    if (initialState.kind === "adopt") {
      const s = initialState.started;
      currentRunIdRef.current = s.runId || null;
      setCurrentRunId(s.runId || null);
      // Adopting mid-run (app restart during a conversation): baseline
      // from the current scan — drafts written before the restart are
      // already in it, so only genuinely-new ones get noticed.
      setDraftBaseline(new Set(draftPathsRef.current));
      setStatus({ kind: "running", started: s });
    } else {
      reopenSession(initialState.session);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live status subscribers — ambient UI (TitleBar AI handle, StatusBar
  // chat counter) attaches via `subscribeToStatus` to get notified on
  // every status / usage transition without lifting RunPanel state into
  // its parent. The Set lives in a ref so subscribers can register from
  // an effect with empty deps and never need to re-subscribe.
  const statusSubscribersRef = useRef<Set<(info: RunStatusInfo) => void>>(
    new Set(),
  );
  // Latest snapshot mirror — read by the immediate-fire branch of
  // subscribeToStatus and by the publish effect. Kept in a ref so
  // subscribeToStatus itself can stay stable (no deps); React state
  // changes still propagate via the publish effect below.
  const statusInfoSnapshotRef = useRef<RunStatusInfo>({
    state: "idle",
    runningCount: 0,
    runningSkill: null,
    runningProject: null,
    lastUsage: null,
    savedCount: null,
  });

  // Publish status info to all subscribers whenever the live state,
  // usage totals, or saved-session count shift. The effect deliberately
  // doesn't gate on a shallow-equal check — Set iteration over a
  // handful of callbacks costs less than the equality check itself,
  // and React already dedupes identical render outputs downstream.
  useEffect(() => {
    const info = buildRunStatusInfo(status, usage, lastSessions);
    statusInfoSnapshotRef.current = info;
    for (const cb of statusSubscribersRef.current) {
      try {
        cb(info);
      } catch {
        // Don't let a misbehaving subscriber take down the dispatch loop.
      }
    }
  }, [status, usage, lastSessions]);

  // Per-tab status broadcast to the multi-chat host. Distinct from
  // `subscribeToStatus` above (which feeds the vault-wide AI handle /
  // StatusBar) — this one is keyed by chatId so the host can build its
  // tab-bar UI: one chip per panel with running indicator, badge for a
  // pending permission, tab title derived from the conversation start.
  // Deps cover every input the snapshot depends on; cost is cheap (one
  // function call per change) and skipping a transition would leave
  // the tab UI stale.
  useEffect(() => {
    if (!onStatusChange) return;
    const stateKind: ChatTabStatusInfo["state"] = status.kind;
    const started =
      status.kind === "running" ||
      status.kind === "stopping" ||
      status.kind === "exited"
        ? status.started
        : null;
    // Artifact runs carry their promptId on the spawn payload; staged
    // artifact runs spawn as freeform ("chat" sentinel), so fall back
    // to the staged source captured at send time.
    const runningSkill =
      started && started.promptId !== "chat"
        ? started.promptId
        : started
          ? (stagedRun?.promptId ?? null)
          : null;
    const runningProject =
      started && started.projectSlug !== "(vault)"
        ? started.projectSlug
        : null;
    // Title precedence: explicit pending freeform title → artifact
    // `project/prompt` pair → "New chat" placeholder. Truncated to keep
    // tab chips compact; the host can re-truncate if needed.
    const title =
      pendingTitle ??
      (started ? `${started.projectSlug}/${started.promptId}` : "New chat");
    onStatusChange({
      chatId,
      state: stateKind,
      runningSkill,
      runningProject,
      title,
      hasPendingPermission: pendingPermission !== null,
      contextUsed: usage.contextUsed,
      contextSize: usage.contextSize,
      costUsd: usage.costUsd,
      savedCount: lastSessions?.length ?? null,
    });
  }, [
    chatId,
    onStatusChange,
    status,
    pendingPermission,
    pendingTitle,
    stagedRun,
    usage.contextUsed,
    usage.contextSize,
    usage.costUsd,
    lastSessions,
  ]);

  const subscribeToStatus = useCallback(
    (cb: (info: RunStatusInfo) => void) => {
      statusSubscribersRef.current.add(cb);
      // Fire-on-subscribe with the latest snapshot so the consumer
      // doesn't render a stale default before the next transition.
      try {
        cb(statusInfoSnapshotRef.current);
      } catch {
        // ignore — same rationale as the publish loop
      }
      return () => {
        statusSubscribersRef.current.delete(cb);
      };
    },
    [],
  );

  const stagePrompt = useCallback<RunPanelHandle["stagePrompt"]>(
    ({ text, projectSlug, promptId }) => {
      // Refuse while a run is active — overwriting the draft mid-stream
      // would surprise the user, and the chat input is disabled during
      // sending anyway. The caller surfaces the returned message inline.
      if (status.kind === "running" || status.kind === "stopping") {
        return "Stop the active run first, then open this prompt in the chat.";
      }
      // Staging is conceptually "start a new conversation with this
      // prompt pre-filled". When the panel is sitting on an exited run,
      // we must discard the prior session id / lines / usage so the
      // next Send goes through `startFreeformRun` (fresh session) rather
      // than `resumeRun` (reply into the prior conversation). Without
      // this reset the scope dropdown also stays locked to the previous
      // run's project and the button reads "Reply" — both surprising
      // when the user just clicked "Open in chat" on a new artifact.
      if (status.kind === "exited") {
        setStatus({ kind: "idle" });
        setLines([]);
        setSessionId(null);
        setUsage(EMPTY_USAGE);
        setPendingTitle(null);
        setStartedAtMs(null);
        setDraftBaseline(null);
        setStagedRun(null);
        // Same rationale as `onNewChat` — staging an artifact opens a
        // fresh conversation; carry-over of the prior chat's picker
        // selection would surprise the user.
        setSelectedRunner(DEFAULT_RUNNER);
        setSelectedModel(null);
      }
      // Pick the scope that matches the source project when its repo is
      // declared; fall back to vault scope so the backend still spawns
      // (just without --add-dir-into-repo). The dropdown's effective-
      // scope guard already drops invalid slugs back to vault scope.
      const hasRepo = scopeOptions.some((p) => p.slug === projectSlug);
      setSelectedScope(hasRepo ? projectSlug : VAULT_SCOPE);
      setChatDraft(text);
      setStagedSource({ projectSlug, promptId });
      setChatError(null);
      // requestAnimationFrame so Dashboard has committed the panel-open
      // state and the textarea is visible before we focus it.
      requestAnimationFrame(() => {
        const el = chatInputRef.current;
        if (!el) return;
        el.focus();
        // Drop the caret at the end so the user can append (e.g.
        // "...also please be brief") without first clicking past the
        // pre-filled text — but scroll the view back to the TOP so the
        // staged prompt is reviewable from its beginning (the caret
        // jump would otherwise leave the box showing the tail).
        el.setSelectionRange(text.length, text.length);
        el.scrollTop = 0;
      });
      return null;
    },
    [status, scopeOptions],
  );

  useImperativeHandle(
    ref,
    () => ({ reopenSession, subscribeToStatus, stagePrompt }),
    [reopenSession, subscribeToStatus, stagePrompt],
  );

  // Eager-fetch the saved-session list whenever the cache is empty.
  // We deliberately don't gate on `status.kind === "idle"` — when the
  // app mounts mid-run (HMR in dev, IDE restart during a long
  // conversation), the run-status sync recovers `kind: "running"`
  // immediately, and an idle-only fetch would never fire. The result
  // was the rail agent icon and StatusBar reading `savedCount: 0`
  // forever until the run exited.
  useEffect(() => {
    if (lastSessions !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listSessions(vaultRoot, false);
        if (!cancelled) setLastSessions(list);
      } catch {
        // Best-effort: savedCount just stays null until the next save.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultRoot, lastSessions]);

  const isRunning = status.kind === "running" || status.kind === "stopping";

  // Latest agent plan / todo-list snapshot. The ACP renderer collapses
  // every `SessionUpdate.plan` emission into one line keyed by
  // `PLAN_DEDUP_KEY` (see `renderAcpPlan`), so the most-recent plan is
  // simply the latest line in `lines` carrying that id. We surface it
  // as a sticky widget above the scrollable output and elide the same
  // entry from the inline stream so it doesn't render twice.
  const latestPlan = useMemo<string | null>(() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.toolCallId === PLAN_DEDUP_KEY) return lines[i]!.text;
    }
    return null;
  }, [lines]);
  const visibleLines = useMemo(
    () => lines.filter((l) => l.toolCallId !== PLAN_DEDUP_KEY),
    [lines],
  );

  const scopeName =
    effectiveScope === VAULT_SCOPE ? "the vault" : effectiveScope;

  // Drafts that appeared after this conversation's run started — the
  // agent's proposed knowledge notes awaiting curation.
  const newDraftCount = useMemo(() => {
    if (draftBaseline === null) return 0;
    let n = 0;
    for (const d of drafts) {
      if (!draftBaseline.has(d.path)) n += 1;
    }
    return n;
  }, [drafts, draftBaseline]);

  return (
    <section
      className="ide-agent-chat"
      aria-label="Agent conversation"
      // Stay mounted-but-hidden when the host is showing a sibling tab
      // (or the whole agent panel is closed). Unmounting would detach
      // `onRunEvents` and freeze any backend run streaming into this
      // conversation.
      style={visible ? undefined : { display: "none" }}
    >
      {/* Scope row: per-session scope chip + runner/model picker,
          session id on the right. */}
      <div className="ide-agent-sub">
        <span>scope</span>
        <span
          className="scope"
          title={
            scopeLocked
              ? "Scope is locked while continuing this session"
              : "Where the agent runs. 'vault' runs in the vault; a project runs in its repo with the vault attached via --add-dir."
          }
        >
          <span
            className={
              "ide-dot " +
              (isRunning ? "run" : status.kind === "exited" ? "ok" : "idle")
            }
          />
          <select
            value={effectiveScope}
            onChange={(e) => setSelectedScope(e.target.value)}
            disabled={scopeLocked}
            aria-label="Chat scope"
          >
            <option value={VAULT_SCOPE}>vault</option>
            {scopeOptions.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
              </option>
            ))}
          </select>
        </span>
        <AgentPicker
          runner={selectedRunner}
          model={selectedModel}
          // Runner is fixed for the lifetime of a conversation: a chat
          // that started against Claude can't become a Codex chat
          // (separate session stores). Re-enables on `idle` only.
          runnerLocked={status.kind !== "idle"}
          modelLocked={isRunning}
          onRunnerChange={setSelectedRunner}
          onModelChange={setSelectedModel}
        />
        <span className="grow" />
        {sessionId && (
          <span title={sessionId}>{sessionId.slice(0, 6)}</span>
        )}
      </div>

      {latestPlan && (
        <div className="ide-agent-plan" role="status" aria-label="Agent plan">
          <pre>{latestPlan}</pre>
        </div>
      )}

      <div
        ref={outputRef}
        className="ide-agent-body"
        onScroll={onScroll}
      >
        {visibleLines.length === 0 ? (
          <p className="ide-panel-hint">
            Ask about {scopeName}. The vault is attached to every chat;
            pick a project scope to run inside its repo. ⌘↵ sends.
          </p>
        ) : (
          <AgentConversation
            lines={visibleLines}
            running={isRunning}
            agentLabel={selectedRunner === "codex" ? "codex" : "claude"}
          />
        )}
      </div>

      {newDraftCount > 0 && (
        <div className="ide-agent-notice" role="status">
          <span
            className="ide-pill"
            style={{
              background: "var(--accent)",
              color: "var(--accent-fg)",
              fontWeight: 700,
            }}
          >
            {newDraftCount} draft{newDraftCount === 1 ? "" : "s"}
          </span>
          <span style={{ flex: 1, color: "var(--fg-2)" }}>
            Written to <code>01_inbox/_drafts/</code>. Review in Drafts.
          </span>
          {onOpenDrafts && (
            <button type="button" className="ide-btn sm" onClick={onOpenDrafts}>
              Drafts →
            </button>
          )}
        </div>
      )}

      <PermissionRequestCard
        request={pendingPermission}
        onResolved={() => setPendingPermission(null)}
      />

      {stagedSource && (
        <div className="ide-agent-staged" role="status" aria-label="Staged artifact">
          <span className="txt">
            staged from{" "}
            <code>
              {stagedSource.projectSlug}/{stagedSource.promptId}
            </code>{" "}
            — review and send
          </span>
          <button
            type="button"
            className="ide-btn ghost sm"
            onClick={() => {
              setStagedSource(null);
              setChatDraft("");
            }}
            title="Discard the staged prompt"
          >
            clear
          </button>
        </div>
      )}

      <div className="ide-composer">
        {chatError && (
          <div className="ide-agent-error" role="alert">
            {chatError}
          </div>
        )}
        <div className="box">
          <textarea
            ref={chatInputRef}
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            placeholder={
              isRunning
                ? "Agent is working…"
                : canResume
                  ? `Reply about ${scopeName}…   ⌘↵ to send`
                  : `Ask about ${scopeName}…   ⌘↵ to send`
            }
            rows={2}
            disabled={sending || isRunning}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void onSend();
              }
            }}
            aria-label={
              canResume ? "Reply to the agent" : "Message to the agent"
            }
          />
          <div className="crow">
            {canResume && (
              <button
                type="button"
                className="ide-chip"
                onClick={onNewChat}
                title="Discard the current session and start a fresh chat here"
              >
                + new
              </button>
            )}
            <span className="grow" />
            {hasUsage(usage) ? (
              <Tooltip
                content={formatUsageTooltip(usage)}
                placement="top"
                align="end"
                ariaLabel="Session usage"
              >
                <span className="meta">{formatUsageSummary(usage)}</span>
              </Tooltip>
            ) : (
              <span className="meta">ready</span>
            )}
            {status.kind === "running" ? (
              <button
                type="button"
                className="ide-btn primary"
                onClick={() => void onStop()}
              >
                stop
              </button>
            ) : status.kind === "stopping" ? (
              <button type="button" className="ide-btn" disabled>
                stopping…
              </button>
            ) : (
              <button
                type="button"
                className="ide-btn primary"
                disabled={sending || chatDraft.trim() === ""}
                onClick={() => void onSend()}
              >
                {sending ? "…" : canResume ? "reply ⌘↵" : "send ⌘↵"}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
  },
);

/**
 * Project the internal `RunStatus + SessionUsage + saved list` triple
 * into the compact snapshot ambient surfaces consume (TitleBar AI
 * handle, StatusBar). `running` and `stopping` collapse into the same
 * exposed `running` state — the cosmetic stop-pending distinction
 * lives only inside the panel header.
 */
function buildRunStatusInfo(
  status: RunStatus,
  usage: SessionUsage,
  lastSessions: SessionSummary[] | null,
): RunStatusInfo {
  const lastUsage = hasUsage(usage)
    ? {
        contextUsed: usage.contextUsed,
        contextSize: usage.contextSize,
        cost: usage.costUsd,
      }
    : null;
  const savedCount = lastSessions === null ? null : lastSessions.length;

  if (status.kind === "running" || status.kind === "stopping") {
    const started = status.started;
    return {
      state: "running",
      runningCount: 1,
      runningProject:
        started.projectSlug === "(vault)" ? null : started.projectSlug,
      runningSkill: started.freeform ? null : started.promptId,
      lastUsage,
      savedCount,
    };
  }
  if (status.kind === "exited") {
    return {
      state: "exited",
      runningCount: 0,
      runningProject: null,
      runningSkill: null,
      lastUsage,
      savedCount,
    };
  }
  return {
    state: "idle",
    runningCount: 0,
    runningProject: null,
    runningSkill: null,
    lastUsage,
    savedCount,
  };
}




function mergeUsage(prev: SessionUsage, snap: UsageSnapshot): SessionUsage {
  return {
    // Context window: latest-wins. Compaction can shrink `used` back
    // toward zero — we trust the agent's snapshot over the prior one.
    contextUsed: snap.contextUsed,
    // Size is only learned authoritatively on the first `result`;
    // mid-stream updates carry it too but if a future variant ever
    // omits it (size === 0), preserve the previously-learned value
    // so the "X / Y" chip doesn't lose its denominator mid-stream.
    contextSize: snap.contextSize > 0 ? snap.contextSize : prev.contextSize,
    // Cost: monotonic. Cumulative session spend can only grow, and
    // mid-stream updates omit `cost` (snap.costUsd === 0) — clamping
    // to max avoids a flicker back to $0 between cost-bearing events.
    costUsd: Math.max(prev.costUsd, snap.costUsd),
    model: snap.model ?? prev.model,
  };
}

function hasUsage(u: SessionUsage): boolean {
  // `contextSize` alone doesn't count — the agent learns it from the
  // first `result` and emits it even before any real tokens flow.
  // Wait for `contextUsed` (a true measurement) or `costUsd` (only
  // reported once billing has accrued) before showing the chip.
  return u.contextUsed > 0 || u.costUsd > 0;
}

function formatUsageSummary(u: SessionUsage): string {
  const parts: string[] = [];
  if (u.contextUsed > 0) {
    parts.push(
      u.contextSize > 0
        ? `${formatTokens(u.contextUsed)} / ${formatTokens(u.contextSize)}`
        : `${formatTokens(u.contextUsed)} ctx`,
    );
  }
  if (u.costUsd > 0) parts.push(formatCost(u.costUsd));
  return parts.join(" · ");
}

function formatUsageTooltip(u: SessionUsage): string {
  const lines: string[] = [];
  lines.push("Session usage (latest snapshot)");
  if (u.model) lines.push(`Model: ${u.model}`);
  lines.push("");
  if (u.contextSize > 0) {
    const pct = (u.contextUsed / u.contextSize) * 100;
    lines.push(
      `Context: ${u.contextUsed.toLocaleString()} / ${u.contextSize.toLocaleString()} tokens (${pct.toFixed(1)}%)`,
    );
  } else {
    lines.push(`Context used: ${u.contextUsed.toLocaleString()} tokens`);
  }
  if (u.costUsd > 0) {
    lines.push(`Cost so far: ${formatCost(u.costUsd)}`);
  } else {
    // Subscription accounts (Claude Pro / Max / Team / Enterprise)
    // and Codex on ChatGPT auth don't get per-call billing. ACP's
    // `usage_update` omits `cost` for those tiers, and also on every
    // mid-stream event regardless of tier.
    lines.push("Cost: not reported (subscription plan or mid-turn)");
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

