import { useCallback, useEffect, useState } from "react";

import {
  listRecentVaults,
  pinRecentVault,
  removeRecentVault,
} from "../api";
import type { RecentVault } from "../types";
import { loadShellTheme } from "./shell/types";

interface WelcomeProps {
  onOpenVault: () => void;
  onOpenDemo: () => void;
  /** Open a vault by its absolute path — used by the recent-vaults
   *  list so the file picker stays out of the loop. */
  onOpenPath: (path: string) => void;
  error: string | null;
  loading: boolean;
  /** Bumps when the parent successfully loads a vault, so the recent
   *  list refetches and reflects the new entry / updated timestamp. */
  recentChangeTick: number;
}

export function Welcome({
  onOpenVault,
  onOpenDemo,
  onOpenPath,
  error,
  loading,
  recentChangeTick,
}: WelcomeProps) {
  const [recent, setRecent] = useState<RecentVault[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listRecentVaults();
      setRecent(list);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, recentChangeTick]);

  const onPinToggle = useCallback(
    async (entry: RecentVault) => {
      try {
        await pinRecentVault(entry.path, !entry.pinned);
        await refresh();
      } catch (err) {
        setListError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const onRemove = useCallback(
    async (entry: RecentVault) => {
      try {
        await removeRecentVault(entry.path);
        await refresh();
      } catch (err) {
        setListError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const hasRecent = recent !== null && recent.length > 0;

  // Wrapped in `.ide <theme>` so the pre-vault screen shares the shell
  // palette (legacy vars bridge inside .ide). Theme comes from the same
  // persisted state the statusbar toggle writes.
  const [theme] = useState(() => loadShellTheme());

  return (
    <div className={"ide " + theme}>
    <div className="welcome">
      <div className="welcome__card">
        <h1 className="welcome__title">Curator</h1>
        <p className="welcome__subtitle">
          A workflow tool for Markdown vaults. Open a vault folder to get started.
        </p>

        {hasRecent && (
          <section className="welcome__recent" aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="welcome__section-title">
              Recent
            </h2>
            <ul className="recent-list">
              {recent!.map((entry) => (
                <RecentRow
                  key={entry.path}
                  entry={entry}
                  disabled={loading}
                  onOpen={() => onOpenPath(entry.path)}
                  onPin={() => void onPinToggle(entry)}
                  onRemove={() => void onRemove(entry)}
                />
              ))}
            </ul>
          </section>
        )}

        <div className="welcome__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onOpenVault}
            disabled={loading}
          >
            Open Vault…
          </button>
          <div className="welcome__demo">
            <button
              type="button"
              className="btn"
              onClick={onOpenDemo}
              disabled={loading}
            >
              Open Demo Vault
            </button>
            <p className="welcome__demo-hint">
              Sanitized fixture bundled with the repo — for onboarding and
              tests only.
            </p>
          </div>
        </div>
        {loading && <p className="welcome__hint">Scanning…</p>}
        {error && <p className="welcome__error">{error}</p>}
        {listError && !error && (
          <p className="welcome__error">recent: {listError}</p>
        )}
      </div>
    </div>
    </div>
  );
}

interface RecentRowProps {
  entry: RecentVault;
  disabled: boolean;
  onOpen: () => void;
  onPin: () => void;
  onRemove: () => void;
}

function RecentRow({ entry, disabled, onOpen, onPin, onRemove }: RecentRowProps) {
  const name = basename(entry.path);
  return (
    <li className="recent-row">
      <button
        type="button"
        className="recent-row__main"
        onClick={onOpen}
        disabled={disabled}
        title={entry.path}
      >
        <span className="recent-row__name">
          {entry.pinned && (
            <span className="recent-row__pin-indicator" aria-hidden="true">
              📌
            </span>
          )}
          {name}
        </span>
        <span className="recent-row__path">{maskHomePath(entry.path)}</span>
        <span className="recent-row__time">
          {formatRelativeMs(entry.lastOpenedAtMs)}
        </span>
      </button>
      <div className="recent-row__actions">
        <button
          type="button"
          className="recent-row__action"
          onClick={onPin}
          title={entry.pinned ? "Unpin" : "Pin (exempt from rolling-limit)"}
          aria-label={entry.pinned ? "Unpin" : "Pin"}
        >
          {entry.pinned ? "📌" : "📍"}
        </button>
        <button
          type="button"
          className="recent-row__action recent-row__action--danger"
          onClick={onRemove}
          title="Remove from recents"
          aria-label="Remove"
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

/** Replace the user's home directory with `~` for display. Best-effort
 *  — we don't know the actual `$HOME` here, so we look for the common
 *  `/Users/<name>` and `/home/<name>` prefixes and strip them. */
function maskHomePath(p: string): string {
  const macMatch = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (macMatch) return "~" + (macMatch[1] ?? "");
  const linuxMatch = p.match(/^\/home\/[^/]+(\/.*)?$/);
  if (linuxMatch) return "~" + (linuxMatch[1] ?? "");
  return p;
}

function formatRelativeMs(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 30 * 86_400_000)
    return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}
