import { useEffect, useMemo, useState, type ReactNode } from "react";
import { searchVault, type SearchHit } from "../../api";
import type {
  ArtifactKind,
  Diagnostic,
  Draft,
  Project,
  ScanResult,
  WorkflowArtifact,
} from "../../types";
import { ShellIcon } from "./ShellIcon";
import type { ShellTheme } from "./types";

/** Shared 36px panel header: mono-uppercase title, muted count,
 *  right-aligned 24px icon buttons. */
export function PanelHead({
  title,
  count,
  children,
}: {
  title: string;
  count?: string | number;
  children?: ReactNode;
}) {
  return (
    <div className="ide-panel-head">
      <span>{title}</span>
      {count != null && <span className="count">{count}</span>}
      <span className="grow" />
      {children}
    </div>
  );
}

/** Status dot used across panels. */
export function Dot({ kind }: { kind: "run" | "ok" | "idle" | "err" | "warn" }) {
  return <span className={"ide-dot " + kind} aria-hidden="true" />;
}

const KTAG: Record<ArtifactKind, { cls: string; label: string }> = {
  "claude-skill": { cls: "skill", label: "skill" },
  "vault-skill": { cls: "vskill", label: "v.skill" },
  "claude-agent": { cls: "agent", label: "agent" },
  "claude-command": { cls: "command", label: "cmd" },
  "claude-rule": { cls: "rule", label: "rule" },
  "agent-prompt": { cls: "prompt", label: "prompt" },
};

export function KTag({ kind }: { kind: ArtifactKind }) {
  const m = KTAG[kind];
  return <span className={"ide-ktag " + m.cls}>{m.label}</span>;
}

/* ================= Projects ================= */

interface PanelProjectsProps {
  projects: Project[];
  drafts: Draft[];
  activeProject: string | null;
  /** Saved chat sessions for the vault — meta for the run-history row. */
  sessionCount: number;
  onOpenProject: (slug: string) => void;
  onOpenFile: (path: string) => void;
  onOpenHistory: () => void;
  onAddProject: () => void;
}

