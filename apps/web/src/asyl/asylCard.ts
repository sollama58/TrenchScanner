import { API_URL } from "../api";
import {
  BRAND_A,
  CARD_H,
  CARD_W,
  FONT,
  INK,
  INK2,
  MUTED,
  cardCanvas,
  clip,
  roundRect,
  stamp,
} from "../shareCard";
import {
  DEFAULT_TIME_LABELS,
  EDGE_KINDS,
  EDGE_LABEL,
  TIMED_KINDS,
  clusterOf,
  edgeTimeLabel,
  nodeName,
  strokePath,
  textBoxSize,
  type AsylGraph,
  type Drawings,
  type TimeLabels,
  type TimedKind,
} from "./graph";
import { EDGE_COLOUR, EDGE_STYLE, CLUSTER_COLOUR, imageSources, radiusOf, type EdgeHead } from "./GraphView";
import { newLayout, settle, type LayoutState } from "./layout";
import { TILE, wallMarks } from "./scrawl";

/**
 * Asyl's share image (user asks 2026-10-24: shareables keep TrenchScanner's background, or Asyl's
 * take on it; the map is the focus and has to look great). The map fills the card edge to edge,
 * as the reader laid it out: every bubble with its picture, link, time and drawing. The brand,
 * title, legend and link sit in thin rows above and below it, over Asyl's faint wall marks. A map too spread out to read at the image's size is laid out afresh for the image alone
 * (fitMap), and the card says so through `onNote`.
 */

/** The map's box: nearly the whole card, between a thin title row and a thin footer row. */
const EDGE = 24;
const MAP_TOP = 84;
const MAP_BOTTOM = CARD_H - 50;
/** Room kept around the map for labels under bubbles and at the edges, in card units. */
const LABEL_BELOW = 20;
const SIDE = 40;
/** Below this many card units per map unit, bubbles and text are too small to read. */
const LEGIBLE = 0.62;
/** Room for a name under its bubble: a full wallet label (up to 40 characters) fits whole. */
const NAME_W = 380;
/**
 * Sizes in the image, set for reading on a phone (user ask 2026-10-24): names in 17px (14px on a
 * map of more than 25), and bubbles never drawn smaller than 160% of their size on screen (90% on a
 * big map), however far the map is scaled down to fit; whatever then touches is nudged apart.
 */
const namePx = (g: AsylGraph) => (g.nodes.length > 25 ? 14 : 17);
const nameW = (g: AsylGraph, n: AsylGraph["nodes"][number]) =>
  Math.min(NAME_W, nodeName(n).length * namePx(g) * 0.58);
const bubbleK = (g: AsylGraph, fit: Fit) => Math.max(fit.size, g.nodes.length > 25 ? 0.9 : 1.6);
/** Text boxes, likewise, keep at least 90% of their size. */
const textK = (fit: Fit) => Math.max(fit.size, 0.9);
/** The most a map is enlarged: a small map isn't blown up past this. */
const MAX_SCALE = 2.2;
/** How far the two axes may be scaled apart to fill the image's shape. */
const STRETCH = 1.7;
/** ...and how far for a map whose names would otherwise pile up: wide names need the width most. */
const STRETCH_CROWDED = 2.6;

