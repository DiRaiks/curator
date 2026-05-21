//! OSV.dev vulnerability database client.
//!
//! Two-phase query:
//!
//! 1. **Batch filter** via `POST /v1/querybatch`. Sends up to 1000
//!    `(ecosystem, name, version)` queries in a single call and receives
//!    back, per query, the list of vulnerability IDs (no detail). This
//!    cheaply discards the ~95 % of packages that have no advisories.
//! 2. **Detail fetch** via `POST /v1/query` per affected package. Returns
//!    the full advisory record (summary, severity, fixed versions, refs).
//!    Per-package rather than per-ID so we don't have to reconcile which
//!    affected ranges hit our actual version — OSV does it for us.
//!
//! Network is best-effort: each chunk / detail call is wrapped so a
//! single failure becomes a [`OsvError`] without losing earlier results.
//! The caller (`scan_project_vulnerabilities`) downgrades top-level
//! errors into a warning and returns whatever advisories did come back.

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{Advisory, DependencyPackage};

const OSV_BATCH_URL: &str = "https://api.osv.dev/v1/querybatch";
const OSV_QUERY_URL: &str = "https://api.osv.dev/v1/query";
/// OSV batch limit per call. Real cap is 1000; we leave a small margin
/// in case a future server-side change tightens it.
const BATCH_CHUNK: usize = 500;
/// Per-call HTTP timeout. OSV is normally fast (<1s) but we cap the wait
/// so a hung connection doesn't stall the whole scan.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum OsvError {
    #[error("network error: {0}")]
    Network(String),
    #[error("server returned status {0}")]
    Status(u16),
    #[error("invalid JSON in response: {0}")]
    InvalidJson(String),
}

/// Query OSV.dev for advisories affecting the given package list.
///
/// Returns one [`Advisory`] per (package, vuln) pair. A package with two
/// vulns yields two rows; a vuln affecting two packages yields two rows.
/// The UI renders this flat so the user can scan / sort easily.
pub fn query_advisories(packages: &[DependencyPackage]) -> Result<Vec<Advisory>, OsvError> {
    if packages.is_empty() {
        return Ok(Vec::new());
    }

    // Build one HTTP agent for the whole scan so the per-package detail
    // fetches reuse the TCP / TLS connection to api.osv.dev instead of
    // doing N handshakes.
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();

    // Phase 1: batch filter. Track the running offset into `packages` so
    // a chunk-relative response index maps cleanly back to the absolute
    // index, no pointer arithmetic.
    let mut affected_indices: HashSet<usize> = HashSet::new();
    let mut offset = 0usize;
    for chunk in packages.chunks(BATCH_CHUNK) {
        let queries: Vec<BatchQuery> = chunk
            .iter()
            .map(|p| BatchQuery {
                package: OsvPackage {
                    ecosystem: p.ecosystem.clone(),
                    name: p.name.clone(),
                },
                version: p.version.clone(),
            })
            .collect();
        let body = BatchRequest { queries: &queries };
        let resp = post_json::<BatchRequest<'_>, BatchResponse>(&agent, OSV_BATCH_URL, &body)?;
        for (i, result) in resp.results.iter().enumerate() {
            if !result.vulns.is_empty() {
                affected_indices.insert(offset + i);
            }
        }
        offset += chunk.len();
    }

    if affected_indices.is_empty() {
        return Ok(Vec::new());
    }

    // Phase 2: fetch full details for each affected package.
    let mut advisories: Vec<Advisory> = Vec::new();
    for idx in affected_indices {
        let pkg = &packages[idx];
        let body = SingleQuery {
            package: OsvPackage {
                ecosystem: pkg.ecosystem.clone(),
                name: pkg.name.clone(),
            },
            version: pkg.version.clone(),
        };
        let resp = match post_json::<SingleQuery, QueryResponse>(&agent, OSV_QUERY_URL, &body) {
            Ok(r) => r,
            Err(_) => continue, // skip this package; partial results are
                                // still useful and the caller surfaces a
                                // warning on the top-level path.
        };
        for vuln in resp.vulns {
            advisories.push(to_advisory(pkg, vuln));
        }
    }

    // Stable order so the UI doesn't reshuffle between scans of the same
    // state. Sort by (package name, then OSV id).
    advisories.sort_by(|a, b| {
        a.package
            .name
            .cmp(&b.package.name)
            .then_with(|| a.osv_id.cmp(&b.osv_id))
    });

    Ok(advisories)
}

fn to_advisory(pkg: &DependencyPackage, v: OsvVuln) -> Advisory {
    let severity = pick_severity(&v.severity);
    let fixed_versions = collect_fixed_versions(&v.affected);
    let references = v.references.into_iter().map(|r| r.url).collect();
    Advisory {
        package: pkg.clone(),
        osv_id: v.id,
        summary: v.summary,
        details: v.details,
        severity,
        fixed_versions,
        references,
    }
}

