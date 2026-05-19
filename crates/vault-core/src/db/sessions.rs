//! Chat-session history.
//!
//! Each completed agent run (artifact or freeform) is upserted into the
//! `sessions` table keyed by `(vault_root, claude_session_id)`. The
//! output buffer is stored alongside metadata so the frontend can
//! restore an "exited" run state on Reopen and let the user continue
//! the conversation via `--resume`.
//!
//! Storage policy:
//! - At most [`MAX_ACTIVE_SESSIONS_PER_VAULT`] non-archived sessions per
//!   vault. Oldest non-archived are auto-deleted on save once the cap
//!   is exceeded.
//! - Archived sessions are never auto-deleted — the user opts into
//!   long-term keep via the Archive button.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{AppDb, AppDbError};

/// Per-vault cap on non-archived sessions. Tuned for a daily user with
/// ~5 chats/day → ~6 weeks of history before auto-trim kicks in. Users
/// wanting longer retention archive the sessions they care about.
pub const MAX_ACTIVE_SESSIONS_PER_VAULT: usize = 200;

pub(super) const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_root               TEXT    NOT NULL,
    claude_session_id        TEXT    NOT NULL,
    project_slug             TEXT    NOT NULL,
    prompt_id                TEXT    NOT NULL,
    workdir                  TEXT    NOT NULL,
    additional_dirs_json     TEXT    NOT NULL,
    freeform                 INTEGER NOT NULL,
    title                    TEXT    NOT NULL,
    output_lines_json        TEXT    NOT NULL,
    started_at_ms            INTEGER NOT NULL,
    ended_at_ms              INTEGER,
    exit_code                INTEGER,
    exit_success             INTEGER,
    input_tokens             INTEGER NOT NULL DEFAULT 0,
    output_tokens            INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
    cost_usd                 REAL    NOT NULL DEFAULT 0,
    model                    TEXT,
    archived                 INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_vault_session
    ON sessions(vault_root, claude_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_vault_started
    ON sessions(vault_root, started_at_ms DESC);
"#;

/// A single line from the run output stream — same shape the frontend
/// renders. Persisted as a string ("stdout" | "stderr" | "system") so
/// the JSON column is readable in `sqlite3` inspections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputLine {
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost_usd: f64,
    pub model: Option<String>,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            cost_usd: 0.0,
            model: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionInput {
    pub vault_root: String,
    pub claude_session_id: String,
    pub project_slug: String,
    pub prompt_id: String,
    pub workdir: String,
    pub additional_dirs: Vec<String>,
    pub freeform: bool,
    /// Truncated first user message — used as the list-row title.
    pub title: String,
    pub output_lines: Vec<OutputLine>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
    pub exit_success: Option<bool>,
    pub usage: UsageSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: i64,
    pub claude_session_id: String,
    pub vault_root: String,
    pub project_slug: String,
    pub prompt_id: String,
    pub freeform: bool,
    pub title: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_success: Option<bool>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub model: Option<String>,
    pub archived: bool,
    pub line_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFull {
    pub summary: SessionSummary,
    pub workdir: String,
    pub additional_dirs: Vec<String>,
    pub output_lines: Vec<OutputLine>,
}

impl AppDb {
    /// Upsert a session by `(vault_root, claude_session_id)`. Returns
    /// the row id. After saving, oldest non-archived rows for this
    /// vault are trimmed if the active count exceeds the cap.
    pub fn save_session(&self, input: SaveSessionInput) -> Result<i64, AppDbError> {
        let additional_dirs_json = serde_json::to_string(&input.additional_dirs)?;
        let output_lines_json = serde_json::to_string(&input.output_lines)?;

        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            INSERT INTO sessions (
                vault_root, claude_session_id, project_slug, prompt_id,
                workdir, additional_dirs_json, freeform, title,
                output_lines_json, started_at_ms, ended_at_ms,
                exit_code, exit_success,
                input_tokens, output_tokens, cache_creation_tokens,
                cache_read_tokens, cost_usd, model
            ) VALUES (
                ?1, ?2, ?3, ?4,
                ?5, ?6, ?7, ?8,
                ?9, ?10, ?11,
                ?12, ?13,
                ?14, ?15, ?16,
                ?17, ?18, ?19
            )
            ON CONFLICT(vault_root, claude_session_id) DO UPDATE SET
                project_slug         = excluded.project_slug,
                prompt_id            = excluded.prompt_id,
                workdir              = excluded.workdir,
                additional_dirs_json = excluded.additional_dirs_json,
                freeform             = excluded.freeform,
                title                = excluded.title,
                output_lines_json    = excluded.output_lines_json,
                ended_at_ms          = excluded.ended_at_ms,
                exit_code            = excluded.exit_code,
                exit_success         = excluded.exit_success,
                input_tokens         = excluded.input_tokens,
                output_tokens        = excluded.output_tokens,
                cache_creation_tokens = excluded.cache_creation_tokens,
                cache_read_tokens    = excluded.cache_read_tokens,
                cost_usd             = excluded.cost_usd,
                model                = excluded.model
            "#,
            params![
                input.vault_root,
                input.claude_session_id,
                input.project_slug,
                input.prompt_id,
                input.workdir,
                additional_dirs_json,
                input.freeform as i64,
                input.title,
                output_lines_json,
                input.started_at_ms,
                input.ended_at_ms,
                input.exit_code,
                input.exit_success.map(|b| b as i64),
                input.usage.input_tokens,
                input.usage.output_tokens,
                input.usage.cache_creation_tokens,
                input.usage.cache_read_tokens,
                input.usage.cost_usd,
                input.usage.model,
            ],
        )?;

        let id: i64 = tx.query_row(
            "SELECT id FROM sessions WHERE vault_root = ?1 AND claude_session_id = ?2",
            params![input.vault_root, input.claude_session_id],
            |r| r.get(0),
        )?;

        // Auto-trim: any non-archived rows past the cap for this vault
        // get deleted, oldest first. Archived rows are immune so users
        // can preserve important conversations beyond the rolling
        // window.
        tx.execute(
            r#"
            DELETE FROM sessions
            WHERE id IN (
                SELECT id FROM sessions
                WHERE vault_root = ?1 AND archived = 0
                ORDER BY started_at_ms DESC
                LIMIT -1 OFFSET ?2
            )
            "#,
            params![input.vault_root, MAX_ACTIVE_SESSIONS_PER_VAULT as i64],
        )?;

        tx.commit()?;
        Ok(id)
    }

    pub fn list_sessions(
        &self,
        vault_root: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionSummary>, AppDbError> {
        let conn = self.lock();
        let mut stmt = if include_archived {
            conn.prepare(
                r#"
                SELECT id, claude_session_id, vault_root, project_slug, prompt_id,
                       freeform, title, started_at_ms, ended_at_ms, exit_success,
                       input_tokens, output_tokens, cost_usd, model, archived,
                       output_lines_json
                FROM sessions
                WHERE vault_root = ?1
                ORDER BY started_at_ms DESC
                "#,
            )?
        } else {
            conn.prepare(
                r#"
                SELECT id, claude_session_id, vault_root, project_slug, prompt_id,
                       freeform, title, started_at_ms, ended_at_ms, exit_success,
                       input_tokens, output_tokens, cost_usd, model, archived,
                       output_lines_json
                FROM sessions
                WHERE vault_root = ?1 AND archived = 0
                ORDER BY started_at_ms DESC
                "#,
            )?
        };

        let rows = stmt.query_map(params![vault_root], row_to_summary)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_session(&self, id: i64) -> Result<SessionFull, AppDbError> {
        let conn = self.lock();
        let row = conn
            .query_row(
                r#"
                SELECT id, claude_session_id, vault_root, project_slug, prompt_id,
                       freeform, title, started_at_ms, ended_at_ms, exit_success,
                       input_tokens, output_tokens, cost_usd, model, archived,
                       output_lines_json, workdir, additional_dirs_json
                FROM sessions WHERE id = ?1
                "#,
                params![id],
                |row| {
                    let summary = SessionSummary {
                        id: row.get(0)?,
                        claude_session_id: row.get(1)?,
                        vault_root: row.get(2)?,
                        project_slug: row.get(3)?,
                        prompt_id: row.get(4)?,
                        freeform: row.get::<_, i64>(5)? != 0,
                        title: row.get(6)?,
                        started_at_ms: row.get(7)?,
                        ended_at_ms: row.get(8)?,
                        exit_success: row
                            .get::<_, Option<i64>>(9)?
                            .map(|v| v != 0),
                        input_tokens: row.get(10)?,
                        output_tokens: row.get(11)?,
                        cost_usd: row.get(12)?,
                        model: row.get(13)?,
                        archived: row.get::<_, i64>(14)? != 0,
                        line_count: 0,
                    };
                    let lines_json: String = row.get(15)?;
                    let workdir: String = row.get(16)?;
                    let additional_dirs_json: String = row.get(17)?;
                    Ok((summary, lines_json, workdir, additional_dirs_json))
                },
            )
            .optional()?
            .ok_or_else(|| AppDbError::NotFound(format!("session id={id}")))?;
        let (mut summary, lines_json, workdir, additional_dirs_json) = row;
        let output_lines: Vec<OutputLine> = serde_json::from_str(&lines_json)?;
        summary.line_count = output_lines.len() as i64;
        let additional_dirs: Vec<String> = serde_json::from_str(&additional_dirs_json)?;
        Ok(SessionFull {
            summary,
            workdir,
            additional_dirs,
            output_lines,
        })
    }

    pub fn archive_session(&self, id: i64, archived: bool) -> Result<(), AppDbError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE sessions SET archived = ?1 WHERE id = ?2",
            params![archived as i64, id],
        )?;
        if n == 0 {
            return Err(AppDbError::NotFound(format!("session id={id}")));
        }
        Ok(())
    }

    pub fn delete_session(&self, id: i64) -> Result<(), AppDbError> {
        let conn = self.lock();
        let n = conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(AppDbError::NotFound(format!("session id={id}")));
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn active_count(&self, vault_root: &str) -> Result<i64, AppDbError> {
        let conn = self.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE vault_root = ?1 AND archived = 0",
            params![vault_root],
            |r| r.get(0),
        )?;
        Ok(n)
    }
}

/// Map a SELECT row to a [`SessionSummary`]. The list query carries the
/// `output_lines_json` column too, but we only need its length to fill
/// `line_count` — we never deserialize the whole buffer for list view.
fn row_to_summary(row: &rusqlite::Row<'_>) -> Result<SessionSummary, rusqlite::Error> {
    let lines_json: String = row.get(15)?;
    let line_count: i64 = serde_json::from_str::<Vec<serde::de::IgnoredAny>>(&lines_json)
        .map(|v| v.len() as i64)
        .unwrap_or(0);
    Ok(SessionSummary {
        id: row.get(0)?,
        claude_session_id: row.get(1)?,
        vault_root: row.get(2)?,
        project_slug: row.get(3)?,
        prompt_id: row.get(4)?,
        freeform: row.get::<_, i64>(5)? != 0,
        title: row.get(6)?,
        started_at_ms: row.get(7)?,
        ended_at_ms: row.get(8)?,
        exit_success: row.get::<_, Option<i64>>(9)?.map(|v| v != 0),
        input_tokens: row.get(10)?,
        output_tokens: row.get(11)?,
        cost_usd: row.get(12)?,
        model: row.get(13)?,
        archived: row.get::<_, i64>(14)? != 0,
        line_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(vault: &str, sid: &str, started_at_ms: i64, title: &str) -> SaveSessionInput {
        SaveSessionInput {
            vault_root: vault.to_string(),
            claude_session_id: sid.to_string(),
            project_slug: "demo".to_string(),
            prompt_id: "chat".to_string(),
            workdir: "/tmp".to_string(),
            additional_dirs: vec![],
            freeform: true,
            title: title.to_string(),
            output_lines: vec![OutputLine {
                kind: "stdout".into(),
                text: "hi".into(),
            }],
            started_at_ms,
            ended_at_ms: Some(started_at_ms + 1000),
            exit_code: Some(0),
            exit_success: Some(true),
            usage: UsageSnapshot::default(),
        }
    }

    #[test]
    fn save_then_list_returns_inserted_row() {
        let db = AppDb::open_in_memory().unwrap();
        let id = db.save_session(sample("/v", "s1", 1000, "first")).unwrap();
        let list = db.list_sessions("/v", false).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].title, "first");
        assert_eq!(list[0].line_count, 1);
    }

    #[test]
    fn upsert_overwrites_same_session_id() {
        let db = AppDb::open_in_memory().unwrap();
        let id1 = db.save_session(sample("/v", "s1", 1000, "v1")).unwrap();
        let mut next = sample("/v", "s1", 1000, "v2");
        next.output_lines.push(OutputLine {
            kind: "system".into(),
            text: "more".into(),
        });
        let id2 = db.save_session(next).unwrap();
        assert_eq!(id1, id2);
        let full = db.get_session(id1).unwrap();
        assert_eq!(full.summary.title, "v2");
        assert_eq!(full.output_lines.len(), 2);
    }

    #[test]
    fn list_orders_newest_first() {
        let db = AppDb::open_in_memory().unwrap();
        db.save_session(sample("/v", "s1", 1000, "a")).unwrap();
        db.save_session(sample("/v", "s2", 3000, "c")).unwrap();
        db.save_session(sample("/v", "s3", 2000, "b")).unwrap();
        let list = db.list_sessions("/v", false).unwrap();
        let titles: Vec<&str> = list.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, vec!["c", "b", "a"]);
    }

    #[test]
    fn archive_hides_from_default_list_but_kept_with_include() {
        let db = AppDb::open_in_memory().unwrap();
        let id = db.save_session(sample("/v", "s1", 1000, "x")).unwrap();
        db.archive_session(id, true).unwrap();
        assert_eq!(db.list_sessions("/v", false).unwrap().len(), 0);
        let with_archived = db.list_sessions("/v", true).unwrap();
        assert_eq!(with_archived.len(), 1);
        assert!(with_archived[0].archived);
    }

    #[test]
    fn delete_removes_row() {
        let db = AppDb::open_in_memory().unwrap();
        let id = db.save_session(sample("/v", "s1", 1000, "x")).unwrap();
        db.delete_session(id).unwrap();
        assert_eq!(db.list_sessions("/v", true).unwrap().len(), 0);
        match db.delete_session(id) {
            Err(AppDbError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    #[test]
    fn auto_trim_drops_oldest_non_archived_past_cap() {
        let db = AppDb::open_in_memory().unwrap();
        let cap = MAX_ACTIVE_SESSIONS_PER_VAULT;
        for i in 0..(cap + 5) {
            let ts = 1000 + i as i64;
            let sid = format!("s{i}");
            db.save_session(sample("/v", &sid, ts, "x")).unwrap();
        }
        assert_eq!(db.active_count("/v").unwrap(), cap as i64);
        let list = db.list_sessions("/v", false).unwrap();
        let oldest_kept = list.last().unwrap();
        assert_eq!(oldest_kept.claude_session_id, "s5");
    }

    #[test]
    fn archived_sessions_are_immune_to_trim() {
        let db = AppDb::open_in_memory().unwrap();
        let oldest = db
            .save_session(sample("/v", "keep-me", 1, "archived"))
            .unwrap();
        db.archive_session(oldest, true).unwrap();
        let cap = MAX_ACTIVE_SESSIONS_PER_VAULT;
        for i in 0..(cap + 3) {
            let ts = 1000 + i as i64;
            let sid = format!("s{i}");
            db.save_session(sample("/v", &sid, ts, "x")).unwrap();
        }
        let full = db.get_session(oldest).unwrap();
        assert!(full.summary.archived);
        assert_eq!(db.active_count("/v").unwrap(), cap as i64);
    }

    #[test]
    fn separate_vaults_have_separate_caps() {
        let db = AppDb::open_in_memory().unwrap();
        db.save_session(sample("/a", "x", 1, "a")).unwrap();
        db.save_session(sample("/b", "x", 1, "b")).unwrap();
        assert_eq!(db.list_sessions("/a", false).unwrap().len(), 1);
        assert_eq!(db.list_sessions("/b", false).unwrap().len(), 1);
    }
}
