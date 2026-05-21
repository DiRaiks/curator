//! Parser for `yarn.lock` files — both Yarn 1 (Classic) and Yarn Berry
//! (v2/v3, lockfile `__metadata: version 6+`).
//!
//! Both formats share the block-per-package shape: a header line listing
//! one or more comma-separated specs, then indented `key value` lines.
//! The only difference we care about is how `version` is encoded:
//!
//! Yarn 1:
//! ```text
//! "@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
//!   version "7.16.7"
//!   resolved "https://..."
//! ```
//!
//! Yarn Berry (YAML-shaped):
//! ```text
//! "@adraffy/ens-normalize@npm:^1.10.1":
//!   version: 1.11.1
//!   resolution: "@adraffy/ens-normalize@npm:1.11.1"
//! ```
//!
//! Name extraction (last `@`) works for both — Berry's `npm:` protocol
//! still leaves the `@` immediately before it, so `@scope/x@npm:^1`
//! splits to `@scope/x`. We also skip the `__metadata` block since its
//! header has no `@` and `extract_name` returns `None` for it.

use crate::cve::DependencyPackage;

/// Parse a yarn.lock body. The `source` label is echoed back as
/// [`DependencyPackage::source_lock_file`] for UI attribution.
pub fn parse(text: &str, source: &str) -> Result<Vec<DependencyPackage>, String> {
    let mut packages = Vec::new();
    let mut iter = text.lines().peekable();

    while let Some(line) = iter.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Block header: non-indented (column 0) and ending in `:`.
        let starts_indented = line.starts_with(|c: char| c.is_whitespace());
        if starts_indented || !trimmed.ends_with(':') {
            continue;
        }

        let header = &trimmed[..trimmed.len() - 1];
        let first = first_spec(header);
        let Some(name) = extract_name(&first) else {
            // Malformed header (e.g. spec with no `@` separator). Skip
            // and continue — better to lose one package than to abort.
            continue;
        };

        // Walk the indented body until the next non-indented line or EOF.
        let mut version: Option<String> = None;
        while let Some(peek) = iter.peek() {
            if !peek.starts_with(|c: char| c.is_whitespace()) {
                break;
            }
            let body = iter.next().expect("peeked").trim();
            if body.is_empty() {
                continue;
            }
            if version.is_none() {
                if let Some(v) = parse_version_line(body) {
                    version = Some(v);
                }
            }
        }

        if let Some(v) = version {
            packages.push(DependencyPackage {
                ecosystem: "npm".to_string(),
                name: name.to_string(),
                version: v,
                source_lock_file: source.to_string(),
            });
        }
    }

    Ok(packages)
}

/// Pick the first spec out of a (possibly comma-separated) header.
///
/// Yarn 1 quotes each spec independently:
///   `"a@^1", "a@^2"` → ["a@^1", "a@^2"]
///
/// Yarn Berry wraps the whole list in one quote pair:
///   `"a@npm:^1, a@npm:^2"` → ["a@npm:^1", "a@npm:^2"]
///
/// Both reduce to the same shape after stripping every `"`: a bare
/// comma-separated list. Package names can't contain commas, and yarn
/// doesn't escape quotes, so this is safe.
fn first_spec(header: &str) -> String {
    let no_quotes: String = header.chars().filter(|c| *c != '"').collect();
    let first = no_quotes.split(',').next().unwrap_or("");
    first.trim().to_string()
}

/// Pull the package name from a Yarn spec — everything before the LAST
/// `@`. Works for both scoped (`@babel/code-frame@^7.0.0`) and unscoped
/// (`lodash@^4.17.0`) packages because scoped names start at index 0.
fn extract_name(spec: &str) -> Option<&str> {
    let last_at = spec.rfind('@')?;
    if last_at == 0 {
        return None;
    }
    Some(&spec[..last_at])
}

/// Parse a `version` line in either Yarn dialect:
///
/// - Yarn 1: `version "7.16.7"` — separator is whitespace, value is
///   double-quoted.
/// - Yarn Berry: `version: 1.11.1` — separator is colon-then-whitespace,
///   value is bare YAML scalar (occasionally quoted).
///
/// Returns `None` for any shape we don't recognise rather than coercing
/// partial matches into nonsense.
fn parse_version_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix("version")?;
    // Require a real separator after `version` — guards against
    // hypothetical keys like `versionGroup` that start with "version".
    let first = rest.chars().next()?;
    if !matches!(first, ':' | ' ' | '\t') {
        return None;
    }
    let rest = rest.trim_start_matches(':').trim_start();
    if rest.is_empty() {
        return None;
    }
    // Quoted (Yarn 1 always, Berry occasionally): read up to the closing
    // quote so a value like "1.2.3-rc+build" stays intact.
    if let Some(inside) = rest.strip_prefix('"') {
        let end = inside.find('"')?;
        return Some(inside[..end].to_string());
    }
    // Unquoted (Yarn Berry default): take up to next whitespace.
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
  version "7.16.7"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.16.7.tgz#abc"
  integrity sha512-deadbeef
  dependencies:
    "@babel/highlight" "^7.16.7"

