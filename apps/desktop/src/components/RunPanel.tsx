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
  archiveSession,
  deleteSession,
  getSession,
  listSessions,
  onRunEvents,
  resumeFreeformRun,
  resumeRun,
  saveSession,
  startFreeformRun,
  stopRun,
  type RunExitEvent,
  type RunPermissionRequestEvent,
  type RunStartedEvent,
} from "../api";
import { usePopoverPosition } from "../hooks/usePopoverPosition";
import type { Project, SessionFull, SessionSummary } from "../types";
import { isSessionLineKind } from "../types";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { Tooltip } from "./Tooltip";

/**
 * Persistent bottom drawer that streams the active run's output and hosts
 * the free-form chat input.
 *
 * The chat input is always available when the panel is expanded — Send
 * either starts a fresh freeform run (idle / fresh state) or replies to
 * the captured session (exited + session id available). The "New chat"
 * button discards an exited session so the user can start over without
 * the prior conversation context.
 *
 * Lines are stored as `{ kind, text }` so the renderer can color stderr
 * differently. We don't word-wrap programmatically — the `<pre>` does it
 * via CSS so the renderer stays cheap on long outputs.
 */

/** Visual kind for an output line.
 *  - `stdout`: model text / tool output (default body color)
 *  - `stderr`: error stream / denied tools (warn color)
 *  - `system`: structural markers — `▶ start`, `✔ exit`, tool calls, etc.
 *  - `user`: the user's chat input echoed locally before the IPC fires,
 *    so the buffer reads as a conversation rather than a one-sided stream
 *    of the model's replies. Persisted with the session so re-opening a
 *    saved chat shows what the user actually said. */
type LineKind = "stdout" | "stderr" | "system" | "user";

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

/** Sentinel scope value for "no project — run inside the vault". */
const VAULT_SCOPE = "__vault__";

/** Preamble injected before the user's prompt when the privacy toggle is
 *  on. Soft enforcement: the agent has read access to the full vault via
 *  --add-dir, so this is a behavioural rule, not a filesystem block.
 *  Claude honours it reliably in practice; for hard isolation we'd need
 *  per-zone --add-dir lists, which is a bigger refactor.
 *
 *  Zone names are derived from the vault's own scope vocabulary
 *  (see scope.rs) so the rule survives if the user renames folders. */
const PRIVACY_PREAMBLE = `## Privacy boundary (hard rule for this run)

Do NOT read, list, or grep any file whose scope is \`personal-work\` or \`team-management\`. This includes (but isn't limited to) folders typically named \`06_daily\`, \`journal\`, \`private\`, \`personal\`, \`meetings\`, \`1on1\`, \`one-on-ones\`, \`people\`, \`team\`, \`management\`, or any subfolder with frontmatter \`scope: personal-work\` / \`scope: team-management\`.

If the task seems to require their content, STOP and ask the user — do not try to infer the content from filenames, do not work around the rule with Bash, and do not write inferred summaries to disk. Violating this rule corrupts user trust.

---

`;

interface RunPanelProps {
  /** Canonical vault root. Forwarded to `start_freeform_run`. */
  vaultRoot: string;
  /** All projects from the current scan. The scope dropdown filters down
   *  to those with a `localPath` (the rest can't be a cwd target). */
  projects: Project[];
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
   *  only the active one is visible. Default true. */
  visible?: boolean;
  /** Initial collapsed state of the drawer. Defaults to `true` so the
   *  app loads with the drawer in compact mode. The multi-chat host
   *  overrides to `false` for tabs the user explicitly creates via
   *  "+" (otherwise opening a new tab would visually "close" the
   *  drawer to the active tab's default-collapsed state, looking
   *  exactly like a regression). */
  initialCollapsed?: boolean;
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
  /** Cumulative usage across this conversation (post-resume turns
   *  included). Aggregated by the host into the vault-wide totals
   *  shown in StatusBar / AI handle. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Total saved sessions for the vault — vault-wide, not per-tab,
   *  but reported via the per-tab channel because each panel runs
   *  `listSessions()` to fill its own dropdown cache. The host takes
   *  the maximum across reporting tabs (they all see the same DB; a
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
  /** Cumulative usage summed across every reporting tab. `null`
   *  before any usage event has arrived in any tab. */
  lastUsage: { in: number; out: number; cost: number } | null;
  /** Total saved sessions for this vault. `null` before the first
   *  `listSessions` call resolves. Each tab reports the same
   *  vault-wide count; the host takes the max. */
  savedCount: number | null;
}

