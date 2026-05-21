//! Shared SQLite-backed persistence for the IDE.
//!
//! [`AppDb`] owns a single SQLite connection and applies the schema for
//! every domain that needs durable per-machine state:
//!
//! - **Sessions** — chat history (see [`sessions`])
//! - **Dismissed recommendations** — vault-scoped rec ids the user hid
//!   (see [`dismissed`])
//! - **Recent vaults** — last-opened list for the Welcome screen (see
//!   [`recents`])
//!
//! Consolidating these into one file is deliberate. Earlier each of
//! them lived in its own JSON file or DB, which produced three
//! disjoint persistence stories — different code, different migration
//! paths, different failure modes — for very similar data. One DB
//! collapses them onto one schema + one migration path.

mod migration;

pub mod dismissed;
pub mod recents;
pub mod sessions;

pub use migration::{migrate_legacy_json, LegacyJsonReport};

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

#[derive(Debug, thiserror::Error)]
pub enum AppDbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json encode/decode error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("internal: {0}")]
    Internal(String),
}

/// Thread-safe shared SQLite store. `Connection` itself is `Send` but
/// not `Sync`, so we wrap it in a `Mutex`. Operations are short
/// (microseconds to a few ms), so a global lock is fine for the IDE's
/// single-window workload.
pub struct AppDb {
    pub(crate) conn: Mutex<Connection>,
}

impl AppDb {
    /// Open (or create) the database at `db_path` and apply every
    /// table's schema. Safe to call concurrently — SQLite handles
    /// file-level locking and `CREATE TABLE IF NOT EXISTS` is
    /// idempotent.
    pub fn open(db_path: &Path) -> Result<Self, AppDbError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppDbError::Internal(format!("mkdir: {e}")))?;
        }
        let conn = Connection::open(db_path)?;
        Self::apply_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// In-memory store, used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, AppDbError> {
        let conn = Connection::open_in_memory()?;
        Self::apply_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Apply every domain's schema. Each statement is `IF NOT EXISTS`
    /// so re-opening an existing DB is a no-op. Future migrations will
    /// gate behind `PRAGMA user_version` here.
    fn apply_schema(conn: &Connection) -> Result<(), AppDbError> {
        conn.execute_batch(sessions::SCHEMA_SQL)?;
        conn.execute_batch(dismissed::SCHEMA_SQL)?;
        conn.execute_batch(recents::SCHEMA_SQL)?;
        // Idempotent column-add migrations for older DBs. New columns
        // appended below SCHEMA_SQL's CREATE TABLE statements arrive
        // for legacy users via these calls. Each migrate fn is
        // expected to swallow "duplicate column name" so calling on a
        // fresh DB is a no-op.
        sessions::migrate_add_runner_column(conn)?;
        Ok(())
    }

    /// Lock the connection, recovering from poisoning. Same rationale
    /// as elsewhere — a panic in one thread holding the lock should
    /// not freeze the UI permanently.
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }
}
