import type { AsylGraph } from "./graph";

/**
 * The map's force layout: linked nodes pull together, every pair pushes apart, and a weak pull to
 * the centre keeps islands on screen. Plain O(n²) repulsion: a map holds a few hundred nodes as a
 * rule (MAP_NODES_MAX on the API caps it). Positions are kept between runs, so a merge only moves what is
 * new and its neighbours; a node the user dragged stays pinned where it was put.
 */

export type Point = { x: number; y: number };

export interface LayoutState {
  pos: Map<string, Point>;
  vel: Map<string, Point>;
  pinned: Set<string>;
}

export function newLayout(): LayoutState {
  return { pos: new Map(), vel: new Map(), pinned: new Set() };
}

/** A small seeded random, so the same map lays out the same way each time. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100_000) / 100_000;
  };
}

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Places nodes the layout hasn't seen yet: near an already placed neighbour when they have one,
 * on a ring around it; otherwise around the centre.
 */
export function placeNew(state: LayoutState, g: AsylGraph): string[] {
  const added: string[] = [];
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const e of g.edges) {
    link(e.a, e.b);
    link(e.b, e.a);
  }
  const ringCount = new Map<string, number>();
  // Twice over: a new node whose only neighbour is also new is placed on the second pass.
  for (let pass = 0; pass < 2; pass++) {
    for (const n of g.nodes) {
      if (state.pos.has(n.id)) continue;
      const anchor = (adj.get(n.id) ?? []).find((id) => state.pos.has(id));
      if (!anchor && pass === 0 && (adj.get(n.id) ?? []).length > 0 && state.pos.size > 0) continue;
      const rnd = seeded(hash(n.id));
      if (anchor) {
        const k = ringCount.get(anchor) ?? 0;
        ringCount.set(anchor, k + 1);
        const a = state.pos.get(anchor)!;
        const angle = k * 2.399963 + rnd() * 0.4;
        const r = 70 + 14 * Math.sqrt(k);
        state.pos.set(n.id, { x: a.x + Math.cos(angle) * r, y: a.y + Math.sin(angle) * r });
      } else {
        const angle = rnd() * Math.PI * 2;
        const r = 40 + rnd() * 160;
        state.pos.set(n.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
      }
      state.vel.set(n.id, { x: 0, y: 0 });
      added.push(n.id);
    }
  }
  // Forget nodes that left the map.
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const id of [...state.pos.keys()]) {
    if (ids.has(id)) continue;
    state.pos.delete(id);
    state.vel.delete(id);
    state.pinned.delete(id);
  }
  return added;
}

export interface LayoutForces {
  /** Pairwise push. */
  repel: number;
  /** Rest length of a link. */
  linkLength: number;
  link: number;
  centre: number;
  damping: number;
}

export const FORCES: LayoutForces = { repel: 2600, linkLength: 90, link: 0.04, centre: 0.004, damping: 0.82 };

/**
 * One step of the simulation, scaled by `alpha` (1 at a start, easing to 0). Returns the largest
 * move, so the caller can stop once the map has settled.
 */