/** Imperative handle exposed to Dashboard. Used today for four things:
 *  reopening a saved session into the editor's chat panel, toggling the
 *  panel collapsed state from the header AI button, letting ambient
 *  surfaces subscribe to run-status updates so the AI handle / status
 *  bar can pulse in lockstep with the bottom drawer, and staging an
 *  artifact-generated prompt into the chat input so the user can review
 *  / edit / grant permissions before sending. */
export interface RunPanelHandle {
  reopenSession: (session: SessionFull) => void;
  /** Flip the panel between collapsed (compact header) and expanded
   *  (full output + chat input). Wired to the header AI button. */
  toggleCollapsed: () => void;
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
      chatId = "default",
      initialState,
      visible = true,
      initialCollapsed = true,
      onStatusChange,
    },
    ref,
  ) {
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const outputRef = useRef<HTMLPreElement | null>(null);

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
  const [chatDraft, setChatDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage>(EMPTY_USAGE);
  const [selectedScope, setSelectedScope] = useState<string>(VAULT_SCOPE);

  /** When true, prepend a hardening preamble to the next outgoing prompt
   *  telling the agent NOT to read files under personal-work or
   *  team-management zones. The vault is still passed as `--add-dir` —
   *  this is a behavioural instruction, not a filesystem block — but the
   *  agent honours it reliably. Session-only state; the toggle resets on
   *  app launch so an absent-minded `true` from a past session doesn't
   *  silently weaken future runs. */
  const [excludePersonalZones, setExcludePersonalZones] = useState(false);

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

  /** Ref to the chat textarea so `stagePrompt` can focus it after writing
   *  the draft. The user expects to land in the input ready to edit. */
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

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

  // Recent active sessions, populated when the user opens the dropdown.
  // Lazy-loaded so the panel mount cost stays unchanged for users who
  // never touch the chat history.
  const [recentSessions, setRecentSessions] = useState<SessionSummary[] | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionMenuError, setSessionMenuError] = useState<string | null>(null);

  // Cache backing the collapsed compact header — latest session + count
  // for this vault. Eager-fetched while idle so the drawer can say "last
  // run 11m ago · $0.21" without waiting for a menu open. Invalidated on
  // run exit so the next idle picks up the freshly saved row.
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
          setChatDraft("");
          setChatError(null);
          // Staging chip belongs to the pre-send moment — once the run
          // actually starts, drop the marker so the panel reads as a
          // regular conversation again.
          setStagedSource(null);
          setStatus({ kind: "running", started: ev });
          setCollapsed(false);
        },
        onStdout: (ev) => {
          if (!isMine(ev.runId)) return;
          // Single JSON.parse per stream line — three downstream
          // consumers (session id capture, usage accumulation, the
          // pretty-printer) all read the same object. Parsing once
          // and dispatching keeps long bursts cheap.
          const parsed = parseClaudeLine(ev.line);
          // Capture the session id once per stream so the chat input can
          // resume the conversation after exit. Subsequent system events
          // in the same run carry the same id; setSessionId is idempotent
          // on identical values.
          const sid = extractClaudeSessionId(parsed.obj);
          if (sid) setSessionId(sid);
          // Accumulate usage / cost from this line. Token deltas come
          // from `assistant.message.usage`; final per-turn cost comes
          // from the `result` event. Both contribute to the running
          // total displayed in the header.
          const delta = extractClaudeUsageDelta(parsed.obj);
          if (delta) {
            setUsage((prev) => mergeUsage(prev, delta));
          }
          for (const rendered of renderClaudeStreamLine(parsed)) {
            appendLine({ kind: rendered.kind, text: rendered.text });
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
    setPendingPermission(null);
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
      setCurrentRunId(ev.runId);
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
      setChatDraft("");
      setChatError(null);
      setStagedSource(null);
      setStatus({ kind: "running", started: ev });
      setCollapsed(false);
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
        const startedNew = started.freeform
          ? await resumeFreeformRun({
              vaultRoot: started.vaultRoot,
              workdir: started.workdir,
              additionalDirs: started.additionalDirs,
              projectSlug: started.projectSlug,
              sessionId,
              reply: text,
            })
          : await resumeRun({
              vaultRoot: started.vaultRoot,
              projectSlug: started.projectSlug,
              promptId: started.promptId,
              sessionId,
              reply: text,
            });
        adoptStarted(startedNew);
        return;
      }

      // Fresh freeform run. Capture the user's first message as the
      // pending title BEFORE startFreeformRun resolves and the
      // onStarted handler clears the draft. The title persists across
      // the run lifecycle and surfaces as the History row's heading.
      setPendingTitle(text.slice(0, 200));
      const scopeProject =
        effectiveScope === VAULT_SCOPE
          ? null
          : scopeOptions.find((p) => p.slug === effectiveScope) ?? null;
      // Optional privacy hardening: prepend a behavioural rule telling
      // the agent to stay out of personal-work / team-management zones.
      // The user's typed text stays in the title (above) so History rows
      // don't read like the policy header.
      const outgoing = excludePersonalZones ? PRIVACY_PREAMBLE + text : text;
      if (excludePersonalZones) {
        appendLine({
          kind: "system",
          text: "▸ privacy: personal-work + team-management zones blocked by request",
        });
      }
      const startedNew = await startFreeformRun({
        vaultRoot,
        prompt: outgoing,
        scopeProjectSlug: scopeProject?.slug,
        scopeRepoPath: scopeProject?.localPath ?? undefined,
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
    excludePersonalZones,
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
        usage: {
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          cacheCreationTokens: finalUsage.cacheCreationTokens,
          cacheReadTokens: finalUsage.cacheReadTokens,
          costUsd: finalUsage.costUsd,
          model: finalUsage.model,
        },
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
      runner: "claude-code",
      resume: false,
      freeform: session.summary.freeform,
    };
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
      inputTokens: session.summary.inputTokens,
      outputTokens: session.summary.outputTokens,
      // Cache split isn't persisted separately on the summary row, so
      // restore the visible total but leave the cache buckets at zero.
      // Subsequent resume turns will re-accumulate them live.
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: session.summary.costUsd,
      model: session.summary.model,
    });
    setPendingTitle(session.summary.title);
    setStartedAtMs(session.summary.startedAtMs);
    setChatDraft("");
    setStagedSource(null);
    setPendingPermission(null);
    setChatError(null);
    setCollapsed(false);
    setSessionMenuOpen(false);
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
      setStatus({ kind: "running", started: s });
      setCollapsed(false);
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
    const runningSkill =
      started && started.promptId !== "chat" ? started.promptId : null;
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
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      savedCount: lastSessions?.length ?? null,
    });
  }, [
    chatId,
    onStatusChange,
    status,
    pendingPermission,
    pendingTitle,
    usage.inputTokens,
    usage.outputTokens,
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

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => !c);
  }, []);

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
      setCollapsed(false);
      // requestAnimationFrame so the textarea is mounted (the expanded
      // chat input is conditionally rendered while collapsed).
      requestAnimationFrame(() => {
        const el = chatInputRef.current;
        if (!el) return;
        el.focus();
        // Drop the caret at the end so the user can append (e.g.
        // "...also please be brief") without first clicking past the
        // pre-filled text.
        el.setSelectionRange(text.length, text.length);
      });
      return null;
    },
    [status, scopeOptions],
  );

  useImperativeHandle(
    ref,
    () => ({ reopenSession, toggleCollapsed, subscribeToStatus, stagePrompt }),
    [reopenSession, toggleCollapsed, subscribeToStatus, stagePrompt],
  );

  // ---------- Session quick-switch dropdown ----------

  const openSessionMenu = useCallback(async () => {
    setSessionMenuOpen((open) => !open);
    if (recentSessions !== null) return; // already loaded
    try {
      const list = await listSessions(vaultRoot, false);
      setRecentSessions(list);
      setSessionMenuError(null);
    } catch (err) {
      setSessionMenuError(err instanceof Error ? err.message : String(err));
    }
  }, [recentSessions, vaultRoot]);

  // Invalidate the dropdown cache when the panel transitions to
  // exited — opening the menu next time will refetch and pick up the
  // freshly-saved row. The compact-header cache (`lastSessions`) is
  // NOT cleared here: the save-completion path in the persistence
  // effect refreshes it explicitly so the count flips from N → N+1
  // in one render rather than briefly going through `null`.
  useEffect(() => {
    if (status.kind === "exited") {
      setRecentSessions(null);
    }
  }, [status.kind]);

  // Eager-fetch the recent session list whenever the cache is empty.
  // We deliberately don't gate on `status.kind === "idle"` — when the
  // app mounts mid-run (HMR in dev, IDE restart during a long
  // conversation), the run-status sync recovers `kind: "running"`
  // immediately, and an idle-only fetch would never fire. The result
  // was the AI handle and StatusBar reading `savedCount: 0` forever
  // until the run exited. Driving solely off `lastSessions === null`
  // catches the mount-during-running case at the cost of one extra
  // IPC during regular start-from-idle (negligible — same call the
  // dropdown would make on first open).
  useEffect(() => {
    if (lastSessions !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listSessions(vaultRoot, false);
        if (!cancelled) setLastSessions(list);
      } catch {
        // Best-effort: the compact line falls back to bare "● idle".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultRoot, lastSessions]);

  const onPickSessionFromMenu = useCallback(
    async (summary: SessionSummary) => {
      try {
        const full = await getSession(summary.id);
        reopenSession(full);
      } catch (err) {
        setSessionMenuError(err instanceof Error ? err.message : String(err));
      }
    },
    [reopenSession],
  );

  /**
   * Refresh the dropdown cache without closing the popover, so the user
   * can chain multiple actions (archive one, delete another) without
   * the menu flickering away after each click.
   */
  const refreshSessionMenu = useCallback(async () => {
    try {
      const list = await listSessions(vaultRoot, false);
      setRecentSessions(list);
      setSessionMenuError(null);
    } catch (err) {
      setSessionMenuError(err instanceof Error ? err.message : String(err));
    }
  }, [vaultRoot]);

  const onArchiveFromMenu = useCallback(
    async (summary: SessionSummary) => {
      try {
        await archiveSession(summary.id, !summary.archived);
        await refreshSessionMenu();
      } catch (err) {
        setSessionMenuError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshSessionMenu],
  );

  const onDeleteFromMenu = useCallback(
    async (summary: SessionSummary) => {
      // Confirm before deleting — the action is irreversible and the
      // icon target is small, so a stray click shouldn't wipe a chat.
      const ok = window.confirm(
        `Delete this chat from history?\n\n"${summary.title}"\n\nThis cannot be undone.`,
      );
      if (!ok) return;
      try {
        await deleteSession(summary.id);
        // If we just deleted the currently-active session, drop the
        // exited state too — there's no row to upsert into on resume.
        if (summary.claudeSessionId === sessionId) {
          setStatus({ kind: "idle" });
          setLines([]);
          setSessionId(null);
          setUsage(EMPTY_USAGE);
          setPendingTitle(null);
          setStartedAtMs(null);
        }
        await refreshSessionMenu();
      } catch (err) {
        setSessionMenuError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshSessionMenu, sessionId],
  );

  const statusLabel = useMemo(() => describeStatus(status), [status]);
  const compact = useMemo(
    () => compactStatusLine({ status, usage, lastSessions }),
    [status, usage, lastSessions],
  );
  const sessionsCount = lastSessions?.length ?? recentSessions?.length ?? null;
  const showChatInput =
    !collapsed && status.kind !== "running" && status.kind !== "stopping";

  return (
    <aside
      className={"run-panel" + (collapsed ? " run-panel--collapsed" : "")}
      aria-label="Agent run output"
      // Stay mounted-but-hidden when the host is showing a sibling tab.
      // Unmounting would detach `onRunEvents` and freeze any backend
      // run streaming into this conversation.
      style={visible ? undefined : { display: "none" }}
    >
      <header className="run-panel__header">
        {collapsed ? (
          <>
            <div className="run-panel__compact">
              <span
                className={
                  "run-panel__compact-dot run-panel__compact-dot--" +
                  compact.dot
                }
                aria-hidden="true"
              />
              <span className="run-panel__compact-label">{compact.label}</span>
              {compact.meta && (
                <span className="run-panel__compact-meta">{compact.meta}</span>
              )}
            </div>
            <SessionMenuButton
              open={sessionMenuOpen}
              loading={recentSessions === null && sessionMenuError === null}
              sessions={recentSessions ?? []}
              error={sessionMenuError}
              activeSessionId={sessionId}
              compact
              sessionsCount={sessionsCount}
              onToggle={() => void openSessionMenu()}
              onPick={(s) => void onPickSessionFromMenu(s)}
              onArchive={(s) => void onArchiveFromMenu(s)}
              onDelete={(s) => void onDeleteFromMenu(s)}
              onDismiss={() => setSessionMenuOpen(false)}
            />
          </>
        ) : (
          <>
            <span className="run-panel__title">Chat</span>
            <SessionMenuButton
              open={sessionMenuOpen}
              loading={recentSessions === null && sessionMenuError === null}
              sessions={recentSessions ?? []}
              error={sessionMenuError}
              activeSessionId={sessionId}
              onToggle={() => void openSessionMenu()}
              onPick={(s) => void onPickSessionFromMenu(s)}
              onArchive={(s) => void onArchiveFromMenu(s)}
              onDelete={(s) => void onDeleteFromMenu(s)}
              onDismiss={() => setSessionMenuOpen(false)}
            />
            <span
              className={"run-panel__status run-panel__status--" + status.kind}
            >
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
          </>
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
        {canResume && (
          <button
            type="button"
            className="btn btn--small"
            onClick={onNewChat}
            title="Discard the current session and start a fresh chat"
          >
            New chat
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
      {!collapsed && lines.length > 0 && (
        <pre
          ref={outputRef}
          className="run-panel__output"
          onScroll={onScroll}
        >
          {lines.map((l, i) => (
            <span
              key={i}
              className={"run-panel__line run-panel__line--" + l.kind}
            >
              {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {!collapsed && (
        <PermissionRequestCard
          request={pendingPermission}
          onResolved={() => setPendingPermission(null)}
        />
      )}
      {showChatInput && (
        <form
          className="run-panel__chat"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <div className="run-panel__chat-scope">
            <label
              htmlFor="run-panel-scope"
              className="run-panel__chat-scope-label"
            >
              Scope:
            </label>
            <select
              id="run-panel-scope"
              className="run-panel__chat-scope-select"
              value={effectiveScope}
              onChange={(e) => setSelectedScope(e.target.value)}
              disabled={scopeLocked}
              title={
                scopeLocked
                  ? "Scope is locked while continuing this session"
                  : "Where the agent runs. 'Vault only' runs in the vault; selecting a project runs in its repo with the vault available via --add-dir."
              }
            >
              <option value={VAULT_SCOPE}>Vault only</option>
              {scopeOptions.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.slug} (repo)
                </option>
              ))}
            </select>
            <label
              className="run-panel__chat-privacy"
              title={
                "When on, the next message is prefixed with a strict instruction telling the agent NOT to read personal-work or team-management zones. The vault is still passed to the agent via --add-dir — this is a behavioural rule, not a filesystem block — but the model honours it reliably. Session-only; resets on app launch."
              }
            >
              <input
                type="checkbox"
                checked={excludePersonalZones}
                onChange={(e) => setExcludePersonalZones(e.target.checked)}
                disabled={sending}
              />
              <span>🔒 Skip personal zones</span>
            </label>
          </div>
          {stagedSource && (
            <div
              className="run-panel__staged"
              role="status"
              aria-label="Staged artifact"
            >
              <span className="run-panel__staged-label">
                Staged from{" "}
                <code>
                  {stagedSource.projectSlug}/{stagedSource.promptId}
                </code>{" "}
                — review and Send to run.
              </span>
              <button
                type="button"
                className="btn btn--small btn--ghost"
                onClick={() => {
                  setStagedSource(null);
                  setChatDraft("");
                }}
                title="Discard the staged prompt"
              >
                Clear
              </button>
            </div>
          )}
          <textarea
            ref={chatInputRef}
            className="run-panel__chat-input"
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            placeholder={
              canResume
                ? "Reply to continue the conversation. Cmd/Ctrl+Enter to send."
                : "Ask the agent to read, create, or edit files. Cmd/Ctrl+Enter to send."
            }
            rows={3}
            disabled={sending}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void onSend();
              }
            }}
            aria-label={canResume ? "Reply to the agent" : "Message to the agent"}
          />
          <div className="run-panel__chat-actions">
            {chatError && (
              <span className="run-panel__chat-error" role="alert">
                {chatError}
              </span>
            )}
            <button
              type="submit"
              className="btn btn--primary btn--small"
              disabled={sending || chatDraft.trim() === ""}
            >
              {sending
                ? canResume
                  ? "Replying…"
                  : "Sending…"
                : canResume
                  ? "Reply"
                  : "Send"}
            </button>
          </div>
        </form>
      )}
    </aside>
  );
  },
);

interface SessionMenuButtonProps {
  open: boolean;
  loading: boolean;
  sessions: SessionSummary[];
  error: string | null;
  activeSessionId: string | null;
  /** Collapsed-mode RunPanel: shorten the toggle label to `☰ {count}`. */
  compact?: boolean;
  /** Total session count for the compact label; `null` when unknown. */
  sessionsCount?: number | null;
  onToggle: () => void;
  onPick: (s: SessionSummary) => void;
  onArchive: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
  onDismiss: () => void;
}

/**
 * Compact "History" dropdown in the chat panel header. Each row exposes
 * the same three actions the History tab offers (reopen / archive /
 * delete) so the user doesn't have to leave the chat panel to clean up
 * their list. The full History tab remains the place for bulk review,
 * filtering, and surfacing archived items.
 */
function SessionMenuButton({
  open,
  loading,
  sessions,
  error,
  activeSessionId,
  compact = false,
  sessionsCount = null,
  onToggle,
  onPick,
  onArchive,
  onDelete,
  onDismiss,
}: SessionMenuButtonProps) {
  const visible = sessions.slice(0, 12);
  // Compact label drops the word "History" — the icon carries the
  // meaning in the collapsed drawer; the count is the only extra signal
  // worth showing inline.
  const toggleLabel = compact
    ? sessionsCount != null
      ? `☰ ${sessionsCount}`
      : "☰"
    : "⌛ History";
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const menuStyle = usePopoverPosition({
    anchorRef: toggleRef,
    open,
    placement: "top",
    align: "auto",
  });
  return (
    <div className="run-panel__history">
      <button
        ref={toggleRef}
        type="button"
        className="btn btn--small run-panel__history-toggle"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Reopen, archive, or delete recent chats"
      >
        {toggleLabel}
      </button>
      {open && (
        <>
          <div
            className="run-panel__history-scrim"
            onClick={onDismiss}
            aria-hidden="true"
          />
          <div
            className="run-panel__history-menu"
            role="listbox"
            style={menuStyle}
          >
            {loading && (
              <div className="run-panel__history-empty">Loading…</div>
            )}
            {error && (
              <div className="run-panel__history-empty run-panel__history-empty--err">
                {error}
              </div>
            )}
            {!loading && !error && visible.length === 0 && (
              <div className="run-panel__history-empty">
                No saved chats yet.
              </div>
            )}
            {!loading &&
              !error &&
              visible.map((s) => (
                <div
                  key={s.id}
                  className={
                    "run-panel__history-item" +
                    (s.claudeSessionId === activeSessionId
                      ? " run-panel__history-item--active"
                      : "")
                  }
                >
                  <button
                    type="button"
                    className="run-panel__history-item-main"
                    onClick={() => onPick(s)}
                    title={s.title}
                  >
                    <span className="run-panel__history-item-title">
                      {truncateTitle(s.title)}
                    </span>
                    <span className="run-panel__history-item-meta">
                      {s.freeform ? "chat" : s.projectSlug} ·{" "}
                      {formatRelativeMs(s.startedAtMs)}
                    </span>
                  </button>
                  <div className="run-panel__history-item-actions">
                    <button
                      type="button"
                      className="run-panel__history-item-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        onArchive(s);
                      }}
                      title="Archive — exempt from auto-trim"
                      aria-label="Archive chat"
                    >
                      📥
                    </button>
                    <button
                      type="button"
                      className="run-panel__history-item-action run-panel__history-item-action--danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s);
                      }}
                      title="Delete permanently"
                      aria-label="Delete chat"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function truncateTitle(s: string): string {
  if (s.length <= 60) return s;
  return s.slice(0, 59) + "…";
}

function formatRelativeMs(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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

/** Visual state for the collapsed compact header row.
 *
 * `dot` selects the colored status indicator class
 * (`run-panel__compact-dot--{dot}`). `label` is the primary status word
 * (idle / running / ready to reply / stopping). `meta` is the optional
 * trailing detail string — scope, tokens, cost, last-run age.
 */
interface CompactStatus {
  dot: "muted" | "running" | "stopping" | "ok";
  label: string;
  meta: string | null;
}

/**
 * Build the one-line status payload rendered when the RunPanel is
 * collapsed. Idle uses the cached `lastSessions` list to surface the
 * most recent run; running / stopping / exited summarise the current
 * session from `status` + `usage`. Side-effect free — purely a view
 * helper so the JSX stays a thin renderer.
 */
function compactStatusLine(args: {
  status: RunStatus;
  usage: SessionUsage;
  lastSessions: SessionSummary[] | null;
}): CompactStatus {
  const { status, usage, lastSessions } = args;
  const usageSummary = hasUsage(usage) ? formatUsageSummary(usage) : null;

  switch (status.kind) {
    case "running": {
      const parts = [scopeLabel(status.started)];
      if (usageSummary) parts.push(usageSummary);
      return { dot: "running", label: "running", meta: parts.join(" · ") };
    }
    case "stopping": {
      const parts = [scopeLabel(status.started)];
      if (usageSummary) parts.push(usageSummary);
      return { dot: "stopping", label: "stopping…", meta: parts.join(" · ") };
    }
    case "exited": {
      const parts: string[] = [];
      if (status.started) parts.push(scopeLabel(status.started));
      if (usageSummary) parts.push(usageSummary);
      return {
        dot: "ok",
        label: "ready to reply",
        meta: parts.length > 0 ? parts.join(" · ") : null,
      };
    }
    case "idle": {
      const latest = lastSessions && lastSessions.length > 0
        ? lastSessions[0]
        : null;
      if (!latest) {
        return {
          dot: "muted",
          label: "idle",
          meta: lastSessions === null ? null : "no chats yet",
        };
      }
      const parts = [`last run ${formatRelativeMs(latest.startedAtMs)}`];
      if (latest.costUsd > 0) parts.push(formatCost(latest.costUsd));
      return { dot: "muted", label: "idle", meta: parts.join(" · ") };
    }
  }
}

/**
 * Short, glanceable label for the run's scope. Freeform vault runs
 * render as `vault`; freeform project runs render as the slug; artifact
 * runs render as `slug/promptId` so the user can tell which prompt is
 * running without expanding the panel.
 */
function scopeLabel(started: RunStartedEvent): string {
  if (started.freeform) {
    return started.projectSlug === "(vault)" ? "vault" : started.projectSlug;
  }
  return `${started.projectSlug}/${started.promptId}`;
}

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
        in: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
        out: usage.outputTokens,
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

// ---------- Claude stream-line parsing ----------

/** Parsed representation of one stdout line from claude. `obj` is the
 *  JSON object when the line parses; `null` for plain text / unparseable
 *  lines. `raw` is always carried so the renderer can fall back to
 *  printing the line verbatim. */
interface ParsedClaudeLine {
  obj: Record<string, unknown> | null;
  raw: string;
}

/** Single JSON.parse per stdout line. Cheaper than the prior pipeline
 *  where three helpers each parsed the same line; for long streams the
 *  saving is linear in line count. */
function parseClaudeLine(raw: string): ParsedClaudeLine {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed[0] !== "{") return { obj: null, raw };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return { obj: isRecord(parsed) ? parsed : null, raw };
  } catch {
    return { obj: null, raw };
  }
}

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

function extractClaudeUsageDelta(
  parsed: Record<string, unknown> | null,
): UsageDelta | null {
  if (parsed === null) return null;
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

function extractClaudeSessionId(
  parsed: Record<string, unknown> | null,
): string | null {
  if (parsed === null) return null;
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
function renderClaudeStreamLine(parsed: ParsedClaudeLine): RenderedLine[] {
  const { obj, raw } = parsed;
  if (obj === null) {
    // Either the line was empty or didn't parse as a JSON object;
    // fall back to printing it verbatim so we never silently drop
    // output we don't recognise.
    if (raw.trim() === "") return [];
    return [{ kind: "stdout", text: raw }];
  }
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
      // `result.result` is a recap of the final assistant message that we
      // already rendered from the `assistant.message.content[].text` block,
      // so we deliberately don't emit it here — otherwise the answer
      // appears twice. Only render the result marker line itself.
      const subtype = readString(obj, "subtype") ?? "?";
      const duration = readNumber(obj, "duration_ms");
      const cost = readNumber(obj, "total_cost_usd");
      const parts = [`◆ result: ${subtype}`];
      if (duration != null) parts.push(`${Math.round(duration / 1000)}s`);
      if (cost != null) parts.push(`$${cost.toFixed(4)}`);
      return [{ kind: "system", text: parts.join(" · ") }];
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
