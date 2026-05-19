import { type ReactNode } from "react";

interface TooltipProps {
  /** The popover content. Strings render with `white-space: pre-line`
   *  so `\n` produces line breaks; pass JSX for richer formatting. */
  content: ReactNode;
  /** The trigger — whatever the user hovers / focuses to reveal the
   *  tooltip. The wrapping span gets `cursor: help`. */
  children: ReactNode;
  /** Vertical placement of the popover relative to the trigger.
   *  `top` for triggers near the bottom of the viewport (so the
   *  popover floats up and stays visible); `bottom` for triggers near
   *  the top (the default). */
  placement?: "top" | "bottom";
  /** Horizontal alignment of the popover's edge. `center` (default)
   *  centers on the trigger; `start` left-aligns; `end` right-aligns —
   *  useful when the trigger sits near the right edge of the viewport
   *  and a centered popover would overflow. */
  align?: "start" | "center" | "end";
  /** Extra class on the wrapping host span. */
  className?: string;
  /** Optional aria-label on the wrapping span. Defaults to the
   *  stringified `content` if it's a primitive. */
  ariaLabel?: string;
}

/**
 * Hover / focus tooltip that doesn't rely on the browser's native
 * `title` attribute.
 *
 * Tauri's WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK
 * on Linux) renders native `title` tooltips inconsistently —
 * particularly for multiline content and on focus. This component
 * provides a CSS-only popover that works the same everywhere, uses
 * the app's styling tokens, and supports keyboard focus for a11y.
 *
 * Implementation: positioned absolute child revealed by sibling
 * `:hover` / `:focus-within`. No JS positioning logic — just a few
 * placement modifiers. Pointer-events on the popover are disabled so
 * hover doesn't get sticky if the user mouses over the popover itself.
 */
export function Tooltip({
  content,
  children,
  placement = "bottom",
  align = "center",
  className,
  ariaLabel,
}: TooltipProps) {
  const labelFallback =
    typeof content === "string" || typeof content === "number"
      ? String(content)
      : undefined;
  return (
    <span
      className={
        "tooltip-host tooltip-host--" +
        placement +
        " tooltip-host--align-" +
        align +
        (className ? " " + className : "")
      }
      tabIndex={0}
      aria-label={ariaLabel ?? labelFallback}
    >
      {children}
      <span className="tooltip-pop" role="tooltip">
        {content}
      </span>
    </span>
  );
}
