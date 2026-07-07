import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import CodeMirror, {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
// Direct imports of packages the lockfile already pins transitively
// (via @codemirror/lang-markdown → @codemirror/language → @lezer/highlight);
// needed to map the markdown highlight tags onto the shell's --sx-* vars.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { EditorViewMode } from "./EditorTabs";
import {
  parseMarkdown,
  serializeMarkdown,
  type FrontmatterValue,
} from "../utils/frontmatter";
import { FrontmatterForm } from "./FrontmatterForm";

interface EditorPanelProps {
  path: string;
  content: string;
  savedContent: string;
  saving: boolean;
  error: string | null;
  /** `Date.now()` of the buffer's last successful save, or `null`
   *  when it hasn't been saved this session. Drives the "saved Nm"
   *  label in the path row. */
  savedAtMs?: number | null;
  /** The file disappeared from the latest vault scan (deleted/moved
   *  externally). Save/Discard are disabled and a banner is shown; the
   *  in-memory buffer is preserved so the user doesn't lose work. */
  missing?: boolean;
  /** View mode driven by the parent (Dashboard) so the ⌘1/2/3
   *  shortcut applies globally; the segmented control in the path row
   *  reports clicks back through `onSetViewMode`. */
  viewMode: EditorViewMode;
  onSetViewMode: (mode: EditorViewMode) => void;
  onChange: (next: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
  /** Open another file inside the same vault. Used to resolve wikilink
   *  clicks in preview mode. Receives the raw wikilink target (e.g. the
   *  text between `[[…]]`) — the host decides how to resolve it. */
  onOpenWikilink?: (target: string) => void;
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

const VIEW_MODES: ReadonlyArray<{ id: EditorViewMode; label: string }> = [
  { id: "src", label: "src" },
  { id: "split", label: "split" },
  { id: "prev", label: "preview" },
] as const;

const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent || "");
const MOD_LABEL = isMac ? "⌘" : "Ctrl+";

/**
 * Shell v2 source surface: NOT a code editor. No gutters, line
 * numbers, or minimap — 13px mono at 1.85 line-height, wrapped, with
 * light syntax coloring only. All colors route through the `--sx-*`
 * theme vars so the graphite/porcelain toggle propagates without a
 * re-mount.
 */
const cmShellTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    height: "100%",
    fontSize: "13px",
    color: "var(--fg-2)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.85",
  },
  ".cm-content": {
    padding: "20px 26px",
    maxWidth: "760px",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
    },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

/** `[[wikilinks]]` aren't part of the markdown grammar, so the lezer
 *  highlighter can't color them — a MatchDecorator paints the accent
 *  link style over the raw source instead. */
const wikilinkMatcher = new MatchDecorator({
  regexp: /\[\[[^\]\n]+\]\]/g,
  decoration: Decoration.mark({ class: "tk-link" }),
});

const cmWikilinkHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wikilinkMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = wikilinkMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const cmMarkdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, color: "var(--sx-head)", fontWeight: "600" },
    { tag: tags.strong, color: "var(--sx-bold)", fontWeight: "700" },
    { tag: tags.emphasis, color: "var(--fg-2)", fontStyle: "italic" },
    { tag: tags.monospace, color: "var(--sx-code)" },
    { tag: tags.link, color: "var(--sx-link)", textDecoration: "underline" },
    { tag: tags.url, color: "var(--sx-link)" },
    { tag: tags.quote, color: "var(--fg-2)", fontStyle: "italic" },
    { tag: tags.processingInstruction, color: "var(--sx-punct)" },
    { tag: tags.meta, color: "var(--sx-punct)" },
    { tag: tags.contentSeparator, color: "var(--sx-punct)" },
  ]),
);

function fmtSavedAgo(savedAtMs: number): string {
  const sec = Math.max(0, Math.round((Date.now() - savedAtMs) / 1000));
  if (sec < 60) return "saved now";
  if (sec < 3600) return `saved ${Math.round(sec / 60)}m`;
  return `saved ${Math.round(sec / 3600)}h`;
}

