//! AI workflow artifact discovery, parsing, and metadata.
//!
//! Six artifact kinds, each living in a known location in the vault:
//!
//! | kind             | where                                    |
//! |------------------|------------------------------------------|
//! | `agent-prompt`   | `00_meta/agent-tasks/prompts/*.md`       |
//! | `claude-command` | `00_meta/_claude/commands/*.md`          |
//! | `claude-agent`   | `00_meta/_claude/agents/*.md`            |
//! | `claude-skill`   | `00_meta/_claude/skills/*/SKILL.md`      |
//! | `claude-rule`    | `00_meta/_claude/rules/*.md`             |
//! | `vault-skill`    | `.vault/skills/*.skill.md` (forward-looking) |
//!
//! Discovery walks each well-known directory in isolation. Parsing reads
//! YAML frontmatter and falls back to filename stem for `id` / `title`
//! when fields are missing. Errors during parsing produce diagnostics —
//! they never abort the scan.

use crate::types::ArtifactKind;

pub(crate) mod discovery;
mod parsers;

pub(crate) use discovery::{
    discover_agent_prompts, discover_claude_agents, discover_claude_commands,
    discover_claude_rules, discover_claude_skills, discover_projects, discover_vault_skills,
};

pub(crate) fn kind_sort_index(k: &ArtifactKind) -> u8 {
    match k {
        ArtifactKind::AgentPrompt => 0,
        ArtifactKind::ClaudeCommand => 1,
        ArtifactKind::ClaudeAgent => 2,
        ArtifactKind::ClaudeSkill => 3,
        ArtifactKind::ClaudeRule => 4,
        ArtifactKind::VaultSkill => 5,
    }
}

pub(crate) fn artifact_kind_label(k: &ArtifactKind) -> &'static str {
    match k {
        ArtifactKind::AgentPrompt => "agent-prompt",
        ArtifactKind::VaultSkill => "vault-skill",
        ArtifactKind::ClaudeSkill => "claude-skill",
        ArtifactKind::ClaudeAgent => "claude-agent",
        ArtifactKind::ClaudeCommand => "claude-command",
        ArtifactKind::ClaudeRule => "claude-rule",
    }
}

/// Every artifact kind whose Markdown body is a usable prompt is runnable
/// via the embedded CLI runner. The only exception is `ClaudeRule` —
/// rules are policy fragments auto-loaded by Claude Code based on path
/// globs, not stand-alone tasks the user invokes.
///
/// `claude-agent.tools[]` whitelisting is still on the slice-2 TODO list;
/// running a claude-agent right now uses the user's global Claude Code
/// settings for tools, same as any other invocation.
pub(crate) fn artifact_runnable(kind: &ArtifactKind) -> bool {
    !matches!(kind, ArtifactKind::ClaudeRule)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_kinds_except_rule_are_runnable() {
        assert!(artifact_runnable(&ArtifactKind::AgentPrompt));
        assert!(artifact_runnable(&ArtifactKind::VaultSkill));
        assert!(artifact_runnable(&ArtifactKind::ClaudeSkill));
        assert!(artifact_runnable(&ArtifactKind::ClaudeAgent));
        assert!(artifact_runnable(&ArtifactKind::ClaudeCommand));
        // Rules are policy fragments, not stand-alone invokables.
        assert!(!artifact_runnable(&ArtifactKind::ClaudeRule));
    }
}
