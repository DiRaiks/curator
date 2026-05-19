import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMarkdownFile,
  initVault,
  listSessions,
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
import { EditorTabs, type EditorViewMode } from "./EditorTabs";
import { EmptyVaultFresh } from "./EmptyVaultFresh";
import { EmptyVaultNoProjects } from "./EmptyVaultNoProjects";
import { HistoryPanel } from "./HistoryPanel";
import { NewFileDialog } from "./NewFileDialog";
import { Sidebar, type ViewId } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Tooltip } from "./Tooltip";

/** Most open editor buffers we keep around. Spec: LRU eviction at 8. */
const MAX_OPEN_FILES = 8;

/** `localStorage` key holding the persisted editor view mode. Carried
 *  over from slice 5's EditorPanel-owned state so users don't lose
 *  their preference on upgrade. */
const EDITOR_VIEW_MODE_STORAGE_KEY = "vide.editor.viewMode";

/** Slice 8 PR C — persisted multi-project tabs. We store the slug list
 *  and the active slug separately because writing one without the
 *  other (e.g. switching active without changing openProjects) is the
 *  common case; bundling them into a single JSON blob would force a
 *  serialize-everything-on-every-switch pattern. */
const OPEN_PROJECTS_STORAGE_KEY = "vide.openProjects";
const ACTIVE_PROJECT_STORAGE_KEY = "vide.activeProject";
import { useRecommendations } from "../hooks/useRecommendations";
import { DraftsList } from "./DraftsList";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { RecommendationsBell } from "./RecommendationsBell";
import {
  RunPanel,
  type RunPanelHandle,
  type RunStatusInfo,
} from "./RunPanel";
import { SecurityPanel } from "./SecurityPanel";
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
  /** `Date.now()` of the last time this buffer was activated. Used to
   *  evict the least-recently-used buffer when the user opens a 9th
   *  file. The tab order in `openFiles` stays stable (insertion
   *  order); only eviction consults this timestamp. */
  lastAccessedAt: number;
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
  /** When set, the pill renders a small "fix" link that calls this
   *  handler. Used only in the legacy-vault case (existing vault
   *  structure but no `.vault/config.yml` yet) — gives the user a
   *  one-click way to fix the warning without leaving the dashboard. */
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
      'Vault has no .vault/config.yml. Add the file with `version: "1"` to lock the format contract.';
  } else if (!vaultFormatVersion) {
    label = "format: ?";
    ok = false;
    tooltip =
      '.vault/config.yml has no parseable `version:` field. Add `version: "1"`.';
  } else if (!vaultFormatSupported) {
    label = `format: ${vaultFormatVersion} (too new)`;
    ok = false;
    tooltip = `Vault declares format ${vaultFormatVersion}, which is newer than this IDE supports. Some fields may not be read correctly.`;
  } else {
    label = `format: ${vaultFormatVersion}`;
    ok = true;
    tooltip = `Vault format ${vaultFormatVersion} declared in .vault/config.yml.`;
  }

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
          title={'Create .vault/config.yml with version: "1"'}
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

  // Slice 8 PR C — open project tabs in the titlebar and which one
  // is the active context. Slugs (not Project objects) are the source
  // of truth so we can persist them across restarts; the full Project
  // is looked up via `result.projects` when needed.
  const [openProjects, setOpenProjects] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(OPEN_PROJECTS_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((s) => typeof s === "string")
      ) {
        return parsed as string[];
      }
    } catch {
      // Malformed JSON or missing key — fall through to the empty default.
      // Mistyped values shouldn't crash the dashboard.
    }
    return [];
  });
  const [activeProject, setActiveProject] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  });

  // Slice 8 PR B — multi-buffer editor state. `openFiles` holds every
  // open buffer in insertion order (stable for the tab strip);
  // `activeFileIdx` is the index of the buffer currently shown in the
  // editor. `-1` means "no active file" (derived `activeFile` returns
  // `null` and the editor pane falls back to projects).
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFileIdx, setActiveFileIdx] = useState<number>(-1);
  // Editor view mode lifted from EditorPanel (slice 5) into Dashboard
  // so the new EditorTabs strip can own the segmented toggle and the
  // ⌘1/2/3 shortcut applies regardless of which view is active.
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>(
    () => {
      if (typeof window === "undefined") return "split";
      const raw = window.localStorage.getItem(EDITOR_VIEW_MODE_STORAGE_KEY);
      return raw === "src" || raw === "split" || raw === "prev"
        ? raw
        : "split";
    },
  );
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  // Derived view of the currently-active buffer. Everything in
  // Dashboard that used to read `openFile` reads this instead; writes
  // go through the multi-buffer helpers below.
  const activeFile: OpenFile | null =
    activeFileIdx >= 0 && activeFileIdx < openFiles.length
      ? openFiles[activeFileIdx]
      : null;

  /** Patch the currently-active buffer. No-op when none. */
  const updateActiveFile = useCallback(
    (patch: Partial<OpenFile>) => {
      setOpenFiles((prev) =>
        prev.map((f, i) =>
          i === activeFileIdx ? { ...f, ...patch } : f,
        ),
      );
    },
    [activeFileIdx],
  );

  /** Open a file at `path` with already-loaded `content`. Switches to
   *  an existing tab if the path is already open; otherwise pushes a
   *  new tab and (if cap exceeded) evicts the least-recently-used
   *  buffer in-place to keep the visible tab order stable. */
  const addOrSwitchTab = useCallback(
    (file: Omit<OpenFile, "lastAccessedAt">) => {
      setOpenFiles((prev) => {
        const now = Date.now();
        const existing = prev.findIndex((f) => f.path === file.path);
        if (existing >= 0) {
          setActiveFileIdx(existing);
          return prev.map((f, i) =>
            i === existing ? { ...f, lastAccessedAt: now } : f,
          );
        }
        const next: OpenFile = { ...file, lastAccessedAt: now };
        if (prev.length < MAX_OPEN_FILES) {
          setActiveFileIdx(prev.length);
          return [...prev, next];
        }
        // Cap reached — evict LRU in-place so the surviving tabs keep
        // their positions.
        let lruIdx = 0;
        let lruAt = prev[0].lastAccessedAt;
        for (let i = 1; i < prev.length; i++) {
          if (prev[i].lastAccessedAt < lruAt) {
            lruAt = prev[i].lastAccessedAt;
            lruIdx = i;
          }
        }
        setActiveFileIdx(lruIdx);
        return prev.map((f, i) => (i === lruIdx ? next : f));
      });
    },
    [],
  );

  /** Close the tab at `idx`. Adjusts `activeFileIdx` so a sensible
   *  neighbour stays active; falls through to `-1` when the last tab
   *  was closed. */
  const closeTabAt = useCallback((idx: number) => {
    setOpenFiles((prev) => prev.filter((_, i) => i !== idx));
    setActiveFileIdx((prevIdx) => {
      // Index math is over the PRE-filter array — at the moment this
      // setter runs, openFiles still has the closed tab in it. After
      // setOpenFiles commits, indices ≥ the closed one shift left by 1.
      if (idx < prevIdx) return prevIdx - 1;
      if (idx > prevIdx) return prevIdx;
      // Closing the active tab: prefer the previous one; -1 if none
      // remain.
      return prevIdx === 0 ? -1 : prevIdx - 1;
    });
  }, []);

  // Persist the view mode and bind the global ⌘1/2/3 shortcut. Both
  // moved from EditorPanel (slice 5) so the chord works from any
  // view, not just when the editor pane has focus.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(EDITOR_VIEW_MODE_STORAGE_KEY, editorViewMode);
  }, [editorViewMode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        setEditorViewMode("src");
      } else if (e.key === "2") {
        e.preventDefault();
        setEditorViewMode("split");
      } else if (e.key === "3") {
        e.preventDefault();
        setEditorViewMode("prev");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Persist open-project tabs + active slug separately. Two writes
  // because the common case is "switch active project" which doesn't
  // need to re-serialize the openProjects array.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      OPEN_PROJECTS_STORAGE_KEY,
      JSON.stringify(openProjects),
    );
  }, [openProjects]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeProject) {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProject);
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  }, [activeProject]);

  // Drop stale slugs after a rescan — a project may have been renamed
  // or deleted between sessions. `result.projects` is the source of
  // truth; persisted slugs that don't exist in it any more get
  // silently discarded so the title bar doesn't hold ghost tabs.
  useEffect(() => {
    const validSlugs = new Set(result.projects.map((p) => p.slug));
    setOpenProjects((prev) => {
      const filtered = prev.filter((s) => validSlugs.has(s));
      // Identity-preserve when nothing changed so the persist effect
      // doesn't fire on every rescan.
      return filtered.length === prev.length ? prev : filtered;
    });
    setActiveProject((prev) =>
      prev && !validSlugs.has(prev) ? null : prev,
    );
  }, [result.projects]);

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

  // Live run-status snapshot, populated via RunPanel's imperative
  // handle. Ambient UI (TitleBar AI handle pulse, StatusBar chat
  // counter) reads from here instead of reaching into RunPanel's
  // private useState.
  const [runStatusInfo, setRunStatusInfo] = useState<RunStatusInfo>({
    state: "idle",
    runningSkill: null,
    runningProject: null,
    lastUsage: null,
  });
  // Total saved chat sessions for this vault. Drives the AI handle's
  // `AI N` count and the StatusBar `N total` segment. Refetched on
  // mount and on every `run:exit` (a fresh exit means one more saved
  // session lives on disk).
  const [savedSessionCount, setSavedSessionCount] = useState<number>(0);
  const vaultRoot = result.vaultRoot;
  const refetchSessions = useCallback(async () => {
    if (!vaultRoot) return;
    try {
      const list = await listSessions(vaultRoot, false);
      setSavedSessionCount(list.length);
    } catch {
      // Best-effort — leave the previous count alone if the IPC fails.
    }
  }, [vaultRoot]);

  useEffect(() => {
    void refetchSessions();
  }, [refetchSessions]);

  // Subscribe to RunPanel status updates. The handle is populated by
  // `useImperativeHandle` during the commit phase, which runs BEFORE
  // this effect, so `runPanelRef.current` is non-null by now.
  useEffect(() => {
    const handle = runPanelRef.current;
    if (!handle) return;
    return handle.subscribeToStatus(setRunStatusInfo);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onRunEvents({
      onPermissionRequest: (ev) => setPendingPermission(ev),
      // On exit: clear the permission prompt (defensive — Stop / crash
      // could leave it open) AND refetch the session list so the
      // AI/StatusBar counter picks up the newly-persisted row.
      onExit: () => {
        setPendingPermission(null);
        void refetchSessions();
      },
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
  }, [refetchSessions]);

  // Auto-include the running chat's project in the title-bar tab strip
  // so a user who started a chat via RunPanel scope dropdown (rather
  // than a sidebar click) still gets a visible tab for it. The tab
  // sticks around after the chat exits — closing it is up to the user.
  useEffect(() => {
    const slug = runStatusInfo.runningProject;
    if (!slug) return;
    setOpenProjects((prev) =>
      prev.includes(slug) ? prev : [...prev, slug],
    );
    setActiveProject((prev) => prev ?? slug);
  }, [runStatusInfo.runningProject]);

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
    activeFile != null && activeFile.content !== activeFile.savedContent;
  /** Total unsaved buffers across all tabs — surfaced in the status bar
   *  for at-a-glance "how much work is pending" awareness. */
  const dirtyCount = openFiles.reduce(
    (n, f) => (f.content !== f.savedContent ? n + 1 : n),
    0,
  );
  // Fall back to the projects view when the user explicitly chose the
  // editor but no file is open — otherwise the main pane renders
  // nothing. Renamed from `effectiveTab` in slice 8 PR A; behavior
  // unchanged.
  const effectiveView: ViewId =
    view === "editor" && !activeFile ? "projects" : view;

  /**
   * Reconcile every open editor buffer with the latest scan. Files that
   * vanished from disk get `missing: true` (the editor pane shows a
   * banner and disables Save); reappearing files drop the flag. We
   * compare per-buffer because each tab tracks its own file independent
   * of which one is active.
   *
   * Bails out by returning `prev` unchanged when nothing flips — keeps
   * React from looping on the new array reference `.map` produces.
   */
  useEffect(() => {
    setOpenFiles((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const stillIndexed = result.markdownFiles.some(
          (m) => m.path === f.path,
        );
        if (!stillIndexed && !f.missing) {
          changed = true;
          return { ...f, missing: true };
        }
        if (stillIndexed && f.missing) {
          changed = true;
          return { ...f, missing: false };
        }
        return f;
      });
      return changed ? next : prev;
    });
  }, [result.markdownFiles]);

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
        addOrSwitchTab({ path, content, savedContent: content, scope });
        setView("editor");
      } catch (err: unknown) {
        // Surface inline; `window.alert` is silently disabled in the Tauri
        // webview, so a banner under the file tree is what the user actually
        // sees.
        setOpenError(`Open failed for ${path}: ${errorMessage(err)}`);
      }
    },
    [result.vaultRoot, result.markdownFiles, addOrSwitchTab],
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
   * Open (or switch to) a project's tab. Used by sidebar PROJECTS row
   * clicks and TitleBar tab-switch clicks. Spec-defined behaviors:
   *
   *   1. Add `slug` to `openProjects` if not already there.
   *   2. Set `activeProject = slug`.
   *   3. `view = "editor"`.
   *   4. Open the project's `_index.md` — switching to an already-open
   *      tab instead of re-reading from disk so an in-flight dirty
   *      buffer survives.
   *
   * Refuses gracefully if the slug isn't in the current scan (project
   * may have been deleted between renders).
   */
  const openProject = useCallback(
    (slug: string) => {
      const project = result.projects.find((p) => p.slug === slug);
      if (!project) return;
      setOpenProjects((prev) =>
        prev.includes(slug) ? prev : [...prev, slug],
      );
      setActiveProject(slug);
      setView("editor");

      const indexPath = project.indexFile;
      const existingIdx = openFiles.findIndex((f) => f.path === indexPath);
      if (existingIdx >= 0) {
        // Already open in another tab — just switch to it. Keeps the
        // dirty buffer intact and avoids an unnecessary disk read.
        setActiveFileIdx(existingIdx);
        setOpenFiles((prev) =>
          prev.map((f, i) =>
            i === existingIdx ? { ...f, lastAccessedAt: Date.now() } : f,
          ),
        );
      } else {
        attemptOpenFile(indexPath);
      }
    },
    [result.projects, openFiles, attemptOpenFile],
  );

  /**
   * Close a project tab. If the closed tab was the active one, fall
   * back to the previous tab in the strip; or to the new first tab
   * when the closed tab was at the head; or to `null` when no tabs
   * remain. The new active project's `_index.md` is opened/refocused
   * so the editor pane has something to render.
   *
   * The file buffers themselves are intentionally NOT closed — a user
   * might have other files from that project open and want to keep
   * editing them. PR C scope is the tab-strip-as-project-list, not
   * "close-all-project-files".
   */
  const closeProject = useCallback(
    (slug: string) => {
      const idx = openProjects.indexOf(slug);
      if (idx < 0) return;
      const remaining = openProjects.filter((s) => s !== slug);
      setOpenProjects(remaining);

      if (activeProject === slug) {
        const fallback =
          idx > 0 ? openProjects[idx - 1] : remaining[0] ?? null;
        setActiveProject(fallback);
        if (fallback) {
          const proj = result.projects.find((p) => p.slug === fallback);
          if (proj) attemptOpenFile(proj.indexFile);
        }
      }
    },
    [openProjects, activeProject, result.projects, attemptOpenFile],
  );

  /**
   * Titlebar `+` handler. Spec offers two implementations: a popover
   * picker or just routing to the existing Projects view. Going with
   * the latter — re-using `ProjectList` in the main pane is simpler
   * than building a popover, and the ProjectList click already opens
   * a project (now wired through `openProject`).
   */
  const onAddProject = useCallback(() => {
    setSelectedProject(null);
    setView("projects");
  }, []);

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

  /** Close the currently-active editor buffer. When it was the last
   *  buffer, fall back to the projects view so the main pane has
   *  something meaningful to render. */
  const closeActiveEditor = useCallback(() => {
    if (activeFileIdx < 0) return;
    const wasLast = openFiles.length === 1;
    closeTabAt(activeFileIdx);
    setEditorError(null);
    if (wasLast) setView("projects");
  }, [activeFileIdx, openFiles.length, closeTabAt]);

  const attemptCloseEditor = useCallback(() => {
    if (isDirty) {
      setPendingAction(() => closeActiveEditor);
    } else {
      closeActiveEditor();
    }
  }, [isDirty, closeActiveEditor]);

  /** Close any tab by index. Used by EditorTabs' `×` affordance. Runs
   *  the dirty-buffer dialog when the targeted tab has unsaved work,
   *  even if it isn't the currently-active one. */
  const attemptCloseTab = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= openFiles.length) return;
      const tab = openFiles[idx];
      const tabDirty = tab.content !== tab.savedContent;
      const closeFn = () => {
        const wasLast = openFiles.length === 1;
        closeTabAt(idx);
        if (wasLast) setView("projects");
      };
      if (tabDirty) {
        // Switch to the dirty tab so the existing ConfirmDirtyDialog
        // — which speaks about the ACTIVE buffer — narrates the right
        // file. After the user picks save/discard, `closeFn` runs.
        setActiveFileIdx(idx);
        setPendingAction(() => closeFn);
      } else {
        closeFn();
      }
    },
    [openFiles, closeTabAt],
  );

  const saveOpenFile = useCallback(async (): Promise<boolean> => {
    if (!activeFile) return false;
    setEditorSaving(true);
    setEditorError(null);
    try {
      await writeMarkdownFile(
        result.vaultRoot,
        activeFile.path,
        activeFile.content,
      );
      updateActiveFile({ savedContent: activeFile.content });
      return true;
    } catch (err: unknown) {
      setEditorError(errorMessage(err));
      return false;
    } finally {
      setEditorSaving(false);
    }
  }, [activeFile, result.vaultRoot, updateActiveFile]);

  const discardOpenFile = useCallback(() => {
    if (!activeFile) return;
    updateActiveFile({ content: activeFile.savedContent });
  }, [activeFile, updateActiveFile]);

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
      addOrSwitchTab({ path, content, savedContent: content });
      setEditorError(null);
      setView("editor");
      await rescanWithTick();
    },
    [result.vaultRoot, rescanWithTick, addOrSwitchTab],
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

  const runningChats = runStatusInfo.state === "running" ? 1 : 0;

  return (
    <div className="dashboard">
      <TitleBar
        openProjects={openProjects}
        activeProject={activeProject}
        onSwitchProject={openProject}
        onCloseProject={closeProject}
        onAddProject={onAddProject}
      />

      {/* Single chrome row carrying every status pill + utility button.
       * Project tabs live in the `<TitleBar>` above; everything else is
       * here so the user has one obvious place to scan for vault
       * state. */}
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
                ? () => setCreateConfigDialog({ busy: false, error: null })
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
          {/* Palette + AI handle — moved here from the short-lived
            * TitleBar pass so they share one chrome row with the rest
            * of the vault meta. Palette is still a no-op; AI handle
            * pulses with the live `runStatusInfo` from RunPanel. */}
          <button
            type="button"
            className="header-palette"
            aria-label="Open command palette"
            title="Command palette (coming soon)"
            onClick={() => {
              // Palette UI doesn't exist yet.
            }}
          >
            <span className="header-palette__kbd">⌘K</span>
            <span>palette</span>
          </button>
          <button
            type="button"
            className="header-ai"
            aria-label="Toggle chat panel"
            title="Toggle chat panel"
            onClick={() => {
              // Chat collapse state still lives inside RunPanel
              // (slice 2). Wiring this requires an additional
              // imperative-handle method; out of scope right now.
            }}
          >
            <span
              className={
                "header-ai__dot" +
                (runningChats > 0 ? " header-ai__dot--running" : "")
              }
              aria-hidden="true"
            />
            <span>AI</span>
            <span className="header-ai__count">{savedSessionCount}</span>
            {runningChats > 0 && (
              <span className="header-ai__live">{runningChats} live</span>
            )}
            <span className="header-ai__kbd">⌘J</span>
          </button>
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
          activeProject={activeProject}
          activeFilePath={activeFile?.path ?? null}
          openError={openError}
          onSwitchView={onSwitchView}
          onOpenProject={openProject}
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
          {effectiveView === "editor" && openFiles.length > 0 && (
            <EditorTabs
              tabs={openFiles.map((f) => ({
                path: f.path,
                modified: f.content !== f.savedContent,
              }))}
              activeIndex={activeFileIdx}
              viewMode={editorViewMode}
              onSwitch={(idx) => {
                setActiveFileIdx(idx);
                // Touch the LRU timestamp on user-initiated switch so
                // a freshly-focused tab doesn't get evicted next.
                setOpenFiles((prev) =>
                  prev.map((f, i) =>
                    i === idx ? { ...f, lastAccessedAt: Date.now() } : f,
                  ),
                );
              }}
              onClose={attemptCloseTab}
              onSetViewMode={setEditorViewMode}
            />
          )}
          {effectiveView === "editor" && activeFile && (
            <section
              id="panel-editor"
              className="panel panel--editor"
            >
              <EditorPanel
                path={activeFile.path}
                scope={activeFile.scope}
                content={activeFile.content}
                savedContent={activeFile.savedContent}
                saving={editorSaving}
                error={editorError}
                missing={activeFile.missing}
                viewMode={editorViewMode}
                onChange={(next) => updateActiveFile({ content: next })}
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

      <StatusBar
        activeProject={activeProject ?? runStatusInfo.runningProject}
        // Branch + cursor still aren't lifted — keep `null` so those
        // slots collapse silently until a future PR plumbs
        // `inspect_source_repo` / CodeMirror cursor events through.
        branch={null}
        dirtyCount={dirtyCount}
        totalChats={savedSessionCount}
        runningChats={runStatusInfo.state === "running" ? 1 : 0}
        runningSkill={runStatusInfo.runningSkill}
        fileMode={activeFile ? "md gfm" : null}
        cursor={null}
      />

      <ApproveToolsModal
        request={pendingPermission}
        onResolved={() => setPendingPermission(null)}
      />

      {pendingAction && activeFile && isDirty && (
        <ConfirmDirtyDialog
          path={activeFile.path}
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
