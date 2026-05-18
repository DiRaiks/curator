import { useMemo } from "react";

import type { FrontmatterValue } from "../utils/frontmatter";

interface FrontmatterFormProps {
  frontmatter: Record<string, FrontmatterValue>;
  /** True when the source already had a `---` block, even if currently
   *  empty. When false, the form renders nothing — adding the first key
   *  requires editing the source directly. */
  hasFrontmatter: boolean;
  /** When true, values render as static text instead of inputs — paired
   *  with preview mode so reading and editing have visibly different UIs. */
  readOnly?: boolean;
  onChange: (next: Record<string, FrontmatterValue>) => void;
}

/**
 * Lightweight YAML frontmatter editor.
 *
 * Renders one row per existing key, inferring the input shape from the
 * current value:
 *
 *   - boolean → checkbox
 *   - number  → numeric input (kept as `number` in the model)
 *   - array   → comma-separated text input
 *   - null    → text input with `(null)` placeholder
 *   - string  → text input (default)
 *
 * The MVP intentionally does **not** support adding or removing keys here;
 * structural edits go through source mode. This keeps the form
 * conservative — the same key set goes in and comes out, only values change.
 */
export function FrontmatterForm({
  frontmatter,
  hasFrontmatter,
  readOnly = false,
  onChange,
}: FrontmatterFormProps) {
  const keys = useMemo(() => Object.keys(frontmatter), [frontmatter]);

  if (!hasFrontmatter || keys.length === 0) return null;

  const update = (key: string, next: FrontmatterValue) => {
    onChange({ ...frontmatter, [key]: next });
  };

  return (
    <section className="fm-form" aria-label="Frontmatter">
      <header className="fm-form__header">
        <span className="fm-form__title">Frontmatter</span>
        <span
          className="fm-form__hint"
          title={
            readOnly
              ? "Switch to source mode to edit."
              : "Structural edits — adding or removing keys — go through source mode."
          }
        >
          {keys.length} field{keys.length === 1 ? "" : "s"}
          {readOnly && " · read-only"}
        </span>
      </header>
      <div className="fm-form__rows">
        {keys.map((key) =>
          readOnly ? (
            <FrontmatterReadonlyRow
              key={key}
              name={key}
              value={frontmatter[key]}
            />
          ) : (
            <FrontmatterRow
              key={key}
              name={key}
              value={frontmatter[key]}
              onChange={(next) => update(key, next)}
            />
          ),
        )}
      </div>
    </section>
  );
}

interface FrontmatterReadonlyRowProps {
  name: string;
  value: FrontmatterValue;
}

function FrontmatterReadonlyRow({ name, value }: FrontmatterReadonlyRowProps) {
  return (
    <div className="fm-form__row" role="group" aria-label={name}>
      <span className="fm-form__label">{name}</span>
      <span className="fm-form__value">{formatValue(value)}</span>
    </div>
  );
}

function formatValue(value: FrontmatterValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(", ");
  if (typeof value === "number") return String(value);
  return value === "" ? "—" : value;
}

interface FrontmatterRowProps {
  name: string;
  value: FrontmatterValue;
  onChange: (next: FrontmatterValue) => void;
}

function FrontmatterRow({ name, value, onChange }: FrontmatterRowProps) {
  return (
    <label className="fm-form__row">
      <span className="fm-form__label">{name}</span>
      <FrontmatterInput value={value} onChange={onChange} name={name} />
    </label>
  );
}

interface FrontmatterInputProps {
  name: string;
  value: FrontmatterValue;
  onChange: (next: FrontmatterValue) => void;
}

function FrontmatterInput({ name, value, onChange }: FrontmatterInputProps) {
  if (typeof value === "boolean") {
    return (
      <input
        type="checkbox"
        className="fm-form__checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={name}
      />
    );
  }
  if (typeof value === "number") {
    return (
      <input
        type="number"
        className="fm-form__input"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        aria-label={name}
      />
    );
  }
  if (Array.isArray(value)) {
    return (
      <input
        type="text"
        className="fm-form__input fm-form__input--array"
        value={value.join(", ")}
        onChange={(e) => {
          const parts = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
          onChange(parts);
        }}
        placeholder="comma-separated"
        aria-label={`${name} (comma-separated list)`}
      />
    );
  }
  if (value === null) {
    return (
      <input
        type="text"
        className="fm-form__input"
        value=""
        onChange={(e) => {
          // Keep null until the user actually types something — empty edits
          // shouldn't silently flip the field to "".
          onChange(e.target.value === "" ? null : e.target.value);
        }}
        placeholder="(null)"
        aria-label={name}
      />
    );
  }
  // string
  return (
    <input
      type="text"
      className="fm-form__input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={name}
    />
  );
}
