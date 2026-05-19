interface TitleBarMeta {
  format: string;
  mdCount: number;
  projectCount: number;
  artifactCount: number;
}

interface TitleBarProps {
  /** Slugs currently mounted as project tabs. PR A: derived from
   *  `activeProject` only — full multi-project state arrives in PR C. */
  openProjects: string[];
  /** Slug of the project the user is currently working in, or `null`. */
  activeProject: string | null;
  /** Cumulative chat session count across the vault. */
  totalChats: number;
  /** How many chats are currently running. Drives the pulse on the AI
   *  handle and the "N live" pill. */
  runningChats: number;
  /** Switch to an already-open project tab. PR A: no-op stub; PR C
   *  swaps `activeProject` + reopens its `_index.md`. */
  onSwitchProject: (slug: string) => void;
  /** Close a project tab. PR A: no-op stub. */
  onCloseProject: (slug: string) => void;
  /** Add a new project tab (opens a project picker). PR A: no-op stub. */
  onAddProject: () => void;
  /** Toggle the bottom RunPanel collapsed/expanded. PR A: no-op stub —
   *  the existing RunPanel still owns its own collapse state from
   *  Slice 2. PR B will lift this. */
  onToggleChat: () => void;
  /** Open the command palette (⌘K). PR A: no-op placeholder; the
   *  palette itself doesn't exist yet. */
  onOpenPalette: () => void;
  /** Vault path to display in the meta cluster (already home-masked
   *  by the caller). */
  vaultPath: string;
  /** Small read-only meta cluster — format / file / project / artifact
   *  counts. The Dashboard still renders the full `dashboard__header`
   *  pill row beneath this bar in PR A; PR B may reconcile the two. */
  meta: TitleBarMeta;
}

/**
 * v0.5 app-shell titlebar — restores the architectural pattern from
 * the original B prototype: project tabs sit at the top, alongside
 * vault meta and the AI handle. PR A scope: only the active project
 * tab renders + a no-op `+` button; full multi-project state lands in
 * PR C. The component owns no state — every behavior bubbles through
 * the typed callback props so future PRs can plug in real handlers
 * without changing the contract.
 *
 * macOS dots are **decorative only** — Tauri's window decorations
 * provide the real close/minimize/zoom controls; the dots here just
 * preserve the design's visual rhythm.
 */
export function TitleBar({
  openProjects,
  activeProject,
  totalChats,
  runningChats,
  onSwitchProject,
  onCloseProject,
  onAddProject,
  onToggleChat,
  onOpenPalette,
  vaultPath,
  meta,
}: TitleBarProps) {
  return (
    <header className="titlebar" role="region" aria-label="App title bar">
      <div className="titlebar__dots" aria-hidden="true">
        <span className="titlebar__dot titlebar__dot--close" />
        <span className="titlebar__dot titlebar__dot--min" />
        <span className="titlebar__dot titlebar__dot--zoom" />
      </div>

      <div className="titlebar__tabs" role="tablist" aria-label="Open projects">
        {openProjects.map((slug) => {
          const active = slug === activeProject;
          return (
            <button
              key={slug}
              type="button"
              role="tab"
              aria-selected={active}
              className={
                "titlebar__tab" + (active ? " titlebar__tab--active" : "")
              }
              onClick={() => onSwitchProject(slug)}
            >
              <span className="titlebar__tab-slug">{slug}</span>
              {active && (
                <span
                  className="titlebar__tab-close"
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${slug}`}
                  title={`Close ${slug}`}
                  onClick={(e) => {
                    // PR A: stub — onCloseProject is a no-op. The
                    // event still needs stopping so the parent tab
                    // button doesn't swallow the click as "switch".
                    e.stopPropagation();
                    onCloseProject(slug);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="titlebar__tab titlebar__tab--plus"
          aria-label="Open another project"
          title="Open another project (coming in PR C)"
          onClick={onAddProject}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>

      <div className="titlebar__spacer" />

      <div className="titlebar__meta" aria-label="Vault metadata">
        <span className="titlebar__meta-path" title={vaultPath}>
          {vaultPath}
        </span>
        <span className="titlebar__meta-sep" aria-hidden="true">
          ·
        </span>
        <span className="titlebar__meta-text">fmt {meta.format}</span>
        <span className="titlebar__meta-sep" aria-hidden="true">
          ·
        </span>
        <span className="titlebar__meta-text">
          {meta.mdCount}md / {meta.projectCount}proj / {meta.artifactCount}art
        </span>
      </div>

      <button
        type="button"
        className="titlebar__palette"
        aria-label="Open command palette"
        title="Command palette (coming soon)"
        onClick={onOpenPalette}
      >
        <span className="titlebar__kbd">⌘K</span>
        <span>palette</span>
      </button>

      <button
        type="button"
        className="titlebar__ai"
        aria-label="Toggle chat panel"
        title="Toggle chat panel"
        onClick={onToggleChat}
      >
        <span
          className={
            "titlebar__ai-dot" +
            (runningChats > 0 ? " titlebar__ai-dot--running" : "")
          }
          aria-hidden="true"
        />
        <span>AI</span>
        <span className="titlebar__ai-count">{totalChats}</span>
        {runningChats > 0 && (
          <span className="titlebar__ai-live">{runningChats} live</span>
        )}
        <span className="titlebar__kbd">⌘J</span>
      </button>
    </header>
  );
}
