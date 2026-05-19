import { useCallback, useMemo, useState } from "react";

import { scanProjectVulnerabilities } from "../api";
import type {
  Advisory,
  Project,
  ProjectVulnerabilityScan,
} from "../types";

interface SecurityPanelProps {
  projects: Project[];
}

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "done"; scan: ProjectVulnerabilityScan }
  | { kind: "error"; error: string };

type Severity = "critical" | "high" | "medium" | "low" | "none";

/** Severities listed in display + sort order — worst first. */
const SEVERITY_ORDER: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "none",
] as const;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  none: "unrated",
};

/**
 * Per-project CVE scanner. Lists every project that declares a
 * `localPath` (without one we have nothing to scan), exposes a per-row
 * Scan button, and a top-level "Scan all" that fans out sequentially.
 *
 * Scans are NOT triggered on mount — each one is a network call to
 * OSV.dev and we'd rather the user opt in. Results live in component
 * state; navigating away discards them. Slice 2 will persist results +
 * trigger periodic background scans + diff old/new findings.
 */
export function SecurityPanel({ projects }: SecurityPanelProps) {
  const scannable = useMemo(
    () => projects.filter((p) => p.localPath != null),
    [projects],
  );
  const [states, setStates] = useState<Record<string, ScanState>>({});
  const [bulkRunning, setBulkRunning] = useState(false);

  const scanOne = useCallback(async (project: Project) => {
    if (!project.localPath) return;
    setStates((s) => ({ ...s, [project.slug]: { kind: "scanning" } }));
    try {
      const scan = await scanProjectVulnerabilities(project.localPath);
      setStates((s) => ({ ...s, [project.slug]: { kind: "done", scan } }));
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setStates((s) => ({ ...s, [project.slug]: { kind: "error", error: text } }));
    }
  }, []);

  const scanAll = useCallback(async () => {
    if (bulkRunning) return;
    setBulkRunning(true);
    try {
      // Sequential rather than parallel — OSV is fine with throughput
      // but a single-threaded fan-out gives clearer per-row progress
      // and avoids rate-limit risk if a vault grows to dozens of repos.
      for (const p of scannable) {
        await scanOne(p);
      }
    } finally {
      setBulkRunning(false);
    }
  }, [scannable, scanOne, bulkRunning]);

  // Aggregate severity counts across every completed scan. Drives the
  // panel-level summary chips so the user can see "what's the worst
  // thing across all my projects" at a glance.
  const overallCounts = useMemo(() => {
    const counts: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      none: 0,
    };
    for (const s of Object.values(states)) {
      if (s.kind !== "done") continue;
      for (const a of s.scan.advisories) {
        counts[classifySeverity(a.severity)]++;
      }
    }
    return counts;
  }, [states]);

  const overallTotal =
    overallCounts.critical +
    overallCounts.high +
    overallCounts.medium +
    overallCounts.low +
    overallCounts.none;

  return (
    <div className="security-panel">
      <header className="security-panel__header">
        <div className="security-panel__title">
          <h2 className="panel__title">Security</h2>
          <p className="security-panel__hint">
            CVE check via OSV.dev. Reads <code>yarn.lock</code> and{" "}
            <code>package-lock.json</code> at each project's{" "}
            <code>local_path</code>.
          </p>
        </div>
        <div className="security-panel__actions">
          <button
            type="button"
            className="btn btn--small btn--primary"
            onClick={() => void scanAll()}
            disabled={bulkRunning || scannable.length === 0}
          >
            {bulkRunning ? (
              <>
                <Spinner />
                Scanning all…
              </>
            ) : (
              "Scan all"
            )}
          </button>
        </div>
      </header>

      {overallTotal > 0 && (
        <div className="severity-summary severity-summary--panel">
          <span className="severity-summary__label">Across all scans:</span>
          {SEVERITY_ORDER.map((sev) => (
            <SeverityChip
              key={sev}
              severity={sev}
              count={overallCounts[sev]}
              active={false}
              clickable={false}
            />
          ))}
        </div>
      )}

      {scannable.length === 0 ? (
        <p className="empty-state">
          No projects with a <code>local_path</code> set — add one in the
          project's <code>_index.md</code> frontmatter to enable CVE scans.
        </p>
      ) : (
        <ul className="security-panel__list">
          {scannable.map((p) => (
            <ProjectSecurityRow
              key={p.slug}
              project={p}
              state={states[p.slug] ?? { kind: "idle" }}
              onScan={() => void scanOne(p)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ProjectSecurityRowProps {
  project: Project;
  state: ScanState;
  onScan: () => void;
}

function ProjectSecurityRow({ project, state, onScan }: ProjectSecurityRowProps) {
  const scanning = state.kind === "scanning";
  return (
    <li className={"security-row" + (scanning ? " security-row--scanning" : "")}>
      <div className="security-row__header">
        <div className="security-row__title">
          <span className="security-row__name">{project.slug}</span>
          {project.localPath && (
            <span className="security-row__path" title={project.localPath}>
              {project.localPath}
            </span>
          )}
        </div>
        <div className="security-row__status">
          <ScanStatusLabel state={state} />
          <button
            type="button"
            className="btn btn--small"
            onClick={onScan}
            disabled={scanning}
          >
            {scanning ? (
              <>
                <Spinner />
                Scanning…
              </>
            ) : state.kind === "done" ? (
              "Re-scan"
            ) : (
              "Scan"
            )}
          </button>
        </div>
      </div>
      {scanning && (
        <div className="security-row__progress">
          <ProgressBar />
          <span className="security-row__progress-hint">
            Parsing lock files and querying OSV.dev — can take 5–30 s for
            large projects.
          </span>
        </div>
      )}
      {state.kind === "error" && (
        <p className="security-row__error" role="alert">
          {state.error}
        </p>
      )}
      {state.kind === "done" && <ScanResultBody scan={state.scan} />}
    </li>
  );
}

/** Small inline spinner (CSS keyframe). Used inside the Scan button so
 *  the click target itself shows the work-in-progress signal. */
function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** Indeterminate progress bar shown under the scanning row so the user
 *  has a visible "this is still working" cue even when their cursor
 *  isn't on the button. Independent of the system cursor — that one
 *  can flicker when the webview's IPC channel is busy. */
function ProgressBar() {
  return (
    <div className="progress-bar" role="progressbar" aria-label="Scanning">
      <div className="progress-bar__fill" />
    </div>
  );
}

function ScanStatusLabel({ state }: { state: ScanState }) {
  switch (state.kind) {
    case "idle":
      return <span className="security-row__status-text">never scanned</span>;
    case "scanning":
      return <span className="security-row__status-text">scanning…</span>;
    case "error":
      return (
        <span className="security-row__status-text security-row__status-text--err">
          error
        </span>
      );
    case "done": {
      const n = state.scan.advisories.length;
      const cls =
        n === 0
          ? "security-row__status-text security-row__status-text--ok"
          : "security-row__status-text security-row__status-text--warn";
      return (
        <span className={cls}>
          {state.scan.packagesScanned} packages · {n} advisor
          {n === 1 ? "y" : "ies"}
        </span>
      );
    }
  }
}

function ScanResultBody({ scan }: { scan: ProjectVulnerabilityScan }) {
  // Pre-compute the (severity, advisory) pairs once. We need the
  // classification both for the summary counts and for filtering /
  // sorting the list, so classifying every advisory eagerly avoids
  // re-doing the regex work in three places.
  const classified = useMemo(
    () =>
      scan.advisories.map((a) => ({
        advisory: a,
        severity: classifySeverity(a.severity),
      })),
    [scan.advisories],
  );

  // Count by severity for the summary chips.
  const counts = useMemo(() => {
    const c: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      none: 0,
    };
    for (const { severity } of classified) c[severity]++;
    return c;
  }, [classified]);

  /**
   * Severities the user has explicitly toggled OFF via the summary chip.
   * Default empty (everything visible). We model "hidden" instead of
   * "shown" so adding a new severity bucket later defaults to visible
   * rather than silently filtered out.
   */
  const [hidden, setHidden] = useState<Set<Severity>>(new Set());

  const toggleSeverity = useCallback((sev: Severity) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) {
        next.delete(sev);
      } else {
        next.add(sev);
      }
      return next;
    });
  }, []);

  // Sort by severity desc, then package name, then OSV id — same order
  // the backend already returns within a severity bucket, so the worst
  // findings bubble to the top.
  const visible = useMemo(() => {
    const filtered = classified.filter(({ severity }) => !hidden.has(severity));
    filtered.sort((a, b) => {
      const sa = severityRank(a.severity);
      const sb = severityRank(b.severity);
      if (sa !== sb) return sb - sa;
      const na = a.advisory.package.name.localeCompare(b.advisory.package.name);
      if (na !== 0) return na;
      return a.advisory.osvId.localeCompare(b.advisory.osvId);
    });
    return filtered;
  }, [classified, hidden]);

  return (
    <div className="security-row__body">
      <div className="security-row__meta">
        <span>
          Lock files: {scan.lockFilesScanned.join(", ") || "(none)"}
        </span>
      </div>
      {scan.warnings.length > 0 && (
        <ul className="security-row__warnings">
          {scan.warnings.map((w, i) => (
            <li key={i} className="security-row__warning">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
      {classified.length > 0 && (
        <div className="severity-summary">
          {SEVERITY_ORDER.map((sev) => (
            <SeverityChip
              key={sev}
              severity={sev}
              count={counts[sev]}
              active={!hidden.has(sev)}
              clickable
              onClick={() => toggleSeverity(sev)}
            />
          ))}
          {hidden.size > 0 && (
            <button
              type="button"
              className="severity-summary__clear"
              onClick={() => setHidden(new Set())}
            >
              Show all
            </button>
          )}
        </div>
      )}
      {classified.length === 0 ? (
        <p className="security-row__empty">No known advisories. ✓</p>
      ) : visible.length === 0 ? (
        <p className="security-row__empty">
          All {classified.length} advisor{classified.length === 1 ? "y" : "ies"}{" "}
          hidden by the filter. Click a chip to show them again.
        </p>
      ) : (
        <ul className="advisories">
          {visible.map(({ advisory, severity }, i) => (
            <AdvisoryItem
              key={`${advisory.osvId}:${advisory.package.name}:${i}`}
              advisory={advisory}
              severity={severity}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface SeverityChipProps {
  severity: Severity;
  count: number;
  /** Whether this severity's advisories are currently visible. Off chips
   *  render desaturated to signal they're filtered out. */
  active: boolean;
  /** Whether clicking toggles the filter. Panel-level summary chips are
   *  read-only (clickable=false) — filtering across all projects at once
   *  isn't a slice-1 feature. */
  clickable: boolean;
  onClick?: () => void;
}

function SeverityChip({
  severity,
  count,
  active,
  clickable,
  onClick,
}: SeverityChipProps) {
  const cls =
    `severity-chip severity-chip--${severity}` +
    (active ? "" : " severity-chip--off") +
    (clickable ? " severity-chip--clickable" : "");
  const label = `${count} ${SEVERITY_LABEL[severity]}`;
  const title = clickable
    ? active
      ? `Hide ${SEVERITY_LABEL[severity]} advisories`
      : `Show ${SEVERITY_LABEL[severity]} advisories`
    : undefined;

  if (!clickable) {
    return (
      <span className={cls} title={title}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

interface AdvisoryItemProps {
  advisory: Advisory;
  severity: Severity;
}

function AdvisoryItem({ advisory, severity }: AdvisoryItemProps) {
  return (
    <li className={"advisory advisory--" + severity}>
      <div className="advisory__content">
        <div className="advisory__head">
          <span className="advisory__pkg">
            {advisory.package.name}@{advisory.package.version}
          </span>
          <span className={"advisory__severity advisory__severity--" + severity}>
            {advisory.severity ?? "no severity"}
          </span>
          <span className="advisory__id">{advisory.osvId}</span>
        </div>
        <p className="advisory__summary">{advisory.summary || "(no summary)"}</p>
        {advisory.fixedVersions.length > 0 && (
          <p className="advisory__fix">
            <strong>Fixed in:</strong> {advisory.fixedVersions.join(", ")}
          </p>
        )}
        {advisory.references.length > 0 && (
          <ul className="advisory__refs">
            {advisory.references.slice(0, 3).map((url, i) => (
              <li key={i}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {hostnameOrUrl(url)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Bucket OSV severity strings into CSS-friendly classes. Falls back to
 * `none` when the upstream label is missing or unparseable. We extract
 * the leading numeric score from CVSS strings (`CVSS_V3 7.5`) since
 * that's what OSV emits today.
 */
function classifySeverity(raw: string | null): Severity {
  if (!raw) return "none";
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    const lower = raw.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";
    return "none";
  }
  const score = parseFloat(match[1]);
  if (Number.isNaN(score)) return "none";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  return "low";
}

function severityRank(sev: Severity): number {
  switch (sev) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "none":
      return 1;
  }
}

function hostnameOrUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
