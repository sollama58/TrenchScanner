import { useRef, useState } from "react";

/**
 * The Pro token view's sizes, the reader's own (user ask 2026-10-19): the width of the column beside
 * the chart and the chart's height, which sets how much of the window the tabs under it get. Null is
 * the layout's own size. Kept in this browser for every coin, like the column's view.
 */
export type TermLayout = { sideW: number | null; chartH: number | null };
const TERM_LAYOUT_KEY = "ts-scope-layout";

/** The column beside the chart, and the chart's plot: never narrower or shorter than these. */
export const SIDE_MIN_PX = 320;
/** What the chart keeps of the row however wide the column is dragged. */
export const CHART_MIN_W_PX = 420;
export const CHART_MIN_H_PX = 220;
/** Room the tabs keep under the chart, header and tab row included, however tall it is dragged. */
const TABS_MIN_PX = 260;

const sizeOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

function readTermLayout(): TermLayout {
  try {
    const v = JSON.parse(localStorage.getItem(TERM_LAYOUT_KEY) ?? "{}") as Partial<TermLayout>;
    return { sideW: sizeOf(v?.sideW), chartH: sizeOf(v?.chartH) };
  } catch {
    return { sideW: null, chartH: null };
  }
}

/** The chart's tallest plot for this window: the tabs under it always keep some room. */
export function chartMaxHeight(): number {
  return Math.max(CHART_MIN_H_PX, window.innerHeight - TABS_MIN_PX);
}

/**
 * The reader's sizes and a setter for each: a drag shows as it moves and is kept when it ends;
 * null puts the layout's own size back.
 */
export function useTermLayout(): [TermLayout, (patch: Partial<TermLayout>, keep?: boolean) => void] {
  const [layout, setLayout] = useState<TermLayout>(readTermLayout);
  const set = (patch: Partial<TermLayout>, keep = true) => {
    setLayout((was) => {
      const next = { ...was, ...patch };
      if (keep) {
        try {
          localStorage.setItem(TERM_LAYOUT_KEY, JSON.stringify(next));
        } catch {
          // Private mode: the sizes hold for this window only.
        }
      }
      return next;
    });
  };
  return [layout, set];
}

/**
 * A divider the reader drags to resize what is on either side of it: the pointer's travel from where
 * the drag began, sent as it moves and once more as it ends. Arrow keys nudge it, Home or a
 * double-click puts the layout's own size back.
 */
export function TermSplit({
  axis,
  label,
  value,
  size,
  min,
  max,
  onSize,
  onReset,
  className = "",
}: {
  /** "x": a column's edge, dragged sideways; "y": a row's edge, dragged up and down. */
  axis: "x" | "y";
  label: string;
  /** The reader's size, in pixels, when they set one (for screen readers), and its bounds. */
  value: number | null;
  /** The size on the page now, read when a drag or a key press starts. */
  size: () => number;
  min: number;
  max: number;
  /** The new size from the size at the drag's start and the pointer's travel; done on release. */
  onSize: (size: number, done: boolean) => void;
  onReset: () => void;
  className?: string;
}) {
  const drag = useRef<{ at: number; from: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // A column's left edge: dragged left, the column widens.
  const sign = axis === "x" ? -1 : 1;
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)));
  const sizeAt = (e: React.PointerEvent) =>
    clamp(drag.current!.from + sign * ((axis === "x" ? e.clientX : e.clientY) - drag.current!.at));
  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value ?? undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label}: drag to resize, double-click to reset`}
      className={`tm-split tm-split-${axis}${dragging ? " dragging" : ""} ${className}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { at: axis === "x" ? e.clientX : e.clientY, from: size(), id: e.pointerId };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (drag.current?.id === e.pointerId) onSize(sizeAt(e), false);
      }}
      onPointerUp={(e) => {
        if (drag.current?.id !== e.pointerId) return;
        onSize(sizeAt(e), true);
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const keys: Record<string, number> =
          axis === "x" ? { ArrowLeft: step, ArrowRight: -step } : { ArrowUp: -step, ArrowDown: step };
        if (e.key === "Home") {
          e.preventDefault();
          onReset();
        } else if (keys[e.key] !== undefined) {
          e.preventDefault();
          onSize(clamp(size() + keys[e.key]!), true);
        }
      }}
    />
  );
}
