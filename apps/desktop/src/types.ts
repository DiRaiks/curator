export type DiagnosticLevel = "info" | "warning" | "error";

export type ArtifactKind =
  | "agent-prompt"
  | "vault-skill"
  | "claude-skill"
  | "claude-agent"
  | "claude-command"
  | "claude-rule";

export interface MarkdownFile {
  path: string;
  noteType?: string;
  project?: string;
}

export interface WorkflowArtifact {
  kind: ArtifactKind;
  /** Whether the IDE may eventually execute this artifact via an AI runner.
   *  Only `agent-prompt` is runnable in the current build. */
  runnable: boolean;
  id: string;
  title: string;
  description?: string;
  version?: string;
  status?: string;
  order?: number;
  outputFile?: string;
  /** `claude-agent` only — model hint (e.g. "sonnet"). */
  model?: string;
  /** `claude-agent` only — tool whitelist. Security-relevant. */
  tools?: string[];
  /** `claude-rule` only — path globs the rule auto-loads for. */
  paths?: string[];
  path: string;
}

export interface Project {
  slug: string;
  path: string;
  indexFile: string;
  repo: string | null;
  localPath: string | null;
  status: string | null;
  myRole: string | null;
  defaultBaseBranch: string | null;
}

export interface Draft {
  /** Vault-relative path of the draft file. */
  path: string;
  /** Frontmatter `title:` or filename stem. */
  title: string;
  /** Vault-relative path the draft proposes to live at after promotion. */
  proposedDestination: string;
  reason?: string;
  sourceRun?: string;
  project?: string;
  created?: string;
}

export type RecommendationSeverity = "info" | "suggest" | "warn";

export type RecommendationCategory =
  | "bootstrap"
  | "kb-stale"
  | "curation"
  | "configuration"
  | "repo-state";

export interface Recommendation {
  id: string;
  severity: RecommendationSeverity;
  category: RecommendationCategory;
  title: string;
  detail?: string;
  projectSlug?: string;
  suggestedSkill?: string;
  suggestedFile?: string;
}

export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
  path: string | null;
}

export interface ScanResult {
  vaultRoot: string;
  homeDir: string | null;
  hasMeta: boolean;
  hasAgentsMd: boolean;
  hasAboutMe: boolean;
  hasMetaReadme: boolean;
  hasGit: boolean;
  hasVaultConfig: boolean;
  /** `version:` field from `.vault/config.yml` as declared, or `null`. */
  vaultFormatVersion: string | null;
  /** `false` when the vault declares a major version newer than the IDE
   *  supports. `true` when the version is missing (lenient default — the
   *  missing-version warning lives in `diagnostics`). */
  vaultFormatSupported: boolean;
  markdownFiles: MarkdownFile[];
  artifacts: WorkflowArtifact[];
  projects: Project[];
  drafts: Draft[];
  diagnostics: Diagnostic[];
}

// ---------- Run plan preview ----------

export type IncludeReason =
  | "meta-agents-rules"
  | "selected-prompt"
  | "project-index"
  | "project-document"
  | "existing-output-file";

export interface IncludedFile {
  path: string;
  reason: IncludeReason;
}

export interface SourceRepoStatus {
  repo: string | null;
  localPath: string | null;
  defaultBaseBranch: string | null;
}

export interface TopLevelEntry {
  name: string;
  isDir: boolean;
}

export interface SourceRepoInspection {
  localPath: string;
  exists: boolean;
  isGitRepo: boolean;
  branch: string | null;
  dirty: boolean | null;
  shortCommit: string | null;
  detected: string[];
  topLevel: TopLevelEntry[];
}

// ---------- Vault git (Source Control panel) ----------

/** One changed path from `git status --porcelain`, with the raw two-letter
 *  code pre-decoded into staged/unstaged/untracked booleans. Mirrors
 *  `vault_core::git::GitFileStatus`. */
