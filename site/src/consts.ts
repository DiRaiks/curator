export const SITE = {
  name: "Curator",
  tagline: "Agents work. The vault remembers.",
  description:
    "A desktop memory-augmented agentic IDE for Markdown knowledge vaults. Open a vault, run an embedded AI runner on your projects, and let accumulated knowledge outlive every chat session.",
  repo: "https://github.com/DiRaiks/curator",
  url: "https://diraiks.github.io/curator",
};

const base = import.meta.env.BASE_URL.replace(/\/$/, "");
export const withBase = (path: string) => `${base}/${path.replace(/^\//, "")}`;

export const NAV = [
  { label: "Why", href: "#why" },
  { label: "Features", href: "#features" },
  { label: "Security", href: "#security" },
  { label: "Docs", href: withBase("/docs/quick-start") },
];

export type Capability = {
  icon: string;
  title: string;
  body: string;
};

// "What you can do today" — six current capabilities from the project brief.
export const CAPABILITIES: Capability[] = [
  {
    icon: "ph:tree-structure",
    title: "Browse",
    body: "Projects, artifacts (skills / commands / agents / prompts), drafts, and privacy zones. A tree plus frontmatter pills give vault state at a glance.",
  },
  {
    icon: "ph:pencil-simple-line",
    title: "Edit",
    body: "Markdown in CodeMirror with rendered preview, an editable frontmatter form, and wikilink navigation across the whole vault.",
  },
  {
    icon: "ph:play-circle",
    title: "Run",
    body: "Drive any artifact against a project through a vendored ACP runner (Claude or Codex). Up to three chats run concurrently with inline tool-call approval.",
  },
  {
    icon: "ph:funnel",
    title: "Curate",
    body: "Agents drop proposed knowledge notes into an inbox. Review each draft, then Promote it to its permanent home or Discard it. Promotion is always your call.",
  },
  {
    icon: "ph:eye",
    title: "Watch",
    body: "A filesystem watcher fires on debounced file activity and rescans automatically, so the IDE stays in sync with edits made anywhere.",
  },
  {
    icon: "ph:chart-line-up",
    title: "Track",
    body: "Session history, recent vaults, a CVE scan against project dependencies, and a rule-based recommendations engine over vault state.",
  },
];

export const STACK = [
  {
    name: "Tauri v2",
    role: "Desktop shell. No backend server, no cloud.",
  },
  {
    name: "React + TypeScript + Vite",
    role: "The frontend and curation surface.",
  },
  {
    name: "Rust",
    role: "vault-core: scanning, watching, the runner abstraction, vault-rooted file IO.",
  },
];

export const PRIVACY = [
  {
    icon: "ph:cloud-slash",
    title: "No telemetry, no cloud, no auth",
    body: "A single-user desktop tool. Nothing leaves your machine and there is no account to create.",
  },
  {
    icon: "ph:hand-palm",
    title: "Interactive tool approval",
    body: "Every agent tool call surfaces an inline permission card. Your global Claude allowlist still applies underneath.",
  },
  {
    icon: "ph:shield-check",
    title: "Sandboxed working directory",
    body: "Subprocess workdirs are canonicalized and checked against a deny-list of sensitive paths so a vault can never redirect an agent into credential locations.",
  },
  {
    icon: "ph:git-diff",
    title: "Git is the safety model",
    body: "The vault is git-tracked source of truth. The IDE never auto-commits; you review every agent write with git diff before it lands.",
  },
];