/**
 * Markdown editor with three view modes:
 *
 * - **src**: CodeMirror 6 source only, full width.
 * - **split**: source + live preview side by side (default).
 * - **prev**: rendered preview only, full width. Frontmatter form is
 *   hidden in this mode since react-markdown already renders the file's
 *   metadata block.
 *
 * The view mode itself is owned by Dashboard since slice 8 PR B — the
 * editor receives it as a prop and renders accordingly. The ⌘1/2/3
 * shortcut and the segmented toggle UI both live above this component
 * now (Dashboard keyboard handler + `EditorTabs` strip respectively).
 *
 * Save/Discard/Close + dirty + missing-on-disk state work the same in
 * all modes. `react-markdown` + GFM powers the preview, with
 * `[[Note Name]]` wikilinks rendered as clickable buttons that invoke
 * `onOpenWikilink`.
 */
export function EditorPanel({
  path,
  content,
  savedContent,
  saving,
  error,
  savedAtMs = null,
  missing = false,
  viewMode,
  onSetViewMode,
  onChange,
  onSave,
  onDiscard,
  onClose,
  onOpenWikilink,
}: EditorPanelProps) {
  const isDirty = content !== savedContent;
  const saveDisabled = !isDirty || saving || missing;
  const discardDisabled = !isDirty || saving || missing;

  const cmExtensions = useMemo(
    () => [
      markdown(),
      cmShellTheme,
      cmMarkdownHighlight,
      cmWikilinkHighlight,
      EditorView.lineWrapping,
    ],
    [],
  );

  const parsed = useMemo(() => parseMarkdown(content), [content]);

  const updateBody = useCallback(
    (nextBody: string) => {
      onChange(serializeMarkdown({ ...parsed, body: nextBody }));
    },
    [onChange, parsed],
  );

  const updateFrontmatter = useCallback(
    (nextFm: Record<string, FrontmatterValue>) => {
      onChange(
        serializeMarkdown({
          frontmatter: nextFm,
          body: parsed.body,
          hasFrontmatter: true,
        }),
      );
    },
    [onChange, parsed.body],
  );

  return (
    <article
      className="ide-edhost"
      aria-label={`Markdown editor for ${path}`}
    >
      {/* Path row: full vault-relative path, save state, mode segment. */}
      <div className="ide-pathrow">
        <span className="path" title={path}>
          {path}
        </span>
        <span className="saved">
          {saving
            ? "saving…"
            : isDirty
              ? "unsaved"
              : savedAtMs != null
                ? fmtSavedAgo(savedAtMs)
                : null}
        </span>
        <span className="grow" />
        {isDirty && !missing && (
          <>
            <button
              type="button"
              className="ide-btn primary sm"
              onClick={onSave}
              disabled={saveDisabled}
            >
              save
            </button>
            <button
              type="button"
              className="ide-btn ghost sm"
              onClick={onDiscard}
              disabled={discardDisabled}
            >
              discard
            </button>
          </>
        )}
        <div className="mode-seg" role="group" aria-label="Editor view mode">
          {VIEW_MODES.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={m.id === viewMode ? "on" : ""}
              aria-pressed={m.id === viewMode}
              title={`${m.label} (${MOD_LABEL}${i + 1})`}
              onClick={() => onSetViewMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ide-btn ghost sm"
          onClick={onClose}
          title="Close file"
        >
          close
        </button>
      </div>
      {missing && (
        <p className="ide-ed-banner" role="alert">
          <strong>This file was deleted or moved outside the app.</strong>{" "}
          Your in-editor changes are kept in memory. Save is disabled to avoid
          silently re-creating the file. Close the editor, or re-create the
          file externally and click Refresh.
        </p>
      )}
      {error && (
        <p className="ide-ed-banner ide-ed-banner--err" role="alert">
          {error}
        </p>
      )}
      {/* Frontmatter editing surface for src/split (CodeMirror edits
       * the body only). In `prev` mode the form is replaced by the
       * compact read-only fm-card inside the preview pane below —
       * matching the design's inspection view. */}
      {viewMode !== "prev" && (
        <FrontmatterForm
          frontmatter={parsed.frontmatter}
          hasFrontmatter={parsed.hasFrontmatter}
          readOnly={false}
          onChange={updateFrontmatter}
        />
      )}
      {/* Both panes are always mounted — only their visibility flips via
       * the `hidden` class. Keeps CodeMirror's scroll/selection + the
       * preview's scroll position alive across mode switches. */}
      <div className="ide-edwrap">
        <div className={"ide-edpane" + (viewMode === "prev" ? " hidden" : "")}>
          <CodeMirror
            className="ide-cm"
            value={parsed.body}
            height="100%"
            // "none" — the wrapper's default is a light theme that
            // paints a white background over our var-driven theme.
            theme="none"
            extensions={cmExtensions}
            onChange={updateBody}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLineGutter: false,
              highlightActiveLine: false,
              indentOnInput: true,
              bracketMatching: false,
              autocompletion: false,
            }}
            aria-label={"Markdown source of " + path}
          />
        </div>
        <div className={"ide-edpane" + (viewMode === "src" ? " hidden" : "")}>
          <div
            className="ide-preview"
            aria-label={"Rendered preview of " + path}
          >
            {viewMode === "prev" && parsed.hasFrontmatter && (
              <FmCard frontmatter={parsed.frontmatter} />
            )}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={makeWikilinkComponents(onOpenWikilink)}
            >
              {parsed.body}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Read-only frontmatter card for preview mode: 2-column mono grid
 *  (design `fm-card`). Editing happens through the form in src/split. */
function FmCard({
  frontmatter,
}: {
  frontmatter: Record<string, FrontmatterValue>;
}) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <div className="fm-card">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <span className="k">{k}</span>
          <span className="v">{formatFmValue(v)}</span>
        </Fragment>
      ))}
    </div>
  );
}

