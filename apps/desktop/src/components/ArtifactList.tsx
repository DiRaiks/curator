import { useMemo, useState } from "react";
import type { ArtifactKind, WorkflowArtifact } from "../types";

const KIND_ORDER: ArtifactKind[] = [
  "agent-prompt",
  "claude-command",
  "claude-agent",
  "claude-skill",
  "claude-rule",
  "vault-skill",
];

const KIND_LABEL: Record<ArtifactKind, string> = {
  "agent-prompt": "Agent Prompts",
  "claude-command": "Claude Commands",
  "claude-agent": "Claude Agents",
  "claude-skill": "Claude Skills",
  "claude-rule": "Claude Rules",
  "vault-skill": "Vault Skills",
};

const KIND_HINT: Record<ArtifactKind, string> = {
  "agent-prompt":
    "Numbered prompts that populate a project KB. Currently the only runnable kind.",
  "claude-command":
    "Slash commands for Claude Code (reference-only here — execution requires a sandboxed CLI runner).",
  "claude-agent":
    "Sub-agent definitions. Tool whitelist is security-relevant — review before running.",
  "claude-skill": "Claude skill packages (SKILL.md).",
  "claude-rule":
    "Policy / rule artifacts — paths globs tell Claude Code when to auto-load.",
  "vault-skill":
    "Forward-looking skill shape under `.vault/skills/`. Not yet runnable.",
};

interface ArtifactListProps {
  artifacts: WorkflowArtifact[];
}

export function ArtifactList({ artifacts }: ArtifactListProps) {
  const grouped = useMemo(() => groupByKind(artifacts), [artifacts]);
  const totalsByKind = useMemo(() => {
    const acc = {} as Record<ArtifactKind, number>;
    for (const k of KIND_ORDER) acc[k] = 0;
    for (const a of artifacts) acc[a.kind] += 1;
    return acc;
  }, [artifacts]);

  const [filter, setFilter] = useState<ArtifactKind | null>(null);

  if (artifacts.length === 0) {
    return (
      <p className="empty">
        No workflow artifacts detected (agent-prompts, claude-skills, agents,
        commands, rules, or vault-skills).
      </p>
    );
  }

  const visibleKinds = filter
    ? KIND_ORDER.filter((k) => k === filter)
    : KIND_ORDER.filter((k) => totalsByKind[k] > 0);

  return (
    <>
      <FilterChips
        totalsByKind={totalsByKind}
        active={filter}
        onSelect={setFilter}
        total={artifacts.length}
      />
      {visibleKinds.map((kind) => (
        <KindGroup
          key={kind}
          kind={kind}
          artifacts={grouped[kind] || []}
          count={totalsByKind[kind]}
        />
      ))}
    </>
  );
}

// ---------- Filter chips ----------

interface FilterChipsProps {
  totalsByKind: Record<ArtifactKind, number>;
  active: ArtifactKind | null;
  onSelect: (k: ArtifactKind | null) => void;
  total: number;
}

