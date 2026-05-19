import { useCallback, useMemo, useState } from "react";

import { approveToolUse, denyToolUse } from "../api";
import type { RunPermissionRequestEvent } from "../api";

interface ApproveToolsModalProps {
  /** Active permission request, or `null` when the modal is hidden. */
  request: RunPermissionRequestEvent | null;
  /** Called after a successful decision is sent back to claude. The
   *  parent typically uses this to clear `request` so the modal hides. */
  onResolved: () => void;
}

/**
 * Modal that surfaces a Claude Code permission request and routes the
 * user's choice back through the SDK control protocol.
 *
 * UX shape (per design slice 6):
 * - Header: ⚠ Permission pill, tool name, optional pre-rendered title.
 * - Body: tool argument (truncated for long shell commands), risk pill
 *   (heuristic — see `classifyRisk`), Claude's own description if
 *   present.
 * - Footer: Deny (red, ghost) · Allow once · Allow for this session.
 *
 * The session-scope "remember" lives entirely inside claude's session
 * via the SDK's `updatedPermissions` field — nothing is persisted to
 * disk yet (frontmatter writeback is a follow-up slice). Closing the
 * modal without a decision is NOT allowed: claude is paused waiting
 * for one of the three explicit answers.
 */
export function ApproveToolsModal({ request, onResolved }: ApproveToolsModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const argText = useMemo(() => {
    if (!request) return "";
    return summariseToolInput(request.toolName, request.toolInput);
  }, [request]);

  const risk = useMemo<Risk>(() => {
    if (!request) return "low";
    return classifyRisk(request.toolName, argText);
  }, [request, argText]);

  const decide = useCallback(
    async (kind: "allow-once" | "allow-session" | "deny") => {
      if (!request || busy) return;
      setBusy(true);
      setError(null);
      try {
        if (kind === "deny") {
          await denyToolUse({
            requestId: request.requestId,
            message: "user denied via approve-tools modal",
          });
        } else {
          await approveToolUse({
            requestId: request.requestId,
            // Session-scope "remember" — placeholder until we wire the
            // real permission_suggestions echo from the request payload.
            // Empty array is a valid PermissionUpdate[] meaning "no new
            // rules" (Allow once) vs absent (also Allow once).
            updatedPermissions: kind === "allow-session" ? [] : undefined,
          });
        }
        onResolved();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [request, busy, onResolved],
  );

  if (!request) return null;

  const headline = request.title ?? defaultHeadline(request.toolName);
  const subline = request.displayName ?? request.toolName;

  return (
    <div
      className="approve-tools-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approve-tools-modal__title"
    >
      <div className="approve-tools-modal__scrim" aria-hidden="true" />
      <div className="approve-tools-modal__card">
        <header className="approve-tools-modal__header">
          <span className="approve-tools-modal__pill">⚠ Permission</span>
          <span className="approve-tools-modal__skill">{subline}</span>
        </header>

        <div className="approve-tools-modal__body">
          <h2
            id="approve-tools-modal__title"
            className="approve-tools-modal__title"
          >
            {headline}
          </h2>
          {request.description && (
            <p className="approve-tools-modal__description">
              {request.description}
            </p>
          )}
          <div className="approve-tools-modal__tool-row">
            <span
              className={"approve-tools-modal__risk approve-tools-modal__risk--" + risk}
              title={`Risk: ${risk}`}
            >
              {risk}
            </span>
            <code className="approve-tools-modal__arg">{argText || "(no args)"}</code>
          </div>
        </div>

        {error && (
          <p className="approve-tools-modal__error" role="alert">
            {error}
          </p>
        )}

        <footer className="approve-tools-modal__footer">
          <button
            type="button"
            className="btn btn--small btn--danger approve-tools-modal__deny"
            onClick={() => void decide("deny")}
            disabled={busy}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void decide("allow-once")}
            disabled={busy}
          >
            Allow once
          </button>
          <button
            type="button"
            className="btn btn--small btn--primary"
            onClick={() => void decide("allow-session")}
            disabled={busy}
          >
            Allow for this session
          </button>
        </footer>
      </div>
    </div>
  );
}

type Risk = "low" | "med" | "high";

/**
 * Heuristic risk classification — runs entirely on the rendered string
 * so it can't fall out of sync with what the user sees. Conservative
 * defaults: anything we can't recognise is "low" so the user isn't
 * scared off legitimate ops by yellow chrome.
 *
 * Categories are intentionally coarse. The real authority on whether a
 * tool call is dangerous is the user reading the argument — the chip is
 * a hint, not a gate.
 */
export function classifyRisk(tool: string, arg: string): Risk {
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    if (arg.startsWith("01_inbox/")) return "low";
    if (arg.includes(".vault/config")) return "high";
    return "med";
  }
  if (tool === "Bash") {
    if (/^git (log|status|diff|branch|show)\b/.test(arg)) return "low";
    if (/(\brm\b|\bchmod\b|\bsudo\b|curl .+ \| sh)/.test(arg)) return "high";
    return "med";
  }
  if (tool === "WebFetch" || tool === "WebSearch") return "low";
  return "low";
}

/**
 * Render the tool input as a compact, mono-friendly one-liner for the
 * modal. We probe a few well-known fields (`command`, `file_path`,
 * `path`, `url`, `pattern`, `prompt`) — these cover Bash, Read/Write,
 * Glob/Grep, WebFetch in one pass. Falls back to a tight JSON dump for
 * unknown shapes so the user still sees something.
 */
function summariseToolInput(_tool: string, input: unknown): string {
  if (input === null || typeof input !== "object") {
    return typeof input === "string" ? input : "";
  }
  const obj = input as Record<string, unknown>;
  for (const field of ["command", "file_path", "path", "pattern", "url", "prompt"]) {
    const v = obj[field];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 240 ? v.slice(0, 239) + "…" : v;
    }
  }
  try {
    const j = JSON.stringify(input);
    return j.length > 240 ? j.slice(0, 239) + "…" : j;
  } catch {
    return "";
  }
}

function defaultHeadline(toolName: string): string {
  return `Claude wants to use ${toolName}`;
}
