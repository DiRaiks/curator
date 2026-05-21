import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { getRuns, type RunStartedEvent } from "../api";
import type { Project, SessionFull } from "../types";
import {
  RunPanel,
  type ChatTabStatusInfo,
  type RunPanelHandle,
  type RunStatusInfo,
} from "./RunPanel";

interface RunPanelHostProps {
  vaultRoot: string;
  projects: Project[];
}

/** Per-tab `initialState` bag — same union RunPanel accepts as a prop. */
type ChatInitialState =
  | { kind: "adopt"; started: RunStartedEvent }
  | { kind: "reopen"; session: SessionFull };

/**
 * One chat tab tracked by the host. The `initialState` is set when the
 * tab is created (mount-sync adoption, history reopen) and consumed
 * once by the RunPanel; we never re-apply it on subsequent renders.
 */
interface ChatTabRecord {
  id: string;
  initialState?: ChatInitialState;
  /** When `false`, the panel mounts already-expanded. Set for tabs
   *  the user creates via "+" so adding a chat doesn't visually
   *  collapse the drawer (the new tab's default-collapsed state
   *  would otherwise win on becoming active). Undefined → fall back
   *  to RunPanel's default (collapsed on first mount). */
  initialCollapsed?: boolean;
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
 * Multi-chat host. Manages the list of open chat tabs, mounts one
 * `RunPanel` per tab (keeping inactive ones in the DOM but hidden so
 * their state and event listeners survive tab switches), and forwards
 * the imperative handle that Dashboard expects.
 *
 * Lifecycle ownership:
 *  - Mount-sync (`getRuns()`): the host hydrates one tab per running
 *    backend run on first mount. Panels themselves no longer call
 *    `getRuns()` — sibling tabs would race for the same run.
 *  - Tab creation: explicit "+" button (or `reopenSession` from
 *    Dashboard which opens a new tab around a saved session).
 *  - Tab closing: removes from the list; if the backend run is still
 *    alive the panel sees its `pending_permissions` cleanup as a no-op
 *    on the next event, so no leak.
 *
 * Status aggregation is currently coarse — the host re-broadcasts the
 * *active* tab's `RunStatusInfo` to ambient consumers (TitleBar AI
 * handle, StatusBar). Срез 5 will replace this with a true aggregate
 * (any tab running → "running"; total cost across all tabs; etc.).
 */
