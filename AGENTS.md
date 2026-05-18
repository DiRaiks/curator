# Agent Instructions

## Package manager policy

This repository is standardized on **npm** for supply-chain governance.

Rules:

1. Do **not** use pnpm, yarn, or bun. Do not create `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `yarn.lock`, or `bun.lockb`. If one appears, delete it.
2. The only lockfile is `package-lock.json`.
3. `package.json` must declare `"packageManager": "npm@<current-version>"`.
4. Do **not** switch package managers without explicit maintainer approval.
5. Do **not** add a dependency (runtime or dev, npm or cargo) without first
   explaining all of:
   - package name
   - why it is needed
   - whether it is runtime or dev
   - alternatives considered
   - supply-chain risk (maintainership, popularity, transitive footprint)
6. Do **not** run install commands (`npm install`, `npm i`, `cargo build`,
   `cargo add`, etc.) without maintainer approval.
7. Do not modify lockfiles casually.

## Security posture

This is a security-first project. Prefer boring, widely adopted, well-governed
tools over faster or more convenient alternatives.
