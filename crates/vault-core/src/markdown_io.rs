//! Markdown read / write / create with vault-rooted path validation.
//!
//! All three public entry points (`read_markdown_file`, `write_markdown_file`,
//! `create_markdown_file`) funnel through `validate_md_path`, which enforces:
//!
//! - the path ends with `.md`
//! - no path traversal (`..`)
//! - no writes into `.git/`, `.obsidian/`, `node_modules/`, `target/`,
//!   `dist/`, `build/`, `.next/` at any depth; no writes into root `.claude/`
//! - no writes into `.vault/cache/` or `.vault/tmp/`
//! - no `.bak` / `.pem` / `.key` suffix even on `.md`-like names
//! - the resolved path stays inside the canonicalized vault root (catches
//!   symlinks-escape attempts even when the target file does not exist yet)
//!
//! Privacy-scope (`personal-work`, `team-management`) is **not** enforced here
//! — that classification only filters AI workflows; manual edits in the
//! editor are always allowed.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::util::format_today_utc;

#[derive(Debug, Error)]
pub enum MarkdownFileError {
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("file already exists: {0}")]
    AlreadyExists(String),
    #[error("path resolves outside vault: {0}")]
    OutsideVault(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Directory names that are off-limits to writes at **any** path depth.
const FORBIDDEN_DIRS_ANY_DEPTH: &[&str] = &[
    ".git",
    ".obsidian",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
];

/// Directory names that are off-limits only when they appear at the vault root.
const FORBIDDEN_DIRS_ROOT_ONLY: &[&str] = &[".claude"];

/// Read a Markdown file from inside the vault. See module-level docs for the
/// path validation rules.
pub fn read_markdown_file(
    vault_root: &Path,
    relative_path: &str,
) -> Result<String, MarkdownFileError> {
    let abs = validate_md_path(vault_root, relative_path)?;
    if !abs.is_file() {
        return Err(MarkdownFileError::NotFound(relative_path.to_string()));
    }
    Ok(std::fs::read_to_string(&abs)?)
}

/// Overwrite an existing `.md` file inside the vault with new content.
/// Path validation matches [`read_markdown_file`].
pub fn write_markdown_file(
    vault_root: &Path,
    relative_path: &str,
    content: &str,
) -> Result<(), MarkdownFileError> {
    let abs = validate_md_path(vault_root, relative_path)?;
    if !abs.is_file() {
        return Err(MarkdownFileError::NotFound(relative_path.to_string()));
    }
    std::fs::write(&abs, content)?;
    Ok(())
}

/// Create a new `.md` file inside the vault with a minimal template. Parent
/// directories are created if they don't exist. Returns the content that was
/// written so the UI can open the file without an extra read round-trip.
///
/// Errors if the file already exists or if path validation fails.
pub fn create_markdown_file(
    vault_root: &Path,
    relative_path: &str,
) -> Result<String, MarkdownFileError> {
    let abs = validate_md_path(vault_root, relative_path)?;
    if abs.exists() {
        return Err(MarkdownFileError::AlreadyExists(relative_path.to_string()));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stem = Path::new(relative_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("new-note");
    let today = format_today_utc();
    let content = format!(
        "---\ntype: note\ntags: []\ncreated: {today}\nupdated: {today}\n---\n\n**Summary**: TODO\n\n# {stem}\n\nTODO\n"
    );
    std::fs::write(&abs, &content)?;
    Ok(content)
}

fn validate_md_path(vault_root: &Path, rel: &str) -> Result<PathBuf, MarkdownFileError> {
    if rel.is_empty() {
        return Err(MarkdownFileError::InvalidPath("path is empty".into()));
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(MarkdownFileError::InvalidPath(
            "absolute paths are not allowed".into(),
        ));
    }
    let rel_norm = rel.replace('\\', "/");
    let segments: Vec<&str> = rel_norm.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(MarkdownFileError::InvalidPath(
            "path has no segments".into(),
        ));
    }
    for seg in &segments {
        if *seg == ".." {
            return Err(MarkdownFileError::InvalidPath(
                "path traversal (..) is not allowed".into(),
            ));
        }
        if FORBIDDEN_DIRS_ANY_DEPTH.contains(seg) {
            return Err(MarkdownFileError::InvalidPath(format!(
                "cannot write into `{seg}/`"
            )));
        }
    }
    if let Some(first) = segments.first() {
        if FORBIDDEN_DIRS_ROOT_ONLY.contains(first) {
            return Err(MarkdownFileError::InvalidPath(format!(
                "cannot write into root `{first}/`"
            )));
        }
    }
    if rel_norm.starts_with(".vault/cache/") || rel_norm.starts_with(".vault/tmp/") {
        return Err(MarkdownFileError::InvalidPath(
            "cannot write into .vault/cache or .vault/tmp".into(),
        ));
    }
    let lower = rel_norm.to_lowercase();
    if !lower.ends_with(".md") {
        return Err(MarkdownFileError::InvalidPath(
            "path must end with .md".into(),
        ));
    }
    // Defense-in-depth: even though .md is required, explicitly reject these
    // suffixes so a future relaxation can't silently allow secret-like files.
    if lower.ends_with(".bak") || lower.ends_with(".pem") || lower.ends_with(".key") {
        return Err(MarkdownFileError::InvalidPath(
            "forbidden file suffix".into(),
        ));
    }
    // Canonicalize the vault root, then validate that the deepest existing
    // ancestor of the target path still lives inside it. This catches
    // symlinks-escape attempts even when the target file does not exist yet.
    let canonical_vault = vault_root.canonicalize().map_err(|e| {
        MarkdownFileError::InvalidPath(format!("vault root not accessible: {e}"))
    })?;
    let abs = canonical_vault.join(&rel_norm);
    let existing = canonicalize_existing_ancestor(&abs)?;
    if !existing.starts_with(&canonical_vault) {
        return Err(MarkdownFileError::OutsideVault(format!(
            "resolved path is outside vault: {}",
            existing.display()
        )));
    }
    Ok(abs)
}

fn canonicalize_existing_ancestor(path: &Path) -> Result<PathBuf, MarkdownFileError> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return Ok(current.canonicalize()?);
        }
        match current.parent() {
            Some(p) if p != current => current = p.to_path_buf(),
            _ => {
                return Err(MarkdownFileError::InvalidPath(
                    "no existing ancestor found for path".into(),
                ));
            }
        }
    }
}