export interface GitFileStatus {
  /** Work-tree path (rename destination), repo-relative, slash-separated. */
  path: string;
  /** Original path for a rename/copy; `null` otherwise. */
  origPath: string | null;
  /** Index column (`X`) status char, or `" "` when unmodified in the index. */
  index: string;
  /** Work-tree column (`Y`) status char, or `" "` when unmodified there. */
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/** Working-tree snapshot of the vault repo. Mirrors
 *  `vault_core::git::GitStatus`. */
export interface GitStatus {
  isGitRepo: boolean;
  branch: string | null;
  /** False on an unborn branch (fresh repo, no commits yet). */
  hasCommits: boolean;
  clean: boolean;
  files: GitFileStatus[];
}

/** One `git log` entry. Mirrors `vault_core::git::CommitInfo`. */
export interface CommitInfo {
  shortHash: string;
  subject: string;
  author: string;
  /** Relative committer date, e.g. "3 days ago". */
  relativeDate: string;
  unixSecs: number;
}

export interface CommitOutcome {
  shortHash: string;
}

// ---------- CVE / Vulnerability scanning ----------

export interface DependencyPackage {
  ecosystem: string;
  name: string;
  version: string;
  /** Relative path of the lock file the package was discovered in. */
  sourceLockFile: string;
}

export interface Advisory {
  package: DependencyPackage;
  /** OSV identifier — typically `GHSA-…` or `CVE-…`. */
  osvId: string;
  summary: string;
  details: string | null;
  /** Best-effort label, e.g. `CVSS_V3 7.5`. Null when OSV gave nothing parseable. */
  severity: string | null;
  fixedVersions: string[];
  references: string[];
}

export interface ProjectVulnerabilityScan {
  lockFilesScanned: string[];
  packagesScanned: number;
  advisories: Advisory[];
  /** Non-fatal warnings (parse issues, network failures). */
  warnings: string[];
}

// ---------- Session history ----------

/** Output-line buckets the chat panel renders. Matches the Rust runner's
 * own `kind` strings; the persistence layer keeps it as `string` so an
 * older row written before a new kind was introduced can still round-trip.
 */
export type SessionLineKind = "stdout" | "stderr" | "system" | "user";

export interface SessionOutputLine {
  /** Persisted-as-string from Rust. Reopen code should narrow via
   * `isSessionLineKind` before passing to the renderer. */
  kind: string;
  text: string;
}

export function isSessionLineKind(value: string): value is SessionLineKind {
  return (
    value === "stdout" ||
    value === "stderr" ||
    value === "system" ||
    value === "user"
  );
}

export interface SessionUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string | null;
}

export interface SessionSummary {
  id: number;
  claudeSessionId: string;
  vaultRoot: string;
  projectSlug: string;
  promptId: string;
  freeform: boolean;
  title: string;
  startedAtMs: number;
  endedAtMs: number | null;
  exitSuccess: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string | null;
  /** Agent backend id (`"claude-code"` / `"codex"`) that served this
   *  session. Persisted so the chat panel can restore the matching
   *  runner picker on reopen. Older rows default to `"claude-code"`
   *  via the DB migration. */
  runner: string;
  archived: boolean;
  lineCount: number;
}

export interface SessionFull {
  summary: SessionSummary;
  workdir: string;
  additionalDirs: string[];
  outputLines: SessionOutputLine[];
}

export interface RecentVault {
  path: string;
  lastOpenedAtMs: number;
  pinned: boolean;
}

export interface SaveSessionInput {
  vaultRoot: string;
  claudeSessionId: string;
  projectSlug: string;
  promptId: string;
  workdir: string;
  additionalDirs: string[];
  freeform: boolean;
  title: string;
  outputLines: SessionOutputLine[];
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
  exitSuccess: boolean | null;
  usage: SessionUsageSnapshot;
  /** Agent backend id that served this session. Frontend forwards
   *  the panel's selectedRunner here so reopen restores the same
   *  agent. Omitting it falls through to the DB's `claude-code`
   *  default (back-compat for any caller built before multi-runner). */
  runner: string;
}

export type WarningKind =
  | "output-file-missing"
  | "output-file-outside-project"
  | "output-file-unresolved-placeholder"
  | "prompt-not-runnable"
  | "unresolved-placeholder";

export interface PreviewWarning {
  kind: WarningKind;
  message: string;
  path?: string;
}

export interface ContextPreview {
  projectSlug: string;
  projectPath: string;
  projectIndexFile: string;
  promptId: string;
  promptTitle: string;
  promptPath: string;
  resolvedOutputFile: string | null;
  outputFileExists: boolean;
  included: IncludedFile[];
  sourceRepo: SourceRepoStatus;
  warnings: PreviewWarning[];
  /** Runner-agnostic prompt text ready to paste into Zed, Claude Code, Codex,
   *  Cursor, etc. Generated server-side by `preview_context`. */
  externalRunnerPrompt: string;
  /** Placeholders surviving materialization of the workflow body. */
  unresolvedPlaceholders: string[];
}
