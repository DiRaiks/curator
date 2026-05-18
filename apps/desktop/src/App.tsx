import { useCallback, useEffect, useRef, useState } from "react";
import { Welcome } from "./components/Welcome";
import { Dashboard } from "./components/Dashboard";
import {
  demoVaultPath,
  onVaultChange,
  pickVaultFolder,
  scanVault,
  startVaultWatch,
  stopVaultWatch,
} from "./api";
import type { ScanResult } from "./types";

type AppState =
  | { kind: "welcome"; error: string | null; loading: boolean }
  | { kind: "loaded"; result: ScanResult };

export function App() {
  const [state, setState] = useState<AppState>({
    kind: "welcome",
    error: null,
    loading: false,
  });

  const loadVault = useCallback(async (path: string) => {
    setState({ kind: "welcome", error: null, loading: true });
    try {
      const result = await scanVault(path);
      setState({ kind: "loaded", result });
    } catch (err) {
      setState({
        kind: "welcome",
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  }, []);

  const onOpenVault = useCallback(async () => {
    try {
      const picked = await pickVaultFolder();
      if (!picked) return;
      await loadVault(picked);
    } catch (err) {
      setState({
        kind: "welcome",
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  }, [loadVault]);

  const onOpenDemo = useCallback(async () => {
    try {
      const path = await demoVaultPath();
      await loadVault(path);
    } catch (err) {
      setState({
        kind: "welcome",
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  }, [loadVault]);

  const onClose = useCallback(() => {
    setState({ kind: "welcome", error: null, loading: false });
  }, []);

  /**
   * Re-scan the currently loaded vault without flashing back to the Welcome
   * screen. Used after the editor creates a new Markdown file so the file
   * tree picks it up immediately. Errors are swallowed — the previous scan
   * stays visible.
   */
  const rescan = useCallback(async (vaultRoot: string): Promise<void> => {
    try {
      const result = await scanVault(vaultRoot);
      setState((prev) =>
        prev.kind === "loaded" ? { kind: "loaded", result } : prev,
      );
    } catch {
      // Keep the prior scan visible. The editor surfaces its own error.
    }
  }, []);

  /**
   * Drive the filesystem watcher off the currently loaded vault root.
   * Starting fires once per load (or vault switch); the Tauri shell replaces
   * any prior watcher internally. The latest `rescan` is held in a ref so
   * the listener doesn't need re-attaching when its identity changes.
   */
  const activeVaultRoot = state.kind === "loaded" ? state.result.vaultRoot : null;
  const rescanRef = useRef(rescan);
  rescanRef.current = rescan;

  useEffect(() => {
    if (!activeVaultRoot) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        await startVaultWatch(activeVaultRoot);
        if (cancelled) {
          void stopVaultWatch().catch(() => {});
          return;
        }
        unlisten = await onVaultChange(() => {
          void rescanRef.current(activeVaultRoot);
        });
      } catch {
        // Watcher is best-effort — manual Refresh still works.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      void stopVaultWatch().catch(() => {});
    };
  }, [activeVaultRoot]);

  if (state.kind === "welcome") {
    return (
      <Welcome
        onOpenVault={onOpenVault}
        onOpenDemo={onOpenDemo}
        error={state.error}
        loading={state.loading}
      />
    );
  }

  const vaultRoot = state.result.vaultRoot;
  return (
    <Dashboard
      result={state.result}
      onClose={onClose}
      onRescan={() => rescan(vaultRoot)}
    />
  );
}
