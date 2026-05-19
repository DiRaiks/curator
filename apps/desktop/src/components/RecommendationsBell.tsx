import { useEffect, useRef, useState } from "react";

import type {
  Recommendation,
  RecommendationCategory,
  RecommendationSeverity,
} from "../types";

interface RecommendationsBellProps {
  /** Active (non-dismissed) recommendations. */
  active: Recommendation[];
  /** Dismissed recs — exposed via "show N hidden" toggle. */
  dismissed: Recommendation[];
  onDismiss: (recId: string) => void;
  onRestore: (recId: string) => void;
  onClearAll: () => void;
  /** Jump to a project's detail view. Receives the slug. */
  onGoToProject: (slug: string) => void;
  /** Open a vault-relative file in the editor. */
  onOpenFile: (path: string) => void;
}

/**
 * Header bell + popover that surfaces recommendations across all
 * projects. Click the bell to expand; click outside to collapse. Each
 * recommendation has Dismiss + (optionally) Open File and Go To
 * Project actions. The bell is hidden when there are zero
 * recommendations (active OR dismissed) — no point taking space.
 */
export function RecommendationsBell({
  active,
  dismissed,
  onDismiss,
  onRestore,
  onClearAll,
  onGoToProject,
  onOpenFile,
}: RecommendationsBellProps) {
  const [open, setOpen] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click + Escape so the popover doesn't get stuck.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (active.length === 0 && dismissed.length === 0) return null;

  const grouped = groupByProject(active);
  const total = active.length;

  return (
    <div className="recs-bell-wrap">
      <button
        ref={buttonRef}
        type="button"
        className={
          "recs-bell" + (total > 0 ? " recs-bell--has-active" : "")
        }
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${total} recommendations`}
        title={`${total} recommendations`}
      >
        <span className="recs-bell__icon" aria-hidden>
          ★
        </span>
        <span className="recs-bell__label">recs</span>
        {total > 0 && (
          <span className="recs-bell__count">{total}</span>
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="recs-popover"
          role="dialog"
          aria-label="Recommendations"
        >
          <header className="recs-popover__header">
            <span className="recs-popover__title">Recommendations</span>
            {dismissed.length > 0 && (
              <button
                type="button"
                className="recs-popover__toggle"
                onClick={() => setShowDismissed((v) => !v)}
              >
                {showDismissed
                  ? "Hide dismissed"
                  : `Show ${dismissed.length} dismissed`}
              </button>
            )}
          </header>
          {active.length === 0 && !showDismissed ? (
            <p className="recs-popover__empty">
              Nothing pressing. Keep working.
            </p>
          ) : (
            <div className="recs-popover__body">
              {grouped.map(({ key, recs }) => (
                <section key={key} className="recs-group">
                  <h4 className="recs-group__title">{key}</h4>
                  <ul className="recs-list">
                    {recs.map((r) => (
                      <RecommendationCard
                        key={r.id}
                        rec={r}
                        dismissed={false}
                        onDismiss={onDismiss}
                        onRestore={onRestore}
                        onGoToProject={onGoToProject}
                        onOpenFile={onOpenFile}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {showDismissed && dismissed.length > 0 && (
                <section className="recs-group recs-group--dismissed">
                  <h4 className="recs-group__title">Dismissed</h4>
                  <ul className="recs-list">
                    {dismissed.map((r) => (
                      <RecommendationCard
                        key={r.id}
                        rec={r}
                        dismissed
                        onDismiss={onDismiss}
                        onRestore={onRestore}
                        onGoToProject={onGoToProject}
                        onOpenFile={onOpenFile}
                      />
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn btn--small recs-popover__clear-all"
                    onClick={onClearAll}
                  >
                    Restore all
                  </button>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RecommendationCardProps {
  rec: Recommendation;
  dismissed: boolean;
  onDismiss: (recId: string) => void;
  onRestore: (recId: string) => void;
  onGoToProject: (slug: string) => void;
  onOpenFile: (path: string) => void;
}

function RecommendationCard({
  rec,
  dismissed,
  onDismiss,
  onRestore,
  onGoToProject,
  onOpenFile,
}: RecommendationCardProps) {
  return (
    <li
      className={
        "recs-card recs-card--" +
        severitySlug(rec.severity) +
        (dismissed ? " recs-card--dismissed" : "")
      }
    >
      <div className="recs-card__head">
        <span
          className="recs-card__severity"
          title={`${rec.severity} · ${rec.category}`}
        >
          {severityIcon(rec.severity)}
        </span>
        <span className="recs-card__title">{rec.title}</span>
        <span className="recs-card__category">
          {categoryLabel(rec.category)}
        </span>
      </div>
      {rec.detail && <p className="recs-card__detail">{rec.detail}</p>}
      <div className="recs-card__actions">
        {rec.projectSlug && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => onGoToProject(rec.projectSlug!)}
          >
            Open project
          </button>
        )}
        {rec.suggestedFile && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => onOpenFile(rec.suggestedFile!)}
          >
            Open file
          </button>
        )}
        {dismissed ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => onRestore(rec.id)}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => onDismiss(rec.id)}
            title="Hide this recommendation for this vault"
          >
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}

function groupByProject(recs: Recommendation[]): {
  key: string;
  recs: Recommendation[];
}[] {
  const map = new Map<string, Recommendation[]>();
  for (const r of recs) {
    const key = r.projectSlug ?? "Vault";
    const existing = map.get(key);
    if (existing) existing.push(r);
    else map.set(key, [r]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      // "Vault" (global) goes first; then projects alphabetically.
      if (a === "Vault") return -1;
      if (b === "Vault") return 1;
      return a.localeCompare(b);
    })
    .map(([key, recs]) => ({ key, recs }));
}

function severityIcon(s: RecommendationSeverity): string {
  switch (s) {
    case "info":
      return "ℹ";
    case "suggest":
      return "💡";
    case "warn":
      return "⚠";
  }
}

function severitySlug(s: RecommendationSeverity): string {
  return s;
}

function categoryLabel(c: RecommendationCategory): string {
  switch (c) {
    case "bootstrap":
      return "bootstrap";
    case "kb-stale":
      return "kb stale";
    case "curation":
      return "curation";
    case "configuration":
      return "config";
    case "repo-state":
      return "repo";
  }
}
