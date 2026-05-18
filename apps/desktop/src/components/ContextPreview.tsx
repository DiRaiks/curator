import { useState } from "react";
import type {
  ContextPreview,
  ExcludedCounts,
  IncludedFile,
  IncludeReason,
  PreviewWarning,
  SourceRepoInspection,
  SourceRepoStatus,
  WarningKind,
} from "../types";
import { maskHome } from "../utils/path";
import { ExternalRunnerPromptCard } from "./ExternalRunnerPromptCard";

// ---------- Labels ----------

const REASON_SHORT: Record<IncludeReason, string> = {
  "meta-agents-rules": "meta agent rules",
  "selected-prompt": "selected prompt",
  "project-index": "project index",
  "project-document": "project document",
  "existing-output-file": "existing output file",
};

const WARNING_LABEL: Record<WarningKind, string> = {
  "output-file-missing": "output_file missing",
  "output-file-outside-project": "output_file outside project",
  "output-file-unresolved-placeholder": "unresolved placeholder",
  "prompt-not-runnable": "prompt not runnable",
  "unresolved-placeholder": "unresolved placeholder",
};

// ---------- Main component ----------

interface ContextPreviewPanelProps {
  preview: ContextPreview;
  homeDir: string | null;
  /** Absolute path of the active vault. Forwarded to `start_run` so the
   *  Run button can spawn the local CLI without re-resolving paths. */
  vaultRoot: string;
  isRefreshing?: boolean;
  /** Create a Markdown file at the given vault-relative path and open it in
   *  the editor. Optional — if omitted, the Create-output-stub affordance is
   *  hidden. */
  onCreateAndOpenFile?: (relativePath: string) => Promise<void>;
  /** Result of `inspect_source_repo` for the selected project, when
   *  available. The SourceRepoCard overlays real connectivity status on top
   *  of the basic frontmatter metadata. */
  sourceRepoInspection?: SourceRepoInspection | null;
}

export function ContextPreviewPanel({
  preview,
  homeDir,
  vaultRoot,
  isRefreshing = false,
  onCreateAndOpenFile,
  sourceRepoInspection,
}: ContextPreviewPanelProps) {
  return (
    <article
      className="preview"
      aria-label={`Run plan preview for ${preview.promptId}`}
    >
      <SummaryCard
        preview={preview}
        isRefreshing={isRefreshing}
        onCreateAndOpenFile={onCreateAndOpenFile}
      />
      <ExternalRunnerPromptCard
        prompt={preview.externalRunnerPrompt}
        unresolvedPlaceholders={preview.unresolvedPlaceholders}
        vaultRoot={vaultRoot}
        projectSlug={preview.projectSlug}
        promptId={preview.promptId}
      />
      <SourceRepoCard
        sourceRepo={preview.sourceRepo}
        inspection={sourceRepoInspection ?? null}
        homeDir={homeDir}
      />
      {preview.warnings.length > 0 && (
        <WarningsBlock warnings={preview.warnings} />
      )}
      <VaultFilesBlock files={preview.included} />
      <ExcludedBlock counts={preview.excludedCounts} />
    </article>
  );
}

// ---------- Summary card ----------

