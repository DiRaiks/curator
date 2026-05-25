//! First-run bootstrap — creates a vault skeleton and the first project.
//!
//! Two operations exposed to the Tauri shell:
//!
//! - [`init_vault`] turns a plain folder into a vault: writes
//!   `.vault/config.yml`, the canonical zone directories, and a seed
//!   `00_meta/AGENTS.md`. Refuses to overwrite an already-initialised
//!   vault (presence of `.vault/config.yml` is the signal).
//! - [`init_project`] writes `02_projects/<slug>/_index.md` from a
//!   template substituting the user's inputs. Refuses to overwrite an
//!   existing project.
//!
//! Both reuse the runner's workdir deny-list (no system dirs, no
//! `~/.ssh`, etc.) so the IDE can't be tricked into seeding a vault on
//! top of sensitive locations.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::runner::validate_workdir;
use crate::util::format_today_utc;

// Embedded templates. `include_str!` resolves at compile time relative
// to this file so the resulting binary is self-contained — no runtime
// filesystem lookup, no missing-template-file failure mode.
const CONFIG_YML: &str = include_str!("templates/config.yml");
const AGENTS_MD: &str = include_str!("templates/AGENTS.md");
const PROJECT_INDEX_TEMPLATE: &str = include_str!("templates/project_index.md");

/// Canonical top-level zones a fresh vault gets. Ordering matters only
/// for diagnostics — the FS doesn't care, but the user sees the tree
/// sorted lexicographically which already matches this list.
const VAULT_ZONES: &[&str] = &[
    "00_meta",
    "01_inbox/_drafts",
    "02_projects",
    "03_areas",
    "04_resources",
    "05_archive",
    "06_daily",
];

#[derive(Debug, Error)]
pub enum BootstrapError {
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("already initialised: {0}")]
    AlreadyInitialised(String),
    #[error("project already exists: {0}")]
    ProjectExists(String),
    #[error("invalid slug: {0}")]
    InvalidSlug(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Seed the given folder as a vault.
///
/// Refuses if `.vault/config.yml` already exists (so a second click can't
/// silently overwrite user content). Path is canonicalised + screened
/// against the runner's deny-list — the IDE will not init a vault into
/// `~/.ssh`, system dirs, or other locations flagged as unsafe.
///
/// On success, every directory in [`VAULT_ZONES`] is created (idempotent
/// via `create_dir_all`), `.vault/config.yml` is written, and
/// `00_meta/AGENTS.md` is created if missing. The caller is expected to
/// re-scan after — the function returns no value because everything the
/// UI needs is rediscovered by `scan_vault`.
pub fn init_vault(path: &Path) -> Result<(), BootstrapError> {
    let canonical = validate_workdir(path).map_err(BootstrapError::InvalidPath)?;
    let config_path = canonical.join(".vault").join("config.yml");
    if config_path.exists() {
        return Err(BootstrapError::AlreadyInitialised(
            canonical.to_string_lossy().to_string(),
        ));
    }

    std::fs::create_dir_all(canonical.join(".vault"))?;
    std::fs::write(&config_path, CONFIG_YML)?;

    for zone in VAULT_ZONES {
        std::fs::create_dir_all(canonical.join(zone))?;
    }

    let agents_path = canonical.join("00_meta").join("AGENTS.md");
    if !agents_path.exists() {
        std::fs::write(&agents_path, AGENTS_MD)?;
    }

    Ok(())
}

/// Slug + form fields for the very first project an empty vault gets.
/// Optional fields stay `None` when the user leaves them blank; the
/// template emits the corresponding frontmatter keys only when a value
/// is present so omitted fields don't render as bare `key:` lines.
#[derive(Debug, Clone)]
pub struct InitProjectArgs<'a> {
    pub slug: &'a str,
    pub my_role: &'a str,
    pub repo: Option<&'a str>,
    pub local_path: Option<&'a str>,
}

/// Create `02_projects/<slug>/_index.md` from the template.
///
/// Returns the new path (relative to vault root, forward-slash form) so
/// the frontend can open it in the editor immediately. Refuses if the
/// project directory already contains an `_index.md`.
///
/// Validation:
/// - Slug must be kebab-case (lowercase letters, digits, dashes) and
///   contain no path separators or leading dots — rejects attempts to
///   escape `02_projects/` via `..` or absolute paths.
/// - `local_path`, when present, is canonicalised and screened against
///   the same runner deny-list (so a project can't point at `~/.ssh`).
pub fn init_project(
    vault_root: &Path,
    args: &InitProjectArgs<'_>,
) -> Result<String, BootstrapError> {
    let vault_root = validate_workdir(vault_root).map_err(BootstrapError::InvalidPath)?;

    validate_slug(args.slug)?;

    if let Some(lp) = args.local_path.filter(|s| !s.trim().is_empty()) {
        // Best-effort: a not-yet-created path can't be canonicalised
        // (validate_workdir would fail). Only deny-list-check when the
        // user pointed at something that already exists.
        let pb = PathBuf::from(lp);
        if pb.exists() {
            validate_workdir(&pb).map_err(BootstrapError::InvalidPath)?;
        }
    }

    let rel = format!("02_projects/{}/_index.md", args.slug);
    let abs = vault_root.join(&rel);
    if abs.exists() {
        return Err(BootstrapError::ProjectExists(rel));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let content = render_project_template(args);
    std::fs::write(&abs, content)?;
    Ok(rel)
}

fn validate_slug(slug: &str) -> Result<(), BootstrapError> {
    if slug.is_empty() {
        return Err(BootstrapError::InvalidSlug("slug is empty".into()));
    }
    if slug.starts_with('.') {
        return Err(BootstrapError::InvalidSlug(
            "slug must not start with a dot".into(),
        ));
    }
    for ch in slug.chars() {
        let ok = ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-';
        if !ok {
            return Err(BootstrapError::InvalidSlug(format!(
                "slug must be kebab-case (lowercase letters, digits, dashes); got `{slug}`"
            )));
        }
    }
    // Reject leading/trailing dashes for hygiene — they parse fine but
    // confuse the eye and look like a typo.
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err(BootstrapError::InvalidSlug(
            "slug must not start or end with a dash".into(),
        ));
    }
    Ok(())
}

