# Contributing

## Package manager policy

This repository is standardized on **npm** for supply-chain governance reasons.

### Rules

1. Use **npm** only. Do not use pnpm, yarn, or bun.
2. The only lockfile is `package-lock.json`. Do not create `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `yarn.lock`, or `bun.lockb`.
3. `package.json` declares `"packageManager": "npm@<current-version>"`. Keep it
   in sync with the npm version actually used to produce the lockfile.
4. Do **not** switch package managers without explicit maintainer approval.

### Adding a dependency

Before opening a PR that adds a dependency (npm **or** cargo), include in the
PR description:

- **package name**
- **why it is needed** — the concrete problem it solves in this repo
- **runtime or dev** dependency
- **alternatives considered** — including "write it ourselves" when reasonable
- **supply-chain risk** — maintainership, release cadence, popularity,
  transitive dependency footprint, known advisories

Avoid trivial-but-deep dependencies (`is-odd`, `left-pad`-style packages). Prefer
boring, widely adopted, well-governed packages.

### Install commands

Do **not** run install commands without maintainer approval. This includes:

- `npm install`, `npm i`, `npm ci`
- `cargo build`, `cargo add`, `cargo update`

These commands materialize / mutate lockfiles and must be done deliberately.

## Security posture

This is a security-first project. Prefer boring, widely adopted, well-governed
tools over faster or more convenient alternatives.
