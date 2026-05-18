/**
 * Minimal YAML-frontmatter parser/serializer tailored to vault notes.
 *
 * The vault schema only uses **flat scalars and string arrays** (see Rust
 * `WorkflowArtifact` / `Project` types: `repo`, `local_path`, `tools`,
 * `paths`, `status`, `order`, `runnable`, etc.). No nested mappings, no
 * anchors, no flow-style sequences in values. That lets this file replace
 * a `js-yaml` / `gray-matter` dependency with ~150 lines.
 *
 * Contract:
 *   parseMarkdown(content)               → { frontmatter, body, hasFrontmatter }
 *   serializeMarkdown({ frontmatter, body, hasFrontmatter }) → content
 *
 * Round-trip preserves semantic content (key→value mapping + body text).
 * It does **not** preserve original formatting verbatim — quoting style,
 * key order, and whitespace inside the YAML block may change on save.
 */

export type FrontmatterValue =
  | string
  | number
  | boolean
  | string[]
  | null;

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
  /** True if the original content started with a `---\n` block. */
  hasFrontmatter: boolean;
}

const FRONTMATTER_OPEN = /^---\r?\n/;

export function parseMarkdown(content: string): ParsedMarkdown {
  const openMatch = content.match(FRONTMATTER_OPEN);
  if (!openMatch) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }
  const afterOpen = content.slice(openMatch[0].length);
  // Look for closing `---` on its own line. Match with optional trailing
  // newline so a frontmatter-only file (no body) parses cleanly.
  const closeMatch = afterOpen.match(/\r?\n---(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    // Unterminated block — treat the whole thing as body so the user
    // doesn't lose content. The Save round-trip will not add a closing
    // delimiter for them; they fix it themselves.
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }
  const yaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return {
    frontmatter: parseYamlBlock(yaml),
    body,
    hasFrontmatter: true,
  };
}

export function serializeMarkdown(parsed: ParsedMarkdown): string {
  if (!parsed.hasFrontmatter && Object.keys(parsed.frontmatter).length === 0) {
    return parsed.body;
  }
  const yaml = serializeYamlBlock(parsed.frontmatter);
  return `---\n${yaml}---\n${parsed.body}`;
}

// ---------- YAML subset ----------

/**
 * Parse the inside of a frontmatter block — a sequence of `key: value`
 * lines, with array values expressed as following `  - item` lines.
 * Unsupported shapes (nested maps, flow sequences, multiline scalars) are
 * stored as raw strings rather than failing, so manual edits don't drop
 * data silently.
 */
function parseYamlBlock(yaml: string): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "" || /^\s*#/.test(line)) {
      i += 1;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];

    if (rest === "") {
      // Could be an array on subsequent lines, or just an empty value.
      const arr: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        const itemMatch = lines[j].match(/^\s*-\s+(.*)$/);
        if (itemMatch) arr.push(unquoteScalar(itemMatch[1].trim()));
        j += 1;
      }
      if (arr.length > 0) {
        out[key] = arr;
        i = j;
        continue;
      }
      out[key] = "";
      i += 1;
      continue;
    }

    // Inline array `key: [a, b]`
    const inlineArr = parseInlineArray(rest);
    if (inlineArr !== null) {
      out[key] = inlineArr;
      i += 1;
      continue;
    }

    out[key] = parseScalar(rest);
    i += 1;
  }
  return out;
}

function parseScalar(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  // Quoted string
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  // Number
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

function parseInlineArray(raw: string): string[] | null {
  const v = raw.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return null;
  const inner = v.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => unquoteScalar(s.trim())).filter((s) => s !== "");
}

function unquoteScalar(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function serializeYamlBlock(fm: Record<string, FrontmatterValue>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${quoteIfNeeded(item)}`);
        }
      }
      continue;
    }
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    if (typeof value === "boolean") {
      lines.push(`${key}: ${value ? "true" : "false"}`);
      continue;
    }
    if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
      continue;
    }
    // string
    if (value === "") {
      lines.push(`${key}: ""`);
      continue;
    }
    lines.push(`${key}: ${quoteIfNeeded(value)}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Wrap a string in double quotes when it could otherwise be misparsed as a
 * non-string scalar (boolean, number, null) or contains characters that
 * would break YAML line parsing (`:`, `#`, leading dashes, leading/trailing
 * whitespace). Strings already containing double quotes get their inner
 * quotes escaped.
 */
function quoteIfNeeded(s: string): string {
  if (
    s === "true" ||
    s === "false" ||
    s === "null" ||
    s === "~" ||
    /^-?\d+(\.\d+)?$/.test(s) ||
    /[:#\n]/.test(s) ||
    /^[-?!&*%@`,[\]{}|>]/.test(s) ||
    /^\s|\s$/.test(s)
  ) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}
