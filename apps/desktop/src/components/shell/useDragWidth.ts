import { useCallback, useRef } from "react";

interface DragWidthArgs {
  width: number;
  min: number;
  max: number;
  /** True when the handle sits on the panel's LEFT edge — dragging
   *  left then grows the panel (right-docked Files). Default: handle
   *  on the right edge of a left-docked panel. */
  invert?: boolean;
  onChange: (width: number) => void;
}

/**
 * Pointer-drag horizontal resize for the shell's side panels. Returns
 * a `pointerdown` handler for the 5px grab strip; document-level
 * move/up listeners keep the drag alive when the cursor leaves the
 * strip. A body class pins the col-resize cursor + kills text
 * selection for the drag's duration.
 */
export function useDragWidth(args: DragWidthArgs) {
  // Read through a ref so the returned handler stays identity-stable
  // while width/min/max change between renders.
  const argsRef = useRef(args);
  argsRef.current = args;

  return useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = argsRef.current.width;

    const onMove = (ev: PointerEvent) => {
      const { min, max, invert, onChange } = argsRef.current;
      const dx = ev.clientX - startX;
      const next = Math.min(max, Math.max(min, startW + (invert ? -dx : dx)));
      onChange(next);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-col-resizing");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.classList.add("is-col-resizing");
  }, []);
}
