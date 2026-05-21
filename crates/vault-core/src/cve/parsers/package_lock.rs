//! Parser for npm `package-lock.json` files.
//!
//! Supports the two formats that matter today:
//!
//! - **v2 / v3** (npm 7+) — the canonical `packages` map keyed by install
//!   path, e.g. `node_modules/<name>` or
//!   `node_modules/<a>/node_modules/<b>` for nested copies. The root
//!   project sits under the `""` key and is skipped.
//! - **v1** (legacy npm 5/6) — `dependencies` tree with `version` per
//!   entry plus optional nested `dependencies`. We recurse so transitive
//!   pins are captured.
//!
//! If both keys are present (v2/v3 files keep the legacy `dependencies`
//! for back-compat with old npm), we prefer `packages` since it's the
//! source of truth for the modern format.

use serde_json::Value;

use crate::cve::DependencyPackage;

/// Parse the body of a `package-lock.json`. The `source` label is echoed
/// back as [`DependencyPackage::source_lock_file`] for UI attribution.
pub fn parse(text: &str, source: &str) -> Result<Vec<DependencyPackage>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;

    let mut out: Vec<DependencyPackage> = Vec::new();

    if let Some(packages) = root.get("packages").and_then(|v| v.as_object()) {
        for (key, entry) in packages {
            if key.is_empty() {
                continue;
            }
            let Some(name) = name_from_packages_key(key) else {
                continue;
            };
            let Some(version) = entry
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            else {
                continue;
            };
            // Skip `link: true` workspace symlinks — they're project-local
            // overlays of dependencies that already appear under their
            // real names elsewhere in the lock.
            if entry.get("link").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            out.push(DependencyPackage {
                ecosystem: "npm".to_string(),
                name: name.to_string(),
                version,
                source_lock_file: source.to_string(),
            });
        }
    } else if let Some(deps) = root.get("dependencies").and_then(|v| v.as_object()) {
        // Legacy v1 format.
        walk_v1_dependencies(deps, source, &mut out);
    }

    Ok(out)
}

/// Extract `<name>` from a `packages` key of shape `node_modules/<name>`
/// or `node_modules/<x>/node_modules/<name>` (nested copies). Names can
/// be scoped (`@scope/name`), which adds a slash inside the segment —
/// we look for the last `node_modules/` and return everything after it.
fn name_from_packages_key(key: &str) -> Option<&str> {
    let marker = "node_modules/";
    let idx = key.rfind(marker)?;
    let tail = &key[idx + marker.len()..];
    if tail.is_empty() {
        None
    } else {
        Some(tail)
    }
}

fn walk_v1_dependencies(
    deps: &serde_json::Map<String, Value>,
    source: &str,
    out: &mut Vec<DependencyPackage>,
) {
    for (name, entry) in deps {
        let version = entry.get("version").and_then(|v| v.as_str());
        if let Some(v) = version {
            out.push(DependencyPackage {
                ecosystem: "npm".to_string(),
                name: name.clone(),
                version: v.to_string(),
                source_lock_file: source.to_string(),
            });
        }
        if let Some(nested) = entry.get("dependencies").and_then(|v| v.as_object()) {
            walk_v1_dependencies(nested, source, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V3_SAMPLE: &str = r#"
    {
      "name": "demo",
      "version": "1.0.0",
      "lockfileVersion": 3,
      "requires": true,
      "packages": {
        "": {
          "name": "demo",
          "version": "1.0.0",
          "dependencies": { "lodash": "^4.17.21" }
        },
        "node_modules/lodash": {
          "version": "4.17.21",
          "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
          "integrity": "sha512-abc"
        },
        "node_modules/@babel/code-frame": {
          "version": "7.16.7",
          "resolved": "https://registry.npmjs.org/@babel/code-frame/-/code-frame-7.16.7.tgz"
        },
        "node_modules/strip-ansi/node_modules/ansi-regex": {
          "version": "6.0.1"
        },
        "node_modules/my-workspace-pkg": {
          "version": "0.0.0",
          "link": true
        }
      }
    }
    "#;

    #[test]
    fn parses_v3_packages_map() {
        let pkgs = parse(V3_SAMPLE, "package-lock.json").unwrap();
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"lodash"));
        assert!(names.contains(&"@babel/code-frame"));
        // Nested copies still count as packages (different versions can pin
        // independently) — but the root `""` entry must be skipped.
        assert!(names.contains(&"ansi-regex"));
        // Workspace symlinks (link: true) are not real package downloads.
        assert!(!names.contains(&"my-workspace-pkg"));
    }

    #[test]
    fn v3_versions_are_captured() {
        let pkgs = parse(V3_SAMPLE, "package-lock.json").unwrap();
        let lodash = pkgs.iter().find(|p| p.name == "lodash").unwrap();
        assert_eq!(lodash.version, "4.17.21");
    }

    const V1_SAMPLE: &str = r#"
    {
      "name": "demo",
      "version": "1.0.0",
      "lockfileVersion": 1,
      "dependencies": {
        "lodash": {
          "version": "4.17.20",
          "resolved": "..."
        },
        "@babel/code-frame": {
          "version": "7.10.4",
          "dependencies": {
            "@babel/highlight": { "version": "7.10.4" }
          }
        }
      }
    }
    "#;

    #[test]
    fn parses_v1_legacy_format() {
        let pkgs = parse(V1_SAMPLE, "package-lock.json").unwrap();
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"lodash"));
        assert!(names.contains(&"@babel/code-frame"));
        // Nested deps from v1 should be walked.
        assert!(names.contains(&"@babel/highlight"));
    }

    #[test]
    fn invalid_json_returns_err() {
        assert!(parse("{not json", "package-lock.json").is_err());
    }

    #[test]
    fn empty_lock_returns_empty_list() {
        let body = r#"{ "name":"x","version":"0","lockfileVersion":3 }"#;
        let pkgs = parse(body, "package-lock.json").unwrap();
        assert!(pkgs.is_empty());
    }
}
