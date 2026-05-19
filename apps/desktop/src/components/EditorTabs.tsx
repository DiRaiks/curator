export type EditorViewMode = "src" | "split" | "prev";

interface EditorTab {
  path: string;
  modified: boolean;
}

interface EditorTabsProps {
  /** One entry per open buffer. The same array order is the tab
   *  order; the user reads left-to-right. */
  tabs: EditorTab[];
  /** Index into `tabs` for the currently-active buffer. */
  activeIndex: number;
  viewMode: EditorViewMode;
  onSwitch: (index: number) => void;
  onClose: (index: number) => void;
  onSetViewMode: (mode: EditorViewMode) => void;
}

const VIEW_MODES: ReadonlyArray<{ id: EditorViewMode; label: string }> = [
  { id: "src", label: "src" },
  { id: "split", label: "split" },
  { id: "prev", label: "prev" },
] as const;

/** Modifier-key label used by the kbd hints. Same detection logic the
 *  slice-5 EditorPanel had — copied here so EditorTabs doesn't need to
 *  reach back into the editor. The actual ⌘1/2/3 listener lives in
 *  Dashboard (lifted in PR B), so this constant is display-only. */
const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent || "");
const MOD_LABEL = isMac ? "⌘" : "Ctrl+";

/**
 * Tab strip + view-mode toggle at the top of the editor pane.
 *
 * Tab visuals: `M` glyph in accent for clean buffers, `●` in warn for
 * dirty ones, basename in mono, `×` close affordance on each tab. The
 * active tab gets a 1px accent rail along its top edge so the user's
 * eye finds it without re-reading the label.
 *
 * The view-mode toggle on the right is a segmented control of three
 * buttons (`src` / `split` / `prev`) with kbd hints (`⌘1`/`⌘2`/`⌘3`
 * on macOS, `Ctrl+1` etc. elsewhere). Clicking a button calls
 * `onSetViewMode` — the actual keyboard shortcut handler lives in
 * Dashboard so the chord works regardless of focus.
 */
export function EditorTabs({
  tabs,
  activeIndex,
  viewMode,
  onSwitch,
  onClose,
  onSetViewMode,
}: EditorTabsProps) {
  return (
    <div className="editor-tabs" role="region" aria-label="Open editor buffers">
      <div className="editor-tabs__strip" role="tablist">
        {tabs.map((tab, i) => {
          const active = i === activeIndex;
          const basename = tab.path.split("/").pop() ?? tab.path;
          return (
            <button
              key={tab.path}
              type="button"
              role="tab"
              aria-selected={active}
              className={
                "editor-tabs__tab" +
                (active ? " editor-tabs__tab--active" : "")
              }
              title={tab.path}
              onClick={() => onSwitch(i)}
            >
              <span
                className={
                  "editor-tabs__glyph editor-tabs__glyph--" +
                  (tab.modified ? "dirty" : "clean")
                }
                aria-hidden="true"
              >
                {tab.modified ? "●" : "M"}
              </span>
              <span className="editor-tabs__name">{basename}</span>
              <span
                className="editor-tabs__close"
                role="button"
                tabIndex={-1}
                aria-label={`Close ${basename}`}
                title={`Close ${basename}`}
                onClick={(e) => {
                  // Don't let the parent tab button swallow the click
                  // as a "switch" — the user explicitly aimed at the
                  // small × glyph.
                  e.stopPropagation();
                  onClose(i);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      <div className="editor-tabs__spacer" />

      <div
        className="editor-tabs__view-mode"
        role="group"
        aria-label="Editor view mode"
      >
        {VIEW_MODES.map((m, i) => {
          const active = m.id === viewMode;
          return (
            <button
              key={m.id}
              type="button"
              className={
                "editor-tabs__mode-btn" +
                (active ? " editor-tabs__mode-btn--active" : "")
              }
              aria-pressed={active}
              title={`${m.label} (${MOD_LABEL}${i + 1})`}
              onClick={() => onSetViewMode(m.id)}
            >
              <span>{m.label}</span>
              <span className="editor-tabs__mode-kbd">
                {MOD_LABEL}
                {i + 1}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
