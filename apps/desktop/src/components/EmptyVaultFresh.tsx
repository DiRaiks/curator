import { useState } from "react";

import { initVault } from "../api";
import { maskHome } from "../utils/path";
import type { ScanResult } from "../types";

interface EmptyVaultFreshProps {
  result: ScanResult;
  /** Re-scan after init so the Dashboard transitions to state 2. */
  onRescan: () => Promise<void>;
  /** Bypass the gate and render the regular Dashboard with the
   *  "format: none" warnings. No write happens — for users who want to
   *  poke around a non-vault folder. */
  onProceedWithout: () => void;
  /** Return to the Welcome screen so the user can pick another folder. */
  onPickAnother: () => void;
}

const ZONES_PREVIEW: readonly string[] = [
  ".vault/config.yml",
  "00_meta/AGENTS.md",
  "01_inbox/_drafts/",
  "02_projects/",
  "03_areas/",
  "04_resources/",
  "05_archive/",
  "06_daily/",
];

/**
 * First-run onboarding for a folder that isn't a vault yet. Surfaces
 * three escape hatches:
 *
 * - **Initialize vault here** — writes the canonical skeleton via
 *   {@link initVault}. After re-scan, `hasVaultConfig` flips true and
 *   the Dashboard transitions to {@link EmptyVaultNoProjects}.
 * - **Proceed without** — local-only flag, no FS writes. Useful when
 *   the user wants to read existing notes in a folder that isn't
 *   structured as a vault.
 * - **Pick another folder** — back to Welcome.
 */
export function EmptyVaultFresh({
  result,
  onRescan,
  onProceedWithout,
  onPickAnother,
}: EmptyVaultFreshProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onInit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await initVault(result.vaultRoot);
      await onRescan();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
    // Don't clear `busy` on success — the rescan unmounts this screen.
  };

  // Show the top-level files / dirs the user actually has, so they can
  // confirm "yes this is the right folder" before initialising.
  const topLevel = sampleTopLevel(result.markdownFiles.map((f) => f.path), 8);
  const displayedRoot = maskHome(result.vaultRoot, result.homeDir);

  return (
    <div className="empty-vault" role="region" aria-label="Fresh folder onboarding">
      <header className="empty-vault__top">
        <span className="empty-vault__label">{displayedRoot}</span>
        <span className="pill pill--warn" title="No .vault/config.yml found">
          not a vault
        </span>
        <button
          type="button"
          className="btn btn--small"
          onClick={onPickAnother}
        >
          Close
        </button>
      </header>

      <main className="empty-vault__main">
        <aside className="empty-vault__sidebar" aria-label="Top-level entries">
          <p className="empty-vault__sidebar-title">What's there now</p>
          {topLevel.length === 0 ? (
            <p className="empty-vault__sidebar-empty">(empty folder)</p>
          ) : (
            <ul className="empty-vault__sidebar-list">
              {topLevel.map((entry) => (
                <li key={entry} className="empty-vault__sidebar-item">
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="empty-vault__hero">
          <h1 className="empty-vault__title">
            This folder isn't a vault yet
          </h1>
          <p className="empty-vault__lede">
            A vault is a structured Markdown workspace the IDE knows how to
            scan — projects, drafts, areas, archive. Initialising creates the
            canonical skeleton in this folder without touching any files
            that already exist.
          </p>

          <div className="empty-vault__plan">
            <p className="empty-vault__plan-title">
              Initialize will create:
            </p>
            <pre className="empty-vault__plan-list">
              {ZONES_PREVIEW.join("\n")}
            </pre>
          </div>

          {error && (
            <p className="empty-vault__error" role="alert">
              {error}
            </p>
          )}

          <div className="empty-vault__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                void onInit();
              }}
              disabled={busy}
            >
              {busy ? "Initializing…" : "Initialize vault here"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={onProceedWithout}
              disabled={busy}
              title="Open the folder without initializing — read-only-ish; many features will show warnings."
            >
              Proceed without
            </button>
            <button
              type="button"
              className="btn"
              onClick={onPickAnother}
              disabled={busy}
            >
              Pick another folder…
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * Pick the first `limit` unique top-level segments from `paths`. Used
 * to render a sparse "what's here" sidebar on the fresh-folder screen.
 * We deduplicate by the first path segment so a folder with 200 files
 * inside `notes/` shows as one row rather than spamming the sidebar.
 */
function sampleTopLevel(paths: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const first = p.split("/")[0];
    if (!first) continue;
    if (seen.has(first)) continue;
    seen.add(first);
    out.push(first);
    if (out.length >= limit) break;
  }
  return out;
}
