import type { Token } from "./api";
import { graphBounds, type BubbleGraph, type MapNode } from "./bubbleMap";
import { shortAddress, tokenLabel } from "./format";
import {
  CARD_H,
  CARD_W,
  FONT,
  INK,
  INK2,
  MONO,
  MUTED,
  OTHER,
  PAD,
  cardCanvas,
  clip,
  frame,
  pill,
} from "./shareCard";

/** The map's cluster colours on the dark card: the dashboard's dark slots (styles.css .bm-modal). */
const CLUSTER = ["#3987e5", "#199e70", "#d95926", "#8b5cf6", "#06b6d4"];
const RISK = "#ef4444";
const DEV = "#fab219";

const colourOf = (n: MapNode) => (n.cluster === null ? OTHER : CLUSTER[n.cluster % CLUSTER.length]!);
const pctText = (v: number) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;

/** A colour with alpha, from a #rrggbb. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** A #rrggbb mixed toward white by `t` (0-1). */
function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/**
 * The bubble map as a branded 1200x675 share image: the coin and its linked share on the left,
 * the clusters listed under it, and the map itself filling the right, drawn from the same layout
 * as the dialog.
 */
export async function renderBubbleCard(graph: BubbleGraph, token: Token): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  const label = tokenLabel(token);
  frame(ctx, icon, "", "", {
    badge: (c, right, cy) => pill(c, right, cy, "Bubble map"),
    footer: `Top holders sized by share of supply · ${shortAddress(token.mintAddress)}`,
    link: "trenchscanner.app",
    time: true,
  });

  // Left column: the coin, the linked share, the clusters.
  const leftW = 430;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `750 46px ${FONT}`;
  ctx.fillText(clip(ctx, label, leftW), PAD, 176);
  ctx.fillStyle = INK2;
  ctx.font = `500 21px ${FONT}`;
  const name = token.name && token.symbol ? `${token.name} · linked wallets` : "Linked wallets";
  ctx.fillText(clip(ctx, name, leftW), PAD, 210);

  const linked = graph.linkedPct;
  ctx.fillStyle = linked !== null && linked >= 30 ? "#ff8080" : INK;
  ctx.font = `800 76px ${FONT}`;
  const big = linked === null ? "–" : pctText(linked);
  ctx.fillText(big, PAD, 300);
  const bigW = ctx.measureText(big).width;
  ctx.fillStyle = MUTED;
  ctx.font = `500 19px ${FONT}`;
  ctx.fillText("of supply in", PAD + bigW + 16, 272);
  ctx.fillText("linked wallets", PAD + bigW + 16, 296);

  let y = 350;
  const rows = graph.clusters.slice(0, 4);
  for (const [i, c] of rows.entries()) {
    const col = CLUSTER[i % CLUSTER.length]!;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(PAD + 9, y - 7, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(`${c.wallets.length} wallets`, PAD + 30, y);
    const w1 = ctx.measureText(`${c.wallets.length} wallets`).width;
    ctx.fillStyle = MUTED;
    ctx.font = `500 17px ${MONO}`;
    ctx.fillText(
      clip(ctx, ` ← ${shortAddress(c.funder)}${c.creatorLinked ? " · dev" : ""}`, leftW - 120 - w1),
      PAD + 30 + w1,
      y,
    );
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 20px ${FONT}`;
    ctx.fillText(pctText(c.pct), PAD + leftW, y);
    ctx.textAlign = "left";
    y += 40;
  }
  if (graph.clusters.length > rows.length) {
    ctx.fillStyle = MUTED;
    ctx.font = `500 17px ${FONT}`;
    ctx.fillText(`and ${graph.clusters.length - rows.length} more`, PAD + 30, y - 6);
    y += 28;
  }
  const risky = graph.nodes.filter((n) => n.kind === "holder" && n.flags.some((f) => f !== "creator")).length;
  if (risky > 0 && y < CARD_H - 110) {
    ctx.fillStyle = RISK;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(`${risky} risky wallet${risky === 1 ? "" : "s"} among the holders`, PAD, y + 4);
  }

  // Right: the map, fitted into its box.
  const area = { x: PAD + leftW + 40, y: 122, w: CARD_W - PAD - (PAD + leftW + 40), h: CARD_H - 112 - 122 };
  const box = graphBounds(graph, 10);
  const scale = Math.min(area.w / box.w, area.h / box.h, 2.4);
  const ox = area.x + (area.w - box.w * scale) / 2 - box.x * scale;
  const oy = area.y + (area.h - box.h * scale) / 2 - box.y * scale;
  const X = (v: number) => ox + v * scale;
  const Y = (v: number) => oy + v * scale;
  const index = new Map(graph.nodes.map((n) => [n.id, n]));

  ctx.lineCap = "round";
  for (const l of graph.links) {
    const a = index.get(l.from);
    const b = index.get(l.to);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
    const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
    ctx.strokeStyle = alpha(CLUSTER[l.cluster % CLUSTER.length]!, 0.6);
    ctx.lineWidth = Math.max(1.5, 1.6 * scale);
    ctx.beginPath();
    ctx.moveTo(X(a.x), Y(a.y));
    ctx.quadraticCurveTo(X(mx), Y(my), X(b.x), Y(b.y));
    ctx.stroke();
  }

  const order = [...graph.nodes].sort((a, b) => b.r - a.r);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of order) {
    const cx = X(n.x);
    const cy = Y(n.y);
    const r = n.r * scale;
    const col = colourOf(n);
    if (n.kind === "funder") {
      const s = r * 1.25;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#11131a";
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.restore();
      continue;
    }
    if (n.kind === "rest") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = INK2;
      ctx.font = `700 ${Math.max(13, Math.min(24, r * 0.4))}px ${FONT}`;
      ctx.fillText(pctText(n.pct), cx, cy - r * 0.12);
      ctx.fillStyle = MUTED;
      ctx.font = `500 ${Math.max(11, Math.min(16, r * 0.24))}px ${FONT}`;
      ctx.fillText(`${n.count} other${n.count === 1 ? "" : "s"}`, cx, cy + r * 0.3);
      continue;
    }
    const risk = n.flags.some((f) => f !== "creator");
    // Glow, then a lit sphere.
    const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.6);
    glow.addColorStop(0, alpha(col, 0.35));
    glow.addColorStop(1, alpha(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    // Lit from the top left, as the dialog's bubbles are.
    const fill = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, 0, cx - r * 0.3, cy - r * 0.4, r * 1.4);
    fill.addColorStop(0, lighten(col, 0.45));
    fill.addColorStop(1, alpha(col, 0.92));
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = alpha(col, 1);
    ctx.lineWidth = 2;
    ctx.stroke();
    if (risk) {
      ctx.strokeStyle = RISK;
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (r >= 22) {
      ctx.fillStyle = INK;
      ctx.font = `750 ${Math.max(12, Math.min(28, r * 0.42))}px ${FONT}`;
      ctx.fillText(pctText(n.pct), cx, cy + 1);
    }
    const dev = n.flags.includes("creator");
    if (risk || dev) {
      const bx = cx + r * 0.72;
      const by = cy - r * 0.72;
      const br = dev ? 15 : 12;
      ctx.fillStyle = dev ? DEV : RISK;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = dev ? "#1a1300" : INK;
      ctx.font = `800 ${dev ? 11 : 16}px ${FONT}`;
      ctx.fillText(dev ? "DEV" : "!", bx, by + 1);
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return canvas;
}
