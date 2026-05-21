//! Read-only inspection of a project's source repository.
//!
//! Given a `local_path` (typically the `local_path` field of a project's
//! `_index.md`), report whether it exists, whether it is a git repo, and a
//! shallow snapshot of branch/dirty/commit plus a few well-known files. No
//! fetch, no checkout, no writes — never mutates the working tree.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceRepoInspection {
    /// Absolute path passed in by the caller, returned verbatim so the UI
    /// can mask `~` consistently.
    pub local_path: String,
    pub exists: bool,
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub dirty: Option<bool>,
    pub short_commit: Option<String>,
    /// Unix timestamp (seconds) of the most recent commit on the current
    /// branch — `git log -1 --format=%ct`. `None` when the path is not a
    /// git repo, has no commits yet, or `git` isn't available. Used by
    /// the recommendations engine to detect "repo edited since last KB
    /// entry" without forcing every caller to shell out to git again.
    pub last_commit_unix_secs: Option<i64>,
    /// Subset of [`DETECTED_CANDIDATES`] that actually exists at the repo
    /// root, plus a `README.*` fallback if `README.md` is missing.
    pub detected: Vec<String>,
    /// Shallow listing of repo root (depth 0). Excludes runtime / output
    /// directories and obvious secret files. Capped to keep the UI sane on
    /// monorepos.
    pub top_level: Vec<TopLevelEntry>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TopLevelEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Files / directories we explicitly check for at the repo root. Existence
/// only — we never read contents in this slice.
const DETECTED_CANDIDATES: &[&str] = &[
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
    "Dockerfile",
    "docker-compose.yml",
    "SECURITY.md",
    ".github/workflows",
];

/// Directory / file names that are never shown in the top-level summary.
/// Matches the spirit of the vault scanner's prune list but tuned for source
/// repos (e.g. include `coverage/`).
const REPO_TOPLEVEL_EXCLUDED: &[&str] = &[
    ".git",
    ".obsidian",
    ".DS_Store",
    "__MACOSX",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "coverage",
    "secrets",
];

const MAX_TOPLEVEL: usize = 50;

/// Read-only inspection of a project's `local_path`. Filesystem checks +
/// a small set of well-known git CLI commands (`rev-parse`, `branch`,
/// `status --porcelain`) — no fetch, no checkout, no writes.
pub fn inspect_source_repo(local_path: &Path) -> SourceRepoInspection {
    let local_str = local_path.to_string_lossy().to_string();

    if !local_path.exists() {
        return SourceRepoInspection {
            local_path: local_str,
            exists: false,
            is_git_repo: false,
            branch: None,
            dirty: None,
            short_commit: None,
            last_commit_unix_secs: None,
            detected: Vec::new(),
            top_level: Vec::new(),
        };
    }

    let is_git_repo =
        run_git(local_path, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");

    let (branch, dirty, short_commit, last_commit_unix_secs) = if is_git_repo {
        let branch = run_git(local_path, &["branch", "--show-current"]).filter(|s| !s.is_empty());
        let dirty = run_git(local_path, &["status", "--porcelain"]).map(|s| !s.is_empty());
        let commit =
            run_git(local_path, &["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty());
        // `%ct` = committer date, unix timestamp. Newer than %at (author
        // date) for rebase / cherry-pick scenarios, which is what we want
        // for "when did this branch last move".
        let last_commit = run_git(local_path, &["log", "-1", "--format=%ct"])
            .and_then(|s| s.trim().parse::<i64>().ok());
        (branch, dirty, commit, last_commit)
    } else {
        (None, None, None, None)
    };

    let detected = detect_repo_files(local_path);
    let top_level = read_repo_top_level(local_path);

    SourceRepoInspection {
        local_path: local_str,
        exists: true,
        is_git_repo,
        branch,
        dirty,
        short_commit,
        last_commit_unix_secs,
        detected,
        top_level,
    }
}

/// Run a git command with `current_dir = repo`. Returns stdout trimmed when
/// the command succeeds; `None` when git is unavailable, the command fails,
/// or the directory is not a git repository.
///
/// Arguments are passed individually to `Command`, never through a shell, so
/// they can't be injected via repo metadata.
fn run_git(repo: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detect_repo_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for name in DETECTED_CANDIDATES {
        if root.join(name).exists() {
            out.push((*name).to_string());
        }
    }
    let has_readme_md = out.iter().any(|n| n == "README.md");
    if !has_readme_md {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("README.") && !out.contains(&name) {
                    out.push(name);
                    break;
                }
            }
        }
    }
    out
}

fn read_repo_top_level(root: &Path) -> Vec<TopLevelEntry> {
    let mut entries: Vec<TopLevelEntry> = Vec::new();
    let dir = match std::fs::read_dir(root) {
        Ok(d) => d,
        Err(_) => return entries,
    };
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if REPO_TOPLEVEL_EXCLUDED.contains(&name.as_str()) {
            continue;
        }
        if name.starts_with(".env") || name.starts_with("._") {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(TopLevelEntry { name, is_dir });
        if entries.len() >= MAX_TOPLEVEL {
            break;
        }
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_repo_dir(tag: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("vw-repo-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("create temp repo dir");
        dir
    }

    #[test]
    fn inspect_missing_path_reports_exists_false() {
        let nonexistent = std::env::temp_dir().join("vw-definitely-not-here-xyz");
        let r = inspect_source_repo(&nonexistent);
        assert!(!r.exists);
        assert!(!r.is_git_repo);
        assert!(r.detected.is_empty());
        assert!(r.top_level.is_empty());
    }

    #[test]
    fn inspect_non_git_dir_reports_not_git_repo() {
        let dir = temp_repo_dir("non-git");
        std::fs::write(dir.join("README.md"), "# hello").unwrap();
        let r = inspect_source_repo(&dir);
        assert!(r.exists);
        assert!(!r.is_git_repo);
        assert!(r.branch.is_none());
        assert!(r.dirty.is_none());
        assert!(r.short_commit.is_none());
        assert!(r.detected.contains(&"README.md".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_repo_files_finds_known_candidates() {
        let dir = temp_repo_dir("detected");
        std::fs::write(dir.join("README.md"), "x").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("Dockerfile"), "x").unwrap();
        std::fs::create_dir_all(dir.join(".github/workflows")).unwrap();
        let detected = detect_repo_files(&dir);
        assert!(detected.contains(&"README.md".to_string()));
        assert!(detected.contains(&"package.json".to_string()));
        assert!(detected.contains(&"Dockerfile".to_string()));
        assert!(detected.contains(&".github/workflows".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_repo_files_falls_back_to_readme_variants() {
        let dir = temp_repo_dir("readme-fallback");
        std::fs::write(dir.join("README.rst"), "x").unwrap();
        let detected = detect_repo_files(&dir);
        assert!(detected.iter().any(|n| n == "README.rst"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn top_level_excludes_runtime_dirs_and_dotenv() {
        let dir = temp_repo_dir("toplevel-excluded");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::create_dir_all(dir.join("coverage")).unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::write(dir.join(".env.local"), "x").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();

        let entries = read_repo_top_level(&dir);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"package.json"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"target"));
        assert!(!names.contains(&"coverage"));
        assert!(!names.iter().any(|n| n.starts_with(".env")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn top_level_caps_long_listings() {
        let dir = temp_repo_dir("toplevel-cap");
        for i in 0..(MAX_TOPLEVEL + 25) {
            std::fs::write(dir.join(format!("file-{i:03}.txt")), "x").unwrap();
        }
        let entries = read_repo_top_level(&dir);
        assert_eq!(entries.len(), MAX_TOPLEVEL);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
