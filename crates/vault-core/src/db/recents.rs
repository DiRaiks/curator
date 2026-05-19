//! Recent vaults — last-opened list shown on the Welcome screen.
//!
//! Same data model as the legacy `recent_vaults.json`:
//! - One row per canonical vault path
//! - `pinned` flag exempts a row from rolling-cap auto-trim
//! - At most [`MAX_RECENT_VAULTS`] non-pinned entries; oldest non-pinned
//!   get dropped on the next `record_recent_vault` call

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{AppDb, AppDbError};

pub(super) const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS recent_vaults (
    path              TEXT    PRIMARY KEY,
    last_opened_at_ms INTEGER NOT NULL,
    pinned            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recent_vaults_last_opened
    ON recent_vaults(last_opened_at_ms DESC);
"#;

pub const MAX_RECENT_VAULTS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub path: String,
    pub last_opened_at_ms: i64,
    pub pinned: bool,
}

impl AppDb {
    /// Upsert a vault into the recent list. The path is treated
    /// verbatim — callers should canonicalize first so semantically-
    /// equivalent paths don't double-up.
    ///
    /// After upsert, oldest non-pinned rows past [`MAX_RECENT_VAULTS`]
    /// are deleted in the same transaction.
    pub fn record_recent_vault(&self, canonical_path: &str) -> Result<(), AppDbError> {
        let now_ms = current_unix_ms();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            INSERT INTO recent_vaults (path, last_opened_at_ms, pinned)
            VALUES (?1, ?2, 0)
            ON CONFLICT(path) DO UPDATE SET
                last_opened_at_ms = excluded.last_opened_at_ms
            "#,
            params![canonical_path, now_ms],
        )?;

        // Trim: delete the non-pinned rows past the cap, oldest first.
        // OFFSET picks rows after the N most-recent unpinned ones; the
        // pinned rows aren't counted at all because the inner SELECT
        // restricts to `pinned = 0`.
        tx.execute(
            r#"
            DELETE FROM recent_vaults
            WHERE pinned = 0 AND path IN (
                SELECT path FROM recent_vaults
                WHERE pinned = 0
                ORDER BY last_opened_at_ms DESC
                LIMIT -1 OFFSET ?1
            )
            "#,
            params![MAX_RECENT_VAULTS as i64],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// List recent vaults newest-first.
    pub fn list_recent_vaults(&self) -> Result<Vec<RecentVault>, AppDbError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT path, last_opened_at_ms, pinned FROM recent_vaults ORDER BY last_opened_at_ms DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RecentVault {
                path: row.get(0)?,
                last_opened_at_ms: row.get(1)?,
                pinned: row.get::<_, i64>(2)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn remove_recent_vault(&self, path: &str) -> Result<(), AppDbError> {
        let conn = self.lock();
        conn.execute("DELETE FROM recent_vaults WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn pin_recent_vault(&self, path: &str, pinned: bool) -> Result<(), AppDbError> {
        let conn = self.lock();
        conn.execute(
            "UPDATE recent_vaults SET pinned = ?1 WHERE path = ?2",
            params![pinned as i64, path],
        )?;
        Ok(())
    }
}

fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_then_list_round_trip() {
        let db = AppDb::open_in_memory().unwrap();
        db.record_recent_vault("/a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        db.record_recent_vault("/b").unwrap();
        let list = db.list_recent_vaults().unwrap();
        // Newest first → "/b" before "/a".
        assert_eq!(list[0].path, "/b");
        assert_eq!(list[1].path, "/a");
    }

    #[test]
    fn re_record_updates_timestamp() {
        let db = AppDb::open_in_memory().unwrap();
        db.record_recent_vault("/a").unwrap();
        db.record_recent_vault("/b").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        db.record_recent_vault("/a").unwrap(); // bump /a to newest
        let list = db.list_recent_vaults().unwrap();
        assert_eq!(list[0].path, "/a");
    }

    #[test]
    fn pin_survives_trim() {
        let db = AppDb::open_in_memory().unwrap();
        db.record_recent_vault("/pinned").unwrap();
        db.pin_recent_vault("/pinned", true).unwrap();
        for i in 0..(MAX_RECENT_VAULTS + 5) {
            db.record_recent_vault(&format!("/v{i}")).unwrap();
        }
        let list = db.list_recent_vaults().unwrap();
        assert!(list.iter().any(|v| v.path == "/pinned" && v.pinned));
        // Only `MAX_RECENT_VAULTS` non-pinned + 1 pinned should survive.
        let unpinned_count = list.iter().filter(|v| !v.pinned).count();
        assert_eq!(unpinned_count, MAX_RECENT_VAULTS);
    }

    #[test]
    fn remove_drops_row() {
        let db = AppDb::open_in_memory().unwrap();
        db.record_recent_vault("/a").unwrap();
        db.remove_recent_vault("/a").unwrap();
        assert!(db.list_recent_vaults().unwrap().is_empty());
    }
}
