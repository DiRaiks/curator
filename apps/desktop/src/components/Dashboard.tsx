import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMarkdownFile,
  initVault,
  onRunEvents,
  readMarkdownFile,
  writeMarkdownFile,
  type RunPermissionRequestEvent,
} from "../api";
import type { Project, Scope, ScanResult } from "../types";
import { maskHome } from "../utils/path";
import { ApproveToolsModal } from "./ApproveToolsModal";
import { ArtifactList } from "./ArtifactList";
import { ConfirmDirtyDialog } from "./ConfirmDirtyDialog";
import { Diagnostics } from "./Diagnostics";
import { EditorPanel } from "./EditorPanel";
import { EmptyVaultFresh } from "./EmptyVaultFresh";
import { EmptyVaultNoProjects } from "./EmptyVaultNoProjects";
import { HistoryPanel } from "./HistoryPanel";
import { NewFileDialog } from "./NewFileDialog";
import { Sidebar, type ViewId } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { useRecommendations } from "../hooks/useRecommendations";
import { DraftsList } from "./DraftsList";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { RecommendationsBell } from "./RecommendationsBell";
import { RunPanel, type RunPanelHandle } from "./RunPanel";
import { SecurityPanel } from "./SecurityPanel";
import { Tooltip } from "./Tooltip";
import { ZoneList } from "./ZoneList";

interface DashboardProps {
  result: ScanResult;
  onClose: () => void;
  /** Re-scan the current vault. Called after creating a new file so the tree refreshes. */
  onRescan: () => Promise<void>;
}

// ViewId — defined in Sidebar.tsx so the sidebar doesn't reach back
// into Dashboard. 1:1 mapping from the legacy `Tab` union (slice 7) to
// the new `ViewId` (slice 8 PR A): every old tab string maps to the
// same string view id.

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
    <Tooltip content={tip} placement="bottom" align="start" ariaLabel={tip}>
      <span
        className={"pill privacy-status privacy-status--" + state}
        role="status"
      >
        {label}
      </span>
    </Tooltip>
  );
}

function computePrivacyState(_result: ScanResult): {
  state: PrivacyState;
  reason?: string;
} {
  return { state: "protected" };
}

interface VaultFormatPillProps {
  hasVaultConfig: boolean;
  vaultFormatVersion: string | null;
  vaultFormatSupported: boolean;
  /** When set, the pill renders as a button that calls this handler.
   *  Used only in legacy-vault state (existing structure but no
   *  config.yml yet) — gives the user a one-click way to fix the
   *  "format: none" warning without leaving the Dashboard. */
  onClickFix?: () => void;
}

