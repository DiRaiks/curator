//! `cargo run -p vault-core --example runner_prompt -- <vault> <project> <prompt>`
//!
//! Prints the external runner prompt that would be copied into a Zed/Claude
//! Code/Codex/Cursor session. Sanity helper for spot-checking real-vault
//! output without launching the GUI.

use std::env;

use vault_core::preview_context;

fn main() {
    let vault = env::args()
        .nth(1)
        .expect("usage: runner_prompt <vault-path> <project-slug> <prompt-id>");
    let project = env::args().nth(2).expect("missing project slug");
    let prompt = env::args().nth(3).expect("missing prompt id");

    let r = preview_context(std::path::Path::new(&vault), &project, &prompt)
        .expect("preview ok");
    print!("{}", r.external_runner_prompt);
    if !r.unresolved_placeholders.is_empty() {
        eprintln!(
            "\n--- unresolved placeholders: {:?}",
            r.unresolved_placeholders
        );
    }
}
