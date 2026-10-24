import { CARD_H, CARD_W, FONT, INK, MUTED, PAD, cardCanvas, clip, frame, pill } from "../shareCard";
import { DIRECTED, EDGE_KINDS, EDGE_LABEL, clusterOf, nodeName, type AsylGraph } from "./graph";
import { EDGE_COLOUR, CLUSTER_COLOUR, radiusOf } from "./GraphView";
import { bounds, newLayout, settle, type LayoutState } from "./layout";
import { TILE, wallMarks } from "./scrawl";

/**
 * Asyl's share image (user ask 2026-10-24: shareables keep TrenchScanner's background, or Asyl's
 * take on it): the card frame every TrenchScanner image has, with Asyl's wall marks faint in its
 * dark, and the map drawn on it as it is laid out on screen.
 */

const MAP_TOP = 244;
const MAP_BOTTOM = CARD_H - 96;

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

export interface MapCardInput {
  title: string;
  graph: AsylGraph;
  /** The screen's layout; laid out afresh when absent. */
  layout?: LayoutState;
  /** The address the map is about, for the subtitle. */
  focus: string | null;
}

export function mapCardSub(g: AsylGraph): string {
  const wallets = g.nodes.filter((n) => n.kind === "wallet").length;
  const coins = g.nodes.length - wallets;
  const parts = [`${wallets} wallet${wallets === 1 ? "" : "s"}`];
  if (coins) parts.push(`${coins} coin${coins === 1 ? "" : "s"}`);
  parts.push(`${g.edges.length} link${g.edges.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export async function renderMapCard(input: MapCardInput): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas(2);
  if (!ctx) return canvas;
  await document.fonts?.load(`400 40px "Permanent Marker"`).catch(() => undefined);
  const g = input.graph;
  const radius = radiusOf(g);
  let layout = input.layout;
  if (!layout || g.nodes.some((n) => !layout!.pos.has(n.id))) {
    layout = newLayout();
    settle(layout, g, radius);
  }

  frame(ctx, icon, input.title, mapCardSub(g), {
    badge: (c, right, cy) => pill(c, right, cy, "Asyl map"),
    footer: "Wallet links from TrenchScanner's own reads and the chain",
    link: "asyl.trenchscanner.app",
    disclaimer: "Links show money or trades that moved between wallets, not who owns them.",
  });
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

  // The map, fitted into the box between the title and the footer, with room for a legend row.
  const legendH = 46;
  const box = { x: PAD, y: MAP_TOP, w: CARD_W - PAD * 2, h: MAP_BOTTOM - MAP_TOP - legendH };
  const b = bounds(
    layout,
    g.nodes.map((n) => n.id),
    radius,
  );
  const k = Math.min(box.w / Math.max(1, b.maxX - b.minX), box.h / Math.max(1, b.maxY - b.minY), 2.2);
  const ox = box.x + (box.w - (b.maxX - b.minX) * k) / 2 - b.minX * k;
  const oy = box.y + (box.h - (b.maxY - b.minY) * k) / 2 - b.minY * k;
  const at = (id: string) => {
    const p = layout!.pos.get(id)!;
    return { x: ox + p.x * k, y: oy + p.y * k };
  };
  const maxByKind = new Map<string, number>();
  for (const e of g.edges) maxByKind.set(e.kind, Math.max(maxByKind.get(e.kind) ?? 0, e.weight));
  ctx.lineCap = "round";
  for (const e of g.edges) {
    if (!layout.pos.has(e.a) || !layout.pos.has(e.b)) continue;
    const a = at(e.a);
    const c = at(e.b);
    const max = maxByKind.get(e.kind) ?? 1;
    const t = max > 0 ? Math.log1p(Math.max(0, e.weight)) / Math.log1p(max) : 0;
    ctx.strokeStyle = EDGE_COLOUR[e.kind];
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(1, (1 + t * 3) * Math.min(1, k));
    ctx.setLineDash(e.source === "chain" ? [6, 4] : e.kind === "cotrade" ? [2, 4] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
    if (DIRECTED.has(e.kind)) {
      const ang = Math.atan2(c.y - a.y, c.x - a.x);
      const r = radius(e.b) * k + 3;
      const tx = c.x - Math.cos(ang) * r;
      const ty = c.y - Math.sin(ang) * r;
      ctx.setLineDash([]);
      ctx.fillStyle = EDGE_COLOUR[e.kind];
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(ang - 0.45) * 8, ty - Math.sin(ang - 0.45) * 8);
      ctx.lineTo(tx - Math.cos(ang + 0.45) * 8, ty - Math.sin(ang + 0.45) * 8);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const clusters = clusterOf(g);
  const labelled = new Set(
    [...g.nodes]
      .filter((n) => n.name || n.id === input.focus)
      .sort((a, b) => radius(b.id) - radius(a.id))
      .slice(0, 24)
      .map((n) => n.id),
  );
  for (const n of g.nodes) {
    if (!layout.pos.has(n.id)) continue;
    const p = at(n.id);
    const r = Math.max(3, radius(n.id) * k);
    const cl = clusters.get(n.id) ?? -1;
    ctx.beginPath();
    if (n.kind === "token") ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle =
      n.kind === "token" ? "#2a2018" : cl >= 0 ? CLUSTER_COLOUR[cl % CLUSTER_COLOUR.length]! : "#4a4440";
    ctx.fill();
    ctx.lineWidth = n.id === input.focus ? 3 : 1.5;
    ctx.strokeStyle =
      n.id === input.focus
        ? "#ffffff"
        : n.tags.includes("kol")
          ? "#ffd34d"
          : n.tags.includes("risky") || n.tags.includes("dumper")
            ? "#ff3b30"
            : "rgba(0,0,0,0.5)";
    ctx.stroke();
    if (labelled.has(n.id)) {
      ctx.font = `600 13px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(12, 13, 18, 0.9)";
      const text = clip(ctx, nodeName(n), 150);
      ctx.strokeText(text, p.x, p.y + r + 4);
      ctx.fillStyle = INK;
      ctx.fillText(text, p.x, p.y + r + 4);
    }
  }
  ctx.textAlign = "left";

  // Legend: only the kinds this map has.
  const kinds = EDGE_KINDS.filter((kd) => g.edges.some((e) => e.kind === kd));
  let lx = PAD;
  const ly = MAP_BOTTOM - 8;
  ctx.font = `500 15px ${FONT}`;
  ctx.textBaseline = "middle";
  for (const kd of kinds) {
    ctx.fillStyle = EDGE_COLOUR[kd];
    ctx.fillRect(lx, ly - 2, 18, 4);
    ctx.fillStyle = MUTED;
    ctx.fillText(EDGE_LABEL[kd], lx + 24, ly);
    lx += 34 + ctx.measureText(EDGE_LABEL[kd]).width;
  }
  return canvas;
}
