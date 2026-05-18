import type { Project } from "../types";
import { maskHome } from "../utils/path";

interface ProjectListProps {
  projects: Project[];
  homeDir: string | null;
  onSelect: (project: Project) => void;
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

export function ProjectList({ projects, homeDir, onSelect }: ProjectListProps) {
  if (projects.length === 0) {
    return <p className="empty">No projects detected under 02_projects/.</p>;
  }
  return (
    <ul className="list">
      {projects.map((p) => {
        const localPathDisplay = p.localPath
          ? maskHome(p.localPath, homeDir)
          : null;
        return (
          <li key={p.slug} className="list__item list__item--clickable">
            <button
              type="button"
              className="list__row-btn"
              onClick={() => onSelect(p)}
              aria-label={`Open project ${p.slug}`}
            >
              <div className="list__primary">
                <span className="list__title">{p.slug}</span>
                {p.status && <span className="tag">{p.status}</span>}
                {p.myRole && <span className="tag">{p.myRole}</span>}
                <span className="list__chevron" aria-hidden="true">
                  ›
                </span>
              </div>
              <div className="list__secondary">
                <span className="list__path">{p.indexFile}</span>
              </div>
              {(p.repo || localPathDisplay || p.defaultBaseBranch) && (
                <div className="fields">
                  <Field label="repo" value={p.repo} mono />
                  <Field label="local_path" value={localPathDisplay} mono />
                  <Field
                    label="default_base_branch"
                    value={p.defaultBaseBranch}
                    mono
                  />
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
