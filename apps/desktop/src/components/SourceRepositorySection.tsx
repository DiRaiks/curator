import type { Project, SourceRepoInspection } from "../types";
import { maskHome } from "../utils/path";

interface SourceRepositorySectionProps {
  project: Project;
  homeDir: string | null;
  /** `null` while the inspection is in flight; `null` is also used when the
   *  project has no `local_path` configured. */
  inspection: SourceRepoInspection | null;
  loading: boolean;
  error: string | null;
}

/**
 * Compact, pre-flight readiness indicator for a project's source repo.
 *
 * Default view is one card with:
 *   - status badge (connected / missing / not git)
 *   - dirty/clean badge when git
 *   - Path, Git (branch + short commit), Repo, Default base
 *   - Detected files inline
 *
 * The shallow top-level listing lives behind a `<details>` disclosure so it
 * doesn't compete with the rest of Project Detail.
 */
export function SourceRepositorySection({
  project,
  homeDir,
  inspection,
  loading,
  error,
}: SourceRepositorySectionProps) {
  if (!project.localPath) {
    return (
      <section
        className="project-detail__source"
        aria-label="Source repository"
      >
        <header className="source-repo__header">
          <h3 className="source-repo__title">Source Repository</h3>
          <span className="tag tag--ref">no local path</span>
        </header>
        <p className="preview__hint">
          No local source repo path configured in this project's{" "}
          <code>_index.md</code> or <code>_local.md</code> overlay.
        </p>
      </section>
    );
  }

  const status = describeStatus(inspection, loading);
  const localPathDisplay = maskHome(project.localPath, homeDir);
  const gitLine = inspection
    ? [inspection.branch, inspection.shortCommit]
        .filter((s): s is string => Boolean(s))
        .join(" · ")
    : "";

  return (
    <section
      className="project-detail__source"
      aria-label="Source repository"
    >
      <header className="source-repo__header">
        <h3 className="source-repo__title">Source Repository</h3>
        <span className={"tag " + status.cls} title={status.title}>
          {status.label}
        </span>
        {inspection?.dirty === true && (
          <span
            className="tag tag--warning"
            title="Working tree has uncommitted changes."
          >
            dirty working tree
          </span>
        )}
        {inspection?.dirty === false && (
          <span className="tag" title="Working tree is clean.">
            clean
          </span>
        )}
      </header>

      {error && <p className="welcome__error">{error}</p>}

      <div className="preview__summary-grid">
        <Row label="Path" value={localPathDisplay} mono />
        {gitLine && <Row label="Git" value={gitLine} mono />}
        {project.repo && <Row label="Repo" value={project.repo} mono />}
        {project.defaultBaseBranch && (
          <Row
            label="Default base"
            value={project.defaultBaseBranch}
            mono
          />
        )}
        {inspection?.exists && inspection.detected.length > 0 && (
          <Row
            label="Detected"
            value={inspection.detected
              .map(shortenDetected)
              .join(" · ")}
          />
        )}
      </div>

      {inspection?.exists && inspection.topLevel.length > 0 && (
        <details className="source-repo__details">
          <summary>Show repository details</summary>
          <div className="source-repo__details-body">
            <p className="preview__hint">
              Top-level entries ({inspection.topLevel.length}). Hidden files
              (.env*), runtime dirs (node_modules, target, dist, build,
              .next, coverage), and secrets are excluded from this listing.
            </p>
            <ul className="source-repo__entries">
              {inspection.topLevel.map((entry) => (
                <li key={entry.name} className="source-repo__entry">
                  <span className="tree__icon" aria-hidden="true">
                    {entry.isDir ? "▸" : "·"}
                  </span>
                  <span
                    className={
                      entry.isDir
                        ? "source-repo__entry-name source-repo__entry-name--dir"
                        : "source-repo__entry-name"
                    }
                  >
                    {entry.name}
                    {entry.isDir ? "/" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </section>
  );
}

interface StatusDescriptor {
  label: string;
  cls: string;
  title: string;
}

function describeStatus(
  inspection: SourceRepoInspection | null,
  loading: boolean,
): StatusDescriptor {
  if (loading && !inspection) {
    return {
      label: "inspecting…",
      cls: "tag",
      title: "Inspecting configured local_path.",
    };
  }
  if (!inspection) {
    return {
      label: "unknown",
      cls: "tag tag--ref",
      title: "Inspection has not produced a result yet.",
    };
  }
  if (!inspection.exists) {
    return {
      label: "missing",
      cls: "tag--warning",
      title: "Configured local_path does not exist on disk.",
    };
  }
  if (!inspection.isGitRepo) {
    return {
      label: "not git",
      cls: "tag--ref",
      title: "Path exists but is not a git repository.",
    };
  }
  return {
    label: "connected",
    cls: "tag--runnable",
    title: "Path is a git repository.",
  };
}

/**
 * Friendlier short label for the very few detected entries that have an
 * obvious common alias. Keep this conservative — anything not known stays
 * verbatim.
 */
function shortenDetected(name: string): string {
  if (name === ".github/workflows") return "workflows";
  return name;
}

interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Row({ label, value, mono }: RowProps) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span
        className={"field__value" + (mono ? " field__value--mono" : "")}
      >
        {value}
      </span>
    </div>
  );
}
