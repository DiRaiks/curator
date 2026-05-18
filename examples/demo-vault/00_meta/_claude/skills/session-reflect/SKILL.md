---
name: session-reflect
description: |
  Look at what changed in the project repo and the vault during the
  current working session and propose reusable knowledge notes for the
  user to review.

  Each proposal is written as a draft in `01_inbox/_drafts/` with
  `status: draft-from-agent` and `proposed_destination` set to the
  vault path where it should live after promotion. The user then
  reviews and decides in the Drafts tab of the IDE.

  Run this AT THE END of a session, not after every individual task —
  reflection is a separate, deliberate step, not a tax on every run.
version: "0.1.0"
status: stable
---

# Session reflection

You are running at the end of a working session. Your job is to look
back at what happened during this session and propose **reusable
knowledge notes** that the user might want to keep in their vault.

You are NOT writing the user's main deliverables. You are writing
**memos to the user's future self** — patterns observed, decisions
made, gotchas discovered, threats identified.

## Inputs

For the current project, examine:

1. **Repo state**: run `git log --since="6 hours ago"` and `git diff
   HEAD~5...HEAD` (or however far back makes sense given the volume).
   What changed? Why?
2. **Vault state**: read `02_projects/<slug>/_index.md` and any files
   modified during this session under `02_projects/<slug>/`.
3. **Recent agent transcripts** (if available): notice patterns the
   agent itself solved or hit.

If you can't access something, ask for it instead of guessing.

## Output: a curated set of drafts

For each piece of reusable knowledge you identified, write **one
draft file** into `01_inbox/_drafts/`. Each file:

```markdown
---
title: <short, descriptive>
status: draft-from-agent
proposed_destination: <vault-relative path you suggest>
reason: <one-line why-keep-this>
source_run: <a stable id you can stamp — date + topic is fine>
project: <slug>
created: <YYYY-MM-DD>
tags: [<relevant>]
type: <pattern | decision | observation | post-mortem | finding>
---

# <title>

<the actual content — 5-30 lines is the sweet spot; longer is okay
when it's truly worth keeping>

## Why this matters

<one paragraph: when will future-you want this?>

## Where this was first observed

<link to the project + commits / files / runs that produced it>
```

## Suggested destinations

Pick whichever fits:

- **Patterns** (reentrancy, oracle manipulation, MEV, etc.):
  `03_areas/patterns/<topic>/<short-name>.md`
- **Reusable CVE writeups**: `04_resources/cve-kb/CVE-YYYY-NNNNN.md`
- **Codebase knowledge** (architecture, idioms specific to a repo
  you'll work with again): `04_resources/codebases/<repo>/<topic>.md`
- **Decisions** specific to this project (ADRs):
  `02_projects/<slug>/decisions/NNNN-<topic>.md`
- **Post-mortems** for failures encountered this session:
  `02_projects/<slug>/post-mortems/<date>-<topic>.md`

## What to skip

- Don't propose notes about tactical, one-off work. Filter for things
  the user would actively want to recall in 3 months.
- Don't propose duplicates of notes that already exist (`grep -r` the
  proposed destination first).
- Don't write more than 5 drafts per session — a flood defeats the
  purpose. If there's more, propose the top 5 by reusability.

## Do NOT promote the drafts yourself

You write them only into `01_inbox/_drafts/`. The user reviews each
one in the IDE's **Drafts** tab and promotes them with one click. If
the user can't act on it from the Drafts UI, you wrote it wrong.

## Quality bar

A good draft answers: "When future-me hits a similar situation, what
would I want to read first?"

If you can't answer that for a candidate draft, don't write it.
