import type { Diagnostic, Draft, Project } from "../types";
import { FileTree } from "./FileTree";

/**
 * Identifier for the currently-rendered main view. 1:1 with the old
 * `Tab` union — keeps the slice-7 → slice-8 rename mechanical (each
 * old tab id maps to the same string). Defined here so the sidebar
 * doesn't reach into Dashboard's internals.
 */
export type ViewId =
  | "projects"
  | "artifacts"
  | "drafts"
  | "security"
  | "source-control"
  | "history"
  | "zones"
  | "diagnostics"
  | "editor";

interface SidebarProps {
  projects: Project[];
  drafts: Draft[];
  artifactCount: number;
  zoneCount: number;
  diagnostics: Diagnostic[];
  /** Saved chat sessions for this vault — drives the "history" row
   *  count. Pass 0 if not loaded yet; the row stays clickable. */
  sessionCount: number;
  /** Number of changed files in the vault git repo — drives the
   *  "source control" row badge. `null` when the vault isn't a git repo
   *  (the row then shows a muted "—"); 0 means a clean tree. */
  changedCount: number | null;
  /** Vault-relative paths for the file tree. */
  files: string[];
  activeView: ViewId;
  /** Slug of the project the user last drilled into. Highlights the
   *  matching PROJECTS row when `activeView === "editor"` or
   *  `"projects"`. */
  activeProject: string | null;
  /** Path of the currently-open file in the editor (for FILES tree
   *  highlight). */
  activeFilePath: string | null;
  /** Loading/error state from the file-open path — surfaced under
   *  FILES so it lives next to the affordance that triggered it. */
  openError?: string | null;
  onSwitchView: (view: ViewId) => void;
  onOpenProject: (slug: string) => void;
  onOpenFile: (path: string) => void;
  onOpenDraft: (path: string) => void;
  /** Top-of-tree affordance for creating a new markdown file. */
  onNewFile: () => void;
}

/**
 * Grouped sidebar for the v0.5 app shell. Four sections:
 *
 *   PROJECTS — every project in the vault. Click a row → open it
 *              (current implementation drills into `ProjectDetail`).
 *   DRAFTS   — agent-produced drafts under `01_inbox/_drafts/`. Click
 *              any row → switch to the Drafts main view.
 *   BROWSE   — navigation rows replacing the old `<nav class="tabs">`
 *              strip: artifacts / security / history / zones /
 *              diagnostics.
 *   FILES    — the existing `<FileTree>` in a flex-1 scroll container.
 *
 * Section headers are mono-uppercase rails (per V5Sidebar in
 * `design/v05-shell.jsx`). Rows have a 2px accent left-border when
 * active so the eye can find "where am I" without reading text.
 */
