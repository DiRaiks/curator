//! Privacy-zone scope classification.
//!
//! Every Markdown file in the vault gets a `Scope` derived from:
//!
//! 1. Explicit `scope:` in frontmatter (highest priority).
//! 2. Path segments matching team/personal/inbox/resource/archive hints.
//! 3. `include_in_ai_context: false` → demoted to `PersonalWork` unless the
//!    path already classifies as team.
//! 4. Fallback: top-level `00_meta` → `Meta`, `02_projects` → `Project`,
//!    otherwise `Unknown`.
//!
//! The scope is purely a privacy/filtering signal — it doesn't change what
//! the user can manually open, only what AI workflows include by default.

use crate::frontmatter::{fm_bool, fm_string};
use crate::types::Scope;

const TEAM_MANAGEMENT_HINTS: &[&str] = &[
    "meetings",
    "1on1",
    "one-on-ones",
    "people",
    "team",
    "management",
];
const PERSONAL_WORK_HINTS: &[&str] = &["daily", "journal", "private", "personal"];
const INBOX_HINTS: &[&str] = &["inbox"];
const RESOURCE_HINTS: &[&str] = &["resources", "resource"];
const ARCHIVE_HINTS: &[&str] = &["archive", "archives"];

pub(crate) fn compute_scope(
    rel: &str,
    fm: Option<&serde_yaml_ng::Mapping>,
) -> (Scope, Option<String>) {
    let (path_scope, zone_root) = compute_path_scope(rel);

    if let Some(m) = fm {
        if let Some(scope_str) = fm_string(m, "scope") {
            if let Some(parsed) = parse_scope_str(&scope_str) {
                return (parsed, zone_root);
            }
        }
        if matches!(fm_bool(m, "include_in_ai_context"), Some(false)) {
            if !matches!(path_scope, Scope::TeamManagement) {
                return (Scope::PersonalWork, zone_root);
            }
        }
    }

    (path_scope, zone_root)
}

fn compute_path_scope(rel: &str) -> (Scope, Option<String>) {
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return (Scope::Unknown, None);
    }
    let dir_segments = &segments[..segments.len().saturating_sub(1)];

    let mut best: Option<(Scope, usize)> = None;
    for (idx, seg) in dir_segments.iter().enumerate() {
        if let Some(scope) = segment_to_scope(seg) {
            let replace = match (&best, &scope) {
                (None, _) => true,
                (Some((b, _)), s) => zone_priority(s) > zone_priority(b),
            };
            if replace {
                best = Some((scope, idx));
            }
        }
    }

    if let Some((scope, idx)) = best {
        let zone_root = dir_segments[..=idx].join("/");
        return (scope, Some(zone_root));
    }

    let first = dir_segments.first().copied().unwrap_or("");
    let cleaned = strip_numeric_prefix(first.trim_start_matches('_'));
    let lower = cleaned.to_lowercase();
    if lower == "meta" {
        return (Scope::Meta, None);
    }
    if lower == "projects" {
        return (Scope::Project, None);
    }
    (Scope::Unknown, None)
}

fn zone_priority(s: &Scope) -> u8 {
    match s {
        Scope::TeamManagement => 7,
        Scope::PersonalWork => 6,
        Scope::Inbox => 5,
        Scope::Resource => 4,
        Scope::Archive => 3,
        Scope::Project => 2,
        Scope::Meta => 1,
        Scope::Unknown => 0,
    }
}

fn segment_to_scope(name: &str) -> Option<Scope> {
    let cleaned = name.trim_start_matches('_');
    let cleaned = strip_numeric_prefix(cleaned);
    let lower = cleaned.to_lowercase();
    let parts: Vec<&str> = lower
        .split(|c: char| c == '-' || c == '_')
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }

    let mut team = false;
    let mut personal = false;
    let mut inbox = false;
    let mut resource = false;
    let mut archive = false;
    for p in &parts {
        if TEAM_MANAGEMENT_HINTS.contains(p) {
            team = true;
        }
        if PERSONAL_WORK_HINTS.contains(p) {
            personal = true;
        }
        if INBOX_HINTS.contains(p) {
            inbox = true;
        }
        if RESOURCE_HINTS.contains(p) {
            resource = true;
        }
        if ARCHIVE_HINTS.contains(p) {
            archive = true;
        }
    }
    if team {
        Some(Scope::TeamManagement)
    } else if personal {
        Some(Scope::PersonalWork)
    } else if inbox {
        Some(Scope::Inbox)
    } else if resource {
        Some(Scope::Resource)
    } else if archive {
        Some(Scope::Archive)
    } else {
        None
    }
}

pub(crate) fn strip_numeric_prefix(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i < bytes.len() && bytes[i] == b'_' {
        &s[i + 1..]
    } else {
        s
    }
}

