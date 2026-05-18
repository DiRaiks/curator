import { useMemo } from "react";
import type { Scope } from "../types";

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
}

/**
 * Raw Markdown editor for a single vault file.
 *
 * No preview, no syntax highlighting, no frontmatter form — just a textarea.
 * Save/Discard/Close are exposed as actions; dirty state is derived from
 * `content !== savedContent`.
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
}: EditorPanelProps) {
  const isDirty = content !== savedContent;
  const sizeBytes = useMemo(() => new Blob([content]).size, [content]);
  const saveDisabled = !isDirty || saving || missing;
  const discardDisabled = !isDirty || saving || missing;

  return (
    <article className="editor" aria-label={`Markdown editor for ${path}`}>
      <header className="editor__header">
        <div className="editor__meta">
          <span
            className="editor__mode"
            title="Raw Markdown — no preview, no syntax highlighting"
          >
            Raw Markdown
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
      <textarea
        className="editor__textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={"Markdown content of " + path}
      />
    </article>
  );
}
