//! Small private utilities shared across modules.
//!
//! IO helpers (`read_head`, `read_dir_sorted`, `is_md_file`, `rel_of`),
//! string/path helpers (`pretty_stem`), environment lookup
//! (`detect_home_dir`), and dependency-free date math (`format_today_utc`,
//! `civil_from_days`). Nothing here is part of the public API.

use std::io::Read;
use std::path::{Path, PathBuf};

pub(crate) fn read_head(path: &Path, max: usize) -> Option<String> {
    let mut buf = vec![0u8; max];
    let mut f = std::fs::File::open(path).ok()?;
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    String::from_utf8(buf).ok()
}

pub(crate) fn pretty_stem(s: &str) -> String {
    let trimmed = s
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_');
    if trimmed.is_empty() {
        s.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn rel_of(root: &Path, p: &Path) -> Option<String> {
    p.strip_prefix(root)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

pub(crate) fn read_dir_sorted(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    entries.sort();
    Ok(entries)
}

pub(crate) fn is_md_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
}

pub(crate) fn detect_home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|s| !s.is_empty())
}

pub(crate) fn format_today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's `civil_from_days`. Converts days-since-1970-01-01 to
/// `(year, month, day)` in the proleptic Gregorian calendar — used only to
/// stamp `created`/`updated` fields in newly created Markdown files, no
/// external date dependency.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y_out = if m <= 2 { y + 1 } else { y };
    (y_out, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_stem_strips_numeric_prefix() {
        assert_eq!(pretty_stem("01-domain"), "domain");
        assert_eq!(pretty_stem("08-services-map"), "services-map");
        assert_eq!(pretty_stem("domain"), "domain");
        assert_eq!(pretty_stem("12"), "12");
    }
}
