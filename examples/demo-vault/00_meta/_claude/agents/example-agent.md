---
name: example-agent
description: Demo claude-agent so the scanner has something to surface under 00_meta/_claude/agents/. Tools list is security-relevant.
tools:
  - Read
  - Grep
  - Glob
model: sonnet
---

# Example agent

Mirrors the real-vault layout: each Claude sub-agent is a single Markdown file
in `00_meta/_claude/agents/` with `name`, `description`, `tools`, and `model`
in the frontmatter. The scanner reports this as `kind: claude-agent` with
`runnable: false`.