export function step(
  state: LayoutState,
  g: AsylGraph,
  alpha: number,
  radius: (id: string) => number = () => 12,
  forces: LayoutForces = FORCES,
): number {
  const ids = g.nodes.map((n) => n.id).filter((id) => state.pos.has(id));
  const force = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
  // The pairwise push over flat arrays, not map lookups: a frame of a big map does a million pairs
  // or more, and this halves its time.
  const n = ids.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const rs = new Float64Array(n);
  const fxs = new Float64Array(n);
  const fys = new Float64Array(n);
  ids.forEach((id, i) => {
    const p = state.pos.get(id)!;
    xs[i] = p.x;
    ys[i] = p.y;
    rs[i] = radius(id);
  });
  const pair = (i: number, j: number) => {
    let dx = xs[i]! - xs[j]!;
    let dy = ys[i]! - ys[j]!;
    let d2 = dx * dx + dy * dy;
    if (d2 < 0.01) {
      dx = (i - j) * 0.1;
      dy = 0.1;
      d2 = dx * dx + dy * dy;
    }
    const minD = rs[i]! + rs[j]! + 6;
    const push = forces.repel / d2 + (d2 < minD * minD ? (minD - Math.sqrt(d2)) * 0.5 : 0);
    const d = Math.sqrt(d2);
    const fx = (dx / d) * push;
    const fy = (dy / d) * push;
    fxs[i] = fxs[i]! + fx;
    fys[i] = fys[i]! + fy;
    fxs[j] = fxs[j]! - fx;
    fys[j] = fys[j]! - fy;
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pair(i, j);
  ids.forEach((id, i) => {
    const f = force.get(id)!;
    f.x += fxs[i]!;
    f.y += fys[i]!;
  });
  for (const e of g.edges) {
    const a = state.pos.get(e.a);
    const b = state.pos.get(e.b);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const rest = forces.linkLength + radius(e.a) + radius(e.b);
    const pull = (d - rest) * forces.link;
    const fx = (dx / d) * pull;
    const fy = (dy / d) * pull;
    force.get(e.a)!.x += fx;
    force.get(e.a)!.y += fy;
    force.get(e.b)!.x -= fx;
    force.get(e.b)!.y -= fy;
  }
  let moved = 0;
  for (const id of ids) {
    if (state.pinned.has(id)) continue;
    const p = state.pos.get(id)!;
    const v = state.vel.get(id) ?? { x: 0, y: 0 };
    const f = force.get(id)!;
    f.x -= p.x * forces.centre * 10;
    f.y -= p.y * forces.centre * 10;
    v.x = (v.x + f.x * alpha) * forces.damping;
    v.y = (v.y + f.y * alpha) * forces.damping;
    // A cap on one step, so a node dropped onto another doesn't fly off the map.
    const speed = Math.hypot(v.x, v.y);
    if (speed > 40) {
      v.x = (v.x / speed) * 40;
      v.y = (v.y / speed) * 40;
    }
    p.x += v.x;
    p.y += v.y;
    state.vel.set(id, v);
    moved = Math.max(moved, Math.hypot(v.x, v.y));
  }
  return moved;
}

/** Runs the layout to rest, at most `ticks` steps: for a share image or a saved map's first draw. */
export function settle(state: LayoutState, g: AsylGraph, radius?: (id: string) => number, ticks = 300): void {
  placeNew(state, g);
  for (let t = 0; t < ticks; t++) {
    const alpha = 1 - t / ticks;
    if (step(state, g, alpha, radius) < 0.05 && t > 20) break;
  }
}

/** The box around every placed node, padded by their radius. */
export function bounds(state: LayoutState, ids: Iterable<string>, radius: (id: string) => number = () => 12) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = state.pos.get(id);
    if (!p) continue;
    const r = radius(id);
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

/** A grid cell: how far apart neighbouring bubbles sit in grid mode. */
export type Cell = { w: number; h: number };

/**
 * Grid mode's cell (user ask 2026-10-24): wide enough for the biggest bubble or nine names in ten
 * under one, with room between neighbours for a line's time or label; tall enough for a bubble, its
 * name, and a time along a line running down to the next row.
 */
export function gridCell(g: AsylGraph, radius: (id: string) => number, name: (id: string) => string): Cell {
  let r = 12;
  const widths: number[] = [];
  for (const n of g.nodes) {
    r = Math.max(r, radius(n.id));
    widths.push(Math.min(150, name(n.id).length * 7));
  }
  // Sized for nine names in ten: one long label shouldn't spread the whole grid out.
  widths.sort((a, b) => a - b);
  const nameW = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.9))] ?? 0;
  return { w: Math.round(Math.max(2 * r, nameW) + 72), h: Math.round(2 * r + 22 + 72) };
}

/**
 * Puts every bubble on its own grid cell, the nearest one free. Bubbles already sitting on a cell
 * keep it; the rest go in order of how many links they have, so hubs get the cells they're nearest.
 */
export function snapToGrid(state: LayoutState, g: AsylGraph, cell: Cell): void {
  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const onCell = (p: Point) =>
    Math.abs(p.x / cell.w - Math.round(p.x / cell.w)) < 1e-6 &&
    Math.abs(p.y / cell.h - Math.round(p.y / cell.h)) < 1e-6;
  const ids = g.nodes
    .map((n) => n.id)
    .filter((id) => state.pos.has(id))
    .sort(
      (a, b) =>
        Number(onCell(state.pos.get(b)!)) - Number(onCell(state.pos.get(a)!)) ||
        (degree.get(b) ?? 0) - (degree.get(a) ?? 0) ||
        (a < b ? -1 : 1),
    );
  const taken = new Set<string>();
  for (const id of ids) {
    const p = state.pos.get(id)!;
    const fx = p.x / cell.w;
    const fy = p.y / cell.h;
    const ci = Math.round(fx);
    const cj = Math.round(fy);
    let best: [number, number] | null = null;
    // Rings outward from the nearest cell; a ring can hold a nearer free cell than the one before.
    for (let ring = 0; ring < 400 && !best; ring++) {
      let bestD = Infinity;
      for (let i = ci - ring; i <= ci + ring; i++)
        for (let j = cj - ring; j <= cj + ring; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring || taken.has(`${i},${j}`)) continue;
          const d = Math.hypot((i - fx) * cell.w, (j - fy) * cell.h);
          if (d < bestD) {
            bestD = d;
            best = [i, j];
          }
        }
    }
    if (!best) continue;
    taken.add(`${best[0]},${best[1]}`);
    state.pos.set(id, { x: best[0] * cell.w, y: best[1] * cell.h });
    state.vel.set(id, { x: 0, y: 0 });
  }
}

/**
 * Spreads a free layout out to the grid's spacing before it first goes onto the grid, so each bubble
 * lands near where it was relative to the others instead of the crowd being pushed outwards: the
 * typical gap between neighbours becomes one cell.
 */
export function spreadForGrid(state: LayoutState, g: AsylGraph, cell: Cell): void {
  const pts = g.nodes.map((n) => state.pos.get(n.id)).filter((p): p is Point => !!p);
  if (pts.length < 2) return;
  const nearest = pts.map((p) => {
    let best = Infinity;
    for (const q of pts) if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    return best;
  });
  nearest.sort((a, b) => a - b);
  const typical = nearest[Math.floor(nearest.length / 2)]!;
  if (!(typical > 0)) return;
  const k = Math.min(cell.w, cell.h) / typical;
  if (k <= 1) return;
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  for (const [id, p] of state.pos) state.pos.set(id, { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k });
}
