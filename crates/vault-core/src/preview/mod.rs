//! Run-plan preview for `(project, workflow)` selections.
//!
//! `preview_context` is read-only: it scans the vault, finds the named project
//! and prompt, and returns a `ContextPreview` describing what would be made
//! available to an AI runner. No files are written, no AI is invoked here.
//!
//! Privacy-zone exclusions (`personal-work`, `team-management`, `inbox`,
//! `archive`, `resource`) are tallied as counts, never as file contents. The
//! static policy also excludes `*.bak`, `.env*`, `*.pem`, `*.key`.
//!
//! The runner-agnostic prompt text (what the user copies into Zed / Claude
//! Code / Codex / Cursor) is assembled by the `runner_prompt` submodule.

use std::collections::HashSet;
use std::path::Path;

use thiserror::Error;
use walkdir::WalkDir;

use crate::scan::{scan_vault, is_pruned, ScanError};
use crate::types::{
    ArtifactKind, ContextPreview, ExcludedCounts, IncludeReason, IncludedFile, PreviewWarning,
    Scope, SourceRepoStatus, WarningKind,
};

mod runner_prompt;

use runner_prompt::{
    build_external_runner_prompt, clean_materialized_for_runner, detect_unresolved_placeholders,
    materialize_prompt_body, strip_frontmatter_block, MaterializeVars,
};