function FilterChips({ totalsByKind, active, onSelect, total }: FilterChipsProps) {
  return (
    <div
      className="filter-chips"
      role="toolbar"
      aria-label="Filter artifacts by kind"
    >
      <button
        type="button"
        className={"chip " + (active === null ? "chip--active" : "")}
        onClick={() => onSelect(null)}
        aria-pressed={active === null}
      >
        All <span className="chip__count">{total}</span>
      </button>
      {KIND_ORDER.map((k) => {
        const n = totalsByKind[k];
        if (n === 0) return null;
        const isActive = active === k;
        return (
          <button
            key={k}
            type="button"
            className={"chip chip--" + k + (isActive ? " chip--active" : "")}
            onClick={() => onSelect(isActive ? null : k)}
            aria-pressed={isActive}
          >
            {KIND_LABEL[k]} <span className="chip__count">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- Per-kind group ----------

interface KindGroupProps {
  kind: ArtifactKind;
  artifacts: WorkflowArtifact[];
  count: number;
}

function KindGroup({ kind, artifacts, count }: KindGroupProps) {
  if (artifacts.length === 0) {
    return null;
  }
  return (
    <section className="kind-group" aria-labelledby={"kind-" + kind}>
      <header className="kind-group__header">
        <h3 id={"kind-" + kind} className="kind-group__title">
          <span className={"kind kind--" + kind}>{kind}</span>
          {KIND_LABEL[kind]}
          <span className="kind-group__count">{count}</span>
        </h3>
        <p className="kind-group__hint">{KIND_HINT[kind]}</p>
      </header>
      <ul className="list">
        {artifacts.map((a) => (
          <ArtifactItem key={a.kind + "|" + a.id + "|" + a.path} artifact={a} />
        ))}
      </ul>
    </section>
  );
}

// ---------- Item ----------

interface ArtifactItemProps {
  artifact: WorkflowArtifact;
}

function ArtifactItem({ artifact: a }: ArtifactItemProps) {
  return (
    <li className="list__item">
      <div className="list__primary">
        <span
          className={"tag " + (a.runnable ? "tag--runnable" : "tag--ref")}
          title={
            a.runnable
              ? "Eligible for AI runner execution (no runner is implemented yet)"
              : "Reference-only — not runnable in this build"
          }
        >
          {a.runnable ? "runnable" : "reference-only"}
        </span>
        <span className="list__id">{a.id}</span>
        {a.title && a.title !== a.id && (
          <span className="list__title">{a.title}</span>
        )}
      </div>
      <ArtifactSecondary artifact={a} />
    </li>
  );
}

function ArtifactSecondary({ artifact: a }: ArtifactItemProps) {
  switch (a.kind) {
    case "agent-prompt":
      return (
        <div className="list__secondary">
          {a.order != null && <span className="tag">order {a.order}</span>}
          {a.outputFile && (
            <span className="tag tag--output" title={a.outputFile}>
              → {a.outputFile}
            </span>
          )}
          <span className="list__path">{a.path}</span>
        </div>
      );

    case "claude-command":
      return (
        <div className="list__secondary list__secondary--stacked">
          {a.description && (
            <span className="list__description">{a.description}</span>
          )}
          <span className="list__path">{a.path}</span>
        </div>
      );

    case "claude-agent":
      return (
        <div className="list__secondary list__secondary--stacked">
          {a.model && (
            <span className="tag" title="Model hint from frontmatter">
              model: {a.model}
            </span>
          )}
          {a.tools && a.tools.length > 0 && (
            <div
              className="tools"
              title="Tool whitelist — security-relevant"
              aria-label="Tools"
            >
              <span className="tools__label">tools</span>
              {a.tools.map((t) => (
                <span key={t} className="tag tag--tool">
                  {t}
                </span>
              ))}
            </div>
          )}
          {a.description && (
            <span className="list__description">{a.description}</span>
          )}
          <span className="list__path">{a.path}</span>
        </div>
      );

    case "claude-skill":
      return (
        <div className="list__secondary list__secondary--stacked">
          {a.description && (
            <span className="list__description">{a.description}</span>
          )}
          <span className="list__path">{a.path}</span>
        </div>
      );

    case "claude-rule":
      return (
        <div className="list__secondary list__secondary--stacked">
          {a.paths && a.paths.length > 0 ? (
            <div className="tools" aria-label="Path globs">
              <span className="tools__label">paths</span>
              {a.paths.map((p) => (
                <span key={p} className="tag tag--glob">
                  {p}
                </span>
              ))}
            </div>
          ) : (
            <span className="empty">No `paths` declared in frontmatter.</span>
          )}
          <span className="list__path">{a.path}</span>
        </div>
      );

    case "vault-skill":
      return (
        <div className="list__secondary">
          {a.version && <span className="tag">v{a.version}</span>}
          {a.status && <span className="tag">{a.status}</span>}
          {a.order != null && <span className="tag">order {a.order}</span>}
          {a.outputFile && (
            <span className="tag tag--output" title={a.outputFile}>
              → {a.outputFile}
            </span>
          )}
          <span className="list__path">{a.path}</span>
        </div>
      );
  }
}

// ---------- Helpers ----------

function groupByKind(
  artifacts: WorkflowArtifact[],
): Partial<Record<ArtifactKind, WorkflowArtifact[]>> {
  const acc: Partial<Record<ArtifactKind, WorkflowArtifact[]>> = {};
  for (const a of artifacts) {
    (acc[a.kind] ||= []).push(a);
  }
  return acc;
}
