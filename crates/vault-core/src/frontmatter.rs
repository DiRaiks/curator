//! YAML frontmatter parsing helpers.
//!
//! All callers go through `parse_frontmatter_from_head` (already-buffered) or
//! `read_frontmatter_full` (reads the file). Once a `Mapping` is in hand, the
//! `fm_*` typed accessors are the only sanctioned way to pull fields — keeping
//! the YAML-shape knowledge contained here.

use std::path::Path;

/// Max bytes read from the head of a Markdown file when sniffing frontmatter.
/// 16 KiB comfortably covers any sane frontmatter block while bounding worst-
/// case IO per file during a vault scan.
pub(crate) const FRONTMATTER_HEAD_BYTES: usize = 16 * 1024;

pub(crate) fn read_frontmatter_full(path: &Path) -> Option<serde_yaml_ng::Mapping> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_frontmatter_from_head(&content)
}

pub(crate) fn parse_frontmatter_from_head(head: &str) -> Option<serde_yaml_ng::Mapping> {
    let fm = extract_frontmatter(head)?;
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(fm).ok()?;
    value.as_mapping().cloned()
}

pub(crate) fn fm_string(m: &serde_yaml_ng::Mapping, k: &str) -> Option<String> {
    m.get(serde_yaml_ng::Value::String(k.to_string()))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

pub(crate) fn fm_i64(m: &serde_yaml_ng::Mapping, k: &str) -> Option<i64> {
    m.get(serde_yaml_ng::Value::String(k.to_string()))
        .and_then(|v| v.as_i64())
}

pub(crate) fn fm_string_array(m: &serde_yaml_ng::Mapping, k: &str) -> Vec<String> {
    match m.get(serde_yaml_ng::Value::String(k.to_string())) {
        Some(serde_yaml_ng::Value::Sequence(seq)) => seq
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        Some(serde_yaml_ng::Value::String(s)) => s
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn extract_frontmatter(content: &str) -> Option<&str> {
    let s = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    if let Some(end) = s.find("\n---\n") {
        return Some(&s[..end]);
    }
    if let Some(end) = s.find("\n---\r\n") {
        return Some(&s[..end]);
    }
    if let Some(stripped) = s.strip_suffix("\n---") {
        return Some(stripped);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_frontmatter_block() {
        let input = "---\nid: foo\ntitle: bar\n---\nbody\n";
        assert_eq!(extract_frontmatter(input), Some("id: foo\ntitle: bar"));
    }

    #[test]
    fn no_frontmatter_returns_none() {
        assert!(extract_frontmatter("# just markdown\n").is_none());
    }

    #[test]
    fn fm_string_array_parses_sequence_and_csv() {
        let yaml = "tools:\n  - Read\n  - Grep\n  - Bash\n";
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let m = value.as_mapping().unwrap().clone();
        assert_eq!(fm_string_array(&m, "tools"), vec!["Read", "Grep", "Bash"]);

        let yaml2 = "tools: \"Read, Grep, Bash\"\n";
        let v2: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml2).unwrap();
        let m2 = v2.as_mapping().unwrap().clone();
        assert_eq!(fm_string_array(&m2, "tools"), vec!["Read", "Grep", "Bash"]);
    }
}
