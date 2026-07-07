//! Rule-based recommendations surfaced in the IDE.
//!
//! Looks at the current `ScanResult` plus per-project repo inspections and
//! emits a list of [`Recommendation`]s the IDE displays in two places:
//!
//! - a global bell in the Dashboard header (count + popover across projects)
//! - an inline section at the top of each `ProjectDetail` (project-scoped)
//!
//! Each recommendation has a stable [`Recommendation::id`] so dismissals
//! can be persisted across rescans without re-firing.
//!
//! ## Rules in this slice
//!
//! 1. **Missing canonical files** — `domain.md`, `architecture.md`,
//!    `security/threat-model.md`, `security/review-focus.md`, `decisions/`
//! 2. **KB stale** — repo committed in last 7 days but newest journal entry
//!    is > 3 days older than the newest commit
//! 3. **Stub `_index.md`** — file < 30 lines or all-TODO
//! 4. **No `local_path`** — project frontmatter doesn't link a repo
//! 5. **Repo dirty** — working tree has uncommitted changes (info-level)
//! 6. **Drafts piling** — `> 5` for one project; `> 15` globally
//! 7. **Stale `_index.md` `updated:`** — declared date > 30 days behind
//!    newest commit
//!
//! All rules are pure functions over the inputs — no IO except for two
//! places that need it (journal mtime, `_index.md` line count). Those
//! take a `vault_root` so the compute is still deterministic given the
//! same on-disk state.

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::source_repo::SourceRepoInspection;
use crate::types::{Project, ScanResult};

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Info,
    Suggest,
    Warn,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    Bootstrap,
    KbStale,
    Curation,
    Configuration,
    RepoState,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    /// Stable id (project_slug + ":" + rule_id, or "vault:" + rule_id for
    /// vault-scoped recs). Used for dismissal persistence.
    pub id: String,
    pub severity: Severity,
    pub category: Category,
    /// One-line user-visible title.
    pub title: String,
    /// Optional expanded explanation — shown in popover detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Project this recommendation applies to. `None` for vault-scoped
    /// (e.g. global drafts piling).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    /// If the recommendation has a specific skill / artifact to run.
    /// The frontend offers a "Run" button when set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_skill: Option<String>,
    /// If the recommendation has a specific file to open. The frontend
    /// offers an "Open" button when set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_file: Option<String>,
}

const SECONDS_PER_DAY: i64 = 86_400;
const KB_STALE_GAP_DAYS: i64 = 3;
const KB_STALE_REPO_WINDOW_DAYS: i64 = 7;
const STALE_INDEX_DAYS: i64 = 30;
const STUB_INDEX_MAX_LINES: usize = 30;
const DRAFTS_PROJECT_THRESHOLD: usize = 5;
const DRAFTS_GLOBAL_THRESHOLD: usize = 15;

/// Entry point. Walks all projects in `scan`, applies every rule, and
/// returns the (unsorted, undeduplicated) recommendation list. The
/// frontend sorts and filters dismissed entries client-side.
pub fn compute_recommendations(
    vault_root: &Path,
    scan: &ScanResult,
    repo_states: &HashMap<String, SourceRepoInspection>,
) -> Vec<Recommendation> {
    let mut out = Vec::new();

    // Project-scoped rules.
    for project in &scan.projects {
        let repo = repo_states.get(&project.slug);
        rule_missing_canonical_files(scan, project, &mut out);
        rule_stub_index(vault_root, project, &mut out);
        rule_no_local_path(project, &mut out);
        if let Some(r) = repo {
            rule_kb_stale(vault_root, project, r, &mut out);
            rule_repo_dirty(project, r, &mut out);
            rule_stale_updated(scan, project, r, &mut out);
        }
        rule_drafts_piling_project(scan, project, &mut out);
    }

    // Vault-scoped rules.
    rule_drafts_piling_global(scan, &mut out);

    out
}

// ---------- Rule 1: missing canonical files ----------

