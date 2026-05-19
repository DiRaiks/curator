//! One-shot migration from the legacy JSON stores into the consolidated
//! [`AppDb`].
//!
//! Before consolidation we had:
//! - `dismissed.json` → many `(vault_root, rec_id)` pairs
//! - `recent_vaults.json` → a list of `RecentVault` entries
//!
//! These files lived in `app_local_data_dir/` next to the SQLite DB.
//! On startup, [`migrate_legacy_json`] looks for them and imports any
//! contents into the matching tables — but only if the table is empty,
//! to avoid clobbering data after a partial earlier migration. On
//! success the JSON file is deleted so the next startup is a no-op.
//!
//! Each domain migrates independently — a parse failure in one file
//! doesn't block the other. The report tells the caller what landed
//! so the IDE log makes the once-only migration visible.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use serde::Deserialize;

use super::{AppDb, AppDbError};

/// What the legacy `dismissed.json` looked like on disk before
/// consolidation. Kept here as a private compat type — we don't want
/// the rest of the crate to depend on its shape.
#[derive(Default, Deserialize)]
struct LegacyDismissedFile {
    #[serde(default)]
    by_vault: HashMap<String, BTreeSet<String>>,
}

/// What the legacy `recent_vaults.json` looked like.
#[derive(Default, Deserialize)]
struct LegacyRecentVaultsFile {
    #[serde(default)]
    vaults: Vec<LegacyRecentVault>,
}

#[derive(Deserialize)]
struct LegacyRecentVault {
    path: String,
    last_opened_at_ms: i64,
    #[serde(default)]
    pinned: bool,
}

/// Per-run summary the Tauri shell logs at startup. Zero counts when
/// the migration was already done previously.
#[derive(Debug, Default, Clone)]
pub struct LegacyJsonReport {
    pub dismissed_imported: usize,
    pub recents_imported: usize,
}

