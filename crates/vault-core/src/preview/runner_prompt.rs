//! External runner prompt assembly.
//!
//! `build_external_runner_prompt` turns a `(project, prompt, output)` triple
//! plus the materialized workflow body into a single Markdown string the user
//! copies into Zed Agent / Claude Code / Codex / Cursor. It contains paths and
//! instructions — never embedded vault file contents — so the prompt stays
//! shareable and the agent fetches what it needs from disk.
//!
//! Materialization is purely textual: a fixed table of placeholder → value
//! pairs (`<project>` → slug, `<repo>` → repo url, …) plus two legacy
//! patterns (`02_projects/<repo-path>/...` and a `/Users/…/Lido/<repo-path>`
//! shim). No template engine, safe on untrusted content.

use std::path::Path;

use crate::types::{Project, WorkflowArtifact};

pub(super) struct MaterializeVars<'a> {
    pub slug: &'a str,
    pub output_file: Option<&'a str>,
    pub repo: Option<&'a str>,
    pub local_path: Option<&'a str>,
    pub default_base_branch: Option<&'a str>,
    pub my_role: Option<&'a str>,
    pub status: Option<&'a str>,
}

/// Substitute project/prompt placeholders in the workflow body. Purely
/// textual — no template engine — so this is safe on untrusted content.
///
/// Two legacy patterns are special-cased:
///
/// - `02_projects/<repo-path>/...`  → `02_projects/{slug}/...`
/// - `/Users/<...>/Work/Lido/<repo-path>` → project's `local_path`
///   (never concatenated, so paths can't be duplicated)
pub(super) fn materialize_prompt_body(body: &str, vars: &MaterializeVars<'_>) -> String {
    let slug = vars.slug;
    let mut s = body.to_string();

    if let Some(local) = vars.local_path {
        s = s.replace("/Users/andreifi/Work/Lido/<repo-path>", local);
    }
    s = s.replace(
        "02_projects/<repo-path>/",
        &format!("02_projects/{}/", slug),
    );

    // Longest first so `<repo>` doesn't fire before `<repo-url>` or
    // `<repo-path>`.
    let pairs: &[(&str, Option<&str>)] = &[
        ("<default_base_branch>", vars.default_base_branch),
        ("{default_base_branch}", vars.default_base_branch),
        ("<output_file>", vars.output_file),
        ("{output_file}", vars.output_file),
        ("<local_path>", vars.local_path),
        ("{local_path}", vars.local_path),
        ("<repo-path>", Some(slug)),
        ("<repo-url>", vars.repo),
        ("{repo_url}", vars.repo),
        ("<my_role>", vars.my_role),
        ("{my_role}", vars.my_role),
        ("<status>", vars.status),
        ("{status}", vars.status),
        ("<project>", Some(slug)),
        ("{project}", Some(slug)),
        ("<branch>", vars.default_base_branch),
        ("{branch}", vars.default_base_branch),
        ("<repo>", vars.repo),
        ("{repo}", vars.repo),
    ];
    for (pat, repl) in pairs {
        if let Some(value) = repl {
            s = s.replace(pat, value);
        }
    }
    s
}

