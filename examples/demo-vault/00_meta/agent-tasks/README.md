---
type: guide
tags: [meta, agent-tasks, guide]
created: 2026-05-17
updated: 2026-05-17
---

**Summary**: How to use the agent-task prompts in `prompts/` to populate a
project's knowledge base.

# Agent tasks (demo)

Each prompt is intended for a single AI session and produces one output file in
`02_projects/<slug>/`. The order is meaningful — later prompts assume context
built by earlier ones.
