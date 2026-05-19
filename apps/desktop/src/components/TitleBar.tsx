interface TitleBarProps {
  /** Slugs currently mounted as project tabs. */
  openProjects: string[];
  /** Slug of the active project, or `null`. */
  activeProject: string | null;
  /** Switch to an already-open project tab. */
  onSwitchProject: (slug: string) => void;
  /** Close a project tab. */
  onCloseProject: (slug: string) => void;
  /** Add a new project tab (opens the Projects view as a picker). */
  onAddProject: () => void;
}

/**
 * Top app-shell strip. **Project tabs only** — meta cluster, palette,
 * AI handle, recs bell, refresh and close all live in the
 * `dashboard__header` below (the user explicitly asked for the chrome
 * to stay together in one row, not split across two).
 *
 * The component owns no state — every behavior routes through typed
 * callbacks. Tauri's `decorations: true` paints the real
 * close/minimize/zoom controls in the OS title bar above, so we
 * deliberately do NOT draw fake macOS dots here.
 */
export function TitleBar({
  openProjects,
  activeProject,
  onSwitchProject,
  onCloseProject,
  onAddProject,
}: TitleBarProps) {
  return (
    <header className="titlebar" role="region" aria-label="Open projects">
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
          title="Open another project"
          onClick={onAddProject}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </header>
  );
}
