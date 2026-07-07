import { useEffect, useState } from "react";
import { FileTree, dirAncestors } from "../FileTree";
import { PanelHead } from "./LeftPanel";
import { ShellIcon } from "./ShellIcon";
import { useDragWidth } from "./useDragWidth";

/** Resize bounds per the shell spec. */
const MIN_WIDTH = 200;
const MAX_WIDTH = 320;

interface ShellFilesProps {
  files: string[];
  activeFilePath: string | null;
  /** Error from the last file-open attempt — shown under the header,
   *  next to the affordance that triggered it. */
  openError: string | null;
  /** Panel width (px), owned + persisted by Dashboard. */
  width: number;
  onResize: (width: number) => void;
  onOpenFile: (path: string) => void;
  onNewFile: () => void;
}

/**
 * Right-hand Files panel — always visible (the core pattern of shell
 * v2: everything functional swaps on the left; the vault tree never
 * moves). Owns the expand/collapse state, including auto-revealing
 * the file that's open in the editor.
 */
export function ShellFiles({
  files,
  activeFilePath,
  openError,
  width,
  onResize,
  onOpenFile,
  onNewFile,
}: ShellFilesProps) {
  const onDragStart = useDragWidth({
    width,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    // Handle sits on the LEFT edge of this right-docked panel.
    invert: true,
    onChange: onResize,
  });
  // Collapsed by default; "collapse all" and auto-reveal both live
  // here so every row is reachable from one place.
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleDir = (path: string) =>
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Reveal the open file by expanding its ancestors — only ever adds,
  // so manually-opened folders stay as the user left them.
  useEffect(() => {
    if (!activeFilePath) return;
    const ancestors = dirAncestors(activeFilePath);
    if (ancestors.length === 0) return;
    setExpandedDirs((prev) => {
      if (ancestors.every((p) => prev.has(p))) return prev;
      return new Set([...prev, ...ancestors]);
    });
  }, [activeFilePath]);

  return (
    <aside className="ide-files" aria-label="Vault files" style={{ width }}>
      <div
        className="ide-rhandle left"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files panel"
        title="Drag to resize"
        onPointerDown={onDragStart}
      />
      <PanelHead title="Files" count="vault">
        <button
          type="button"
          className="hbtn"
          title="New Markdown file"
          aria-label="New Markdown file"
          onClick={onNewFile}
        >
          <ShellIcon name="plus" size={15} />
        </button>
        <button
          type="button"
          className="hbtn"
          title="Collapse all folders"
          aria-label="Collapse all folders"
          disabled={expandedDirs.size === 0}
          onClick={() => setExpandedDirs(new Set())}
        >
          <ShellIcon name="collapse" size={15} />
        </button>
      </PanelHead>
      {openError && (
        <p className="ide-files-error" role="alert">
          {openError}
        </p>
      )}
      <div className="ide-panel-body">
        <FileTree
          files={files}
          onSelectFile={onOpenFile}
          activePath={activeFilePath}
          expanded={expandedDirs}
          onToggleDir={toggleDir}
        />
      </div>
    </aside>
  );
}
