//! Tiny CLI helper: `cargo run -p vault-core --example scan_path -- <path>`
//! prints a one-line summary of a scan. Used for local sanity checks.

use std::env;

use vault_core::{scan_vault, ArtifactKind, DiagnosticLevel};

fn main() {
    let path = env::args().nth(1).expect("usage: scan_path <vault-path>");
    let r = scan_vault(std::path::Path::new(&path)).expect("scan ok");
    println!(
        "vault={} meta={} agents={} about_me={} git={} md_files={} artifacts={} projects={} diagnostics={}",
        r.vault_root,
        r.has_meta,
        r.has_agents_md,
        r.has_about_me,
        r.has_git,
        r.markdown_files.len(),
        r.artifacts.len(),
        r.projects.len(),
        r.diagnostics.len(),
    );

    println!("--- artifacts by kind ---");
    let mut by_kind: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for a in &r.artifacts {
        let label = match &a.kind {
            ArtifactKind::AgentPrompt => "agent-prompt",
            ArtifactKind::VaultSkill => "vault-skill",
            ArtifactKind::ClaudeSkill => "claude-skill",
            ArtifactKind::ClaudeAgent => "claude-agent",
            ArtifactKind::ClaudeCommand => "claude-command",
            ArtifactKind::ClaudeRule => "claude-rule",
        };
        *by_kind.entry(label.to_string()).or_default() += 1;
    }
    for (k, n) in &by_kind {
        println!("  {k}: {n}");
    }

    println!("--- one sample per kind ---");
    for kind in [
        ArtifactKind::AgentPrompt,
        ArtifactKind::ClaudeCommand,
        ArtifactKind::ClaudeAgent,
        ArtifactKind::ClaudeSkill,
        ArtifactKind::ClaudeRule,
        ArtifactKind::VaultSkill,
    ] {
        if let Some(a) = r.artifacts.iter().find(|a| a.kind == kind) {
            println!(
                "  [{:?}] runnable={} {} — {}  model={:?} tools={:?} paths={:?}",
                a.kind, a.runnable, a.id, a.title, a.model, a.tools, a.paths
            );
        }
    }
    println!("--- projects (first 10) ---");
    for p in r.projects.iter().take(10) {
        println!(
            "  {} status={:?} repo={:?} local={:?}",
            p.slug, p.status, p.repo, p.local_path
        );
    }
    println!("--- diagnostics by level ---");
    let mut info = 0;
    let mut warn = 0;
    let mut err = 0;
    for d in &r.diagnostics {
        match d.level {
            DiagnosticLevel::Info => info += 1,
            DiagnosticLevel::Warning => warn += 1,
            DiagnosticLevel::Error => err += 1,
        }
    }
    println!("  info={info} warning={warn} error={err}");
}