fn rule_missing_canonical_files(
    scan: &ScanResult,
    project: &Project,
    out: &mut Vec<Recommendation>,
) {
    let canonical: &[(&str, &str, &str, &str)] = &[
        (
            "domain",
            "domain.md",
            "No domain glossary yet",
            "Capture domain terms before they drift. Try the `domain` skill.",
        ),
        (
            "architecture",
            "architecture.md",
            "No architecture note yet",
            "Run the `architecture` skill to capture high-level structure.",
        ),
        (
            "threat-model",
            "security/threat-model.md",
            "No threat model yet",
            "Run the `threat-model` skill to bootstrap security context.",
        ),
        (
            "review-focus",
            "security/review-focus.md",
            "No security review focus",
            "Capture what to check during reviews; run the `security-review` skill.",
        ),
    ];

    for (rule_id, suffix, title, detail) in canonical {
        let abs_rel = format!("{}/{}", project.path, suffix);
        let present = scan.markdown_files.iter().any(|f| f.path == abs_rel);
        if present {
            continue;
        }
        out.push(Recommendation {
            id: format!("{}:bootstrap:{}", project.slug, rule_id),
            severity: Severity::Suggest,
            category: Category::Bootstrap,
            title: (*title).to_string(),
            detail: Some((*detail).to_string()),
            project_slug: Some(project.slug.clone()),
            suggested_skill: Some((*rule_id).to_string()),
            suggested_file: None,
        });
    }

    // Decisions folder is structural — check for any file under
    // `02_projects/<slug>/decisions/`, including ADRs.
    let decisions_prefix = format!("{}/decisions/", project.path);
    let has_decisions = scan
        .markdown_files
        .iter()
        .any(|f| f.path.starts_with(&decisions_prefix));
    if !has_decisions {
        out.push(Recommendation {
            id: format!("{}:bootstrap:decisions", project.slug),
            severity: Severity::Info,
            category: Category::Bootstrap,
            title: "No ADRs recorded yet".into(),
            detail: Some(
                "Capture decisions as they happen — even one ADR is more useful than zero.".into(),
            ),
            project_slug: Some(project.slug.clone()),
            suggested_skill: None,
            suggested_file: None,
        });
    }
}

// ---------- Rule 2: KB stale (repo edited without recent journal) ----------

fn rule_kb_stale(
    vault_root: &Path,
    project: &Project,
    repo: &SourceRepoInspection,
    out: &mut Vec<Recommendation>,
) {
    let Some(last_commit) = repo.last_commit_unix_secs else {
        return;
    };
    let now = now_unix_secs();
    // Only fire if the repo has moved recently — old projects shouldn't
    // nag forever just because they're old.
    if now - last_commit > KB_STALE_REPO_WINDOW_DAYS * SECONDS_PER_DAY {
        return;
    }
    let journal_dir = vault_root.join(&project.path).join("journal");
    let newest_journal = newest_mtime_in_dir(&journal_dir);

    let needs_journal = match newest_journal {
        Some(j) => last_commit - j > KB_STALE_GAP_DAYS * SECONDS_PER_DAY,
        None => true,
    };
    if !needs_journal {
        return;
    }

    let gap = match newest_journal {
        Some(j) => format!("{} day(s)", (last_commit - j) / SECONDS_PER_DAY),
        None => "ever".to_string(),
    };

    out.push(Recommendation {
        id: format!("{}:kb-stale", project.slug),
        severity: Severity::Suggest,
        category: Category::KbStale,
        title: "Repo moved since last journal".into(),
        detail: Some(format!(
            "Last commit is {gap} newer than last journal entry. Run `session-reflect` to capture what changed."
        )),
        project_slug: Some(project.slug.clone()),
        suggested_skill: Some("session-reflect".into()),
        suggested_file: None,
    });
}

// ---------- Rule 3: stub _index.md ----------

fn rule_stub_index(vault_root: &Path, project: &Project, out: &mut Vec<Recommendation>) {
    let path = vault_root.join(&project.index_file);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    if is_stub(&content) {
        out.push(Recommendation {
            id: format!("{}:stub-index", project.slug),
            severity: Severity::Warn,
            category: Category::Configuration,
            title: "Project _index.md is a stub".into(),
            detail: Some(
                "Less than 30 lines or all-TODO. Flesh it out before relying on this project's KB."
                    .into(),
            ),
            project_slug: Some(project.slug.clone()),
            suggested_skill: None,
            suggested_file: Some(project.index_file.clone()),
        });
    }
}

