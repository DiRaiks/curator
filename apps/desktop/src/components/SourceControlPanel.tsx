import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  gitCommit,
  gitDiff,
  gitLog,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
} from "../api";
import type { CommitInfo, GitFileStatus, GitStatus } from "../types";

type Tab = "changes" | "history";

/** Which file's diff is open, and against which side. A path can appear in
 *  both groups (staged edit + further unstaged edit), so the staged flag is
 *  part of the selection identity, not just the path. */
interface DiffSelection {
  path: string;
  staged: boolean;
}

interface SourceControlPanelProps {
  vaultRoot: string;
  /** Bumped by the Dashboard whenever the vault is re-scanned (file watcher,
   *  manual refresh). The panel refetches git status on every change so the
   *  list tracks edits made elsewhere in the app. */
  refreshTick: number;
  /** Open a vault-relative path in the editor so the user can fix the change
   *  they're looking at. Wired to the Dashboard's `attemptOpenFile` (which
   *  guards unsaved edits and switches to the editor view). Only offered for
   *  editable `.md` files — the editor can't open other types. */
  onOpenFile: (path: string) => void;
}

/**
 * Source Control for the **vault itself** — review changed Markdown, stage,
 * and commit without leaving Curator. Mirrors the mental model of VS Code's
 * SCM view: a Staged group and a Changes group, a diff pane for the selected
 * file, a commit box, and a History tab listing recent commits.
 *
 * Deliberately scoped to the vault root (not project repos). Commit signing
 * is whatever the user's git config does — we never force or suppress it.
 * The IDE never auto-commits: every commit here is an explicit button press.
 */