/// Fill the project _index.md template. Optional fields are emitted as
/// frontmatter lines only when present so the resulting YAML doesn't
/// carry bare `repo:` keys with empty values.
fn render_project_template(args: &InitProjectArgs<'_>) -> String {
    let date = format_today_utc();
    let repo_block = match args.repo.filter(|s| !s.trim().is_empty()) {
        Some(v) => format!("repo: {}\n", v),
        None => String::new(),
    };
    let local_path_block = match args.local_path.filter(|s| !s.trim().is_empty()) {
        Some(v) => format!("local_path: {}\n", v),
        None => String::new(),
    };
    PROJECT_INDEX_TEMPLATE
        .replace("%{slug}", args.slug)
        .replace("%{my_role}", args.my_role)
        .replace("%{repo_block}", &repo_block)
        .replace("%{local_path_block}", &local_path_block)
        .replace("%{date}", &date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn init_vault_creates_skeleton() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("init_vault");

        // Config exists with the right version line.
        let config = std::fs::read_to_string(dir.path().join(".vault/config.yml"))
            .expect("config.yml written");
        assert!(config.contains("version: \"1\""));

        // All canonical zones exist.
        for zone in VAULT_ZONES {
            assert!(
                dir.path().join(zone).is_dir(),
                "expected zone dir {zone} to exist"
            );
        }

        // Seed AGENTS.md is present.
        assert!(dir.path().join("00_meta/AGENTS.md").is_file());
    }

    #[test]
    fn init_vault_refuses_already_initialised() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("first init");
        let err = init_vault(dir.path()).expect_err("second init should fail");
        assert!(matches!(err, BootstrapError::AlreadyInitialised(_)));
    }

    #[test]
    fn init_vault_preserves_existing_agents_md() {
        let dir = tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("00_meta")).unwrap();
        std::fs::write(dir.path().join("00_meta/AGENTS.md"), "PRE-EXISTING").unwrap();

        init_vault(dir.path()).expect("init_vault");

        let content = std::fs::read_to_string(dir.path().join("00_meta/AGENTS.md")).unwrap();
        assert_eq!(
            content, "PRE-EXISTING",
            "must not overwrite existing AGENTS.md"
        );
    }

    #[test]
    fn init_project_writes_index_md() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("init_vault");

        let rel = init_project(
            dir.path(),
            &InitProjectArgs {
                slug: "my-first-project",
                my_role: "owner",
                repo: Some("https://github.com/me/repo"),
                local_path: None,
            },
        )
        .expect("init_project");

        assert_eq!(rel, "02_projects/my-first-project/_index.md");
        let content = std::fs::read_to_string(dir.path().join(&rel)).expect("file written");
        assert!(content.contains("project: my-first-project"));
        assert!(content.contains("my_role: owner"));
        assert!(content.contains("repo: https://github.com/me/repo"));
        // local_path was None — must not emit a bare key.
        assert!(!content.contains("local_path:"));
        // Template's body section still appears.
        assert!(content.contains("# my-first-project"));
    }

    #[test]
    fn init_project_omits_missing_optional_blocks() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("init_vault");

        init_project(
            dir.path(),
            &InitProjectArgs {
                slug: "minimal",
                my_role: "reviewer",
                repo: None,
                local_path: Some("   "),
            },
        )
        .expect("init_project");

        let content = std::fs::read_to_string(dir.path().join("02_projects/minimal/_index.md"))
            .expect("file written");
        assert!(!content.contains("repo:"));
        // Whitespace-only local_path is treated as absent.
        assert!(!content.contains("local_path:"));
    }

    #[test]
    fn init_project_refuses_existing_index() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("init_vault");
        let args = InitProjectArgs {
            slug: "dup",
            my_role: "owner",
            repo: None,
            local_path: None,
        };
        init_project(dir.path(), &args).expect("first create");
        let err = init_project(dir.path(), &args).expect_err("second create should fail");
        assert!(matches!(err, BootstrapError::ProjectExists(_)));
    }

    #[test]
    fn init_project_rejects_path_separators_in_slug() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("init_vault");
        for bad in &[
            "../escape",
            "with/slash",
            "with\\slash",
            ".hidden",
            "UPPER",
            "with space",
        ] {
            let err = init_project(
                dir.path(),
                &InitProjectArgs {
                    slug: bad,
                    my_role: "owner",
                    repo: None,
                    local_path: None,
                },
            )
            .err()
            .unwrap_or_else(|| panic!("expected error for slug `{bad}`"));
            assert!(
                matches!(err, BootstrapError::InvalidSlug(_)),
                "slug `{bad}` should be rejected as invalid; got {err:?}"
            );
        }
    }

    #[test]
    fn init_project_rejects_local_path_in_sensitive_dir() {
        let dir = tempdir().expect("tempdir");
        init_vault(dir.path()).expect("init_vault");

        // /etc exists on every unix system and is in the deny-list.
        let err = init_project(
            dir.path(),
            &InitProjectArgs {
                slug: "sensitive",
                my_role: "owner",
                repo: None,
                local_path: Some("/etc"),
            },
        )
        .expect_err("expected sensitive local_path to be rejected");
        assert!(matches!(err, BootstrapError::InvalidPath(_)));
    }
}
