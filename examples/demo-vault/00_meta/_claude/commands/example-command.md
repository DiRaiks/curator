---
description: Demo Claude slash command. Name derived from filename.
---

# /example-command

Mirrors the real-vault layout: each Claude slash command is a single Markdown
file in `00_meta/_claude/commands/`. The scanner reports this as
`kind: claude-command` with `runnable: false`. Future slices may execute these
via a sandboxed Claude Code CLI runner.
