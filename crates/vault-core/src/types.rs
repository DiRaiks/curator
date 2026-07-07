//! Public data types serialized to the frontend.
//!
//! These structs/enums are pure data — no behavior, no error types. Error
//! types live alongside the functions that produce them
//! (`scan::ScanError`, `preview::PreviewError`, `markdown_io::MarkdownFileError`).
//! Inspection types tied to source-repo behavior live in `source_repo.rs`.

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub vault_root: String,
    pub home_dir: Option<String>,
    pub has_meta: bool,
    pub has_agents_md: bool,
    pub has_about_me: bool,
    pub has_meta_readme: bool,
    pub has_git: bool,
    /// Whether `.vault/config.yml` exists.
    pub has_vault_config: bool,
    /// The `version:` field from `.vault/config.yml` exactly as declared,
    /// or `None` when the file is missing / has no version / is unparseable.
    pub vault_format_version: Option<String>,
    /// `true` when the vault's declared major version is ≤ the IDE's supported
    /// major. `false` when the vault is newer than the IDE understands.
    /// `true` when no version is declared (lenient default — diagnostic
    /// surfaces the "version missing" warning separately).
    pub vault_format_supported: bool,
    pub markdown_files: Vec<MarkdownFile>,
    pub artifacts: Vec<WorkflowArtifact>,
    pub projects: Vec<Project>,
    /// Markdown notes proposed by an agent run for the user to review and
    /// promote into a permanent location. See [`Draft`] for the
    /// frontmatter convention.
    pub drafts: Vec<Draft>,
    pub diagnostics: Vec<Diagnostic>,
}

/// A note an agent produced as a side-output of a run — typically a
/// reusable pattern, observation, or decision worth keeping — that the
/// agent itself does NOT promote into a permanent location. The user
/// reviews and decides where (if anywhere) it lands.
///
/// Detection: any markdown file whose frontmatter contains both
/// `status: draft-from-agent` AND `proposed_destination: <vault-relative
/// path>`. Convention is to write drafts under `01_inbox/_drafts/` but
/// detection is location-agnostic.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// Vault-relative path of the draft file itself.
    pub path: String,
    /// Human-readable label — frontmatter `title:` if present, else the
    /// filename stem.
    pub title: String,
    /// Where the agent suggests this note should live after promotion
    /// (vault-relative). Validated on promote, not at scan time.
    pub proposed_destination: String,
    /// Optional reason / context line from frontmatter — surfaced in the
    /// drafts list so the user knows why the agent thought this was
    /// reusable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Run identifier (or any string) the agent stamped to point back at
    /// the run that produced this draft. Optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_run: Option<String>,
    /// Project slug the draft is attributed to (frontmatter `project:`),
    /// if the agent set one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Frontmatter `created:` value, verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactKind {
    AgentPrompt,
    VaultSkill,
    ClaudeSkill,
    ClaudeAgent,
    ClaudeCommand,
    ClaudeRule,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowArtifact {
    pub kind: ArtifactKind,
    pub runnable: bool,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    pub path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub slug: String,
    pub path: String,
    pub index_file: String,
    pub repo: Option<String>,
    pub local_path: Option<String>,
    pub status: Option<String>,
    pub my_role: Option<String>,
    pub default_base_branch: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

/// Simple run plan for a `(project, workflow)` selection. The UI shows:
///
/// - project + workflow + resolved output file
/// - vault files that would be made available (paths only)
/// - source repo status
/// - excluded content counts (privacy summary, never file contents)
/// - warnings
///
/// There are no token estimates, no profile filtering, and no embedded-file
/// machinery — those belonged to the legacy "Generate Prompt Package" path
/// which the MVP no longer uses.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContextPreview {
    pub project_slug: String,
    pub project_path: String,
    pub project_index_file: String,
    pub prompt_id: String,
    pub prompt_title: String,
    pub prompt_path: String,
    pub resolved_output_file: Option<String>,
    pub output_file_exists: bool,
    pub included: Vec<IncludedFile>,
    pub source_repo: SourceRepoStatus,
    pub warnings: Vec<PreviewWarning>,
    /// Runner-agnostic prompt text the user can copy into Zed, Claude Code,
    /// Codex, Cursor, etc. Contains paths + instructions, not embedded file
    /// contents (except the materialized workflow body).
    pub external_runner_prompt: String,
    /// Placeholders that survived materialization of the workflow body
    /// (e.g. `<unknown_var>`). Surface separately so the UI can warn.
    pub unresolved_placeholders: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IncludedFile {
    pub path: String,
    pub reason: IncludeReason,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IncludeReason {
    MetaAgentsRules,
    SelectedPrompt,
    ProjectIndex,
    ProjectDocument,
    ExistingOutputFile,
}

/// Snapshot of the source-repo metadata declared in the project's
/// `_index.md`. Real connectivity (path exists, is git, branch, dirty, …) is
/// reported separately by `inspect_source_repo` — the UI overlays that on
/// top of this basic snapshot.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceRepoStatus {
    pub repo: Option<String>,
    pub local_path: Option<String>,
    pub default_base_branch: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWarning {
    pub kind: WarningKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WarningKind {
    OutputFileMissing,
    OutputFileOutsideProject,
    OutputFileUnresolvedPlaceholder,
    PromptNotRunnable,
    /// The materialized workflow body still contains `<foo>` / `{foo}`
    /// placeholders after substitution. Surfaced so the user knows the
    /// runner prompt may confuse the agent.
    UnresolvedPlaceholder,
}