function VaultFormatPill({
  hasVaultConfig,
  vaultFormatVersion,
  vaultFormatSupported,
  onClickFix,
}: VaultFormatPillProps) {
  let label: string;
  let ok: boolean;
  let tooltip: string;

  if (!hasVaultConfig) {
    label = "format: none";
    ok = false;
    tooltip =
      "Vault has no .vault/config.yml. Add the file with `version: \"1\"` to lock the format contract.";
  } else if (!vaultFormatVersion) {
    label = "format: ?";
    ok = false;
    tooltip =
      ".vault/config.yml has no parseable `version:` field. Add `version: \"1\"`.";
  } else if (!vaultFormatSupported) {
    label = `format: ${vaultFormatVersion} (too new)`;
    ok = false;
    tooltip = `Vault declares format ${vaultFormatVersion}, which is newer than this IDE supports. Some fields may not be read correctly.`;
  } else {
    label = `format: ${vaultFormatVersion}`;
    ok = true;
    tooltip = `Vault format ${vaultFormatVersion} declared in .vault/config.yml.`;
  }

  // The fix-link only renders when:
  //  - The pill is in a warn state (`ok === false`), AND
  //  - The host wired `onClickFix` (Dashboard only does that for the
  //    legacy-vault case `!hasVaultConfig && hasMeta` — for "config
  //    exists but version unparseable" or "version too new" there's no
  //    safe automatic fix; the user has to edit the existing file).
  const showFix = !ok && !!onClickFix;

  return (
    <span className={"pill " + (ok ? "pill--ok" : "pill--warn")} title={tooltip}>
      {label}
      {showFix && (
        <button
          type="button"
          className="pill__fix-link"
          onClick={onClickFix}
          aria-label="Create .vault/config.yml"
          title='Create .vault/config.yml with version: "1"'
        >
          fix
        </button>
      )}
    </span>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Dashboard({ result, onClose, onRescan }: DashboardProps) {
  // Bypass for the empty-vault onboarding gate. The "Proceed without"
  // affordance on EmptyVaultFresh and "Chat with the vault first" on
  // EmptyVaultNoProjects both flip this so the user can interact with
  // the regular Dashboard despite the scan not satisfying the normal
  // preconditions. We don't persist it — a fresh app launch goes back
  // through the gate.
  const [proceedWithoutVault, setProceedWithoutVault] = useState(false);

  const [view, setView] = useState<ViewId>("projects");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileSuggestion, setNewFileSuggestion] = useState<string>(
    "01_inbox/new-note.md",
  );

  // Confirm dialog for the "create .vault/config.yml" action exposed by
  // the format pill in legacy-vault state. `null` = closed; the string
  // is the most recent error from `initVault` so the dialog can stay
  // open and show it inline instead of closing on failure.
  const [createConfigDialog, setCreateConfigDialog] = useState<{
    busy: boolean;
    error: string | null;
  } | null>(null);

  const onConfirmCreateConfig = useCallback(async () => {
    setCreateConfigDialog({ busy: true, error: null });
    try {
      // initVault is idempotent for existing structure: writes the
      // missing .vault/config.yml + creates zone dirs that don't exist
      // yet, but skips an existing 00_meta/AGENTS.md. Re-scan picks up
      // the new config and the format-pill flips green automatically.
      await initVault(result.vaultRoot);
      await onRescan();
      setCreateConfigDialog(null);
    } catch (err) {
      setCreateConfigDialog({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [result.vaultRoot, onRescan]);

  // Legacy vault: has 00_meta/ but no .vault/config.yml yet. The pill
  // becomes a button that opens the confirm dialog. For genuinely
  // initialised vaults (config exists, just unparseable version) we
  // don't expose this — those need manual editing of the existing file
  // rather than a one-click recreate.
  const isLegacyVault = !result.hasVaultConfig && result.hasMeta;

  const runPanelRef = useRef<RunPanelHandle | null>(null);

  // Active permission request — set when claude pauses awaiting a
  // can_use_tool decision. The modal hides as soon as approve/deny
  // resolves and we clear this back to null. Subsequent requests just
  // overwrite (claude only emits one pending request at a time per
  // session, so we never queue).
  const [pendingPermission, setPendingPermission] =
    useState<RunPermissionRequestEvent | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onRunEvents({
      onPermissionRequest: (ev) => setPendingPermission(ev),
      // Defensive: if the run exits before the user resolves the modal
      // (Stop, crash), clear the prompt so it doesn't hang around for
      // the next session.
      onExit: () => setPendingPermission(null),
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlisten = un;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  /** Bumped after every successful rescan so child panels (Project Detail's
   *  Source Repository section, etc.) can re-fetch their derived data. */
  const [refreshTick, setRefreshTick] = useState(0);

  // Recommendations: re-computed on every refreshTick so vault rescans
  // (manual Refresh, file-watcher fires, draft promotions, agent runs)
  // surface fresh hints.
  const recs = useRecommendations(result.vaultRoot, refreshTick);

  // Navigate to a project's detail view from the bell. Looks up the
  // project by slug in the current scan.
  const goToProject = useCallback(
    (slug: string) => {
      const project = result.projects.find((p) => p.slug === slug);
      if (project) {
        setView("projects");
        setSelectedProject(project);
      }
    },
    [result.projects],
  );

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
  // Fall back to the projects view when the user explicitly chose the
  // editor but no file is open — otherwise the main pane renders
  // nothing. Renamed from `effectiveTab` in slice 8 PR A; behavior
  // unchanged.
  const effectiveView: ViewId =
    view === "editor" && !openFile ? "projects" : view;

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

  const onSwitchView = (next: ViewId) => {
    setView(next);
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
        setView("editor");
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

  /**
   * Resolve a wikilink target (the text between `[[…]]`, alias stripped)
   * to a vault file path and open it.
   *
   * Resolution order:
   *   1. If the target contains `/`, treat it as a vault-relative path.
   *      Try the path as-is, then with a `.md` suffix appended.
   *   2. Otherwise (or if the path miss), fall back to case-insensitive
   *      filename-stem match — Obsidian's default behaviour for bare
   *      links like `[[Some Note]]`.
   *
   * Missing targets surface in the file-tree error banner so the click
   * isn't silently swallowed.
   */
  const onOpenWikilink = useCallback(
    (target: string) => {
      const trimmed = target.trim();
      if (trimmed === "") return;
      const hasSlash = trimmed.includes("/");

      if (hasSlash) {
        const candidates = trimmed.toLowerCase().endsWith(".md")
          ? [trimmed]
          : [trimmed, `${trimmed}.md`];
        for (const cand of candidates) {
          const pathHit = result.markdownFiles.find(
            (f) => f.path.toLowerCase() === cand.toLowerCase(),
          );
          if (pathHit) {
            attemptOpenFile(pathHit.path);
            return;
          }
        }
      }

      // Stem fallback. Take the last segment of the target and strip
      // `.md` so both `[[foo]]` and `[[a/b/foo]]` resolve when only a
      // basename match exists.
      const stemKey =
        (trimmed.split("/").pop() ?? trimmed)
          .replace(/\.md$/i, "")
          .toLowerCase();
      const stemHit = result.markdownFiles.find((f) => {
        const stem = (f.path.split("/").pop() ?? "")
          .replace(/\.md$/i, "")
          .toLowerCase();
        return stem === stemKey;
      });
      if (stemHit) {
        attemptOpenFile(stemHit.path);
        return;
      }

      setOpenError(`Wikilink not found in vault: [[${target}]]`);
    },
    [result.markdownFiles, attemptOpenFile],
  );

  const closeEditor = useCallback(() => {
    setOpenFile(null);
    setEditorError(null);
    setView("projects");
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
      setView("editor");
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

  // Empty-vault onboarding gate. Renders an alternate first-run screen
  // when:
  //   state 1 — folder has no recognisable vault structure at all (no
  //             `.vault/config.yml` AND no `00_meta/`). A pre-config.yml
  //             vault (legacy: `00_meta/` exists but the config file
  //             was never created) falls through to the normal
  //             Dashboard, where the format-pill surfaces "format: none"
  //             as a soft warning instead of blocking the whole UI.
  //   state 2 — vault is fully initialised (config.yml exists) but has
  //             no projects yet — the onboarding form helps create one.
  // The "proceedWithoutVault" override lets the user bypass either
  // state for read-only inspection of an unusual folder.
  if (!proceedWithoutVault && !result.hasVaultConfig && !result.hasMeta) {
    return (
      <EmptyVaultFresh
        result={result}
        onRescan={onRescan}
        onProceedWithout={() => setProceedWithoutVault(true)}
        onPickAnother={onClose}
      />
    );
  }
  if (
    !proceedWithoutVault &&
    result.hasVaultConfig &&
    result.projects.length === 0
  ) {
    return (
      <EmptyVaultNoProjects
        result={result}
        onRescan={onRescan}
        onOpenFile={(path) => attemptOpenFile(path)}
        onChatWithVault={() => setProceedWithoutVault(true)}
      />
    );
  }

  // PR A stub for the title-bar's "open projects" list: just the
  // currently-drilled-in project, if any. Multi-project state arrives
  // in PR C.
  const openProjects = selectedProject ? [selectedProject.slug] : [];
  const activeProjectSlug = selectedProject?.slug ?? null;

  return (
    <div className="dashboard">
      <TitleBar
        openProjects={openProjects}
        activeProject={activeProjectSlug}
        totalChats={0}
        runningChats={0}
        onSwitchProject={() => {
          // PR A stub — only one project tab can be active so nothing
          // to switch. PR C wires multi-project state.
        }}
        onCloseProject={() => {
          // PR A stub — close-tab is meaningless without multi-open.
        }}
        onAddProject={() => {
          // PR A stub — opening additional projects is PR C.
        }}
        onToggleChat={() => {
          // PR A stub — chat collapse state still lives inside RunPanel
          // (slice 2). PR B lifts it.
        }}
        onOpenPalette={() => {
          // PR A stub — palette UI doesn't exist yet.
        }}
        vaultPath={displayedVaultRoot}
        meta={{
          format: result.vaultFormatVersion ?? "?",
          mdCount: result.markdownFiles.length,
          projectCount: result.projects.length,
          artifactCount: result.artifacts.length,
        }}
      />
      <header className="dashboard__header">
        <div className="dashboard__title">
          <span className="dashboard__label">Vault</span>
          <span className="dashboard__path" title={displayedVaultRoot}>
            {displayedVaultRoot}
          </span>
        </div>
        <div className="dashboard__meta">
          <PrivacyBadge state={privacy.state} reason={privacy.reason} />
          <VaultFormatPill
            hasVaultConfig={result.hasVaultConfig}
            vaultFormatVersion={result.vaultFormatVersion}
            vaultFormatSupported={result.vaultFormatSupported}
            onClickFix={
              isLegacyVault
                ? () =>
                    setCreateConfigDialog({ busy: false, error: null })
                : undefined
            }
          />
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
          <RecommendationsBell
            active={recs.active}
            dismissed={recs.dismissed}
            onDismiss={(id) => void recs.dismiss(id)}
            onRestore={(id) => void recs.restore(id)}
            onClearAll={() => void recs.clearAll()}
            onGoToProject={goToProject}
            onOpenFile={attemptOpenFile}
          />
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
        <Sidebar
          projects={result.projects}
          drafts={result.drafts}
          artifactCount={result.artifacts.length}
          zoneCount={result.zones.length}
          diagnostics={result.diagnostics}
          // PR A: session count not threaded through Dashboard yet.
          // The Run-history view loads its own list when opened; the
          // sidebar row count just hides until PR B lifts the chat
          // history hook.
          sessionCount={0}
          files={filePaths}
          activeView={effectiveView}
          activeProject={activeProjectSlug}
          activeFilePath={openFile?.path ?? null}
          openError={openError}
          onSwitchView={onSwitchView}
          onOpenProject={(slug) => {
            const project = result.projects.find((p) => p.slug === slug);
            if (project) {
              setSelectedProject(project);
              setView("projects");
            }
          }}
          onOpenFile={attemptOpenFile}
          onOpenDraft={() => setView("drafts")}
          onNewFile={attemptNewFile}
        />

        <main
          className={
            "dashboard__main" +
            (effectiveView === "editor" ? " dashboard__main--editor" : "")
          }
        >
          {/* Slice 8 PR A: the `<nav class="tabs">` strip was removed
              here — sidebar BROWSE rows now drive the view switch. The
              panel sections below kept their `id` for any external
              `aria-controls` references, but no longer claim
              `role="tabpanel"` since there's no `tablist` parent. */}
          {effectiveView === "projects" && (
            <section
              id="panel-projects"
              className="panel"
            >
              {selectedProject ? (
                <ProjectDetail
                  project={selectedProject}
                  artifacts={result.artifacts}
                  homeDir={result.homeDir}
                  vaultRoot={result.vaultRoot}
                  refreshTick={refreshTick}
                  recommendations={recs.active.filter(
                    (r) => r.projectSlug === selectedProject.slug,
                  )}
                  onDismissRecommendation={(id) => void recs.dismiss(id)}
                  onOpenFile={attemptOpenFile}
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
          {effectiveView === "artifacts" && (
            <section
              id="panel-artifacts"
              className="panel"
            >
              <ArtifactList artifacts={result.artifacts} />
            </section>
          )}
          {effectiveView === "drafts" && (
            <section
              id="panel-drafts"
              className="panel"
            >
              <DraftsList
                vaultRoot={result.vaultRoot}
                drafts={result.drafts}
                onRescan={rescanWithTick}
                onPreview={attemptOpenFile}
              />
            </section>
          )}
          {effectiveView === "security" && (
            <section
              id="panel-security"
              className="panel"
            >
              <SecurityPanel projects={result.projects} />
            </section>
          )}
          {effectiveView === "history" && (
            <section
              id="panel-history"
              className="panel"
            >
              <HistoryPanel
                vaultRoot={result.vaultRoot}
                onReopen={(session) => {
                  runPanelRef.current?.reopenSession(session);
                  // After reopening, drop the user back into the chat
                  // so they see the restored conversation immediately.
                  setView("projects");
                }}
              />
            </section>
          )}
          {effectiveView === "zones" && (
            <section
              id="panel-zones"
              className="panel"
            >
              <ZoneList zones={result.zones} />
            </section>
          )}
          {effectiveView === "diagnostics" && (
            <section
              id="panel-diagnostics"
              className="panel"
            >
              <Diagnostics diagnostics={result.diagnostics} />
            </section>
          )}
          {effectiveView === "editor" && openFile && (
            <section
              id="panel-editor"
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
                onOpenWikilink={onOpenWikilink}
              />
            </section>
          )}
        </main>
      </div>

      <RunPanel
        ref={runPanelRef}
        vaultRoot={result.vaultRoot}
        projects={result.projects}
      />

      <ApproveToolsModal
        request={pendingPermission}
        onResolved={() => setPendingPermission(null)}
      />

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

      {createConfigDialog && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3 className="modal__title">Create .vault/config.yml?</h3>
            <div className="modal__body">
              <p style={{ margin: "0 0 10px" }}>
                Locks this vault to format <code>version: "1"</code> so future
                IDE versions know how to read it. Won't touch any existing
                files.
              </p>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
                Also creates any missing canonical zone directories (no-op if
                they already exist) and adds <code>00_meta/AGENTS.md</code>{" "}
                only if the file isn't there yet.
              </p>
            </div>
            {createConfigDialog.error && (
              <p className="modal__error" role="alert">
                {createConfigDialog.error}
              </p>
            )}
            <div className="modal__actions">
              <button
                type="button"
                className="btn"
                onClick={() => setCreateConfigDialog(null)}
                disabled={createConfigDialog.busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  void onConfirmCreateConfig();
                }}
                disabled={createConfigDialog.busy}
              >
                {createConfigDialog.busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
