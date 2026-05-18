//! Integration test for the `vault-skill` discovery path.
//!
//! `.vault/skills/*.skill.md` is a forward-looking convention — no real vault
//! (and not the demo vault) uses it today. The scanner is still required to
//! recognize it, so coverage lives in a dedicated fixture here rather than in
//! `examples/demo-vault/`.

use std::path::PathBuf;

use vault_core::{scan_vault, ArtifactKind};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("vault-skill")
        .canonicalize()
        .expect("vault-skill fixture exists")
}

#[test]
fn vault_skill_fixture_yields_one_vault_skill() {
    let r = scan_vault(&fixture_path()).expect("scan succeeds");

    let vault_skills: Vec<_> = r
        .artifacts
        .iter()
        .filter(|a| matches!(a.kind, ArtifactKind::VaultSkill))
        .collect();
    assert_eq!(vault_skills.len(), 1, "expected exactly 1 vault-skill");

    let a = vault_skills[0];
    assert_eq!(a.id, "intake");
    assert_eq!(a.title, "Intake");
    assert!(
        a.runnable,
        "vault-skill should be runnable now that an embedded runner exists",
    );
    assert_eq!(a.version.as_deref(), Some("0.1.0"));
    assert_eq!(a.status.as_deref(), Some("stable"));
    assert_eq!(a.order, Some(1));
    assert_eq!(a.output_file.as_deref(), Some("01_intake.md"));
    assert_eq!(a.path, ".vault/skills/intake.skill.md");

    // Fixture has no other artifact kinds, and no projects.
    assert!(r.projects.is_empty());
    let other_kinds = r
        .artifacts
        .iter()
        .filter(|a| !matches!(a.kind, ArtifactKind::VaultSkill))
        .count();
    assert_eq!(other_kinds, 0);
}