function SummaryCard({
  preview,
  isRefreshing,
  onCreateAndOpenFile,
}: {
  preview: ContextPreview;
  isRefreshing: boolean;
  onCreateAndOpenFile?: (relativePath: string) => Promise<void>;
}) {
  const canCreateStub =
    onCreateAndOpenFile != null &&
    preview.resolvedOutputFile != null &&
    !preview.outputFileExists &&
    !preview.resolvedOutputFile.includes("<") &&
    preview.resolvedOutputFile.endsWith(".md");
  return (
    <section className="preview__summary" aria-label="Run plan preview summary">
      <header className="preview__header">
        <h3 className="preview__title">
          Run Plan Preview · {preview.promptId}
          {isRefreshing && (
            <span className="preview__refresh" aria-live="polite">
              refreshing…
            </span>
          )}
        </h3>
        <p className="preview__hint">
          Read-only plan for the next AI run. The primary execution path will
          be a sandboxed workspace with this vault subset plus the connected
          source repo. No AI is called. No vault files are modified.
        </p>
      </header>

      <div className="preview__summary-grid">
        <SummaryRow label="project" value={preview.projectSlug} />
        <SummaryRow
          label="workflow"
          value={
            preview.promptTitle && preview.promptTitle !== preview.promptId
              ? `${preview.promptId} — ${preview.promptTitle}`
              : preview.promptId
          }
        />
        <SummaryRow
          label="prompt path"
          value={preview.promptPath}
          mono
        />
        <SummaryRow
          label="output_file"
          value={preview.resolvedOutputFile ?? "—"}
          mono
          rightAdornment={
            preview.resolvedOutputFile ? (
              <span
                className={
                  "tag " +
                  (preview.outputFileExists ? "tag--runnable" : "tag--ref")
                }
              >
                {preview.outputFileExists ? "exists" : "missing"}
              </span>
            ) : null
          }
        />
      </div>

      {canCreateStub && (
        <CreateStubRow
          path={preview.resolvedOutputFile!}
          onCreate={onCreateAndOpenFile!}
        />
      )}
    </section>
  );
}