#[derive(Debug, Error)]
pub enum PreviewError {
    #[error("project not found: {0}")]
    ProjectNotFound(String),
    #[error("agent-prompt not found: {0}")]
    PromptNotFound(String),
    #[error(transparent)]
    Scan(#[from] ScanError),
}

/// Build a simple run plan for a `(project, workflow)` pair. The MVP always
/// makes all safe project + meta files available — no profile filtering. The
/// returned [`ContextPreview`] is read-only: no AI is called, no files are
/// written, no prompt body is materialized here.
pub fn preview_context(
    vault_root: &Path,
    project_slug: &str,
    prompt_id: &str,
) -> Result<ContextPreview, PreviewError> {
    let r = scan_vault(vault_root)?;

    let project = r
        .projects
        .iter()
        .find(|p| p.slug == project_slug)
        .ok_or_else(|| PreviewError::ProjectNotFound(project_slug.to_string()))?
        .clone();

    let prompt = r
        .artifacts
        .iter()
        .find(|a| matches!(a.kind, ArtifactKind::AgentPrompt) && a.id == prompt_id)
        .ok_or_else(|| PreviewError::PromptNotFound(prompt_id.to_string()))?
        .clone();

    let mut warnings: Vec<PreviewWarning> = Vec::new();

    if !prompt.runnable {
        warnings.push(PreviewWarning {
            kind: WarningKind::PromptNotRunnable,
            message: format!(
                "selected prompt `{}` is not marked runnable",
                prompt.id
            ),
            path: Some(prompt.path.clone()),
        });
    }

    let project_prefix = format!("{}/", project.path);

    // Resolve output_file template — only `<project>` substitution is needed
    // for the MVP run plan; prompt-body materialization belongs to the
    // future sandbox workspace.
    let resolved_output = prompt.output_file.as_ref().map(|template| {
        let resolved = template.replace("<project>", project_slug);
        let still_has_placeholder = resolved.contains('<');
        let looks_like_path =
            resolved.contains('/') && resolved.ends_with(".md");

        if still_has_placeholder {
            warnings.push(PreviewWarning {
                kind: WarningKind::OutputFileUnresolvedPlaceholder,
                message: format!(
                    "output_file template still has unresolved placeholders: `{}`",
                    resolved
                ),
                path: Some(prompt.path.clone()),
            });
        } else if !looks_like_path {
            warnings.push(PreviewWarning {
                kind: WarningKind::OutputFileOutsideProject,
                message: format!(
                    "output_file `{}` does not look like a single file path inside the project — treating as informational",
                    resolved
                ),
                path: Some(prompt.path.clone()),
            });
        } else if !resolved.starts_with(&project_prefix) {
            warnings.push(PreviewWarning {
                kind: WarningKind::OutputFileOutsideProject,
                message: format!(
                    "output_file `{}` is outside selected project folder `{}`",
                    resolved, project.path
                ),
                path: Some(prompt.path.clone()),
            });
        }

        resolved
    });

    let mut output_exists = false;
    if let Some(resolved) = resolved_output.as_ref() {
        let looks_like_path =
            !resolved.contains('<') && resolved.contains('/') && resolved.ends_with(".md");
        if looks_like_path {
            let abs = vault_root.join(resolved);
            output_exists = abs.is_file();
            if !output_exists {
                warnings.push(PreviewWarning {
                    kind: WarningKind::OutputFileMissing,
                    message: format!(
                        "output_file `{}` does not exist yet",
                        resolved
                    ),
                    path: Some(resolved.clone()),
                });
            }
        }
    }

    // Source-repo connectivity is reported separately via
    // [`inspect_source_repo`] — no per-run-plan warning is needed.

    // ---------- Included vault files ----------
    let mut included: Vec<IncludedFile> = Vec::new();
    let mut handled_project_paths: HashSet<String> = HashSet::new();

    if r.has_agents_md {
        included.push(IncludedFile {
            path: "00_meta/AGENTS.md".to_string(),
            scope: Scope::Meta,
            reason: IncludeReason::MetaAgentsRules,
        });
    }

    included.push(IncludedFile {
        path: prompt.path.clone(),
        scope: Scope::Meta,
        reason: IncludeReason::SelectedPrompt,
    });

    if r
        .markdown_files
        .iter()
        .any(|f| f.path == project.index_file)
    {
        included.push(IncludedFile {
            path: project.index_file.clone(),
            scope: Scope::Project,
            reason: IncludeReason::ProjectIndex,
        });
        handled_project_paths.insert(project.index_file.clone());
    }

    if let Some(resolved) = resolved_output.as_ref() {
        if output_exists && resolved.starts_with(&project_prefix) {
            included.push(IncludedFile {
                path: resolved.clone(),
                scope: Scope::Project,
                reason: IncludeReason::ExistingOutputFile,
            });
            handled_project_paths.insert(resolved.clone());
        }
    }

    let mut excluded = ExcludedCounts::default();
    for f in &r.markdown_files {
        if !f.path.starts_with(&project_prefix) {
            continue;
        }
        if handled_project_paths.contains(&f.path) {
            continue;
        }
        match f.scope {
            Scope::Project | Scope::Meta => {
                included.push(IncludedFile {
                    path: f.path.clone(),
                    scope: f.scope.clone(),
                    reason: IncludeReason::ProjectDocument,
                });
            }
            Scope::PersonalWork => excluded.personal_work += 1,
            Scope::TeamManagement => excluded.team_management += 1,
            Scope::Inbox => excluded.inbox += 1,
            Scope::Archive | Scope::Resource => excluded.archive_or_resource += 1,
            Scope::Unknown => excluded.ignored_path += 1,
        }
    }

    // Static-policy exclusions: `*.bak`, `.env*`, `*.pem`, `*.key`.
    let (bak_count, ignored_count) =
        count_static_excluded_in_project(vault_root, &project.path);
    excluded.bak = bak_count;
    excluded.ignored_path += ignored_count;

    included.sort_by(|a, b| {
        include_reason_order(&a.reason)
            .cmp(&include_reason_order(&b.reason))
            .then_with(|| a.path.cmp(&b.path))
    });

    let source_repo = SourceRepoStatus {
        repo: project.repo.clone(),
        local_path: project.local_path.clone(),
        default_base_branch: project.default_base_branch.clone(),
    };

    // ---------- External runner prompt ----------
    let raw_body = std::fs::read_to_string(vault_root.join(&prompt.path))
        .unwrap_or_default();
    let body_no_fm = strip_frontmatter_block(&raw_body);
    let vars = MaterializeVars {
        slug: &project.slug,
        output_file: resolved_output.as_deref(),
        repo: project.repo.as_deref(),
        local_path: project.local_path.as_deref(),
        default_base_branch: project.default_base_branch.as_deref(),
        my_role: project.my_role.as_deref(),
        status: project.status.as_deref(),
    };
    let materialized = materialize_prompt_body(&body_no_fm, &vars);
    let cleaned = clean_materialized_for_runner(&materialized);
    let unresolved_placeholders = detect_unresolved_placeholders(&cleaned);
    if !unresolved_placeholders.is_empty() {
        warnings.push(PreviewWarning {
            kind: WarningKind::UnresolvedPlaceholder,
            message: format!(
                "{} unresolved placeholder(s) in workflow body: {}",
                unresolved_placeholders.len(),
                unresolved_placeholders.join(", ")
            ),
            path: Some(prompt.path.clone()),
        });
    }
    let external_runner_prompt = build_external_runner_prompt(
        vault_root,
        &project,
        &prompt,
        resolved_output.as_deref(),
        &cleaned,
    );

    Ok(ContextPreview {
        project_slug: project.slug.clone(),
        project_path: project.path.clone(),
        project_index_file: project.index_file.clone(),
        prompt_id: prompt.id.clone(),
        prompt_title: prompt.title.clone(),
        prompt_path: prompt.path.clone(),
        resolved_output_file: resolved_output,
        output_file_exists: output_exists,
        included,
        source_repo,
        excluded_counts: excluded,
        warnings,
        external_runner_prompt,
        unresolved_placeholders,
    })
}

fn include_reason_order(r: &IncludeReason) -> u8 {
    match r {
        IncludeReason::MetaAgentsRules => 0,
        IncludeReason::SelectedPrompt => 1,
        IncludeReason::ProjectIndex => 2,
        IncludeReason::ProjectDocument => 3,
        IncludeReason::ExistingOutputFile => 4,
    }
}

fn count_static_excluded_in_project(vault_root: &Path, project_rel: &str) -> (usize, usize) {
    let dir = vault_root.join(project_rel);
    if !dir.is_dir() {
        return (0, 0);
    }
    let mut bak = 0usize;
    let mut ignored = 0usize;
    let walker = WalkDir::new(&dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_pruned(e));
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".bak") {
            bak += 1;
            continue;
        }
        if is_static_ignored_filename(&name) {
            ignored += 1;
        }
    }
    (bak, ignored)
}

fn is_static_ignored_filename(name: &str) -> bool {
    if name.starts_with(".env") {
        return true;
    }
    if name.ends_with(".pem") || name.ends_with(".key") {
        return true;
    }
    false
}
