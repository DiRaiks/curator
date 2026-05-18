import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ContextPreview,
  ScanResult,
  SourceRepoInspection,
} from "./types";

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