// ---------- Draft promotion ----------

/// Promote an agent-produced draft into its proposed destination.
///
/// Reads the draft, strips the `status: draft-from-agent` /
/// `proposed_destination` / `source_run` marker fields, rewrites the
/// frontmatter, and writes the result at the destination. The original
/// draft file is deleted on success.
///
/// Both source and destination paths go through full vault-rooted
/// validation (same rules as `write_markdown_file`). The destination
/// must not already exist — promoting onto a real file would silently
/// destroy whatever was there.
///
/// Returns the vault-relative path the draft landed at.
pub fn promote_draft(
    vault_root: &Path,
    draft_path: &str,
) -> Result<String, MarkdownFileError> {
    // Load + parse the draft.
    let abs_draft = validate_md_path(vault_root, draft_path)?;
    if !abs_draft.is_file() {
        return Err(MarkdownFileError::NotFound(draft_path.to_string()));
    }
    let content = std::fs::read_to_string(&abs_draft)?;

    let (raw_fm, body) = split_frontmatter(&content).ok_or_else(|| {
        MarkdownFileError::InvalidPath(
            "draft has no YAML frontmatter; cannot promote".into(),
        )
    })?;

    let mut map: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(raw_fm)
        .map_err(|e| MarkdownFileError::InvalidPath(format!("yaml parse failed: {e}")))?;

    // Extract the proposed destination — required to promote.
    let dest_key = serde_yaml_ng::Value::String("proposed_destination".into());
    let dest_value = map.remove(&dest_key).ok_or_else(|| {
        MarkdownFileError::InvalidPath(
            "draft has no `proposed_destination` field; cannot promote".into(),
        )
    })?;
    let dest_rel = dest_value
        .as_str()
        .ok_or_else(|| {
            MarkdownFileError::InvalidPath(
                "`proposed_destination` must be a string".into(),
            )
        })?
        .to_string();

    // Drop the marker fields. `status` is replaced with `promoted` for
    // an audit trail; `source_run` is kept (it points back at the run
    // that produced this note) but no longer needed as a draft signal.
    let status_key = serde_yaml_ng::Value::String("status".into());
    map.insert(
        status_key,
        serde_yaml_ng::Value::String("promoted".into()),
    );
    // Record what the draft was previously at — useful in commit logs.
    let provenance_key = serde_yaml_ng::Value::String("promoted_from".into());
    map.insert(
        provenance_key,
        serde_yaml_ng::Value::String(draft_path.to_string()),
    );

    // Serialize the new frontmatter and stitch the file back together.
    let new_fm = serde_yaml_ng::to_string(&map)
        .map_err(|e| MarkdownFileError::InvalidPath(format!("yaml serialize failed: {e}")))?;
    let new_content = format!("---\n{}---\n{}", new_fm, body);

    // Resolve and validate the destination. We require it to NOT exist —
    // promotion is never an overwrite; the user must rename/discard if
    // they want a different target.
    let abs_dest = validate_md_path(vault_root, &dest_rel)?;
    if abs_dest.exists() {
        return Err(MarkdownFileError::AlreadyExists(dest_rel));
    }
    if let Some(parent) = abs_dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&abs_dest, &new_content)?;

    // Delete the draft only after the destination was written
    // successfully — if anything above failed, the draft stays intact.
    std::fs::remove_file(&abs_draft)?;

    Ok(dest_rel)
}

