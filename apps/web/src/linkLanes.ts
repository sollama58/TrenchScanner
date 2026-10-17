/**
 * Lanes for the lines between two bubbles (user ask 2026-10-17: when two wallets are tied more than
 * one way, say a shared funder and a transfer, the lines should read as one tidy bundle). Every
 * line between the same pair runs as a lane of one bundle: side by side, a fixed gap apart by their
 * widths, each leaving and reaching its bubbles at its own spot on the rim, so they neither lie on
 * top of each other nor fan out from the bubbles' centres and cross. Shared by the token bubble map
 * (bubbleMap.ts) and the wallet web (walletWeb.ts), and by both share images.
 *
 * Pure, so it is tested on its own.
 */

export interface LanePoint {
  x: number;
  y: number;
}

export interface LaneEnd extends LanePoint {
  r: number;
}

/**
 * A lane's drawn curve: a quadratic from (x1, y1) through (cx, cy) to (x2, y2). `angle`: its heading
 * at the end, for an arrowhead.
 */
export interface LaneRoute {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  angle: number;
}

/** The room between two lanes' strokes, map units. */
export const LANE_GAP = 2.4;

/**
 * Each lane's offset from the bundle's middle line, in order, centred on it: lanes sit edge to edge
 * by their widths with `gap` between, so a thick arrow takes more room than a hairline.
 */
export function laneOffsets(widths: readonly number[], gap = LANE_GAP): number[] {
  if (widths.length === 0) return [];
  const centres: number[] = [];
  let at = 0;
  widths.forEach((w, i) => {
    if (i > 0) at += widths[i - 1]! / 2 + gap + w / 2;
    centres.push(at);
  });
  const mid = (centres[0]! + centres[centres.length - 1]!) / 2;
  return centres.map((c) => c - mid);
}

/** The side of a pair a lane's bend and offset are measured on: one way round, whichever end is `from`. */
export function pairSign(from: string, to: string): 1 | -1 {
  return from <= to ? 1 : -1;
}

/**
 * One lane from `a` to `b`. `bend`: how far the bundle's middle line bows, as a share of the
 * distance, to the left of a-to-b (the transfer arrows' sense: -dy, dx). `offset`: the lane's place
 * across the bundle, map units, the same way. Each end sits on its bubble's rim, `gapA` / `gapB`
 * past it (negative: inside), turned toward the lane's side so parallel lanes enter side by side;
 * a small bubble pinches them together rather than letting a lane miss it.
 */
export function laneRoute(a: LaneEnd, b: LaneEnd, bend: number, offset = 0, gapA = 0, gapB = 0): LaneRoute {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  // How far across each end steps: most of the lane's offset, never past most of the bubble.
  const port = (r: number) => Math.max(-r * 0.62, Math.min(r * 0.62, offset * 0.8));
  const pa = port(a.r);
  const pb = port(b.r);
  // The control point: the bundle's bow, plus what the lane needs so its middle sits `offset` across.
  const across = bend * len + 2 * offset - (pa + pb) / 2;
  const cx = (a.x + b.x) / 2 + nx * across;
  const cy = (a.y + b.y) / 2 + ny * across;
  const end = (n: LaneEnd, p: number, gap: number) => {
    // Along the curve's tangent at this end, then across by p, then onto the rim (plus the gap).
    const tx = cx - n.x;
    const ty = cy - n.y;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    // The across direction, turned to the pair's left (n) whichever end this is.
    let sx = -uy;
    let sy = ux;
    if (sx * nx + sy * ny < 0) {
      sx = -sx;
      sy = -sy;
    }
    const along = Math.sqrt(Math.max(0, n.r * n.r - p * p));
    const px = ux * along + sx * p;
    const py = uy * along + sy * p;
    const pl = Math.hypot(px, py) || 1;
    const reach = n.r + gap;
    return { x: n.x + (px / pl) * reach, y: n.y + (py / pl) * reach };
  };
  const p1 = end(a, pa, gapA);
  const p2 = end(b, pb, gapB);
  return { x1: p1.x, y1: p1.y, cx, cy, x2: p2.x, y2: p2.y, angle: Math.atan2(p2.y - cy, p2.x - cx) };
}

/** Points along a lane, its ends included: about one every `step` map units. */
export function lanePoints(r: LaneRoute, step = 3): LanePoint[] {
  const n = Math.max(6, Math.ceil(Math.hypot(r.x2 - r.x1, r.y2 - r.y1) / step));
  const out: LanePoint[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    out.push({
      x: (1 - t) * (1 - t) * r.x1 + 2 * (1 - t) * t * r.cx + t * t * r.x2,
      y: (1 - t) * (1 - t) * r.y1 + 2 * (1 - t) * t * r.cy + t * t * r.y2,
    });
  }
  return out;
}

/** A lane's middle (t = 0.5) and its heading there in degrees: for a mark along it. */
export function laneMid(r: LaneRoute): { x: number; y: number; angle: number } {
  return {
    x: 0.25 * r.x1 + 0.5 * r.cx + 0.25 * r.x2,
    y: 0.25 * r.y1 + 0.5 * r.cy + 0.25 * r.y2,
    // A quadratic's heading at its middle is its chord's.
    angle: (Math.atan2(r.y2 - r.y1, r.x2 - r.x1) * 180) / Math.PI,
  };
}

/** The SVG path of a lane, to a tenth of a unit. */
export function laneD(r: Pick<LaneRoute, "x1" | "y1" | "cx" | "cy" | "x2" | "y2">): string {
  const f = (v: number) => Math.round(v * 10) / 10;
  return `M${f(r.x1)} ${f(r.y1)} Q${f(r.cx)} ${f(r.cy)} ${f(r.x2)} ${f(r.y2)}`;
}

/** Whether segment p1-p2 crosses segment q1-q2 (touching ends aside). */
export function segmentsCross(p1: LanePoint, p2: LanePoint, q1: LanePoint, q2: LanePoint): boolean {
  const side = (a: LanePoint, b: LanePoint, c: LanePoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = side(q1, q2, p1);
  const d2 = side(q1, q2, p2);
  const d3 = side(p1, p2, q1);
  const d4 = side(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** How many of `others` a polyline crosses, each counted once; a box check skips the far ones. */
export function crossingCount(pts: readonly LanePoint[], others: readonly (readonly LanePoint[])[]): number {
  const box = (ps: readonly LanePoint[]) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of ps) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  };
  const mine = box(pts);
  let c = 0;
  for (const other of others) {
    const b = box(other);
    if (b.x1 < mine.x0 || b.x0 > mine.x1 || b.y1 < mine.y0 || b.y0 > mine.y1) continue;
    cross: for (let i = 1; i < pts.length; i += 1)
      for (let j = 1; j < other.length; j += 1)
        if (segmentsCross(pts[i - 1]!, pts[i]!, other[j - 1]!, other[j]!)) {
          c += 1;
          break cross;
        }
  }
  return c;
}
