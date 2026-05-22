import { beforeEach, describe, expect, test } from "vitest";

import {
  acpUpdateKind,
  classifyStreamingVisibility,
  clipToolOutput,
  extractAcpUsageDelta,
  extractToolCallFullText,
  MAX_TOOL_OUTPUT_CHARS,
  parseAcpUpdate,
  readContentText,
  renderAcpToolCall,
  renderAcpToolCallUpdate,
  renderAcpUpdate,
  resetAcpUsageBaseline,
  summariseToolInput,
  toolCallDedupKey,
  toolKindLabel,
  type LineSnapshot,
} from "./acpRender";

beforeEach(() => {
  // The usage-delta extractor maintains a module-local baseline so
  // ACP `usage_update` events (which report running totals, not
  // deltas) produce a per-event delta on the consumer side. Tests
  // share that state — reset it before each so a prior case's
  // baseline doesn't leak into the next.
  resetAcpUsageBaseline();
});

// ---------- parseAcpUpdate ----------

describe("parseAcpUpdate", () => {
  test("plain text non-JSON falls through with obj=null", () => {
    const r = parseAcpUpdate("hello world");
    expect(r?.obj).toBeNull();
    expect(r?.raw).toBe("hello world");
  });

  test("empty input is a passthrough", () => {
    const r = parseAcpUpdate("   ");
    expect(r?.obj).toBeNull();
  });

  test("valid JSON object parses", () => {
    const r = parseAcpUpdate('{"sessionUpdate":"tool_call","toolCallId":"x"}');
    expect(r?.obj).toEqual({ sessionUpdate: "tool_call", toolCallId: "x" });
  });

  test("malformed JSON does not throw — falls through with obj=null", () => {
    const r = parseAcpUpdate('{"sessionUpdate":');
    expect(r?.obj).toBeNull();
    expect(r?.raw).toBe('{"sessionUpdate":');
  });

  test("JSON arrays at top level are not records — obj=null", () => {
    // Arrays parse but ACP `SessionUpdate` is always an object;
    // treat anything else as unstructured.
    const r = parseAcpUpdate("[1,2,3]");
    expect(r?.obj).toBeNull();
  });
});

// ---------- acpUpdateKind ----------

describe("acpUpdateKind", () => {
  test("snake_case discriminator passes through", () => {
    expect(acpUpdateKind({ sessionUpdate: "agent_message_chunk" })).toBe(
      "agent_message_chunk",
    );
  });

  test("camelCase discriminator is normalised to snake_case", () => {
    expect(acpUpdateKind({ sessionUpdate: "agentMessageChunk" })).toBe(
      "agent_message_chunk",
    );
  });

  test("snake_case `session_update` field name is also accepted", () => {
    // Defensive against a serde rename divergence between the
    // crate version we vendored and a future agent build.
    expect(acpUpdateKind({ session_update: "tool_call" })).toBe("tool_call");
  });

  test("missing discriminator returns null", () => {
    expect(acpUpdateKind({})).toBeNull();
  });
});

// ---------- extractAcpUsageDelta ----------

describe("extractAcpUsageDelta", () => {
  test("first usage_update returns the absolute counts as a delta", () => {
    const parsed = parseAcpUpdate(
      JSON.stringify({
        sessionUpdate: "usage_update",
        contextWindow: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 5,
          cacheReadTokens: 1000,
        },
        costUsd: 0.0125,
      }),
    );
    const delta = extractAcpUsageDelta(parsed!);
    expect(delta).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 5,
      cacheReadTokens: 1000,
      costUsd: 0.0125,
      model: null,
    });
  });

  test("subsequent usage_update returns only the increase", () => {
    extractAcpUsageDelta(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "usage_update",
          contextWindow: { inputTokens: 100, outputTokens: 20 },
          costUsd: 0.01,
        }),
      )!,
    );
    const delta = extractAcpUsageDelta(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "usage_update",
          contextWindow: { inputTokens: 150, outputTokens: 50 },
          costUsd: 0.03,
        }),
      )!,
    );
    expect(delta?.inputTokens).toBe(50);
    expect(delta?.outputTokens).toBe(30);
    expect(delta?.costUsd).toBeCloseTo(0.02, 6);
  });

  test("declining totals (impossible in practice) clamp to zero", () => {
    extractAcpUsageDelta(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "usage_update",
          contextWindow: { inputTokens: 100 },
        }),
      )!,
    );
    const delta = extractAcpUsageDelta(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "usage_update",
          contextWindow: { inputTokens: 50 },
        }),
      )!,
    );
    expect(delta?.inputTokens).toBe(0);
  });

  test("non-usage events return null", () => {
    expect(
      extractAcpUsageDelta(
        parseAcpUpdate('{"sessionUpdate":"agent_message_chunk"}')!,
      ),
    ).toBeNull();
  });

  test("resetAcpUsageBaseline lets the next usage_update return absolute again", () => {
    extractAcpUsageDelta(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "usage_update",
          contextWindow: { inputTokens: 999 },
        }),
      )!,
    );
    resetAcpUsageBaseline();
    const delta = extractAcpUsageDelta(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "usage_update",
          contextWindow: { inputTokens: 10 },
        }),
      )!,
    );
    expect(delta?.inputTokens).toBe(10);
  });
});

