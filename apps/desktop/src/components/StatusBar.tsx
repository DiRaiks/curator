interface StatusBarProps {
  /** Slug of the project currently in focus, or `null` if the user is
   *  on a project-less view (vault-wide history, drafts, etc.). */
  activeProject: string | null;
  /** Git branch of the active project's source repo, or `null` when
   *  unknown / not a git repo. The Dashboard doesn't fetch this in
   *  PR B (the existing `inspect_source_repo` call sits inside
   *  ProjectDetail) — pass `null` for now. */
  branch: string | null;
  /** Count of open editor buffers with unsaved changes across the
   *  multi-buffer state. Surfaces in the left cluster in warn tone
   *  when > 0. */
  dirtyCount: number;
  /** Total saved chat sessions for this vault, including archived. */
  totalChats: number;
  /** Chats currently running. Drives the run-status chip on the left
   *  end of the bar. */
  runningChats: number;
  /** Name of the skill/artifact the running chat is executing, or
   *  `null` for a freeform run. Only used when `runningChats > 0`. */
  runningSkill: string | null;
  /** File-type indicator string for the active editor buffer
   *  ("md gfm", "yaml", …) or `null` when no file is open. */
  fileMode: string | null;
  /** Cursor position in the active editor buffer, or `null` when not
   *  available. EditorPanel doesn't expose cursor events yet —
   *  Dashboard passes `null` in PR B; PR C may plumb a CodeMirror
   *  listener through. */
  cursor: { line: number; col: number } | null;
}

/**
 * Bottom-of-window status bar restored from the original B prototype.
 * Pure presentation — every signal comes through props so the
 * component stays trivially testable.
 *
 * Layout (per `design/v05-shell.jsx` `V5StatusBar`):
 *
 *   [run status?] · [project] · [branch?] · [dirty?]     [NORMAL · UTF-8 · mode? · cursor?]
 *
 * Pieces without data (branch / cursor / running skill) collapse out
 * silently rather than rendering "—" placeholders — a partially-known
 * status reads cleaner than one full of em-dashes.
 *
 * The 1px vertical dividers between groups are rendered as separate
 * `<span>` elements (`StatusSep`) instead of CSS borders so flex
 * children can collapse around them when their neighbour is hidden.
 */
export function StatusBar({
  activeProject,
  branch,
  dirtyCount,
  totalChats,
  runningChats,
  runningSkill,
  fileMode,
  cursor,
}: StatusBarProps) {
  const running = runningChats > 0;
  return (
    <div className="status-bar" role="contentinfo" aria-label="Status">
      {running && (
        <>
          <span
            className="status-bar__run"
            title={runningSkill ?? "Chat running"}
          >
            <span className="status-bar__run-dot" aria-hidden="true" />
            {runningSkill ?? "running"}
          </span>
          <StatusSep />
        </>
      )}
      {activeProject && (
        <>
          <span className="status-bar__project">{activeProject}</span>
          <StatusSep />
        </>
      )}
      {branch && (
        <>
          <span className="status-bar__branch">{branch}</span>
          <StatusSep />
        </>
      )}
      {dirtyCount > 0 && (
        <>
          <span className="status-bar__dirty">±{dirtyCount} modified</span>
          <StatusSep />
        </>
      )}
      <span className="status-bar__chats">
        {runningChats} chat{runningChats === 1 ? "" : "s"} running · {totalChats}{" "}
        total
      </span>

      <span className="status-bar__spacer" />

      {/* Editor-mode indicators on the right end. NORMAL is a static
       * Vim-mode style label — the editor isn't modal but it sets the
       * expected B-prototype rhythm. PR C may make this dynamic. */}
      <span>NORMAL</span>
      <StatusSep />
      <span>UTF-8</span>
      {fileMode && (
        <>
          <StatusSep />
          <span>{fileMode}</span>
        </>
      )}
      {cursor && (
        <>
          <StatusSep />
          <span>
            {cursor.line}:{cursor.col}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * 1px vertical divider used between status-bar groups. Rendered as
 * an element rather than a `border-right` on every span so groups
 * that hide themselves don't leave double dividers visible.
 */
function StatusSep() {
  return <span className="status-bar__sep" aria-hidden="true" />;
}
