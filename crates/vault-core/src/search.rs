//! Plain-text content search across the vault's Markdown files.
//!
//! Backs the shell's Search panel. Deliberately simple: a
//! case-insensitive substring scan, line by line, over the same file
//! set the scanner indexes (pruned dirs skipped, `.bak` ignored). No
//! index is maintained — vaults are text-sized (hundreds of files,
//! not millions), so a full pass stays comfortably interactive; the
//! caps below bound the worst case.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::scan::is_pruned;

/// Total hits returned before the search stops early.
pub const MAX_HITS: usize = 200;
/// Hits reported per file — enough to show a file is relevant without
/// one log-like note drowning out the rest of the results.
pub const MAX_HITS_PER_FILE: usize = 5;
/// Snippet length cap (chars) so a minified/one-line file can't ship
/// megabytes into the UI.
const MAX_SNIPPET_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Vault-relative path, slash-separated.
    pub path: String,
    /// 1-based line number of the match.
    pub line: usize,
    /// The matched line, trimmed and clipped for display.
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// Files with at least one hit (counted even past the hit cap of
    /// an individual file).
    pub files_matched: usize,
    /// Markdown files read.
    pub files_scanned: usize,
    /// True when [`MAX_HITS`] stopped the walk early — the UI should
    /// say "first N" rather than implying completeness.
    pub truncated: bool,
}

/// Case-insensitive substring search over every indexed `.md` file
/// under `root`. Read-only; unreadable files are skipped silently
/// (the scanner's diagnostics already cover walk errors).
pub fn search_vault(root: &Path, query: &str) -> SearchResult {
    let needle = query.trim().to_lowercase();
    let mut result = SearchResult {
        hits: Vec::new(),
        files_matched: 0,
        files_scanned: 0,
        truncated: false,
    };
    if needle.is_empty() {
        return result;
    }

    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_pruned(e));

    'files: for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        // Binary-ish or unreadable content: skip quietly.
        let Ok(content) = fs::read_to_string(p) else {
            continue;
        };
        result.files_scanned += 1;
        let rel = p
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.to_string());

        let mut per_file = 0usize;
        for (i, line) in content.lines().enumerate() {
            if !line.to_lowercase().contains(&needle) {
                continue;
            }
            if per_file == 0 {
                result.files_matched += 1;
            }
            if per_file < MAX_HITS_PER_FILE {
                if result.hits.len() >= MAX_HITS {
                    result.truncated = true;
                    break 'files;
                }
                result.hits.push(SearchHit {
                    path: rel.clone(),
                    line: i + 1,
                    snippet: clip(line.trim()),
                });
            }
            per_file += 1;
        }
    }

    result
}

fn clip(s: &str) -> String {
    if s.chars().count() <= MAX_SNIPPET_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_SNIPPET_CHARS - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn finds_case_insensitive_matches_with_line_numbers() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "02_projects/a/_index.md",
            "# Title\nReentrancy via callback\nnothing here\n",
        );
        write(tmp.path(), "note.md", "unrelated\n");

        let r = search_vault(tmp.path(), "reentrancy");
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "02_projects/a/_index.md");
        assert_eq!(r.hits[0].line, 2);
        assert_eq!(r.files_matched, 1);
        assert_eq!(r.files_scanned, 2);
        assert!(!r.truncated);
    }

    #[test]
    fn empty_query_returns_nothing_and_reads_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "note.md", "content\n");
        let r = search_vault(tmp.path(), "   ");
        assert!(r.hits.is_empty());
        assert_eq!(r.files_scanned, 0);
    }

    #[test]
    fn caps_hits_per_file() {
        let tmp = tempfile::tempdir().unwrap();
        let body = "match\n".repeat(MAX_HITS_PER_FILE + 10);
        write(tmp.path(), "log.md", &body);
        let r = search_vault(tmp.path(), "match");
        assert_eq!(r.hits.len(), MAX_HITS_PER_FILE);
        assert_eq!(r.files_matched, 1);
    }

    #[test]
    fn skips_pruned_directories() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "node_modules/dep/readme.md", "match\n");
        write(tmp.path(), ".obsidian/plugin.md", "match\n");
        write(tmp.path(), "real.md", "match\n");
        let r = search_vault(tmp.path(), "match");
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "real.md");
    }
}
