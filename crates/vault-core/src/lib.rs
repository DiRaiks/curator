//! Vault scanning + run-plan preview for the Vault Workflow IDE MVP.
//!
//! The MVP execution path is:
//!     open vault → select project → select workflow → simple run plan →
//!     sandbox workspace → runner → output file → diff → apply.
//!
//! This crate implements the first half of that path:
//!
//! - [`scan_vault`] walks a Markdown vault and produces a [`ScanResult`]
//!   containing projects, AI workflow artifacts, document zones, and
//!   diagnostics.
//! - [`preview_context`] turns a (project, workflow) selection into a
//!   [`ContextPreview`] — a simple run plan that lists the vault files that
//!   would be made available, the source repo status, what's excluded by
//!   privacy policy, and any warnings.
//! - [`inspect_source_repo`] reports a read-only snapshot of the project's
//!   `local_path` (exists / is-git / branch / dirty / known files).
//! - [`read_markdown_file`] / [`write_markdown_file`] /
//!   [`create_markdown_file`] are the only sanctioned mutators of the vault
//!   on disk. They enforce vault-rooted path validation and forbid writes
//!   into runtime / secret-bearing locations.

mod types;
pub use types::*;

mod util;
mod frontmatter;
mod scope;
mod artifacts;

mod scan;
pub use scan::{scan_vault, ScanError};

mod preview;
pub use preview::{preview_context, PreviewError};

mod source_repo;
pub use source_repo::{inspect_source_repo, SourceRepoInspection, TopLevelEntry};

mod markdown_io;
pub use markdown_io::{
    create_markdown_file, read_markdown_file, write_markdown_file, MarkdownFileError,
};

pub mod watch;
