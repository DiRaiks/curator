import { useState } from "react";

interface NewFileDialogProps {
  initialPath: string;
  onCreate: (path: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Visible modal for creating a new Markdown file. Replaces `window.prompt()`,
 * which is silently disabled in the Tauri WebKit / WebView2 runtimes.
 *
 * `onCreate` is expected to throw on validation/IO errors — the dialog
 * surfaces the error inline and stays open so the user can correct the path.
 * On success, the parent component should close the dialog.
 */
export function NewFileDialog({
  initialPath,
  onCreate,
  onCancel,
}: NewFileDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = path.trim();
    if (!trimmed) {
      setError("Path is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-file-title"
    >
      <div className="modal">
        <h3 id="new-file-title" className="modal__title">
          New Markdown file
        </h3>
        <p className="modal__body">
          Vault-relative path. Must end with <code>.md</code> and stay inside
          the vault.
        </p>
        <input
          type="text"
          className="modal__input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="01_inbox/new-note.md"
          autoFocus
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          aria-label="New Markdown file path"
          aria-invalid={error !== null}
          aria-describedby={error ? "new-file-error" : undefined}
          disabled={creating}
        />
        {error && (
          <p id="new-file-error" className="modal__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => {
              void submit();
            }}
            disabled={creating}
          >
            {creating ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={onCancel}
            disabled={creating}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