// ---------- classifyStreamingVisibility ----------

describe("classifyStreamingVisibility", () => {
  const earlierWith = (...texts: string[]): LineSnapshot[] =>
    texts.map((text) => ({ kind: "stdout" as const, text }));

  test("no prior matches → visible as-is", () => {
    const r = classifyStreamingVisibility("hello", "stdout", earlierWith());
    expect(r).toEqual({ hidden: false, text: "hello" });
  });

  test("current text equals a prior line → hidden (replay still building)", () => {
    const r = classifyStreamingVisibility(
      "Готово.",
      "stdout",
      earlierWith("Готово."),
    );
    expect(r.hidden).toBe(true);
    expect(r.text).toBe("Готово.");
  });

  test("current is a strict prefix of a prior line → hidden (replay in progress)", () => {
    const r = classifyStreamingVisibility(
      "Гот",
      "stdout",
      earlierWith("Готово. Создал папку."),
    );
    expect(r.hidden).toBe(true);
    expect(r.text).toBe("Гот");
  });

  test("current strictly extends a prior line → visible with prefix trimmed", () => {
    const r = classifyStreamingVisibility(
      "Готово. Создал папку.Удалю её.",
      "stdout",
      earlierWith("Готово. Создал папку."),
    );
    expect(r.hidden).toBe(false);
    expect(r.text).toBe("Удалю её.");
  });

  test("multiple priors — picks the longest as prefix when trimming", () => {
    // Both "Готово." and "Готово. Создал папку." are prefixes of
    // the current text. The longer prior trims more, exposing only
    // the truly-new tail.
    const r = classifyStreamingVisibility(
      "Готово. Создал папку.Удалю.",
      "stdout",
      earlierWith("Готово.", "Готово. Создал папку.", "other text"),
    );
    expect(r.hidden).toBe(false);
    expect(r.text).toBe("Удалю.");
  });

  test("lines of a different kind are not matched", () => {
    const r = classifyStreamingVisibility(
      "Готово.",
      "stdout",
      [{ kind: "system", text: "Готово." }],
    );
    // System-kind prior doesn't dedup a stdout line.
    expect(r.hidden).toBe(false);
  });

  test("trimming strips leading whitespace from the remainder", () => {
    const r = classifyStreamingVisibility(
      "prior\n\n  new",
      "stdout",
      earlierWith("prior"),
    );
    expect(r.text).toBe("new");
  });
});

// ---------- renderAcpUpdate dispatcher ----------

