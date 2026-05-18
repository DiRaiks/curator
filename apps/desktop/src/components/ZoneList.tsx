import type { Scope, Zone } from "../types";

const SCOPE_LABEL: Record<Scope, string> = {
  project: "project",
  meta: "meta",
  "personal-work": "personal-work",
  "team-management": "team-management",
  inbox: "inbox",
  resource: "resource",
  archive: "archive",
  unknown: "unknown",
};

// Scopes surfaced in the privacy summary card (excluded from project
// workflows by default). `archive` and `resource` are technically also
// excluded but are less sensitive — keep the summary focused on what the
// user is most worried about leaking.
const SUMMARY_SCOPES: Scope[] = [
  "personal-work",
  "team-management",
  "inbox",
];

interface ZoneListProps {
  zones: Zone[];
}

interface ScopeStats {
  scope: Scope;
  fileCount: number;
  zoneCount: number;
}

function summarize(zones: Zone[]): ScopeStats[] {
  const acc = new Map<Scope, ScopeStats>();
  for (const z of zones) {
    const existing = acc.get(z.scope);
    if (existing) {
      existing.fileCount += z.fileCount;
      existing.zoneCount += 1;
    } else {
      acc.set(z.scope, {
        scope: z.scope,
        fileCount: z.fileCount,
        zoneCount: 1,
      });
    }
  }
  return SUMMARY_SCOPES.flatMap((s) => {
    const stats = acc.get(s);
    return stats ? [stats] : [];
  });
}

export function ZoneList({ zones }: ZoneListProps) {
  if (zones.length === 0) {
    return (
      <p className="empty">
        No private or team-management zones detected. Project workflows are
        free to use all indexed files (subject to their own scope).
      </p>
    );
  }

  const summary = summarize(zones);

  return (
    <>
      <p className="zones__hint">
        Zones below are <strong>excluded from project workflows by default</strong>
        — including <code>personal-work</code>, <code>team-management</code>,
        <code>inbox</code>, <code>resource</code>, and <code>archive</code>.
        No content from these files will be prepared for AI context unless you
        explicitly opt in per file in a future slice.
      </p>

      {summary.length > 0 && (
        <ul className="zone-summary" aria-label="Private zones at a glance">
          {summary.map((s) => (
            <li
              key={s.scope}
              className={"zone-summary__item zone-summary__item--" + s.scope}
            >
              <span className={"scope scope--" + s.scope}>
                {SCOPE_LABEL[s.scope]}
              </span>
              <span className="zone-summary__count">{s.fileCount} files</span>
              <span className="zone-summary__zones">
                in {s.zoneCount} zone{s.zoneCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ul className="list">
        {zones.map((z) => (
          <li key={z.path} className="list__item">
            <div className="list__primary">
              <span className={"scope scope--" + z.scope}>
                {SCOPE_LABEL[z.scope]}
              </span>
              <span className="list__path">{z.path}</span>
              <span className="tag">{z.fileCount} files</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
