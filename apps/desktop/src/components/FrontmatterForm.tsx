import { useMemo, useState } from "react";

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
 * A small `+ Add field` affordance in the header lets the user create
 * a new key with an explicit type — the only way to add structure
 * since CodeMirror displays the body (`parsed.body`), not the YAML
 * block. Deleting keys still requires editing the file outside the
 * IDE for now.
 */
type NewFieldType = "string" | "number" | "boolean" | "array";

function defaultForType(t: NewFieldType): FrontmatterValue {
  switch (t) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
  }
}

export function FrontmatterForm({
  frontmatter,
  hasFrontmatter,
  readOnly = false,
  onChange,
}: FrontmatterFormProps) {
  const keys = useMemo(() => Object.keys(frontmatter), [frontmatter]);
  const existingKeys = useMemo(() => new Set(keys), [keys]);
  const [adding, setAdding] = useState(false);

  if (!hasFrontmatter || keys.length === 0) return null;

  const update = (key: string, next: FrontmatterValue) => {
    onChange({ ...frontmatter, [key]: next });
  };

  const commitNewField = (name: string, type: NewFieldType) => {
    onChange({ ...frontmatter, [name]: defaultForType(type) });
    setAdding(false);
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
              : "Removing keys still requires editing the file outside the IDE."
          }
        >
          {keys.length} field{keys.length === 1 ? "" : "s"}
          {readOnly && " · read-only"}
        </span>
        {!readOnly && !adding && (
          <button
            type="button"
            className="fm-form__add-btn"
            onClick={() => setAdding(true)}
            title="Add a new frontmatter field"
          >
            + Add field
          </button>
        )}
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
        {!readOnly && adding && (
          <AddFieldRow
            existingKeys={existingKeys}
            onCommit={commitNewField}
            onCancel={() => setAdding(false)}
          />
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

interface AddFieldRowProps {
  existingKeys: Set<string>;
  onCommit: (name: string, type: NewFieldType) => void;
  onCancel: () => void;
}

/**
 * Inline new-field row revealed by the `+ Add field` header button.
 * The user picks a key name + a type (so we can default the value to
 * the right primitive — `""` / `0` / `false` / `[]` — and the existing
 * row renderer infers the input shape from that primitive without any
 * special casing).
 *
 * Validation is local: non-empty key, not already in `existingKeys`,
 * matches a conservative YAML-friendly identifier pattern (letter or
 * underscore start, then letters / digits / underscore / dash).
 * `Enter` commits, `Esc` cancels — both fire even when focused inside
 * the text input.
 */
function AddFieldRow({ existingKeys, onCommit, onCancel }: AddFieldRowProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<NewFieldType>("string");
  const trimmed = name.trim();
  const validShape = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed);
  const duplicate = existingKeys.has(trimmed);
  const error =
    trimmed === ""
      ? null
      : duplicate
        ? `\`${trimmed}\` already exists`
        : !validShape
          ? "use letters, digits, _ and -"
          : null;
  const canCommit = trimmed !== "" && !duplicate && validShape;

  const commit = () => {
    if (canCommit) onCommit(trimmed, type);
  };

  return (
    <div className="fm-form__row fm-form__row--add" role="group" aria-label="Add new field">
      <input
        type="text"
        autoFocus
        className="fm-form__input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="field name"
        aria-label="New field name"
        aria-invalid={error !== null}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <select
        className="fm-form__add-type"
        value={type}
        onChange={(e) => setType(e.target.value as NewFieldType)}
        aria-label="New field type"
      >
        <option value="string">text</option>
        <option value="number">number</option>
        <option value="boolean">true/false</option>
        <option value="array">list</option>
      </select>
      <button
        type="button"
        className="fm-form__add-commit"
        onClick={commit}
        disabled={!canCommit}
        title={error ?? "Add field (Enter)"}
      >
        Add
      </button>
      <button
        type="button"
        className="fm-form__add-cancel"
        onClick={onCancel}
        title="Cancel (Esc)"
      >
        Cancel
      </button>
      {error && (
        <span className="fm-form__add-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
