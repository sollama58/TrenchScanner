/**
 * The token chart's drawing tools (TradingChart): trendlines, Fibonacci retracements and horizontal
 * price levels, ported from HolDEX's chart (CultScreener frontend/js/chartDrawings.js). The chart
 * library has no drawing tools of its own, so they are drawn by a series primitive. A point is kept
 * as a time and a market cap, so a drawing stays put across timeframes and views, and is saved per
 * coin on this device. Which Fibonacci levels show, and whether a trendline runs on past its
 * points, are the chart's own options.
 */

export type DrawTool = "trend" | "fib" | "level";

/** A drawing's point: a time (ms) and a market cap (USD). */
export interface DrawPoint {
  t: number;
  v: number;
}

export interface Drawing {
  id: string;
  type: DrawTool;
  p1: DrawPoint;
  p2: DrawPoint;
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
const MAX_DRAWINGS = 60;

/** A Fibonacci level's value: level 1 at the first point, 0 at the second (TradingView's way). */
export function fibValue(d: Drawing, level: number): number {
  return d.p2.v + (d.p1.v - d.p2.v) * level;
}

/** A point's distance (px) from the infinite line through (x1, y1) and (x2, y2). */
function distToLine(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!len) return Math.hypot(px - x1, py - y1);
  return Math.abs((px - x1) * dy - (py - y1) * dx) / len;
}

/** Exported for tests. A point's distance (px) from the segment from (x1, y1) to (x2, y2). */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const u = Math.max(0, Math.min(1, len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0));
  return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
}

/** Exported for tests. The drawings saved under `key`, those that make sense, newest kept. */
export function loadDrawings(key: string): Drawing[] {
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(arr)) return [];
    const ok = (p: unknown): p is DrawPoint =>
      !!p &&
      Number.isFinite((p as DrawPoint).t) &&
      Number.isFinite((p as DrawPoint).v) &&
      (p as DrawPoint).v > 0;
    return (arr as Drawing[])
      .filter(
        (d) =>
          d &&
          (d.type === "trend" || d.type === "fib" || d.type === "level") &&
          typeof d.id === "string" &&
          ok(d.p1) &&
          ok(d.p2),
      )
      .slice(-MAX_DRAWINGS);
  } catch {
    return [];
  }
}

function saveDrawings(key: string, drawings: readonly Drawing[]): void {
  try {
    if (drawings.length) localStorage.setItem(key, JSON.stringify(drawings));
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the drawings last for this visit.
  }
}

/** Where the chart places things: a time and value to CSS px, and back; null off the plot. */
export interface DrawScale {
  x(t: number): number | null;
  y(v: number): number | null;
  t(x: number): number | null;
  v(y: number): number | null;
}

/** What the drawings draw with. */
export interface DrawColors {
  trend: string;
  select: string;
  handleFill: string;
  diagonal: string;
  fib: readonly string[];
  font: string;
}

/** The drawings on one coin's chart: the tool in hand, the selection, and the saved drawings. */
export class Drawings {
  private drawings: Drawing[];
  tool: DrawTool | null = null;
  /** The first point of a drawing being placed. */
  private pending: DrawPoint | null = null;
  /** The pointer's latest point while placing, for the preview. */
  private hover: DrawPoint | null = null;
  selectedId: string | null = null;
  /** Fibonacci levels drawn (a subset of FIB_LEVELS). The chart keeps the choice. */
  private fibOn = new Set<number>(FIB_LEVELS);
  /** A trendline continues past both points to the edges of the plot. */
  extendTrend = false;

  constructor(
    private readonly key: string,
    private readonly onChange: () => void,
  ) {
    this.drawings = loadDrawings(key);
  }

  get count(): number {
    return this.drawings.length;
  }
  get placing(): boolean {
    return this.pending !== null;
  }
  /** The selected drawing's tool, for the options that belong to it. */
  get selectedType(): DrawTool | null {
    return this.drawings.find((d) => d.id === this.selectedId)?.type ?? null;
  }

  /** Which Fibonacci levels to draw. An empty list keeps every level. */
  setFibLevels(levels: readonly number[]): void {
    const next = new Set(FIB_LEVELS.filter((lv) => levels.some((n) => Math.abs(n - lv) < 1e-6)));
    this.fibOn = next.size ? next : new Set(FIB_LEVELS);
    this.changed();
  }

  setExtendTrend(on: boolean): void {
    if (this.extendTrend === on) return;
    this.extendTrend = on;
    this.changed();
  }

  private changed(save = false): void {
    if (save) saveDrawings(this.key, this.drawings);
    this.onChange();
  }

  setTool(next: DrawTool): void {
    this.tool = this.tool === next ? null : next;
    this.pending = null;
    this.hover = null;
    if (this.tool) this.selectedId = null;
    this.changed();
  }

