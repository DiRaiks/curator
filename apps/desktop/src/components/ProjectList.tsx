import type { Project } from "../types";
import { maskHome } from "../utils/path";

interface ProjectListProps {
  projects: Project[];
  homeDir: string | null;
  onSelect: (project: Project) => void;
}

/**
 * Dense project picker — one ~52px row per project under
 * `02_projects/`. Each row is a button so keyboard nav + screen
 * readers see the activation target directly rather than guessing
 * from a `cursor: pointer` div.
 *
 * Layout per row (3-col grid):
 *   [● dot] [slug + role badge / repo · branch X · path · status] [›]
 *
 * The dot colour signals project status at a glance (active / paused /
 * archived / unknown). The meta line is a single ellipsised mono row —
 * scanning many projects vertically is the primary use case, so
 * wrapping would defeat the "list, not cards" goal.
 */
export function ProjectList({ projects, homeDir, onSelect }: ProjectListProps) {
  if (projects.length === 0) {
    return <p className="empty">No projects detected under 02_projects/.</p>;
  }
  return (
    <ul className="project-list">
      {projects.map((p) => {
        const localPathDisplay = p.localPath
          ? maskHome(p.localPath, homeDir)
          : null;
        const meta = buildMetaLine({
          repo: p.repo,
          branch: p.defaultBaseBranch,
          localPath: localPathDisplay,
          status: p.status,
        });
        return (
          <li key={p.slug} className="project-list__item">
            <button
              type="button"
              className="project-list__row"
              onClick={() => onSelect(p)}
              aria-label={`Open project ${p.slug}`}
            >
              <span
                className={
                  "project-list__dot project-list__dot--" +
                  statusKind(p.status)
                }
                aria-hidden="true"
              />
              <div className="project-list__content">
                <div className="project-list__title-row">
                  <span className="project-list__slug">{p.slug}</span>
                  {p.myRole && (
                    <span className="project-list__role">{p.myRole}</span>
                  )}
                </div>
                <div className="project-list__meta">{meta}</div>
              </div>
              <span className="project-list__chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Build the "repo · branch X · local_path · status" line, dropping
 * pieces that aren't set so a project with only a slug doesn't render
 * a wall of stray dots. Branch gets a `branch ` prefix because a bare
 * `main` next to a repo URL would read as part of the URL.
 *
 * Returns an em-dash placeholder when every field is empty — the row
 * keeps a consistent two-line height that way, which makes the list
 * easier to scan than mixed 1/2-line rows.
 */
function buildMetaLine(args: {
  repo: string | null;
  branch: string | null;
  localPath: string | null;
  status: string | null;
}): string {
  const parts: string[] = [];
  if (args.repo) parts.push(args.repo);
  if (args.branch) parts.push(`branch ${args.branch}`);
  if (args.localPath) parts.push(args.localPath);
  if (args.status) parts.push(args.status);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Bucket the freeform `status` string into a CSS-friendly class
 *  suffix. Anything we don't recognise (or absent) falls into a neutral
 *  "unknown" tone so a typo in frontmatter doesn't make the dot
 *  invisible. */
function statusKind(status: string | null): "active" | "paused" | "archived" | "unknown" {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "archived":
      return "archived";
    default:
      return "unknown";
  }
}
