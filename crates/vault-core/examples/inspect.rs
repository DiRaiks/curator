//! `cargo run -p vault-core --example inspect -- <repo-path>`
//!
//! Smoke helper: prints the SourceRepoInspection summary for a local path.
//! Useful for spot-checking real-vault projects without launching the GUI.

use std::env;

use vault_core::inspect_source_repo;

fn main() {
    let path = env::args().nth(1).expect("usage: inspect <local_path>");
    let r = inspect_source_repo(std::path::Path::new(&path));

    println!("local_path:  {}", r.local_path);
    println!("exists:      {}", r.exists);
    println!("is_git_repo: {}", r.is_git_repo);
    if let Some(b) = r.branch {
        println!("branch:      {b}");
    }
    if let Some(d) = r.dirty {
        println!("dirty:       {}", if d { "dirty" } else { "clean" });
    }
    if let Some(c) = r.short_commit {
        println!("commit:      {c}");
    }
    if !r.detected.is_empty() {
        println!("detected:    {}", r.detected.join(", "));
    }
    println!("top_level ({} items):", r.top_level.len());
    for e in r.top_level.iter().take(20) {
        println!("  {}{}", e.name, if e.is_dir { "/" } else { "" });
    }
}
