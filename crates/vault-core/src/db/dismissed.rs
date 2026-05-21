//! Dismissed recommendations.
//!
//! When the user clicks "dismiss" on a recommendation chip, we record
//! the `(vault_root, rec_id)` pair here so the rule engine knows to
//! filter that id out on subsequent re-computations. Same data this
//! lived in the legacy `dismissed.json` before consolidation.

use rusqlite::params;

use super::{AppDb, AppDbError};

pub(super) const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS dismissed_recommendations (
    vault_root      TEXT    NOT NULL,
    rec_id          TEXT    NOT NULL,
    dismissed_at_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (vault_root, rec_id)
);
"#;

impl AppDb {
    /// Mark a recommendation as dismissed for the given vault.
    /// Idempotent — re-dismissing a row updates the timestamp without
    /// duplicating it (composite primary key).
    pub fn dismiss_recommendation(&self, vault_root: &str, rec_id: &str) -> Result<(), AppDbError> {
        let conn = self.lock();
        conn.execute(
            r#"
            INSERT INTO dismissed_recommendations (vault_root, rec_id, dismissed_at_ms)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(vault_root, rec_id) DO UPDATE SET
                dismissed_at_ms = excluded.dismissed_at_ms
            "#,
            params![vault_root, rec_id, current_unix_ms()],
        )?;
        Ok(())
    }

    /// Undo a dismiss. Idempotent — removing an absent row is a no-op.
    pub fn restore_recommendation(&self, vault_root: &str, rec_id: &str) -> Result<(), AppDbError> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM dismissed_recommendations WHERE vault_root = ?1 AND rec_id = ?2",
            params![vault_root, rec_id],
        )?;
        Ok(())
    }

    /// List dismissed recommendation ids for a vault. Returned sorted
    /// so the frontend can use the value directly without re-sorting.
    pub fn list_dismissed(&self, vault_root: &str) -> Result<Vec<String>, AppDbError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT rec_id FROM dismissed_recommendations WHERE vault_root = ?1 ORDER BY rec_id",
        )?;
        let rows = stmt.query_map(params![vault_root], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Drop every dismissal for a vault. Used by "show all again" reset.
    pub fn clear_dismissals(&self, vault_root: &str) -> Result<(), AppDbError> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM dismissed_recommendations WHERE vault_root = ?1",
            params![vault_root],
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
    fn dismiss_then_list_round_trip() {
        let db = AppDb::open_in_memory().unwrap();
        db.dismiss_recommendation("/v", "rec-1").unwrap();
        db.dismiss_recommendation("/v", "rec-2").unwrap();
        let list = db.list_dismissed("/v").unwrap();
        assert_eq!(list, vec!["rec-1".to_string(), "rec-2".to_string()]);
    }

    #[test]
    fn dismiss_is_idempotent() {
        let db = AppDb::open_in_memory().unwrap();
        db.dismiss_recommendation("/v", "rec-1").unwrap();
        db.dismiss_recommendation("/v", "rec-1").unwrap();
        let list = db.list_dismissed("/v").unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn restore_removes_only_targeted_row() {
        let db = AppDb::open_in_memory().unwrap();
        db.dismiss_recommendation("/v", "rec-1").unwrap();
        db.dismiss_recommendation("/v", "rec-2").unwrap();
        db.restore_recommendation("/v", "rec-1").unwrap();
        assert_eq!(db.list_dismissed("/v").unwrap(), vec!["rec-2".to_string()]);
    }

    #[test]
    fn clear_dismissals_wipes_per_vault() {
        let db = AppDb::open_in_memory().unwrap();
        db.dismiss_recommendation("/a", "x").unwrap();
        db.dismiss_recommendation("/b", "y").unwrap();
        db.clear_dismissals("/a").unwrap();
        assert!(db.list_dismissed("/a").unwrap().is_empty());
        assert_eq!(db.list_dismissed("/b").unwrap(), vec!["y".to_string()]);
    }

    #[test]
    fn restore_absent_is_noop() {
        let db = AppDb::open_in_memory().unwrap();
        // Doesn't error, doesn't crash. Tests the idempotency contract
        // the frontend relies on when retrying after a transient fail.
        db.restore_recommendation("/v", "never-dismissed").unwrap();
    }
}
