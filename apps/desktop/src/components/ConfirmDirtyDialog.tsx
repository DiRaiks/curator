interface ConfirmDirtyDialogProps {
  path: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Three-option modal shown when the user tries to navigate away from an
 * unsaved file. Native `window.confirm` only has two buttons; this gives
 * Save / Discard / Cancel without pulling in a UI library.
 */
export function ConfirmDirtyDialog({
  path,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: ConfirmDirtyDialogProps) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-dirty-title">
      <div className="modal">
        <h3 id="confirm-dirty-title" className="modal__title">
          Unsaved changes
        </h3>
        <p className="modal__body">
          You have unsaved changes in <code>{path}</code>.
        </p>
        <div className="modal__actions">
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={onDiscard}
            disabled={saving}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
