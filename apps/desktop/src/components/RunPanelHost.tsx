import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  archiveSession,
  deleteSession,
  getRuns,
  getSession,
  listSessions,
  type RunStartedEvent,
} from "../api";
import type { Draft, Project, SessionFull, SessionSummary } from "../types";
import {
  RunPanel,
  type ChatTabStatusInfo,
  type RunPanelHandle,
  type RunStatusInfo,
} from "./RunPanel";
import {
  formatCost,
  formatRelativeMs,
  truncateTitle,
} from "./shell/chatFormat";
import { Dot, PanelHead } from "./shell/LeftPanel";
import { ShellIcon } from "./shell/ShellIcon";
import { useDragWidth } from "./shell/useDragWidth";

/** Resize bounds per the shell spec. */
const MIN_WIDTH = 320;
const MAX_WIDTH = 560;

interface RunPanelHostProps {
  vaultRoot: string;
  projects: Project[];
  /** Current drafts from the scan — RunPanel diffs them against a
   *  run-start snapshot to surface the "N drafts written" notice. */
  drafts: Draft[];
  /** Whether the agent panel is the open left panel. The host stays
   *  mounted regardless (`display: none` when closed) so running chats
   *  keep streaming — the rail icon pulses and the statusbar reflects
   *  them while hidden. */
  open: boolean;
  /** Panel width (px), owned + persisted by Dashboard. */
  width: number;
  onResize: (width: number) => void;
  /** Open the Drafts panel (rail) — target of the drafts notice. */
  onOpenDrafts: () => void;
}

/** Per-tab `initialState` bag — same union RunPanel accepts as a prop. */
type ChatInitialState =
  | { kind: "adopt"; started: RunStartedEvent }
  | { kind: "reopen"; session: SessionFull };

/**
 * One chat conversation tracked by the host. The `initialState` is set
 * when the chat is created (mount-sync adoption, history reopen) and
 * consumed once by the RunPanel; we never re-apply it on subsequent
 * renders.
 */
interface ChatTabRecord {
  id: string;
  initialState?: ChatInitialState;
}

let chatIdCounter = 0;
function nextChatId(): string {
  // Counter + epoch ms guarantees uniqueness across reloads and HMR
  // resets. Used as React `key` for the panel mount + as the routing
  // tag carried on every `onStatusChange` callback.
  chatIdCounter += 1;
  return `chat-${chatIdCounter}-${Date.now()}`;
}

/**
 * Agent panel host (shell v2, Zed-style, 404px on the left).
 *
 * Owns the list of concurrent chat conversations, mounts one `RunPanel`
 * per chat (keeping inactive ones in the DOM but hidden so their state
 * and event listeners survive switches), renders the panel header
 * (session pill, history toggle, new chat) and the session-history
 * pane, and forwards the imperative handle Dashboard expects.
 *
 * Lifecycle ownership:
 *  - Mount-sync (`getRuns()`): the host hydrates one chat per running
 *    backend run on first mount.
 *  - Chat creation: header "+" button, `reopenSession` (a saved session
 *    opens into a fresh chat), history-pane clicks.
 *  - Chat closing: the × on open-chat rows in the history pane.
 */
