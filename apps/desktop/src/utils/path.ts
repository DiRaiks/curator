/**
 * Replace the user's home directory prefix with `~` for display purposes.
 *
 * - Display-only. Stored parsed values (in ScanResult) keep absolute paths.
 * - Returns the input untouched if `homeDir` is null or doesn't prefix the path.
 *
 *   maskHome("/Users/me/Work/foo", "/Users/me")  -> "~/Work/foo"
 *   maskHome("/Users/me",         "/Users/me")  -> "~"
 *   maskHome("/etc/hosts",        "/Users/me")  -> "/etc/hosts"
 *   maskHome("relative/path.md",  "/Users/me")  -> "relative/path.md"
 */
export function maskHome(
  path: string | null | undefined,
  homeDir: string | null,
): string {
  if (!path) return "";
  if (!homeDir) return path;
  if (path === homeDir) return "~";
  const prefix = homeDir.endsWith("/") ? homeDir : homeDir + "/";
  if (path.startsWith(prefix)) {
    return "~/" + path.slice(prefix.length);
  }
  return path;
}
