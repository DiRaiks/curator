# Shell v2

The app shell implemented from `design/design_handoff_shell_v2/`
(VSCode-style rail + Zed-style agent). This doc covers the frontend
architecture and the non-obvious decisions; the agent panel's
multi-chat internals live in [multi-chat.md](./multi-chat.md).

## Layout

```
[native OS titlebar]
[app header 34px — curator · vault chip (path · branch ±N) · recs/⌘K/refresh/close]
[rail 52][left panel 268 (agent 320–560)][center: editor / legacy views][files 200–320]
[statusbar 24px]
```

- **Rail** (`shell/Rail.tsx`) — one icon per surface: projects, search,
  git (badge = changed files), skills, drafts (badge), cve, diag
  (badge = errors, red); bottom group: agent (amber pulse while any
  chat runs), settings. Clicking the active icon closes the panel.
- **Left panel** — exactly one at a time. Simple data-pure panels live
  in `shell/LeftPanel.tsx`; `PanelGit` / `PanelCve` own async state and
  have their own files; the agent panel is `RunPanelHost`.
- **Files** (`shell/ShellFiles.tsx`) — always visible on the right;
  drafts subtree accented with a count badge on `01_inbox/_drafts/`.
- **Center** — the markdown editor (`ide-editor`) plus the legacy
  views that still need main-pane room (ProjectDetail, ArtifactList,
  DraftsList, HistoryPanel, SourceControlPanel), navigated from the
  panels. These are mid-migration: shell palette via bridged CSS vars,
  markup still their own.
- **Statusbar** (`shell/ShellStatusBar.tsx`) — running-chat segment
  (exactly 1 running → its title; >1 → "N running"; 0 → hidden),
  `N running · M chats`, `✕ errors ⚠ warnings` (opens diag), then
  file mode / UTF-8 / theme toggle / `watching · N`.

## State & persistence

Shell state is deliberately tiny (`Dashboard.tsx`):

```ts
activePanel: PanelId | null   // incl. "agent" and "settings"
editorMode:  "src" | "split" | "prev"
activeFile / openFiles        // multi-buffer editor (LRU cap 8)
theme:       "graphite" | "porcelain"
```

Persisted to localStorage under `vide.shell.v1` (`shell/types.ts`
exports the key): `{theme, activePanel, agentWidth, filesWidth}`.
`loadShellTheme()` reads just the theme for pre-vault screens
(Welcome, empty-vault gates) — they wrap themselves in
`.ide <theme>` so the legacy styles pick up the palette.

Every count shown in two places comes from one source: the vault
`GitStatus` snapshot lives in Dashboard and feeds the rail git badge,
the header `±N`, and the Source Control panel; `RunStatusInfo`
(aggregated by RunPanelHost) feeds the rail pulse, the statusbar chat
segments, and artifact "running" chips.

## Resize rules

Agent panel 320–560px (right-edge handle), files 200–320px (left-edge
handle) — `shell/useDragWidth.ts`. When the center would drop below
480px the left panel auto-collapses (window resize or drag).

## Keyboard

⌘K palette (`shell/ShellPalette.tsx` — commands + file jump),
⌘J agent panel, ⌘B toggle left panel, ⌘1/2/3 editor modes, ⌘S save,
⌘↵ send chat.

## Editor

CodeMirror 6 markdown, deliberately NOT a code editor: no gutters /
line numbers / minimap; 13px mono, 1.85 line-height, wrapped, max
760px. Theme + light syntax coloring map onto the `--sx-*` CSS vars
(`EditorPanel.tsx`: `EditorView.theme` + `HighlightStyle`), so the
graphite/porcelain toggle restyles without a re-mount. `[[wikilinks]]`
are painted by a `MatchDecorator` (lezer's markdown grammar doesn't
know them). Pass `theme="none"` to `@uiw/react-codemirror` — its
default `light` theme paints a white background over ours.
Frontmatter: editable form in src/split; read-only `fm-card` grid in
preview.

## CSS conventions

- All shell styling lives in `shell.css`, scoped under `.ide`. Tokens
  are the design handoff's graphite/porcelain tables verbatim.
- Shared atoms are prefixed (`.ide-btn`, `.ide-pill`, `.ide-chip`,
  `.ide-row`, …) so they can't collide with legacy `styles.css`
  classes during the migration.
- **Bridge variables**: `.ide` maps legacy token names (`--text`,
  `--font-mono`, `--bg-sub`) onto shell tokens, which is what makes
  the un-migrated center views adopt the palette for free.
- **The `:where()` reset gotcha**: the button reset is
  `:where(.ide) button { … }`. The bare `.ide button` form has
  specificity (0,1,1) and silently beats every one-class component
  selector (0,1,0) — it stripped `.ide-row`'s 14px padding and every
  button's padding until wrapped. Keep zero-specificity resets.

## Popovers

`hooks/usePopoverPosition.ts` — flip + size behaviour of floating-ui
without the dependency: `placement` is a preference (flips to the
roomier side under 240px of space), and the returned style carries
`maxHeight` = the chosen side's free space + `overflowY: auto`, so
content scrolls instead of escaping the viewport. Use it for any new
floating menu before reaching for a library.
