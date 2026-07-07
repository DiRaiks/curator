import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMarkdownFile,
  gitStatus,
  initVault,
  readMarkdownFile,
  writeMarkdownFile,
} from "../api";
import type { GitStatus, Project, ScanResult } from "../types";
import { maskHome } from "../utils/path";
import { ArtifactList } from "./ArtifactList";
import { ConfirmDirtyDialog } from "./ConfirmDirtyDialog";
import { EditorPanel } from "./EditorPanel";
import { EditorTabs, type EditorViewMode } from "./EditorTabs";
import { EmptyVaultFresh } from "./EmptyVaultFresh";
import { EmptyVaultNoProjects } from "./EmptyVaultNoProjects";
import { HistoryPanel } from "./HistoryPanel";
import { NewFileDialog } from "./NewFileDialog";
import { LeftPanel, PanelSettings } from "./shell/LeftPanel";
import { PanelCve } from "./shell/PanelCve";
import { PanelGit } from "./shell/PanelGit";
import { Rail } from "./shell/Rail";
import { ShellFiles } from "./shell/ShellFiles";
import { ShellPalette, type PaletteCommand } from "./shell/ShellPalette";
import { ShellStatusBar } from "./shell/ShellStatusBar";
import { ShellTitleBar } from "./shell/ShellTitleBar";
import { SHELL_STORAGE_KEY, type PanelId, type ShellTheme } from "./shell/types";

/** Most open editor buffers we keep around. Spec: LRU eviction at 8. */
const MAX_OPEN_FILES = 8;

/** `localStorage` key holding the persisted editor view mode. Carried
 *  over from slice 5's EditorPanel-owned state so users don't lose
 *  their preference on upgrade. */
const EDITOR_VIEW_MODE_STORAGE_KEY = "vide.editor.viewMode";

/** Slug of the project the user last drilled into. (The slice-8
 *  multi-project titlebar tabs were retired by shell v2 — only the
 *  active slug persists now.) */
const ACTIVE_PROJECT_STORAGE_KEY = "vide.activeProject";

/** Left panels rendered by the shell — the agent chat is one of them
 *  (404px instead of 268px; its host stays mounted while closed so
 *  running chats keep streaming). */
type LeftPanelId = PanelId;

const LEFT_PANEL_IDS: readonly LeftPanelId[] = [
  "projects",
  "search",
  "git",
  "skills",
  "drafts",
  "cve",
  "diag",
  "agent",
  "settings",
];

/** Resize bounds (README "Resize rules"): agent 320–560, files
 *  200–320; the editor floor drives auto-collapse of the left panel. */
const AGENT_WIDTH_DEFAULT = 404;
const AGENT_WIDTH_MIN = 320;
const AGENT_WIDTH_MAX = 560;
const FILES_WIDTH_DEFAULT = 250;
const FILES_WIDTH_MIN = 200;
const FILES_WIDTH_MAX = 320;
const PLAIN_PANEL_WIDTH = 268;
const RAIL_WIDTH = 52;
const EDITOR_MIN_WIDTH = 480;

interface ShellPersistedState {
  theme: ShellTheme;
  activePanel: LeftPanelId | null;
  agentWidth: number;
  filesWidth: number;
}

