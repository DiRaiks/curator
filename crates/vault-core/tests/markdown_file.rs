//! Integration tests for the Markdown reader/writer.
//!
//! Read tests use the bundled `examples/demo-vault` (never mutated). Write
//! and create tests use per-process temp vaults so they don't collide and
//! don't leave global state behind.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use vault_core::{
    create_markdown_file, read_markdown_file, write_markdown_file, MarkdownFileError,
};

fn demo_vault_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("examples")
        .join("demo-vault")
        .canonicalize()
        .expect("demo vault path resolves")
}

fn unique_temp_vault(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("vw-md-{tag}-{pid}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("temp vault create");
    dir
}

#[test]
fn read_existing_md_file_in_demo_vault() {
    let content = read_markdown_file(&demo_vault_path(), "00_meta/AGENTS.md").expect("read ok");
    assert!(
        content.contains("Instructions for AI agents"),
        "expected demo AGENTS.md content"
    );
}

#[test]
fn read_rejects_non_md_path() {
    let err = read_markdown_file(&demo_vault_path(), "00_meta/README")
        .expect_err("must reject non-md path");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
}

#[test]
fn write_updates_existing_file() {
    let temp = unique_temp_vault("write-update");
    std::fs::write(temp.join("test.md"), "original").unwrap();

    write_markdown_file(&temp, "test.md", "updated body").expect("write ok");
    let read_back = std::fs::read_to_string(temp.join("test.md")).unwrap();
    assert_eq!(read_back, "updated body");

    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn write_rejects_missing_file() {
    let temp = unique_temp_vault("write-missing");
    let err = write_markdown_file(&temp, "absent.md", "data")
        .expect_err("write to missing file should error");
    assert!(matches!(err, MarkdownFileError::NotFound(_)));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn write_rejects_path_outside_vault() {
    let temp = unique_temp_vault("write-outside");
    let err =
        write_markdown_file(&temp, "../escape.md", "data").expect_err("traversal must be rejected");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn write_rejects_git_path() {
    let temp = unique_temp_vault("write-git");
    std::fs::create_dir_all(temp.join(".git")).unwrap();
    std::fs::write(temp.join(".git/test.md"), "x").unwrap();
    let err = write_markdown_file(&temp, ".git/test.md", "x").expect_err(".git must be rejected");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn write_rejects_obsidian_path() {
    let temp = unique_temp_vault("write-obsidian");
    std::fs::create_dir_all(temp.join(".obsidian")).unwrap();
    std::fs::write(temp.join(".obsidian/test.md"), "x").unwrap();
    let err = write_markdown_file(&temp, ".obsidian/test.md", "x")
        .expect_err(".obsidian must be rejected");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn write_rejects_root_claude_path() {
    let temp = unique_temp_vault("write-root-claude");
    std::fs::create_dir_all(temp.join(".claude")).unwrap();
    let err = write_markdown_file(&temp, ".claude/notes.md", "x")
        .expect_err("root .claude must be rejected");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn write_rejects_bak_suffix() {
    let temp = unique_temp_vault("write-bak");
    let err =
        write_markdown_file(&temp, "foo.md.bak", "x").expect_err(".bak suffix must be rejected");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn create_writes_template() {
    let temp = unique_temp_vault("create-template");
    let content = create_markdown_file(&temp, "sub/dir/new-note.md").expect("create ok");

    assert!(content.starts_with("---\ntype: note"));
    assert!(content.contains("**Summary**: TODO"));
    assert!(content.contains("# new-note"));
    assert!(content.contains("TODO\n"));

    let on_disk = std::fs::read_to_string(temp.join("sub/dir/new-note.md")).expect("file on disk");
    assert_eq!(on_disk, content);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn create_rejects_existing_file() {
    let temp = unique_temp_vault("create-exists");
    std::fs::write(temp.join("exists.md"), "old").unwrap();

    let err = create_markdown_file(&temp, "exists.md").expect_err("must reject existing");
    assert!(matches!(err, MarkdownFileError::AlreadyExists(_)));
    // Existing content must not be touched.
    let on_disk = std::fs::read_to_string(temp.join("exists.md")).unwrap();
    assert_eq!(on_disk, "old");
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn create_rejects_node_modules() {
    let temp = unique_temp_vault("create-node-modules");
    let err = create_markdown_file(&temp, "node_modules/lib/readme.md")
        .expect_err("node_modules must be rejected at any depth");
    assert!(matches!(err, MarkdownFileError::InvalidPath(_)));
    let _ = std::fs::remove_dir_all(&temp);
}