/// Delete a draft from the vault. Same path validation as the other
/// markdown_io entry points; rejects writes into forbidden zones so a
/// stray "discard" can't be tricked into deleting a system file.
pub fn discard_draft(
    vault_root: &Path,
    draft_path: &str,
) -> Result<(), MarkdownFileError> {
    let abs = validate_md_path(vault_root, draft_path)?;
    if !abs.is_file() {
        return Err(MarkdownFileError::NotFound(draft_path.to_string()));
    }
    std::fs::remove_file(&abs)?;
    Ok(())
}

/// Split a Markdown document at its YAML frontmatter delimiters.
/// Returns `(yaml_block_contents, body)` if the document starts with a
/// `---` fence and has a closing one; `None` otherwise. The yaml block
/// does NOT include the trailing newline before the closing `---`.
fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let after_open = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    if let Some(idx) = after_open.find("\n---\n") {
        let yaml = &after_open[..idx];
        let body = &after_open[(idx + 5)..];
        return Some((yaml, body));
    }
    if let Some(idx) = after_open.find("\n---\r\n") {
        let yaml = &after_open[..idx];
        let body = &after_open[(idx + 6)..];
        return Some((yaml, body));
    }
    None
}

#[cfg(test)]
mod draft_tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_vault(tag: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("vw-draft-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_draft(vault: &Path, path: &str, fm: &str, body: &str) {
        let abs = vault.join(path);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, format!("---\n{fm}---\n{body}")).unwrap();
    }

    #[test]
    fn promote_moves_file_and_strips_marker_fields() {
        let vault = temp_vault("promote-ok");
        write_draft(
            &vault,
            "01_inbox/_drafts/reentrancy-pattern.md",
            "title: Reentrancy in wcKeyCrops\nstatus: draft-from-agent\nproposed_destination: 03_areas/patterns/reentrancy/wcKeyCrops.md\nsource_run: run-abc-123\nproject: subgraph\n",
            "# Reentrancy\n\nThe pattern observed was…\n",
        );

        let dest = promote_draft(&vault, "01_inbox/_drafts/reentrancy-pattern.md")
            .expect("promote");
        assert_eq!(dest, "03_areas/patterns/reentrancy/wcKeyCrops.md");

        // Original draft is gone.
        assert!(!vault
            .join("01_inbox/_drafts/reentrancy-pattern.md")
            .exists());

        // Destination has the body and stripped/rewritten frontmatter.
        let promoted = std::fs::read_to_string(
            vault.join("03_areas/patterns/reentrancy/wcKeyCrops.md"),
        )
        .unwrap();
        assert!(promoted.contains("# Reentrancy"));
        assert!(!promoted.contains("proposed_destination"));
        assert!(promoted.contains("status: promoted"));
        assert!(promoted.contains("promoted_from: 01_inbox/_drafts/reentrancy-pattern.md"));
        // Non-marker fields are preserved.
        assert!(promoted.contains("project: subgraph"));
        assert!(promoted.contains("source_run: run-abc-123"));

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn promote_refuses_to_overwrite_existing_destination() {
        let vault = temp_vault("promote-collision");
        write_draft(
            &vault,
            "01_inbox/_drafts/x.md",
            "status: draft-from-agent\nproposed_destination: 03_areas/patterns/x.md\n",
            "draft body",
        );
        write_draft(
            &vault,
            "03_areas/patterns/x.md",
            "title: existing\n",
            "existing body",
        );

        let err = promote_draft(&vault, "01_inbox/_drafts/x.md")
            .expect_err("must reject overwrite");
        assert!(matches!(err, MarkdownFileError::AlreadyExists(_)));

        // Draft survives — promotion was atomic-failed.
        assert!(vault.join("01_inbox/_drafts/x.md").exists());
        // Existing destination untouched.
        let existing = std::fs::read_to_string(vault.join("03_areas/patterns/x.md"))
            .unwrap();
        assert!(existing.contains("existing body"));

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn promote_errors_when_destination_is_missing() {
        let vault = temp_vault("promote-no-dest");
        write_draft(
            &vault,
            "01_inbox/_drafts/no-dest.md",
            "status: draft-from-agent\n",
            "body",
        );
        let err = promote_draft(&vault, "01_inbox/_drafts/no-dest.md")
            .expect_err("must reject");
        assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
        // Draft survives.
        assert!(vault.join("01_inbox/_drafts/no-dest.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn discard_deletes_the_draft() {
        let vault = temp_vault("discard");
        write_draft(
            &vault,
            "01_inbox/_drafts/y.md",
            "status: draft-from-agent\nproposed_destination: 03_areas/y.md\n",
            "body",
        );
        discard_draft(&vault, "01_inbox/_drafts/y.md").expect("discard");
        assert!(!vault.join("01_inbox/_drafts/y.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn discard_refuses_forbidden_paths() {
        let vault = temp_vault("discard-forbidden");
        // Even an existing file under a forbidden subtree must be
        // rejected by path validation.
        std::fs::create_dir_all(vault.join(".git")).unwrap();
        std::fs::write(vault.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        let err = discard_draft(&vault, ".git/HEAD").expect_err("must reject");
        assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
        // .git/HEAD survives.
        assert!(vault.join(".git/HEAD").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