describe("renderAcpUpdate", () => {
  test("agent_message_chunk renders as streaming stdout with text", () => {
    const r = renderAcpUpdate(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        }),
      )!,
    );
    expect(r).toEqual([{ kind: "stdout", text: "hello", streaming: true }]);
  });

  test("agent_message_chunk with non-text content renders a placeholder", () => {
    // Image / audio / resource content blocks render as their
    // placeholder so the user sees that the agent included non-text
    // content rather than silently dropping it.
    const r = renderAcpUpdate(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "image" },
        }),
      )!,
    );
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("(image)");
    expect(r[0].streaming).toBe(true);
  });

  test("agent_thought_chunk renders with thinking marker", () => {
    const r = renderAcpUpdate(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "let me think about this" },
        }),
      )!,
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("system");
    expect(r[0].text).toMatch(/^🧠 /);
  });

  test("empty agent_thought_chunk produces a bare thinking marker", () => {
    const r = renderAcpUpdate(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "" },
        }),
      )!,
    );
    expect(r).toEqual([{ kind: "system", text: "🧠 thinking…" }]);
  });

  test("user_message_chunk is silently dropped (echoed locally by host)", () => {
    const r = renderAcpUpdate(
      parseAcpUpdate(
        JSON.stringify({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      )!,
    );
    expect(r).toHaveLength(0);
  });

  test("metadata events are silent", () => {
    for (const kind of [
      "available_commands_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
    ]) {
      const r = renderAcpUpdate(
        parseAcpUpdate(JSON.stringify({ sessionUpdate: kind }))!,
      );
      expect(r).toHaveLength(0);
    }
  });

  test("unknown variants fall back to raw passthrough", () => {
    const r = renderAcpUpdate(
      parseAcpUpdate('{"sessionUpdate":"some_future_variant"}')!,
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("stdout");
  });
});

// ---------- renderAcpToolCall ----------

describe("renderAcpToolCall", () => {
  test("uses agent-provided title and includes dedup id", () => {
    const r = renderAcpToolCall({
      toolCallId: "call-42",
      title: "Run unit tests",
      kind: "execute",
      rawInput: { command: "npm test" },
    });
    expect(r).toHaveLength(1);
    expect(r[0].text).toMatch(/^→ Run unit tests/);
    expect(r[0].toolCallId).toBe("start:call-42");
  });

  test("falls back to a humanised kind label when title is missing", () => {
    const r = renderAcpToolCall({
      toolCallId: "x",
      kind: "execute",
      rawInput: { command: "ls" },
    });
    expect(r[0].text).toMatch(/^→ Bash/);
  });
});

// ---------- renderAcpToolCallUpdate ----------

describe("renderAcpToolCallUpdate", () => {
  test("status=completed with content shows full output", () => {
    const r = renderAcpToolCallUpdate({
      toolCallId: "x",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "output here" } }],
    });
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("system");
    expect(r[0].text).toBe("← completed\noutput here");
    expect(r[0].toolCallId).toBe("end:x");
  });

  test("status=failed renders as stderr", () => {
    const r = renderAcpToolCallUpdate({
      toolCallId: "x",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    expect(r[0].kind).toBe("stderr");
    expect(r[0].text).toBe("✘ failed\nboom");
  });

  test("content-only update (no status) renders with 'output' label", () => {
    // Codex sends progressive content updates without status changes.
    // The renderer should surface those rather than swallow them.
    const r = renderAcpToolCallUpdate({
      toolCallId: "x",
      content: [{ type: "content", content: { type: "text", text: "partial" } }],
    });
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("← output\npartial");
  });

  test("status=in_progress without content is silent (pure heartbeat)", () => {
    const r = renderAcpToolCallUpdate({
      toolCallId: "x",
      status: "in_progress",
    });
    expect(r).toHaveLength(0);
  });

  test("status=completed without content shows bare marker", () => {
    const r = renderAcpToolCallUpdate({ toolCallId: "x", status: "completed" });
    expect(r[0].text).toBe("← completed");
  });
});

// ---------- toolCallDedupKey ----------

describe("toolCallDedupKey", () => {
  test("camelCase toolCallId at top level", () => {
    expect(toolCallDedupKey({ toolCallId: "abc" }, "start")).toBe("start:abc");
  });

  test("snake_case tool_call_id fallback (defensive against schema drift)", () => {
    expect(toolCallDedupKey({ tool_call_id: "abc" }, "end")).toBe("end:abc");
  });

  test("missing id returns undefined", () => {
    expect(toolCallDedupKey({}, "start")).toBeUndefined();
  });

  test("start vs end prefix distinguishes the two render paths", () => {
    expect(toolCallDedupKey({ toolCallId: "x" }, "start")).toBe("start:x");
    expect(toolCallDedupKey({ toolCallId: "x" }, "end")).toBe("end:x");
  });
});

// ---------- readContentText ----------

describe("readContentText", () => {
  test("text block returns the text", () => {
    expect(readContentText({ type: "text", text: "hi" })).toBe("hi");
  });

  test("text block without `text` returns null", () => {
    expect(readContentText({ type: "text" })).toBeNull();
  });

  test("image / audio render as placeholders", () => {
    expect(readContentText({ type: "image" })).toBe("(image)");
    expect(readContentText({ type: "audio" })).toBe("(audio)");
  });

  test("resource_link with uri", () => {
    expect(
      readContentText({ type: "resource_link", uri: "https://x" }),
    ).toBe("(resource: https://x)");
  });

  test("unknown variant returns null", () => {
    expect(readContentText({ type: "future_kind" })).toBeNull();
  });

  test("non-record input returns null", () => {
    expect(readContentText(null)).toBeNull();
    expect(readContentText("string")).toBeNull();
  });
});