function CreateStubRow({
  path,
  onCreate,
}: {
  path: string;
  onCreate: (relativePath: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(path);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="create-stub">
      <button
        type="button"
        className="btn btn--small"
        onClick={() => {
          void click();
        }}
        disabled={busy}
      >
        {busy ? "Creating…" : "Create output stub"}
      </button>
      <span className="create-stub__hint">
        Stub uses the standard frontmatter template and opens in the editor.
      </span>
      {error && (
        <p className="modal__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface SummaryRowProps {
  label: string;
  value: string;
  mono?: boolean;
  rightAdornment?: React.ReactNode;
}

function SummaryRow({ label, value, mono, rightAdornment }: SummaryRowProps) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span
        className={"field__value" + (mono ? " field__value--mono" : "")}
      >
        {value}
        {rightAdornment && (
          <span style={{ marginLeft: 8 }}>{rightAdornment}</span>
        )}
      </span>
    </div>
  );
}

// ---------- Source repo card ----------

function SourceRepoCard({
  sourceRepo,
  inspection,
  homeDir,
}: {
  sourceRepo: SourceRepoStatus;
  inspection: SourceRepoInspection | null;
  homeDir: string | null;
}) {
  const localPathDisplay = sourceRepo.localPath
    ? maskHome(sourceRepo.localPath, homeDir)
    : null;

  // Concise status tag — derived from real inspection when available.
  let statusTag: { label: string; cls: string; title: string };
  if (!sourceRepo.localPath) {
    statusTag = {
      label: "no local path",
      cls: "tag--ref",
      title: "Project does not declare `local_path` in _index.md.",
    };
  } else if (!inspection) {
    statusTag = {
      label: "inspecting…",
      cls: "tag",
      title: "Inspecting the configured local_path.",
    };
  } else if (!inspection.exists) {
    statusTag = {
      label: "missing",
      cls: "tag--warning",
      title: "Configured local_path does not exist on disk.",
    };
  } else if (!inspection.isGitRepo) {
    statusTag = {
      label: "not git",
      cls: "tag--ref",
      title: "Path exists but is not a git repository.",
    };
  } else {
    statusTag = {
      label: "connected",
      cls: "tag--runnable",
      title: "Path is a git repository.",
    };
  }

  return (
    <section className="preview__resolved" aria-label="Source repo">
      <h4 className="preview__section-title">
        Source repo
        <span className={"tag " + statusTag.cls} title={statusTag.title}>
          {statusTag.label}
        </span>
      </h4>
      {localPathDisplay ? (
        <div className="preview__summary-grid">
          <SummaryRow label="Path" value={localPathDisplay} mono />
          {inspection?.branch && (
            <SummaryRow label="Branch" value={inspection.branch} mono />
          )}
          {inspection?.dirty != null && (
            <SummaryRow
              label="Status"
              value={inspection.dirty ? "dirty" : "clean"}
            />
          )}
        </div>
      ) : (
        <p className="preview__hint">
          Project `_index.md` doesn't declare <code>local_path</code>. The
          sandbox workspace will run with vault files only.
        </p>
      )}
      <p className="preview__hint">
        Will be available to future sandbox runs as <code>./repo</code>. No
        source files are sent to AI in this slice.
      </p>
    </section>
  );
}

// ---------- Warnings ----------

function WarningsBlock({ warnings }: { warnings: PreviewWarning[] }) {
  return (
    <section
      className="preview__warnings"
      aria-label="Warnings"
      role="region"
    >
      <h4 className="preview__section-title">
        Warnings ({warnings.length})
      </h4>
      <ul className="list">
        {warnings.map((w, i) => (
          <li key={i} className="list__item diag diag--warning">
            <div className="list__primary">
              <span className="tag tag--warning">{WARNING_LABEL[w.kind]}</span>
              <span>{w.message}</span>
            </div>
            {w.path && (
              <div className="list__secondary">
                <span className="list__path">{w.path}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Vault files ----------

function VaultFilesBlock({ files }: { files: IncludedFile[] }) {
  return (
    <section
      className="preview__included"
      aria-label="Vault files made available"
    >
      <h4 className="preview__section-title">
        Vault files made available ({files.length})
      </h4>
      {files.length === 0 ? (
        <p className="empty">No vault files would be included.</p>
      ) : (
        <ul className="list">
          {files.map((f) => (
            <li key={f.path} className="list__item">
              <div className="list__primary">
                <span className={"scope scope--" + f.scope}>{f.scope}</span>
                <span className="list__id">{REASON_SHORT[f.reason]}</span>
                <span className="list__path">{f.path}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- Excluded counts ----------

function ExcludedBlock({ counts }: { counts: ExcludedCounts }) {
  const total =
    counts.personalWork +
    counts.teamManagement +
    counts.inbox +
    counts.archiveOrResource +
    counts.ignoredPath +
    counts.bak;

  return (
    <section className="preview__excluded" aria-label="Excluded content">
      <h4 className="preview__section-title">
        Excluded content ({total})
        <span className="preview__total">counts only — no contents shown</span>
      </h4>
      <ul className="zone-summary" aria-label="Exclusions">
        <ExcludedRow
          scope="personal-work"
          label="personal-work excluded"
          count={counts.personalWork}
        />
        <ExcludedRow
          scope="team-management"
          label="team-management excluded"
          count={counts.teamManagement}
        />
        <ExcludedRow
          scope="inbox"
          label="inbox excluded"
          count={counts.inbox}
        />
        <ExcludedRow
          scope="archive"
          label="archive / resource excluded"
          count={counts.archiveOrResource}
        />
        <ExcludedRow
          scope="unknown"
          label="ignored path (.env, .pem, .key) excluded"
          count={counts.ignoredPath}
        />
        <ExcludedRow scope="unknown" label="*.bak excluded" count={counts.bak} />
      </ul>
      <p className="preview__excluded-hint">
        These categories are excluded from project workflows by default. Their
        file contents are <strong>not</strong> read, displayed, or prepared
        for AI context.
      </p>
    </section>
  );
}

interface ExcludedRowProps {
  scope: string;
  label: string;
  count: number;
}

function ExcludedRow({ scope, label, count }: ExcludedRowProps) {
  return (
    <li className="zone-summary__item">
      <span className={"scope scope--" + scope}>{scope}</span>
      <span className="zone-summary__count">{count}</span>
      <span className="zone-summary__zones">{label}</span>
    </li>
  );
}
