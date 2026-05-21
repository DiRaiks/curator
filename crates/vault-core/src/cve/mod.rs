//! CVE / vulnerability scanning for project source repositories.
//!
//! The entry point is [`scan_project_vulnerabilities`]: given a project's
//! `local_path`, it parses any supported lock files, queries OSV.dev for
//! known advisories, and returns a [`ProjectVulnerabilityScan`].
//!
//! Lock file support in this slice:
//! - `yarn.lock` v1 (user's primary Yarn 1 stack)
//! - `package-lock.json` v2/v3 (npm 7+)
//!
//! Out of scope (slice 2+): Yarn Berry (v2/v3), pnpm-lock.yaml,
//! Cargo.lock, Pipfile.lock, Gemfile.lock, go.sum, gradle/maven.

use std::path::Path;

use serde::{Deserialize, Serialize};

mod osv;
mod parsers;

pub use osv::OsvError;

/// A single resolved dependency identified in a lock file.
///
/// `ecosystem` is the OSV.dev ecosystem identifier — `npm` for both
/// yarn.lock and package-lock.json. Future ecosystems (PyPI, RubyGems,
/// crates.io, Go) get added when their parser lands.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct DependencyPackage {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    /// Lock file the package was discovered in, relative to the project's
    /// `local_path`. Used by the UI to attribute each finding back to a
    /// concrete source.
    pub source_lock_file: String,
}

/// A vulnerability advisory affecting a specific package version.
///
/// One OSV vulnerability can affect many packages; the scanner emits one
/// `Advisory` per (package, vuln) pair so the UI can render a flat list
/// without further joining.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    pub package: DependencyPackage,
    /// OSV identifier — typically `GHSA-...` or `CVE-...`.
    pub osv_id: String,
    pub summary: String,
    pub details: Option<String>,
    /// Best-effort severity label. Carries the highest CVSS score we found
    /// across the advisory's severity entries, formatted as
    /// `"CVSS:3.1 7.5"` etc. `None` when OSV provided nothing parseable.
    pub severity: Option<String>,
    /// Versions that fix the issue (range "fixed" events from OSV). Empty
    /// when OSV didn't declare any — usually means no fix yet.
    pub fixed_versions: Vec<String>,
    /// External reference URLs (advisory writeups, commits, etc.).
    pub references: Vec<String>,
}

/// Result of a single project scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVulnerabilityScan {
    /// Lock files that were detected + successfully parsed, relative to
    /// project root.
    pub lock_files_scanned: Vec<String>,
    /// Total unique packages observed across all lock files.
    pub packages_scanned: usize,
    /// All advisories returned by OSV, flat list (one row per affected
    /// package + vuln pair).
    pub advisories: Vec<Advisory>,
    /// Non-fatal issues (parse warnings, OSV network errors). Surfaced to
    /// the UI so the user knows the scan was partial.
    pub warnings: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CveScanError {
    #[error("project path not accessible: {path}: {source}")]
    PathNotAccessible {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("no supported lock files found in {path} — expected yarn.lock or package-lock.json")]
    NoLockFiles { path: String },
    #[error("OSV query failed: {0}")]
    Osv(#[from] OsvError),
}

/// Scan a project's `local_path` for known vulnerabilities.
///
/// Walks the directory non-recursively (lock files live at the root by
/// convention), parses any supported lock files, deduplicates packages
/// across them, and queries OSV.dev for advisories.
///
/// Returns the full scan envelope including warnings — caller should
/// surface those to the user even when `advisories` is empty.
pub fn scan_project_vulnerabilities(
    project_root: &Path,
) -> Result<ProjectVulnerabilityScan, CveScanError> {
    let canon = project_root
        .canonicalize()
        .map_err(|e| CveScanError::PathNotAccessible {
            path: project_root.display().to_string(),
            source: e,
        })?;

    let mut warnings: Vec<String> = Vec::new();
    let mut lock_files: Vec<String> = Vec::new();
    let mut packages: Vec<DependencyPackage> = Vec::new();

    let yarn_lock = canon.join("yarn.lock");
    if yarn_lock.is_file() {
        match std::fs::read_to_string(&yarn_lock) {
            Ok(text) => match parsers::yarn_lock::parse(&text, "yarn.lock") {
                Ok(mut pkgs) => {
                    lock_files.push("yarn.lock".to_string());
                    packages.append(&mut pkgs);
                }
                Err(e) => warnings.push(format!("yarn.lock: {e}")),
            },
            Err(e) => warnings.push(format!("yarn.lock unreadable: {e}")),
        }
    }

    let package_lock = canon.join("package-lock.json");
    if package_lock.is_file() {
        match std::fs::read_to_string(&package_lock) {
            Ok(text) => match parsers::package_lock::parse(&text, "package-lock.json") {
                Ok(mut pkgs) => {
                    lock_files.push("package-lock.json".to_string());
                    packages.append(&mut pkgs);
                }
                Err(e) => warnings.push(format!("package-lock.json: {e}")),
            },
            Err(e) => warnings.push(format!("package-lock.json unreadable: {e}")),
        }
    }

    if lock_files.is_empty() {
        return Err(CveScanError::NoLockFiles {
            path: canon.display().to_string(),
        });
    }

    // Deduplicate by (ecosystem, name, version) — multiple lock files in
    // the same monorepo can name the same package. We keep the first
    // sighting's `source_lock_file` for attribution.
    packages.sort_by(|a, b| {
        (a.ecosystem.as_str(), a.name.as_str(), a.version.as_str()).cmp(&(
            b.ecosystem.as_str(),
            b.name.as_str(),
            b.version.as_str(),
        ))
    });
    packages
        .dedup_by(|a, b| a.ecosystem == b.ecosystem && a.name == b.name && a.version == b.version);

    let packages_scanned = packages.len();

    let advisories = match osv::query_advisories(&packages) {
        Ok(advs) => advs,
        Err(e) => {
            warnings.push(format!("osv query failed: {e}"));
            Vec::new()
        }
    };

    Ok(ProjectVulnerabilityScan {
        lock_files_scanned: lock_files,
        packages_scanned,
        advisories,
        warnings,
    })
}
