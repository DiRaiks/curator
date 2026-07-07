import { useEffect, useMemo, useState } from "react";
import { listSessions, previewContext } from "../api";
import type {
  ContextPreview,
  Project,
  SourceRepoInspection,
  WorkflowArtifact,
} from "../types";
import { ContextPreviewPanel } from "./ContextPreview";

/**
 * Per-artifact run counts derived from session history. Two shapes of
 * saved sessions count as "a run of artifact X":
 *  - direct artifact runs — `promptId === X`;
 *  - staged runs — spawned as freeform (`promptId: "chat"`) but titled
 *    `"<project>/<X>"` at stage time.
 * `null` until the first fetch resolves; best-effort (a failed fetch
 * just hides the counter).
 */
export function useArtifactRunCounts(
  vaultRoot: string,
): ReadonlyMap<string, number> | null {
  const [counts, setCounts] = useState<ReadonlyMap<string, number> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    void listSessions(vaultRoot, true)
      .then((sessions) => {
        if (cancelled) return;
        const m = new Map<string, number>();
        for (const s of sessions) {
          const key =
            s.promptId !== "chat"
              ? s.promptId
              : s.title.includes("/")
                ? s.title.slice(s.title.lastIndexOf("/") + 1)
                : null;
          if (key) m.set(key, (m.get(key) ?? 0) + 1);
        }
        setCounts(m);
      })
      .catch(() => {
        if (!cancelled) setCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultRoot]);
  return counts;
}

interface ArtifactRunPanelProps {
  artifact: WorkflowArtifact;
  vaultRoot: string;
  homeDir: string | null;
  /** Projects eligible as a run target (used by the select). Ignored
   *  when `fixedProjectSlug` is set. */
  projects: Project[];
  /** ProjectDetail mode: the run target is the page's project — no
   *  select is rendered. */
  fixedProjectSlug?: string;
  /** Pre-selected project for the select (browser mode). Falls back
   *  to the first project. */
  defaultProjectSlug?: string | null;
  /** Times this artifact ran, from session history. `null` = unknown. */
  runsCount: number | null;
  /** promptId of a currently-running chat (vault-wide aggregate) —
   *  drives the live chip when it matches this artifact. */
  runningSkill: string | null;
  onStagePrompt: (args: {
    text: string;
    projectSlug: string;
    promptId: string;
  }) => string | null;
  onOpenFile: (path: string) => void;
  onOpenAgent: () => void;
  onCreateAndOpenFile?: (relativePath: string) => Promise<void>;
  /** Source-repo inspection when the host already has it (ProjectDetail). */
  sourceRepoInspection?: SourceRepoInspection | null;
}

/**
 * In-place expansion body for an artifact card ("accordion" fix): the
 * run action lives next to the card instead of a preview section far
 * below the list.
 *
 *   run on [project ▾]  [▶ run…]  [open]  runs · N   (● running…)
 *   N files in context · ⚠ M warnings        [run plan ▸]
 *
 * "▶ run…" STAGES the materialized prompt into the agent composer
 * (review → Send) — it deliberately does not spawn the runner
 * directly; the staged human-in-the-loop flow is the product's safety
 * model. The full run plan (ContextPreviewPanel) unfolds inside the
 * card on demand.
 */
export function ArtifactRunPanel({
  artifact,
  vaultRoot,
  homeDir,
  projects,
  fixedProjectSlug,
  defaultProjectSlug,
  runsCount,
  runningSkill,
  onStagePrompt,
  onOpenFile,
  onOpenAgent,
  onCreateAndOpenFile,
  sourceRepoInspection,
}: ArtifactRunPanelProps) {
  const [selectedSlug, setSelectedSlug] = useState<string>(
    () =>
      fixedProjectSlug ??
      defaultProjectSlug ??
      projects[0]?.slug ??
      "",
  );
  const targetSlug = fixedProjectSlug ?? selectedSlug;

  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  useEffect(() => {
    if (!targetSlug) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    previewContext(vaultRoot, targetSlug, artifact.id)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultRoot, targetSlug, artifact.id]);

  const warningsCount = preview?.warnings.length ?? 0;
  const isRunning = runningSkill === artifact.id;

  const summary = useMemo(() => {
    if (previewLoading && !preview) return "computing run plan…";
    if (previewError) return null;
    if (!preview) return null;
    const parts = [`${preview.included.length} files in context`];
    if (warningsCount > 0) parts.push(`⚠ ${warningsCount} warnings`);
    return parts.join(" · ");
  }, [preview, previewLoading, previewError, warningsCount]);

  const onRun = () => {
    if (!preview) return;
    setStageError(null);
    const err = onStagePrompt({
      text: preview.externalRunnerPrompt,
      projectSlug: targetSlug,
      promptId: artifact.id,
    });
    if (err) setStageError(err);
  };

  return (
    <div className="arun">
      <div className="arun__row">
        {!fixedProjectSlug &&
          (projects.length > 0 ? (
            <label className="arun__on">
              run on
              <select
                className="arun__select"
                value={selectedSlug}
                onChange={(e) => setSelectedSlug(e.target.value)}
                aria-label="Project to run on"
              >
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="arun__on">no projects to run on</span>
          ))}
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={!preview || !targetSlug}
          onClick={onRun}
          title="Stage the materialized prompt into the agent composer — review, then Send"
        >
          ▶ run…
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => onOpenFile(artifact.path)}
          title={artifact.path}
        >
          open
        </button>
        {runsCount !== null && (
          <span className="arun__meta">runs · {runsCount}</span>
        )}
        <span className="arun__grow" />
        {isRunning && (
          <button
            type="button"
            className="arun__running"
            onClick={onOpenAgent}
            title="A chat is executing this artifact — open the agent panel"
          >
            <span className="arun__running-dot" aria-hidden="true" />
            running
            <span className="arun__running-open">open in Agent →</span>
          </button>
        )}
      </div>

      {stageError && (
        <p className="arun__error" role="alert">
          {stageError}
        </p>
      )}
      {previewError && (
        <p className="arun__error" role="alert">
          run plan failed: {previewError}
        </p>
      )}

      {summary && (
        <div className="arun__summary-row">
          <span
            className={
              "arun__meta" + (warningsCount > 0 ? " arun__meta--warn" : "")
            }
          >
            {summary}
          </span>
          {preview && (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setPlanOpen((o) => !o)}
              aria-expanded={planOpen}
            >
              {planOpen ? "hide run plan" : "run plan ▸"}
            </button>
          )}
        </div>
      )}

      {planOpen && preview && (
        <div className="arun__plan">
          <ContextPreviewPanel
            preview={preview}
            homeDir={homeDir}
            isRefreshing={previewLoading}
            onCreateAndOpenFile={onCreateAndOpenFile}
            sourceRepoInspection={sourceRepoInspection ?? null}
            onStagePrompt={onStagePrompt}
          />
        </div>
      )}
    </div>
  );
}