function formatFmValue(v: FrontmatterValue): string {
  if (v === null) return "—";
  if (Array.isArray(v)) return v.join(" · ");
  return String(v);
}

// ---------- Wikilink support ----------

/**
 * Build a `components` map for `ReactMarkdown` that scans the rendered tree
 * for `[[Wikilink]]` patterns in text nodes and replaces them with clickable
 * buttons. Implemented as a recursive React children walk so we don't need
 * a separate remark plugin (and the `unist-util-visit` dep that would bring).
 *
 * The set of intercepted elements (`p`, `li`, `h1`–`h6`, `blockquote`, `td`)
 * covers every place vault notes typically put inline text. Inside `code`
 * / `pre` we deliberately do NOT transform — code blocks should render
 * `[[foo]]` literally.
 */
function makeWikilinkComponents(
  onOpenWikilink: ((target: string) => void) | undefined,
) {
  if (!onOpenWikilink) return undefined;

  const wrap = (Element: keyof JSX.IntrinsicElements) => {
    const Component = (props: { children?: ReactNode }) => {
      const children = transformWikilinks(props.children, onOpenWikilink);
      const ElTag = Element as unknown as React.ElementType;
      return <ElTag {...props}>{children}</ElTag>;
    };
    Component.displayName = `WikilinkAware(${Element})`;
    return Component;
  };

  return {
    p: wrap("p"),
    li: wrap("li"),
    h1: wrap("h1"),
    h2: wrap("h2"),
    h3: wrap("h3"),
    h4: wrap("h4"),
    h5: wrap("h5"),
    h6: wrap("h6"),
    blockquote: wrap("blockquote"),
    td: wrap("td"),
    th: wrap("th"),
  };
}

function transformWikilinks(
  node: ReactNode,
  onOpen: (target: string) => void,
): ReactNode {
  return Children.map(node, (child, idx) => {
    if (typeof child === "string") {
      return splitStringWithWikilinks(child, onOpen, idx);
    }
    if (isValidElement(child)) {
      const props = (child.props as { children?: ReactNode } | null) ?? {};
      if (props.children !== undefined) {
        return cloneElement(child, {
          ...child.props,
          children: transformWikilinks(props.children, onOpen),
        } as Partial<unknown>);
      }
    }
    return child;
  });
}

function splitStringWithWikilinks(
  s: string,
  onOpen: (target: string) => void,
  parentKey: number,
): ReactNode {
  WIKILINK_RE.lastIndex = 0;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    // Obsidian-style aliased wikilink: `[[target|display]]`. The `|`
    // separates the resolution target from the visible label. Without an
    // alias, target == display.
    const full = m[1];
    const pipe = full.indexOf("|");
    const target = (pipe >= 0 ? full.slice(0, pipe) : full).trim();
    const display = (pipe >= 0 ? full.slice(pipe + 1) : full).trim() || target;
    parts.push(
      <button
        key={`wl-${parentKey}-${m.index}`}
        type="button"
        className="wikilink"
        onClick={() => onOpen(target)}
        title={`Open: ${target}`}
      >
        {display}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last === 0) return s;
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
