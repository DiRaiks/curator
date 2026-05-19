import { useCallback, useEffect, useState } from "react";

import {
  archiveSession,
  deleteSession,
  getSession,
  listSessions,
} from "../api";
import type { SessionFull, SessionSummary } from "../types";

type Filter = "active" | "archived" | "all";

interface HistoryPanelProps {
  vaultRoot: string;
  /** Hand a fully-loaded session to the chat panel so the user can
   *  continue the conversation. Wired through `RunPanelHandle`. */
  onReopen: (session: SessionFull) => void;
}

/**
 * Full-page browser of saved chat sessions. Filters by active /
 * archived / all and offers Reopen / Archive / Delete per row.
 *
 * State is local to this panel — the dropdown in `RunPanel` has its own
 * cached list. Both call the same `list_sessions` Tauri command so
 * they're always in sync after a refresh.
 */
export function HistoryPanel({ vaultRoot, onReopen }: HistoryPanelProps) {
  const [filter, setFilter] = useState<Filter>("active");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mutation in flight (reopen / archive / delete) — disables row
  // controls so a slow IPC call doesn't let the user double-act.
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await listSessions(vaultRoot, filter !== "active");
      const filtered =
        filter === "archived" ? list.filter((s) => s.archived) : list;
      setSessions(filtered);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSessions([]);
    }
  }, [vaultRoot, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleReopen = useCallback(
    async (s: SessionSummary) => {
      setBusyId(s.id);
      try {
        const full = await getSession(s.id);
        onReopen(full);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [onReopen],
  );

  const handleArchive = useCallback(
    async (s: SessionSummary) => {
      setBusyId(s.id);
      try {
        await archiveSession(s.id, !s.archived);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (s: SessionSummary) => {
      const ok = window.confirm(
        `Delete this chat from history?\n\n"${s.title}"\n\nThis cannot be undone.`,
      );
      if (!ok) return;
      setBusyId(s.id);
      try {
        await deleteSession(s.id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return (
    <div className="history-panel">
      <header className="history-panel__header">
        <div>
          <h2 className="panel__title">History</h2>
          <p className="history-panel__hint">
            Saved chat sessions for this vault. Reopen to continue the
            conversation, archive to keep past the rolling limit, or delete
            to remove permanently.
          </p>
        </div>
        <div className="history-panel__filter" role="tablist">
          {(["active", "archived", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={
                "history-panel__filter-btn" +
                (filter === f ? " history-panel__filter-btn--active" : "")
              }
              onClick={() => setFilter(f)}
            >
              {f === "active" ? "Active" : f === "archived" ? "Archived" : "All"}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p className="history-panel__error" role="alert">
          {error}
        </p>
      )}

      {sessions === null ? (
        <p className="empty-state">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="empty-state">
          {filter === "archived"
            ? "No archived chats."
            : filter === "all"
              ? "No saved chats yet — start a chat in the bottom panel."
              : "No active chats. Start one in the bottom panel."}
        </p>
      ) : (
        <ul className="history-list">
          {sessions.map((s) => (
            <HistoryRow
              key={s.id}
              session={s}
              busy={busyId === s.id}
              onReopen={() => void handleReopen(s)}
              onArchive={() => void handleArchive(s)}
              onDelete={() => void handleDelete(s)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface HistoryRowProps {
  session: SessionSummary;
  busy: boolean;
  onReopen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function HistoryRow({
  session,
  busy,
  onReopen,
  onArchive,
  onDelete,
}: HistoryRowProps) {
  const startedDate = new Date(session.startedAtMs);
  const duration =
    session.endedAtMs !== null
      ? formatDuration(session.endedAtMs - session.startedAtMs)
      : "—";
  const exitClass = session.exitSuccess
    ? "history-row__exit history-row__exit--ok"
    : session.exitSuccess === false
      ? "history-row__exit history-row__exit--fail"
      : "history-row__exit history-row__exit--unknown";
  const exitLabel =
    session.exitSuccess === true
      ? "ok"
      : session.exitSuccess === false
        ? "failed"
        : "unfinished";

  return (
    <li
      className={
        "history-row" +
        (session.archived ? " history-row--archived" : "")
      }
    >
      <div className="history-row__main">
        <div className="history-row__title-row">
          <span className="history-row__title">{session.title}</span>
          <span className={exitClass}>{exitLabel}</span>
          {session.archived && (
            <span className="history-row__badge">archived</span>
          )}
        </div>
        <div className="history-row__meta">
          <span>{session.freeform ? "chat" : session.projectSlug}</span>
          <span aria-hidden="true">·</span>
          <span title={startedDate.toString()}>
            {startedDate.toLocaleString()}
          </span>
          <span aria-hidden="true">·</span>
          <span>{duration}</span>
          <span aria-hidden="true">·</span>
          <span>{session.lineCount} lines</span>
          {(session.inputTokens > 0 || session.outputTokens > 0) && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {formatTokens(session.inputTokens)} in /{" "}
                {formatTokens(session.outputTokens)} out
              </span>
            </>
          )}
          {session.costUsd > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>${session.costUsd.toFixed(3)}</span>
            </>
          )}
        </div>
      </div>
      <div className="history-row__actions">
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={onReopen}
          disabled={busy}
        >
          Reopen
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={onArchive}
          disabled={busy}
          title={session.archived ? "Move back to active list" : "Archive — exempt from rolling-limit auto-delete"}
        >
          {session.archived ? "Unarchive" : "Archive"}
        </button>
        <button
          type="button"
          className="btn btn--small btn--danger"
          onClick={onDelete}
          disabled={busy}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}
