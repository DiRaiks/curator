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
