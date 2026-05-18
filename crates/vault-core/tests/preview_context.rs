//! Integration tests for the MVP `preview_context`.
//!
//! The run plan is intentionally simple: vault files that would be made
//! available, source-repo status, excluded-content counts, warnings. There
//! are no profiles, no token estimates, no embedded-package machinery.

use std::path::PathBuf;

use vault_core::{
    preview_context, IncludeReason, WarningKind,
};

fn demo_vault_path() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .join("..")
        .join("..")
        .join("examples")
        .join("demo-vault")
        .canonicalize()
        .expect("demo vault path resolves")
}

#[test]
fn preview_for_threat_model_on_sample_project() {
    let r = preview_context(&demo_vault_path(), "sample-project", "04-threat-model")
        .expect("preview ok");

    assert_eq!(r.project_slug, "sample-project");
    assert_eq!(r.prompt_id, "04-threat-model");

    // `<project>` in the output_file template gets substituted.
    assert_eq!(
        r.resolved_output_file.as_deref(),
        Some("02_projects/sample-project/security/threat-model.md")
    );
    assert!(
        !r.output_file_exists,
        "demo sample-project has no security/threat-model.md"
    );

    let included_paths: Vec<&str> =
        r.included.iter().map(|f| f.path.as_str()).collect();

    // Always-include set.
    assert!(
        included_paths.contains(&"00_meta/AGENTS.md"),
        "must include 00_meta/AGENTS.md"
    );
    assert!(
        included_paths.contains(&"00_meta/agent-tasks/prompts/04-threat-model.md"),
        "must include the selected prompt"
    );
    assert!(
        included_paths.contains(&"02_projects/sample-project/_index.md"),
        "must include the project _index.md"
    );
    // Plus all safe Project + Meta scope files inside the project folder.
    assert!(
        included_paths.contains(&"02_projects/sample-project/01_intake.md"),
        "must include 01_intake.md"
    );
    assert!(
        included_paths.contains(&"02_projects/sample-project/02_plan.md"),
        "must include 02_plan.md"
    );

    // Must NOT include personal-work files.
    assert!(
        !included_paths.contains(&"02_projects/sample-project/journal/2026-05-17.md"),
        "must not include journal/"
    );
    assert!(
        !included_paths
            .contains(&"02_projects/sample-project/private-decision-2026-05-17.md"),
        "fm scope override must keep private-decision out"
    );

    // Reasons are tagged correctly.
    let by_reason = |reason: IncludeReason| -> Vec<&str> {
        r.included
            .iter()
            .filter(|f| f.reason == reason)
            .map(|f| f.path.as_str())
            .collect()
    };
    assert_eq!(
        by_reason(IncludeReason::MetaAgentsRules),
        vec!["00_meta/AGENTS.md"]
    );
    assert_eq!(
        by_reason(IncludeReason::SelectedPrompt),
        vec!["00_meta/agent-tasks/prompts/04-threat-model.md"]
    );
    assert_eq!(
        by_reason(IncludeReason::ProjectIndex),
        vec!["02_projects/sample-project/_index.md"]
    );
    assert!(by_reason(IncludeReason::ExistingOutputFile).is_empty());

    // Excluded counts — demo has 2 personal-work files + 1 .bak.
    assert_eq!(r.excluded_counts.personal_work, 2);
    assert_eq!(r.excluded_counts.bak, 1);
    assert_eq!(r.excluded_counts.team_management, 0);
    assert_eq!(r.excluded_counts.inbox, 0);

    // Source-repo snapshot. Real connectivity (path exists, git, branch…)
    // is reported separately by `inspect_source_repo` — the snapshot here
    // is just the metadata declared in `_index.md`.
    assert!(r.source_repo.repo.is_some());
    assert!(r.source_repo.local_path.is_some());

    // Warnings.
    let warning_kinds: Vec<&WarningKind> =
        r.warnings.iter().map(|w| &w.kind).collect();
    assert!(
        warning_kinds.contains(&&WarningKind::OutputFileMissing),
        "missing output_file should be flagged"
    );
    assert!(
        !warning_kinds.contains(&&WarningKind::PromptNotRunnable),
        "agent-prompt is runnable; should not warn"
    );
}

#[test]
fn external_runner_prompt_contains_required_sections() {
    let r = preview_context(&demo_vault_path(), "sample-project", "04-threat-model")
        .expect("preview ok");
    let p = &r.external_runner_prompt;

    // Title.
    assert!(
        p.starts_with("# Vault Workflow Run: sample-project / 04-threat-model"),
        "title not at top of prompt"
    );

    // Required sections.
    for section in [
        "## Role",
        "## Project",
        "## Required first reads",
        "## Source repo access check",
        "## Related repos",
        "## Task instructions",
        "## Output contract",
    ] {
        assert!(p.contains(section), "missing section: {section}");
    }

    // Runner-agnostic wording (not Zed-specific).
    assert!(p.contains("Zed, Claude Code, Codex, Cursor"));

    // Paths.
    let vault_root = demo_vault_path();
    let vroot_str = vault_root.display().to_string();
    assert!(
        p.contains(&format!("{vroot_str}/00_meta/AGENTS.md")),
        "must reference absolute AGENTS.md path"
    );
    assert!(
        p.contains(&format!("{vroot_str}/02_projects/sample-project/_index.md")),
        "must reference absolute project _index.md path"
    );
    assert!(
        p.contains(&format!(
            "{vroot_str}/00_meta/agent-tasks/prompts/04-threat-model.md"
        )),
        "must reference absolute prompt path"
    );
    // Resolved output_file appears too.
    assert!(p.contains("02_projects/sample-project/security/threat-model.md"));

    // Output-contract directives.
    assert!(p.contains("Do not modify vault files directly"));
    assert!(p.contains("Return the complete proposed Markdown content"));
    assert!(p.contains("## Questions for developer"));
    assert!(p.contains("## Access requests"));
    assert!(p.contains("Repository/project needed:"));

    // Placeholder cleanup.
    assert!(
        !p.contains("Replace <project>"),
        "raw `Replace <project>` line must be cleaned"
    );
    assert!(
        !p.contains("Replace `sample-project` and `sample-project`"),
        "materialized 'Replace X and X' must be cleaned too"
    );
    assert!(
        !p.contains("before pasting"),
        "'before pasting' line should be stripped"
    );

    // <project> materialized to slug everywhere in Task instructions.
    let task_section_idx = p
        .find("## Task instructions")
        .expect("task section present");
    let after_task = &p[task_section_idx..];
    let next_section_idx = after_task
        .find("\n## Output contract")
        .expect("output contract follows task section");
    let task_block = &after_task[..next_section_idx];
    assert!(
        !task_block.contains("<project>"),
        "<project> should be materialized inside task body"
    );

    // Unresolved placeholders: the demo prompt has no funky tokens, so this
    // should be empty.
    assert!(
        r.unresolved_placeholders.is_empty(),
        "demo prompt should have no unresolved placeholders, got {:?}",
        r.unresolved_placeholders
    );
}

#[test]
fn unknown_project_returns_not_found() {
    let err = preview_context(&demo_vault_path(), "does-not-exist", "04-threat-model")
        .expect_err("must error");
    assert!(format!("{err}").contains("project not found"));
}

#[test]
fn unknown_prompt_returns_not_found() {
    let err = preview_context(&demo_vault_path(), "sample-project", "99-not-real")
        .expect_err("must error");
    assert!(format!("{err}").contains("agent-prompt not found"));
}
