import { ShellIcon } from "./shell/ShellIcon";

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
  onSwitch: (index: number) => void;
  onClose: (index: number) => void;
}

/**
 * 36px tab strip at the top of the editor (shell v2): md file icon in
 * info-blue, basename, and either a close × (clean buffer) or a dirty
 * dot (unsaved changes) — the dot replaces the close affordance so a
 * dirty tab can't be closed by a stray click without going through
 * the confirm flow. Active tab: `--bg` surface + 2px accent top rail.
 *
 * The view-mode segmented control lives in the editor's path row now
 * (see EditorPanel); the ⌘1/2/3 handler stays in Dashboard.
 */
export function EditorTabs({
  tabs,
  activeIndex,
  onSwitch,
  onClose,
}: EditorTabsProps) {
  return (
    <div className="ide-tabs" role="tablist" aria-label="Open editor buffers">
      {tabs.map((tab, i) => {
        const active = i === activeIndex;
        const basename = tab.path.split("/").pop() ?? tab.path;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            className={"ide-tab" + (active ? " active" : "")}
            title={tab.path}
            onClick={() => onSwitch(i)}
          >
            <span className="ficon">
              <ShellIcon name="md" size={15} />
            </span>
            <span className="nm">{basename}</span>
            {tab.modified ? (
              <span
                className="dirty"
                title="Unsaved changes"
                aria-label="Unsaved changes"
              />
            ) : (
              <button
                type="button"
                className="x"
                aria-label={`Close ${basename}`}
                title={`Close ${basename}`}
                onClick={(e) => {
                  // Don't let the parent tab swallow the click as a
                  // "switch" — the user explicitly aimed at the ×.
                  e.stopPropagation();
                  onClose(i);
                }}
              >
                <ShellIcon name="close" size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