fn is_stub(content: &str) -> bool {
    // Strip frontmatter for the line/TODO heuristic — a 25-line file
    // that's 20 lines of YAML and 5 lines of body is still a stub.
    let body = strip_frontmatter(content);
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() < STUB_INDEX_MAX_LINES {
        return true;
    }
    // First 20 content lines (skipping blank) — if half or more contain
    // "TODO" or "stub" markers, treat as stub.
    let head: Vec<&str> = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .take(20)
        .copied()
        .collect();
    if head.is_empty() {
        return true;
    }
    let todo_lines = head
        .iter()
        .filter(|l| {
            let lower = l.to_lowercase();
            lower.contains("todo") || lower.contains("stub") || lower.contains("fill in")
        })
        .count();
    todo_lines * 2 >= head.len()
}

fn strip_frontmatter(content: &str) -> &str {
    let after_open = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"));
    let Some(after) = after_open else {
        return content;
    };
    if let Some(idx) = after.find("\n---\n") {
        return &after[(idx + 5)..];
    }
    if let Some(idx) = after.find("\n---\r\n") {
        return &after[(idx + 6)..];
    }
    content
}

// ---------- Rule 4: no local_path ----------

fn rule_no_local_path(project: &Project, out: &mut Vec<Recommendation>) {
    if project.local_path.is_some() {
        return;
    }
    out.push(Recommendation {
        id: format!("{}:no-local-path", project.slug),
        severity: Severity::Info,
        category: Category::Configuration,
        title: "No repo path linked".into(),
        detail: Some(
            "Declare `local_path:` in the project's `_index.md` (or a per-machine `_local.md` overlay) to enable git integration and let the agent see your source code."
                .into(),
        ),
        project_slug: Some(project.slug.clone()),
        suggested_skill: None,
        suggested_file: Some(project.index_file.clone()),
    });
}

// ---------- Rule 5: repo dirty (info) ----------

fn rule_repo_dirty(project: &Project, repo: &SourceRepoInspection, out: &mut Vec<Recommendation>) {
    if repo.dirty != Some(true) {
        return;
    }
    out.push(Recommendation {
        id: format!("{}:repo-dirty", project.slug),
        severity: Severity::Info,
        category: Category::RepoState,
        title: "Working tree has uncommitted changes".into(),
        detail: Some(
            "The repo at `local_path` has dirty state. Review before the next agent run so changes aren't accidentally mixed."
                .into(),
        ),
        project_slug: Some(project.slug.clone()),
        suggested_skill: None,
        suggested_file: None,
    });
}

// ---------- Rule 6: drafts piling up ----------

fn rule_drafts_piling_project(scan: &ScanResult, project: &Project, out: &mut Vec<Recommendation>) {
    let count = scan
        .drafts
        .iter()
        .filter(|d| d.project.as_deref() == Some(project.slug.as_str()))
        .count();
    if count <= DRAFTS_PROJECT_THRESHOLD {
        return;
    }
    out.push(Recommendation {
        id: format!("{}:drafts-piling", project.slug),
        severity: Severity::Suggest,
        category: Category::Curation,
        title: format!("{count} unpromoted drafts for this project"),
        detail: Some(
            "Open the Drafts tab to promote what's worth keeping and discard the rest.".into(),
        ),
        project_slug: Some(project.slug.clone()),
        suggested_skill: None,
        suggested_file: None,
    });
}

fn rule_drafts_piling_global(scan: &ScanResult, out: &mut Vec<Recommendation>) {
    let total = scan.drafts.len();
    if total <= DRAFTS_GLOBAL_THRESHOLD {
        return;
    }
    out.push(Recommendation {
        id: "vault:drafts-global".into(),
        severity: Severity::Suggest,
        category: Category::Curation,
        title: format!("{total} drafts pending review across the vault"),
        detail: Some(
            "Curating drafts in batches keeps the knowledge graph clean. Open the Drafts tab."
                .into(),
        ),
        project_slug: None,
        suggested_skill: None,
        suggested_file: None,
    });
}

// ---------- Rule 7: stale _index.md updated date ----------

