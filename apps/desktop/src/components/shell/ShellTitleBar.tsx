import type { ReactNode } from "react";
import { ShellIcon } from "./ShellIcon";

interface ShellTitleBarProps {
  /** Home-masked vault root, e.g. `~/work/security-vault`. */
  vaultLabel: string;
  /** Vault repo branch, or `null` when not a git repo / unknown. */
  branch: string | null;
  /** Changed-file count in the vault repo (staged + unstaged +
   *  untracked). Must agree with the Source Control panel counts —
   *  both derive from the same `gitStatus` snapshot. 0 hides `±N`. */
  dirtyCount: number;
  /** Legacy vault (has 00_meta/ but no .vault/config.yml): renders a
   *  warn chip that opens the create-config dialog. */
  onFixConfig?: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onCloseVault: () => void;
  /** Open the ⌘K command palette. */
  onOpenPalette: () => void;
  /** Extra right-cluster content (recommendations bell). */
  children?: ReactNode;
}

/**
 * App header strip (34px, `--bg-deep`) rendered BELOW the native
 * window titlebar. We deliberately keep OS decorations (no
 * `titleBarStyle: Overlay`): the webview drag-region path proved
 * flaky (drag worked once, then stopped), and a native bar gives
 * dragging, double-click maximize, and traffic lights for free.
 */
export function ShellTitleBar({
  vaultLabel,
  branch,
  dirtyCount,
  onFixConfig,
  onRefresh,
  refreshing,
  onCloseVault,
  onOpenPalette,
  children,
}: ShellTitleBarProps) {
  return (
    <header className="ide-titlebar">
      <span>curator</span>
      <div className="ide-tl-center">
        <span>{vaultLabel}</span>
        {branch && (
          <>
            <span className="sep">·</span>
            <span className="branch">{branch}</span>
          </>
        )}
        {dirtyCount > 0 && <span className="dirty">±{dirtyCount}</span>}
      </div>
      <div className="ide-tl-right">
        {onFixConfig && (
          <button
            type="button"
            className="ide-tl-btn ide-tl-warn"
            onClick={onFixConfig}
            title='Vault has no .vault/config.yml — create it with version: "1"'
          >
            format: none · fix
          </button>
        )}
        {children}
        <button
          type="button"
          className="ide-tl-btn"
          onClick={onOpenPalette}
          title="Command palette"
        >
          ⌘K
        </button>
        <button
          type="button"
          className="ide-tl-btn"
          onClick={onRefresh}
          disabled={refreshing}
          title="Re-scan the vault from disk. Editor content is preserved."
          aria-label="Refresh vault"
        >
          <ShellIcon name="refresh" size={13} />
          {refreshing ? "…" : null}
        </button>
        <button
          type="button"
          className="ide-tl-btn"
          onClick={onCloseVault}
          title="Close this vault"
        >
          close
        </button>
      </div>
    </header>
  );
}
