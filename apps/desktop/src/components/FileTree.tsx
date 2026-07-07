import { useMemo } from "react";
import { ShellIcon } from "./shell/ShellIcon";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** Vault-relative directory prefix whose subtree renders in the
 *  accent "draft" tone with a count badge on the folder row. */
const DRAFTS_DIR = "01_inbox/_drafts";

/**
 * Vault-relative paths of every directory that should render expanded.
 * Lifted out of the individual rows so the parent can drive "collapse
 * all" and auto-reveal in one place. A directory is open iff its path
 * is in this set — an empty set means the whole tree is collapsed.
 */
export function dirAncestors(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  // Drop the file segment; keep each parent directory's cumulative path.
  return parts.slice(0, -1).map((_, idx) => parts.slice(0, idx + 1).join("/"));
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    children: new Map(),
    isFile: false,
  };
  for (const raw of paths) {
    const parts = raw.split("/").filter(Boolean);
    let cur = root;
    parts.forEach((part, idx) => {
      const isFile = idx === parts.length - 1;
      let next = cur.children.get(part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, idx + 1).join("/"),
          children: new Map(),
          isFile,
        };
        cur.children.set(part, next);
      }
      cur = next;
    });
  }
  return root;
}

function countFiles(node: TreeNode): number {
  let n = 0;
  for (const c of node.children.values()) {
    n += c.isFile ? 1 : countFiles(c);
  }
  return n;
}

interface FileTreeProps {
  files: string[];
  onSelectFile?: (path: string) => void;
  activePath?: string | null;
  /** Directory paths to render expanded (controlled by the parent). */
  expanded: ReadonlySet<string>;
  /** Toggle a directory's expanded state. */
  onToggleDir: (path: string) => void;
}

/** Vault file tree in the shell v2 look: 22px mono rows, folder icons
 *  info-blue, md icons muted, drafts subtree in accent with a count
 *  badge on the `_drafts/` folder. */
export function FileTree({
  files,
  onSelectFile,
  activePath,
  expanded,
  onToggleDir,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  if (files.length === 0) {
    return <p className="ide-panel-hint">No markdown files.</p>;
  }
  return (
    <div className="ide-tree" role="tree">
      {[...tree.children.values()].sort(compareNodes).map((n) => (
        <TreeItem
          key={n.path}
          node={n}
          depth={0}
          onSelectFile={onSelectFile}
          activePath={activePath ?? null}
          expanded={expanded}
          onToggleDir={onToggleDir}
        />
      ))}
    </div>
  );
}

function compareNodes(a: TreeNode, b: TreeNode) {
  if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
  return a.name.localeCompare(b.name);
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  onSelectFile?: (path: string) => void;
  activePath: string | null;
  expanded: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
}

function TreeItem({
  node,
  depth,
  onSelectFile,
  activePath,
  expanded,
  onToggleDir,
}: TreeItemProps) {
  const open = expanded.has(node.path);
  const padding = { paddingLeft: depth * 12 + 10 };
  const inDrafts =
    node.path === DRAFTS_DIR || node.path.startsWith(DRAFTS_DIR + "/");

  if (node.isFile) {
    const isActive = activePath === node.path;
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={isActive}
        className={
          "ide-tnode file" +
          (inDrafts ? " draft" : "") +
          (isActive ? " active" : "")
        }
        style={padding}
        title={node.path}
        onClick={() => onSelectFile?.(node.path)}
        disabled={!onSelectFile}
      >
        <span className="caret" />
        <span className="ic">
          <ShellIcon name="md" size={14} />
        </span>
        <span className="nm">{node.name}</span>
      </button>
    );
  }

  const draftCount = node.path === DRAFTS_DIR ? countFiles(node) : 0;
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        className={"ide-tnode dir" + (inDrafts ? " draft" : "")}
        style={padding}
        onClick={() => onToggleDir(node.path)}
        title={node.path}
      >
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="ic">
          <ShellIcon name="folder" size={14} />
        </span>
        <span className="nm">{node.name}/</span>
        {draftCount > 0 && <span className="tbadge">{draftCount}</span>}
      </button>
      {open &&
        [...node.children.values()].sort(compareNodes).map((c) => (
          <TreeItem
            key={c.path}
            node={c}
            depth={depth + 1}
            onSelectFile={onSelectFile}
            activePath={activePath}
            expanded={expanded}
            onToggleDir={onToggleDir}
          />
        ))}
    </>
  );
}
