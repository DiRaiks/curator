import { useEffect, useMemo, useState } from "react";
import { inspectSourceRepo, previewContext } from "../api";
import type {
  ArtifactKind,
  ContextPreview,
  Project,
  SourceRepoInspection,
  WorkflowArtifact,
} from "../types";
import { maskHome } from "../utils/path";
import { ContextPreviewPanel } from "./ContextPreview";
import { SourceRepositorySection } from "./SourceRepositorySection";

const RUNNABLE_KIND_LABEL: Record<ArtifactKind, string> = {
  "agent-prompt": "Prompts",
  "claude-command": "Commands",
  "claude-agent": "Agents",
  "claude-skill": "Skills",
  "claude-rule": "Rules",
  "vault-skill": "Vault Skills",
};

/** Stable ordering for kind chips and section sort priority. */
const RUNNABLE_KIND_ORDER: ArtifactKind[] = [
  "agent-prompt",
  "claude-command",
  "claude-agent",
  "claude-skill",
  "vault-skill",
];

type KindFilter = ArtifactKind | "all";

interface ProjectDetailProps {
  project: Project;
  artifacts: WorkflowArtifact[];
  homeDir: string | null;
  vaultRoot: string;
  /** Bumped by Dashboard each time the vault rescan completes. Used to
   *  re-trigger the source-repo inspection so manual Refresh updates this
   *  panel too. */
  refreshTick: number;
  onBack: () => void;
  /** Create a Markdown file at the given vault-relative path and open it in
   *  the editor. Used by the Run Plan "Create output stub" action. Throws on
   *  failure so the child can surface inline errors. */
  onCreateAndOpenFile: (relativePath: string) => Promise<void>;
}

interface FieldProps {
  label: string;
  value: string | null;
  mono?: boolean;
}

function Field({ label, value, mono = false }: FieldProps) {
  if (!value) return null;
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className={"field__value" + (mono ? " field__value--mono" : "")}>
        {value}
      </span>
    </div>
  );
}