  /** Drops the tool in hand or the selection; false when there was neither. */
  cancel(): boolean {
    if (!this.tool && !this.selectedId) return false;
    this.tool = null;
    this.pending = null;
    this.hover = null;
    this.selectedId = null;
    this.changed();
    return true;
  }

  /** A click or tap at (x, y): places a point, or selects the drawing under it. True when used. */
  click(x: number, y: number, scale: DrawScale, touch: boolean): boolean {
    if (this.tool) {
      const t = scale.t(x);
      const v = scale.v(y);
      if (t === null || v === null || !(v > 0)) return true;
      const pt = { t, v };
      // A price level is one tap: a horizontal line at that market cap.
      if (this.tool === "level") {
        this.finish(this.tool, pt, pt);
        return true;
      }
      if (!this.pending) {
        this.pending = pt;
        this.hover = pt;
        this.changed();
        return true;
      }
      if (pt.t === this.pending.t && Math.abs(pt.v - this.pending.v) / this.pending.v < 1e-9) return true;
      this.finish(this.tool, this.pending, pt);
      return true;
    }
    const hit = this.hitTest(x, y, scale, touch ? 22 : 7);
    const next = hit?.id ?? null;
    if (next !== this.selectedId) {
      this.selectedId = next;
      this.changed();
    }
    return hit !== null;
  }

  /** The pointer moved while placing: the preview follows it. True when it needs a redraw. */
  move(x: number, y: number, scale: DrawScale): boolean {
    if (!this.tool || !this.pending) return false;
    const t = scale.t(x);
    const v = scale.v(y);
    if (t === null || v === null || !(v > 0)) return false;
    this.hover = { t, v };
    return true;
  }

  deleteSelected(): boolean {
    if (!this.selectedId) return false;
    this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
    this.selectedId = null;
    this.changed(true);
    return true;
  }

  clearAll(): void {
    if (!this.drawings.length) return;
    this.drawings = [];
    this.selectedId = null;
    this.changed(true);
  }

  private finish(type: DrawTool, p1: DrawPoint, p2: DrawPoint): void {
    const d: Drawing = {
      id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      p1,
      p2,
    };
    this.drawings = [...this.drawings, d].slice(-MAX_DRAWINGS);
    this.tool = null;
    this.pending = null;
    this.hover = null;
    this.selectedId = d.id;
    this.changed(true);
  }

  private enabledFib(): readonly (typeof FIB_LEVELS)[number][] {
    return FIB_LEVELS.filter((lv) => this.fibOn.has(lv));
  }

