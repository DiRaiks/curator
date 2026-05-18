//! Vault scan entry point.
//!
//! `scan_vault` walks the vault root, classifies Markdown files by privacy
//! scope, aggregates them into zones, and delegates artifact + project
//! discovery to the `artifacts` module. Returns a single `ScanResult` snapshot
//! plus a list of diagnostics — never panics, never aborts on per-file errors.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use thiserror::Error;
use walkdir::WalkDir;

use crate::artifacts::{
    artifact_kind_label, discover_agent_prompts, discover_claude_agents,
    discover_claude_commands, discover_claude_rules, discover_claude_skills, discover_projects,
    discover_vault_skills, kind_sort_index,
};
use crate::config::{read_vault_config, VAULT_FORMAT_VERSION_MAJOR};
use crate::frontmatter::{
    fm_bool, fm_string, parse_frontmatter_from_head, FRONTMATTER_HEAD_BYTES,
};
use crate::scope::{compute_scope, scope_label, zone_sort_priority};
use crate::types::{
    ArtifactKind, Diagnostic, DiagnosticLevel, MarkdownFile, Project, ScanResult, Scope,
    WorkflowArtifact, Zone,
};
use crate::util::{detect_home_dir, read_head};

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("vault path does not exist: {0}")]
    NotFound(PathBuf),
    #[error("vault path is not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Cap on per-file "missing frontmatter" info diagnostics. Suppressing the
/// long tail keeps the diagnostics panel readable for legacy vaults.
const MAX_MISSING_FRONTMATTER_DIAGNOSTICS: usize = 50;

pub fn scan_vault(root: &Path) -> Result<ScanResult, ScanError> {
    if !root.exists() {
        return Err(ScanError::NotFound(root.to_path_buf()));
    }
    if !root.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut markdown_files: Vec<MarkdownFile> = Vec::new();
    let mut zone_acc: HashMap<String, (Scope, usize)> = HashMap::new();
    let mut artifacts: Vec<WorkflowArtifact> = Vec::new();
    let mut projects: Vec<Project> = Vec::new();

    let has_meta = root.join("00_meta").is_dir();
    let has_agents_md = root.join("00_meta").join("AGENTS.md").is_file();
    let has_about_me = root.join("00_meta").join("ABOUT_ME.md").is_file();
    let has_meta_readme = root.join("00_meta").join("README.md").is_file();
    let has_git = root.join(".git").exists();

    let config = read_vault_config(root);
    let vault_format_supported = match config.declared_major {
        Some(major) => major <= VAULT_FORMAT_VERSION_MAJOR,
        None => true, // lenient default when missing — separate diagnostic covers it
    };
    emit_vault_config_diagnostics(&config, vault_format_supported, &mut diagnostics);

    let mut missing_fm_total: usize = 0;
    let mut missing_fm_emitted: usize = 0;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_pruned(e));

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                diagnostics.push(Diagnostic {
                    level: DiagnosticLevel::Warning,
                    message: format!("walk error: {err}"),
                    path: None,
                });
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        let rel = p
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.to_string());

        if name.ends_with(".bak") {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Info,
                message: format!(".bak file (not indexed): {name}"),
                path: Some(rel),
            });
            continue;
        }

        let ext_is_md = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !ext_is_md {
            continue;
        }

        let head = read_head(p, FRONTMATTER_HEAD_BYTES);
        let has_fm_start = head
            .as_ref()
            .map(|h| h.starts_with("---\n") || h.starts_with("---\r\n"))
            .unwrap_or(false);
        let fm = head.as_ref().and_then(|h| parse_frontmatter_from_head(h));

        if !has_fm_start {
            missing_fm_total += 1;
            if missing_fm_emitted < MAX_MISSING_FRONTMATTER_DIAGNOSTICS {
                diagnostics.push(Diagnostic {
                    level: DiagnosticLevel::Info,
                    message: "markdown file missing YAML frontmatter".into(),
                    path: Some(rel.clone()),
                });
                missing_fm_emitted += 1;
            }
        }

        let (scope, zone_root) = compute_scope(&rel, fm.as_ref());
        let sensitivity = fm.as_ref().and_then(|m| fm_string(m, "sensitivity"));
        let audience = fm.as_ref().and_then(|m| fm_string(m, "audience"));
        let include_in_ai_context =
            fm.as_ref().and_then(|m| fm_bool(m, "include_in_ai_context"));
        let note_type = fm.as_ref().and_then(|m| fm_string(m, "type"));
        let project_fm = fm.as_ref().and_then(|m| fm_string(m, "project"));

        markdown_files.push(MarkdownFile {
            path: rel.clone(),
            scope: scope.clone(),
            sensitivity,
            audience,
            include_in_ai_context,
            note_type,
            project: project_fm,
        });

        if let Some(root) = zone_root {
            let counter = zone_acc.entry(root).or_insert((scope.clone(), 0));
            counter.1 += 1;
        }
    }

    markdown_files.sort_by(|a, b| a.path.cmp(&b.path));

    if missing_fm_total > missing_fm_emitted {
        let suppressed = missing_fm_total - missing_fm_emitted;
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Info,
            message: format!(
                "{suppressed} more markdown file(s) missing frontmatter (suppressed; cap = {MAX_MISSING_FRONTMATTER_DIAGNOSTICS})"
            ),
            path: None,
        });
    }

    let mut zones: Vec<Zone> = zone_acc
        .into_iter()
        .map(|(path, (scope, file_count))| Zone {
            path,
            scope,
            file_count,
        })
        .collect();
    zones.sort_by(|a, b| {
        zone_sort_priority(&a.scope)
            .cmp(&zone_sort_priority(&b.scope))
            .then_with(|| a.path.cmp(&b.path))
    });

    for z in &zones {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Info,
            message: format!(
                "private zone detected: {} ({}, {} files)",
                z.path,
                scope_label(&z.scope),
                z.file_count
            ),
            path: Some(z.path.clone()),
        });
    }

    discover_vault_skills(root, &mut artifacts, &mut diagnostics);
    discover_agent_prompts(root, &mut artifacts, &mut diagnostics);
    discover_claude_skills(root, &mut artifacts, &mut diagnostics);
    discover_claude_agents(root, &mut artifacts, &mut diagnostics);
    discover_claude_commands(root, &mut artifacts, &mut diagnostics);
    discover_claude_rules(root, &mut artifacts, &mut diagnostics);

    artifacts.sort_by(|a, b| {
        let ka = (
            kind_sort_index(&a.kind),
            a.order.unwrap_or(i64::MAX),
            a.title.to_lowercase(),
            a.id.to_lowercase(),
        );
        let kb = (
            kind_sort_index(&b.kind),
            b.order.unwrap_or(i64::MAX),
            b.title.to_lowercase(),
            b.id.to_lowercase(),
        );
        ka.cmp(&kb)
    });

    let mut seen: HashSet<String> = HashSet::new();
    let dups: Vec<(String, String, ArtifactKind)> = artifacts
        .iter()
        .filter_map(|a| {
            let key = format!("{:?}|{}", a.kind, a.id);
            if !seen.insert(key) {
                Some((a.id.clone(), a.path.clone(), a.kind.clone()))
            } else {
                None
            }
        })
        .collect();
    for (id, path, kind) in dups {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Warning,
            message: format!(
                "duplicate artifact id within kind {}: {id}",
                artifact_kind_label(&kind)
            ),
            path: Some(path),
        });
    }

    discover_projects(root, &mut projects, &mut diagnostics);

    Ok(ScanResult {
        vault_root: root.to_string_lossy().to_string(),
        home_dir: detect_home_dir(),
        has_meta,
        has_agents_md,
        has_about_me,
        has_meta_readme,
        has_git,
        has_vault_config: config.exists,
        vault_format_version: config.raw_version,
        vault_format_supported,
        markdown_files,
        zones,
        artifacts,
        projects,
        diagnostics,
    })
}