export function PanelProjects({
  projects,
  drafts,
  activeProject,
  sessionCount,
  onOpenProject,
  onOpenFile,
  onOpenHistory,
  onAddProject,
}: PanelProjectsProps) {
  const draftCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of drafts) {
      if (d.project) m.set(d.project, (m.get(d.project) ?? 0) + 1);
    }
    return m;
  }, [drafts]);

  const active = projects.find((p) => p.slug === activeProject) ?? null;

  return (
    <div className="ide-panel" aria-label="Projects">
      <PanelHead title="Projects" count={projects.length}>
        <button
          type="button"
          className="hbtn"
          title="New project"
          onClick={onAddProject}
        >
          <ShellIcon name="plus" size={16} />
        </button>
      </PanelHead>
      <div className="ide-panel-body">
        {projects.length === 0 ? (
          <p className="ide-panel-hint">No projects in this vault.</p>
        ) : (
          projects.map((p) => {
            const dc = draftCounts.get(p.slug) ?? 0;
            return (
              <button
                key={p.slug}
                type="button"
                className={"ide-row" + (p.slug === activeProject ? " active" : "")}
                onClick={() => onOpenProject(p.slug)}
              >
                <Dot kind={projectDot(p.status)} />
                <span className="r-txt">{p.slug}</span>
                {dc > 0 && (
                  <span
                    style={{
                      color: "var(--accent)",
                      fontFamily: "var(--mono)",
                      fontSize: 10.5,
                    }}
                  >
                    △{dc}
                  </span>
                )}
              </button>
            );
          })
        )}
        {active && (
          <>
            <div className="ide-secline" style={{ marginTop: 8 }}>
              <span>Active · {active.slug}</span>
            </div>
            <button
              type="button"
              className="ide-row"
              onClick={() => onOpenFile(active.indexFile)}
            >
              <span className="r-txt">overview</span>
              <span className="r-meta">_index.md</span>
            </button>
            <button type="button" className="ide-row" onClick={onOpenHistory}>
              <span className="r-txt">run history</span>
              <span className="r-meta">{sessionCount} runs</span>
            </button>
            <button
              type="button"
              className="ide-row"
              onClick={() => onOpenProject(active.slug)}
            >
              <span className="r-txt">source repo</span>
              <span className="r-meta">
                {active.localPath ? "local" : active.repo ? "remote" : "—"}
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function projectDot(status: string | null): "ok" | "warn" | "idle" {
  if (status === "active") return "ok";
  if (status === "paused") return "warn";
  return "idle";
}

/* ================= Search ================= */

interface PanelSearchProps {
  vaultRoot: string;
  onOpenFile: (path: string) => void;
}

interface SearchState {
  hits: SearchHit[];
  filesMatched: number;
  truncated: boolean;
}

/** Content search over the vault's Markdown files, backed by the
 *  `search_vault` command (case-insensitive substring, capped).
 *  Debounced so a keystroke burst doesn't queue a full-tree read per
 *  character; results are grouped by file. */
export function PanelSearch({ vaultRoot, onOpenFile }: PanelSearchProps) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchState | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setResult(null);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchVault(vaultRoot, q)
        .then((r) => {
          if (cancelled) return;
          setResult({
            hits: r.hits,
            filesMatched: r.filesMatched,
            truncated: r.truncated,
          });
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [vaultRoot, query]);

  // Group hits per file, preserving walk order.
  const groups = useMemo(() => {
    if (!result) return [];
    const byFile = new Map<string, SearchHit[]>();
    for (const h of result.hits) {
      const list = byFile.get(h.path);
      if (list) list.push(h);
      else byFile.set(h.path, [h]);
    }
    return [...byFile.entries()];
  }, [result]);

  return (
    <div className="ide-panel" aria-label="Search">
      <PanelHead title="Search" />
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <div className="ide-input-box">
          <ShellIcon name="search" size={14} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vault…"
            aria-label="Search vault content"
          />
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--muted)",
            marginTop: 6,
          }}
        >
          {query.trim() === ""
            ? "content search · vault scope"
            : searching
              ? "searching…"
              : error
                ? ""
                : result
                  ? `${result.hits.length}${result.truncated ? "+" : ""} results · ${result.filesMatched} files`
                  : ""}
        </div>
      </div>
      <div className="ide-panel-body">
        {error && (
          <p className="ide-panel-hint" style={{ color: "var(--err)" }}>
            {error}
          </p>
        )}
        {!error &&
          groups.map(([path, hits]) => (
            <div
              key={path}
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              <button
                type="button"
                className="ide-rtl-path"
                style={{
                  display: "block",
                  width: "100%",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--fg-2)",
                }}
                onClick={() => onOpenFile(path)}
                title={path}
              >
                {path}
              </button>
              {hits.map((h) => (
                <button
                  key={h.line}
                  type="button"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    fontSize: 11.5,
                    color: "var(--muted)",
                    marginTop: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  onClick={() => onOpenFile(h.path)}
                  title={`line ${h.line}: ${h.snippet}`}
                >
                  <span style={{ color: "var(--muted-2)" }}>{h.line}</span>{" "}
                  {h.snippet}
                </button>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

/* ================= AI Artifacts ================= */

type ArtifactFilter = "all" | ArtifactKind;

const ARTIFACT_CHIPS: { id: ArtifactFilter; label: string }[] = [
  { id: "all", label: "all" },
  { id: "claude-skill", label: "skill" },
  { id: "claude-command", label: "command" },
  { id: "claude-agent", label: "agent" },
  { id: "vault-skill", label: "vault" },
  { id: "agent-prompt", label: "prompt" },
  { id: "claude-rule", label: "rule" },
];

interface PanelSkillsProps {
  artifacts: WorkflowArtifact[];
  onOpenFile: (path: string) => void;
  /** Opens the full artifacts view (details, run staging) in the
   *  center area. */
  onOpenFullList: () => void;
}

export function PanelSkills({
  artifacts,
  onOpenFile,
  onOpenFullList,
}: PanelSkillsProps) {
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const shown =
    filter === "all" ? artifacts : artifacts.filter((a) => a.kind === filter);

  return (
    <div className="ide-panel" aria-label="AI Artifacts">
      <PanelHead title="AI Artifacts" count={artifacts.length}>
        <button
          type="button"
          className="hbtn"
          title="Open artifacts view"
          onClick={onOpenFullList}
        >
          <ShellIcon name="chevr" size={15} />
        </button>
      </PanelHead>
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border-soft)",
          flexWrap: "wrap",
        }}
      >
        {ARTIFACT_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={"ide-chip" + (filter === c.id ? " on" : "")}
            onClick={() => setFilter(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="ide-panel-body">
        {shown.map((a) => (
          <button
            key={a.kind + ":" + a.id}
            type="button"
            className="ide-row"
            style={{ height: 34 }}
            onClick={() => onOpenFile(a.path)}
            title={a.path}
          >
            <KTag kind={a.kind} />
            <span
              className="r-txt"
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--fg)",
              }}
            >
              {a.id}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ================= Drafts ================= */

interface PanelDraftsProps {
  drafts: Draft[];
  onOpenDraft: (path: string) => void;
  /** Opens the full drafts view (promote / discard) in the center. */
  onOpenFullList: () => void;
}

export function PanelDrafts({
  drafts,
  onOpenDraft,
  onOpenFullList,
}: PanelDraftsProps) {
  return (
    <div className="ide-panel" aria-label="Drafts">
      <PanelHead
        title="Drafts"
        count={drafts.length > 0 ? `${drafts.length} new` : "0"}
      >
        <button
          type="button"
          className="hbtn"
          title="Review drafts (promote / discard)"
          onClick={onOpenFullList}
        >
          <ShellIcon name="chevr" size={15} />
        </button>
      </PanelHead>
      <div className="ide-panel-body">
        {drafts.length === 0 ? (
          <p className="ide-panel-hint">
            No drafts. Agents propose reusable notes into{" "}
            <code>01_inbox/_drafts/</code>.
          </p>
        ) : (
          drafts.map((d) => (
            <button
              key={d.path}
              type="button"
              className="ide-row card"
              onClick={() => onOpenDraft(d.path)}
              title={d.path}
            >
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9.5,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                  marginBottom: 3,
                }}
              >
                <span style={{ color: "var(--accent)" }}>△</span>{" "}
                {d.project ?? "vault"}
                {d.created ? ` · ${d.created}` : ""}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--fg)",
                  fontWeight: 500,
                  lineHeight: 1.35,
                  textWrap: "pretty",
                  whiteSpace: "normal",
                }}
              >
                {d.title}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ================= Diagnostics ================= */

interface PanelDiagProps {
  diagnostics: Diagnostic[];
}

export function PanelDiag({ diagnostics }: PanelDiagProps) {
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const warnings = diagnostics.filter((d) => d.level === "warning").length;
  return (
    <div className="ide-panel" aria-label="Diagnostics">
      <PanelHead title="Diagnostics" count={`${errors} err · ${warnings} warn`} />
      <div className="ide-panel-body">
        {diagnostics.length === 0 ? (
          <p className="ide-panel-hint">No diagnostics — vault looks clean.</p>
        ) : (
          diagnostics.map((d, i) => (
            <div
              key={i}
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-soft)",
                borderLeft:
                  "2px solid " +
                  (d.level === "error"
                    ? "var(--err)"
                    : d.level === "warning"
                      ? "var(--warn)"
                      : "var(--muted-2)"),
              }}
            >
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                }}
              >
                {d.level}
              </div>
              {d.path && (
                <div
                  className="ide-rtl-path"
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--fg-2)",
                    margin: "2px 0",
                  }}
                >
                  {d.path}
                </div>
              )}
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--muted)",
                  textWrap: "pretty",
                }}
              >
                {d.message}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ================= Settings ================= */

interface PanelSettingsProps {
  result: ScanResult;
  /** Home-masked vault root for display. */
  vaultLabel: string;
  theme: ShellTheme;
  onSetTheme: (theme: ShellTheme) => void;
  /** Present for legacy vaults (00_meta/ without .vault/config.yml):
   *  opens the create-config dialog. */
  onFixConfig?: () => void;
}

const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ["⌘K", "command palette"],
  ["⌘J", "agent panel"],
  ["⌘B", "toggle left panel"],
  ["⌘1 / ⌘2 / ⌘3", "editor src / split / preview"],
  ["⌘S", "save file"],
  ["⌘↵", "send chat message"],
];

export function PanelSettings({
  result,
  vaultLabel,
  theme,
  onSetTheme,
  onFixConfig,
}: PanelSettingsProps) {
  const formatLabel = !result.hasVaultConfig
    ? "none"
    : (result.vaultFormatVersion ?? "?") +
      (result.vaultFormatSupported ? "" : " (too new)");
  return (
    <div className="ide-panel" aria-label="Settings">
      <PanelHead title="Settings" />
      <div className="ide-panel-body">
        <div className="ide-secline" style={{ marginTop: 6 }}>
          <span>Theme</span>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "4px 14px 8px" }}>
          {(["graphite", "porcelain"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={"ide-chip" + (theme === t ? " on" : "")}
              onClick={() => onSetTheme(t)}
              aria-pressed={theme === t}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="ide-secline" style={{ marginTop: 6 }}>
          <span>Vault</span>
        </div>
        <div className="ide-row" style={{ cursor: "default" }} title={result.vaultRoot}>
          <span className="r-txt ide-rtl-path" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
            {vaultLabel}
          </span>
        </div>
        <div className="ide-row" style={{ cursor: "default" }}>
          <span className="r-txt">format</span>
          <span
            className="r-meta"
            style={
              result.hasVaultConfig && result.vaultFormatSupported
                ? undefined
                : { color: "var(--warn)" }
            }
          >
            {formatLabel}
          </span>
          {onFixConfig && (
            <button type="button" className="ide-btn sm" onClick={onFixConfig}>
              fix
            </button>
          )}
        </div>
        {(
          [
            ["markdown files", result.markdownFiles.length],
            ["artifacts", result.artifacts.length],
            ["projects", result.projects.length],
            ["drafts", result.drafts.length],
          ] as const
        ).map(([label, count]) => (
          <div key={label} className="ide-row" style={{ cursor: "default" }}>
            <span className="r-txt">{label}</span>
            <span className="r-meta">{count}</span>
          </div>
        ))}

        <div className="ide-secline" style={{ marginTop: 6 }}>
          <span>Shortcuts</span>
        </div>
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="ide-row" style={{ cursor: "default" }}>
            <span className="r-txt">{label}</span>
            <span className="ide-kbd">{keys}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= Host ================= */

export interface LeftPanelCallbacks {
  onOpenProject: (slug: string) => void;
  onOpenFile: (path: string) => void;
  onOpenHistory: () => void;
  onAddProject: () => void;
  onOpenArtifactsView: () => void;
  onOpenDraftsView: () => void;
}

interface LeftPanelProps extends LeftPanelCallbacks {
  view: "projects" | "search" | "skills" | "drafts" | "diag";
  result: ScanResult;
  activeProject: string | null;
  sessionCount: number;
}

/** The data-pure panels. `git` and `cve` live in their own files
 *  (they own async state); `agent` is the chat drawer for now. */
export function LeftPanel({
  view,
  result,
  activeProject,
  sessionCount,
  onOpenProject,
  onOpenFile,
  onOpenHistory,
  onAddProject,
  onOpenArtifactsView,
  onOpenDraftsView,
}: LeftPanelProps) {
  switch (view) {
    case "projects":
      return (
        <PanelProjects
          projects={result.projects}
          drafts={result.drafts}
          activeProject={activeProject}
          sessionCount={sessionCount}
          onOpenProject={onOpenProject}
          onOpenFile={onOpenFile}
          onOpenHistory={onOpenHistory}
          onAddProject={onAddProject}
        />
      );
    case "search":
      return (
        <PanelSearch vaultRoot={result.vaultRoot} onOpenFile={onOpenFile} />
      );
    case "skills":
      return (
        <PanelSkills
          artifacts={result.artifacts}
          onOpenFile={onOpenFile}
          onOpenFullList={onOpenArtifactsView}
        />
      );
    case "drafts":
      return (
        <PanelDrafts
          drafts={result.drafts}
          onOpenDraft={onOpenFile}
          onOpenFullList={onOpenDraftsView}
        />
      );
    case "diag":
      return <PanelDiag diagnostics={result.diagnostics} />;
  }
}
