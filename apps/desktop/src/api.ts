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