/// Drop lines that only made sense for the legacy "paste into Claude Code"
/// workflow. After materialization the line may already be substituted
/// (`Replace \`subgraph\` and \`subgraph\` before pasting...`), so the match
/// works on both pre- and post-substitution variants.
pub(super) fn clean_materialized_for_runner(materialized: &str) -> String {
    let mut out = String::with_capacity(materialized.len());
    for line in materialized.lines() {
        let lc = line.to_lowercase();
        if lc.contains("replace") && lc.contains("before pasting") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Strip leading YAML frontmatter block (between `---` delimiters) from a
/// Markdown body. Used before inlining the workflow body into the external
/// runner prompt — we don't want the YAML metadata to leak into the prompt.
pub(super) fn strip_frontmatter_block(content: &str) -> String {
    let after_open = if let Some(s) = content.strip_prefix("---\n") {
        s
    } else if let Some(s) = content.strip_prefix("---\r\n") {
        s
    } else {
        return content.to_string();
    };
    if let Some(idx) = after_open.find("\n---\n") {
        return after_open[(idx + 5)..].trim_start_matches('\n').to_string();
    }
    if let Some(idx) = after_open.find("\n---\r\n") {
        return after_open[(idx + 6)..].trim_start_matches('\n').to_string();
    }
    content.to_string()
}

/// Scan for `<word>` / `{word}` placeholders that survived materialization.
/// Word must start with a letter or `_`. Returns each distinct match once.
pub(super) fn detect_unresolved_placeholders(s: &str) -> Vec<String> {
    use std::collections::HashSet;
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let open = bytes[i];
        let close = match open {
            b'<' => b'>',
            b'{' => b'}',
            _ => {
                i += 1;
                continue;
            }
        };
        if i + 1 >= bytes.len() || !(bytes[i + 1].is_ascii_alphabetic() || bytes[i + 1] == b'_') {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len()
            && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
        {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == close {
            let placeholder = &s[i..=j];
            if seen.insert(placeholder.to_string()) {
                out.push(placeholder.to_string());
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Build the runner-agnostic prompt text that the user copies into Zed,
/// Claude Code, Codex, Cursor, etc. Contains only paths and instructions
/// plus the materialized workflow body — never embeds vault file contents.
pub(super) fn build_external_runner_prompt(
    vault_root: &Path,
    project: &Project,
    prompt: &WorkflowArtifact,
    resolved_output_file: Option<&str>,
    cleaned_materialized_body: &str,
) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(cleaned_materialized_body.len() + 2048);
    let vroot = vault_root.display();

    let _ = writeln!(
        out,
        "# Vault Workflow Run: {} / {}",
        project.slug, prompt.id
    );
    out.push('\n');

    out.push_str("## Role\n\n");
    out.push_str(
        "You are helping update a Markdown project vault using project source code as the primary source of truth and the vault as project memory.\n\n",
    );
    out.push_str(
        "You may be running in Zed, Claude Code, Codex, Cursor, or another local coding agent. The instructions below apply regardless of the runner.\n\n",
    );

    out.push_str("## Project\n\n");
    let _ = writeln!(out, "- project: `{}`", project.slug);
    let _ = writeln!(out, "- vault root: `{}`", vroot);
    let _ = writeln!(out, "- project vault folder: `{}/{}/`", vroot, project.path);
    if let Some(o) = resolved_output_file {
        let _ = writeln!(out, "- output_file: `{}/{}`", vroot, o);
    } else {
        out.push_str("- output_file: (not configured)\n");
    }
    match project.repo.as_deref() {
        Some(r) => {
            let _ = writeln!(out, "- repo: {}", r);
        }
        None => {
            out.push_str("- repo: (not configured)\n");
        }
    }
    match project.local_path.as_deref() {
        Some(l) => {
            let _ = writeln!(out, "- expected source repo path: `{}`", l);
        }
        None => {
            out.push_str("- expected source repo path: (not configured)\n");
        }
    }
    if let Some(b) = project.default_base_branch.as_deref() {
        let _ = writeln!(out, "- default base branch: `{}`", b);
    }
    if let Some(r) = project.my_role.as_deref() {
        let _ = writeln!(out, "- my role: {}", r);
    }
    if let Some(s) = project.status.as_deref() {
        let _ = writeln!(out, "- project status: {}", s);
    }
    out.push('\n');

    out.push_str("## Required first reads\n\n");
    out.push_str("Before doing anything else, read:\n\n");
    let _ = writeln!(
        out,
        "1. `{}/00_meta/AGENTS.md` — vault conventions and agent rules",
        vroot
    );
    let _ = writeln!(
        out,
        "2. `{}/{}` — project overview",
        vroot, project.index_file
    );
    let _ = writeln!(
        out,
        "3. `{}/{}` — selected workflow prompt",
        vroot, prompt.path
    );
    out.push_str(
        "\nIf any of these are not accessible, ask the user for access or to paste the contents.\n\n",
    );

    out.push_str("## Source repo access check\n\n");
    out.push_str("Determine whether you can access the source repository.\n\n");
    out.push_str("Try in this order:\n\n");
    out.push_str(
        "1. If you are already running inside the project repository workspace, use the current workspace.\n",
    );
    out.push_str(
        "2. Otherwise, try the expected source repo path above if filesystem access is available.\n",
    );
    out.push_str(
        "3. If you cannot access the source repository, do not guess. Ask the user for access.\n\n",
    );
    out.push_str(
        "Source code is the primary source of truth for bootstrap workflows like domain, architecture, operations, and services-map. Vault documents are project memory and conventions.\n\n",
    );

    out.push_str("## Related repos\n\n");
    out.push_str("If you determine that another repository is needed:\n\n");
    out.push_str("- do not search the user's filesystem broadly\n");
    out.push_str("- do not guess hidden paths\n");
    out.push_str("- ask explicitly under `## Access requests` (see Output contract below)\n\n");

    out.push_str("## Task instructions\n\n");
    out.push_str(cleaned_materialized_body.trim());
    out.push_str("\n\n");

    out.push_str("## Output contract\n\n");
    out.push_str(
        "The vault is a git-tracked Markdown knowledge base. You may write\nto vault files directly — the user reviews your changes via `git diff`\nand commits manually, so finalized content belongs on disk, not in a\nchat reply. The vault root is shown in the project section above.\n\n",
    );
    if let Some(o) = resolved_output_file {
        let _ = writeln!(
            out,
            "Primary output target — write or update:\n\n  `{}/{}`\n",
            vroot, o
        );
    } else {
        out.push_str(
            "No primary output file was configured for this workflow. Write to the most appropriate path under the project vault folder, following vault conventions.\n",
        );
    }
    out.push('\n');
    out.push_str(
        "If the target file does not exist: create it with valid YAML frontmatter following vault conventions.\n\n",
    );
    out.push_str("If it exists: edit in place, preserving useful existing structure.\n\n");
    out.push_str(
        "If information is unclear, do not invent facts. Add a section\n`## Questions for developer` at the bottom of the file (or in a\nsibling note if you didn't write a primary file) so the question lives\nalongside the work.\n\n",
    );
    out.push_str(
        "If another repository is needed, add an `## Access requests` section using the format:\n\n  - Repository/project needed:\n  - Why it is needed:\n  - Evidence that suggests this relationship:\n  - What question it would answer:\n\n",
    );
    out.push_str("Cite source paths when making claims.\n");

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(slug: &str, local: Option<&str>) -> MaterializeVars<'static> {
        // Trick: store strings via Box::leak — only used inside #[cfg(test)],
        // so leaks are bounded by the test run.
        let slug: &'static str = Box::leak(slug.to_string().into_boxed_str());
        let local: Option<&'static str> =
            local.map(|s| -> &'static str { Box::leak(s.to_string().into_boxed_str()) });
        MaterializeVars {
            slug,
            output_file: Some(Box::leak(
                format!("02_projects/{slug}/domain.md").into_boxed_str(),
            )),
            repo: None,
            local_path: local,
            default_base_branch: Some("main"),
            my_role: None,
            status: None,
        }
    }

    #[test]
    fn materialize_replaces_project_and_repo_path() {
        let v = vars("subgraph", None);
        let out = materialize_prompt_body(
            "see <project> at 02_projects/<repo-path>/architecture.md and <repo-path>",
            &v,
        );
        assert_eq!(
            out,
            "see subgraph at 02_projects/subgraph/architecture.md and subgraph"
        );
    }

    #[test]
    fn materialize_uses_local_path_for_lido_legacy_pattern() {
        let v = vars("subgraph", Some("/Users/me/Work/Lido/subgraph"));
        let out = materialize_prompt_body("cd /Users/andreifi/Work/Lido/<repo-path> && ls", &v);
        assert_eq!(out, "cd /Users/me/Work/Lido/subgraph && ls");
        assert!(!out.contains("/Users//Users"));
    }

    #[test]
    fn clean_strips_replace_before_pasting_lines() {
        let body = "Step 1\nReplace `vaults-api` and `vaults-api` before pasting into Claude Code.\nStep 2";
        let cleaned = clean_materialized_for_runner(body);
        assert!(!cleaned.contains("Replace `vaults-api`"));
        assert!(!cleaned.contains("before pasting"));
        assert!(cleaned.contains("Step 1"));
        assert!(cleaned.contains("Step 2"));
    }

    #[test]
    fn strip_frontmatter_removes_yaml_block() {
        let body = "---\ntype: agent-prompt\norder: 1\n---\n\n# Heading\n\nBody";
        let stripped = strip_frontmatter_block(body);
        assert_eq!(stripped, "# Heading\n\nBody");
    }

    #[test]
    fn strip_frontmatter_noop_when_absent() {
        let body = "# Heading\n\nBody";
        let stripped = strip_frontmatter_block(body);
        assert_eq!(stripped, body);
    }

    #[test]
    fn detect_unresolved_finds_angle_and_curly() {
        let placeholders = detect_unresolved_placeholders("a <foo> b {bar_baz} c <baz-quux> d");
        assert_eq!(placeholders, vec!["<foo>", "{bar_baz}", "<baz-quux>"]);
    }

    #[test]
    fn detect_unresolved_ignores_numeric_and_lone_brackets() {
        let placeholders = detect_unresolved_placeholders("at <3, {1}, <>, x < y, {");
        assert!(placeholders.is_empty(), "got: {:?}", placeholders);
    }
}
