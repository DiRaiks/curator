//! Integration test: scan the bundled demo vault and assert the headline
//! findings. Acts as a smoke test for the real-vault conventions, the
//! document-scope model, and the workflow-artifact catalogue.

use std::path::PathBuf;

use vault_core::{scan_vault, ArtifactKind, DiagnosticLevel, Scope};

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
fn demo_vault_matches_expectations() {
    let root = demo_vault_path();
    let r = scan_vault(&root).expect("scan succeeds");

    // home_dir should be set on macOS/Linux ($HOME) or Windows ($USERPROFILE).
    assert!(
        r.home_dir.is_some(),
        "home_dir should be detected from $HOME / $USERPROFILE"
    );

    assert!(r.has_meta);
    assert!(r.has_agents_md);
    assert!(r.has_about_me);
    assert!(r.has_meta_readme);
    assert!(!r.has_git, "demo vault has no .git/");

    // Workflow artifact catalogue per kind.
    let count_kind = |k: ArtifactKind| {
        r.artifacts.iter().filter(|a| a.kind == k).count()
    };
    assert_eq!(
        count_kind(ArtifactKind::AgentPrompt),
        3,
        "expected 3 agent-prompts"
    );
    assert_eq!(
        count_kind(ArtifactKind::VaultSkill),
        0,
        "demo must not contain a vault-skill (lives in the fixture)"
    );
    assert_eq!(
        count_kind(ArtifactKind::ClaudeSkill),
        1,
        "expected 1 claude-skill"
    );
    assert_eq!(
        count_kind(ArtifactKind::ClaudeAgent),
        1,
        "expected 1 claude-agent"
    );
    assert_eq!(
        count_kind(ArtifactKind::ClaudeCommand),
        1,
        "expected 1 claude-command"
    );
    assert_eq!(
        count_kind(ArtifactKind::ClaudeRule),
        1,
        "expected 1 claude-rule"
    );

    // Only agent-prompts are runnable.
    for a in &r.artifacts {
        let expected = matches!(a.kind, ArtifactKind::AgentPrompt);
        assert_eq!(
            a.runnable, expected,
            "runnable mismatch for artifact {} ({:?})",
            a.id, a.kind
        );
    }

    // Claude-agent metadata is parsed.
    let agent = r
        .artifacts
        .iter()
        .find(|a| matches!(a.kind, ArtifactKind::ClaudeAgent))
        .expect("agent present");
    assert_eq!(agent.id, "example-agent");
    assert_eq!(agent.model.as_deref(), Some("sonnet"));
    assert_eq!(agent.tools, vec!["Read", "Grep", "Glob"]);
    assert!(agent.description.is_some());

    // Claude-rule paths are parsed.
    let rule = r
        .artifacts
        .iter()
        .find(|a| matches!(a.kind, ArtifactKind::ClaudeRule))
        .expect("rule present");
    assert_eq!(rule.id, "example-rule");
    assert_eq!(rule.paths, vec!["**/*.ts", "**/*.tsx"]);

    // Claude-command picks up description and derives id from filename.
    let cmd = r
        .artifacts
        .iter()
        .find(|a| matches!(a.kind, ArtifactKind::ClaudeCommand))
        .expect("command present");
    assert_eq!(cmd.id, "example-command");
    assert!(cmd.description.is_some());

    // Sort: agent-prompt group first (and ordered by `order`), then commands,
    // agents, skills, rules, vault-skills.
    let kind_seq: Vec<&ArtifactKind> = r.artifacts.iter().map(|a| &a.kind).collect();
    let mut expected = kind_seq.clone();
    expected.sort_by_key(|k| match k {
        ArtifactKind::AgentPrompt => 0,
        ArtifactKind::ClaudeCommand => 1,
        ArtifactKind::ClaudeAgent => 2,
        ArtifactKind::ClaudeSkill => 3,
        ArtifactKind::ClaudeRule => 4,
        ArtifactKind::VaultSkill => 5,
    });
    assert_eq!(
        kind_seq, expected,
        "artifacts must be grouped by kind in display order"
    );

    // Projects unchanged.
    let project_slugs: Vec<&str> =
        r.projects.iter().map(|p| p.slug.as_str()).collect();
    assert_eq!(project_slugs, vec!["empty-project", "sample-project"]);

    // Document scope (sanity).
    let find_scope = |path: &str| -> Scope {
        r.markdown_files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("file not indexed: {path}"))
            .scope
            .clone()
    };
    assert_eq!(find_scope("00_meta/AGENTS.md"), Scope::Meta);
    assert_eq!(
        find_scope("02_projects/sample-project/_index.md"),
        Scope::Project
    );
    assert_eq!(find_scope("06_daily/2026-05-17.md"), Scope::PersonalWork);
    assert_eq!(
        find_scope("03_areas/team/weekly-sync.md"),
        Scope::TeamManagement
    );
    assert_eq!(find_scope("01_inbox/idea-2026-05-17.md"), Scope::Inbox);
    assert_eq!(
        find_scope("04_resources/defi-frontend-patterns.md"),
        Scope::Resource
    );
    assert_eq!(
        find_scope("05_archive/2025-old-experiment.md"),
        Scope::Archive
    );

    // The newly added 00_meta/_claude artifact files are also indexed as
    // markdown files with scope: meta.
    assert_eq!(
        find_scope("00_meta/_claude/agents/example-agent.md"),
        Scope::Meta
    );
    assert_eq!(
        find_scope("00_meta/_claude/rules/example-rule.md"),
        Scope::Meta
    );

    // .bak and warning diagnostics survive.
    let has_warning_no_index = r.diagnostics.iter().any(|d| {
        matches!(d.level, DiagnosticLevel::Warning)
            && d.message.contains("no-index-project")
    });
    assert!(has_warning_no_index);
    let has_bak_info = r.diagnostics.iter().any(|d| {
        matches!(d.level, DiagnosticLevel::Info) && d.message.contains(".bak")
    });
    assert!(has_bak_info);

    let bak_indexed = r.markdown_files.iter().any(|f| f.path.ends_with(".bak"));
    assert!(!bak_indexed, ".bak files must not be indexed as markdown");
}