export const RunPanelHost = forwardRef<RunPanelHandle, RunPanelHostProps>(
  function RunPanelHost(
    { vaultRoot, projects, drafts, open, width, onResize, onOpenDrafts },
    ref,
  ) {
    const [chats, setChats] = useState<ChatTabRecord[]>(() => [
      { id: nextChatId() },
    ]);
    const [activeChatId, setActiveChatId] = useState<string>(
      () => chats[0]!.id,
    );

    // History pane state. Sessions are fetched on open (and refreshed
    // after archive/delete) rather than kept hot — the pane is a
    // navigation surface, not a live view.
    const [historyOpen, setHistoryOpen] = useState(false);
    const [savedSessions, setSavedSessions] = useState<
      SessionSummary[] | null
    >(null);
    const [historyError, setHistoryError] = useState<string | null>(null);

    // Per-chat status snapshots, keyed by chatId. Drives the header
    // pill, the open-chats rows in the history pane, and the host's
    // `subscribeToStatus` aggregation. Map cloning on every update is
    // cheap at this cardinality (≤3).
    const [tabStatus, setTabStatus] = useState<Map<string, ChatTabStatusInfo>>(
      () => new Map(),
    );

    // Per-chat imperative handles. Populated by each RunPanel via its
    // forwarded ref; the host reads from here to dispatch `stagePrompt`
    // to the active chat.
    const handlesRef = useRef<Map<string, RunPanelHandle | null>>(new Map());

    // Ambient status subscribers (Dashboard registers one). The host
    // re-broadcasts an aggregated `RunStatusInfo` derived from every
    // chat's `ChatTabStatusInfo` (see effect below).
    const subscribersRef = useRef<Set<(info: RunStatusInfo) => void>>(
      new Set(),
    );
    // Last emitted aggregate, kept in a ref so a fresh subscriber can
    // fire-on-subscribe without waiting for the next transition.
    const lastAggregateRef = useRef<RunStatusInfo>({
      state: "idle",
      runningCount: 0,
      runningSkill: null,
      runningProject: null,
      lastUsage: null,
      savedCount: null,
    });

    // ---------- Mount-sync ----------

    // Hydrate one chat per backend run that was already alive when the
    // host mounted. Best-effort: a failed getRuns just leaves the
    // default empty chat.
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        try {
          const live = await getRuns();
          if (cancelled || live.length === 0) return;
          // Sort by run_id prefix so the order is stable across
          // reloads — the gen counter inside the id increases
          // monotonically.
          const sorted = [...live].sort((a, b) =>
            a.runId.localeCompare(b.runId),
          );
          const tabs: ChatTabRecord[] = sorted.map((started) => ({
            id: nextChatId(),
            initialState: { kind: "adopt", started },
          }));
          setChats(tabs);
          setActiveChatId(tabs[0]!.id);
        } catch {
          // Non-fatal — events alone will recover when the user
          // interacts with the panel.
        }
      })();
      return () => {
        cancelled = true;
      };
      // Intentionally empty deps — this is a once-on-mount sync.
    }, []);

    // ---------- Status aggregation + broadcast ----------

    // Re-aggregate and broadcast whenever any chat's status snapshot
    // changes. The aggregate is the *vault-wide* view consumed by the
    // rail agent icon (pulse when anything runs) and the statusbar
    // (running count, total spend).
    useEffect(() => {
      let state: RunStatusInfo["state"] = "idle";
      let runningCount = 0;
      let runningSkill: string | null = null;
      let runningProject: string | null = null;
      let sumCost = 0;
      let repContextUsed = 0;
      let repContextSize = 0;
      let anyUsage = false;
      let maxSaved: number | null = null;
      for (const info of tabStatus.values()) {
        if (info.state === "running" || info.state === "stopping") {
          state = "running";
          runningCount += 1;
          if (runningSkill === null) runningSkill = info.runningSkill;
          if (runningProject === null) runningProject = info.runningProject;
          // First running chat wins the representative context numbers.
          if (repContextUsed === 0 && info.contextUsed > 0) {
            repContextUsed = info.contextUsed;
            repContextSize = info.contextSize;
          }
        } else if (info.state === "exited" && state !== "running") {
          state = "exited";
        }
        if (info.contextUsed || info.costUsd) {
          sumCost += info.costUsd;
          anyUsage = true;
        }
        if (info.savedCount !== null) {
          maxSaved = Math.max(maxSaved ?? 0, info.savedCount);
        }
      }
      const aggregate: RunStatusInfo = {
        state,
        runningCount,
        runningSkill,
        runningProject,
        lastUsage: anyUsage
          ? {
              contextUsed: repContextUsed,
              contextSize: repContextSize,
              cost: sumCost,
            }
          : null,
        savedCount: maxSaved,
      };
      lastAggregateRef.current = aggregate;
      for (const cb of subscribersRef.current) {
        try {
          cb(aggregate);
        } catch {
          // Don't let one bad subscriber break the rest.
        }
      }
    }, [tabStatus]);

    // ---------- Chat actions ----------

    const addChat = useCallback(() => {
      const id = nextChatId();
      setChats((prev) => [...prev, { id }]);
      setActiveChatId(id);
      setHistoryOpen(false);
    }, []);

    const closeChat = useCallback((id: string) => {
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === id);
        if (idx < 0) return prev;
        const next = prev.filter((c) => c.id !== id);
        // Always keep at least one chat — closing the last creates a
        // fresh empty replacement so the user always has somewhere to
        // type.
        if (next.length === 0) {
          const fresh: ChatTabRecord = { id: nextChatId() };
          setActiveChatId(fresh.id);
          return [fresh];
        }
        // If we closed the active chat, pick a neighbour (next-right
        // by default; falls back to the new last when we closed the
        // rightmost). Otherwise the active stays put.
        setActiveChatId((current) => {
          if (current !== id) return current;
          const neighbour = next[Math.min(idx, next.length - 1)]!;
          return neighbour.id;
        });
        return next;
      });
      handlesRef.current.delete(id);
      setTabStatus((m) => {
        if (!m.has(id)) return m;
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    }, []);

    // ---------- History pane ----------

    const refreshHistory = useCallback(async () => {
      try {
        const list = await listSessions(vaultRoot, false);
        setSavedSessions(list);
        setHistoryError(null);
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : String(err));
      }
    }, [vaultRoot]);

    const toggleHistory = useCallback(() => {
      setHistoryOpen((prev) => {
        if (!prev) void refreshHistory();
        return !prev;
      });
    }, [refreshHistory]);

    const onPickSaved = useCallback(
      async (summary: SessionSummary) => {
        try {
          const full = await getSession(summary.id);
          const id = nextChatId();
          setChats((prev) => [
            ...prev,
            { id, initialState: { kind: "reopen", session: full } },
          ]);
          setActiveChatId(id);
          setHistoryOpen(false);
        } catch (err) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      },
      [],
    );

    const onArchiveSaved = useCallback(
      async (summary: SessionSummary) => {
        try {
          await archiveSession(summary.id, !summary.archived);
          await refreshHistory();
        } catch (err) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      },
      [refreshHistory],
    );

    const onDeleteSaved = useCallback(
      async (summary: SessionSummary) => {
        // Confirm before deleting — irreversible, and the icon target
        // is small enough that a stray click shouldn't wipe a chat.
        const ok = window.confirm(
          `Delete this chat from history?\n\n"${summary.title}"\n\nThis cannot be undone.`,
        );
        if (!ok) return;
        try {
          await deleteSession(summary.id);
          await refreshHistory();
        } catch (err) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      },
      [refreshHistory],
    );

    // ---------- Imperative handle ----------

    const reopenSession = useCallback((session: SessionFull) => {
      // Open the saved session in a fresh chat so the user doesn't
      // lose whatever was in the previously-active one.
      const id = nextChatId();
      setChats((prev) => [
        ...prev,
        { id, initialState: { kind: "reopen", session } },
      ]);
      setActiveChatId(id);
      setHistoryOpen(false);
    }, []);

    const subscribeToStatus = useCallback(
      (cb: (info: RunStatusInfo) => void) => {
        subscribersRef.current.add(cb);
        // Fire-on-subscribe with the latest aggregate so the consumer
        // doesn't render a stale default before the next transition.
        try {
          cb(lastAggregateRef.current);
        } catch {
          // ignore — same rationale as the broadcast loop
        }
        return () => {
          subscribersRef.current.delete(cb);
        };
      },
      [],
    );

    const stagePrompt = useCallback<RunPanelHandle["stagePrompt"]>(
      (args) => {
        setHistoryOpen(false);
        const handle = handlesRef.current.get(activeChatId);
        // Best case: active chat is idle / exited — stage in place so
        // the user keeps the visual context.
        if (handle) {
          const err = handle.stagePrompt(args);
          if (!err) return null;
          // Active chat is running. Fall through to opening a new one
          // rather than blocking the user with the inline error.
        }
        // Stage in a new chat. The new RunPanel mounts on the next
        // commit; we dispatch stagePrompt to it after a frame so its
        // imperative handle is registered.
        const id = nextChatId();
        setChats((prev) => [...prev, { id }]);
        setActiveChatId(id);
        requestAnimationFrame(() => {
          const newHandle = handlesRef.current.get(id);
          newHandle?.stagePrompt(args);
        });
        return null;
      },
      [activeChatId],
    );

    useImperativeHandle(
      ref,
      () => ({ reopenSession, subscribeToStatus, stagePrompt }),
      [reopenSession, subscribeToStatus, stagePrompt],
    );

    const onTabStatusChange = useCallback((info: ChatTabStatusInfo) => {
      setTabStatus((m) => {
        const prev = m.get(info.chatId);
        // Structural skip — avoids a fan-out re-render for each
        // token-delta update on hot streams.
        if (
          prev &&
          prev.state === info.state &&
          prev.title === info.title &&
          prev.hasPendingPermission === info.hasPendingPermission &&
          prev.runningSkill === info.runningSkill &&
          prev.runningProject === info.runningProject &&
          prev.contextUsed === info.contextUsed &&
          prev.contextSize === info.contextSize &&
          prev.costUsd === info.costUsd &&
          prev.savedCount === info.savedCount
        ) {
          return m;
        }
        const next = new Map(m);
        next.set(info.chatId, info);
        return next;
      });
    }, []);

    const activeInfo = tabStatus.get(activeChatId);
    const activeTitle = activeInfo?.title ?? "New chat";

    const onDragStart = useDragWidth({
      width,
      min: MIN_WIDTH,
      max: MAX_WIDTH,
      onChange: onResize,
    });

    return (
      <aside
        className="ide-panel agent"
        aria-label="Agent"
        style={open ? { width } : { display: "none" }}
      >
        <div
          className="ide-rhandle right"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize agent panel"
          title="Drag to resize"
          onPointerDown={onDragStart}
        />
        <PanelHead title="Agent">
          {!historyOpen && (
            <span
              className="ide-pill accent"
              style={{
                maxWidth: 190,
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "inline-block",
                whiteSpace: "nowrap",
              }}
              title={activeTitle}
            >
              {truncateTitle(activeTitle, 40)}
            </span>
          )}
          {historyOpen && (
            <span className="count">
              {savedSessions === null ? "…" : `${savedSessions.length} saved`}
            </span>
          )}
          <span className="grow" />
          <button
            type="button"
            className={"hbtn" + (historyOpen ? " on" : "")}
            title="Session history"
            aria-label="Session history"
            aria-pressed={historyOpen}
            onClick={toggleHistory}
          >
            <ShellIcon name="menu" size={16} />
          </button>
          <button
            type="button"
            className="hbtn"
            title="New chat"
            aria-label="New chat"
            onClick={addChat}
          >
            <ShellIcon name="plus" size={16} />
          </button>
        </PanelHead>

        {/* Conversations stay mounted while the history pane covers
            them — unmounting would detach run listeners mid-stream. */}
        <div
          className="ide-agent-stack"
          style={historyOpen ? { display: "none" } : undefined}
        >
          {chats.map((c) => (
            <RunPanel
              key={c.id}
              ref={(handle) => {
                if (handle) handlesRef.current.set(c.id, handle);
                else handlesRef.current.delete(c.id);
              }}
              vaultRoot={vaultRoot}
              projects={projects}
              drafts={drafts}
              chatId={c.id}
              initialState={c.initialState}
              visible={open && !historyOpen && c.id === activeChatId}
              onStatusChange={onTabStatusChange}
              onOpenDrafts={onOpenDrafts}
            />
          ))}
        </div>

        {historyOpen && (
          <div className="ide-panel-body">
            <div className="ide-secline">
              <span>Open chats</span>
              <span className="grow" />
              <span>{chats.length}</span>
            </div>
            {chats.map((c) => {
              const info = tabStatus.get(c.id);
              const running =
                info?.state === "running" || info?.state === "stopping";
              return (
                <div
                  key={c.id}
                  className={
                    "ide-srow" + (c.id === activeChatId ? " active" : "")
                  }
                >
                  <button
                    type="button"
                    className="main"
                    onClick={() => {
                      setActiveChatId(c.id);
                      setHistoryOpen(false);
                    }}
                    title={info?.title ?? "New chat"}
                  >
                    <Dot
                      kind={
                        running
                          ? "run"
                          : info?.state === "exited"
                            ? "ok"
                            : "idle"
                      }
                    />
                    <span className="ttl">{info?.title ?? "New chat"}</span>
                    {info?.hasPendingPermission && (
                      <span
                        className="ide-pill warn"
                        style={{ height: 15, fontSize: 9 }}
                        title="Waiting on a permission decision"
                      >
                        !
                      </span>
                    )}
                    <span className="meta">
                      {info && info.costUsd > 0
                        ? formatCost(info.costUsd)
                        : running
                          ? "running"
                          : ""}
                    </span>
                  </button>
                  {chats.length > 1 && (
                    <button
                      type="button"
                      className="act"
                      onClick={() => closeChat(c.id)}
                      title="Close chat"
                      aria-label="Close chat"
                    >
                      <ShellIcon name="close" size={12} />
                    </button>
                  )}
                </div>
              );
            })}

            <div className="ide-secline" style={{ marginTop: 6 }}>
              <span>Saved</span>
              <span className="grow" />
              <span>{savedSessions?.length ?? ""}</span>
            </div>
            {historyError && (
              <p className="ide-panel-hint" style={{ color: "var(--err)" }}>
                {historyError}
              </p>
            )}
            {savedSessions === null && !historyError && (
              <p className="ide-panel-hint">Loading…</p>
            )}
            {savedSessions !== null && savedSessions.length === 0 && (
              <p className="ide-panel-hint">No saved chats yet.</p>
            )}
            {savedSessions?.map((s) => (
              <div key={s.id} className="ide-srow">
                <button
                  type="button"
                  className="main"
                  onClick={() => void onPickSaved(s)}
                  title={s.title}
                >
                  <Dot kind={s.exitSuccess === false ? "err" : "ok"} />
                  <span className="col">
                    <span className="ttl">{truncateTitle(s.title)}</span>
                    <span className="sub">
                      {s.freeform ? "chat" : `${s.projectSlug}/${s.promptId}`}
                      {s.model ? ` · ${s.model}` : ""}
                    </span>
                  </span>
                  <span className="right">
                    {formatRelativeMs(s.startedAtMs)}
                    <br />
                    {s.costUsd > 0 ? formatCost(s.costUsd) : "—"}
                  </span>
                </button>
                <button
                  type="button"
                  className="act"
                  onClick={() => void onArchiveSaved(s)}
                  title={
                    s.archived
                      ? "Unarchive"
                      : "Archive — exempt from auto-trim"
                  }
                  aria-label="Archive chat"
                >
                  <ShellIcon name="drafts" size={13} />
                </button>
                <button
                  type="button"
                  className="act danger"
                  onClick={() => void onDeleteSaved(s)}
                  title="Delete permanently"
                  aria-label="Delete chat"
                >
                  <ShellIcon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>
    );
  },
);
