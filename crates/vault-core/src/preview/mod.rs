//! Run-plan preview for `(project, workflow)` selections.
//!
//! `preview_context` is read-only: it scans the vault, finds the named project
//! and prompt, and returns a `ContextPreview` describing what would be made
//! available to an AI runner. No files are written, no AI is invoked here.
//!
//! The runner-agnostic prompt text (what the user copies into Zed / Claude
//! Code / Codex / Cursor) is assembled by the `runner_prompt` submodule.

use std::collections::HashSet;
use std::path::Path;

use thiserror::Error;

use crate::scan::{scan_vault, ScanError};
use crate::types::{
    ContextPreview, IncludeReason, IncludedFile, PreviewWarning, SourceRepoStatus, WarningKind,
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

    // Find by id across any runnable kind — skills, commands, and agents
    // are first-class run targets alongside agent-prompts. Rules
    // (`ClaudeRule`) are policy fragments, not invokables, and stay
    // excluded.
    let prompt = r
        .artifacts
        .iter()
        .find(|a| a.runnable && a.id == prompt_id)
        .ok_or_else(|| PreviewError::PromptNotFound(prompt_id.to_string()))?
        .clone();

    let mut warnings: Vec<PreviewWarning> = Vec::new();

    if !prompt.runnable {
        warnings.push(PreviewWarning {
            kind: WarningKind::PromptNotRunnable,
            message: format!("selected prompt `{}` is not marked runnable", prompt.id),
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
                    message: format!("output_file `{}` does not exist yet", resolved),
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
            reason: IncludeReason::MetaAgentsRules,
        });
    }

    included.push(IncludedFile {
        path: prompt.path.clone(),
        reason: IncludeReason::SelectedPrompt,
    });

    if r.markdown_files
        .iter()
        .any(|f| f.path == project.index_file)
    {
        included.push(IncludedFile {
            path: project.index_file.clone(),
            reason: IncludeReason::ProjectIndex,
        });
        handled_project_paths.insert(project.index_file.clone());
    }

    if let Some(resolved) = resolved_output.as_ref() {
        if output_exists && resolved.starts_with(&project_prefix) {
            included.push(IncludedFile {
                path: resolved.clone(),
                reason: IncludeReason::ExistingOutputFile,
            });
            handled_project_paths.insert(resolved.clone());
        }
    }

    // Every indexed markdown file under the project dir joins the run
    // plan. (Privacy zones and per-file `scope:` opt-outs were removed
    // from the product — the agent reads the vault via --add-dir
    // regardless; the plan lists the project's own documents.)
    for f in &r.markdown_files {
        if !f.path.starts_with(&project_prefix) {
            continue;
        }
        if handled_project_paths.contains(&f.path) {
            continue;
        }
        included.push(IncludedFile {
            path: f.path.clone(),
            reason: IncludeReason::ProjectDocument,
        });
    }

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
    let raw_body = std::fs::read_to_string(vault_root.join(&prompt.path)).unwrap_or_default();
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
