import { useMemo, useState } from "react";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
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
}

export function FileTree({
  files,
  onSelectFile,
  activePath,
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
}

function TreeItem({ node, depth, onSelectFile, activePath }: TreeItemProps) {
  const [open, setOpen] = useState(depth < 1);
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
        onClick={() => setOpen((v) => !v)}
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}
