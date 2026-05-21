import { useCallback, useRef, useState } from "react";

import {
  AGENT_CATALOG,
  getAgentSpec,
  getModelOption,
  type AgentSpec,
} from "../agents";
import type { AgentRunnerId } from "../api";
import { usePopoverPosition } from "../hooks/usePopoverPosition";

/**
 * Compact per-tab agent + model picker for the chat input header.
 *
 * Two-section popover:
 *
 *  - **Agent (Claude / Codex)** — the runner backend. Disabled with
 *    `runnerLocked` once the chat has started, because switching CLI
 *    mid-conversation would lose the session (Claude and Codex
 *    maintain separate session stores) and is a footgun.
 *  - **Model (per runner)** — picks `--model` for the next turn.
 *    Pickable even on an exited (reply-ready) chat so the user can
 *    swap Sonnet → Opus mid-conversation. Locked during running so a
 *    mid-stream swap can't desync the spawned subprocess.
 *
 * The chip label compresses the two selections into one short string —
 * `"✦ Claude · Sonnet"` — keeping the input row dense. The popover
 * opens on click; positioned via the shared `usePopoverPosition` hook
 * so it flips above the chip when the drawer is near the bottom of
 * the window.
 */
interface AgentPickerProps {
  runner: AgentRunnerId;
  /** Model value passed to the runner CLI. `null` = the catalog's
   *  "default" sentinel; the runner's own configured default kicks
   *  in at spawn time. */
  model: string | null;
  /** Disable changing the runner. Set once the chat tab has started
   *  (status ≠ idle) so the user can't accidentally lose their
   *  session by switching CLI. */
  runnerLocked: boolean;
  /** Disable changing the model. Set during running/stopping — once
   *  a turn is in flight, model is fixed for that subprocess. */
  modelLocked: boolean;
  onRunnerChange: (id: AgentRunnerId) => void;
  onModelChange: (value: string | null) => void;
}

export function AgentPicker({
  runner,
  model,
  runnerLocked,
  modelLocked,
  onRunnerChange,
  onModelChange,
}: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuStyle = usePopoverPosition({
    anchorRef: buttonRef,
    open,
    placement: "top",
    align: "auto",
  });

  // Resolve the current spec + model option so the chip label is
  // always derived, never stale. Unknown runner falls back to a thin
  // synthetic spec so the chip still renders (defensive against a
  // future runner id arriving from a persisted history row).
  const spec: AgentSpec = getAgentSpec(runner) ?? AGENT_CATALOG[0];
  const modelOption = getModelOption(spec.id, model);
  const modelLabel = modelOption?.label ?? "default";

  const dismiss = useCallback(() => setOpen(false), []);

  // Build the title= tooltip describing why an option is disabled,
  // so the user understands why their click does nothing.
  const chipTitle = (() => {
    const parts: string[] = [`Agent: ${spec.label} · Model: ${modelLabel}`];
    if (runnerLocked && modelLocked) {
      parts.push("Locked while the run is active.");
    } else if (runnerLocked) {
      parts.push("Agent is locked once the chat has started.");
    }
    return parts.join("\n");
  })();

  return (
    <div className="agent-picker">
      <button
        ref={buttonRef}
        type="button"
        className="agent-picker__chip"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={chipTitle}
      >
        <span className="agent-picker__chip-icon" aria-hidden="true">
          {spec.icon}
        </span>
        <span className="agent-picker__chip-label">{spec.label}</span>
        <span className="agent-picker__chip-sep" aria-hidden="true">·</span>
        <span className="agent-picker__chip-model">{modelLabel}</span>
        <span className="agent-picker__chip-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <div
            className="agent-picker__scrim"
            onClick={dismiss}
            aria-hidden="true"
          />
          <div
            className="agent-picker__menu"
            role="dialog"
            aria-label="Agent and model"
            style={menuStyle}
          >
            <div className="agent-picker__section-label">Agent</div>
            <div className="agent-picker__agents">
              {AGENT_CATALOG.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={
                    "agent-picker__agent" +
                    (a.id === spec.id ? " agent-picker__agent--active" : "")
                  }
                  onClick={() => {
                    if (a.id === spec.id) return;
                    onRunnerChange(a.id);
                  }}
                  disabled={runnerLocked && a.id !== spec.id}
                  title={
                    runnerLocked && a.id !== spec.id
                      ? "Agent is locked once the chat has started — start a new chat to switch."
                      : a.description
                  }
                >
                  <span className="agent-picker__agent-icon" aria-hidden="true">
                    {a.icon}
                  </span>
                  <span className="agent-picker__agent-body">
                    <span className="agent-picker__agent-label">{a.label}</span>
                    <span className="agent-picker__agent-desc">{a.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="agent-picker__section-label">Model</div>
            <div className="agent-picker__models">
              {spec.models.map((m) => (
                <button
                  key={m.value ?? "__default__"}
                  type="button"
                  className={
                    "agent-picker__model" +
                    (m.value === (modelOption?.value ?? null)
                      ? " agent-picker__model--active"
                      : "")
                  }
                  onClick={() => {
                    onModelChange(m.value);
                    // Dismiss after a model pick so the user lands
                    // back in the textarea ready to type. Agent picks
                    // keep the popover open so the user can adjust
                    // the model in the same gesture.
                    dismiss();
                  }}
                  disabled={modelLocked}
                  title={m.hint ?? m.label}
                >
                  <span className="agent-picker__model-label">{m.label}</span>
                  {m.hint && (
                    <span className="agent-picker__model-hint">{m.hint}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
