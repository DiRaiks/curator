//! Vault config (`.vault/config.yml`) parsing and format-version policy.
//!
//! The vault format has a single declared **major version**. Bump
//! [`VAULT_FORMAT_VERSION_MAJOR`] on breaking changes to the on-disk format —
//! zone conventions, frontmatter contract, artifact discovery rules. Minor
//! and patch revisions are not versioned at this layer; they must stay
//! forward-compatible by definition.
//!
//! `.vault/config.yml` schema (all fields optional, unknown fields ignored):
//!
//! ```yaml
//! version: "1"   # vault format major version; string for forward-compat
//! ```
//!
//! A missing file, missing `version:` field, or unparseable version is
//! reported as a warning diagnostic by `scan_vault`; it never aborts the
//! scan.

use std::path::Path;

use serde::Deserialize;

/// The vault format major version this build of vault-core supports. Bump on
/// breaking on-disk format changes. Vaults declaring a higher major are
/// flagged as "may not be read correctly".
pub const VAULT_FORMAT_VERSION_MAJOR: u32 = 1;

/// Subset of `.vault/config.yml` we read today. `#[serde(default)]` +
/// `deny_unknown_fields = false` (the default) means future additions don't
/// break older builds.
#[derive(Debug, Default, Deserialize)]
struct RawVaultConfig {
    #[serde(default)]
    version: Option<String>,
}

/// Result of probing `.vault/config.yml`.
#[derive(Debug, Default)]
pub(crate) struct VaultConfigInfo {
    /// Whether `.vault/config.yml` exists as a file.
    pub exists: bool,
    /// `version:` field exactly as declared in the YAML, if present.
    pub raw_version: Option<String>,
    /// Major version parsed from `raw_version` (first dot-separated segment
    /// parsed as `u32`). `None` when missing or non-numeric.
    pub declared_major: Option<u32>,
}

/// Read and parse `.vault/config.yml` under the given vault root. Never
/// returns an error: parsing failures and IO failures collapse to a default
/// `VaultConfigInfo` carrying `exists` truthfully. The caller decides what
/// diagnostic to emit.
pub(crate) fn read_vault_config(vault_root: &Path) -> VaultConfigInfo {
    let path = vault_root.join(".vault").join("config.yml");
    if !path.is_file() {
        return VaultConfigInfo::default();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            return VaultConfigInfo {
                exists: true,
                ..Default::default()
            };
        }
    };
    let cfg: RawVaultConfig = serde_yaml_ng::from_str(&content).unwrap_or_default();
    let declared_major = cfg.version.as_deref().and_then(parse_major);
    VaultConfigInfo {
        exists: true,
        raw_version: cfg.version,
        declared_major,
    }
}

fn parse_major(s: &str) -> Option<u32> {
    s.trim().split('.').next()?.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("vw-config-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(dir.join(".vault")).unwrap();
        dir
    }

    fn write_config(root: &Path, content: &str) {
        std::fs::write(root.join(".vault").join("config.yml"), content).unwrap();
    }

    #[test]
    fn missing_file_reports_not_exists() {
        let dir = temp_vault("missing");
        let info = read_vault_config(&dir);
        assert!(!info.exists);
        assert!(info.raw_version.is_none());
        assert!(info.declared_major.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_yaml_exists_without_version() {
        let dir = temp_vault("empty");
        write_config(&dir, "# no version yet\n");
        let info = read_vault_config(&dir);
        assert!(info.exists);
        assert!(info.raw_version.is_none());
        assert!(info.declared_major.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_one_dot_zero_parses_to_major_one() {
        let dir = temp_vault("v1.0");
        write_config(&dir, "version: \"1.0\"\n");
        let info = read_vault_config(&dir);
        assert!(info.exists);
        assert_eq!(info.raw_version.as_deref(), Some("1.0"));
        assert_eq!(info.declared_major, Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bare_integer_version_parses() {
        let dir = temp_vault("v2");
        write_config(&dir, "version: \"2\"\n");
        let info = read_vault_config(&dir);
        assert_eq!(info.declared_major, Some(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_numeric_version_yields_none_major() {
        let dir = temp_vault("vfoo");
        write_config(&dir, "version: \"foo\"\n");
        let info = read_vault_config(&dir);
        assert_eq!(info.raw_version.as_deref(), Some("foo"));
        assert!(info.declared_major.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let dir = temp_vault("unknown");
        write_config(
            &dir,
            "version: \"1\"\nfeeds:\n  - https://example.com/osv\nfuture_field: 42\n",
        );
        let info = read_vault_config(&dir);
        assert_eq!(info.declared_major, Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