fn rule_stale_updated(
    scan: &ScanResult,
    project: &Project,
    repo: &SourceRepoInspection,
    out: &mut Vec<Recommendation>,
) {
    let Some(last_commit) = repo.last_commit_unix_secs else {
        return;
    };

    // Find `_index.md` in markdown_files to read its frontmatter
    // `updated` date. We don't keep parsed frontmatter on MarkdownFile, so
    // we re-read the file from disk — minor cost, single file.
    let updated_secs = read_frontmatter_updated_unix(scan, project);
    let Some(updated_secs) = updated_secs else {
        return;
    };

    if last_commit - updated_secs <= STALE_INDEX_DAYS * SECONDS_PER_DAY {
        return;
    }
    let days = (last_commit - updated_secs) / SECONDS_PER_DAY;
    out.push(Recommendation {
        id: format!("{}:stale-index", project.slug),
        severity: Severity::Suggest,
        category: Category::KbStale,
        title: format!("_index.md last updated {days} days behind repo"),
        detail: Some(
            "The project overview is older than the code it describes. Consider refreshing the high-level summary."
                .into(),
        ),
        project_slug: Some(project.slug.clone()),
        suggested_skill: None,
        suggested_file: Some(project.index_file.clone()),
    });
}

fn read_frontmatter_updated_unix(scan: &ScanResult, project: &Project) -> Option<i64> {
    let path = Path::new(&scan.vault_root).join(&project.index_file);
    let content = std::fs::read_to_string(&path).ok()?;
    let after_open = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let end = after_open
        .find("\n---\n")
        .or_else(|| after_open.find("\n---\r\n"))?;
    let yaml = &after_open[..end];
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).ok()?;
    let mapping = value.as_mapping()?;
    let updated = mapping
        .get(serde_yaml_ng::Value::String("updated".into()))?
        .as_str()?;
    parse_iso_date_to_unix(updated)
}

/// Parse `YYYY-MM-DD` to a unix timestamp at 00:00 UTC. Returns `None`
/// for anything that doesn't look like a calendar date.
fn parse_iso_date_to_unix(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 10 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    days_from_civil(y, m, d).map(|d| d * SECONDS_PER_DAY)
}

/// Howard Hinnant's `days_from_civil` — proleptic Gregorian, returns
/// signed days since `1970-01-01`. Same math as in `util.rs` going the
/// other direction.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