/** Faint orange marker over the card's dark, as on the map itself. */
function drawWall(ctx: CanvasRenderingContext2D, W = CARD_W, H = CARD_H) {
  const marks = wallMarks({ seed: 1985, density: 60, notes: false });
  const paths = marks.strokes.map((m) => ({ p: new Path2D(m.d), w: m.width }));
  ctx.save();
  ctx.strokeStyle = "rgba(255, 122, 47, 0.03)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let ox = 0; ox < W; ox += TILE) {
    for (let oy = 0; oy < H; oy += TILE) {
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
  /**
   * The map as the reader sees it now (user ask 2026-10-25): the image is what is on screen, at
   * the screen's size and zoom, with the legend and brand laid over its corners.
   */
  view?: { x: number; y: number; k: number; w: number; h: number };
}

/** A screen-sized image's pixels per screen pixel: sharp, within what browsers draw. */
const shotScale = (w: number, h: number) => Math.max(1, Math.min(2, 4096 / Math.max(w, h)));

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
  /** Stretch even at a legible scale: for a map whose bubbles would otherwise pile up. */
  spread = false,
): Fit & { stretched: boolean } {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const fx = box.w / bw;
  const fy = box.h / bh;
  const k = Math.min(fx, fy, MAX_SCALE);
  let sx = k;
  let sy = k;
  let stretched = false;
  if (k < LEGIBLE || spread) {
    // Fill the box's other axis too, as far as STRETCH allows.
    const most = k * (spread ? STRETCH_CROWDED : STRETCH);
    // Spreading leaves bubbles their size, so it isn't held to the enlargement cap.
    const cap = spread ? Infinity : MAX_SCALE;
    sx = Math.min(fx, cap, most);
    sy = Math.min(fy, cap, most);
    stretched = Math.abs(sx - sy) > 1e-6;
  }
  const ox = box.x + (box.w - bw * sx) / 2 - b.minX * sx;
  const oy = box.y + (box.h - bh * sy) / 2 - b.minY * sy;
  // Spread for room, bubbles and names keep the size they'd have unstretched: the room is the point.
  return { sx, sy, ox, oy, size: spread ? k : Math.sqrt(sx * sy), stretched };
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

/** A picture the canvas can read back: loaded with CORS, or not at all. */
function loadImage(src: string, ms = 3500): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    const t = setTimeout(() => resolve(null), ms);
    img.onload = () => {
      clearTimeout(t);
      resolve(img.naturalWidth > 0 ? img : null);
    };
    img.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    img.src = src;
  });
}

/**
 * Each bubble's picture, trying its sources in turn as the map does. Avatars come through the
 * API's CORS copy (as the chart's do); a coin whose hosts all refuse a CORS read keeps its plain
 * tile rather than leaving the image unsaveable.
 */
async function loadPictures(g: AsylGraph): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  await Promise.all(
    g.nodes.slice(0, 120).map(async (n) => {
      const sources =
        n.kind === "wallet" && n.avatar
          ? [`${API_URL}${n.avatar}${n.avatar.includes("?") ? "&" : "?"}cors=1`]
          : imageSources(n);
      for (const src of sources.slice(0, 3)) {
        const img = await loadImage(src);
        if (img) {
          out.set(n.id, img);
          return;
        }
      }
    }),
  );
  return out;
}

/**
 * How crowded a fit draws: pairs of bubbles, or of the names under them, that land on one another
 * at the image's size. A layout that reads on a zoomable screen can still pile up in the image.
 */
