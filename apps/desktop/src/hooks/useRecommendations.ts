import { useCallback, useEffect, useMemo, useState } from "react";

import {
  clearDismissals,
  computeRecommendations,
  dismissRecommendation,
  listDismissed,
  restoreRecommendation,
} from "../api";
import type { Recommendation } from "../types";

interface UseRecommendationsState {
  /** All recommendations the engine produced (unfiltered). */
  all: Recommendation[];
  /** Subset visible to the user — dismissed ids hidden. */
  active: Recommendation[];
  /** Subset hidden by the user. Exposed so the UI can show a
   *  "show N dismissed" toggle. */
  dismissed: Recommendation[];
  /** Stable Set for O(1) membership checks in render. */
  dismissedIds: Set<string>;
  loading: boolean;
  error: string | null;
}

interface UseRecommendationsActions {
  /** Re-fetch from the backend. Cheap enough to call on rescans. */
  refresh: () => Promise<void>;
  /** Hide a recommendation persistently for the current vault. */
  dismiss: (recId: string) => Promise<void>;
  /** Bring back a previously-dismissed recommendation. */
  restore: (recId: string) => Promise<void>;
  /** Restore every dismissed rec for the current vault. */
  clearAll: () => Promise<void>;
}

export type UseRecommendationsResult = UseRecommendationsState &
  UseRecommendationsActions;

/**
 * Recommendations state synced with the backend, shared across the
 * header bell and the per-project inline section.
 *
 * The hook auto-refreshes whenever `refreshKey` increments — pass the
 * dashboard's `refreshTick` so vault rescans trigger a recompute.
 * Dismissals are persisted per-vault in the OS app-data dir, so they
 * survive across IDE restarts and vault re-opens.
 */
export function useRecommendations(
  vaultRoot: string | null,
  refreshKey: number,
): UseRecommendationsResult {
  const [all, setAll] = useState<Recommendation[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!vaultRoot) {
      setAll([]);
      setDismissedIds(new Set());
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [recs, dismissed] = await Promise.all([
        computeRecommendations(vaultRoot),
        listDismissed(vaultRoot),
      ]);
      setAll(recs);
      setDismissedIds(new Set(dismissed));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [vaultRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const dismiss = useCallback(
    async (recId: string) => {
      if (!vaultRoot) return;
      // Optimistic: hide immediately so the click feels instant.
      // Backend confirms; on failure we re-fetch to recover state.
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.add(recId);
        return next;
      });
      try {
        await dismissRecommendation(vaultRoot, recId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refresh();
      }
    },
    [vaultRoot, refresh],
  );

  const restore = useCallback(
    async (recId: string) => {
      if (!vaultRoot) return;
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.delete(recId);
        return next;
      });
      try {
        await restoreRecommendation(vaultRoot, recId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refresh();
      }
    },
    [vaultRoot, refresh],
  );

  const clearAll = useCallback(async () => {
    if (!vaultRoot) return;
    setDismissedIds(new Set());
    try {
      await clearDismissals(vaultRoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void refresh();
    }
  }, [vaultRoot, refresh]);

  const { active, dismissed } = useMemo(() => {
    const a: Recommendation[] = [];
    const d: Recommendation[] = [];
    for (const r of all) {
      if (dismissedIds.has(r.id)) {
        d.push(r);
      } else {
        a.push(r);
      }
    }
    return { active: a, dismissed: d };
  }, [all, dismissedIds]);

  return {
    all,
    active,
    dismissed,
    dismissedIds,
    loading,
    error,
    refresh,
    dismiss,
    restore,
    clearAll,
  };
}
