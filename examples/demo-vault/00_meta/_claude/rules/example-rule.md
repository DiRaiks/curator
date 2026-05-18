---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Example rule

Mirrors the real-vault layout: each Claude rule is a single Markdown file in
`00_meta/_claude/rules/` with a `paths` glob list in the frontmatter telling
Claude Code when to auto-load the rule. The scanner reports this as
`kind: claude-rule` with `runnable: false` — rules are policy artifacts, not
executable.
