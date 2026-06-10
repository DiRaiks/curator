/**
 * Curated catalog of agent backends + their model options. Single
 * source of truth for the per-tab picker in `RunPanel` and the chip
 * label in `RunPanelHost`. The frontend hardcodes this list (rather
 * than fetching it from the CLI dynamically) so the picker can render
 * synchronously on mount without a startup IPC round-trip; the trade-
 * off is that adding a model means shipping a build, which is fine
 * for the cadence of new model releases.
 *
 * The Rust side accepts any model string — these are just curated
 * shortcuts. Users with a pinned model in `~/.claude/settings.json`
 * or `~/.codex/config.toml` can leave the model on `default` and
 * their config kicks in.
 */

import type { AgentRunnerId } from "./api";

/** One selectable option in the model dropdown. */
export interface AgentModelOption {
  /** Value passed to the runner CLI's `--model` flag. `null` means
   *  "no override — let the CLI's own config pick", which we map to
   *  omitting the flag entirely. */
  value: string | null;
  /** Short label shown in the picker chip + dropdown. */
  label: string;
  /** Optional one-liner used as `title=` on the dropdown row. */
  hint?: string;
}

/** Per-runner metadata + model list. */
export interface AgentSpec {
  id: AgentRunnerId;
  /** Title-cased label shown in the picker chip. */
  label: string;
  /** Single-character emoji for the chip — picked for legibility at
   *  the small font size; both colored variants render clearly in
   *  light and dark mode. */
  icon: string;
  /** Short one-line description shown in the runner-pick dropdown. */
  description: string;
  /** Models the picker exposes. The first entry MUST be the
   *  `value: null` "default" sentinel so the dropdown lands on
   *  "no override" when the user hasn't made a choice. */
  models: AgentModelOption[];
}

/**
 * Catalog. Order is the display order in the picker.
 *
 * Sources for the model names:
 * - Claude: aliases accepted by `claude --model` (sonnet/opus/haiku).
 *   The CLI maps these to the latest stable in each family.
 * - Codex: model ids documented for `codex --model` as of 0.132.
 */
export const AGENT_CATALOG: readonly AgentSpec[] = [
  {
    id: "claude-code",
    label: "Claude",
    icon: "✦",
    description: "Anthropic Claude Code CLI — with inline permission card for Bash/network.",
    models: [
      { value: null, label: "default", hint: "Use your ~/.claude/settings.json default" },
      { value: "fable", label: "Fable", hint: "Latest flagship — Fable 5" },
      { value: "sonnet", label: "Sonnet", hint: "Latest stable Sonnet — best general coding" },
      { value: "opus", label: "Opus", hint: "Deepest reasoning — slower + more expensive" },
      { value: "haiku", label: "Haiku", hint: "Fastest + cheapest — light tasks" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    icon: "◇",
    description: "OpenAI Codex CLI — sandboxed shell access, no per-call permission prompts.",
    // Codex serves two different families of model names depending
    // on how the user logged in (codex-cli 0.132, verified live).
    // The exact whitelist is opinionated and version-specific:
    //
    //  - **ChatGPT account** (`codex login`) — accepts exactly five
    //    explicit names: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
    //    `gpt-5.3-codex`, `gpt-5.2`. Everything else (including
    //    plausible-looking `gpt-5.5-codex` / `gpt-5.3-mini`) is
    //    rejected with HTTP 400 mid-stream. The list matches Zed's
    //    Codex picker — same auth, same whitelist.
    //  - **OpenAI API key auth** — accepts the canonical API names
    //    (`gpt-5`, `gpt-5-codex`, `gpt-5-mini`).
    //
    // `default` always works — codex falls back to the model in
    // `~/.codex/config.toml`, which the CLI sets to whatever's
    // appropriate for the user's auth tier.
    models: [
      {
        value: null,
        label: "default (recommended)",
        hint: "Codex picks the model from your ~/.codex/config.toml — always works regardless of auth",
      },
      // --- ChatGPT-account family (verified against `codex login`) ---
      {
        value: "gpt-5.5",
        label: "GPT-5.5 · ChatGPT",
        hint: "Latest ChatGPT-plan default. Works with `codex login`.",
      },
      {
        value: "gpt-5.4",
        label: "GPT-5.4 · ChatGPT",
        hint: "Prior ChatGPT-plan default. Still available on the picker.",
      },
      {
        value: "gpt-5.4-mini",
        label: "GPT-5.4 Mini · ChatGPT",
        hint: "Faster / cheaper ChatGPT-plan variant.",
      },
      {
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex · ChatGPT",
        hint: "Codex-tuned variant available on ChatGPT plans.",
      },
      {
        value: "gpt-5.2",
        label: "GPT-5.2 · ChatGPT",
        hint: "Older ChatGPT-plan model. Kept for users who pinned it.",
      },
      // --- OpenAI API-key family ---
      {
        value: "gpt-5",
        label: "GPT-5 · API key",
        hint: "Requires an OpenAI API key login. Rejected on ChatGPT-account auth.",
      },
      {
        value: "gpt-5-codex",
        label: "GPT-5 Codex · API key",
        hint: "Codex-tuned GPT-5 for API users.",
      },
      {
        value: "gpt-5-mini",
        label: "GPT-5 Mini · API key",
        hint: "Faster / cheaper API model.",
      },
    ],
  },
] as const;

/** Default backend for fresh chat tabs. Claude has the richer
 *  in-IDE UX (permission card, broader stream-json renderer); new
 *  users land on it. */
export const DEFAULT_RUNNER: AgentRunnerId = "claude-code";

/** Look up the catalog entry for a runner id. Returns `null` for
 *  unknown ids — callers should fall back to the [`DEFAULT_RUNNER`]
 *  spec rather than crashing. */
export function getAgentSpec(id: string): AgentSpec | null {
  return AGENT_CATALOG.find((a) => a.id === id) ?? null;
}

/** Look up a model option by value within a runner. `null` matches
 *  the "default" sentinel. */
export function getModelOption(
  runnerId: AgentRunnerId,
  value: string | null,
): AgentModelOption | null {
  const spec = getAgentSpec(runnerId);
  if (!spec) return null;
  return spec.models.find((m) => m.value === value) ?? null;
}

/** Treat null / "" / "default" / unknown as the no-override sentinel
 *  so persisted strings from older sessions round-trip cleanly. */
export function normalizeModelValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "default") return null;
  return trimmed;
}

/** Coerce arbitrary backend-supplied runner strings into a known id.
 *  Future-compat: a newer backend sending an unknown runner shouldn't
 *  crash the renderer. The caller picks a safe rendering path (Claude
 *  format is the closest to "plain text fallback"). */
export function normalizeRunnerId(raw: string | null | undefined): AgentRunnerId {
  if (raw === "codex") return "codex";
  return "claude-code";
}
