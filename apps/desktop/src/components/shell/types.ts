/** The swappable left panel currently open, or `null` when closed
 *  (editor gets maximum width). `agent` is a left panel like the
 *  rest — just wider (404px vs 268px). */
export type PanelId =
  | "projects"
  | "search"
  | "git"
  | "skills"
  | "drafts"
  | "cve"
  | "diag"
  | "agent"
  | "settings";

export type ShellTheme = "graphite" | "porcelain";

/** localStorage key for the persisted shell chrome state (theme,
 *  active panel, panel widths). Owned by Dashboard's load/persist
 *  cycle; exposed here so pre-vault screens (Welcome) can read the
 *  theme without dragging in the full state shape. */
export const SHELL_STORAGE_KEY = "vide.shell.v1";

/** Read just the persisted theme — safe before any vault is open. */
export function loadShellTheme(): ShellTheme {
  if (typeof window === "undefined") return "graphite";
  try {
    const raw = window.localStorage.getItem(SHELL_STORAGE_KEY);
    if (!raw) return "graphite";
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).theme === "porcelain"
      ? "porcelain"
      : "graphite";
  } catch {
    return "graphite";
  }
}
