import type { ShellTheme } from "./types";

interface ShellStatusBarProps {
  /** Chats currently running (across all drawer tabs). */
  runningCount: number;
  /** Representative title for the running chat — skill id or project
   *  slug. Only shown when exactly one chat is running. */
  runningTitle: string | null;
  /** Total saved chat sessions for this vault. */
  totalChats: number;
  errorCount: number;
  warningCount: number;
  /** Markdown files under watch (the scan's indexed count). */
  watchingCount: number;
  /** File-type segment for the active editor buffer ("md · gfm"),
   *  `null` when no file is open — the segment collapses out. */
  fileMode: string | null;
  theme: ShellTheme;
  onToggleTheme: () => void;
  onOpenAgent: () => void;
  onOpenDiagnostics: () => void;
}

/**
 * 24px statusbar on `--bg-deep`, 10.5px mono segments.
 *
 * Running-chat rule (README "Screens / 6"): exactly 1 running → its
 * title; >1 → "N running"; 0 → segment hidden entirely.
 */
export function ShellStatusBar({
  runningCount,
  runningTitle,
  totalChats,
  errorCount,
  warningCount,
  watchingCount,
  fileMode,
  theme,
  onToggleTheme,
  onOpenAgent,
  onOpenDiagnostics,
}: ShellStatusBarProps) {
  return (
    <footer className="ide-status" role="contentinfo" aria-label="Status">
      {runningCount > 0 && (
        <button
          type="button"
          className="seg accent live"
          onClick={onOpenAgent}
          title="Open agent panel"
        >
          {runningCount === 1
            ? runningTitle ?? "chat running"
            : `${runningCount} running`}
        </button>
      )}
      <button
        type="button"
        className="seg"
        onClick={onOpenAgent}
        title="Open agent panel"
      >
        {runningCount} running · {totalChats} chats
      </button>
      <button
        type="button"
        className="seg"
        onClick={onOpenDiagnostics}
        title="Open diagnostics"
      >
        <span className={errorCount > 0 ? "err" : undefined}>
          ✕ {errorCount}
        </span>
        <span className={warningCount > 0 ? "warn" : undefined}>
          ⚠ {warningCount}
        </span>
      </button>
      <span className="grow" />
      {fileMode && <span className="seg">{fileMode}</span>}
      <span className="seg">UTF-8</span>
      <button
        type="button"
        className="seg"
        onClick={onToggleTheme}
        title="Toggle theme"
      >
        ◐ {theme}
      </button>
      <span className="seg">watching · {watchingCount}</span>
    </footer>
  );
}
