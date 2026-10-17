import { useEffect, useRef, useState, type PointerEvent } from "react";

/**
 * A chart box's real pixel width, kept current with a ResizeObserver, so an SVG drawn at that
 * width keeps its text and bars at their size at any width instead of scaling with the viewBox.
 * Never under `min`, so a chart squeezed by its layout still has room for its axis.
 */
export function useChartWidth(initial = 560, min = 280) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(
      ([entry]) => entry && setWidth(Math.max(min, Math.round(entry.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, width] as const;
}

/** Where a pointer is across an SVG drawn `width` units wide, in those units. */
export function pointerX(e: PointerEvent<Element>, width: number): number {
  const r = e.currentTarget.getBoundingClientRect();
  return ((e.clientX - r.left) / Math.max(1, r.width)) * width;
}

/**
 * Pointer handlers that pick what is under the pointer as it moves, and on a tap, so a phone gets
 * the same readout a mouse does. Leaving clears the pick only for a mouse: on touch the pointer
 * leaves as the finger lifts, and the readout should stay up until the next tap.
 */
export function pickHandlers<T>(pick: (e: PointerEvent<Element>) => T | null, set: (v: T | null) => void) {
  const on = (e: PointerEvent<Element>) => set(pick(e));
  return {
    onPointerMove: on,
    onPointerDown: on,
    onPointerLeave: (e: PointerEvent<Element>) => {
      if (e.pointerType === "mouse") set(null);
    },
  };
}