// ---------- extractToolCallFullText ----------

describe("extractToolCallFullText", () => {
  test("returns null for empty / non-array", () => {
    expect(extractToolCallFullText([])).toBeNull();
    expect(extractToolCallFullText(null)).toBeNull();
  });

  test("single content entry returns its text", () => {
    expect(
      extractToolCallFullText([
        { type: "content", content: { type: "text", text: "hello" } },
      ]),
    ).toBe("hello");
  });

  test("multiple content entries are joined with newlines", () => {
    expect(
      extractToolCallFullText([
        { type: "content", content: { type: "text", text: "line 1" } },
        { type: "content", content: { type: "text", text: "line 2" } },
      ]),
    ).toBe("line 1\nline 2");
  });

  test("diff entries render as `diff <path>`", () => {
    expect(
      extractToolCallFullText([{ type: "diff", path: "/foo/bar.rs" }]),
    ).toBe("diff /foo/bar.rs");
  });

  test("non-text-bearing entries are skipped", () => {
    expect(
      extractToolCallFullText([
        { type: "content", content: { type: "image" } },
      ]),
    ).toBe("(image)");
  });

  test("whitespace is preserved verbatim", () => {
    expect(
      extractToolCallFullText([
        { type: "content", content: { type: "text", text: "  spaced\n\nout" } },
      ]),
    ).toBe("  spaced\n\nout");
  });
});

// ---------- clipToolOutput ----------

describe("clipToolOutput", () => {
  test("short text passes through unchanged", () => {
    expect(clipToolOutput("short")).toBe("short");
  });

  test("text at the cap passes through unchanged", () => {
    const exactly = "x".repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(clipToolOutput(exactly).length).toBe(MAX_TOOL_OUTPUT_CHARS);
  });

  test("text past the cap is truncated with an ellipsis", () => {
    const tooLong = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100);
    const clipped = clipToolOutput(tooLong);
    expect(clipped.length).toBe(MAX_TOOL_OUTPUT_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

// ---------- summariseToolInput ----------

describe("summariseToolInput", () => {
  test("string `command` field surfaces with a leading space", () => {
    expect(summariseToolInput({ command: "ls -la" })).toBe(" ls -la");
  });

  test("array `command` extracts the shell payload from /bin/zsh wrapper", () => {
    // Codex emits commands as ["/bin/zsh", "-lc", "<actual>"]. The
    // wrapper bits are noise; the meaningful payload is the last
    // element.
    expect(
      summariseToolInput({
        command: ["/bin/zsh", "-lc", "mkdir -p ~/foo"],
      }),
    ).toBe(" mkdir -p ~/foo");
  });

  test("short string-array command joins with spaces", () => {
    expect(summariseToolInput({ command: ["ls", "-la"] })).toBe(" ls -la");
  });

  test("falls back to file_path / path / pattern / url / prompt in order", () => {
    expect(summariseToolInput({ file_path: "/foo" })).toBe(" /foo");
    expect(summariseToolInput({ filePath: "/foo" })).toBe(" /foo");
    expect(summariseToolInput({ pattern: "*.rs" })).toBe(" *.rs");
    expect(summariseToolInput({ url: "https://x" })).toBe(" https://x");
  });

  test("non-record input returns empty string", () => {
    expect(summariseToolInput(null)).toBe("");
    expect(summariseToolInput("string")).toBe("");
  });

  test("long string is truncated", () => {
    const long = "a".repeat(500);
    const result = summariseToolInput({ command: long });
    expect(result.length).toBeLessThan(500);
    expect(result).toMatch(/…$/);
  });
});

// ---------- toolKindLabel ----------

describe("toolKindLabel", () => {
  test("known kinds get a friendly label", () => {
    expect(toolKindLabel("execute")).toBe("Bash");
    expect(toolKindLabel("read")).toBe("Read");
    expect(toolKindLabel("edit")).toBe("Edit");
  });

  test("unknown kinds pass through verbatim", () => {
    // Defensive — a future ACP `ToolKind` variant shouldn't disappear.
    expect(toolKindLabel("future_kind")).toBe("future_kind");
  });
});
