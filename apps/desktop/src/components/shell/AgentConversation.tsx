import { useMemo, type ReactNode } from "react";

import type { LineKind } from "../../acpRender";

/** Structural slice of RunPanel's `OutputLine` the conversation
 *  renderer needs. Defined here (not imported from RunPanel) so the
 *  dependency points panel → renderer only. */
export interface ConvoLine {
  kind: LineKind;
  text: string;
  hidden?: boolean;
  toolCallId?: string;
  parentToolUseId?: string;
}

/**
 * Zed-style conversation rendering for the agent panel (shell v2).
 *
 * The chat buffer stays the flat `OutputLine[]` RunPanel accumulates —
 * this component derives a turn/bubble view per render:
 *
 * - a `user` line starts a new YOU turn;
 * - everything until the next user line groups into one agent turn;
 * - `→ Tool args` system lines (dedup key `start:<id>`) become tool
 *   bubbles; their `← status\n<output>` counterparts (`end:<id>`)
 *   fold into the same bubble as the ✓/✕ state + output block;
 * - thoughts (`🧠 …`), lifecycle markers (`▶ start`, `✔ exit`, …) and
 *   stderr render as muted meta / error lines;
 * - subagent-attributed lines (`parentToolUseId`) indent under their
 *   parent.
 */
