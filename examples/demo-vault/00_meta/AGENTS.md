---
type: meta
tags: [meta, vault-conventions]
created: 2026-05-17
updated: 2026-05-17
---

**Summary**: Conventions any AI agent should follow when working on this demo
vault. Mirrors the real-vault `00_meta/AGENTS.md` shape so the scanner has
something realistic to recognize.

# Instructions for AI agents

## Read first

1. `00_meta/ABOUT_ME.md` — who owns this vault.
2. `00_meta/AGENTS.md` — this file.
3. For project work: `02_projects/<project>/_index.md`.

## Where things live

- `00_meta/` — rules, prompts, skills, templates. System zone.
- `02_projects/<slug>/` — one folder per project, each with an `_index.md`.
- `.vault/skills/*.skill.md` — future home for vault-managed skills.

## Don't

- Don't invent new top-level folders.
- Don't delete notes without confirmation.
- Don't change frontmatter casually.
