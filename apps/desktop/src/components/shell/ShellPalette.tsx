import { useEffect, useMemo, useRef, useState } from "react";
import { ShellIcon } from "./ShellIcon";

/** One executable palette entry supplied by the shell. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Right-aligned hint (shortcut or category). */
  hint?: string;
  run: () => void;
}

interface ShellPaletteProps {
  /** Vault-relative markdown paths, jumpable by name. */
  files: string[];
  commands: PaletteCommand[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

type Item =
  | { kind: "command"; key: string; command: PaletteCommand }
  | { kind: "file"; key: string; path: string };

const MAX_FILE_ITEMS = 50;

/**
 * ⌘K command palette: commands + file jump in one list. Empty query
 * shows the command set; typing filters commands and mixes in
 * matching files. Enter / click executes; Esc or a scrim click
 * closes. Selection follows ↑/↓ and wraps.
 */
export function ShellPalette({
  files,
  commands,
  onOpenFile,
  onClose,
}: ShellPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const cmds = commands
      .filter((c) => q === "" || c.label.toLowerCase().includes(q))
      .map<Item>((c) => ({ kind: "command", key: "c:" + c.id, command: c }));
    if (q === "") return cmds;
    const fileItems = files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, MAX_FILE_ITEMS)
      .map<Item>((f) => ({ kind: "file", key: "f:" + f, path: f }));
    return [...cmds, ...fileItems];
  }, [commands, files, query]);

  // Clamp selection when the list shrinks under it.
  const sel = Math.min(selected, Math.max(0, items.length - 1));

  const runItem = (item: Item) => {
    onClose();
    if (item.kind === "command") item.command.run();
    else onOpenFile(item.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(items.length === 0 ? 0 : (sel + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(
        items.length === 0 ? 0 : (sel - 1 + items.length) % items.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[sel];
      if (item) runItem(item);
    }
  };

  // Keep the selected row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, items]);

  return (
    <div
      className="ide-palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="ide-palette" onKeyDown={onKeyDown}>
        <div className="head">
          <div className="ide-input-box">
            <ShellIcon name="search" size={14} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              placeholder="Type a command or file name…"
              aria-label="Palette query"
            />
            <span className="ide-kbd">esc</span>
          </div>
        </div>
        <div className="list" ref={listRef} role="listbox">
          {items.length === 0 && (
            <p className="ide-panel-hint">No matches.</p>
          )}
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === sel}
              data-selected={i === sel || undefined}
              className={"prow" + (i === sel ? " selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runItem(item)}
              title={item.kind === "file" ? item.path : item.command.label}
            >
              <span className="ic">
                <ShellIcon
                  name={item.kind === "file" ? "md" : "chevr"}
                  size={14}
                />
              </span>
              {item.kind === "file" ? (
                <span className="lbl ide-rtl-path">{item.path}</span>
              ) : (
                <span className="lbl">{item.command.label}</span>
              )}
              {item.kind === "command" && item.command.hint && (
                <span className="hint">{item.command.hint}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
