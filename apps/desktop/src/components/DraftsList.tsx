import { useState } from "react";

import { discardDraft, promoteDraft } from "../api";
import type { Draft } from "../types";

interface DraftsListProps {
  vaultRoot: string;
  drafts: Draft[];
  /** Called after promote/discard to refresh the underlying scan so the
   *  list reflects the new on-disk state. */
  onRescan: () => Promise<void>;
  /** Open a vault-relative file in the editor (for preview before promote). */
  onPreview: (path: string) => void;
}

type DraftActionState =
  | { kind: "idle" }
  | { kind: "promoting" }
  | { kind: "discarding" }
  | { kind: "error"; message: string };

/**
 * Curation surface for agent-produced drafts. Each row shows what the
 * agent wrote + where it wants to put it; the user reviews and decides.
 *
 * Promote = move file to `proposed_destination` + rewrite marker
 * frontmatter (`status: promoted`, `promoted_from: <draft path>`).
 * Discard = delete the draft.
 *
 * Both actions go through Tauri commands that re-use the same path
 * validation as the rest of the markdown_io module — drafts can't escape
 * the vault, can't overwrite existing files, can't write into forbidden
 * subtrees.
 */
export function DraftsList({
  vaultRoot,
  drafts,
  onRescan,
  onPreview,
}: DraftsListProps) {
  const [actionStates, setActionStates] = useState<
    Record<string, DraftActionState>
  >({});

  const setState = (path: string, next: DraftActionState): void => {
    setActionStates((prev) => ({ ...prev, [path]: next }));
  };

  const onPromote = async (draft: Draft): Promise<void> => {
    setState(draft.path, { kind: "promoting" });
    try {
      await promoteDraft(vaultRoot, draft.path);
      await onRescan();
      // The draft row will disappear once the rescan returns the new
      // drafts list. No need to clear local state for it.
    } catch (err) {
      setState(draft.path, {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDiscard = async (draft: Draft): Promise<void> => {
    setState(draft.path, { kind: "discarding" });
    try {
      await discardDraft(vaultRoot, draft.path);
      await onRescan();
    } catch (err) {
      setState(draft.path, {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (drafts.length === 0) {
    return (
      <p className="empty">
        No drafts pending. Agents produce drafts by writing into{" "}
        <code>01_inbox/_drafts/</code> with{" "}
        <code>status: draft-from-agent</code> and{" "}
        <code>proposed_destination: &lt;path&gt;</code> in frontmatter.
      </p>
    );
  }

  return (
    <ul className="list drafts">
      {drafts.map((d) => {
        const state = actionStates[d.path] ?? { kind: "idle" };
        const busy = state.kind === "promoting" || state.kind === "discarding";
        return (
          <li key={d.path} className="list__item drafts__item">
            <div className="drafts__primary">
              <span className="list__id">{d.title}</span>
              {d.project && (
                <span className="tag tag--kind">{d.project}</span>
              )}
              {d.created && (
                <span className="drafts__date">{d.created}</span>
              )}
            </div>
            {d.reason && <p className="drafts__reason">{d.reason}</p>}
            <div className="drafts__paths">
              <span className="drafts__path-label">draft</span>
              <code className="drafts__path">{d.path}</code>
            </div>
            <div className="drafts__paths">
              <span className="drafts__path-label">promote to</span>
              <code className="drafts__path drafts__path--target">
                {d.proposedDestination}
              </code>
            </div>
            {state.kind === "error" && (
              <p className="welcome__error" role="alert">
                {state.message}
              </p>
            )}
            <div className="drafts__actions">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => onPreview(d.path)}
                disabled={busy}
              >
                Preview
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={() => {
                  void onPromote(d);
                }}
                disabled={busy}
                title={`Move to ${d.proposedDestination} and strip draft markers`}
              >
                {state.kind === "promoting" ? "Promoting…" : "Promote"}
              </button>
              <button
                type="button"
                className="btn btn--small btn--danger"
                onClick={() => {
                  void onDiscard(d);
                }}
                disabled={busy}
              >
                {state.kind === "discarding" ? "Discarding…" : "Discard"}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