function clampWidth(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function loadShellState(): ShellPersistedState {
  const fallback: ShellPersistedState = {
    theme: "graphite",
    activePanel: "projects",
    agentWidth: AGENT_WIDTH_DEFAULT,
    filesWidth: FILES_WIDTH_DEFAULT,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(SHELL_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const p = parsed as Record<string, unknown>;
    return {
      theme: p.theme === "porcelain" ? "porcelain" : "graphite",
      activePanel:
        p.activePanel === null
          ? null
          : LEFT_PANEL_IDS.includes(p.activePanel as LeftPanelId)
            ? (p.activePanel as LeftPanelId)
            : fallback.activePanel,
      agentWidth: clampWidth(
        p.agentWidth,
        AGENT_WIDTH_MIN,
        AGENT_WIDTH_MAX,
        AGENT_WIDTH_DEFAULT,
      ),
      filesWidth: clampWidth(
        p.filesWidth,
        FILES_WIDTH_MIN,
        FILES_WIDTH_MAX,
        FILES_WIDTH_DEFAULT,
      ),
    };
  } catch {
    return fallback;
  }
}

/**
 * Identifier for the currently-rendered center view. Shell v2 keeps
 * the center views that still need main-pane room (project detail,
 * artifact detail, drafts review, run history, git diffs) reachable
 * from the left panels while their surfaces migrate; `zones`,
 * `security` and `diagnostics` were absorbed by the rail panels.
 */
export type ViewId =
  | "projects"
  | "artifacts"
  | "drafts"
  | "history"
  | "source-control"
  | "editor";
import { useRecommendations } from "../hooks/useRecommendations";
import { DraftsList } from "./DraftsList";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { RecommendationsBell } from "./RecommendationsBell";
import { type RunPanelHandle, type RunStatusInfo } from "./RunPanel";
import { RunPanelHost } from "./RunPanelHost";
import { SourceControlPanel } from "./SourceControlPanel";

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
  /** `Date.now()` of the last successful save this session, or `null`
   *  before the first one. Drives the editor path row's "saved Nm". */
  savedAtMs?: number | null;
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

  // Shell v2 chrome: theme + which left panel is open. Restored from
  // localStorage in one shot so a reload lands where the user left.
  const [theme, setTheme] = useState<ShellTheme>(() => loadShellState().theme);
  const [activePanel, setActivePanel] = useState<LeftPanelId | null>(
    () => loadShellState().activePanel,
  );
  const [agentWidth, setAgentWidth] = useState<number>(
    () => loadShellState().agentWidth,
  );
  const [filesWidth, setFilesWidth] = useState<number>(
    () => loadShellState().filesWidth,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Last non-null panel, so ⌘B can re-open what the user closed.
  const lastPanelRef = useRef<LeftPanelId>("projects");
  // Latest save-if-dirty closure for the ⌘S handler — the keyboard
  // effect mounts once, so it reads through a ref instead of
  // re-binding on every buffer change.
  const saveIfDirtyRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (activePanel) lastPanelRef.current = activePanel;
  }, [activePanel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const state: ShellPersistedState = {
      theme,
      activePanel,
      agentWidth,
      filesWidth,
    };
    window.localStorage.setItem(SHELL_STORAGE_KEY, JSON.stringify(state));
  }, [theme, activePanel, agentWidth, filesWidth]);

  // Drive the document/window background from the *active* shell theme,
  // not from prefers-color-scheme. The native OS titlebar reflects the
  // window background; the CSS fallback (styles.css :root) only matches
  // when the OS theme happens to equal the app theme. Overriding here
  // keeps the titlebar in sync when the user toggles graphite/porcelain
  // against an opposite OS appearance. Values mirror shell.css --bg-deep.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.background =
      theme === "porcelain" ? "#eceef2" : "#0e0f12";
  }, [theme]);

  // Auto-collapse the left panel when the editor would drop below its
  // minimum width (README resize rules) — narrow window or panels
  // dragged wide.
  useEffect(() => {
    const check = () => {
      setActivePanel((panel) => {
        if (!panel) return panel;
        const leftW = panel === "agent" ? agentWidth : PLAIN_PANEL_WIDTH;
        const editorW =
          window.innerWidth - RAIL_WIDTH - leftW - filesWidth;
        return editorW < EDITOR_MIN_WIDTH ? null : panel;
      });
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [agentWidth, filesWidth]);

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
      } else if (e.key.toLowerCase() === "s") {
        // ⌘S — save the active buffer. The webview would otherwise
        // trigger the browser save dialog.
        e.preventDefault();
        saveIfDirtyRef.current();
      } else if (e.key.toLowerCase() === "j") {
        // ⌘J — toggle the agent panel.
        e.preventDefault();
        setActivePanel((p) => (p === "agent" ? null : "agent"));
      } else if (e.key.toLowerCase() === "k") {
        // ⌘K — command palette.
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key.toLowerCase() === "b") {
        // ⌘B — toggle the left panel; re-opens the last one used.
        e.preventDefault();
        setActivePanel((p) => (p ? null : lastPanelRef.current));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeProject) {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProject);
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  }, [activeProject]);

  // Drop a stale active slug after a rescan — the project may have
  // been renamed or deleted between sessions.
  useEffect(() => {
    const validSlugs = new Set(result.projects.map((p) => p.slug));
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
      // missing .vault/config.yml + creates canonical dirs that don't exist
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

  /** Bridge artifact "Run" clicks into the bottom chat panel: the
   *  materialized prompt is staged as a chat draft instead of spawning
   *  claude immediately, so the user can edit, add context, or
   *  pre-approve permissions before sending. Returns an error string
   *  (e.g. "active run") to surface inline at the callsite. */
  const handleStagePrompt = useCallback(
    (args: {
      text: string;
      projectSlug: string;
      promptId: string;
    }): string | null => {
      // Split the "ref is null" branch from the "stagePrompt returned
      // null (success)" branch — the prior `?? "Chat panel not ready
      // yet."` collapsed both into the error string, surfacing a
      // false error in the prompt card even when staging worked.
      const handle = runPanelRef.current;
      if (!handle) return "Chat panel not ready yet.";
      const err = handle.stagePrompt(args);
      // Successful staging should land the user in the composer —
      // open the agent panel so the pre-filled draft is visible.
      if (!err) setActivePanel("agent");
      return err;
    },
    [],
  );

  // Live run-status snapshot, populated via RunPanel's imperative
  // handle. Ambient UI (TitleBar AI handle pulse, StatusBar chat
  // counter) reads from here — including the saved-session count,
  // which RunPanel owns since it does the writes via `save_session`
  // and refreshes the list immediately after each UPSERT (no race
  // with a Dashboard-side refetch).
  const [runStatusInfo, setRunStatusInfo] = useState<RunStatusInfo>({
    state: "idle",
    runningCount: 0,
    runningSkill: null,
    runningProject: null,
    lastUsage: null,
    savedCount: null,
  });
  /** Saved-session count derived from `runStatusInfo`. `null` (pre-fetch)
   *  collapses to 0 for display so the badge doesn't flash an "empty"
   *  intermediate before RunPanel reports — first paint just shows the
   *  zero baseline. */
  const savedSessionCount = runStatusInfo.savedCount ?? 0;

  // Subscribe to RunPanel status updates. The handle is populated by
  // `useImperativeHandle` during the commit phase, which runs BEFORE
  // this effect, so `runPanelRef.current` is non-null by now.
  useEffect(() => {
    const handle = runPanelRef.current;
    if (!handle) return;
    return handle.subscribeToStatus(setRunStatusInfo);
  }, []);

  // Adopt the running chat's project as the active one when nothing
  // is active yet — a chat started from the RunPanel scope dropdown
  // should still light up the Projects panel.
  useEffect(() => {
    const slug = runStatusInfo.runningProject;
    if (!slug) return;
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

  // Vault git snapshot — the single source for every changed-file
  // count in the chrome (rail badge, titlebar ±N, Source Control
  // panel sections), per the design's "one source per count" rule.
  // `null` = not loaded / not a git repo. Recomputed on every rescan
  // and whenever the git panel mutates the index (`gitTick`).
  const [vaultGit, setVaultGit] = useState<GitStatus | null>(null);
  const [gitTick, setGitTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void gitStatus(result.vaultRoot)
      .then((s) => {
        if (cancelled) return;
        setVaultGit(s.isGitRepo ? s : null);
      })
      .catch(() => {
        if (!cancelled) setVaultGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [result.vaultRoot, refreshTick, gitTick]);

  const filePaths = useMemo(
    () => result.markdownFiles.map((f) => f.path),
    [result.markdownFiles],
  );
  const displayedVaultRoot = useMemo(
    () => maskHome(result.vaultRoot, result.homeDir),
    [result.vaultRoot, result.homeDir],
  );

  const isDirty =
    activeFile != null && activeFile.content !== activeFile.savedContent;
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

  /** Rail click: open the panel; clicking the active icon again
   *  closes it. */
  const pickPanel = useCallback((id: PanelId) => {
    setActivePanel((p) => (p === id ? null : id));
  }, []);

  const [openError, setOpenError] = useState<string | null>(null);

  const doOpenFile = useCallback(
    async (path: string) => {
      setEditorError(null);
      setOpenError(null);
      try {
        const content = await readMarkdownFile(result.vaultRoot, path);
        addOrSwitchTab({ path, content, savedContent: content });
        setView("editor");
      } catch (err: unknown) {
        // Surface inline; `window.alert` is silently disabled in the Tauri
        // webview, so a banner under the file tree is what the user actually
        // sees.
        setOpenError(`Open failed for ${path}: ${errorMessage(err)}`);
      }
    },
    [result.vaultRoot, addOrSwitchTab],
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
   * Open a project: make it the active context and render its
   * `ProjectDetail` (Run plans, Source Repo, Recommendations,
   * ContextPreview) in the center. Used by the Projects panel rows
   * and the recommendations bell. Refuses gracefully if the slug
   * isn't in the current scan.
   */
  const openProject = useCallback(
    (slug: string) => {
      const project = result.projects.find((p) => p.slug === slug);
      if (!project) return;
      setActiveProject(slug);
      setSelectedProject(project);
      setView("projects");
    },
    [result.projects],
  );

  /** Projects-panel `+` handler: routes to the ProjectList in the
   *  center, which doubles as the "open another project" picker. */
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
      updateActiveFile({
        savedContent: activeFile.content,
        savedAtMs: Date.now(),
      });
      return true;
    } catch (err: unknown) {
      setEditorError(errorMessage(err));
      return false;
    } finally {
      setEditorSaving(false);
    }
  }, [activeFile, result.vaultRoot, updateActiveFile]);

  // Keep the ⌘S closure current (see saveIfDirtyRef above).
  saveIfDirtyRef.current = () => {
    if (isDirty) void saveOpenFile();
  };

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
  // Both gates render inside an `.ide <theme>` wrapper so their legacy
  // styles pick up the shell palette via the bridged variables.
  if (!proceedWithoutVault && !result.hasVaultConfig && !result.hasMeta) {
    return (
      <div className={"ide " + theme}>
        <EmptyVaultFresh
          result={result}
          onRescan={onRescan}
          onProceedWithout={() => setProceedWithoutVault(true)}
          onPickAnother={onClose}
        />
      </div>
    );
  }
  if (
    !proceedWithoutVault &&
    result.hasVaultConfig &&
    result.projects.length === 0
  ) {
    return (
      <div className={"ide " + theme}>
        <EmptyVaultNoProjects
          result={result}
          onRescan={onRescan}
          onOpenFile={(path) => attemptOpenFile(path)}
          onChatWithVault={() => setProceedWithoutVault(true)}
        />
      </div>
    );
  }

  const runningChats = runStatusInfo.runningCount;
  const diagErrors = result.diagnostics.filter(
    (d) => d.level === "error",
  ).length;
  const diagWarnings = result.diagnostics.filter(
    (d) => d.level === "warning",
  ).length;

  // ⌘K command set. Rebuilt per render — the palette only mounts
  // while open, so the cost is a handful of object literals.
  const paletteCommands: PaletteCommand[] = [
    { id: "agent", label: "Open agent panel", hint: "⌘J", run: () => setActivePanel("agent") },
    { id: "projects", label: "Open projects panel", run: () => setActivePanel("projects") },
    { id: "search", label: "Search vault", run: () => setActivePanel("search") },
    { id: "git", label: "Open source control", run: () => setActivePanel("git") },
    { id: "skills", label: "Open AI artifacts", run: () => setActivePanel("skills") },
    { id: "drafts", label: "Review drafts", run: () => setActivePanel("drafts") },
    { id: "cve", label: "CVE scan", run: () => setActivePanel("cve") },
    { id: "diag", label: "Open diagnostics", run: () => setActivePanel("diag") },
    { id: "settings", label: "Open settings", run: () => setActivePanel("settings") },
    { id: "new-file", label: "New markdown file", run: attemptNewFile },
    {
      id: "theme",
      label: "Toggle theme (graphite / porcelain)",
      run: () => setTheme((t) => (t === "graphite" ? "porcelain" : "graphite")),
    },
    { id: "mode-src", label: "Editor: source mode", hint: "⌘1", run: () => setEditorViewMode("src") },
    { id: "mode-split", label: "Editor: split mode", hint: "⌘2", run: () => setEditorViewMode("split") },
    { id: "mode-prev", label: "Editor: preview mode", hint: "⌘3", run: () => setEditorViewMode("prev") },
    { id: "refresh", label: "Refresh vault (re-scan)", run: attemptRefresh },
    { id: "close-vault", label: "Close vault", run: onClose },
  ];

  return (
    <div className={"ide " + theme}>
      <ShellTitleBar
        vaultLabel={displayedVaultRoot}
        branch={vaultGit?.branch ?? null}
        dirtyCount={vaultGit?.files.length ?? 0}
        onFixConfig={
          isLegacyVault
            ? () => setCreateConfigDialog({ busy: false, error: null })
            : undefined
        }
        onRefresh={attemptRefresh}
        refreshing={refreshing}
        onCloseVault={onClose}
        onOpenPalette={() => setPaletteOpen(true)}
      >
        <RecommendationsBell
          active={recs.active}
          dismissed={recs.dismissed}
          onDismiss={(id) => void recs.dismiss(id)}
          onRestore={(id) => void recs.restore(id)}
          onClearAll={() => void recs.clearAll()}
          onGoToProject={openProject}
          onOpenFile={attemptOpenFile}
        />
      </ShellTitleBar>

      <div className="ide-body">
        <Rail
          active={activePanel}
          onPick={pickPanel}
          gitBadge={vaultGit?.files.length ?? 0}
          draftsBadge={result.drafts.length}
          errorBadge={diagErrors}
          agentRunning={runningChats > 0}
        />

        {activePanel === "git" && (
          <PanelGit
            vaultRoot={result.vaultRoot}
            status={vaultGit}
            onRefetch={() => setGitTick((t) => t + 1)}
            onOpenFile={attemptOpenFile}
            onOpenFullView={() => onSwitchView("source-control")}
          />
        )}
        {activePanel === "cve" && <PanelCve projects={result.projects} />}
        {activePanel === "settings" && (
          <PanelSettings
            result={result}
            vaultLabel={displayedVaultRoot}
            theme={theme}
            onSetTheme={setTheme}
            onFixConfig={
              isLegacyVault
                ? () => setCreateConfigDialog({ busy: false, error: null })
                : undefined
            }
          />
        )}
        {/* Agent panel host — always mounted so running chats keep
            streaming while the panel is closed; hidden via display:none
            inside. */}
        <RunPanelHost
          ref={runPanelRef}
          vaultRoot={result.vaultRoot}
          projects={result.projects}
          drafts={result.drafts}
          open={activePanel === "agent"}
          width={agentWidth}
          onResize={setAgentWidth}
          onOpenDrafts={() => setActivePanel("drafts")}
        />
        {(activePanel === "projects" ||
          activePanel === "search" ||
          activePanel === "skills" ||
          activePanel === "drafts" ||
          activePanel === "diag") && (
          <LeftPanel
            view={activePanel}
            result={result}
            activeProject={activeProject}
            sessionCount={savedSessionCount}
            onOpenProject={openProject}
            onOpenFile={attemptOpenFile}
            onOpenHistory={() => onSwitchView("history")}
            onAddProject={onAddProject}
            onOpenArtifactsView={() => onSwitchView("artifacts")}
            onOpenDraftsView={() => onSwitchView("drafts")}
          />
        )}

        <main className="ide-center">
          {/* Center views still rendered with the legacy `.panel`
              styling while their surfaces migrate into shell v2 —
              navigation into them now comes from the rail panels. */}
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
                  onStagePrompt={handleStagePrompt}
                  runningSkill={runStatusInfo.runningSkill}
                  onOpenAgent={() => setActivePanel("agent")}
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
              <ArtifactList
                artifacts={result.artifacts}
                vaultRoot={result.vaultRoot}
                homeDir={result.homeDir}
                projects={result.projects}
                activeProject={activeProject}
                runningSkill={runStatusInfo.runningSkill}
                onStagePrompt={handleStagePrompt}
                onOpenFile={attemptOpenFile}
                onOpenAgent={() => setActivePanel("agent")}
              />
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
          {effectiveView === "source-control" && (
            <section
              id="panel-source-control"
              className="panel panel--fill"
            >
              <SourceControlPanel
                vaultRoot={result.vaultRoot}
                refreshTick={refreshTick}
                onOpenFile={attemptOpenFile}
              />
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
                  // Land the user in the agent panel so the restored
                  // conversation is immediately visible.
                  setActivePanel("agent");
                }}
              />
            </section>
          )}
          {effectiveView === "editor" && activeFile && (
            <div className="ide-editor" id="panel-editor">
              <EditorTabs
                tabs={openFiles.map((f) => ({
                  path: f.path,
                  modified: f.content !== f.savedContent,
                }))}
                activeIndex={activeFileIdx}
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
              />
              <EditorPanel
                path={activeFile.path}
                content={activeFile.content}
                savedContent={activeFile.savedContent}
                saving={editorSaving}
                error={editorError}
                savedAtMs={activeFile.savedAtMs}
                missing={activeFile.missing}
                viewMode={editorViewMode}
                onSetViewMode={setEditorViewMode}
                onChange={(next) => updateActiveFile({ content: next })}
                onSave={() => {
                  void saveOpenFile();
                }}
                onDiscard={discardOpenFile}
                onClose={attemptCloseEditor}
                onOpenWikilink={onOpenWikilink}
              />
            </div>
          )}
        </main>

        <ShellFiles
          files={filePaths}
          activeFilePath={activeFile?.path ?? null}
          openError={openError}
          width={filesWidth}
          onResize={setFilesWidth}
          onOpenFile={attemptOpenFile}
          onNewFile={attemptNewFile}
        />
      </div>

      <ShellStatusBar
        runningCount={runStatusInfo.runningCount}
        runningTitle={
          runStatusInfo.runningSkill ?? runStatusInfo.runningProject
        }
        totalChats={savedSessionCount}
        errorCount={diagErrors}
        warningCount={diagWarnings}
        watchingCount={result.markdownFiles.length}
        fileMode={activeFile ? "md · gfm" : null}
        theme={theme}
        onToggleTheme={() =>
          setTheme((t) => (t === "graphite" ? "porcelain" : "graphite"))
        }
        onOpenAgent={() => setActivePanel("agent")}
        onOpenDiagnostics={() => setActivePanel("diag")}
      />

      {paletteOpen && (
        <ShellPalette
          files={filePaths}
          commands={paletteCommands}
          onOpenFile={attemptOpenFile}
          onClose={() => setPaletteOpen(false)}
        />
      )}

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
                Also creates any missing canonical directories (no-op if
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
