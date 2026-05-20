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
  getRunStatus,
  getSession,
  listSessions,
  onRunEvents,
  resumeFreeformRun,
  resumeRun,
  saveSession,
  startFreeformRun,
  stopRun,
  type RunExitEvent,
  type RunStartedEvent,
} from "../api";
import { usePopoverPosition } from "../hooks/usePopoverPosition";
import type { Project, SessionFull, SessionSummary } from "../types";
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

interface RunPanelProps {
  /** Canonical vault root. Forwarded to `start_freeform_run`. */
  vaultRoot: string;
  /** All projects from the current scan. The scope dropdown filters down
   *  to those with a `localPath` (the rest can't be a cwd target). */
  projects: Project[];
}

/** Snapshot of the live run state suitable for ambient UI surfaces
 *  outside the panel itself (TitleBar AI handle, StatusBar). Keep this
 *  derived view minimal — the RunPanel internals carry richer state,
 *  but Dashboard / chrome consumers should never reach into that. */
export interface RunStatusInfo {
  /** Compressed lifecycle. `running` covers both the live-streaming
   *  state and the brief `stopping` window (cosmetic distinction not
   *  worth exposing to ambient UI). */
  state: "idle" | "running" | "exited";
  /** Skill / prompt id when running an artifact run (e.g.
   *  `"session-reflect"`). `null` for freeform chats. */
  runningSkill: string | null;
  /** Project slug of the active chat (e.g. `"subgraph"`). `null` for
   *  vault-scope freeform runs. */
  runningProject: string | null;
  /** Last reported usage totals across the live session, or `null`
   *  before any usage event has arrived. */
  lastUsage: { in: number; out: number; cost: number } | null;
  /** Total saved sessions for this vault. `null` before the first
   *  `listSessions` call resolves. RunPanel is the single source of
   *  truth — it refetches after every save_session UPSERT so the
   *  count stays consistent with what's actually on disk. */
  savedCount: number | null;
}

/** Imperative handle exposed to Dashboard. Used today for three things:
 *  reopening a saved session into the editor's chat panel, toggling
 *  the panel collapsed state from the header AI button, and letting
 *  ambient surfaces subscribe to run-status updates so the AI handle
 *  / status bar can pulse in lockstep with the bottom drawer. */
export interface RunPanelHandle {
  reopenSession: (session: SessionFull) => void;
  /** Flip the panel between collapsed (compact header) and expanded
   *  (full output + chat input). Wired to the header AI button. */
  toggleCollapsed: () => void;
  /** Subscribe to live status updates. The callback fires once
   *  immediately with the current snapshot, then on every transition
   *  thereafter. Returns an unsubscribe function. */
  subscribeToStatus: (cb: (info: RunStatusInfo) => void) => () => void;
}

export const RunPanel = forwardRef<RunPanelHandle, RunPanelProps>(
  function RunPanel({ vaultRoot, projects }, ref) {
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const outputRef = useRef<HTMLPreElement | null>(null);

  // Claude session id captured from the first `system init` event in the
  // stream. Once it's set, the user can continue the conversation via the
  // chat input after the run exits. It survives `run:started` of a resumed
  // run (claude reuses the same session id under `--resume`).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage>(EMPTY_USAGE);
  const [selectedScope, setSelectedScope] = useState<string>(VAULT_SCOPE);

  // Session-history bookkeeping. `pendingTitle` is set when the user
  // sends a fresh freeform message — it survives the run lifecycle and
  // becomes the History row's title at save time. `startedAtMs` marks
  // the wall-clock origin so the History view can sort by recency
  // independent of run order.
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);

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
              additionalDirs: [],
              runner: "claude-code",
              resume: false,
              freeform: false,
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
          setStatus({ kind: "running", started: ev });
          setCollapsed(false);
        },
        onStdout: (ev) => {
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
  }, []);

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
        if (started.freeform) {
          await resumeFreeformRun({
            vaultRoot: started.vaultRoot,
            workdir: started.workdir,
            additionalDirs: started.additionalDirs,
            projectSlug: started.projectSlug,
            sessionId,
            reply: text,
          });
        } else {
          await resumeRun({
            vaultRoot: started.vaultRoot,
            projectSlug: started.projectSlug,
            promptId: started.promptId,
            sessionId,
            reply: text,
          });
        }
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
      await startFreeformRun({
        vaultRoot,
        prompt: text,
        scopeProjectSlug: scopeProject?.slug,
        scopeRepoPath: scopeProject?.localPath ?? undefined,
      });
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
  ]);

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

    // Idempotency guard against re-entry. If status flips out of
    // "exited" (resume turn, New chat) and back without any new lines,
    // the on-disk row hasn't moved — skip the round-trip.
    const last = lastSavedSessionRef.current;
    if (
      last !== null &&
      last.sessionId === sessionId &&
      last.linesCount === lines.length
    ) {
      return;
    }

    const started = status.started;
    const exit = status.exit;
    const title = pendingTitle ?? `${started.projectSlug}/${started.promptId}`;
    const started_at = startedAtMs ?? Date.now();
    const snapshotCount = lines.length;

    lastSavedSessionRef.current = {
      sessionId,
      linesCount: snapshotCount,
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
      outputLines: lines.map((l) => ({ kind: l.kind, text: l.text })),
      startedAtMs: started_at,
      endedAtMs: Date.now(),
      exitCode: exit.code,
      exitSuccess: exit.success,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: usage.costUsd,
        model: usage.model,
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
        // Persistence is best-effort — don't blow up the UI. Roll the
        // memo back so a retry on the next render isn't blocked by
        // the optimistic update we wrote above.
        lastSavedSessionRef.current = last;
        const text = err instanceof Error ? err.message : String(err);
        appendLine({
          kind: "system",
          text: `! failed to save chat to history: ${text}`,
        });
      });
    // We deliberately depend only on `status` here. `lines`, `usage`,
    // etc. are read at the moment status flips to "exited" (which is
    // the same render where their final values land via the same
    // event-handler batch). Adding them to deps would trigger spurious
    // re-saves on every render while exited (e.g. if the user types
    // in the chat input).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ---------- Reopen flow ----------

  const reopenSession = useCallback((session: SessionFull) => {
    // Restore the run state as if the saved run had just exited. The
    // Reply path then handles `resume_*_run` using the captured session
    // id and stashed context.
    const synthStarted: RunStartedEvent = {
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
        code: session.summary.exitSuccess === false ? 1 : 0,
        success: session.summary.exitSuccess ?? true,
      },
      started: synthStarted,
    });
    setLines(
      session.outputLines.map((l) => ({
        kind: l.kind as LineKind,
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
    setChatError(null);
    setCollapsed(false);
    setSessionMenuOpen(false);
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

  useImperativeHandle(
    ref,
    () => ({ reopenSession, toggleCollapsed, subscribeToStatus }),
    [reopenSession, toggleCollapsed, subscribeToStatus],
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
          </div>
          <textarea
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
      runningProject: null,
      runningSkill: null,
      lastUsage,
      savedCount,
    };
  }
  return {
    state: "idle",
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