/// Import any legacy JSON files found in `data_dir` into `db`. Files
/// that successfully import are deleted afterwards so subsequent
/// startups skip the work.
///
/// Returns a report rather than `()` so the caller can log the
/// once-only migration. Errors are surfaced for the failing domain
/// only — the others still get a chance to import. The function as a
/// whole returns `Err` only when something truly unexpected happens
/// (e.g. the DB itself errored).
pub fn migrate_legacy_json(
    db: &AppDb,
    data_dir: &Path,
) -> Result<LegacyJsonReport, AppDbError> {
    let mut report = LegacyJsonReport::default();

    // Dismissed recommendations -------------------------------------
    let dismissed_path = data_dir.join("dismissed.json");
    if dismissed_path.is_file() {
        // Only import if the table is currently empty. This guards
        // against re-importing after a user manually re-created the
        // JSON file (e.g. by restoring a backup).
        let empty: i64 = {
            let conn = db.lock();
            conn.query_row(
                "SELECT COUNT(*) FROM dismissed_recommendations",
                [],
                |r| r.get(0),
            )?
        };
        if empty == 0 {
            match read_json::<LegacyDismissedFile>(&dismissed_path) {
                Ok(parsed) => {
                    for (vault, ids) in &parsed.by_vault {
                        for id in ids {
                            db.dismiss_recommendation(vault, id)?;
                            report.dismissed_imported += 1;
                        }
                    }
                    // Best-effort cleanup. If the unlink fails we just
                    // leave the file in place; the next startup will
                    // see the table is non-empty and skip the import,
                    // so no double-write hazard.
                    let _ = std::fs::remove_file(&dismissed_path);
                }
                Err(e) => {
                    // Keep the file so the user can recover; surface
                    // the error for telemetry but don't fail the open.
                    eprintln!(
                        "legacy dismissed.json migration failed: {e} (file kept at {})",
                        dismissed_path.display()
                    );
                }
            }
        }
    }

    // Recent vaults --------------------------------------------------
    let recents_path = data_dir.join("recent_vaults.json");
    if recents_path.is_file() {
        let empty: i64 = {
            let conn = db.lock();
            conn.query_row("SELECT COUNT(*) FROM recent_vaults", [], |r| r.get(0))?
        };
        if empty == 0 {
            match read_json::<LegacyRecentVaultsFile>(&recents_path) {
                Ok(parsed) => {
                    // Insert directly with the preserved timestamps —
                    // we can't use `record_recent_vault` because it
                    // overwrites `last_opened_at_ms` with `now`.
                    let conn = db.lock();
                    let mut stmt = conn.prepare(
                        r#"
                        INSERT OR REPLACE INTO recent_vaults
                            (path, last_opened_at_ms, pinned)
                        VALUES (?1, ?2, ?3)
                        "#,
                    )?;
                    for v in &parsed.vaults {
                        stmt.execute(rusqlite::params![
                            v.path,
                            v.last_opened_at_ms,
                            v.pinned as i64,
                        ])?;
                        report.recents_imported += 1;
                    }
                    drop(stmt);
                    drop(conn);
                    let _ = std::fs::remove_file(&recents_path);
                }
                Err(e) => {
                    eprintln!(
                        "legacy recent_vaults.json migration failed: {e} (file kept at {})",
                        recents_path.display()
                    );
                }
            }
        }
    }

    Ok(report)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AppDbError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppDbError::Internal(format!("read {}: {e}", path.display())))?;
    Ok(serde_json::from_str::<T>(&raw)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn imports_dismissed_then_deletes_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("dismissed.json"),
            r#"{"by_vault":{"/v":["rec-1","rec-2"]}}"#,
        )
        .unwrap();
        let db = AppDb::open_in_memory().unwrap();
        let report = migrate_legacy_json(&db, tmp.path()).unwrap();
        assert_eq!(report.dismissed_imported, 2);
        assert!(!tmp.path().join("dismissed.json").exists());
        assert_eq!(
            db.list_dismissed("/v").unwrap(),
            vec!["rec-1".to_string(), "rec-2".to_string()]
        );
    }

    #[test]
    fn imports_recents_with_preserved_timestamps() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("recent_vaults.json"),
            r#"{"vaults":[
                {"path":"/old","last_opened_at_ms":1000,"pinned":true},
                {"path":"/new","last_opened_at_ms":2000,"pinned":false}
            ]}"#,
        )
        .unwrap();
        let db = AppDb::open_in_memory().unwrap();
        let report = migrate_legacy_json(&db, tmp.path()).unwrap();
        assert_eq!(report.recents_imported, 2);
        let list = db.list_recent_vaults().unwrap();
        assert_eq!(list.len(), 2);
        let new_row = list.iter().find(|v| v.path == "/new").unwrap();
        assert_eq!(new_row.last_opened_at_ms, 2000);
        let pinned = list.iter().find(|v| v.path == "/old").unwrap();
        assert!(pinned.pinned);
        assert!(!tmp.path().join("recent_vaults.json").exists());
    }

    #[test]
    fn skips_when_table_non_empty() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("dismissed.json"),
            r#"{"by_vault":{"/v":["from-json"]}}"#,
        )
        .unwrap();
        let db = AppDb::open_in_memory().unwrap();
        // Pre-seed the table — migration must NOT clobber.
        db.dismiss_recommendation("/v", "from-db").unwrap();
        let report = migrate_legacy_json(&db, tmp.path()).unwrap();
        assert_eq!(report.dismissed_imported, 0);
        let list = db.list_dismissed("/v").unwrap();
        assert_eq!(list, vec!["from-db".to_string()]);
        // File preserved on disk for safety (user can inspect).
        assert!(tmp.path().join("dismissed.json").exists());
    }

    #[test]
    fn missing_files_is_noop() {
        let tmp = TempDir::new().unwrap();
        let db = AppDb::open_in_memory().unwrap();
        let report = migrate_legacy_json(&db, tmp.path()).unwrap();
        assert_eq!(report.dismissed_imported, 0);
        assert_eq!(report.recents_imported, 0);
    }
}