export function SourceControlPanel({
  vaultRoot,
  refreshTick,
  onOpenFile,
}: SourceControlPanelProps) {
  const [tab, setTab] = useState<Tab>("changes");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);

  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitNotice, setCommitNotice] = useState<string | null>(null);

  const [log, setLog] = useState<CommitInfo[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  // Generation tokens guard against last-response-wins races: each async
  // fetch captures the current value, and only the latest in-flight call is
  // allowed to commit its result. A stale response (slower IPC, a vault
  // switch mid-flight) bumps the token and is dropped.
  const statusGenRef = useRef(0);
  const diffGenRef = useRef(0);
  const logGenRef = useRef(0);
  // Mirror of `selection` readable synchronously inside async callbacks so
  // `runMutation` reconciles against the *current* selection without needing
  // `selection` in its dependency list (which would re-memoize every handler
  // on each row click).
  const selectionRef = useRef<DiffSelection | null>(null);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const refreshStatus = useCallback(async () => {
    const gen = ++statusGenRef.current;
    setError(null);
    try {
      const s = await gitStatus(vaultRoot);
      if (gen !== statusGenRef.current) return;
      setStatus(s);
    } catch (err) {
      if (gen !== statusGenRef.current) return;
      setError(toMessage(err));
      setStatus(null);
    }
  }, [vaultRoot]);

  // Refetch on mount, vault switch, and any external rescan.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, refreshTick]);

  const refreshLog = useCallback(async () => {
    const gen = ++logGenRef.current;
    setLogError(null);
    try {
      const entries = await gitLog(vaultRoot, 50);
      if (gen !== logGenRef.current) return;
      setLog(entries);
    } catch (err) {
      if (gen !== logGenRef.current) return;
      setLogError(toMessage(err));
      // Keep null (not []) so loading / empty / error stay distinct states.
      setLog(null);
    }
  }, [vaultRoot]);

  // Load history lazily the first time the tab is opened, and refresh it
  // after each commit (commitNotice changes) while it's the active tab.
  useEffect(() => {
    if (tab === "history") void refreshLog();
  }, [tab, refreshLog, commitNotice]);

  const staged = useMemo(
    () => (status?.files ?? []).filter((f) => f.staged),
    [status],
  );
  const unstaged = useMemo(
    () => (status?.files ?? []).filter((f) => f.unstaged),
    [status],
  );

  // The selected file is openable in the editor only when it's a Markdown
  // file that still exists on disk — the editor rejects other extensions,
  // and a deleted file has nothing to open.
  const selectedIsEditable = useMemo(() => {
    if (!selection) return false;
    const file = (status?.files ?? []).find((f) => f.path === selection.path);
    return file ? isEditable(file, selection.staged) : false;
  }, [selection, status]);

  const loadDiff = useCallback(
    async (sel: DiffSelection) => {
      const gen = ++diffGenRef.current;
      setSelection(sel);
      setDiffLoading(true);
      setDiffText("");
      try {
        const text = await gitDiff(vaultRoot, sel.path, sel.staged);
        if (gen !== diffGenRef.current) return; // superseded by a newer select
        setDiffText(text);
      } catch (err) {
        if (gen !== diffGenRef.current) return;
        setDiffText("");
        setError(toMessage(err));
      } finally {
        if (gen === diffGenRef.current) setDiffLoading(false);
      }
    },
    [vaultRoot],
  );

  // After a stage/unstage the selected file may move between groups; re-run
  // the diff against whichever side still has it so the pane doesn't go stale.
  const reconcileSelection = useCallback(
    (next: GitStatus, prev: DiffSelection | null) => {
      if (!prev) return;
      const file = next.files.find((f) => f.path === prev.path);
      if (!file) {
        setSelection(null);
        setDiffText("");
        return;
      }
      const staysStaged = prev.staged && file.staged;
      const nextStaged = staysStaged ? true : file.staged && !file.unstaged;
      void loadDiff({ path: prev.path, staged: nextStaged });
    },
    [loadDiff],
  );

  const runMutation = useCallback(
    async (op: () => Promise<void>) => {
      const gen = ++statusGenRef.current;
      setBusy(true);
      setError(null);
      setCommitNotice(null);
      try {
        await op();
        const next = await gitStatus(vaultRoot);
        if (gen !== statusGenRef.current) return; // a newer fetch superseded us
        setStatus(next);
        // Read the live selection (ref), not a stale closure capture.
        reconcileSelection(next, selectionRef.current);
      } catch (err) {
        if (gen !== statusGenRef.current) return;
        setError(toMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [vaultRoot, reconcileSelection],
  );

  const handleStage = useCallback(
    (file: GitFileStatus) => runMutation(() => gitStage(vaultRoot, [file.path])),
    [runMutation, vaultRoot],
  );
  const handleUnstage = useCallback(
    (file: GitFileStatus) =>
      runMutation(() => gitUnstage(vaultRoot, [file.path])),
    [runMutation, vaultRoot],
  );
  const handleStageAll = useCallback(
    () => runMutation(() => gitStageAll(vaultRoot)),
    [runMutation, vaultRoot],
  );
  const handleUnstageAll = useCallback(
    () => runMutation(() => gitUnstage(vaultRoot, staged.map((f) => f.path))),
    [runMutation, vaultRoot, staged],
  );

  const handleCommit = useCallback(async () => {
    setCommitting(true);
    setError(null);
    setCommitNotice(null);
    try {
      const outcome = await gitCommit(vaultRoot, message);
      setMessage("");
      setSelection(null);
      setDiffText("");
      setCommitNotice(`Committed ${outcome.shortHash}`);
      await refreshStatus();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setCommitting(false);
    }
  }, [vaultRoot, message, refreshStatus]);

  const canCommit =
    staged.length > 0 && message.trim().length > 0 && !committing && !busy;

  if (status && !status.isGitRepo) {
    return (
      <div className="scm-panel">
        <PanelHeader branch={null} onRefresh={() => void refreshStatus()} />
        <p className="empty-state">
          This vault folder is not a git repository. Run <code>git init</code>{" "}
          at the vault root to track and commit changes from here.
        </p>
      </div>
    );
  }

  return (
    <div className="scm-panel">
      <PanelHeader
        branch={status?.branch ?? null}
        onRefresh={() => void refreshStatus()}
        busy={busy}
      />

      <div className="scm-panel__tabs" role="tablist">
        {(["changes", "history"] as const).map((t) => (
          <button
            key={t}
            id={`scm-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`scm-panel-${t}`}
            className={
              "scm-panel__tab" + (tab === t ? " scm-panel__tab--active" : "")
            }
            onClick={() => setTab(t)}
          >
            {t === "changes"
              ? `Changes${unstaged.length + staged.length > 0 ? ` (${unstaged.length + staged.length})` : ""}`
              : "History"}
          </button>
        ))}
      </div>

      {error && (
        <p className="scm-panel__error" role="alert">
          {error}
        </p>
      )}

      {tab === "changes" ? (
        <div
          className="scm-changes"
          role="tabpanel"
          id="scm-panel-changes"
          aria-labelledby="scm-tab-changes"
        >
          <div className="scm-changes__lists">
            <CommitBox
              stagedCount={staged.length}
              message={message}
              onMessageChange={setMessage}
              onCommit={() => void handleCommit()}
              canCommit={canCommit}
              committing={committing}
              notice={commitNotice}
            />

            <FileGroup
              title="Staged"
              files={staged}
              emptyHint="Nothing staged."
              actionLabel="−"
              actionTitle="Unstage"
              onAction={handleUnstage}
              groupAction={
                staged.length > 0
                  ? { label: "Unstage all", onClick: handleUnstageAll }
                  : undefined
              }
              busy={busy}
              selection={selection}
              selectedStaged
              onSelect={(f) => void loadDiff({ path: f.path, staged: true })}
              onOpen={(f) => onOpenFile(f.path)}
            />

            <FileGroup
              title="Changes"
              files={unstaged}
              emptyHint="No unstaged changes."
              actionLabel="+"
              actionTitle="Stage"
              onAction={handleStage}
              groupAction={
                unstaged.length > 0
                  ? { label: "Stage all", onClick: handleStageAll }
                  : undefined
              }
              busy={busy}
              selection={selection}
              selectedStaged={false}
              onSelect={(f) => void loadDiff({ path: f.path, staged: false })}
              onOpen={(f) => onOpenFile(f.path)}
            />
          </div>

          <DiffPane
            selection={selection}
            diffText={diffText}
            loading={diffLoading}
            onOpen={
              // `selection` is a const this render; the `&&` narrows it to
              // non-null inside the closure, so no non-null assertion needed.
              selection && selectedIsEditable
                ? () => onOpenFile(selection.path)
                : undefined
            }
          />
        </div>
      ) : (
        <div
          className="scm-history"
          role="tabpanel"
          id="scm-panel-history"
          aria-labelledby="scm-tab-history"
        >
          <HistoryList log={log} error={logError} />
        </div>
      )}
    </div>
  );
}

interface PanelHeaderProps {
  branch: string | null;
  onRefresh: () => void;
  busy?: boolean;
}

function PanelHeader({ branch, onRefresh, busy }: PanelHeaderProps) {
  return (
    <header className="scm-panel__header">
      <div>
        <h2 className="panel__title">Source Control</h2>
        <p className="scm-panel__hint">
          Review and commit changes to the vault.{" "}
          {branch && (
            <>
              On <span className="scm-panel__branch">{branch}</span>.
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        className="btn btn--small"
        onClick={onRefresh}
        disabled={busy}
      >
        Refresh
      </button>
    </header>
  );
}

interface CommitBoxProps {
  stagedCount: number;
  message: string;
  onMessageChange: (v: string) => void;
  onCommit: () => void;
  canCommit: boolean;
  committing: boolean;
  notice: string | null;
}

function CommitBox({
  stagedCount,
  message,
  onMessageChange,
  onCommit,
  canCommit,
  committing,
  notice,
}: CommitBoxProps) {
  return (
    <div className="scm-commit">
      <textarea
        className="scm-commit__input"
        placeholder="Commit message"
        value={message}
        rows={2}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter commits, matching the editor's save chord feel.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
            e.preventDefault();
            onCommit();
          }
        }}
      />
      <div className="scm-commit__actions">
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={onCommit}
          disabled={!canCommit}
          title={
            stagedCount === 0
              ? "Stage at least one file first"
              : "Commit staged changes (⌘↵)"
          }
        >
          {committing
            ? "Committing…"
            : `Commit ${stagedCount > 0 ? stagedCount : ""}`.trim()}
        </button>
        {notice && <span className="scm-commit__notice">{notice}</span>}
      </div>
    </div>
  );
}

interface FileGroupProps {
  title: string;
  files: GitFileStatus[];
  emptyHint: string;
  /** Glyph for the per-row primary action (stage "+" / unstage "−"). */
  actionLabel: string;
  actionTitle: string;
  onAction: (f: GitFileStatus) => void;
  groupAction?: { label: string; onClick: () => void };
  busy: boolean;
  selection: DiffSelection | null;
  /** Whether this group renders the staged side (so selection highlight
   *  matches the diff side currently open). */
  selectedStaged: boolean;
  onSelect: (f: GitFileStatus) => void;
  /** Open an editable file directly (double-click). Undefined disables it. */
  onOpen?: (f: GitFileStatus) => void;
}

function FileGroup({
  title,
  files,
  emptyHint,
  actionLabel,
  actionTitle,
  onAction,
  groupAction,
  busy,
  selection,
  selectedStaged,
  onSelect,
  onOpen,
}: FileGroupProps) {
  return (
    <section className="scm-group">
      <div className="scm-group__header">
        <span className="scm-group__title">
          {title}
          <span className="scm-group__count">{files.length}</span>
        </span>
        {groupAction && (
          <button
            type="button"
            className="scm-group__action"
            onClick={groupAction.onClick}
            disabled={busy}
          >
            {groupAction.label}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="scm-group__empty">{emptyHint}</p>
      ) : (
        <ul className="scm-file-list">
          {files.map((f) => {
            const selected =
              selection?.path === f.path &&
              selection.staged === selectedStaged;
            return (
              <li
                key={f.path}
                className={
                  "scm-file" + (selected ? " scm-file--selected" : "")
                }
              >
                <button
                  type="button"
                  className="scm-file__main"
                  onClick={() => onSelect(f)}
                  onDoubleClick={() => {
                    if (onOpen && isEditable(f, selectedStaged)) onOpen(f);
                  }}
                  title={
                    onOpen && isEditable(f, selectedStaged)
                      ? `${f.path} — double-click to open`
                      : f.path
                  }
                >
                  <span
                    className={
                      "scm-file__badge scm-file__badge--" +
                      statusKind(f, selectedStaged)
                    }
                    aria-hidden="true"
                  >
                    {statusGlyph(f, selectedStaged)}
                  </span>
                  <span className="scm-file__name">{basename(f.path)}</span>
                  <span className="scm-file__dir">{dirname(f.path)}</span>
                </button>
                <button
                  type="button"
                  className="scm-file__act"
                  onClick={() => onAction(f)}
                  disabled={busy}
                  title={actionTitle}
                  aria-label={`${actionTitle} ${f.path}`}
                >
                  {actionLabel}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface DiffPaneProps {
  selection: DiffSelection | null;
  diffText: string;
  loading: boolean;
  /** Open the selected file in the editor. Undefined when the file can't be
   *  edited in-app (non-Markdown or deleted) — the button is then hidden. */
  onOpen?: () => void;
}

function DiffPane({ selection, diffText, loading, onOpen }: DiffPaneProps) {
  if (!selection) {
    return (
      <div className="scm-diff scm-diff--empty">
        <p className="empty-state">Select a file to view its diff.</p>
      </div>
    );
  }
  return (
    <div className="scm-diff">
      <div className="scm-diff__head">
        <span className="scm-diff__path">{selection.path}</span>
        <div className="scm-diff__head-right">
          <span className="scm-diff__side">
            {selection.staged ? "staged" : "working tree"}
          </span>
          {onOpen && (
            <button
              type="button"
              className="btn btn--small"
              onClick={onOpen}
              title="Open this file in the editor to edit it"
            >
              Open file ↗
            </button>
          )}
        </div>
      </div>
      {loading ? (
        <p className="empty-state">Loading diff…</p>
      ) : diffText.trim().length === 0 ? (
        <p className="empty-state">No textual diff (binary or empty change).</p>
      ) : (
        // Key the <pre> by the selection identity so React remounts the
        // whole block on a diff switch instead of recycling line <span>s by
        // index (which can leave stale classes when line counts differ).
        <pre
          key={`${selection.path} ${selection.staged}`}
          className="scm-diff__body"
        >
          {diffText.split("\n").map((line, i) => (
            <span
              key={i}
              className={"scm-diff__line scm-diff__line--" + diffLineKind(line)}
            >
              {line || " "}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

interface HistoryListProps {
  log: CommitInfo[] | null;
  error: string | null;
}

function HistoryList({ log, error }: HistoryListProps) {
  if (error) {
    return (
      <p className="scm-panel__error" role="alert">
        {error}
      </p>
    );
  }
  if (log === null) {
    return <p className="empty-state">Loading…</p>;
  }
  if (log.length === 0) {
    return <p className="empty-state">No commits yet.</p>;
  }
  return (
    <ul className="scm-log">
      {log.map((c) => (
        <li key={c.shortHash} className="scm-log__row">
          <code className="scm-log__hash">{c.shortHash}</code>
          <span className="scm-log__subject" title={c.subject}>
            {c.subject}
          </span>
          <span className="scm-log__meta">
            {c.author}
            <span aria-hidden="true"> · </span>
            <span title={new Date(c.unixSecs * 1000).toString()}>
              {c.relativeDate}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------- helpers ----------

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A file the in-app editor can open: a Markdown file that still exists
 *  (a deletion has nothing to edit). `forStagedSide` picks which column's
 *  status to judge, since a file can be e.g. staged-modified but
 *  worktree-deleted. */
function isEditable(f: GitFileStatus, forStagedSide: boolean): boolean {
  return (
    f.path.toLowerCase().endsWith(".md") &&
    statusKind(f, forStagedSide) !== "del"
  );
}

/** The relevant status code for the side being rendered. A file present in
 *  both the Staged and Changes groups has meaningful `index` AND `worktree`
 *  columns; each group must read its own. */
function sideCode(f: GitFileStatus, forStagedSide: boolean): string {
  return forStagedSide ? f.index : f.worktree;
}

/** Coarse classification for the status badge color. */
function statusKind(
  f: GitFileStatus,
  forStagedSide: boolean,
): "add" | "del" | "mod" | "ren" {
  if (f.untracked) return "add";
  const code = sideCode(f, forStagedSide).trim();
  if (code === "A") return "add";
  if (code === "D") return "del";
  if (code === "R" || code === "C") return "ren";
  return "mod";
}

/** Single-letter git-style status glyph. Takes only the first char so a
 *  two-letter porcelain code (e.g. "MM") can't render as a double glyph. */
function statusGlyph(f: GitFileStatus, forStagedSide: boolean): string {
  if (f.untracked) return "U";
  return sideCode(f, forStagedSide).trim().charAt(0) || "M";
}

function diffLineKind(line: string): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