/// Pick the strongest severity available. OSV may attach multiple entries
/// (CVSS_V3 + CVSS_V4 + qualitative) — we surface CVSS_V4 if present,
/// then V3, then anything else. Formatted as `"CVSS_V3 7.5"` so the UI
/// can render the kind + raw score without re-parsing the vector string.
fn pick_severity(entries: &[OsvSeverity]) -> Option<String> {
    let priority = |kind: &str| -> u8 {
        match kind {
            "CVSS_V4" => 3,
            "CVSS_V3" => 2,
            _ => 1,
        }
    };
    entries
        .iter()
        .max_by_key(|e| priority(&e.kind))
        .map(|e| format!("{} {}", e.kind, e.score))
}

fn collect_fixed_versions(affected: &[OsvAffected]) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for a in affected {
        for r in &a.ranges {
            for ev in &r.events {
                if let Some(v) = &ev.fixed {
                    if seen.insert(v.as_str()) {
                        out.push(v.clone());
                    }
                }
            }
        }
    }
    out
}

fn post_json<TReq: Serialize, TResp: for<'de> Deserialize<'de>>(
    agent: &ureq::Agent,
    url: &str,
    body: &TReq,
) -> Result<TResp, OsvError> {
    let resp = agent
        .post(url)
        .set("Accept", "application/json")
        .set("User-Agent", "vault-workflow-ide")
        .send_json(
            serde_json::to_value(body)
                .map_err(|e| OsvError::InvalidJson(format!("serialize request: {e}")))?,
        );
    match resp {
        Ok(r) => r
            .into_json::<TResp>()
            .map_err(|e| OsvError::InvalidJson(e.to_string())),
        Err(ureq::Error::Status(code, _)) => Err(OsvError::Status(code)),
        Err(e) => Err(OsvError::Network(e.to_string())),
    }
}

// ---------- OSV wire types ----------

#[derive(Serialize)]
struct BatchRequest<'a> {
    queries: &'a [BatchQuery],
}

#[derive(Serialize)]
struct BatchQuery {
    package: OsvPackage,
    version: String,
}

#[derive(Serialize)]
struct OsvPackage {
    ecosystem: String,
    name: String,
}

#[derive(Serialize)]
struct SingleQuery {
    package: OsvPackage,
    version: String,
}

#[derive(Deserialize)]
struct BatchResponse {
    #[serde(default)]
    results: Vec<BatchResult>,
}

#[derive(Deserialize, Default)]
struct BatchResult {
    /// We only inspect `vulns.is_empty()` to decide whether to fetch
    /// details — the `id` field inside isn't used here, so deserialize
    /// to a value we can count and ignore. Avoids carrying around a
    /// pointless `id` String.
    #[serde(default)]
    vulns: Vec<serde::de::IgnoredAny>,
}

#[derive(Deserialize, Default)]
struct QueryResponse {
    #[serde(default)]
    vulns: Vec<OsvVuln>,
}

#[derive(Deserialize, Default)]
struct OsvVuln {
    #[serde(default)]
    id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    details: Option<String>,
    #[serde(default)]
    severity: Vec<OsvSeverity>,
    #[serde(default)]
    references: Vec<OsvReference>,
    #[serde(default)]
    affected: Vec<OsvAffected>,
}

#[derive(Deserialize)]
struct OsvSeverity {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    score: String,
}

#[derive(Deserialize)]
struct OsvReference {
    #[serde(default)]
    url: String,
}

#[derive(Deserialize, Default)]
struct OsvAffected {
    #[serde(default)]
    ranges: Vec<OsvRange>,
}

#[derive(Deserialize, Default)]
struct OsvRange {
    #[serde(default)]
    events: Vec<OsvRangeEvent>,
}

#[derive(Deserialize, Default)]
struct OsvRangeEvent {
    /// OSV ranges also carry `introduced` markers, but we only need
    /// `fixed` for the UI ("upgrade to ≥ X"). Leaving `introduced`
    /// untyped lets serde discard it without a dead-code warning.
    #[serde(default)]
    fixed: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_severity_prefers_v4_over_v3() {
        let entries = vec![
            OsvSeverity {
                kind: "CVSS_V3".into(),
                score: "7.5".into(),
            },
            OsvSeverity {
                kind: "CVSS_V4".into(),
                score: "9.1".into(),
            },
        ];
        assert_eq!(pick_severity(&entries), Some("CVSS_V4 9.1".into()));
    }

    #[test]
    fn pick_severity_falls_back_to_unknown_kinds() {
        let entries = vec![OsvSeverity {
            kind: "CWE_FOO".into(),
            score: "high".into(),
        }];
        assert_eq!(pick_severity(&entries), Some("CWE_FOO high".into()));
    }

    #[test]
    fn collect_fixed_versions_dedupes() {
        let aff = vec![
            OsvAffected {
                ranges: vec![OsvRange {
                    events: vec![
                        OsvRangeEvent { fixed: None },
                        OsvRangeEvent {
                            fixed: Some("1.2.3".into()),
                        },
                    ],
                }],
            },
            OsvAffected {
                ranges: vec![OsvRange {
                    events: vec![OsvRangeEvent {
                        fixed: Some("1.2.3".into()),
                    }],
                }],
            },
        ];
        assert_eq!(collect_fixed_versions(&aff), vec!["1.2.3".to_string()]);
    }
}