export function Sidebar({
  projects,
  drafts,
  artifactCount,
  zoneCount,
  diagnostics,
  sessionCount,
  changedCount,
  files,
  activeView,
  activeProject,
  activeFilePath,
  openError,
  onSwitchView,
  onOpenProject,
  onOpenFile,
  onOpenDraft,
  onNewFile,
}: SidebarProps) {
  const diagWarnings = diagnostics.filter((d) => d.level === "warning").length;
  const diagErrors = diagnostics.filter((d) => d.level === "error").length;
  const diagBad = diagWarnings + diagErrors > 0;

  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <SectionHeader label="Projects" right={String(projects.length)} />
      <div className="sidebar__group">
        {projects.length === 0 ? (
          <p className="sidebar__empty">No projects.</p>
        ) : (
          projects.map((p) => (
            <SidebarRow
              key={p.slug}
              kind="project"
              active={
                p.slug === activeProject &&
                (activeView === "editor" || activeView === "projects")
              }
              onClick={() => onOpenProject(p.slug)}
            >
              <span
                className={
                  "sidebar__dot sidebar__dot--" + projectStatusKind(p.status)
                }
                aria-hidden="true"
              />
              <span className="sidebar__row-label">{p.slug}</span>
            </SidebarRow>
          ))
        )}
      </div>

      <SectionHeader
        label="Drafts"
        right={drafts.length > 0 ? `${drafts.length} new` : undefined}
        rightTone={drafts.length > 0 ? "accent" : undefined}
      />
      <div className="sidebar__group">
        {drafts.length === 0 ? (
          <p className="sidebar__empty">No drafts.</p>
        ) : (
          drafts.map((d) => (
            <SidebarRow
              key={d.path}
              kind="draft"
              active={activeView === "drafts"}
              onClick={() => onOpenDraft(d.path)}
            >
              <span className="sidebar__draft-glyph" aria-hidden="true">
                △
              </span>
              <span className="sidebar__row-label">
                {truncate(d.title || d.path.split("/").pop() || d.path, 28)}
              </span>
            </SidebarRow>
          ))
        )}
      </div>

      <SectionHeader label="Browse" />
      <div className="sidebar__group">
        <BrowseRow
          view="artifacts"
          activeView={activeView}
          label="artifacts"
          onClick={() => onSwitchView("artifacts")}
          right={String(artifactCount)}
        />
        <BrowseRow
          view="security"
          activeView={activeView}
          label="security"
          onClick={() => onSwitchView("security")}
          rightTone={projects.length > 0 ? "muted" : "muted"}
          right="scan"
        />
        <BrowseRow
          view="source-control"
          activeView={activeView}
          label="source control"
          onClick={() => onSwitchView("source-control")}
          right={changedCount === null ? "—" : String(changedCount)}
          rightTone={changedCount && changedCount > 0 ? "warn" : "muted"}
        />
        <BrowseRow
          view="history"
          activeView={activeView}
          label="run history"
          onClick={() => onSwitchView("history")}
          right={String(sessionCount)}
        />
        <BrowseRow
          view="zones"
          activeView={activeView}
          label="zones"
          onClick={() => onSwitchView("zones")}
          right={String(zoneCount)}
        />
        <BrowseRow
          view="diagnostics"
          activeView={activeView}
          label="diagnostics"
          onClick={() => onSwitchView("diagnostics")}
          right={
            diagBad
              ? `${diagWarnings}w ${diagErrors}e`
              : String(diagnostics.length)
          }
          rightTone={diagBad ? "warn" : "muted"}
        />
      </div>

      <SectionHeader
        label="Files"
        action={
          <button
            type="button"
            className="sidebar__section-action"
            onClick={onNewFile}
            title="Create a new Markdown file in the vault"
            aria-label="New file"
          >
            +
          </button>
        }
      />
      {openError && (
        <p className="sidebar__error" role="alert">
          {openError}
        </p>
      )}
      <div className="sidebar__files">
        <FileTree
          files={files}
          onSelectFile={onOpenFile}
          activePath={activeFilePath}
        />
      </div>
    </aside>
  );
}

interface SectionHeaderProps {
  label: string;
  right?: string;
  rightTone?: "accent" | "muted" | "warn";
  action?: React.ReactNode;
}

function SectionHeader({
  label,
  right,
  rightTone = "muted",
  action,
}: SectionHeaderProps) {
  return (
    <div className="sidebar__section-head">
      <span className="sidebar__section-label">{label}</span>
      <span className="sidebar__section-spacer" />
      {right && (
        <span className={"sidebar__section-right sidebar__section-right--" + rightTone}>
          {right}
        </span>
      )}
      {action}
    </div>
  );
}

interface SidebarRowProps {
  kind: "project" | "draft" | "browse";
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function SidebarRow({ kind, active, onClick, children }: SidebarRowProps) {
  return (
    <button
      type="button"
      className={
        "sidebar__row sidebar__row--" +
        kind +
        (active ? " sidebar__row--active" : "")
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface BrowseRowProps {
  view: ViewId;
  activeView: ViewId;
  label: string;
  onClick: () => void;
  right?: string;
  rightTone?: "muted" | "warn" | "accent";
}

function BrowseRow({
  view,
  activeView,
  label,
  onClick,
  right,
  rightTone = "muted",
}: BrowseRowProps) {
  return (
    <SidebarRow
      kind="browse"
      active={activeView === view}
      onClick={onClick}
    >
      <span className="sidebar__bullet" aria-hidden="true" />
      <span className="sidebar__row-label">{label}</span>
      {right && (
        <span className={"sidebar__row-right sidebar__row-right--" + rightTone}>
          {right}
        </span>
      )}
    </SidebarRow>
  );
}

function projectStatusKind(status: string | null): "active" | "paused" | "archived" | "unknown" {
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
