import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Scope } from "../types";
import {
  parseMarkdown,
  serializeMarkdown,
  type FrontmatterValue,
} from "../utils/frontmatter";
import { FrontmatterForm } from "./FrontmatterForm";

interface EditorPanelProps {
  path: string;
  scope?: Scope;
  content: string;
  savedContent: string;
  saving: boolean;
  error: string | null;
  /** The file disappeared from the latest vault scan (deleted/moved
   *  externally). Save/Discard are disabled and a banner is shown; the
   *  in-memory buffer is preserved so the user doesn't lose work. */
  missing?: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
  /** Open another file inside the same vault. Used to resolve wikilink
   *  clicks in preview mode. Receives the raw wikilink target (e.g. the
   *  text between `[[…]]`) — the host decides how to resolve it. */
  onOpenWikilink?: (target: string) => void;
}

type Mode = "edit" | "view";

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/**
 * Markdown editor with two modes:
 *
 * - **edit**: CodeMirror 6 + the markdown grammar (headings, lists, code
 *   blocks, links highlighted in the source). No live preview — toggle to
 *   view mode for that.
 * - **view**: `react-markdown` + GFM (tables, task lists, strikethrough)
 *   with wikilink support — `[[Note Name]]` renders as a clickable button
 *   that invokes `onOpenWikilink`.
 *
 * Cmd/Ctrl + E toggles between modes. The mode toggle is per-mount: opening
 * a different file does not reset it.
 *
 * Save/Discard/Close + dirty + missing-on-disk state work the same in both
 * modes. Frontmatter editing UI lives in `FrontmatterForm` and is plugged in
 * by a follow-up commit; for now the editor sees the file content as a
 * single string.
 */
export function EditorPanel({
  path,
  scope,
  content,
  savedContent,
  saving,
  error,
  missing = false,
  onChange,
  onSave,
  onDiscard,
  onClose,
  onOpenWikilink,
}: EditorPanelProps) {
  const isDirty = content !== savedContent;
  const sizeBytes = useMemo(() => new Blob([content]).size, [content]);
  const saveDisabled = !isDirty || saving || missing;
  const discardDisabled = !isDirty || saving || missing;

  const [mode, setMode] = useState<Mode>("edit");
  const toggleMode = useCallback(
    () => setMode((m) => (m === "edit" ? "view" : "edit")),
    [],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      if (cmdOrCtrl && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleMode]);

  const cmExtensions = useMemo(() => [markdown()], []);

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
    <article className="editor" aria-label={`Markdown editor for ${path}`}>
      <header className="editor__header">
        <div className="editor__meta">
          <span
            className="editor__mode"
            title={
              mode === "edit"
                ? "Markdown source — Cmd/Ctrl+E for preview"
                : "Rendered preview — Cmd/Ctrl+E for source"
            }
          >
            {mode === "edit" ? "Source" : "Preview"}
          </span>
          <span className="editor__path">{path}</span>
          {scope && (
            <span className={"scope scope--" + scope}>{scope}</span>
          )}
          <span className="editor__size" title="Approximate byte size">
            {sizeBytes} B
          </span>
          {isDirty && (
            <span
              className="tag tag--warning"
              title="Unsaved changes — Save or Discard before navigating away"
            >
              unsaved
            </span>
          )}
          {missing && (
            <span
              className="tag tag--warning"
              title="The file is no longer present on disk."
            >
              missing on disk
            </span>
          )}
        </div>
        <div className="editor__actions">
          <button
            type="button"
            className="btn btn--small"
            onClick={toggleMode}
            title="Toggle source / preview (Cmd/Ctrl+E)"
            aria-pressed={mode === "view"}
          >
            {mode === "edit" ? "Preview" : "Source"}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={onSave}
            disabled={saveDisabled}
            title={
              missing
                ? "Save is disabled because the file no longer exists on disk."
                : undefined
            }
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={onDiscard}
            disabled={discardDisabled}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </header>
      {missing && (
        <p className="editor__missing" role="alert">
          <strong>This file was deleted or moved outside the app.</strong>{" "}
          Your in-editor changes are kept in memory. Save is disabled to avoid
          silently re-creating the file. Close the editor, or re-create the
          file externally and click Refresh.
        </p>
      )}
      {error && <p className="welcome__error">{error}</p>}
      <FrontmatterForm
        frontmatter={parsed.frontmatter}
        hasFrontmatter={parsed.hasFrontmatter}
        readOnly={mode === "view"}
        onChange={updateFrontmatter}
      />
      {mode === "edit" ? (
        <CodeMirror
          className="editor__cm"
          value={parsed.body}
          height="100%"
          extensions={cmExtensions}
          onChange={updateBody}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLineGutter: false,
            highlightActiveLine: true,
            indentOnInput: true,
            bracketMatching: false,
            autocompletion: false,
          }}
          aria-label={"Markdown source of " + path}
        />
      ) : (
        <div
          className="editor__preview"
          aria-label={"Rendered preview of " + path}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={makeWikilinkComponents(onOpenWikilink)}
          >
            {parsed.body}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
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