export function crowding(g: AsylGraph, pos: Pos, fit: Fit, radius: (id: string) => number): number {
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const n of g.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const x = fit.ox + p.x * fit.sx;
    const y = fit.oy + p.y * fit.sy;
    const r = Math.max(4, radius(n.id) * bubbleK(g, fit));
    boxes.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
    const w = nameW(g, n) / 2;
    boxes.push({ x0: x - w, y0: y + r + 4, x1: x + w, y1: y + r + namePx(g) + 6 });
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

type Rect = { x0: number; y0: number; x1: number; y1: number };
const overlap = (a: Rect, b: Rect) =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;

/** Where a bubble and the name under it sit in the image. */
function nodeRects(g: AsylGraph, at: (id: string) => { x: number; y: number }, r: (id: string) => number) {
  const out = new Map<string, { bubble: Rect; name: Rect }>();
  for (const n of g.nodes) {
    const p = at(n.id);
    const rr = r(n.id);
    const w = nameW(g, n) / 2 + 2;
    out.set(n.id, {
      bubble: { x0: p.x - rr, y0: p.y - rr, x1: p.x + rr, y1: p.y + rr },
      name: { x0: p.x - w, y0: p.y + rr + 3, x1: p.x + w, y1: p.y + rr + namePx(g) + 6 },
    });
  }
  return out;
}

/**
 * The last touch before drawing: bubbles, or their names, that still touch in the image are nudged
 * apart a few pixels at a time, and out from under the reader's text boxes, so every one reads.
 * Works in image pixels and hands back map units; returns how many bubbles moved visibly.
 */
function declutter(
  g: AsylGraph,
  pos: Pos,
  fit: Fit,
  radius: (id: string) => number,
  texts: Rect[],
  box: Box,
): { pos: Pos; moved: number } {
  const ids = g.nodes.map((n) => n.id).filter((id) => pos.has(id));
  if (ids.length > 150) return { pos, moved: 0 };
  const px = new Map(
    ids.map((id) => [id, { x: fit.ox + pos.get(id)!.x * fit.sx, y: fit.oy + pos.get(id)!.y * fit.sy }]),
  );
  const start = new Map([...px].map(([id, p]) => [id, { ...p }]));
  const r = (id: string) => Math.max(4, radius(id) * bubbleK(g, fit));
  // Each bubble, its name included, stays inside the map's part of the card.
  const push = (id: string, dx: number, dy: number) => {
    const p = px.get(id)!;
    const rr = r(id);
    const n = byId.get(id);
    const half = n ? nameW(g, n) / 2 : rr;
    const lo = Math.max(rr, half);
    p.x = Math.min(CARD_W - EDGE - lo, Math.max(EDGE + lo, p.x + dx));
    p.y = Math.min(MAP_BOTTOM - 8 - namePx(g) - 6 - rr, Math.max(box.y + rr, p.y + dy));
  };
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const id of ids) push(id, 0, 0);

  // The way to slide two rectangles apart: along whichever axis needs less, split between them.
  const apart = (a: Rect, b: Rect) => {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const ca = (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2;
    const cb = (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2;
    return ox < oy
      ? { dx: (ca >= 0 ? 1 : -1) * (ox + 2), dy: 0 }
      : { dx: 0, dy: (cb >= 0 ? 1 : -1) * (oy + 2) };
  };
  for (let round = 0; round < 200; round++) {
    let any = false;
    const rects = nodeRects(g, (id) => px.get(id) ?? { x: 0, y: 0 }, r);
    for (let i = 0; i < ids.length; i++) {
      const a = rects.get(ids[i]!)!;
      for (let j = i + 1; j < ids.length; j++) {
        const b = rects.get(ids[j]!)!;
        for (const [ra, rb] of [
          [a.bubble, b.bubble],
          [a.name, b.name],
          [a.name, b.bubble],
          [a.bubble, b.name],
        ] as const) {
          if (!overlap(ra, rb)) continue;
          const { dx, dy } = apart(ra, rb);
          push(ids[i]!, dx / 2, dy / 2);
          push(ids[j]!, -dx / 2, -dy / 2);
          any = true;
          break;
        }
      }
      for (const t of texts) {
        for (const ra of [a.bubble, a.name]) {
          if (!overlap(ra, t)) continue;
          const { dx, dy } = apart(ra, t);
          push(ids[i]!, dx, dy);
          any = true;
          break;
        }
      }
    }
    if (!any) break;
  }
  let moved = 0;
  const out: Pos = new Map(pos);
  for (const id of ids) {
    const p = px.get(id)!;
    const s = start.get(id)!;
    if (Math.hypot(p.x - s.x, p.y - s.y) > 4) moved++;
    out.set(id, { x: (p.x - fit.ox) / fit.sx, y: (p.y - fit.oy) / fit.sy });
  }
  return { pos: out, moved };
}

export async function renderMapCard(input: MapCardInput): Promise<HTMLCanvasElement> {
  const shot = input.view;
  const W = shot ? Math.max(320, Math.round(shot.w)) : CARD_W;
  const H = shot ? Math.max(240, Math.round(shot.h)) : CARD_H;
  const card = await cardCanvas(2);
  const { icon } = card;
  let { canvas, ctx } = card;
  if (shot) {
    const sc = shotScale(W, H);
    canvas = document.createElement("canvas");
    canvas.width = Math.round(W * sc);
    canvas.height = Math.round(H * sc);
    ctx = canvas.getContext("2d");
    ctx?.scale(sc, sc);
  }
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

  // The card: dark, the brand's flame bar along the top, Asyl's marks faint over all of it.
  ctx.fillStyle = "#0c0d12";
  ctx.fillRect(0, 0, W, H);
  drawWall(ctx, W, H);
  const glow = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, W * 0.62);
  glow.addColorStop(0, "rgba(255, 122, 47, 0.07)");
  glow.addColorStop(1, "rgba(255, 122, 47, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = BRAND_A;
  ctx.fillRect(0, 0, W, 4);
  const drawnCount =
    (input.drawings?.lines.length ?? 0) +
    (input.drawings?.texts.length ?? 0) +
    (input.drawings?.strokes?.length ?? 0);

  // Title row: icon, ASYL in marker, the map's title and what is on it; TrenchScanner on the right.
  const iconS = 38;
  if (!shot) {
    if (icon) {
      ctx.save();
      roundRect(ctx, EDGE, 22, iconS, iconS, 10);
      ctx.clip();
      ctx.drawImage(icon, EDGE, 22, iconS, iconS);
      ctx.restore();
    }
    ctx.save();
    ctx.font = `400 30px "Permanent Marker", ${FONT}`;
    ctx.fillStyle = "#ff7a2f";
    ctx.textBaseline = "middle";
    ctx.translate(EDGE + iconS + 12, 42);
    ctx.rotate(-0.05);
    ctx.fillText("ASYL", 0, 0);
    ctx.restore();
    const titleX = EDGE + iconS + 104;
    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.fillRect(titleX - 14, 26, 1.5, 32);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.font = `750 22px ${FONT}`;
    ctx.fillText(clip(ctx, input.title, 560), titleX, 41);
    ctx.fillStyle = INK2;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText(
      clip(
        ctx,
        mapCardSub(g) + (drawnCount ? ` · ${drawnCount} drawn note${drawnCount === 1 ? "" : "s"}` : ""),
        560,
      ),
      titleX,
      61,
    );
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 17px ${FONT}`;
    ctx.fillText("TrenchScanner", CARD_W - EDGE, 40);
    ctx.fillStyle = MUTED;
    ctx.font = `500 13px ${FONT}`;
    ctx.fillText("by ASDFASDFA", CARD_W - EDGE, 59);
    ctx.textAlign = "left";
  }

  // Pictures for the bubbles, each from the first of its sources that loads readable.
  const pictures = await loadPictures(g);

  // Fit the whole map, as laid out, into the box; lay it out afresh only when that can't be read.
  const box: Box = {
    x: EDGE + SIDE,
    y: MAP_TOP + 10,
    w: CARD_W - (EDGE + SIDE) * 2,
    h: MAP_BOTTOM - MAP_TOP - LABEL_BELOW - 10,
  };
  const ids = g.nodes.map((n) => n.id);
  let pos: Pos = layout.pos;
  let drawings = input.drawings;
  // A screenshot is the screen's own view: nothing refitted, laid out afresh or nudged.
  let fit: Fit & { stretched?: boolean } = shot
    ? { sx: shot.k, sy: shot.k, ox: shot.x, oy: shot.y, size: shot.k }
    : fitBox(extent(pos, ids, radius, drawings), box);
  let note: string | null = fit.stretched ? "The map is stretched a little to fill the image's shape." : null;
  const crowd = shot ? 0 : crowding(g, pos, fit, radius);
  if (!shot && (fit.size < LEGIBLE || crowd > 0) && g.nodes.length > 2) {
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
  if (!shot && fit.size < LEGIBLE * 0.6 && !note?.startsWith("Your map"))
    note = "A big map: the image shows all of it, small. Take some bubbles off for a clearer image.";
  // A tall or narrow map that still piles up uses the image's width (or height) too.
  const crowdNow = shot ? 0 : crowding(g, pos, fit, radius);
  if (crowdNow > 0) {
    const wide = fitBox(extent(pos, ids, radius, drawings), box, true);
    const crowdWide = crowding(g, pos, wide, radius);
    if (wide.stretched && crowdWide <= crowdNow) {
      fit = wide;
      note ??= "The map is spread wider in the image so every name reads. Your map itself is unchanged.";
    }
  }

  // Sizes: on a screenshot exactly as on screen; on the card, kept readable (bubbleK, textK).
  const tk = shot ? shot.k : textK(fit);
  const bk = shot ? shot.k : bubbleK(g, fit);
  const namePxNow = shot ? (11 * shot.k) / Math.min(1.4, Math.max(0.7, shot.k)) : namePx(g);
  // Text boxes as the image draws them, which bubbles keep clear of.
  const textRects = (drawings?.texts ?? [])
    .filter((t) => t.text.trim())
    .map((t) => {
      const { w, h } = textBoxSize(t.text);
      const x = fit.ox + t.x * fit.sx;
      const y = fit.oy + t.y * fit.sy;
      return { x0: x - 4, y0: y - 4, x1: x + w * tk + 4, y1: y + h * tk + 4 };
    });
  const tidy = shot ? { pos, moved: 0 } : declutter(g, pos, fit, radius, textRects, box);
  pos = tidy.pos;
  if (tidy.moved > 0 && !note)
    note =
      tidy.moved === 1
        ? "One bubble is nudged a little in the image so nothing sits on top of it. Your map itself is unchanged."
        : `${tidy.moved} bubbles are nudged a little in the image so none sit on top of another. Your map itself is unchanged.`;
  input.onNote?.(note);

  const at = (id: string) => {
    const p = pos.get(id)!;
    return { x: fit.ox + p.x * fit.sx, y: fit.oy + p.y * fit.sy };
  };
  const rOf = (id: string) => Math.max(shot ? 1 : 4, radius(id) * bk);
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
  const timeRects: Rect[] = [];
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
      const text = edgeTimeLabel(e.at, Math.floor((q.d - 24) / 7.5));
      if (text) {
        let a = Math.atan2(q.ey - q.sy, q.ex - q.sx);
        if (a > Math.PI / 2) a -= Math.PI;
        else if (a < -Math.PI / 2) a += Math.PI;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.translate(midX, midY);
        ctx.rotate(a);
        ctx.font = `700 13px ${FONT}`;
        {
          // Where it lands, roughly, so a drawn line's label can keep off it.
          const half = ctx.measureText(text).width / 2;
          const ex = Math.abs(Math.cos(a)) * half + Math.abs(Math.sin(a)) * 9;
          const ey = Math.abs(Math.sin(a)) * half + Math.abs(Math.cos(a)) * 9;
          timeRects.push({ x0: midX - ex, y0: midY - ey, x1: midX + ex, y1: midY + ey });
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.lineWidth = 3.5;
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#0c0d12";
        const y = e.kind === "created" ? -10 : -6;
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
  // A screenshot names what the screen names: named bubbles, and the rest when the map is small or
  // zoomed in enough (GraphView's own rule).
  const dense = g.nodes.length / 25;
  const labelled = new Set(
    (shot
      ? g.nodes.filter((n) => n.name || n.id === input.focus || dense < 1 || shot.k > 1.1 * dense)
      : g.nodes.length <= 40
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
    // Its picture inside, as on the map: a coin's image, a wallet's avatar.
    const pic = pictures.get(n.id);
    if (pic && r >= 7) {
      ctx.save();
      ctx.beginPath();
      const ir = r - 2;
      if (n.kind === "token") ctx.roundRect(p.x - ir, p.y - ir, ir * 2, ir * 2, ir * 0.44);
      else ctx.arc(p.x, p.y, ir, 0, Math.PI * 2);
      ctx.clip();
      // Cover the bubble, cropping the longer side.
      const s = Math.max((ir * 2) / pic.naturalWidth, (ir * 2) / pic.naturalHeight);
      const w = pic.naturalWidth * s;
      const h = pic.naturalHeight * s;
      ctx.drawImage(pic, p.x - w / 2, p.y - h / 2, w, h);
      ctx.restore();
      ctx.beginPath();
      if (n.kind === "token") ctx.roundRect(p.x - r, p.y - r, r * 2, r * 2, r * 0.44);
      else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
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
  }
  // Names over every bubble, so a bubble drawn later never covers one.
  for (const n of g.nodes) {
    if (!pos.has(n.id)) continue;
    const p = at(n.id);
    const r = rOf(n.id);
    if (labelled.has(n.id)) {
      ctx.font = `700 ${namePxNow}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(12, 13, 18, 0.9)";
      const text = clip(ctx, nodeName(n), NAME_W);
      ctx.strokeText(text, p.x, p.y + r + 4);
      ctx.fillStyle = INK;
      ctx.fillText(text, p.x, p.y + r + 4);
    }
  }

  // Each label at the point along its line that covers the fewest bubbles, names and other labels.
  const taken: Rect[] = [
    ...[...nodeRects(g, at, rOf).values()].flatMap((n) => [n.bubble, n.name]),
    ...timeRects,
  ];
  for (const { q, label, colour } of lineLabels) {
    ctx.font = `400 17px "Permanent Marker", ${FONT}`;
    const text = clip(ctx, label, 260);
    const w = ctx.measureText(text).width + 20;
    let mx = 0;
    let my = 0;
    let fewest = Infinity;
    // Along the line first; then just off it, either side, if every point on it is taken.
    const nx = -(q.ey - q.sy);
    const ny = q.ex - q.sx;
    const nl = Math.hypot(nx, ny) || 1;
    search: for (const off of [0, 22, -22, 36, -36]) {
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]) {
        const u = 1 - t;
        const x = u * u * q.sx + 2 * u * t * q.mx + t * t * q.ex + (nx / nl) * off;
        const y = u * u * q.sy + 2 * u * t * q.my + t * t * q.ey + (ny / nl) * off;
        const me = { x0: x - w / 2, y0: y - 14, x1: x + w / 2, y1: y + 14 };
        // An off-line spot counts one worse, so it wins only when it clears something.
        const n = taken.filter((o) => overlap(me, o)).length + (off ? 0.5 : 0);
        if (n < fewest) {
          fewest = n;
          mx = x;
          my = y;
        }
        if (n === 0) break search;
      }
    }
    taken.push({ x0: mx - w / 2, y0: my - 14, x1: mx + w / 2, y1: my + 14 });
    ctx.beginPath();
    ctx.roundRect(mx - w / 2, my - 14, w, 28, 14);
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

  // The reader's pen strokes, in the map's units like the bubbles they were drawn around.
  for (const st of drawings?.strokes ?? []) {
    ctx.save();
    ctx.translate(fit.ox, fit.oy);
    ctx.scale(fit.sx, fit.sy);
    ctx.strokeStyle = st.colour;
    ctx.lineWidth = st.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(strokePath(st.points)));
    ctx.restore();
  }

  // The reader's text boxes, over everything, scaled with the map.
  for (const t of drawings?.texts ?? []) {
    if (!t.text.trim()) continue;
    const { w, h } = textBoxSize(t.text);
    const k = tk;
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

  if (shot) {
    drawShotFrame(ctx, W, H, icon, input.title, g, drawnCount > 0);
    return canvas;
  }

  // Footer row: the legend (only the kinds this map has, and the reader's lines), the link and date.
  const fy = CARD_H - 30;
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fillRect(EDGE, CARD_H - 50, CARD_W - EDGE * 2, 1);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  ctx.font = `700 17px ${FONT}`;
  ctx.fillText("asyl.trenchscanner.app", CARD_W - EDGE, fy - 4);
  const linkW = ctx.measureText("asyl.trenchscanner.app").width;
  ctx.fillStyle = MUTED;
  ctx.font = `500 11px ${FONT}`;
  ctx.fillText(stamp(new Date()), CARD_W - EDGE, fy + 13);
  ctx.textAlign = "left";
  const kinds = EDGE_KINDS.filter((kd) => g.edges.some((e) => e.kind === kd));
  const legendEnd = CARD_W - EDGE - linkW - 28;
  let lx = EDGE;
  const ly = fy - 4;
  ctx.font = `500 13px ${FONT}`;
  const entries: { label: string; draw: (x: number) => void }[] = kinds.map((kd) => ({
    label: EDGE_LABEL[kd],
    draw: (x: number) => {
      const st = EDGE_STYLE[kd];
      ctx.strokeStyle = EDGE_COLOUR[kd];
      ctx.lineWidth = 2.5;
      ctx.lineCap = kd === "cotrade" ? "round" : "butt";
      ctx.setLineDash(dashOf(st.dash));
      ctx.beginPath();
      ctx.moveTo(x, ly);
      ctx.lineTo(x + (st.head ? 16 : 22), ly);
      ctx.stroke();
      ctx.setLineDash([]);
      if (st.head) drawHead(ctx, st.head, x + 24, ly, 0, EDGE_COLOUR[kd]);
    },
  }));
  if (drawings?.lines.length || drawings?.texts.length)
    entries.push({
      label: "Drawn by the map's author",
      draw: (x: number) => {
        ctx.strokeStyle = "#fff3e6";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + 2, ly);
        ctx.lineTo(x + 22, ly);
        ctx.stroke();
      },
    });
  for (const en of entries) {
    const w = 30 + ctx.measureText(en.label).width;
    if (lx + w > legendEnd) break;
    en.draw(lx);
    ctx.fillStyle = INK2;
    ctx.textBaseline = "middle";
    ctx.fillText(en.label, lx + 30, ly);
    lx += w + 16;
  }
  ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
  ctx.font = `500 10.5px ${FONT}`;
  ctx.fillText(
    "Links show money or trades that moved between wallets, not who owns them. From TrenchScanner's reads and the chain.",
    EDGE,
    fy + 14,
  );
  return canvas;
}

