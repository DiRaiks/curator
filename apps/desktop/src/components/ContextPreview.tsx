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
import { Tooltip } from "./Tooltip";

const SURFACED_TOOLTIP =
  "Files the prompt makes the agent aware of. AGENTS.md, the prompt itself, the project index, and any existing output file are explicitly required reads; project documents are surfaced via the project-folder pointer but the agent decides which to open.\n\nThe agent has read access to the entire vault via --add-dir; this list is a map, not a sandbox.";

const PRIVACY_ZONES_TOOLTIP =
  "Zones AGENTS.md asks the agent to leave alone. Listed for transparency — the agent has read access to the full vault and these files are not blocked at the filesystem level. Use the chat panel's 'Skip personal zones' toggle to inject a hard preamble for runs where this matters.";

// ---------- Labels ----------

type ReasonTone = "info" | "accent" | "ok" | "warn";

/**
 * Short reason badge text + semantic tone. The tone drives the badge
 * background/foreground tokens via `.reason-badge--{tone}` and stays
 * stable across the included-files list and any future per-row badges
 * so users learn the colour language once.
 */
const REASON_LABELS: Record<IncludeReason, { label: string; tone: ReasonTone }> =
  {
    "meta-agents-rules": { label: "meta", tone: "info" },
    "selected-prompt": { label: "prompt", tone: "accent" },
    "project-index": { label: "index", tone: "ok" },
    "project-document": { label: "project", tone: "ok" },
    "existing-output-file": { label: "output", tone: "warn" },
  };

type BucketTone = "err" | "warn" | "muted";

/**
 * Excluded-content buckets, in display order. Order is "loudest first"
 * — buckets that point at real security concerns (personal-work,
 * team-management) lead so the user notices counts > 0 immediately.
 * Buckets whose count is zero are filtered out at render time.
 */
const BUCKETS: ReadonlyArray<{
  key: keyof ExcludedCounts;
  label: string;
  tone: BucketTone;
}> = [
  { key: "personalWork", label: "personal-work", tone: "err" },
  { key: "teamManagement", label: "team-management", tone: "err" },
  { key: "inbox", label: "inbox", tone: "warn" },
  { key: "archiveOrResource", label: "archive/resource", tone: "muted" },
  { key: "bak", label: ".bak files", tone: "muted" },
  { key: "ignoredPath", label: "ignored paths", tone: "muted" },
];

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
  isRefreshing?: boolean;
  /** Create a Markdown file at the given vault-relative path and open it in
   *  the editor. Optional — if omitted, the Create-output-stub affordance is
   *  hidden. */
  onCreateAndOpenFile?: (relativePath: string) => Promise<void>;
  /** Result of `inspect_source_repo` for the selected project, when
   *  available. The SourceRepoCard overlays real connectivity status on top
   *  of the basic frontmatter metadata. */
  sourceRepoInspection?: SourceRepoInspection | null;
  /** Stage the artifact's materialized prompt into the bottom chat panel
   *  (instead of spawning the runner directly). Forwarded into
   *  `ExternalRunnerPromptCard`'s primary action. */
  onStagePrompt: (args: {
    text: string;
    projectSlug: string;
    promptId: string;
  }) => string | null;
}

export function ContextPreviewPanel({
  preview,
  homeDir,
  isRefreshing = false,
  onCreateAndOpenFile,
  sourceRepoInspection,
  onStagePrompt,
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
      {/* Secondary action: stage the prompt into the chat panel, or copy
       * it for paste into Zed / Claude / Codex / Cursor. Collapsed by
       * default so the card focuses on the run plan; advanced users
       * expand it. */}
      <details className="external-runner-details">
        <summary className="external-runner-details__summary">
          Runner prompt — open in chat, or copy for another agent
        </summary>
        <ExternalRunnerPromptCard
          prompt={preview.externalRunnerPrompt}
          unresolvedPlaceholders={preview.unresolvedPlaceholders}
          projectSlug={preview.projectSlug}
          promptId={preview.promptId}
          onStagePrompt={onStagePrompt}
        />
      </details>
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
      title:
        "Project does not declare `local_path` in _index.md or _local.md.",
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
          Project doesn't declare <code>local_path</code> in{" "}
          <code>_index.md</code> or a <code>_local.md</code> overlay. The
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
        Warnings · {warnings.length}
      </h4>
      <ul className="warnings-list">
        {warnings.map((w, i) => (
          <li key={i} className="warning-row">
            <span className="warning-row__glyph" aria-hidden="true">
              ⚠
            </span>
            <span
              className="warning-row__kind"
              title={WARNING_LABEL[w.kind]}
            >
              [{w.kind}]
            </span>
            <span className="warning-row__message">{w.message}</span>
            {w.path && (
              <span className="warning-row__path">{w.path}</span>
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
      aria-label="Vault files surfaced to the agent"
    >
      <h4 className="preview__section-title">
        Surfaced · {files.length} file{files.length === 1 ? "" : "s"}
        <Tooltip content={SURFACED_TOOLTIP} placement="bottom" align="start">
          <span
            className="preview__section-hint"
            aria-label="What 'surfaced' means"
          >
            (info)
          </span>
        </Tooltip>
      </h4>
      {files.length === 0 ? (
        <p className="empty">No vault files would be included.</p>
      ) : (
        <ul className="list">
          {files.map((f) => (
            <li key={f.path} className="list__item">
              <div className="list__primary">
                <ReasonBadge reason={f.reason} />
                <span className="list__path">{f.path}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReasonBadge({ reason }: { reason: IncludeReason }) {
  const { label, tone } = REASON_LABELS[reason];
  return (
    <span
      className={`reason-badge reason-badge--${tone}`}
      title={reason}
    >
      {label}
    </span>
  );
}

// ---------- Excluded counts ----------

function ExcludedBlock({ counts }: { counts: ExcludedCounts }) {
  // Buckets with zero hits are filtered out — the user only sees what's
  // actually being excluded so the panel stays scannable. The total is
  // the sum over ALL buckets (the empties contribute zero anyway).
  const nonZero = BUCKETS.filter(({ key }) => counts[key] > 0);
  const total = BUCKETS.reduce((acc, { key }) => acc + counts[key], 0);

  return (
    <section
      className="preview__excluded"
      aria-label="Privacy zones listed off-limits by convention"
    >
      <h4 className="preview__section-title">
        Privacy zones · {total} file{total === 1 ? "" : "s"}
        <span className="preview__total">informational — not blocked</span>
        <Tooltip
          content={PRIVACY_ZONES_TOOLTIP}
          placement="bottom"
          align="start"
        >
          <span
            className="preview__section-hint"
            aria-label="What 'privacy zones' means"
          >
            (info)
          </span>
        </Tooltip>
      </h4>
      {nonZero.length === 0 ? (
        <p className="empty">Nothing excluded.</p>
      ) : (
        <ul className="bucket-grid" aria-label="Exclusions">
          {nonZero.map(({ key, label, tone }) => (
            <li key={key} className="bucket-pill">
              <span
                className={"bucket-pill__dot bucket-pill__dot--" + tone}
                aria-hidden="true"
              />
              <span className="bucket-pill__label">{label}</span>
              <span className="bucket-pill__count">{counts[key]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="preview__excluded-hint">
        Listed here for transparency. By default the agent has read access
        to the entire vault via <code>--add-dir</code>; these zones are{" "}
        <strong>not</strong> blocked at the filesystem level. Toggle{" "}
        <strong>🔒 Skip personal zones</strong> in the chat panel to
        inject a hard preamble that tells the agent to stay out of
        personal-work and team-management content for that run.
      </p>
    </section>
  );
}