  private hitTest(x: number, y: number, scale: DrawScale, tol: number): Drawing | null {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i]!;
      if (d.type === "level") {
        const ly = scale.y(d.p1.v);
        if (ly !== null && Math.abs(y - ly) <= tol) return d;
        continue;
      }
      const ax = scale.x(d.p1.t);
      const ay = scale.y(d.p1.v);
      const bx = scale.x(d.p2.t);
      const by = scale.y(d.p2.v);
      if (ax === null || ay === null || bx === null || by === null) continue;
      if (d.type === "trend") {
        // An extended trendline is the whole line, so a click on the dashed run past either
        // point still selects it. Otherwise only the segment between the two points does.
        const dist = this.extendTrend
          ? distToLine(x, y, ax, ay, bx, by)
          : distToSegment(x, y, ax, ay, bx, by);
        if (dist <= tol) return d;
        continue;
      }
      const left = Math.min(ax, bx);
      const right = Math.max(ax, bx);
      if (x < left - tol || x > right + tol) continue;
      const near = this.enabledFib().some((lv) => {
        const ly = scale.y(fibValue(d, lv));
        return ly !== null && Math.abs(y - ly) <= tol;
      });
      if (near) return d;
    }
    return null;
  }

  /** Draws them all on the pane's canvas (bitmap px: `hr`, `vr` per CSS px). */
  draw(
    ctx: CanvasRenderingContext2D,
    hr: number,
    vr: number,
    scale: DrawScale,
    colors: DrawColors,
    label: (v: number) => string,
    plotW = 0,
    plotH = 0,
  ): void {
    const items = this.drawings.map((d) => ({ d, sel: d.id === this.selectedId, preview: false }));
    if (this.pending && this.hover && this.tool)
      items.push({
        d: { id: "_preview", type: this.tool, p1: this.pending, p2: this.hover },
        sel: false,
        preview: true,
      });
    const handle = (x: number, y: number, color: string) => {
      ctx.beginPath();
      ctx.arc(x * hr, y * vr, 4.5 * hr, 0, Math.PI * 2);
      ctx.fillStyle = colors.handleFill;
      ctx.fill();
      ctx.lineWidth = 1.5 * hr;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    for (const it of items) {
      if (it.d.type === "level") {
        const ly = scale.y(it.d.p1.v);
        if (ly === null) continue;
        const ax = scale.x(it.d.p1.t);
        ctx.save();
        const y = Math.round(ly * vr) + 0.5;
        const span = plotW > 0 ? plotW : 0;
        ctx.lineWidth = (it.sel ? 2 : 1.25) * hr;
        ctx.strokeStyle = colors.trend;
        ctx.setLineDash([7 * hr, 4 * hr]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(span * hr, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `${Math.round(10.5 * vr)}px ${colors.font}`;
        ctx.textBaseline = "bottom";
        ctx.fillStyle = colors.trend;
        const text = label(it.d.p1.v);
        const tw = ctx.measureText(text).width / hr;
        ctx.fillText(text, Math.max(4, span - tw - 8) * hr, (ly - 3) * vr);
        ctx.restore();
        if (it.sel && ax !== null) handle(ax, ly, colors.select);
        continue;
      }
      const ax = scale.x(it.d.p1.t);
      const ay = scale.y(it.d.p1.v);
      const bx = scale.x(it.d.p2.t);
      const by = scale.y(it.d.p2.v);
      if (ax === null || ay === null || bx === null || by === null) continue;
      ctx.save();
      if (it.d.type === "trend") {
        ctx.lineWidth = (it.sel ? 2.5 : 2) * hr;
        ctx.strokeStyle = colors.trend;
        if (it.preview) ctx.setLineDash([6 * hr, 4 * hr]);
        if (this.extendTrend && !it.preview && plotW > 0 && plotH > 0) {
          const ext = rayPast(ax, ay, bx, by, plotW, plotH);
          ctx.save();
          ctx.setLineDash([5 * hr, 4 * hr]);
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.moveTo(ext.x1 * hr, ext.y1 * vr);
          ctx.lineTo(ext.x2 * hr, ext.y2 * vr);
          ctx.stroke();
          ctx.restore();
        }
        ctx.beginPath();
        ctx.moveTo(ax * hr, ay * vr);
        ctx.lineTo(bx * hr, by * vr);
        ctx.stroke();
      } else {
        const left = Math.min(ax, bx);
        const right = Math.max(ax, bx);
        ctx.font = `${Math.round(10.5 * vr)}px ${colors.font}`;
        ctx.textBaseline = "bottom";
        const shown = this.enabledFib();
        const ys = new Map(shown.map((lv) => [lv, scale.y(fibValue(it.d, lv))]));
        // Shaded bands between neighbouring levels that are switched on.
        for (let i = 0; i < shown.length - 1; i++) {
          const a = ys.get(shown[i]!);
          const b = ys.get(shown[i + 1]!);
          if (a == null || b == null) continue;
          const colorAt = FIB_LEVELS.indexOf(shown[i + 1]!);
          ctx.globalAlpha = it.preview ? 0.05 : 0.08;
          ctx.fillStyle = colors.fib[Math.max(0, colorAt)]!;
          ctx.fillRect(left * hr, Math.min(a, b) * vr, (right - left) * hr, Math.abs(b - a) * vr);
        }
        ctx.globalAlpha = 1;
        shown.forEach((lv) => {
          const i = FIB_LEVELS.indexOf(lv);
          const y = ys.get(lv);
          if (y == null) return;
          ctx.strokeStyle = colors.fib[i]!;
          ctx.lineWidth = (it.sel ? 1.5 : 1) * hr;
          ctx.setLineDash(it.preview ? [5 * hr, 4 * hr] : []);
          ctx.beginPath();
          ctx.moveTo(left * hr, Math.round(y * vr) + 0.5);
          ctx.lineTo(right * hr, Math.round(y * vr) + 0.5);
          ctx.stroke();
          if (right - left > 50) {
            ctx.fillStyle = colors.fib[i]!;
            ctx.fillText(`${lv} (${label(fibValue(it.d, lv))})`, (left + 4) * hr, (y - 2) * vr);
          }
        });
        // The diagonal from the first point to the second, as TradingView shows it.
        ctx.setLineDash([3 * hr, 3 * hr]);
        ctx.strokeStyle = colors.diagonal;
        ctx.lineWidth = hr;
        ctx.beginPath();
        ctx.moveTo(ax * hr, ay * vr);
        ctx.lineTo(bx * hr, by * vr);
        ctx.stroke();
      }
      ctx.restore();
      if (it.sel || it.preview) {
        const c = it.sel ? colors.select : colors.trend;
        handle(ax, ay, c);
        handle(bx, by, c);
      }
    }
    // A drawing's first point, all a phone shows until the second tap.
    if (this.pending && this.tool) {
      const x = scale.x(this.pending.t);
      const y = scale.y(this.pending.v);
      if (x !== null && y !== null) handle(x, y, colors.trend);
    }
  }
}

/** The segment from (ax, ay) to (bx, by), run on in both directions across a plot of w by h. */
function rayPast(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  w: number,
  h: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const span = Math.hypot(w, h);
  return {
    x1: ax - (dx / len) * span,
    y1: ay - (dy / len) * span,
    x2: bx + (dx / len) * span,
    y2: by + (dy / len) * span,
  };
}