export function AgentConversation({
  lines,
  running,
  agentLabel,
}: {
  lines: ConvoLine[];
  /** True while the backend run streams — drives the "running" badge
   *  on the last agent turn and the live state of unfinished tools. */
  running: boolean;
  /** Turn-header label for the agent side ("claude" / "codex"). */
  agentLabel: string;
}) {
  const turns = useMemo(() => buildTurns(lines), [lines]);
  return (
    <>
      {turns.map((turn, ti) => {
        const isLast = ti === turns.length - 1;
        const live = running && isLast && turn.who === "agent";
        return (
          <div className="ide-turn" key={ti}>
            <div className={"who " + (turn.who === "user" ? "user" : "ai")}>
              <span>{turn.who === "user" ? "you" : agentLabel}</span>
              {live && (
                <span className="run">
                  <span
                    className="ide-dot run"
                    style={{ width: 5, height: 5 }}
                  />{" "}
                  running
                </span>
              )}
              {!live && turn.who === "agent" && turn.done && (
                <span style={{ color: "var(--ok)" }}>✓</span>
              )}
            </div>
            <div className={"body" + (turn.who === "agent" ? " ai" : "")}>
              {turn.items.map((item) => renderItem(item, live))}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------- turn model ----------

interface ToolItem {
  type: "tool";
  key: string;
  tag: string;
  arg: string;
  /** Status word from the tool's terminal update ("completed",
   *  "failed", "output"), or `null` while still in flight. */
  statusWord: string | null;
  failed: boolean;
  output: string | null;
  sub: boolean;
}

type Item =
  | { type: "text"; key: string; text: string; sub: boolean }
  | { type: "thought"; key: string; text: string; sub: boolean }
  | { type: "meta"; key: string; text: string }
  | { type: "stderr"; key: string; text: string }
  | ToolItem;

interface Turn {
  who: "user" | "agent";
  items: Item[];
  /** Agent turn ended with a successful exit marker. */
  done: boolean;
}

function buildTurns(lines: ConvoLine[]): Turn[] {
  const turns: Turn[] = [];
  const toolByCallId = new Map<string, ToolItem>();
  let current: Turn | null = null;

  const agentTurn = (): Turn => {
    if (!current || current.who !== "agent") {
      current = { who: "agent", items: [], done: false };
      turns.push(current);
    }
    return current;
  };

  lines.forEach((l, i) => {
    if (l.hidden) return;
    const key = String(i);
    const sub = l.parentToolUseId !== undefined;

    if (l.kind === "user") {
      current = {
        who: "user",
        items: [{ type: "text", key, text: l.text, sub: false }],
        done: false,
      };
      turns.push(current);
      return;
    }

    // Tool start — `→ Label args` with dedup key `start:<id>`.
    if (l.toolCallId?.startsWith("start:")) {
      const stripped = l.text.replace(/^→\s*/, "");
      const space = stripped.indexOf(" ");
      const item: ToolItem = {
        type: "tool",
        key,
        tag: space < 0 ? stripped : stripped.slice(0, space),
        arg: space < 0 ? "" : stripped.slice(space + 1),
        statusWord: null,
        failed: false,
        output: null,
        sub,
      };
      agentTurn().items.push(item);
      toolByCallId.set(l.toolCallId.slice("start:".length), item);
      return;
    }

    // Tool terminal update — folds into its start bubble when we have
    // one; otherwise falls through as a meta/error line.
    if (l.toolCallId?.startsWith("end:")) {
      const item = toolByCallId.get(l.toolCallId.slice("end:".length));
      const failed = l.kind === "stderr" || l.text.startsWith("✘");
      const body = l.text.replace(/^[✘←]\s*/, "");
      const nl = body.indexOf("\n");
      const statusWord = nl < 0 ? body : body.slice(0, nl);
      const output = nl < 0 ? null : body.slice(nl + 1);
      if (item) {
        item.statusWord = statusWord || (failed ? "failed" : "done");
        item.failed = failed;
        item.output = output;
        return;
      }
      agentTurn().items.push(
        failed
          ? { type: "stderr", key, text: l.text }
          : { type: "meta", key, text: l.text },
      );
      return;
    }

    if (l.kind === "stderr") {
      agentTurn().items.push({ type: "stderr", key, text: l.text });
      return;
    }

    if (l.kind === "system") {
      if (l.text.startsWith("🧠")) {
        agentTurn().items.push({
          type: "thought",
          key,
          text: l.text.replace(/^🧠\s*/, ""),
          sub,
        });
        return;
      }
      const turn = agentTurn();
      if (l.text.startsWith("✔ exit")) turn.done = true;
      turn.items.push({ type: "meta", key, text: l.text });
      return;
    }

    // Plain agent text (stdout).
    agentTurn().items.push({ type: "text", key, text: l.text, sub });
  });

  return turns;
}

// ---------- item rendering ----------

function renderItem(item: Item, turnLive: boolean): ReactNode {
  switch (item.type) {
    case "text":
      return (
        <p key={item.key} className={item.sub ? "sub" : undefined}>
          {renderTextWithCodeBlocks(item.text)}
        </p>
      );
    case "thought":
      return (
        <div
          key={item.key}
          className={"ide-agent-thought" + (item.sub ? " sub" : "")}
        >
          {item.text}
        </div>
      );
    case "meta":
      return (
        <div key={item.key} className="ide-agent-meta">
          {item.text}
        </div>
      );
    case "stderr":
      return (
        <pre key={item.key} className="ide-agent-stderr">
          {item.text}
        </pre>
      );
    case "tool": {
      const live = turnLive && item.statusWord === null;
      return (
        <div
          key={item.key}
          className={"ide-tool-wrap" + (item.sub ? " sub" : "")}
        >
          <div className={"ide-tool" + (live ? " live" : "")}>
            <span className="tt">{item.tag}</span>
            <span className="ta" title={item.arg}>
              {item.arg}
            </span>
            {item.failed ? (
              <span className="er">✕ {item.statusWord}</span>
            ) : item.statusWord !== null ? (
              <span className="ok">✓</span>
            ) : live ? (
              <span className="wr">
                <span
                  className="ide-dot run"
                  style={{ width: 5, height: 5 }}
                />{" "}
                running
              </span>
            ) : null}
          </div>
          {item.output && <pre className="ide-tool-out">{item.output}</pre>}
        </div>
      );
    }
  }
}

/** Render ``` fenced blocks inside agent text as styled code blocks;
 *  plain text passes through untouched. */
function renderTextWithCodeBlocks(text: string): ReactNode {
  if (!text.includes("```")) return text;
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const [whole, lang, body] = match;
    if (match.index > cursor) {
      parts.push(text.slice(cursor, match.index));
    }
    parts.push(
      <span key={key++} className="ide-code">
        {lang ? <span className="lang">{lang}</span> : null}
        {lang ? "\n" : ""}
        {body.replace(/\n$/, "")}
      </span>,
    );
    cursor = match.index + whole.length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return <>{parts}</>;
}
