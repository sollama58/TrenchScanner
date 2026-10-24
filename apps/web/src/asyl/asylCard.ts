import { CARD_H, CARD_W, FONT, INK, INK2, MUTED, PAD, cardCanvas, clip, frame, pill } from "../shareCard";
import {
  DEFAULT_TIME_LABELS,
  EDGE_KINDS,
  EDGE_LABEL,
  TIMED_KINDS,
  clusterOf,
  edgeTimeLabel,
  nodeName,
  textBoxSize,
  type AsylGraph,
  type Drawings,
  type TimeLabels,
  type TimedKind,
} from "./graph";
import { EDGE_COLOUR, EDGE_STYLE, CLUSTER_COLOUR, radiusOf, type EdgeHead } from "./GraphView";
import { newLayout, settle, type LayoutState } from "./layout";
import { TILE, wallMarks } from "./scrawl";

/**
 * Asyl's share image (user ask 2026-10-24: shareables keep TrenchScanner's background, or Asyl's
 * take on it): the card frame every TrenchScanner image has, with Asyl's wall marks faint in its
 * dark, and the whole map drawn on it as the reader laid it out: every bubble, link, time and
 * drawing. A map too spread out to read at the image's size is laid out afresh for the image alone
 * (fitMap), and the card says so through `onNote`.
 */

/** The map's box: under a compact title, over the legend row and footer. */
const MAP_TOP = 196;
const MAP_BOTTOM = CARD_H - 96;
const LEGEND_H = 30;
/** Room kept around the map for labels under bubbles and at the edges, in card units. */
const LABEL_BELOW = 20;
const SIDE = 46;
/** Below this many card units per map unit, bubbles and text are too small to read. */
const LEGIBLE = 0.62;
/** The most a map is enlarged: a small map isn't blown up past this. */
const MAX_SCALE = 2;
/** How far the two axes may be scaled apart to fill the image's shape. */
const STRETCH = 1.7;

