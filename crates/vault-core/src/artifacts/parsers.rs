//! Per-kind frontmatter parsers.
//!
//! Each `parse_*` function reads the YAML frontmatter at `path` (using the
//! `frontmatter` module) and produces a `WorkflowArtifact`. Only `vault-skill`
//! enforces required fields (`id`, `title`); other kinds fall back to the
//! filename stem when fields are missing.

use std::path::Path;

use super::artifact_runnable;
use crate::frontmatter::{fm_i64, fm_string, fm_string_array, read_frontmatter_full};
use crate::types::{ArtifactKind, WorkflowArtifact};
use crate::util::pretty_stem;

pub(super) fn parse_vault_skill(path: &Path, rel: &str) -> Result<WorkflowArtifact, String> {
    let m = read_frontmatter_full(path).ok_or_else(|| "missing YAML frontmatter".to_string())?;
    let id = fm_string(&m, "id").ok_or_else(|| "missing `id`".to_string())?;
    let title = fm_string(&m, "title").ok_or_else(|| "missing `title`".to_string())?;
    Ok(WorkflowArtifact {
        kind: ArtifactKind::VaultSkill,
        runnable: artifact_runnable(&ArtifactKind::VaultSkill),
        id,
        title,
        description: fm_string(&m, "description"),
        version: fm_string(&m, "version"),
        status: fm_string(&m, "status"),
        order: fm_i64(&m, "order"),
        output_file: fm_string(&m, "output_file"),
        model: None,
        tools: Vec::new(),
        paths: Vec::new(),
        path: rel.to_string(),
    })
}

pub(super) fn parse_agent_prompt(path: &Path, rel: &str) -> WorkflowArtifact {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let m = read_frontmatter_full(path);
    WorkflowArtifact {
        kind: ArtifactKind::AgentPrompt,
        runnable: artifact_runnable(&ArtifactKind::AgentPrompt),
        id: m
            .as_ref()
            .and_then(|m| fm_string(m, "id"))
            .unwrap_or_else(|| stem.clone()),
        title: m
            .as_ref()
            .and_then(|m| fm_string(m, "title"))
            .unwrap_or_else(|| pretty_stem(&stem)),
        description: m.as_ref().and_then(|m| fm_string(m, "description")),
        version: m.as_ref().and_then(|m| fm_string(m, "version")),
        status: m.as_ref().and_then(|m| fm_string(m, "status")),
        order: m.as_ref().and_then(|m| fm_i64(m, "order")),
        output_file: m.as_ref().and_then(|m| fm_string(m, "output_file")),
        model: None,
        tools: Vec::new(),
        paths: Vec::new(),
        path: rel.to_string(),
    }
}

pub(super) fn parse_claude_skill(skill_md: &Path, rel: &str, slug: &str) -> WorkflowArtifact {
    let m = read_frontmatter_full(skill_md);
    let title = m
        .as_ref()
        .and_then(|m| fm_string(m, "name").or_else(|| fm_string(m, "title")))
        .unwrap_or_else(|| slug.to_string());
    let id = m
        .as_ref()
        .and_then(|m| fm_string(m, "id"))
        .unwrap_or_else(|| slug.to_string());
    WorkflowArtifact {
        kind: ArtifactKind::ClaudeSkill,
        runnable: artifact_runnable(&ArtifactKind::ClaudeSkill),
        id,
        title,
        description: m.as_ref().and_then(|m| fm_string(m, "description")),
        version: m.as_ref().and_then(|m| fm_string(m, "version")),
        status: m.as_ref().and_then(|m| fm_string(m, "status")),
        order: m.as_ref().and_then(|m| fm_i64(m, "order")),
        output_file: m.as_ref().and_then(|m| fm_string(m, "output_file")),
        model: None,
        tools: Vec::new(),
        paths: Vec::new(),
        path: rel.to_string(),
    }
}

pub(super) fn parse_claude_agent(path: &Path, rel: &str) -> WorkflowArtifact {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let m = read_frontmatter_full(path);
    let id = m
        .as_ref()
        .and_then(|m| fm_string(m, "name"))
        .unwrap_or_else(|| stem.clone());
    WorkflowArtifact {
        kind: ArtifactKind::ClaudeAgent,
        runnable: artifact_runnable(&ArtifactKind::ClaudeAgent),
        id: id.clone(),
        title: m.as_ref().and_then(|m| fm_string(m, "title")).unwrap_or(id),
        description: m.as_ref().and_then(|m| fm_string(m, "description")),
        version: None,
        status: None,
        order: None,
        output_file: None,
        model: m.as_ref().and_then(|m| fm_string(m, "model")),
        tools: m
            .as_ref()
            .map(|m| fm_string_array(m, "tools"))
            .unwrap_or_default(),
        paths: Vec::new(),
        path: rel.to_string(),
    }
}

pub(super) fn parse_claude_command(path: &Path, rel: &str) -> WorkflowArtifact {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let m = read_frontmatter_full(path);
    WorkflowArtifact {
        kind: ArtifactKind::ClaudeCommand,
        runnable: artifact_runnable(&ArtifactKind::ClaudeCommand),
        id: stem.clone(),
        title: stem,
        description: m.as_ref().and_then(|m| fm_string(m, "description")),
        version: None,
        status: None,
        order: None,
        output_file: None,
        model: None,
        tools: Vec::new(),
        paths: Vec::new(),
        path: rel.to_string(),
    }
}

pub(super) fn parse_claude_rule(path: &Path, rel: &str) -> WorkflowArtifact {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let m = read_frontmatter_full(path);
    WorkflowArtifact {
        kind: ArtifactKind::ClaudeRule,
        runnable: artifact_runnable(&ArtifactKind::ClaudeRule),
        id: stem.clone(),
        title: stem,
        description: m.as_ref().and_then(|m| fm_string(m, "description")),
        version: None,
        status: None,
        order: None,
        output_file: None,
        model: None,
        tools: Vec::new(),
        paths: m
            .as_ref()
            .map(|m| fm_string_array(m, "paths"))
            .unwrap_or_default(),
        path: rel.to_string(),
    }
}
