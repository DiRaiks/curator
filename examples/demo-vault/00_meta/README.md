---
type: meta
tags: [meta]
created: 2026-05-17
updated: 2026-05-17
---

**Summary**: Demo vault meta folder. Mirrors the real-vault convention used by
Curator — `00_meta/` holds rules, the AI-agent profile, and prompts.

# 00_meta — demo vault

| File | What |
| --- | --- |
| `README.md` | This file |
| `AGENTS.md` | Conventions for any AI agent operating on this vault |
| `ABOUT_ME.md` | Profile / context for the vault owner |
| `agent-tasks/prompts/*.md` | Numbered prompts that populate a project KB |
| `_claude/skills/<slug>/SKILL.md` | Claude-style skill packages |

The scanner treats this folder as the "system zone" and surfaces presence
flags (`meta`, `git`) in the dashboard header.
