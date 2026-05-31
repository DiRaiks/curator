import { useMemo } from "react";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/**
 * Vault-relative paths of every directory that should render expanded.
 * Lifted out of the individual rows so the sidebar can drive "collapse
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

interface FileTreeProps {
  files: string[];
  onSelectFile?: (path: string) => void;
  activePath?: string | null;
  /** Directory paths to render expanded (controlled by the parent). */
  expanded: ReadonlySet<string>;
  /** Toggle a directory's expanded state. */
  onToggleDir: (path: string) => void;
}

export function FileTree({
  files,
  onSelectFile,
  activePath,
  expanded,
  onToggleDir,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  if (files.length === 0) {
    return <p className="empty">No markdown files.</p>;
  }
  return (
    <ul className="tree">
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
    </ul>
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
  const padding = { paddingLeft: depth * 12 + 4 };
  if (node.isFile) {
    const isActive = activePath === node.path;
    return (
      <li
        className={
          "tree__item tree__item--file" +
          (isActive ? " tree__item--active" : "")
        }
        title={node.path}
      >
        <button
          type="button"
          className="tree__file-btn"
          style={padding}
          onClick={() => onSelectFile?.(node.path)}
          disabled={!onSelectFile}
        >
          <span className="tree__icon">·</span>
          {node.name}
        </button>
      </li>
    );
  }
  return (
    <li className="tree__item tree__item--dir">
      <button
        type="button"
        className="tree__toggle"
        style={padding}
        onClick={() => onToggleDir(node.path)}
        aria-expanded={open}
      >
        <span className="tree__icon">{open ? "▾" : "▸"}</span>
        {node.name}
      </button>
      {open && (
        <ul className="tree">
          {[...node.children.values()].sort(compareNodes).map((c) => (
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
        </ul>
      )}
    </li>
  );
}