/** Faint orange marker over the card's dark, as on the map itself. */
function drawWall(ctx: CanvasRenderingContext2D) {
  const marks = wallMarks({ seed: 1985, density: 60, notes: false });
  const paths = marks.strokes.map((m) => ({ p: new Path2D(m.d), w: m.width }));
  ctx.save();
  ctx.strokeStyle = "rgba(255, 122, 47, 0.03)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let ox = 0; ox < CARD_W; ox += TILE) {
    for (let oy = 0; oy < CARD_H; oy += TILE) {
      ctx.save();
      ctx.translate(ox, oy);
      for (const { p, w } of paths) {
        ctx.lineWidth = w;
        ctx.stroke(p);
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

/** A link's end mark, as the map draws it, at (x, y) pointing along `ang`. */
function drawHead(
  ctx: CanvasRenderingContext2D,
  head: EdgeHead,
  x: number,
  y: number,
  ang: number,
  colour: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.setLineDash([]);
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.beginPath();
  if (head === "arrow") {
    ctx.moveTo(0, 0);
    ctx.lineTo(-9, -4.5);
    ctx.lineTo(-9, 4.5);
    ctx.closePath();
    ctx.fill();
  } else if (head === "open") {
    ctx.lineWidth = 2;
    ctx.moveTo(-8, -4);
    ctx.lineTo(0, 0);
    ctx.lineTo(-8, 4);
    ctx.stroke();
  } else if (head === "diamond") {
    ctx.moveTo(0, 0);
    ctx.lineTo(-4.5, -4);
    ctx.lineTo(-9, 0);
    ctx.lineTo(-4.5, 4);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.arc(-4, 0, 3.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const dashOf = (dash: string | undefined) => (dash ? dash.split(" ").map(Number) : []);

/** A link's bow, as the map draws it, so two kinds between one pair don't overlap. */
const bowOf = (kind: string) =>
  kind === "funded" ? 0 : kind === "transfer" ? 0.12 : kind === "side" ? -0.12 : 0.06;

export interface MapCardInput {
  title: string;
  graph: AsylGraph;
  /** The screen's layout; laid out afresh when absent. */
  layout?: LayoutState;
  /** The address the map is about, for the subtitle. */
  focus: string | null;
  /** The reader's own lines and text boxes. */
  drawings?: Drawings;
  /** Which kinds of line carry their time, as on screen. */
  timeLabels?: TimeLabels;
  /** Told what the image changed to fit (a fresh layout), or null when it is the map as laid out. */
  onNote?: (note: string | null) => void;
}

export function mapCardSub(g: AsylGraph): string {
  const wallets = g.nodes.filter((n) => n.kind === "wallet").length;
  const coins = g.nodes.length - wallets;
  const parts = [`${wallets} wallet${wallets === 1 ? "" : "s"}`];
  if (coins) parts.push(`${coins} coin${coins === 1 ? "" : "s"}`);
  parts.push(`${g.edges.length} link${g.edges.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

type Pos = Map<string, { x: number; y: number }>;
type Box = { x: number; y: number; w: number; h: number };
type Fit = { sx: number; sy: number; ox: number; oy: number; size: number };

/** The map's extent in its own units: every bubble with its radius, and every text box. */
function extent(pos: Pos, ids: string[], radius: (id: string) => number, drawings: Drawings | undefined) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    const r = radius(id);
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  }
  for (const t of drawings?.texts ?? []) {
    const { w, h } = textBoxSize(t.text);
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + w);
    maxY = Math.max(maxY, t.y + h);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

/**
 * How the map fits the box: one scale for both axes when that reads well; otherwise the axes
 * scaled apart (up to STRETCH) to fill the image's wide shape. `size` is what bubbles scale by.
 */
export function fitBox(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  box: Box,
): Fit & { stretched: boolean } {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const fx = box.w / bw;
  const fy = box.h / bh;
  const k = Math.min(fx, fy, MAX_SCALE);
  let sx = k;
  let sy = k;
  let stretched = false;
  if (k < LEGIBLE) {
    // Fill the box's other axis too, as far as STRETCH allows.
    sx = Math.min(fx, MAX_SCALE, k * STRETCH);
    sy = Math.min(fy, MAX_SCALE, k * STRETCH);
    stretched = Math.abs(sx - sy) > 1e-6;
  }
  const ox = box.x + (box.w - bw * sx) / 2 - b.minX * sx;
  const oy = box.y + (box.h - bh * sy) / 2 - b.minY * sy;
  return { sx, sy, ox, oy, size: Math.sqrt(sx * sy), stretched };
}

/**
 * The image's own layout, when the reader's is too spread out to read at the image's size: the
 * map's forces run again from where the reader put things, nothing pinned, which pulls stray
 * bubbles in. Text boxes go beside the bubble they were nearest.
 */
function compactLayout(
  g: AsylGraph,
  from: Pos,
  radius: (id: string) => number,
  drawings: Drawings | undefined,
) {
  const lay = newLayout();
  for (const n of g.nodes) {
    const p = from.get(n.id);
    if (p) {
      lay.pos.set(n.id, { x: p.x, y: p.y });
      lay.vel.set(n.id, { x: 0, y: 0 });
    }
  }
  settle(lay, g, radius, 400);
  // Each text box goes beside the bubble it was nearest, on the side of it that covers least,
  // trying its old side first.
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const hits = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0;
    for (const m of g.nodes) {
      const q = lay.pos.get(m.id);
      if (!q) continue;
      const r = radius(m.id) + 6;
      // A bubble and the name under it.
      if (q.x + r > x0 && q.x - r < x1 && q.y + r + 18 > y0 && q.y - r < y1) n++;
    }
    for (const b of placed) if (b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1) n += 2;
    return n;
  };
  const texts = (drawings?.texts ?? []).map((t) => {
    let best: string | null = null;
    let bestD = Infinity;
    const { w, h } = textBoxSize(t.text);
    const cx = t.x + w / 2;
    const cy = t.y + h / 2;
    for (const n of g.nodes) {
      const p = from.get(n.id);
      if (!p) continue;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    if (!best) return t;
    const was = from.get(best)!;
    const at = lay.pos.get(best)!;
    const r = radius(best) + 14;
    const sides = [
      { x: at.x + r, y: at.y - h / 2, dx: 1, dy: 0 },
      { x: at.x - r - w, y: at.y - h / 2, dx: -1, dy: 0 },
      { x: at.x - w / 2, y: at.y - r - h, dx: 0, dy: -1 },
      { x: at.x - w / 2, y: at.y + r + 18, dx: 0, dy: 1 },
    ].sort((a, b) => b.dx * (cx - was.x) + b.dy * (cy - was.y) - (a.dx * (cx - was.x) + a.dy * (cy - was.y)));
    let pick = sides[0]!;
    let fewest = Infinity;
    for (const c of sides) {
      const n = hits(c.x, c.y, c.x + w, c.y + h);
      if (n < fewest) {
        fewest = n;
        pick = c;
      }
    }
    placed.push({ x0: pick.x, y0: pick.y, x1: pick.x + w, y1: pick.y + h });
    return { ...t, x: pick.x, y: pick.y };
  });
  return { pos: lay.pos, drawings: drawings ? { ...drawings, texts } : drawings };
}

/**
 * How crowded a fit draws: pairs of bubbles, or of the names under them, that land on one another
 * at the image's size. A layout that reads on a zoomable screen can still pile up in the image.
 */
export function crowding(g: AsylGraph, pos: Pos, fit: Fit, radius: (id: string) => number): number {
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const small = g.nodes.length > 25;
  for (const n of g.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const x = fit.ox + p.x * fit.sx;
    const y = fit.oy + p.y * fit.sy;
    const r = Math.max(4, radius(n.id) * fit.size);
    boxes.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
    const w = Math.min(150, nodeName(n).length * (small ? 6 : 7.2)) / 2;
    boxes.push({ x0: x - w, y0: y + r + 4, x1: x + w, y1: y + r + (small ? 17 : 20) });
  }
  let n = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      // A bubble and its own name touch by design; a pixel or two of contact isn't a pile-up.
      if (j === i + 1 && i % 2 === 0) continue;
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 3 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 3)
        n++;
    }
  return n;
}

export async function renderMapCard(input: MapCardInput): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas(2);
  if (!ctx) return canvas;
  await document.fonts?.load(`400 40px "Permanent Marker"`).catch(() => undefined);
  const g = input.graph;
  const radius = radiusOf(g);
  const times = input.timeLabels ?? DEFAULT_TIME_LABELS;
  let layout = input.layout;
  if (!layout || g.nodes.some((n) => !layout!.pos.has(n.id))) {
    layout = newLayout();
    settle(layout, g, radius);
  }

  // The frame's own title is left empty: a compact one is drawn below, to leave the map more room.
  frame(ctx, icon, "", "", {
    badge: (c, right, cy) => pill(c, right, cy, "Asyl map"),
    footer: "Wallet links from TrenchScanner's own reads and the chain",
    link: "asyl.trenchscanner.app",
    disclaimer: "Links show money or trades that moved between wallets, not who owns them.",
  });
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `750 34px ${FONT}`;
  ctx.fillText(clip(ctx, input.title, CARD_W - PAD * 2), PAD, 152);
  ctx.fillStyle = INK2;
  ctx.font = `500 18px ${FONT}`;
  const drawnCount = (input.drawings?.lines.length ?? 0) + (input.drawings?.texts.length ?? 0);
  ctx.fillText(
    clip(
      ctx,
      mapCardSub(g) + (drawnCount ? ` · ${drawnCount} note${drawnCount === 1 ? "" : "s"} drawn` : ""),
      CARD_W - PAD * 2,
    ),
    PAD,
    180,
  );
  // Under the title, so the marks sit in the background of the map.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, MAP_TOP - 8, CARD_W, MAP_BOTTOM - MAP_TOP + 16);
  ctx.clip();
  drawWall(ctx);
  ctx.restore();
  // "ASYL" in marker, by the brand row.
  ctx.save();
  ctx.font = `400 34px "Permanent Marker", ${FONT}`;
  ctx.fillStyle = "#ff7a2f";
  ctx.textBaseline = "middle";
  ctx.translate(PAD + 290, 70);
  ctx.rotate(-0.06);
  ctx.fillText("ASYL", 0, 0);
  ctx.restore();

  // Fit the whole map, as laid out, into the box; lay it out afresh only when that can't be read.
  const box: Box = {
    x: PAD + SIDE,
    y: MAP_TOP + 6,
    w: CARD_W - (PAD + SIDE) * 2,
    h: MAP_BOTTOM - MAP_TOP - LEGEND_H - LABEL_BELOW - 6,
  };
  const ids = g.nodes.map((n) => n.id);
  let pos: Pos = layout.pos;
  let drawings = input.drawings;
  let fit = fitBox(extent(pos, ids, radius, drawings), box);
  let note: string | null = fit.stretched ? "The map is stretched a little to fill the image's shape." : null;
  const crowd = crowding(g, pos, fit, radius);
  if ((fit.size < LEGIBLE || crowd > 0) && g.nodes.length > 2) {
    const compact = compactLayout(g, layout.pos, radius, drawings);
    const fit2 = fitBox(extent(compact.pos, ids, radius, compact.drawings), box);
    const crowd2 = crowding(g, compact.pos, fit2, radius);
    // The image's own layout only when it reads better: fewer pile-ups, or bigger at no more.
    if (crowd2 < crowd || (crowd2 === crowd && fit2.size > fit.size * 1.1)) {
      pos = compact.pos;
      drawings = compact.drawings;
      fit = fit2;
      note =
        crowd > crowd2 && fit.size >= LEGIBLE
          ? "Some bubbles would sit on top of one another at the image's size, so the image lays the map out afresh to keep each one clear. Your map itself is unchanged."
          : "Your map is too spread out to read at the image's size, so the image lays it out more compactly. Your map itself is unchanged.";
    }
  }
  if (fit.size < LEGIBLE * 0.6 && !note?.startsWith("Your map"))
    note = "A big map: the image shows all of it, small. Take some bubbles off for a clearer image.";
  input.onNote?.(note);

  const at = (id: string) => {
    const p = pos.get(id)!;
    return { x: fit.ox + p.x * fit.sx, y: fit.oy + p.y * fit.sy };
  };
  const rOf = (id: string) => Math.max(4, radius(id) * fit.size);
  const maxByKind = new Map<string, number>();
  for (const e of g.edges) maxByKind.set(e.kind, Math.max(maxByKind.get(e.kind) ?? 0, e.weight));

  // Links: bowed from rim to rim, as on screen.
  const curve = (aId: string, bId: string, bow: number) => {
    const a = at(aId);
    const c = at(bId);
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ra = rOf(aId);
    const rb = rOf(bId) + 2;
    const sx = a.x + (dx / d) * ra;
    const sy = a.y + (dy / d) * ra;
    const ex = c.x - (dx / d) * rb;
    const ey = c.y - (dy / d) * rb;
    const mx = (sx + ex) / 2 - dy * bow;
    const my = (sy + ey) / 2 + dx * bow;
    return { sx, sy, mx, my, ex, ey, d: d - ra - rb };
  };
  ctx.lineCap = "round";
  for (const e of g.edges) {
    if (!pos.has(e.a) || !pos.has(e.b)) continue;
    const q = curve(e.a, e.b, bowOf(e.kind));
    const max = maxByKind.get(e.kind) ?? 1;
    const t = max > 0 ? Math.log1p(Math.max(0, e.weight)) / Math.log1p(max) : 0;
    const path = new Path2D();
    path.moveTo(q.sx, q.sy);
    path.quadraticCurveTo(q.mx, q.my, q.ex, q.ey);
    ctx.strokeStyle = EDGE_COLOUR[e.kind];
    ctx.globalAlpha = e.kind === "holds" ? 0.55 : 0.8;
    ctx.lineWidth = Math.max(1.2, (1 + t * 3) * Math.min(1, fit.size));
    const st = EDGE_STYLE[e.kind];
    if (e.kind === "created") {
      // The Deployed line's gold glow, as on the map.
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 9;
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      ctx.stroke(path);
      ctx.restore();
      ctx.lineWidth = 3;
    }
    ctx.setLineDash(dashOf(st.dash));
    ctx.lineCap = e.kind === "cotrade" ? "round" : "butt";
    ctx.stroke(path);
    const ang = Math.atan2(q.ey - q.my, q.ex - q.mx);
    if (st.head) drawHead(ctx, st.head, q.ex, q.ey, ang, EDGE_COLOUR[e.kind]);
    const midX = 0.25 * q.sx + 0.5 * q.mx + 0.25 * q.ex;
    const midY = 0.25 * q.sy + 0.5 * q.my + 0.25 * q.ey;
    if (e.source === "chain") {
      // A chain read: the ringed dot halfway along.
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(midX, midY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#120c09";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    // Its time along it, as on screen, when the reader has times on for its kind.
    if ((TIMED_KINDS as readonly string[]).includes(e.kind) && times[e.kind as TimedKind] && e.at) {
      const text = edgeTimeLabel(e.at, Math.floor((q.d - 24) / 6));
      if (text) {
        let a = Math.atan2(q.ey - q.sy, q.ex - q.sx);
        if (a > Math.PI / 2) a -= Math.PI;
        else if (a < -Math.PI / 2) a += Math.PI;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.translate(midX, midY);
        ctx.rotate(a);
        ctx.font = `700 10.5px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.lineWidth = 3.5;
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#0c0d12";
        const y = e.kind === "created" ? -9 : -5;
        ctx.strokeText(text, 0, y);
        ctx.fillStyle = EDGE_COLOUR[e.kind];
        ctx.fillText(text, 0, y);
        ctx.restore();
      }
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // The reader's own lines, bowed the other way; their labels go on after the bubbles, on top.
  const lineLabels: { q: ReturnType<typeof curve>; label: string; colour: string }[] = [];
  for (const l of drawings?.lines ?? []) {
    if (!pos.has(l.a) || !pos.has(l.b)) continue;
    const q = curve(l.a, l.b, -0.18);
    ctx.strokeStyle = l.colour;
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(q.sx, q.sy);
    ctx.quadraticCurveTo(q.mx, q.my, q.ex, q.ey);
    ctx.stroke();
    for (const [x, y] of [
      [q.sx, q.sy],
      [q.ex, q.ey],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = l.colour;
      ctx.fill();
    }
    if (l.label) lineLabels.push({ q, label: l.label, colour: l.colour });
  }

  const clusters = clusterOf(g);
  // Every bubble is named on a map of up to 40; past that, the named ones and the biggest.
  const labelled = new Set(
    (g.nodes.length <= 40
      ? g.nodes
      : [...g.nodes]
          .sort((a, b) => Number(!!b.name) - Number(!!a.name) || radius(b.id) - radius(a.id))
          .slice(0, 40)
    ).map((n) => n.id),
  );
  for (const n of g.nodes) {
    if (!pos.has(n.id)) continue;
    const p = at(n.id);
    const r = rOf(n.id);
    const cl = clusters.get(n.id) ?? -1;
    ctx.beginPath();
    if (n.kind === "token") ctx.roundRect(p.x - r, p.y - r, r * 2, r * 2, r * 0.44);
    else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle =
      n.kind === "token" ? "#2a2018" : cl >= 0 ? CLUSTER_COLOUR[cl % CLUSTER_COLOUR.length]! : "#4a4440";
    ctx.fill();
    ctx.lineWidth = n.id === input.focus ? 3 : n.kind === "token" ? 2 : 1.5;
    ctx.strokeStyle =
      n.id === input.focus
        ? "#ffffff"
        : n.tags.includes("kol")
          ? "#ffd34d"
          : n.tags.includes("risky") || n.tags.includes("dumper")
            ? "#ff3b30"
            : n.kind === "token"
              ? "#ffb067"
              : "rgba(0,0,0,0.5)";
    ctx.stroke();
    if (n.kind === "wallet" && n.tags.includes("dev")) {
      // The deployer's yellow D, as on the map.
      const bx = p.x + r * 0.74;
      const by = p.y - r * 0.74;
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#ffe066";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#120402";
      ctx.stroke();
      ctx.font = `800 10px ${FONT}`;
      ctx.fillStyle = "#120402";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("D", bx, by + 0.5);
    }
    if (labelled.has(n.id)) {
      ctx.font = `600 ${g.nodes.length > 25 ? 11 : 13}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(12, 13, 18, 0.9)";
      const text = clip(ctx, nodeName(n), 150);
      ctx.strokeText(text, p.x, p.y + r + 4);
      ctx.fillStyle = INK;
      ctx.fillText(text, p.x, p.y + r + 4);
    }
  }

  for (const { q, label, colour } of lineLabels) {
    const mx = 0.25 * q.sx + 0.5 * q.mx + 0.25 * q.ex;
    const my = 0.25 * q.sy + 0.5 * q.my + 0.25 * q.ey;
    ctx.font = `400 14px "Permanent Marker", ${FONT}`;
    const text = clip(ctx, label, 260);
    const w = ctx.measureText(text).width + 20;
    ctx.beginPath();
    ctx.roundRect(mx - w / 2, my - 12, w, 24, 12);
    ctx.fillStyle = "#120c09";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, mx, my + 1);
  }

  // The reader's text boxes, over everything, scaled with the map.
  for (const t of drawings?.texts ?? []) {
    if (!t.text.trim()) continue;
    const { w, h } = textBoxSize(t.text);
    const k = fit.size;
    const x = fit.ox + t.x * fit.sx;
    const y = fit.oy + t.y * fit.sy;
    ctx.beginPath();
    ctx.roundRect(x, y, w * k, h * k, 8 * k);
    ctx.fillStyle = "rgba(18, 12, 9, 0.92)";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = t.colour;
    ctx.stroke();
    ctx.fillStyle = t.colour;
    ctx.font = `400 ${14 * k}px "Permanent Marker", ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    t.text.split("\n").forEach((line, i) => ctx.fillText(line, x + 12 * k, y + (23 + i * 20) * k));
  }
  ctx.textAlign = "left";

  // Legend: only the kinds this map has, and the reader's lines when there are any.
  const kinds = EDGE_KINDS.filter((kd) => g.edges.some((e) => e.kind === kd));
  let lx = PAD;
  const ly = MAP_BOTTOM - 10;
  ctx.font = `500 15px ${FONT}`;
  ctx.textBaseline = "middle";
  for (const kd of kinds) {
    const st = EDGE_STYLE[kd];
    ctx.strokeStyle = EDGE_COLOUR[kd];
    ctx.lineWidth = 3;
    ctx.lineCap = kd === "cotrade" ? "round" : "butt";
    ctx.setLineDash(dashOf(st.dash));
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(lx + (st.head ? 22 : 30), ly);
    ctx.stroke();
    if (st.head) drawHead(ctx, st.head, lx + 31, ly, 0, EDGE_COLOUR[kd]);
    ctx.setLineDash([]);
    ctx.fillStyle = MUTED;
    ctx.fillText(EDGE_LABEL[kd], lx + 38, ly);
    lx += 50 + ctx.measureText(EDGE_LABEL[kd]).width;
  }
  if (drawings?.lines.length) {
    ctx.strokeStyle = "#fff3e6";
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(lx + 3, ly);
    ctx.lineTo(lx + 27, ly);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText("Drawn by the map's author", lx + 38, ly);
  }
  return canvas;
}
