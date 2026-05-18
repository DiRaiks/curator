export type DiagnosticLevel = "info" | "warning" | "error";

export type ArtifactKind =
  | "agent-prompt"
  | "vault-skill"
  | "claude-skill"
  | "claude-agent"
  | "claude-command"
  | "claude-rule";

export type Scope =
  | "project"
  | "meta"
  | "personal-work"
  | "team-management"
  | "inbox"
  | "resource"
  | "archive"
  | "unknown";

export interface MarkdownFile {
  path: string;
  scope: Scope;
  sensitivity?: string;
  audience?: string;
  includeInAiContext?: boolean;
  noteType?: string;
  project?: string;
}

export interface Zone {
  path: string;
  scope: Scope;
  fileCount: number;
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
  zones: Zone[];
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
  scope: Scope;
  reason: IncludeReason;
}

export interface ExcludedCounts {
  personalWork: number;
  teamManagement: number;
  inbox: number;
  archiveOrResource: number;
  ignoredPath: number;
  bak: number;
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
  excludedCounts: ExcludedCounts;
  warnings: PreviewWarning[];
  /** Runner-agnostic prompt text ready to paste into Zed, Claude Code, Codex,
   *  Cursor, etc. Generated server-side by `preview_context`. */
  externalRunnerPrompt: string;
  /** Placeholders surviving materialization of the workflow body. */
  unresolvedPlaceholders: string[];
}