fn emit_vault_config_diagnostics(
    config: &crate::config::VaultConfigInfo,
    supported: bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    const CONFIG_PATH: &str = ".vault/config.yml";
    if !config.exists {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Warning,
            message: format!(
                "{CONFIG_PATH} missing — vault format version cannot be determined; add `version: \"{VAULT_FORMAT_VERSION_MAJOR}\"` to lock the contract"
            ),
            path: Some(CONFIG_PATH.into()),
        });
        return;
    }
    match (&config.raw_version, config.declared_major) {
        (None, _) => diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Warning,
            message: format!(
                "{CONFIG_PATH} has no `version:` field; add `version: \"{VAULT_FORMAT_VERSION_MAJOR}\"` to lock the contract"
            ),
            path: Some(CONFIG_PATH.into()),
        }),
        (Some(raw), None) => diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Error,
            message: format!(
                "{CONFIG_PATH} `version: \"{raw}\"` is not a parseable major version"
            ),
            path: Some(CONFIG_PATH.into()),
        }),
        (Some(raw), Some(major)) if !supported => diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Warning,
            message: format!(
                "vault format `{raw}` (major {major}) is newer than this IDE supports (major {VAULT_FORMAT_VERSION_MAJOR}); some fields may not be read correctly"
            ),
            path: Some(CONFIG_PATH.into()),
        }),
        _ => {}
    }
}

pub(crate) fn is_pruned(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    if matches!(
        name.as_ref(),
        ".git"
            | ".claude"
            | ".obsidian"
            | ".DS_Store"
            | "__MACOSX"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
    ) {
        return true;
    }
    if name.starts_with("._") {
        return true;
    }
    false
}
