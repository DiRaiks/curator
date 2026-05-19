import { useState } from "react";

import { initProject } from "../api";
import { maskHome } from "../utils/path";
import type { ScanResult } from "../types";

interface EmptyVaultNoProjectsProps {
  result: ScanResult;
  /** Re-scan so the new project appears + Dashboard transitions to its
   *  normal view. */
  onRescan: () => Promise<void>;
  /** Open a freshly-written `_index.md` in the editor. The new path is
   *  relative to the vault root, forward-slash form. */
  onOpenFile: (relativePath: string) => Promise<void> | void;
  /** Skip onboarding entirely and just chat against the vault. The
   *  Dashboard's regular RunPanel handles freeform chats. */
  onChatWithVault: () => void;
}

/**
 * State 2 of the empty-vault onboarding: vault is initialised
 * (`.vault/config.yml` exists) but there are zero projects yet. Shows
 * an inline form for the first project plus a checklist of vault
 * readiness signals so the user understands why the IDE is gating them
 * here rather than showing the full Dashboard.
 *
 * Successful submit: writes `02_projects/<slug>/_index.md`, re-scans
 * the vault, and opens the new file in the editor. The Dashboard's
 * gate flips false (`projects.length > 0`) and the regular view
 * appears around the still-open editor.
 */
export function EmptyVaultNoProjects({
  result,
  onRescan,
  onOpenFile,
  onChatWithVault,
}: EmptyVaultNoProjectsProps) {
  const [slug, setSlug] = useState("");
  const [myRole, setMyRole] = useState("owner");
  const [repo, setRepo] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugError = slug.length > 0 && !isKebabCase(slug)
    ? "Use lowercase letters, digits, and dashes only."
    : null;
  const canSubmit =
    !busy && slug.trim().length > 0 && slugError === null && myRole.trim().length > 0;

  const onSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const path = await initProject({
        vaultRoot: result.vaultRoot,
        slug: slug.trim(),
        myRole: myRole.trim(),
        repo: repo.trim() || undefined,
        localPath: localPath.trim() || undefined,
      });
      await onRescan();
      await onOpenFile(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const checklist: ChecklistRow[] = [
    {
      ok: true,
      label: ".vault/config.yml",
      detail: `format ${result.vaultFormatVersion ?? "1"}`,
    },
    { ok: result.hasMeta, label: "00_meta/", detail: result.hasMeta ? "present" : "missing" },
    {
      ok: result.hasAgentsMd,
      label: "00_meta/AGENTS.md",
      detail: result.hasAgentsMd ? "present" : "missing",
    },
    {
      ok: result.projects.length > 0,
      label: "02_projects/<slug>/_index.md",
      detail: "0 projects — start below",
      pending: true,
    },
  ];

  const displayedRoot = maskHome(result.vaultRoot, result.homeDir);

  return (
    <div className="empty-vault" role="region" aria-label="Empty vault onboarding">
      <header className="empty-vault__top">
        <span className="empty-vault__label">{displayedRoot}</span>
        <span className="pill pill--ok">format: {result.vaultFormatVersion ?? "1"}</span>
        <span className="pill pill--ok">privacy: protected</span>
        <span className="pill pill--warn">0 projects</span>
      </header>

      <main className="empty-vault__main">
        <section className="empty-vault__hero empty-vault__hero--no-projects">
          <h1 className="empty-vault__title">
            Vault is ready. Now create your first project.
          </h1>
          <p className="empty-vault__lede">
            A project is a `02_projects/&lt;slug&gt;/` directory with an{" "}
            <code>_index.md</code> describing what it is, who's driving
            it, and (optionally) the source repo it tracks.
          </p>

          <ul className="empty-vault__checklist">
            {checklist.map((row, i) => (
              <li
                key={i}
                className={
                  "empty-vault__checklist-row" +
                  (row.pending
                    ? " empty-vault__checklist-row--pending"
                    : row.ok
                      ? " empty-vault__checklist-row--ok"
                      : " empty-vault__checklist-row--warn")
                }
              >
                <span className="empty-vault__checklist-mark" aria-hidden="true">
                  {row.pending ? "○" : row.ok ? "●" : "○"}
                </span>
                <span className="empty-vault__checklist-label">{row.label}</span>
                <span className="empty-vault__checklist-detail">{row.detail}</span>
              </li>
            ))}
          </ul>

          <form
            className="empty-vault__form"
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
          >
            <FieldRow
              id="empty-vault-slug"
              label="slug"
              hint="kebab-case, e.g. aave-v3-audit"
              value={slug}
              onChange={setSlug}
              required
              mono
              invalid={slugError !== null}
              error={slugError}
              disabled={busy}
            />
            <FieldRow
              id="empty-vault-role"
              label="my_role"
              hint="owner / reviewer / contributor / observer"
              value={myRole}
              onChange={setMyRole}
              required
              disabled={busy}
            />
            <FieldRow
              id="empty-vault-repo"
              label="repo"
              hint="optional — git url, e.g. https://github.com/me/repo"
              value={repo}
              onChange={setRepo}
              mono
              disabled={busy}
            />
            <FieldRow
              id="empty-vault-localpath"
              label="local_path"
              hint="optional — absolute path to a local clone"
              value={localPath}
              onChange={setLocalPath}
              mono
              disabled={busy}
            />

            {error && (
              <p className="empty-vault__error" role="alert">
                {error}
              </p>
            )}

            <div className="empty-vault__actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={!canSubmit}
              >
                {busy ? "Creating…" : "Create first project"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={onChatWithVault}
                disabled={busy}
              >
                Chat with the vault first
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

interface ChecklistRow {
  ok: boolean;
  /** Render this row in neutral "pending" state regardless of `ok`. Used
   *  for the first-project row — it's not red (no problem yet), just
   *  the next step. */
  pending?: boolean;
  label: string;
  detail: string;
}

interface FieldRowProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  mono?: boolean;
  invalid?: boolean;
  error?: string | null;
  disabled?: boolean;
}

function FieldRow({
  id,
  label,
  hint,
  value,
  onChange,
  required = false,
  mono = false,
  invalid = false,
  error,
  disabled = false,
}: FieldRowProps) {
  return (
    <div className="empty-vault__field">
      <label htmlFor={id} className="empty-vault__field-label">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        type="text"
        className={
          "empty-vault__field-input" +
          (mono ? " empty-vault__field-input--mono" : "")
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={invalid}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {error ? (
        <span id={`${id}-error`} className="empty-vault__field-error">
          {error}
        </span>
      ) : (
        <span id={`${id}-hint`} className="empty-vault__field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

function isKebabCase(s: string): boolean {
  if (s.length === 0) return false;
  if (s.startsWith("-") || s.endsWith("-") || s.startsWith(".")) return false;
  for (const ch of s) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-";
    if (!ok) return false;
  }
  return true;
}
