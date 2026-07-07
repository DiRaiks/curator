/** Names of the inline stroke icons the shell chrome uses. Kept as a
 *  union (not string) so a rail item can't reference an icon that
 *  doesn't exist. */
export type ShellIconName =
  | "projects"
  | "search"
  | "git"
  | "skills"
  | "drafts"
  | "cve"
  | "diag"
  | "history"
  | "settings"
  | "agent"
  | "folder"
  | "md"
  | "chevr"
  | "close"
  | "menu"
  | "plus"
  | "attach"
  | "collapse"
  | "refresh";

interface ShellIconProps {
  name: ShellIconName;
  size?: number;
  stroke?: number;
}

/**
 * Line icons for the shell v2 chrome (VSCode/Zed style, 24×24 stroke,
 * round caps). Ported from `design/design_handoff_shell_v2/shell-icons.jsx`.
 */
export function ShellIcon({ name, size = 21, stroke = 1.6 }: ShellIconProps) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "projects":
      return (
        <svg {...p}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      );
    case "git":
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="2.4" />
          <circle cx="6" cy="18" r="2.4" />
          <circle cx="18" cy="9" r="2.4" />
          <path d="M6 8.5v7M18 11.4c0 3-3 3.6-6 3.6" />
        </svg>
      );
    case "skills":
      return (
        <svg {...p}>
          <path d="m12 3 2.1 5.2L19.5 9l-4 3.6 1.2 5.6L12 15.6 7.3 18.2l1.2-5.6-4-3.6 5.4-.8z" />
        </svg>
      );
    case "drafts":
      return (
        <svg {...p}>
          <path d="M4 5h16v11H15l-3 3-3-3H4z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
      );
    case "cve":
      return (
        <svg {...p}>
          <circle cx="12" cy="13.5" r="4.5" />
          <path d="M9.8 9.5 8 7M14.2 9.5 16 7M7.5 12H4.5M7.5 15.5H5M16.5 12h3M16.5 15.5h2.5M12 9v9" />
        </svg>
      );
    case "diag":
      return (
        <svg {...p}>
          <path d="M12 4 3 19h18z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
      );
    case "history":
      return (
        <svg {...p}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 4v4h4M12 8v4l3 2" />
        </svg>
      );
    case "settings":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
        </svg>
      );
    case "agent":
      return (
        <svg {...p}>
          <rect x="4" y="6" width="16" height="12" rx="2.5" />
          <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
          <path d="M12 3v3" />
        </svg>
      );
    case "folder":
      return (
        <svg {...p} strokeWidth={1.5}>
          <path d="M3 7a1 1 0 0 1 1-1h4l1.5 1.5H20a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
        </svg>
      );
    case "md":
      return (
        <svg {...p} strokeWidth={1.5}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path
            d="M7 15V9l2.5 3L12 9v6M15.5 9v6M15.5 15l2-2M15.5 15l-2-2"
            strokeWidth={1.3}
          />
        </svg>
      );
    case "chevr":
      return (
        <svg {...p} strokeWidth={1.8}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "close":
      return (
        <svg {...p} strokeWidth={1.8}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case "menu":
      return (
        <svg {...p} strokeWidth={1.8}>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      );
    case "plus":
      return (
        <svg {...p} strokeWidth={1.8}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "attach":
      return (
        <svg {...p} strokeWidth={1.5}>
          <path d="M18 8.5 9.5 17a3 3 0 0 1-4.2-4.2l8-8a2 2 0 0 1 2.8 2.8l-7.6 7.6" />
        </svg>
      );
    case "collapse":
      return (
        <svg {...p} strokeWidth={1.8}>
          <path d="M15 6 9 12l6 6" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...p} strokeWidth={1.8}>
          <path d="M20 12a8 8 0 1 1-2.3-5.6L20 8" />
          <path d="M20 3v5h-5" />
        </svg>
      );
  }
}
