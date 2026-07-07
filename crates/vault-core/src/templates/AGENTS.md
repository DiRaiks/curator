---
type: meta
tags: [agents, conventions]
---

# Vault Agents — guidelines

This file documents how AI agents should work inside this vault.

## Scope

- AI runs read from `02_projects/<slug>/` and `00_meta/` by default.
- Drafts proposed by agents land in `01_inbox/_drafts/` for review.

## Write rules

- Never edit files outside the project's own directory unless the user
  explicitly asks.
- Prefer creating drafts over overwriting existing notes.
- Preserve frontmatter when editing — keep `created` / `updated` valid.

## Tools

- File-edit tools (Write, Edit) are auto-approved within the project
  scope. Other tools (Bash, network) require explicit user approval
  per session.

## Privacy

- Files marked `scope: personal-work` or `scope: team-management` are
  never sent to AI models.