lodash@^4.17.20:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#xyz"
  integrity sha512-cafebabe

"@scope/no-version-block@^1.0.0":
  resolved "https://example.com"
"#;

    #[test]
    fn parses_scoped_and_unscoped() {
        let pkgs = parse(SAMPLE, "yarn.lock").unwrap();
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"@babel/code-frame"));
        assert!(names.contains(&"lodash"));
        // The malformed block (no version) should be skipped silently.
        assert!(!names.contains(&"@scope/no-version-block"));
    }

    #[test]
    fn captures_resolved_version() {
        let pkgs = parse(SAMPLE, "yarn.lock").unwrap();
        let babel = pkgs.iter().find(|p| p.name == "@babel/code-frame").unwrap();
        assert_eq!(babel.version, "7.16.7");
        let lodash = pkgs.iter().find(|p| p.name == "lodash").unwrap();
        assert_eq!(lodash.version, "4.17.21");
    }

    #[test]
    fn ecosystem_is_npm() {
        let pkgs = parse(SAMPLE, "yarn.lock").unwrap();
        for p in &pkgs {
            assert_eq!(p.ecosystem, "npm");
            assert_eq!(p.source_lock_file, "yarn.lock");
        }
    }

    #[test]
    fn ignores_comments_and_blanks() {
        let pkgs = parse("# only comments\n\n   \n# more\n", "yarn.lock").unwrap();
        assert!(pkgs.is_empty());
    }

    #[test]
    fn first_spec_handles_both_dialects() {
        // Yarn 1: each spec independently quoted, separated by ", ".
        assert_eq!(
            first_spec("\"@babel/code-frame@^7.0.0\", \"@babel/code-frame@^7.10.4\""),
            "@babel/code-frame@^7.0.0"
        );
        // Yarn Berry: whole spec list inside ONE quote pair.
        assert_eq!(
            first_spec("\"@x/y@npm:^1.0, @x/y@npm:^2.0\""),
            "@x/y@npm:^1.0"
        );
        // Single spec, single quote pair.
        assert_eq!(first_spec("\"lodash@^4\""), "lodash@^4");
    }

    #[test]
    fn extract_name_rejects_lone_scope() {
        assert_eq!(extract_name("@scope-only"), None);
        assert_eq!(extract_name("@scope/name@^1"), Some("@scope/name"));
        assert_eq!(extract_name("lodash@^4"), Some("lodash"));
    }

    const BERRY_SAMPLE: &str = r#"# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 6
  cacheKey: 8

"@adraffy/ens-normalize@npm:^1.10.1, @adraffy/ens-normalize@npm:^1.11.0":
  version: 1.11.1
  resolution: "@adraffy/ens-normalize@npm:1.11.1"
  checksum: e8b17fcc730ccc45a956
  languageName: node
  linkType: hard

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: cafebabe

"@babel/runtime@npm:^7.20.0":
  version: "7.22.5"
  resolution: "@babel/runtime@npm:7.22.5"
"#;

    #[test]
    fn parses_yarn_berry_format() {
        let pkgs = parse(BERRY_SAMPLE, "yarn.lock").unwrap();
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        // `__metadata` has no `@` in its header so it gets skipped silently.
        assert!(!names.contains(&"__metadata"));
        assert!(names.contains(&"@adraffy/ens-normalize"));
        assert!(names.contains(&"lodash"));
        assert!(names.contains(&"@babel/runtime"));
    }

    #[test]
    fn berry_captures_unquoted_versions() {
        let pkgs = parse(BERRY_SAMPLE, "yarn.lock").unwrap();
        let ens = pkgs
            .iter()
            .find(|p| p.name == "@adraffy/ens-normalize")
            .unwrap();
        assert_eq!(ens.version, "1.11.1");
        let lodash = pkgs.iter().find(|p| p.name == "lodash").unwrap();
        assert_eq!(lodash.version, "4.17.21");
    }

    #[test]
    fn berry_handles_quoted_versions_too() {
        // Berry occasionally double-quotes versions; we should accept it.
        let pkgs = parse(BERRY_SAMPLE, "yarn.lock").unwrap();
        let runtime = pkgs.iter().find(|p| p.name == "@babel/runtime").unwrap();
        assert_eq!(runtime.version, "7.22.5");
    }

    #[test]
    fn parse_version_line_rejects_lookalikes() {
        // No separator after `version` — must not match.
        assert_eq!(parse_version_line("versionGroup: foo"), None);
        // Real separators in both dialects.
        assert_eq!(
            parse_version_line("version \"1.2.3\""),
            Some("1.2.3".to_string())
        );
        assert_eq!(
            parse_version_line("version: 1.2.3"),
            Some("1.2.3".to_string())
        );
        assert_eq!(
            parse_version_line("version: \"1.2.3-rc1\""),
            Some("1.2.3-rc1".to_string())
        );
    }
}