/**
 * A screenshot's frame (user ask 2026-10-25): the brand and title in the top-left corner, the
 * legend in the bottom-left, the link and date in the bottom-right, each on a dark plate so the map
 * under it stays the picture.
 */
function drawShotFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  icon: HTMLImageElement | null,
  title: string,
  g: AsylGraph,
  drawn: boolean,
) {
  const pad = 14;
  const plate = (x: number, y: number, w: number, h: number) => {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 18;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = "rgba(12, 13, 18, 0.88)";
    ctx.fill();
    ctx.restore();
    roundRect(ctx, x, y, w, h, 12);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 122, 47, 0.35)";
    ctx.stroke();
  };

  // Brand and title, top left.
  const iconS = 30;
  ctx.font = `750 15px ${FONT}`;
  const titleText = clip(ctx, title, Math.min(420, W - 200));
  ctx.font = `500 12px ${FONT}`;
  const sub = clip(ctx, mapCardSub(g), Math.min(420, W - 200));
  const subW = ctx.measureText(sub).width;
  ctx.font = `750 15px ${FONT}`;
  const textW = Math.max(ctx.measureText(titleText).width, subW);
  const brandW = iconS + 10 + 62;
  const topW = Math.min(W - pad * 2, brandW + 22 + textW + 24);
  plate(pad, pad, topW, 52);
  if (icon) {
    ctx.save();
    roundRect(ctx, pad + 11, pad + 11, iconS, iconS, 8);
    ctx.clip();
    ctx.drawImage(icon, pad + 11, pad + 11, iconS, iconS);
    ctx.restore();
  }
  ctx.save();
  ctx.font = `400 22px "Permanent Marker", ${FONT}`;
  ctx.fillStyle = "#ff7a2f";
  ctx.textBaseline = "middle";
  ctx.translate(pad + 11 + iconS + 9, pad + 27);
  ctx.rotate(-0.05);
  ctx.fillText("ASYL", 0, 0);
  ctx.restore();
  const tx = pad + 11 + brandW + 12;
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  ctx.fillRect(tx - 11, pad + 12, 1, 28);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = `750 15px ${FONT}`;
  ctx.fillText(titleText, tx, pad + 24);
  ctx.fillStyle = INK2;
  ctx.font = `500 12px ${FONT}`;
  ctx.fillText(sub, tx, pad + 41);

  // Link and date, bottom right.
  ctx.font = `700 14px ${FONT}`;
  const link = "asyl.trenchscanner.app";
  const by = "TrenchScanner · by ASDFASDFA";
  const linkW = ctx.measureText(link).width;
  ctx.font = `500 11px ${FONT}`;
  const byW = Math.max(ctx.measureText(by).width, ctx.measureText(stamp(new Date())).width);
  const brW = Math.max(linkW, byW) + 24;
  const brH = 60;
  plate(W - pad - brW, H - pad - brH, brW, brH);
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = `700 14px ${FONT}`;
  ctx.fillText(link, W - pad - 12, H - pad - brH + 22);
  ctx.fillStyle = INK2;
  ctx.font = `500 11px ${FONT}`;
  ctx.fillText(by, W - pad - 12, H - pad - brH + 38);
  ctx.fillStyle = MUTED;
  ctx.fillText(stamp(new Date()), W - pad - 12, H - pad - brH + 52);
  ctx.textAlign = "left";

  // Legend, bottom left: the kinds of link on the map, one per row (two columns when many).
  const kinds = EDGE_KINDS.filter((kd) => g.edges.some((e) => e.kind === kd));
  const rows: { label: string; draw: (x: number, y: number) => void }[] = kinds.map((kd) => ({
    label: EDGE_LABEL[kd],
    draw: (x: number, y: number) => {
      const st = EDGE_STYLE[kd];
      ctx.strokeStyle = EDGE_COLOUR[kd];
      ctx.lineWidth = 2.5;
      ctx.lineCap = kd === "cotrade" ? "round" : "butt";
      ctx.setLineDash(dashOf(st.dash));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (st.head ? 16 : 22), y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (st.head) drawHead(ctx, st.head, x + 24, y, 0, EDGE_COLOUR[kd]);
    },
  }));
  if (drawn)
    rows.push({
      label: "Drawn by the map's author",
      draw: (x: number, y: number) => {
        ctx.strokeStyle = "#fff3e6";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + 2, y);
        ctx.lineTo(x + 22, y);
        ctx.stroke();
      },
    });
  if (rows.length === 0) return;
  ctx.font = `500 12px ${FONT}`;
  const rowH = 20;
  const room = W - pad * 3 - brW;
  const colW = Math.max(...rows.map((r) => ctx.measureText(r.label).width)) + 40;
  const perCol = Math.ceil(rows.length / (rows.length > 6 && colW * 2 + 24 <= room ? 2 : 1));
  const cols = Math.ceil(rows.length / perCol);
  const lw = Math.min(room, colW * cols + 20);
  const lh = perCol * rowH + 34;
  const lx = pad;
  const ly = H - pad - lh;
  plate(lx, ly, lw, lh);
  ctx.fillStyle = MUTED;
  ctx.font = `700 10px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText("LINKS", lx + 12, ly + 14);
  ctx.font = `500 12px ${FONT}`;
  rows.forEach((r, i) => {
    const x = lx + 12 + Math.floor(i / perCol) * colW;
    const y = ly + 30 + (i % perCol) * rowH;
    r.draw(x, y);
    ctx.fillStyle = INK2;
    ctx.textBaseline = "middle";
    ctx.fillText(clip(ctx, r.label, colW - 36), x + 30, y);
  });
}