export const RunPanelHost = forwardRef<RunPanelHandle, RunPanelHostProps>(
  function RunPanelHost({ vaultRoot, projects }, ref) {
    const [chats, setChats] = useState<ChatTabRecord[]>(() => [
      { id: nextChatId() },
    ]);
    const [activeChatId, setActiveChatId] = useState<string>(
      () => chats[0]!.id,
    );

    // Per-tab status snapshots, keyed by chatId. Drives the tab-bar
    // chip labels (title + state indicator) and the host's
    // `subscribeToStatus` aggregation. Map cloning on every update is
    // cheap at this cardinality (≤3) and avoids the subtle bugs of
    // mutating + re-using the same Map reference.
    const [tabStatus, setTabStatus] = useState<Map<string, ChatTabStatusInfo>>(
      () => new Map(),
    );

    // Per-tab imperative handles. Populated by each RunPanel via its
    // forwarded ref; the host reads from here to dispatch
    // `stagePrompt` / `toggleCollapsed` to the active tab.
    const handlesRef = useRef<Map<string, RunPanelHandle | null>>(new Map());

    // Ambient status subscribers (Dashboard registers one). The host
    // re-broadcasts an aggregated `RunStatusInfo` derived from every
    // tab's `ChatTabStatusInfo` (see effect below). Aggregation lets
    // the AI handle pulse whenever ANY tab is running, not just when
    // the user happens to have a running tab in the foreground.
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

    // Hydrate one tab per backend run that was already alive when the
    // host mounted. Skipped when chats > 1 — implies a HMR cycle and
    // the previous mount has already done the work. Best-effort: a
    // failed getRuns just leaves the default empty tab.
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
          // Replace the default empty tab with one per live run, in
          // order. The first becomes active so the user lands on the
          // oldest conversation.
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

    // Re-aggregate and broadcast whenever any tab's status snapshot
    // changes. The aggregate represents the *vault-wide* view consumed
    // by the TitleBar AI handle (does any chat need attention?) and
    // the StatusBar (how many chats running, total spend).
    //
    // Rules:
    // - `state = "running"` if any tab is running / stopping; else
    //   `"exited"` if any tab is in `exited` (last finish wins); else
    //   `"idle"`. The AI handle pulses on `running`.
    // - `runningSkill` / `runningProject`: from any running tab — first
    //   match wins. Multi-running gives an arbitrary representative;
    //   the StatusBar already shows running count, the skill label is
    //   just a hint.
    // - `lastUsage`: sum of tokens + cost across all reporting tabs.
    //   Surfaces the user's total spend, not just one conversation's.
    // - `savedCount`: max of reported counts (each tab reports the
    //   same vault-wide list; max handles tabs that haven't fetched
    //   yet by ignoring their `null`).
    useEffect(() => {
      let state: RunStatusInfo["state"] = "idle";
      let runningCount = 0;
      let runningSkill: string | null = null;
      let runningProject: string | null = null;
      let sumIn = 0;
      let sumOut = 0;
      let sumCost = 0;
      let anyUsage = false;
      let maxSaved: number | null = null;
      for (const info of tabStatus.values()) {
        if (info.state === "running" || info.state === "stopping") {
          state = "running";
          runningCount += 1;
          if (runningSkill === null) runningSkill = info.runningSkill;
          if (runningProject === null) runningProject = info.runningProject;
        } else if (info.state === "exited" && state !== "running") {
          state = "exited";
        }
        if (info.inputTokens || info.outputTokens || info.costUsd) {
          sumIn += info.inputTokens;
          sumOut += info.outputTokens;
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
          ? { in: sumIn, out: sumOut, cost: sumCost }
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

    // ---------- Tab actions ----------

    const addChat = useCallback(() => {
      const id = nextChatId();
      // initialCollapsed: false — the user explicitly clicked "+", so
      // they want to see the new tab right away. Otherwise the new
      // panel would mount in its default-collapsed state, "closing"
      // the drawer to a compact header the moment they create the
      // new chat.
      setChats((prev) => [...prev, { id, initialCollapsed: false }]);
      setActiveChatId(id);
    }, []);

    const closeChat = useCallback(
      (id: string) => {
        setChats((prev) => {
          const idx = prev.findIndex((c) => c.id === id);
          if (idx < 0) return prev;
          const next = prev.filter((c) => c.id !== id);
          // Always keep at least one tab — closing the last creates a
          // fresh empty replacement so the user always has somewhere
          // to type.
          if (next.length === 0) {
            const fresh: ChatTabRecord = { id: nextChatId() };
            setActiveChatId(fresh.id);
            return [fresh];
          }
          // If we closed the active tab, pick a neighbour (next-right
          // by default; falls back to the new last if we closed the
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
      },
      [],
    );

    // ---------- Imperative handle (matches old RunPanelHandle) ----------

    const reopenSession = useCallback((session: SessionFull) => {
      // Open the saved session in a fresh tab so the user doesn't lose
      // whatever was in the previously-active tab. Pre-Срез-4 this
      // overwrote the single panel; the new behaviour better matches
      // user expectation when they explicitly click "Open in chat" on
      // a History row.
      const id = nextChatId();
      setChats((prev) => [...prev, { id, initialState: { kind: "reopen", session } }]);
      setActiveChatId(id);
    }, []);

    const toggleCollapsed = useCallback(() => {
      // Delegated to the active panel. With per-panel collapsed state
      // this can drift across tabs; acceptable as v1 (Срез 5 polish).
      const handle = handlesRef.current.get(activeChatId);
      handle?.toggleCollapsed();
    }, [activeChatId]);

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
        const handle = handlesRef.current.get(activeChatId);
        // Best case: active tab is idle / exited — stage in place so
        // the user keeps the visual context.
        if (handle) {
          const err = handle.stagePrompt(args);
          if (!err) return null;
          // Active tab is running. Fall through to opening a new tab
          // rather than blocking the user with the inline error — the
          // user just clicked "Open in chat" expecting a usable
          // surface, not an error.
        }
        // Stage in a new tab. The new RunPanel mounts on the next
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
      () => ({ reopenSession, toggleCollapsed, subscribeToStatus, stagePrompt }),
      [reopenSession, toggleCollapsed, subscribeToStatus, stagePrompt],
    );

    // ---------- Tab-bar UI ----------

    // The tab bar is always rendered so the "+" button is reachable
    // even with a single chat — otherwise the user has no UI
    // affordance to spawn a parallel chat, only via History.reopen or
    // Open-in-chat side effects. With one chat we still show its chip
    // (without the close button — there's always at least one open).
    const orderedTabs = useMemo(() => chats, [chats]);

    const onTabStatusChange = useCallback((info: ChatTabStatusInfo) => {
      setTabStatus((m) => {
        const prev = m.get(info.chatId);
        // Structural skip — covers every field aggregated into the
        // vault-wide RunStatusInfo (state/title/pending/skill/project
        // drive the tab bar; tokens/cost/savedCount feed StatusBar +
        // AI handle). Skipping when nothing changed avoids a fan-out
        // re-render for each token-delta update on hot streams.
        if (
          prev &&
          prev.state === info.state &&
          prev.title === info.title &&
          prev.hasPendingPermission === info.hasPendingPermission &&
          prev.runningSkill === info.runningSkill &&
          prev.runningProject === info.runningProject &&
          prev.inputTokens === info.inputTokens &&
          prev.outputTokens === info.outputTokens &&
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

    return (
      <>
        <div className="run-panel-host__tabs" role="tablist">
            {orderedTabs.map((c) => {
              const info = tabStatus.get(c.id);
              const isActive = c.id === activeChatId;
              const isRunning =
                info?.state === "running" || info?.state === "stopping";
              const label = info?.title ?? "New chat";
              return (
                <div
                  key={c.id}
                  className={
                    "run-panel-host__tab" +
                    (isActive ? " run-panel-host__tab--active" : "") +
                    (isRunning ? " run-panel-host__tab--running" : "") +
                    (info?.hasPendingPermission
                      ? " run-panel-host__tab--pending"
                      : "")
                  }
                  role="tab"
                  aria-selected={isActive}
                >
                  <button
                    type="button"
                    className="run-panel-host__tab-button"
                    onClick={() => setActiveChatId(c.id)}
                    title={label}
                  >
                    <span
                      className={
                        "run-panel-host__tab-dot run-panel-host__tab-dot--" +
                        (info?.state ?? "idle")
                      }
                      aria-hidden="true"
                    />
                    <span className="run-panel-host__tab-label">{label}</span>
                    {info?.hasPendingPermission && (
                      <span
                        className="run-panel-host__tab-badge"
                        title="Pending permission"
                      >
                        !
                      </span>
                    )}
                  </button>
                  {chats.length > 1 && (
                    <button
                      type="button"
                      className="run-panel-host__tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeChat(c.id);
                      }}
                      aria-label="Close chat"
                      title="Close chat"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              className="run-panel-host__tab-add"
              onClick={addChat}
              aria-label="New chat"
              title="New chat"
            >
              +
            </button>
          </div>
        {chats.map((c) => (
          <RunPanel
            key={c.id}
            ref={(handle) => {
              if (handle) handlesRef.current.set(c.id, handle);
              else handlesRef.current.delete(c.id);
            }}
            vaultRoot={vaultRoot}
            projects={projects}
            chatId={c.id}
            initialState={c.initialState}
            initialCollapsed={c.initialCollapsed}
            visible={c.id === activeChatId}
            onStatusChange={onTabStatusChange}
          />
        ))}
      </>
    );
  },
);
