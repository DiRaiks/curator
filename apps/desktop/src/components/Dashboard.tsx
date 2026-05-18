import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMarkdownFile,
  readMarkdownFile,
  writeMarkdownFile,
} from "../api";
import type { Project, Scope, ScanResult } from "../types";
import { maskHome } from "../utils/path";
import { ArtifactList } from "./ArtifactList";
import { ConfirmDirtyDialog } from "./ConfirmDirtyDialog";
import { Diagnostics } from "./Diagnostics";
import { EditorPanel } from "./EditorPanel";
import { FileTree } from "./FileTree";
import { NewFileDialog } from "./NewFileDialog";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { ZoneList } from "./ZoneList";

interface DashboardProps {
  result: ScanResult;
  onClose: () => void;
  /** Re-scan the current vault. Called after creating a new file so the tree refreshes. */
  onRescan: () => Promise<void>;
}

type Tab = "projects" | "artifacts" | "zones" | "diagnostics" | "editor";

interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
  scope?: Scope;
  /** True when the file no longer appears in the latest vault scan — e.g.
   *  it was deleted or moved outside the IDE. Set by the post-rescan
   *  reconciliation effect. */
  missing?: boolean;
}

type PendingAction = (() => Promise<void> | void) | null;

interface PillProps {
  ok: boolean;
  label: string;
  title?: string;
}

function StatusPill({ ok, label, title }: PillProps) {
  return (
    <span
      className={"pill " + (ok ? "pill--ok" : "pill--warn")}
      title={title}
    >
      {label}: {ok ? "present" : "missing"}
    </span>
  );
}

type PrivacyState = "protected" | "at-risk";

interface PrivacyBadgeProps {
  state: PrivacyState;
  reason?: string;
}

const PRIVACY_TOOLTIP =
  "Personal and team-management zones are excluded from project workflows by default. No content from these files is prepared for AI context.";

function PrivacyBadge({ state, reason }: PrivacyBadgeProps) {
  const label =
    state === "protected" ? "privacy: protected" : "privacy: at risk";
  const tip = state === "protected" ? PRIVACY_TOOLTIP : (reason ?? PRIVACY_TOOLTIP);
  return (
    <span
      className={"pill privacy-status privacy-status--" + state}
      title={tip}
      aria-label={tip}
      role="status"
    >
      {label}
    </span>
  );
}

function computePrivacyState(_result: ScanResult): {
  state: PrivacyState;
  reason?: string;
} {
  return { state: "protected" };
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  id: string;
  controls: string;
}

