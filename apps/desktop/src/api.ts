import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ContextPreview,
  ScanResult,
  SourceRepoInspection,
} from "./types";

export interface VaultChangeEvent {
  root: string;
  paths: string[];
}

export async function scanVault(path: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_vault", { path });
}

export async function pickVaultFolder(): Promise<string | null> {
  const result = await open({
    directory: true,
    multiple: false,
    title: "Open Vault Folder",
  });
  if (Array.isArray(result)) return result[0] ?? null;
  return result ?? null;
}

export async function demoVaultPath(): Promise<string> {
  return invoke<string>("demo_vault_path");
}

export async function previewContext(
  vaultPath: string,
  projectSlug: string,
  promptId: string,
): Promise<ContextPreview> {
  return invoke<ContextPreview>("preview_context", {
    vaultPath,
    projectSlug,
    promptId,
  });
}

export async function readMarkdownFile(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  return invoke<string>("read_markdown_file", { vaultRoot, relativePath });
}

export async function writeMarkdownFile(
  vaultRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await invoke<void>("write_markdown_file", { vaultRoot, relativePath, content });
}

export async function createMarkdownFile(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  return invoke<string>("create_markdown_file", { vaultRoot, relativePath });
}

export async function inspectSourceRepo(
  localPath: string,
): Promise<SourceRepoInspection> {
  return invoke<SourceRepoInspection>("inspect_source_repo", { localPath });
}

/**
 * Start the filesystem watcher for the given vault root. Any previously
 * running watcher is replaced. The Tauri shell emits a `vault:changed`
 * event whenever the 300 ms debounce window fires.
 */
export async function startVaultWatch(vaultRoot: string): Promise<void> {
  await invoke<void>("start_vault_watch", { vaultRoot });
}

export async function stopVaultWatch(): Promise<void> {
  await invoke<void>("stop_vault_watch");
}

/**
 * Subscribe to debounced vault filesystem change events. The returned promise
 * resolves to an `unlisten` function — call it to detach the listener.
 */
export async function onVaultChange(
  handler: (event: VaultChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<VaultChangeEvent>("vault:changed", (event) => {
    handler(event.payload);
  });
}

// ---------- Runner ----------

export interface RunStartedEvent {
  projectSlug: string;
  promptId: string;
  workdir: string;
  runner: string;
}

export interface RunLineEvent {
  line: string;
}

export interface RunTruncatedEvent {
  droppedBytes: number;
}

export interface RunExitEvent {
  code: number | null;
  success: boolean;
}

export interface RunStatus {
  active: boolean;
}

export async function startRun(args: {
  vaultRoot: string;
  projectSlug: string;
  promptId: string;
  runtimeInput?: string;
}): Promise<void> {
  await invoke<void>("start_run", args);
}

export async function stopRun(): Promise<void> {
  await invoke<void>("stop_run");
}

/**
 * Snapshot of run state. Components query this on mount to synchronise
 * their local "is a run active right now?" flag with the backend — the
 * lifecycle events alone are not enough since a component may mount
 * while a run is already in progress.
 */
export async function getRunStatus(): Promise<RunStatus> {
  return invoke<RunStatus>("get_run_status");
}

/**
 * Subscribe to all run-lifecycle events with one call. Returns an unlisten
 * function that detaches every individual listener at once.
 *
 * Subscription is atomic — all `listen()` calls happen in parallel and
 * we await them together. This closes a race where a component unmounts
 * mid-`await` and the remaining listeners attach after cleanup ran,
 * leaking event handlers for the lifetime of the window.
 */
export async function onRunEvents(handlers: {
  onStarted?: (e: RunStartedEvent) => void;
  onStdout?: (e: RunLineEvent) => void;
  onStderr?: (e: RunLineEvent) => void;
  onTruncated?: (e: RunTruncatedEvent) => void;
  onExit?: (e: RunExitEvent) => void;
}): Promise<UnlistenFn> {
  const pending: Promise<UnlistenFn>[] = [];

  // Capture each handler in a local `const` before crossing the async
  // boundary so the closure body doesn't need a non-null assertion.
  if (handlers.onStarted) {
    const h = handlers.onStarted;
    pending.push(
      listen<RunStartedEvent>("run:started", (ev) => h(ev.payload)),
    );
  }
  if (handlers.onStdout) {
    const h = handlers.onStdout;
    pending.push(listen<RunLineEvent>("run:stdout", (ev) => h(ev.payload)));
  }
  if (handlers.onStderr) {
    const h = handlers.onStderr;
    pending.push(listen<RunLineEvent>("run:stderr", (ev) => h(ev.payload)));
  }
  if (handlers.onTruncated) {
    const h = handlers.onTruncated;
    pending.push(
      listen<RunTruncatedEvent>("run:truncated", (ev) => h(ev.payload)),
    );
  }
  if (handlers.onExit) {
    const h = handlers.onExit;
    pending.push(listen<RunExitEvent>("run:exit", (ev) => h(ev.payload)));
  }

  const unlisteners = await Promise.all(pending);
  return () => {
    for (const un of unlisteners) un();
  };
}
