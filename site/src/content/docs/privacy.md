---
title: Privacy & security
description: The privacy and security model behind Curator.
order: 3
---

# Privacy & security

Curator is built for people who cannot send their work to a third party:
security researchers, audit firms, internal security teams, and consultants.

## No telemetry, no cloud, no auth

It is a single-user desktop tool. Nothing leaves your machine, there is no
account to create, and there is no cloud sync.

## Interactive tool-use approval

Tool-use approval is interactive via an inline permission card driven by ACP's
`session/request_permission` RPC. The vault is expected to be git-tracked, so
you review agent writes via `git diff` before committing. Persistent allow/deny
rules per chat are on the roadmap.

## Sandboxed working directory

The working directory for spawned subprocesses is canonicalized and checked
against a deny-list of sensitive paths (`/etc`, `/Library`, `~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, and others), so a vault-declared
`local_path` can't redirect the agent into credential locations.

## Vault-rooted write validation

Promoting drafts and writing files always goes through vault-rooted path
validation. Symlink escape, `..` traversal, and writes into `.git/`,
`node_modules/`, `target/`, `.next/`, `dist/`, `build/`, and the root
`.claude/` directory are all rejected.

## Privacy zones

Personal-work and team-management zones are excluded from the default AI
context. A per-zone opt-in toggle is on the roadmap.

## Git is the safety model

The single most important property: the vault is the git-tracked source of
truth, and the IDE never auto-commits. Every change an agent makes is a working
-tree edit you can read, diff, and revert before it becomes permanent.