function TabButton({
  active,
  onClick,
  label,
  count,
  id,
  controls,
}: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      className={"tab " + (active ? "tab--active" : "")}
      onClick={onClick}
    >
      {label}
      {typeof count === "number" && (
        <span className="tab__count">{count}</span>
      )}
    </button>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Dashboard({ result, onClose, onRescan }: DashboardProps) {
  const [tab, setTab] = useState<Tab>("projects");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileSuggestion, setNewFileSuggestion] = useState<string>(
    "01_inbox/new-note.md",
  );

  const [refreshing, setRefreshing] = useState(false);
  /** Bumped after every successful rescan so child panels (Project Detail's
   *  Source Repository section, etc.) can re-fetch their derived data. */
  const [refreshTick, setRefreshTick] = useState(0);

  const filePaths = useMemo(
    () => result.markdownFiles.map((f) => f.path),
    [result.markdownFiles],
  );
  const displayedVaultRoot = useMemo(
    () => maskHome(result.vaultRoot, result.homeDir),
    [result.vaultRoot, result.homeDir],
  );

  const privacy = computePrivacyState(result);
  const isDirty =
    openFile != null && openFile.content !== openFile.savedContent;
  const effectiveTab: Tab =
    tab === "editor" && !openFile ? "projects" : tab;

  /**
   * Reconcile the open editor file with the latest scan after each refresh.
   * If the file vanished from the vault, mark it as `missing` so the editor
   * can show a banner instead of silently failing on Save. If it reappears
   * (e.g. the user re-created it externally and refreshed), drop the flag.
   *
   * Future: a live filesystem watcher with debounce could replace the manual
   * Refresh button entirely. Out of scope for this slice.
   */
  useEffect(() => {
    if (!openFile) return;
    const stillIndexed = result.markdownFiles.some(
      (f) => f.path === openFile.path,
    );
    if (!stillIndexed && !openFile.missing) {
      setOpenFile({ ...openFile, missing: true });
    } else if (stillIndexed && openFile.missing) {
      setOpenFile({ ...openFile, missing: false });
    }
  }, [result.markdownFiles, openFile]);

  const onSelectTab = (next: Tab) => {
    setTab(next);
    if (next !== "projects") setSelectedProject(null);
  };

  const [openError, setOpenError] = useState<string | null>(null);

  const doOpenFile = useCallback(
    async (path: string) => {
      setEditorError(null);
      setOpenError(null);
      try {
        const content = await readMarkdownFile(result.vaultRoot, path);
        const scope = result.markdownFiles.find((f) => f.path === path)?.scope;
        setOpenFile({ path, content, savedContent: content, scope });
        setTab("editor");
      } catch (err: unknown) {
        // Surface inline; `window.alert` is silently disabled in the Tauri
        // webview, so a banner under the file tree is what the user actually
        // sees.
        setOpenError(`Open failed for ${path}: ${errorMessage(err)}`);
      }
    },
    [result.vaultRoot, result.markdownFiles],
  );

  const attemptOpenFile = useCallback(
    (path: string) => {
      if (isDirty) {
        setPendingAction(() => () => doOpenFile(path));
      } else {
        void doOpenFile(path);
      }
    },
    [isDirty, doOpenFile],
  );

  const closeEditor = useCallback(() => {
    setOpenFile(null);
    setEditorError(null);
    setTab("projects");
  }, []);

  const attemptCloseEditor = useCallback(() => {
    if (isDirty) {
      setPendingAction(() => closeEditor);
    } else {
      closeEditor();
    }
  }, [isDirty, closeEditor]);

  const saveOpenFile = useCallback(async (): Promise<boolean> => {
    if (!openFile) return false;
    setEditorSaving(true);
    setEditorError(null);
    try {
      await writeMarkdownFile(result.vaultRoot, openFile.path, openFile.content);
      setOpenFile({ ...openFile, savedContent: openFile.content });
      return true;
    } catch (err: unknown) {
      setEditorError(errorMessage(err));
      return false;
    } finally {
      setEditorSaving(false);
    }
  }, [openFile, result.vaultRoot]);

  const discardOpenFile = useCallback(() => {
    if (!openFile) return;
    setOpenFile({ ...openFile, content: openFile.savedContent });
  }, [openFile]);

  /** Wrap the app-level rescan so dependent panels can subscribe to changes
   *  via a single counter dep. */
  const rescanWithTick = useCallback(async () => {
    await onRescan();
    setRefreshTick((t) => t + 1);
  }, [onRescan]);

  /** Shared create-and-open used by both the "+ New" button and the Run Plan
   *  "Create output stub" affordance. Throws on failure so callers can surface
   *  errors inline. Refreshes the file tree on success. */
  const createAndOpenFile = useCallback(
    async (path: string): Promise<void> => {
      const content = await createMarkdownFile(result.vaultRoot, path);
      setOpenFile({ path, content, savedContent: content });
      setEditorError(null);
      setTab("editor");
      await rescanWithTick();
    },
    [result.vaultRoot, rescanWithTick],
  );

  const openNewFileDialog = useCallback(() => {
    const suggested = selectedProject
      ? `02_projects/${selectedProject.slug}/new-note.md`
      : "01_inbox/new-note.md";
    setNewFileSuggestion(suggested);
    setShowNewFile(true);
  }, [selectedProject]);

  const attemptNewFile = useCallback(() => {
    if (isDirty) {
      setPendingAction(() => openNewFileDialog);
    } else {
      openNewFileDialog();
    }
  }, [isDirty, openNewFileDialog]);

  /** Re-scan the vault from disk. Does NOT touch editor content — the open
   *  file's in-memory buffer is preserved. If the file is gone from disk
   *  after the rescan, the reconciliation effect above marks it `missing`.
   *  Also bumps `refreshTick` so Project Detail's Source Repository panel
   *  re-inspects the configured `local_path`. */
  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await rescanWithTick();
    } finally {
      setRefreshing(false);
    }
  }, [rescanWithTick]);

  const attemptRefresh = useCallback(() => {
    if (isDirty) {
      // Reuses the existing dirty-confirm flow: Save / Discard both end with
      // a clean editor buffer; Cancel skips the refresh entirely. Refresh
      // itself does not overwrite the editor content.
      setPendingAction(() => doRefresh);
    } else {
      void doRefresh();
    }
  }, [isDirty, doRefresh]);

  // Confirm-dirty handlers
  const onConfirmSave = useCallback(async () => {
    const ok = await saveOpenFile();
    if (!ok) return; // keep dialog open so user can see the error
    const action = pendingAction;
    setPendingAction(null);
    if (action) await action();
  }, [saveOpenFile, pendingAction]);

  const onConfirmDiscard = useCallback(async () => {
    discardOpenFile();
    const action = pendingAction;
    setPendingAction(null);
    if (action) await action();
  }, [discardOpenFile, pendingAction]);

  const onConfirmCancel = useCallback(() => {
    setPendingAction(null);
  }, []);

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <div className="dashboard__title">
          <span className="dashboard__label">Vault</span>
          <span className="dashboard__path" title={displayedVaultRoot}>
            {displayedVaultRoot}
          </span>
        </div>
        <div className="dashboard__meta">
          <PrivacyBadge state={privacy.state} reason={privacy.reason} />
          <StatusPill ok={result.hasMeta} label="meta" title="00_meta/" />
          <StatusPill ok={result.hasGit} label="git" title=".git/" />
          <span className="pill">{result.markdownFiles.length} md files</span>
          <span className="pill">{result.artifacts.length} artifacts</span>
          <span className="pill">{result.projects.length} projects</span>
          {result.zones.length > 0 && (
            <span
              className="pill"
              title="Private / team-management zones detected — see the Zones tab for the breakdown."
            >
              {result.zones.length} zones
            </span>
          )}
          <button
            type="button"
            className="btn btn--small"
            onClick={attemptRefresh}
            disabled={refreshing}
            title="Re-scan the vault from disk. Editor content is preserved."
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="btn btn--small" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <div className="dashboard__body">
        <aside className="dashboard__tree">
          <div className="dashboard__tree-header">
            <h2 className="panel__title">Files</h2>
            <button
              type="button"
              className="btn btn--small"
              onClick={attemptNewFile}
              title="Create a new Markdown file inside the vault"
            >
              + New
            </button>
          </div>
          {openError && (
            <p className="welcome__error" role="alert">
              {openError}
            </p>
          )}
          <FileTree
            files={filePaths}
            onSelectFile={attemptOpenFile}
            activePath={openFile?.path ?? null}
          />
        </aside>

        <main
          className={
            "dashboard__main" +
            (effectiveTab === "editor" ? " dashboard__main--editor" : "")
          }
        >
          <nav className="tabs" role="tablist" aria-label="Vault sections">
            <TabButton
              id="tab-projects"
              controls="panel-projects"
              active={effectiveTab === "projects"}
              onClick={() => onSelectTab("projects")}
              label="Projects"
              count={result.projects.length}
            />
            <TabButton
              id="tab-artifacts"
              controls="panel-artifacts"
              active={effectiveTab === "artifacts"}
              onClick={() => onSelectTab("artifacts")}
              label="AI Artifacts"
              count={result.artifacts.length}
            />
            <TabButton
              id="tab-zones"
              controls="panel-zones"
              active={effectiveTab === "zones"}
              onClick={() => onSelectTab("zones")}
              label="Zones"
              count={result.zones.length}
            />
            <TabButton
              id="tab-diagnostics"
              controls="panel-diagnostics"
              active={effectiveTab === "diagnostics"}
              onClick={() => onSelectTab("diagnostics")}
              label="Diagnostics"
              count={result.diagnostics.length}
            />
            {openFile && (
              <TabButton
                id="tab-editor"
                controls="panel-editor"
                active={effectiveTab === "editor"}
                onClick={() => setTab("editor")}
                label="Editor"
              />
            )}
          </nav>

          {effectiveTab === "projects" && (
            <section
              id="panel-projects"
              role="tabpanel"
              aria-labelledby="tab-projects"
              className="panel"
            >
              {selectedProject ? (
                <ProjectDetail
                  project={selectedProject}
                  artifacts={result.artifacts}
                  homeDir={result.homeDir}
                  vaultRoot={result.vaultRoot}
                  refreshTick={refreshTick}
                  onBack={() => setSelectedProject(null)}
                  onCreateAndOpenFile={createAndOpenFile}
                />
              ) : (
                <ProjectList
                  projects={result.projects}
                  homeDir={result.homeDir}
                  onSelect={setSelectedProject}
                />
              )}
            </section>
          )}
          {effectiveTab === "artifacts" && (
            <section
              id="panel-artifacts"
              role="tabpanel"
              aria-labelledby="tab-artifacts"
              className="panel"
            >
              <ArtifactList artifacts={result.artifacts} />
            </section>
          )}
          {effectiveTab === "zones" && (
            <section
              id="panel-zones"
              role="tabpanel"
              aria-labelledby="tab-zones"
              className="panel"
            >
              <ZoneList zones={result.zones} />
            </section>
          )}
          {effectiveTab === "diagnostics" && (
            <section
              id="panel-diagnostics"
              role="tabpanel"
              aria-labelledby="tab-diagnostics"
              className="panel"
            >
              <Diagnostics diagnostics={result.diagnostics} />
            </section>
          )}
          {effectiveTab === "editor" && openFile && (
            <section
              id="panel-editor"
              role="tabpanel"
              aria-labelledby="tab-editor"
              className="panel panel--editor"
            >
              <EditorPanel
                path={openFile.path}
                scope={openFile.scope}
                content={openFile.content}
                savedContent={openFile.savedContent}
                saving={editorSaving}
                error={editorError}
                missing={openFile.missing}
                onChange={(next) =>
                  setOpenFile({ ...openFile, content: next })
                }
                onSave={() => {
                  void saveOpenFile();
                }}
                onDiscard={discardOpenFile}
                onClose={attemptCloseEditor}
              />
            </section>
          )}
        </main>
      </div>

      {pendingAction && openFile && isDirty && (
        <ConfirmDirtyDialog
          path={openFile.path}
          saving={editorSaving}
          onSave={() => {
            void onConfirmSave();
          }}
          onDiscard={() => {
            void onConfirmDiscard();
          }}
          onCancel={onConfirmCancel}
        />
      )}

      {showNewFile && (
        <NewFileDialog
          initialPath={newFileSuggestion}
          onCreate={async (path) => {
            await createAndOpenFile(path);
            setShowNewFile(false);
          }}
          onCancel={() => setShowNewFile(false)}
        />
      )}
    </div>
  );
}