fn parse_scope_str(s: &str) -> Option<Scope> {
    let key = s.trim().to_lowercase().replace('_', "-");
    match key.as_str() {
        "project" => Some(Scope::Project),
        "meta" => Some(Scope::Meta),
        "personal-work" | "personal" => Some(Scope::PersonalWork),
        "team-management" | "team" => Some(Scope::TeamManagement),
        "inbox" => Some(Scope::Inbox),
        "resource" | "resources" => Some(Scope::Resource),
        "archive" | "archives" => Some(Scope::Archive),
        "unknown" => Some(Scope::Unknown),
        _ => None,
    }
}

pub(crate) fn zone_sort_priority(s: &Scope) -> u8 {
    match s {
        Scope::TeamManagement => 0,
        Scope::PersonalWork => 1,
        Scope::Inbox => 2,
        Scope::Resource => 3,
        Scope::Archive => 4,
        Scope::Unknown => 5,
        Scope::Project => 6,
        Scope::Meta => 7,
    }
}

pub(crate) fn scope_label(s: &Scope) -> &'static str {
    match s {
        Scope::Project => "project",
        Scope::Meta => "meta",
        Scope::PersonalWork => "personal-work",
        Scope::TeamManagement => "team-management",
        Scope::Inbox => "inbox",
        Scope::Resource => "resource",
        Scope::Archive => "archive",
        Scope::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(rel: &str) -> (Scope, Option<String>) {
        compute_scope(rel, None)
    }

    #[test]
    fn strip_numeric_prefix_works() {
        assert_eq!(strip_numeric_prefix("01_inbox"), "inbox");
        assert_eq!(strip_numeric_prefix("06_daily"), "daily");
        assert_eq!(strip_numeric_prefix("notnumeric"), "notnumeric");
        assert_eq!(strip_numeric_prefix("12"), "12");
        assert_eq!(strip_numeric_prefix("99_"), "");
    }

    #[test]
    fn project_default_scope() {
        let (sc, root) = s("02_projects/foo/architecture.md");
        assert_eq!(sc, Scope::Project);
        assert_eq!(root, None);
    }

    #[test]
    fn meta_scope_for_meta_folder() {
        let (sc, _) = s("00_meta/AGENTS.md");
        assert_eq!(sc, Scope::Meta);
    }

    #[test]
    fn daily_is_personal_work() {
        let (sc, root) = s("06_daily/2026-05-17.md");
        assert_eq!(sc, Scope::PersonalWork);
        assert_eq!(root.as_deref(), Some("06_daily"));
    }

    #[test]
    fn project_journal_overrides_to_personal() {
        let (sc, root) = s("02_projects/staking-widget/journal/2026-05-15.md");
        assert_eq!(sc, Scope::PersonalWork);
        assert_eq!(
            root.as_deref(),
            Some("02_projects/staking-widget/journal")
        );
    }

    #[test]
    fn team_areas_detected() {
        let (sc, _) = s("03_areas/team/weekly-sync.md");
        assert_eq!(sc, Scope::TeamManagement);
        let (sc2, _) = s("03_areas/people/alice.md");
        assert_eq!(sc2, Scope::TeamManagement);
    }

    #[test]
    fn inbox_meetings_compound_is_team() {
        let (sc, _) = s("02_projects/_inbox-meetings/2026-05-15-1on1.md");
        assert_eq!(sc, Scope::TeamManagement);
    }

    #[test]
    fn plain_inbox_is_inbox_scope() {
        let (sc, root) = s("01_inbox/some-thought.md");
        assert_eq!(sc, Scope::Inbox);
        assert_eq!(root.as_deref(), Some("01_inbox"));
    }

    #[test]
    fn resources_is_resource_scope() {
        let (sc, _) = s("04_resources/defi-frontend-patterns.md");
        assert_eq!(sc, Scope::Resource);
    }

    #[test]
    fn archive_is_archive_scope() {
        let (sc, _) = s("05_archive/old-project/notes.md");
        assert_eq!(sc, Scope::Archive);
    }

    #[test]
    fn fm_scope_overrides_path() {
        let yaml = "scope: team-management\n";
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let m = value.as_mapping().unwrap().clone();
        let (sc, _) = compute_scope("02_projects/foo/architecture.md", Some(&m));
        assert_eq!(sc, Scope::TeamManagement);
    }

    #[test]
    fn include_in_ai_context_false_promotes_to_personal() {
        let yaml = "include_in_ai_context: false\n";
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let m = value.as_mapping().unwrap().clone();
        let (sc, _) = compute_scope("02_projects/foo/architecture.md", Some(&m));
        assert_eq!(sc, Scope::PersonalWork);
    }

    #[test]
    fn explicit_team_path_overrides_include_false() {
        let yaml = "include_in_ai_context: false\n";
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let m = value.as_mapping().unwrap().clone();
        let (sc, _) = compute_scope("03_areas/team/weekly.md", Some(&m));
        assert_eq!(sc, Scope::TeamManagement);
    }
}
