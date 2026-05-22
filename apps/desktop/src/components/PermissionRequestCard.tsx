import { useCallback, useMemo, useState } from "react";

import { approveToolUse, denyToolUse } from "../api";
import type { RunPermissionRequestEvent } from "../api";

interface PermissionRequestCardProps {
  /** Active permission request, or `null` when nothing is pending. */
  request: RunPermissionRequestEvent | null;
  /** Called after a decision is successfully sent back to claude. The
   *  parent typically clears its `pendingPermission` state so the card
   *  unmounts. */
  onResolved: () => void;
}

/**
 * Inline permission request card. Rendered above the chat textarea
 * inside the chat that issued the request, so the user can:
 *
 *   - See exactly which conversation is paused (no "which tab does
 *     this belong to?" question — it's attached to its own chat),
 *   - Approve or deny without losing the rest of the conversation's
 *     scroll position to a modal scrim,
 *   - Close the tab to abandon the request safely (backend
 *     `pending_permissions` cleanup is already idempotent — see
 *     `approve_tool_use` in `lib.rs`).
 *
 * Replaces the global `ApproveToolsModal` which had no chat binding
 * and would have created routing problems once multiple chats can each
 * have their own pending permissions. The visual is a compact card
 * (one expandable row) rather than a full modal — the modal's height
 * was overkill for what is, after the title/risk/arg, two buttons.
 */
export function PermissionRequestCard({
  request,
  onResolved,
}: PermissionRequestCardProps) {
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
            runId: request.runId,
            requestId: request.requestId,
            message: "user denied via permission card",
          });
        } else {
          await approveToolUse({
            runId: request.runId,
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

  const headline = request.title ?? `Claude wants to use ${request.toolName}`;
  const subline = request.displayName ?? request.toolName;

  return (
    <div
      className="permission-card"
      role="region"
      aria-label="Permission request"
    >
      <div className="permission-card__header">
        <span className="permission-card__pill">⚠ Permission</span>
        <span
          className={"permission-card__risk permission-card__risk--" + risk}
          title={`Risk: ${risk}`}
        >
          {risk}
        </span>
        <span className="permission-card__skill">{subline}</span>
      </div>

      <p className="permission-card__title">{headline}</p>
      {request.description && (
        <p className="permission-card__description">{request.description}</p>
      )}
      <code className="permission-card__arg">{argText || "(no args)"}</code>

      {error && (
        <p className="permission-card__error" role="alert">
          {error}
        </p>
      )}

      <div className="permission-card__actions">
        <button
          type="button"
          className="btn btn--small btn--danger"
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
          Allow for session
        </button>
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
 * tool call is dangerous is the user reading the argument — the chip
 * is a hint, not a gate.
 */
function classifyRisk(tool: string, arg: string): Risk {
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
 * Render the tool input as a compact, mono-friendly one-liner. We
 * probe a few well-known fields (`command`, `file_path`, `path`,
 * `url`, `pattern`, `prompt`) — these cover Bash, Read/Write,
 * Glob/Grep, WebFetch in one pass. Falls back to a tight JSON dump
 * for unknown shapes so the user still sees something.
 */
function summariseToolInput(_tool: string, input: unknown): string {
  if (input === null || typeof input !== "object") {
    return typeof input === "string" ? input : "";
  }
  const obj = input as Record<string, unknown>;
  for (const field of [
    "command",
    "file_path",
    "filePath",
    "path",
    "pattern",
    "url",
    "prompt",
  ]) {
    const v = obj[field];
    if (typeof v === "string" && v.length > 0) {
      return clip(v);
    }
    // codex-acp ships `command` as a string array — typically
    // `["/bin/zsh", "-lc", "<actual command>"]`. Pull the shell
    // payload out (last element) so the card shows the user the
    // meaningful command rather than the wrapper invocation.
    if (Array.isArray(v) && v.every((it) => typeof it === "string")) {
      const arr = v as string[];
      const meaningful =
        arr.length >= 3 && (arr[0] === "/bin/zsh" || arr[0] === "/bin/bash")
          ? arr[arr.length - 1]
          : arr.join(" ");
      if (meaningful.length > 0) return clip(meaningful);
    }
  }
  try {
    return clip(JSON.stringify(input));
  } catch {
    return "";
  }
}

function clip(s: string): string {
  return s.length > 240 ? s.slice(0, 239) + "…" : s;
}
