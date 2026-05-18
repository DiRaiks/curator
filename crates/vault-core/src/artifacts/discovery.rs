//! Directory walkers for each artifact kind + project discovery.
//!
//! Each `discover_*` function:
//! - returns silently when its well-known directory is absent
//! - emits an error diagnostic when reading the directory fails
//! - delegates per-file parsing to `super::parsers`
//! - never panics; per-file errors become diagnostics
//!
//! `discover_projects` lives here too: it walks `02_projects/<slug>/_index.md`,
//! parses the project frontmatter, and emits a warning per slug without an
//! `_index.md`.

use std::path::Path;

use super::parsers::{
    parse_agent_prompt, parse_claude_agent, parse_claude_command, parse_claude_rule,
    parse_claude_skill, parse_vault_skill,
};
use crate::frontmatter::{fm_string, read_frontmatter_full};
use crate::types::{Diagnostic, DiagnosticLevel, Project, WorkflowArtifact};
use crate::util::{is_md_file, read_dir_sorted, rel_of};

pub(crate) fn discover_vault_skills(
    root: &Path,
    artifacts: &mut Vec<WorkflowArtifact>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join(".vault").join("skills");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read .vault/skills: {err}"),
                path: Some(".vault/skills".into()),
            });
            return;
        }
    };
    for path in entries {
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.ends_with(".skill.md") {
            continue;
        }
        let rel = rel_of(root, &path).unwrap_or(name.clone());
        match parse_vault_skill(&path, &rel) {
            Ok(a) => artifacts.push(a),
            Err(msg) => diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("vault-skill parse failed: {msg}"),
                path: Some(rel),
            }),
        }
    }
}

pub(crate) fn discover_agent_prompts(
    root: &Path,
    artifacts: &mut Vec<WorkflowArtifact>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join("00_meta").join("agent-tasks").join("prompts");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read 00_meta/agent-tasks/prompts: {err}"),
                path: Some("00_meta/agent-tasks/prompts".into()),
            });
            return;
        }
    };
    for path in entries {
        if !is_md_file(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let rel = rel_of(root, &path).unwrap_or(name);
        artifacts.push(parse_agent_prompt(&path, &rel));
    }
}

pub(crate) fn discover_claude_skills(
    root: &Path,
    artifacts: &mut Vec<WorkflowArtifact>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join("00_meta").join("_claude").join("skills");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read 00_meta/_claude/skills: {err}"),
                path: Some("00_meta/_claude/skills".into()),
            });
            return;
        }
    };
    for sub in entries {
        if !sub.is_dir() {
            continue;
        }
        let skill_md = sub.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let slug = sub
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let rel = rel_of(root, &skill_md)
            .unwrap_or_else(|| format!("00_meta/_claude/skills/{slug}/SKILL.md"));
        artifacts.push(parse_claude_skill(&skill_md, &rel, &slug));
    }
}

pub(crate) fn discover_claude_agents(
    root: &Path,
    artifacts: &mut Vec<WorkflowArtifact>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join("00_meta").join("_claude").join("agents");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read 00_meta/_claude/agents: {err}"),
                path: Some("00_meta/_claude/agents".into()),
            });
            return;
        }
    };
    for path in entries {
        if !is_md_file(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let rel = rel_of(root, &path).unwrap_or(name);
        artifacts.push(parse_claude_agent(&path, &rel));
    }
}

pub(crate) fn discover_claude_commands(
    root: &Path,
    artifacts: &mut Vec<WorkflowArtifact>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join("00_meta").join("_claude").join("commands");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read 00_meta/_claude/commands: {err}"),
                path: Some("00_meta/_claude/commands".into()),
            });
            return;
        }
    };
    for path in entries {
        if !is_md_file(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let rel = rel_of(root, &path).unwrap_or(name);
        artifacts.push(parse_claude_command(&path, &rel));
    }
}

pub(crate) fn discover_claude_rules(
    root: &Path,
    artifacts: &mut Vec<WorkflowArtifact>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join("00_meta").join("_claude").join("rules");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read 00_meta/_claude/rules: {err}"),
                path: Some("00_meta/_claude/rules".into()),
            });
            return;
        }
    };
    for path in entries {
        if !is_md_file(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let rel = rel_of(root, &path).unwrap_or(name);
        artifacts.push(parse_claude_rule(&path, &rel));
    }
}

pub(crate) fn discover_projects(
    root: &Path,
    projects: &mut Vec<Project>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let dir = root.join("02_projects");
    if !dir.is_dir() {
        return;
    }
    let entries = match read_dir_sorted(&dir) {
        Ok(e) => e,
        Err(err) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Error,
                message: format!("failed to read 02_projects: {err}"),
                path: Some("02_projects".into()),
            });
            return;
        }
    };
    for sub in entries {
        if !sub.is_dir() {
            continue;
        }
        let slug = sub
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if slug.starts_with('_') {
            continue;
        }
        let project_rel =
            rel_of(root, &sub).unwrap_or_else(|| format!("02_projects/{slug}"));
        let index = sub.join("_index.md");
        if !index.is_file() {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Warning,
                message: format!("project missing _index.md: {slug}"),
                path: Some(project_rel),
            });
            continue;
        }
        let index_rel =
            rel_of(root, &index).unwrap_or_else(|| format!("{project_rel}/_index.md"));
        let mut project = Project {
            slug,
            path: project_rel,
            index_file: index_rel,
            repo: None,
            local_path: None,
            status: None,
            my_role: None,
            default_base_branch: None,
        };
        if let Some(m) = read_frontmatter_full(&index) {
            project.repo = fm_string(&m, "repo");
            project.local_path = fm_string(&m, "local_path");
            project.status = fm_string(&m, "status");
            project.my_role = fm_string(&m, "my_role");
            project.default_base_branch = fm_string(&m, "default_base_branch");
        }
        projects.push(project);
    }
    projects.sort_by(|a, b| a.slug.cmp(&b.slug));
}
