---
type: meta
tags: [meta]
created: 2026-05-17
updated: 2026-05-17
---

**Summary**: Demo vault that mirrors the **current** real-vault conventions
Curator recognizes. Sanitized fixture for onboarding and tests —
not the source of truth for any real workflow.

# demo-vault

```
00_meta/
  README.md
  AGENTS.md
  ABOUT_ME.md
  agent-tasks/
    README.md
    prompts/
      01-domain.md
      02-architecture.md
      04-threat-model.md
  _claude/
    README.md
    skills/
      example/
        SKILL.md
01_inbox/
  idea-2026-05-17.md            ← inbox zone (scope: unknown)
03_areas/
  team/weekly-sync.md           ← team-management zone
  people/alex-demo.md           ← team-management zone
06_daily/
  2026-05-17.md                 ← personal-work zone
02_projects/
  sample-project/
    _index.md                   ← full frontmatter (repo, local_path, status, …)
    01_intake.md
    02_plan.md
    journal/
      2026-05-17.md             ← project + journal/ → personal-work
    private-decision-2026-05-17.md   ← project + fm scope override → personal-work
    research/
      2026-05-old-notes.md.bak  ← triggers .bak info diagnostic
  empty-project/
    _index.md                   ← minimal frontmatter
  no-index-project/
    notes.md                    ← triggers "project missing _index.md" warning
```

What the scanner reports after opening this folder:

- `meta: present` (00_meta/ exists), `git: missing` (no `.git/`)
- 3 agent-prompts (in `00_meta/agent-tasks/prompts/`)
- 1 claude-skill (in `00_meta/_claude/skills/example/`)
- 0 vault-skills — `.vault/skills/*.skill.md` is a forward-looking shape and
  is exercised by `crates/vault-core/tests/fixtures/vault-skill/` instead
- 2 projects (sample-project, empty-project)
- 1 warning (no-index-project missing `_index.md`)
- 1 info (`.bak` file)
- 5 private-zone info diagnostics (06_daily, 03_areas/team, 03_areas/people,
  01_inbox, 02_projects/sample-project/journal)
