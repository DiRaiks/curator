import { useState } from "react";
import { scanProjectVulnerabilities } from "../../api";
import type { Advisory, Project, ProjectVulnerabilityScan } from "../../types";
import { Dot, PanelHead } from "./LeftPanel";

interface PanelCveProps {
  projects: Project[];
}

type ScanState =
  | { kind: "results"; scan: ProjectVulnerabilityScan; atMs: number }
  | { kind: "error"; message: string };

/**
 * Manual, per-project CVE scan against OSV.dev. Results are cached
 * per project slug for the lifetime of the panel session — the scan
 * only runs when the user presses the button (network call).
 */
export function PanelCve({ projects }: PanelCveProps) {
  const [slug, setSlug] = useState<string>(projects[0]?.slug ?? "");
  const [scanning, setScanning] = useState(false);
  const [bySlug, setBySlug] = useState<Record<string, ScanState>>({});

  const project = projects.find((p) => p.slug === slug) ?? null;
  const state: ScanState | null = bySlug[slug] ?? null;

  const runScan = async () => {
    if (!project?.localPath || scanning) return;
    const target = project.slug;
    setScanning(true);
    try {
      const scan = await scanProjectVulnerabilities(project.localPath);
      setBySlug((prev) => ({
        ...prev,
        [target]: { kind: "results", scan, atMs: Date.now() },
      }));
    } catch (err: unknown) {
      setBySlug((prev) => ({
        ...prev,
        [target]: {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="ide-panel" aria-label="CVE Scan">
      <PanelHead title="CVE Scan" count="osv.dev" />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "9px 12px",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <select
          className="ide-select"
          style={{ flex: 1 }}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          aria-label="Project to scan"
        >
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.slug}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ide-btn primary sm"
          style={{ height: 24 }}
          disabled={scanning || !project?.localPath}
          onClick={() => void runScan()}
        >
          {scanning ? "scanning…" : "scan"}
        </button>
      </div>

      <div className="ide-panel-body">
        {projects.length === 0 ? (
          <p className="ide-panel-hint">No projects to scan.</p>
        ) : !project?.localPath ? (
          <p className="ide-panel-hint">
            <code>{slug}</code> declares no <code>local_path</code> — nothing
            to scan. Set it in the project's <code>_index.md</code> (or{" "}
            <code>_local.md</code>).
          </p>
        ) : scanning ? (
          <div
            style={{
              padding: 14,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--muted)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Dot kind="run" /> parsing lock files · querying osv.dev…
          </div>
        ) : state === null ? (
          <p className="ide-panel-hint">Not scanned yet — press scan.</p>
        ) : state.kind === "error" ? (
          <ErrorState message={state.message} />
        ) : (
          <Results scan={state.scan} atMs={state.atMs} />
        )}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const noLockFiles = /no lock files/i.test(message);
  return (
    <div className="ide-panel-hint" style={{ color: "var(--fg-2)" }}>
      <div
        style={{
          color: "var(--warn)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: ".05em",
          marginBottom: 4,
        }}
      >
        {noLockFiles ? "no lock files" : "scan failed"}
      </div>
      {noLockFiles ? (
        <>
          No <code>yarn.lock</code> / <code>package-lock.json</code> found in
          the project's <code>local_path</code>.
        </>
      ) : (
        message
      )}
    </div>
  );
}

function Results({
  scan,
  atMs,
}: {
  scan: ProjectVulnerabilityScan;
  atMs: number;
}) {
  return (
    <>
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--muted)",
          lineHeight: 1.6,
        }}
      >
        {scan.lockFilesScanned.join(", ")} · {scan.packagesScanned} packages ·{" "}
        {fmtAgo(atMs)}
        {scan.warnings.map((w, i) => (
          <div key={i} style={{ color: "var(--warn)" }}>
            ⚠ {w}
          </div>
        ))}
      </div>
      {scan.advisories.length === 0 ? (
        <div
          style={{
            padding: 14,
            fontSize: 11.5,
            color: "var(--ok)",
            fontFamily: "var(--mono)",
          }}
        >
          ✓ 0 advisories
        </div>
      ) : (
        scan.advisories.map((a, i) => <AdvisoryRow key={a.osvId + i} adv={a} />)
      )}
    </>
  );
}

function AdvisoryRow({ adv }: { adv: Advisory }) {
  const { tone, label, score } = severityOf(adv.severity);
  const fix = adv.fixedVersions[0];
  return (
    <div className="ide-row card" style={{ cursor: "default" }}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 3,
        }}
      >
        <span
          className={"ide-pill " + tone}
          style={{ height: 15, fontSize: 9 }}
        >
          {label}
          {score != null ? ` ${score.toFixed(1)}` : ""}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            color: "var(--muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {adv.osvId}
        </span>
      </span>
      <span
        style={{
          display: "block",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--fg)",
          marginBottom: 2,
        }}
      >
        {adv.package.name}@{adv.package.version}
      </span>
      <span
        style={{
          display: "block",
          fontSize: 11.5,
          color: "var(--fg-2)",
          lineHeight: 1.4,
          marginBottom: 3,
          textWrap: "pretty",
          whiteSpace: "normal",
        }}
      >
        {adv.summary}
      </span>
      <span
        style={{
          display: "flex",
          gap: 6,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--muted)",
        }}
      >
        {fix && <span style={{ color: "var(--ok)" }}>fix: {fix}</span>}
        {fix && <span>·</span>}
        <span>{adv.package.sourceLockFile}</span>
      </span>
    </div>
  );
}

/** CVSS bucket per the design contract: ≥7 HIGH (err) / ≥4 MED (warn)
 *  / LOW. The OSV `severity` field is a best-effort label like
 *  `CVSS_V3 7.5`; when no score is parseable we fall back to keyword
 *  matching, and to LOW when even that fails. */
function severityOf(raw: string | null): {
  tone: "err" | "warn" | "";
  label: string;
  score: number | null;
} {
  const match = raw?.match(/(\d+(?:\.\d+)?)/);
  const score = match ? parseFloat(match[1]) : null;
  if (score != null && !Number.isNaN(score)) {
    if (score >= 7) return { tone: "err", label: "HIGH", score };
    if (score >= 4) return { tone: "warn", label: "MED", score };
    return { tone: "", label: "LOW", score };
  }
  const lower = raw?.toLowerCase() ?? "";
  if (lower.includes("critical") || lower.includes("high"))
    return { tone: "err", label: "HIGH", score: null };
  if (lower.includes("medium") || lower.includes("moderate"))
    return { tone: "warn", label: "MED", score: null };
  return { tone: "", label: "LOW", score: null };
}

function fmtAgo(atMs: number): string {
  const sec = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
