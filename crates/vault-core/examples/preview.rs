//! `cargo run -p vault-core --example preview -- <vault> <project> <prompt>`
//!
//! One-shot helper that prints a compact run plan summary. Useful for
//! spot-checking real-vault behaviour without launching the GUI.

use std::env;

use vault_core::{preview_context, IncludeReason, WarningKind};

fn main() {
    let mut args = env::args().skip(1);
    let vault = args
        .next()
        .expect("usage: preview <vault-path> <project-slug> <prompt-id>");
    let project = args.next().expect("missing project slug");
    let prompt = args.next().expect("missing prompt id");

    let p = preview_context(std::path::Path::new(&vault), &project, &prompt).expect("preview ok");

    println!(
        "project={} prompt={} output_file={:?} exists={}",
        p.project_slug, p.prompt_id, p.resolved_output_file, p.output_file_exists
    );
    println!(
        "source_repo: repo={:?} local_path={:?}",
        p.source_repo.repo, p.source_repo.local_path
    );

    println!("--- warnings ---");
    for w in &p.warnings {
        let label = match w.kind {
            WarningKind::OutputFileMissing => "output-file-missing",
            WarningKind::OutputFileOutsideProject => "output-file-outside-project",
            WarningKind::OutputFileUnresolvedPlaceholder => "output-file-unresolved-placeholder",
            WarningKind::PromptNotRunnable => "prompt-not-runnable",
            WarningKind::UnresolvedPlaceholder => "unresolved-placeholder",
        };
        println!("  [{label}] {} (path={:?})", w.message, w.path);
    }

    println!("--- included files (by reason) ---");
    for reason in [
        IncludeReason::MetaAgentsRules,
        IncludeReason::SelectedPrompt,
        IncludeReason::ProjectIndex,
        IncludeReason::ProjectDocument,
        IncludeReason::ExistingOutputFile,
    ] {
        let files: Vec<_> = p.included.iter().filter(|f| f.reason == reason).collect();
        if files.is_empty() {
            continue;
        }
        let label = match reason {
            IncludeReason::MetaAgentsRules => "meta-agents-rules",
            IncludeReason::SelectedPrompt => "selected-prompt",
            IncludeReason::ProjectIndex => "project-index",
            IncludeReason::ProjectDocument => "project-document",
            IncludeReason::ExistingOutputFile => "existing-output-file",
        };
        println!("  [{label}] {} files", files.len());
        for f in files.iter().take(5) {
            println!("    - {} ({:?})", f.path, f.scope);
        }
        if files.len() > 5 {
            println!("    ... and {} more", files.len() - 5);
        }
    }

    let e = &p.excluded_counts;
    println!("--- excluded counts ---");
    println!("  personal-work:     {}", e.personal_work);
    println!("  team-management:   {}", e.team_management);
    println!("  inbox:             {}", e.inbox);
    println!("  archive/resource:  {}", e.archive_or_resource);
    println!("  ignored-path:      {}", e.ignored_path);
    println!("  bak:               {}", e.bak);
}