// ---------- helpers ----------

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn newest_mtime_in_dir(dir: &Path) -> Option<i64> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<i64> = None;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if !meta.is_file() {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
                if let Ok(d) = mtime.duration_since(UNIX_EPOCH) {
                    let secs = d.as_secs() as i64;
                    newest = Some(newest.map_or(secs, |cur| cur.max(secs)));
                }
            }
        }
    }
    newest
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Draft, MarkdownFile, Project, ScanResult};

    fn empty_scan() -> ScanResult {
        ScanResult {
            vault_root: "/tmp/empty-vault".into(),
            home_dir: None,
            has_meta: true,
            has_agents_md: true,
            has_about_me: true,
            has_meta_readme: true,
            has_git: true,
            has_vault_config: true,
            vault_format_version: Some("1".into()),
            vault_format_supported: true,
            markdown_files: Vec::new(),
            artifacts: Vec::new(),
            projects: Vec::new(),
            drafts: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn project(slug: &str, local_path: Option<&str>) -> Project {
        Project {
            slug: slug.into(),
            path: format!("02_projects/{slug}"),
            index_file: format!("02_projects/{slug}/_index.md"),
            repo: None,
            local_path: local_path.map(String::from),
            status: None,
            my_role: None,
            default_base_branch: None,
        }
    }

    fn repo_with(last_commit: Option<i64>, dirty: Option<bool>) -> SourceRepoInspection {
        SourceRepoInspection {
            local_path: "/tmp/repo".into(),
            exists: true,
            is_git_repo: true,
            branch: Some("main".into()),
            dirty,
            short_commit: Some("abc1234".into()),
            last_commit_unix_secs: last_commit,
            detected: Vec::new(),
            top_level: Vec::new(),
        }
    }

    fn draft(slug: &str) -> Draft {
        Draft {
            path: format!("01_inbox/_drafts/{slug}.md"),
            title: slug.into(),
            proposed_destination: format!("03_areas/{slug}.md"),
            reason: None,
            source_run: None,
            project: Some("test-project".into()),
            created: None,
        }
    }

    fn md_file(path: &str) -> MarkdownFile {
        MarkdownFile {
            path: path.into(),
            note_type: None,
            project: None,
        }
    }

    #[test]
    fn missing_domain_fires_bootstrap_rec() {
        let mut scan = empty_scan();
        let p = project("x", Some("/tmp/repo"));
        scan.projects.push(p.clone());
        // Architecture, threat-model, review-focus, decisions/ also missing
        // — they all fire. We're checking the domain one specifically.
        let mut out = Vec::new();
        rule_missing_canonical_files(&scan, &p, &mut out);
        assert!(out.iter().any(|r| r.id == "x:bootstrap:domain"));
        assert!(
            out.iter()
                .find(|r| r.id == "x:bootstrap:domain")
                .unwrap()
                .suggested_skill
                .as_deref()
                == Some("domain")
        );
    }

    #[test]
    fn present_canonical_files_suppress_their_recs() {
        let mut scan = empty_scan();
        let p = project("x", Some("/tmp/repo"));
        scan.projects.push(p.clone());
        scan.markdown_files.push(md_file("02_projects/x/domain.md"));
        scan.markdown_files
            .push(md_file("02_projects/x/decisions/0001-init.md"));
        let mut out = Vec::new();
        rule_missing_canonical_files(&scan, &p, &mut out);
        assert!(!out.iter().any(|r| r.id == "x:bootstrap:domain"));
        assert!(!out.iter().any(|r| r.id == "x:bootstrap:decisions"));
        // Others still missing.
        assert!(out.iter().any(|r| r.id == "x:bootstrap:architecture"));
    }

    #[test]
    fn drafts_piling_threshold_per_project() {
        let mut scan = empty_scan();
        let p = project("test-project", None);
        scan.projects.push(p.clone());
        for i in 0..6 {
            scan.drafts.push(draft(&format!("d{i}")));
        }
        let mut out = Vec::new();
        rule_drafts_piling_project(&scan, &p, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].title.contains("6 unpromoted"));
    }

    #[test]
    fn drafts_under_threshold_does_not_fire() {
        let mut scan = empty_scan();
        let p = project("test-project", None);
        for _ in 0..5 {
            scan.drafts.push(draft("d"));
        }
        let mut out = Vec::new();
        rule_drafts_piling_project(&scan, &p, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn no_local_path_fires() {
        let mut out = Vec::new();
        let p = project("x", None);
        rule_no_local_path(&p, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "x:no-local-path");
    }

    #[test]
    fn has_local_path_does_not_fire() {
        let mut out = Vec::new();
        let p = project("x", Some("/tmp/repo"));
        rule_no_local_path(&p, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn dirty_repo_fires_info_rec() {
        let p = project("x", Some("/tmp/repo"));
        let r = repo_with(Some(now_unix_secs()), Some(true));
        let mut out = Vec::new();
        rule_repo_dirty(&p, &r, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::Info);
    }

    #[test]
    fn clean_repo_does_not_fire() {
        let p = project("x", Some("/tmp/repo"));
        let r = repo_with(Some(now_unix_secs()), Some(false));
        let mut out = Vec::new();
        rule_repo_dirty(&p, &r, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn is_stub_short_file() {
        assert!(is_stub("short\nshort\nshort\n"));
    }

    #[test]
    fn is_stub_todo_heavy() {
        let content: String = (0..40)
            .map(|i| {
                if i % 2 == 0 {
                    "Real content here.\n"
                } else {
                    "TODO: fill in.\n"
                }
            })
            .collect();
        assert!(is_stub(&content));
    }

    #[test]
    fn is_stub_real_content() {
        let mut content = String::new();
        for _ in 0..40 {
            content.push_str("This is a real sentence with real content.\n");
        }
        assert!(!is_stub(&content));
    }

    #[test]
    fn parse_iso_date_roundtrips_today() {
        let unix = parse_iso_date_to_unix("2026-05-19");
        assert!(unix.is_some());
        // Sanity bound: 2026-05-19 is between 1.7B and 1.8B in seconds.
        let v = unix.unwrap();
        assert!(v > 1_700_000_000);
        assert!(v < 1_900_000_000);
    }

    #[test]
    fn parse_iso_date_rejects_garbage() {
        assert!(parse_iso_date_to_unix("not-a-date").is_none());
        assert!(parse_iso_date_to_unix("2026/05/19").is_none());
        assert!(parse_iso_date_to_unix("").is_none());
    }
}