export function ProjectDetail({
  project,
  artifacts,
  homeDir,
  vaultRoot,
  refreshTick,
  onBack,
  onCreateAndOpenFile,
}: ProjectDetailProps) {
  const [inspection, setInspection] = useState<SourceRepoInspection | null>(
    null,
  );
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);

  useEffect(() => {
    if (!project.localPath) {
      setInspection(null);
      setInspectionError(null);
      return;
    }
    let cancelled = false;
    setInspectionLoading(true);
    setInspectionError(null);
    inspectSourceRepo(project.localPath)
      .then((r) => {
        if (!cancelled) setInspection(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setInspection(null);
          setInspectionError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setInspectionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.localPath, refreshTick]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const runnableArtifacts = useMemo(() => {
    return artifacts
      .filter((a) => a.runnable)
      .slice()
      .sort((a, b) => {
        // Sort by kind first (agent-prompt → commands → agents → skills),
        // then by declared `order`, then alphabetically. Same as the
        // backend's sort but explicit here so the UI is stable even if
        // the backend tweaks ordering.
        const ka = RUNNABLE_KIND_ORDER.indexOf(a.kind);
        const kb = RUNNABLE_KIND_ORDER.indexOf(b.kind);
        if (ka !== kb) return ka - kb;
        const ao = a.order ?? Number.MAX_SAFE_INTEGER;
        const bo = b.order ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return a.id.localeCompare(b.id);
      });
  }, [artifacts]);

  const kindCounts = useMemo(() => {
    const acc: Record<ArtifactKind, number> = {
      "agent-prompt": 0,
      "claude-command": 0,
      "claude-agent": 0,
      "claude-skill": 0,
      "claude-rule": 0,
      "vault-skill": 0,
    };
    for (const a of runnableArtifacts) {
      acc[a.kind] += 1;
    }
    return acc;
  }, [runnableArtifacts]);

  const visibleArtifacts = useMemo(() => {
    if (kindFilter === "all") return runnableArtifacts;
    return runnableArtifacts.filter((a) => a.kind === kindFilter);
  }, [runnableArtifacts, kindFilter]);

  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!selectedPromptId) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    previewContext(vaultRoot, project.slug, selectedPromptId)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(err instanceof Error ? err.message : String(err));
        setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultRoot, project.slug, selectedPromptId]);

  const localPathDisplay = project.localPath
    ? maskHome(project.localPath, homeDir)
    : null;

  return (
    <div className="project-detail">
      <nav className="breadcrumb" aria-label="breadcrumb">
        <button
          type="button"
          className="breadcrumb__back"
          onClick={onBack}
          aria-label="Back to project list"
        >
          ← Projects
        </button>
        <span className="breadcrumb__sep">/</span>
        <span className="breadcrumb__current">{project.slug}</span>
      </nav>

      <SourceRepositorySection
        project={project}
        homeDir={homeDir}
        inspection={inspection}
        loading={inspectionLoading}
        error={inspectionError}
      />

      <section className="project-detail__meta">
        <h2 className="project-detail__title">{project.slug}</h2>
        <div className="project-detail__tags">
          {project.status && <span className="tag">{project.status}</span>}
          {project.myRole && <span className="tag">{project.myRole}</span>}
        </div>
        <div className="fields">
          <Field label="index file" value={project.indexFile} mono />
          <Field label="repo" value={project.repo} mono />
          <Field label="local_path" value={localPathDisplay} mono />
          <Field
            label="default_base_branch"
            value={project.defaultBaseBranch}
            mono
          />
        </div>
      </section>

      <section className="project-detail__prompts">
        <header className="kind-group__header">
          <h3 className="kind-group__title">
            Runnable on this project
            <span className="kind-group__count">{visibleArtifacts.length}</span>
          </h3>
          <p className="kind-group__hint">
            Prompts, commands, skills, and agents from the vault — pick one
            to preview the run plan, then Run it against this project.
          </p>
        </header>
        <div className="kind-filter">
          <KindChip
            label="All"
            count={runnableArtifacts.length}
            active={kindFilter === "all"}
            onClick={() => setKindFilter("all")}
          />
          {RUNNABLE_KIND_ORDER.filter((k) => kindCounts[k] > 0).map((k) => (
            <KindChip
              key={k}
              label={RUNNABLE_KIND_LABEL[k]}
              count={kindCounts[k]}
              active={kindFilter === k}
              onClick={() => setKindFilter(k)}
            />
          ))}
        </div>
        {visibleArtifacts.length === 0 ? (
          <p className="empty">
            {kindFilter === "all"
              ? "No runnable artifacts detected in this vault. Add one under 00_meta/agent-tasks/prompts/, 00_meta/_claude/commands/, 00_meta/_claude/skills/, or 00_meta/_claude/agents/."
              : `No ${RUNNABLE_KIND_LABEL[kindFilter].toLowerCase()} in this vault.`}
          </p>
        ) : (
          <ul className="list">
            {visibleArtifacts.map((p) => (
              <li
                key={`${p.kind}:${p.id}`}
                className={
                  "list__item list__item--clickable" +
                  (selectedPromptId === p.id ? " list__item--selected" : "")
                }
              >
                <button
                  type="button"
                  className="list__row-btn"
                  onClick={() =>
                    setSelectedPromptId(
                      selectedPromptId === p.id ? null : p.id,
                    )
                  }
                  aria-pressed={selectedPromptId === p.id}
                >
                  <div className="list__primary">
                    <span
                      className={"tag tag--kind tag--kind-" + p.kind}
                      title={RUNNABLE_KIND_LABEL[p.kind]}
                    >
                      {p.kind}
                    </span>
                    {p.order != null && (
                      <span className="tag">order {p.order}</span>
                    )}
                    <span className="list__id">{p.id}</span>
                    {p.title && p.title !== p.id && (
                      <span className="list__title">{p.title}</span>
                    )}
                  </div>
                  <div className="list__secondary">
                    {p.outputFile && (
                      <span className="tag tag--output" title={p.outputFile}>
                        → {p.outputFile}
                      </span>
                    )}
                    <span className="list__path">{p.path}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedPromptId && (
        <section className="project-detail__preview">
          {previewLoading && !preview && (
            <p className="empty">Computing run plan preview…</p>
          )}
          {previewError && <p className="welcome__error">{previewError}</p>}
          {preview && (
            <ContextPreviewPanel
              preview={preview}
              homeDir={homeDir}
              vaultRoot={vaultRoot}
              isRefreshing={previewLoading}
              onCreateAndOpenFile={onCreateAndOpenFile}
              sourceRepoInspection={inspection}
            />
          )}
        </section>
      )}
    </div>
  );
}

interface KindChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function KindChip({ label, count, active, onClick }: KindChipProps) {
  return (
    <button
      type="button"
      className={"kind-chip" + (active ? " kind-chip--active" : "")}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
      <span className="kind-chip__count">{count}</span>
    </button>
  );
}
