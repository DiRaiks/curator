import { ShellIcon, type ShellIconName } from "./ShellIcon";
import type { PanelId } from "./types";

interface RailProps {
  active: PanelId | null;
  /** Toggle-style pick: clicking the active icon closes the panel.
   *  The parent owns that rule; the rail just reports clicks. */
  onPick: (id: PanelId) => void;
  /** staged+unstaged file count in the vault repo; 0 hides the badge. */
  gitBadge: number;
  draftsBadge: number;
  /** Diagnostics errors — rendered red. */
  errorBadge: number;
  /** Any chat currently running → amber pulse dot on the agent icon. */
  agentRunning: boolean;
}

const TOP_ITEMS: { id: PanelId; icon: ShellIconName; title: string }[] = [
  { id: "projects", icon: "projects", title: "Projects" },
  { id: "search", icon: "search", title: "Search" },
  { id: "git", icon: "git", title: "Source Control" },
  { id: "skills", icon: "skills", title: "AI Artifacts" },
  { id: "drafts", icon: "drafts", title: "Drafts" },
  { id: "cve", icon: "cve", title: "CVE Scan" },
  { id: "diag", icon: "diag", title: "Diagnostics" },
];

/**
 * Activity rail (52px, full height, darkest surface). One icon per
 * functional surface; the agent + settings live in a bottom group.
 * Badges derive from live scan / git / run data passed by the parent —
 * never hardcoded (see README "State Management": every count shown in
 * two places must come from one source).
 */
export function Rail({
  active,
  onPick,
  gitBadge,
  draftsBadge,
  errorBadge,
  agentRunning,
}: RailProps) {
  const badgeFor = (id: PanelId): { value: number; tone?: "err" } | null => {
    if (id === "git" && gitBadge > 0) return { value: gitBadge };
    if (id === "drafts" && draftsBadge > 0) return { value: draftsBadge };
    if (id === "diag" && errorBadge > 0) return { value: errorBadge, tone: "err" };
    return null;
  };

  return (
    <nav className="ide-rail" aria-label="Activity rail">
      {TOP_ITEMS.map((it) => {
        const badge = badgeFor(it.id);
        return (
          <button
            key={it.id}
            type="button"
            className={"ide-rail-btn" + (active === it.id ? " active" : "")}
            onClick={() => onPick(it.id)}
            title={it.title}
            aria-label={it.title}
            aria-pressed={active === it.id}
          >
            <ShellIcon name={it.icon} />
            {badge && (
              <span className={"badge" + (badge.tone ? " " + badge.tone : "")}>
                {badge.value > 99 ? "99+" : badge.value}
              </span>
            )}
          </button>
        );
      })}
      <div className="grow" />
      <button
        type="button"
        className={"ide-rail-btn" + (active === "agent" ? " active" : "")}
        onClick={() => onPick("agent")}
        title="Agent (⌘J)"
        aria-label="Agent"
        aria-pressed={active === "agent"}
      >
        <ShellIcon name="agent" />
        {agentRunning && <span className="badge pulse" />}
      </button>
      <button
        type="button"
        className={"ide-rail-btn" + (active === "settings" ? " active" : "")}
        onClick={() => onPick("settings")}
        title="Settings"
        aria-label="Settings"
        aria-pressed={active === "settings"}
      >
        <ShellIcon name="settings" />
      </button>
    </nav>
  );
}
