import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/** Vertical side of the anchor the popover should sit on. Treated as
 *  a PREFERENCE: when that side has less than [`FLIP_THRESHOLD`] px
 *  free and the opposite side has more, the popover flips there. */
type Placement = "top" | "bottom";

/** Free space (px) below which the preferred side is considered
 *  cramped and the popover flips to the roomier side. */
const FLIP_THRESHOLD = 240;

/** Horizontal anchoring rule. `auto` picks the side that keeps the popover
 *  on-screen based on which viewport half the anchor center is in. */
type Align = "start" | "end" | "auto";

export interface PopoverPositionArgs {
  /** Element the popover is anchored to. The popover follows this ref's
   *  bounding box on resize / scroll / size changes. */
  anchorRef: RefObject<HTMLElement | null>;
  /** When `false`, the hook returns `{visibility: hidden}` and skips
   *  attaching listeners so it costs nothing while closed. */
  open: boolean;
  /** Side of the anchor the popover sits on. Default `bottom`. */
  placement?: Placement;
  /** Horizontal anchoring. Default `auto`. */
  align?: Align;
  /** Gap between anchor and popover edge, in CSS pixels. */
  offset?: number;
  /** Minimum margin from viewport edges, in CSS pixels. */
  inset?: number;
}

const HIDDEN_STYLE: CSSProperties = {
  position: "fixed",
  visibility: "hidden",
  top: 0,
  left: 0,
};

/**
 * Position a popover-style floating element next to a ref'd anchor,
 * keeping it inside the viewport (the flip + size behaviour of
 * floating-ui, without the dependency).
 *
 * Returns a `style` ready to spread on the popover element. Inline
 * `top` / `left` / `right` / `bottom` are computed against the live
 * viewport so the popover stays anchored while the user resizes the
 * window, scrolls a parent container, or the anchor itself shifts.
 *
 * Viewport fitting, without measuring the popover itself:
 *  - **flip** — `placement` is a preference; when that side has under
 *    [`FLIP_THRESHOLD`] px free and the opposite side has more, the
 *    popover opens on the roomier side (an anchor near the top of the
 *    window with `placement: "top"` opens downward instead of
 *    clipping off-screen).
 *  - **size** — the returned style carries `maxHeight` equal to the
 *    chosen side's free space (and `maxWidth` for the viewport), with
 *    `overflowY: auto`, so however tall the content is it scrolls
 *    instead of escaping the screen.
 *
 * `useLayoutEffect` + an initial `visibility: hidden` together prevent
 * the unpositioned-then-jump flicker: by the time the browser paints
 * the popover for the first time, the position has already been
 * computed and applied. Callers don't need to gate the popover render
 * separately.
 *
 * Listeners (resize, capture-phase scroll, ResizeObserver on the
 * anchor) only attach while `open` is `true`, so the closed-state cost
 * is one `setState`.
 */
export function usePopoverPosition(
  args: PopoverPositionArgs,
): CSSProperties {
  const {
    anchorRef,
    open,
    placement = "bottom",
    align = "auto",
    offset = 6,
    inset = 12,
  } = args;
  const [style, setStyle] = useState<CSSProperties>(HIDDEN_STYLE);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(HIDDEN_STYLE);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;

    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const next: CSSProperties = {
        position: "fixed",
        visibility: "visible",
      };

      // Vertical anchoring with flip: `placement` is a preference —
      // when its side is cramped and the other has more room, open on
      // the roomier side instead.
      const spaceAbove = rect.top - offset - inset;
      const spaceBelow = vh - rect.bottom - offset - inset;
      let side: Placement = placement;
      const preferredSpace = placement === "top" ? spaceAbove : spaceBelow;
      const otherSpace = placement === "top" ? spaceBelow : spaceAbove;
      if (preferredSpace < FLIP_THRESHOLD && otherSpace > preferredSpace) {
        side = placement === "top" ? "bottom" : "top";
      }

      // `side: "top"` means the popover sits ABOVE the anchor, so we
      // pin its bottom edge to the anchor's top edge (minus offset).
      if (side === "top") {
        next.bottom = Math.max(inset, vh - rect.top + offset);
        next.top = "auto";
        next.maxHeight = Math.max(120, spaceAbove);
      } else {
        next.top = Math.max(inset, rect.bottom + offset);
        next.bottom = "auto";
        next.maxHeight = Math.max(120, spaceBelow);
      }
      // However tall the content, it scrolls inside the free space
      // rather than escaping the viewport.
      next.overflowY = "auto";
      next.maxWidth = vw - inset * 2;

      // Horizontal anchoring. `auto` picks the side whose edge stays
      // closer to the viewport edge — left-half anchor → align start,
      // right-half anchor → align end. Inset clamps prevent the popover
      // from sticking to the very edge.
      let resolved: "start" | "end" =
        align === "end" ? "end" : align === "start" ? "start" : "start";
      if (align === "auto") {
        const center = rect.left + rect.width / 2;
        resolved = center > vw / 2 ? "end" : "start";
      }
      if (resolved === "end") {
        next.right = Math.max(inset, vw - rect.right);
        next.left = "auto";
      } else {
        next.left = Math.max(inset, rect.left);
        next.right = "auto";
      }

      setStyle(next);
    };

    compute();

    // Re-position on the three events that can move the anchor:
    //   - window resize (viewport reflow)
    //   - scroll inside ANY ancestor (capture phase catches nested scrolls)
    //   - the anchor's own size changing (e.g. label flipping between
    //     "Show 0 dismissed" and "Hide dismissed")
    const onWindow = () => compute();
    window.addEventListener("resize", onWindow);
    window.addEventListener("scroll", onWindow, true);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => compute());
      observer.observe(anchor);
    }

    return () => {
      window.removeEventListener("resize", onWindow);
      window.removeEventListener("scroll", onWindow, true);
      if (observer) observer.disconnect();
    };
  }, [open, anchorRef, placement, align, offset, inset]);

  return style;
}
