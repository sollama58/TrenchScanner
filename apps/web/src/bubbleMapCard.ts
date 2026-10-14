import type { Token } from "./api";
import {
  centreOf,
  cexGroupsOf,
  cexSlots,
  clusterHalos,
  exchangeName,
  graphBounds,
  HALO_PAD,
  nodeSlot,
  placeLabels,
  regroupLayout,
  sameTimeSlot,
  sideMembers,
  bubbleNameLines,
  type SideGroup,
  type FlagsRead,
  type BubbleGraph,
  type MapNode,
} from "./bubbleMap";
import { countCutFor, SAFETY_REJECT_LINKED_COUNT } from "./components/AlertCard";
import { shortAddress, tokenLabel } from "./format";
import { isFomoName, isPumpfunName, isUsername, walletText, type WalletNames } from "./walletNames";
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
} from "./shareCard";

/** The map's cluster colours on the dark card: the dashboard's dark slots (styles.css .bm-modal). */
const CLUSTER = ["#3987e5", "#199e70", "#d95926", "#8b5cf6", "#06b6d4", "#84cc16", "#ec4899"];
const RISK = "#ef4444";
const DEV = "#fab219";
/** The map's pills on the card: their text size, side padding and height, in card pixels. */
const PILL_FONT = 16;
const PILL_PAD = 11;
const PILL_H = 28;

/** The exchanges' colours (styles.css --bm-cex-0 to --bm-cex-3; bubbleMap CEX_COLOURS). */
const CEX = ["#a5b4fc", "#5eead4", "#fda4af", "#f0abfc"];
/** The most the map is scaled up, so a small one isn't blown up past readable proportions. */
const MAX_SCALE = 3;
/** KOLs' possible side wallets: the map's dotted gold (styles.css --bm-side). */
const SIDE = "#f5b324";

/** A colour slot's colour (nodeSlot / sameTimeSlot); grey for none. */
const slotColour = (slot: number | null) => (slot === null ? OTHER : CLUSTER[slot % CLUSTER.length]!);
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
export async function renderBubbleCard(
  graph: BubbleGraph,
  token: Token,
  names: WalletNames = {},
  /**
   * cex: draw the same-exchange ties, laid out by exchange, as the map shows them when they're on.
   * sides: the KOLs whose possible side wallets the map ties to them, drawn and listed the same way.
   * flags: whether the flagged-wallet read came back; until it does the risky count isn't known,
   * and the card says so instead of implying none.
   */
  opts: { cex?: boolean; sides?: readonly SideGroup[]; flags?: FlagsRead } = {},
): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  const label = tokenLabel(token);
  frame(ctx, icon, "", "", {
    // No badge: the map takes the card's top right too (user ask 2026-10-14, a larger map); the
    // coin's line says "bubble map" instead.
    badge: () => undefined,
    footer: `Top holders sized by share of supply · ${shortAddress(token.mintAddress)}`,
    link: "trenchscanner.app",
    time: true,
  });

  // Left column: the coin, the linked share, the clusters; kept narrow so the map gets most of the
  // card (user ask 2026-10-14).
  const leftW = 340;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `750 40px ${FONT}`;
  ctx.fillText(clip(ctx, label, leftW), PAD, 176);
  ctx.fillStyle = INK2;
  ctx.font = `500 21px ${FONT}`;
  // Without clusters the card is about the holders themselves (every token view has the map).
  const holdersOnly = graph.clusters.length === 0;
  const topic = "bubble map";
  const name =
    token.name && token.symbol ? `${token.name} · ${topic}` : topic[0]!.toUpperCase() + topic.slice(1);
  ctx.fillText(clip(ctx, name, leftW), PAD, 210);

  const linked = graph.linkedPct;
  const count = graph.linkedCount;
  const holders = graph.nodes.filter((n) => n.kind === "holder").length;
  const held = graph.nodes.filter((n) => n.kind === "holder").reduce((t, n) => t + n.pct, 0);
  // Red at the app's cut: the Linked tile's count against the screen's 20 of 25.
  ctx.fillStyle =
    !holdersOnly && count !== null && count.linked >= countCutFor(SAFETY_REJECT_LINKED_COUNT, count.of)
      ? "#ff8080"
      : INK;
  ctx.font = `800 62px ${FONT}`;
  const big = holdersOnly
    ? pctText(graph.top10Pct ?? held)
    : linked === null
      ? "–"
      : count
        ? `${count.linked}/${count.of}`
        : pctText(linked);
  ctx.fillText(big, PAD, 300);
  const bigW = ctx.measureText(big).width;
  ctx.fillStyle = MUTED;
  ctx.font = `500 17px ${FONT}`;
  if (holdersOnly) {
    ctx.fillText("of supply held by", PAD + bigW + 16, 272);
    ctx.fillText(`the top ${graph.top10Pct !== null ? 10 : holders} holders`, PAD + bigW + 16, 296);
  } else if (count && linked !== null) {
    ctx.fillText("top holders linked,", PAD + bigW + 16, 272);
    ctx.fillText(`holding ${pctText(linked)}`, PAD + bigW + 16, 296);
  } else {
    ctx.fillText("of supply in", PAD + bigW + 16, 272);
    ctx.fillText("linked wallets", PAD + bigW + 16, 296);
  }

  // Each KOL's possible side wallets on the map, listed like a funder's cluster (user ask 2026-10-14).
  const sideRows = (opts.sides ?? [])
    .map((g) => ({ g, members: sideMembers(graph, g) }))
    .filter((s) => s.members.length >= 2);
  let y = 350;
  // Room for five rows: up to four clusters, or three and up to two KOLs.
  const rows = graph.clusters.slice(0, sideRows.length > 0 ? 3 : 4);
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
      clip(ctx, ` ← ${walletText(c.funder, names)}${c.creatorLinked ? " · dev" : ""}`, leftW - 120 - w1),
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
  const sideShown = sideRows.slice(0, Math.min(2, 5 - rows.length));
  for (const { g, members } of sideShown) {
    // A gold ring with a dotted edge: the map's side-wallet key.
    ctx.strokeStyle = SIDE;
    ctx.lineWidth = 3;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(PAD + 9, y - 7, 7.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const sideCount = members.filter((m) => m.wallet !== g.kolWallet).length;
    const lead = `${sideCount} side${sideCount === 1 ? "" : "s"}?`;
    ctx.fillStyle = INK;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(lead, PAD + 30, y);
    const w1 = ctx.measureText(lead).width;
    ctx.fillStyle = SIDE;
    ctx.font = `500 17px ${MONO}`;
    const kolName = names[g.kolWallet]?.name ?? g.kolName ?? walletText(g.kolWallet, names);
    ctx.fillText(clip(ctx, ` ← ${kolName}`, leftW - 120 - w1), PAD + 30 + w1, y);
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 20px ${FONT}`;
    ctx.fillText(pctText(members.reduce((t, m) => t + m.pct, 0)), PAD + leftW, y);
    ctx.textAlign = "left";
    y += 40;
  }
  if (holdersOnly) {
    ctx.fillStyle = INK2;
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(
      linked === 0 ? "No two of them share a funder" : "Who funded them isn't checked yet",
      PAD,
      y,
    );
    y += 40;
  }
  if (graph.clusters.length > rows.length) {
    ctx.fillStyle = MUTED;
    ctx.font = `500 17px ${FONT}`;
    ctx.fillText(`and ${graph.clusters.length - rows.length} more`, PAD + 30, y - 6);
    y += 28;
  }
  const risky = graph.nodes.filter((n) => n.kind === "holder" && n.flags.some((f) => f !== "creator")).length;
  if ((opts.flags ?? "ok") !== "ok" && y < CARD_H - 110) {
    // No ringless map passed off as clean: the flagged wallets weren't read.
    ctx.fillStyle = MUTED;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText("Risky wallets: not read", PAD, y + 4);
    y += 32;
  } else if (risky > 0 && y < CARD_H - 110) {
    ctx.fillStyle = RISK;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(`${risky} risky wallet${risky === 1 ? "" : "s"} among the holders`, PAD, y + 4);
    y += 32;
  }
  const sameWallets = graph.nodes.filter((n) => n.sameTime !== null).length;
  if (sameWallets > 0 && graph.sameTimePct !== null && y < CARD_H - 110) {
    ctx.fillStyle = INK2;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(
      clip(
        ctx,
        graph.sameTimeCount
          ? `${graph.sameTimeCount.linked}/${graph.sameTimeCount.of} funded the same minute, holding ${pctText(graph.sameTimePct)}`
          : `${pctText(graph.sameTimePct)} in ${sameWallets} wallets funded the same minute`,
        leftW,
      ),
      PAD,
      y + 4,
    );
  }

  // With the exchange ties on: which exchanges funded which holders, in their colours.
  const cex = opts.cex && graph.cexLinks.length > 0;
  const exchanges = cex ? cexGroupsOf(graph) : [];
  const cexSlot = cex ? cexSlots(graph) : new Map<string, number>();
  const exchangeText = (funder: string) => {
    const named = names[funder];
    return named ? exchangeName(named.name) : walletText(funder, names);
  };
  if (exchanges.length > 0) {
    y += 36;
    ctx.font = `600 18px ${FONT}`;
    let x = PAD;
    for (const g of exchanges.slice(0, 3)) {
      const text = `${exchangeText(g.funder)} ${g.nodes.length}`;
      const w = ctx.measureText(text).width;
      if (x + 22 + w > PAD + leftW || y > CARD_H - 110) break;
      ctx.fillStyle = CEX[(cexSlot.get(g.funder) ?? 0) % CEX.length]!;
      ctx.beginPath();
      ctx.arc(x + 7, y - 2, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK2;
      ctx.fillText(text, x + 20, y + 4);
      x += 20 + w + 22;
    }
  }

  // Right: the map, fitted into its box; regrouped by exchange and by KOL when those ties show, as on the map.
  const sideGroups = sideRows.map((s) => s.g);
  const map = cex || sideGroups.length > 0 ? regroupLayout(graph, { cex, sides: sideGroups }) : graph;
  // Which kinds of name the bubbles carry, for the legend under the map (user ask 2026-10-14).
  const legend = nameLegend(graph, names);
  // From the card's top to the footer's rule (CARD_H - 82), less the legend under it.
  const area = {
    x: PAD + leftW + 8,
    y: 24,
    w: CARD_W - 12 - (PAD + leftW + 8),
    h: CARD_H - 92 - 24 - (legend.length > 0 ? LEGEND_H : 0),
  };
  // The pills are sized in pixels on the card (readable at share size), so in map units they shrink
  // as the map scales up: estimate the scale without them first, then place them at that size.
  const bare = graphBounds(map, 10);
  const scale0 = Math.min(area.w / bare.w, area.h / bare.h, MAX_SCALE);
  ctx.font = `600 ${PILL_FONT}px ${FONT}`;
  const pillSize = (text: string) => ({
    w: (ctx.measureText(text).width + PILL_PAD * 2) / scale0,
    h: PILL_H / scale0,
  });
  // Each funder's name on a pill by its diamond, in its cluster's colour, as the dialog labels it;
  // a pill that had to move off keeps a line back to it.
  const hubs: {
    id: string;
    x: number;
    y: number;
    r: number;
    w: number;
    h: number;
    text: string;
    colour: string;
    members: MapNode[];
    dashed: boolean;
    dotted: boolean;
    funder?: boolean;
  }[] = [];
  ctx.font = `600 ${PILL_FONT - 1}px ${MONO}`;
  for (const n of map.nodes) {
    if (n.kind !== "funder" || !n.wallet) continue;
    const text = walletText(n.wallet, names);
    const short = text.length > 18 ? `${text.slice(0, 17)}…` : text;
    hubs.push({
      id: n.id,
      x: n.x,
      y: n.y,
      r: n.r,
      w: (ctx.measureText(short).width + PILL_PAD * 2) / scale0,
      h: PILL_H / scale0,
      text: short,
      colour: slotColour(nodeSlot(n, map)),
      members: [],
      dashed: false,
      dotted: false,
      funder: true,
    });
  }
  ctx.font = `600 ${PILL_FONT}px ${FONT}`;
  // Each same-minute group's pill, a hub tied to its wallets by solid lines, as the dialog draws it.
  map.sameTimeGroups.forEach((g, i) => {
    const members = map.nodes.filter((n): n is MapNode => n.kind === "holder" && n.sameTime === i);
    if (members.length === 0) return;
    // No time on the share image (user ask 2026-10-14): the group's colour tells them apart.
    const text = "Funded together";
    hubs.push({
      id: `same:${i}`,
      ...centreOf(members),
      r: 0,
      ...pillSize(text),
      text,
      colour: slotColour(sameTimeSlot(map, i)),
      members,
      dashed: false,
      dotted: false,
    });
  });
  // Each exchange's pill, its name alone and in full, tied to its holders by dashed lines in its colour.
  if (cex) {
    for (const g of cexGroupsOf(map)) {
      if (g.nodes.length === 0) continue;
      const text = exchangeText(g.funder);
      hubs.push({
        id: `cex:${g.funder}`,
        ...centreOf(g.nodes),
        r: 0,
        ...pillSize(text),
        text,
        colour: CEX[(cexSlot.get(g.funder) ?? 0) % CEX.length]!,
        members: [...g.nodes],
        dashed: true,
        dotted: false,
      });
    }
  }
  // Each KOL's pill, tied to it and its possible side wallets by dotted gold lines.
  for (const g of sideGroups) {
    const members = sideMembers(map, g);
    const kolName = names[g.kolWallet]?.name ?? g.kolName ?? walletText(g.kolWallet, names);
    const text = `${kolName.length > 16 ? `${kolName.slice(0, 15)}…` : kolName} sides?`;
    hubs.push({
      id: `side:${g.kolWallet}`,
      ...centreOf(members),
      r: 0,
      ...pillSize(text),
      text,
      colour: SIDE,
      members,
      dashed: false,
      dotted: true,
    });
  }
  const placed = placeLabels(map, hubs);
  const box = graphBounds(map, 10, placed);
  const scale = Math.min(area.w / box.w, area.h / box.h, MAX_SCALE);
  const ox = area.x + (area.w - box.w * scale) / 2 - box.x * scale;
  const oy = area.y + (area.h - box.h * scale) / 2 - box.y * scale;
  const X = (v: number) => ox + v * scale;
  const Y = (v: number) => oy + v * scale;
  const index = new Map(map.nodes.map((n) => [n.id, n]));

  // Each cluster's halo, as in the dialog: drawn solid on a layer of its own, then laid down
  // faintly, so the overlapping bubbles and bands don't darken.
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  const lc = layer.getContext("2d");
  if (lc) {
    const ratio = canvas.width / CARD_W;
    for (const h of clusterHalos(map)) {
      lc.setTransform(ratio, 0, 0, ratio, 0, 0);
      lc.clearRect(0, 0, CARD_W, CARD_H);
      const col = CLUSTER[h.cluster % CLUSTER.length]!;
      lc.fillStyle = col;
      lc.strokeStyle = col;
      lc.lineCap = "round";
      lc.lineWidth = HALO_PAD * 2.4 * scale;
      for (const b of h.bands) {
        lc.beginPath();
        lc.moveTo(X(b.x1), Y(b.y1));
        lc.lineTo(X(b.x2), Y(b.y2));
        lc.stroke();
      }
      lc.beginPath();
      for (const c of h.circles) {
        lc.moveTo(X(c.x) + c.r * scale, Y(c.y));
        lc.arc(X(c.x), Y(c.y), c.r * scale, 0, Math.PI * 2);
      }
      lc.fill();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.16;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }
  }

  ctx.lineCap = "round";
  for (const l of map.links) {
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

  // Each pill's ties to its wallets: solid for a same-minute group, dashed for an exchange.
  ctx.lineWidth = Math.max(1.5, 1.6 * scale);
  hubs.forEach((hub, i) => {
    const p = placed[i]!;
    if (hub.funder) {
      if (!p.far) return;
      ctx.strokeStyle = alpha(hub.colour, 0.6);
      ctx.beginPath();
      ctx.moveTo(X(hub.x), Y(hub.y));
      ctx.lineTo(X(p.x), Y(p.y));
      ctx.stroke();
      return;
    }
    ctx.strokeStyle = alpha(hub.colour, hub.dashed || hub.dotted ? 0.9 : 0.6);
    ctx.setLineDash(hub.dashed ? [7, 6] : hub.dotted ? [2, 5] : []);
    for (const m of hub.members) {
      const mx = (p.x + m.x) / 2 + (m.y - p.y) * 0.12;
      const my = (p.y + m.y) / 2 - (m.x - p.x) * 0.12;
      ctx.beginPath();
      ctx.moveTo(X(p.x), Y(p.y));
      ctx.quadraticCurveTo(X(mx), Y(my), X(m.x), Y(m.y));
      ctx.stroke();
    }
  });
  ctx.setLineDash([]);

  const order = [...map.nodes].sort((a, b) => b.r - a.r);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of order) {
    const cx = X(n.x);
    const cy = Y(n.y);
    const r = n.r * scale;
    const col = slotColour(nodeSlot(n, map));
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
    // The glossy highlight, as in the dialog.
    ctx.save();
    ctx.translate(cx - r * 0.32, cy - r * 0.42);
    ctx.rotate(-Math.PI / 6);
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.42, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (n.sameTime !== null) {
      ctx.strokeStyle = slotColour(sameTimeSlot(map, n.sameTime));
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r + (risk ? 13 : 6), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (risk) {
      ctx.strokeStyle = RISK;
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // The % and, under it, the wallet's name, sized and wrapped as the dialog does (bubbleNameLines).
    const named = n.wallet ? names[n.wallet] : undefined;
    const fit = named ? bubbleNameLines(n.r, named.name, isUsername(named)) : null;
    const pctSize = Math.max(12, Math.min(28, r * 0.42));
    const nameSize = fit ? Math.max(11, fit.size * scale) : 0;
    const lineH = nameSize * 1.15;
    const pctY = fit ? cy - (fit.lines.length * lineH) / 2 - 1 : cy + 1;
    if (r >= 22) {
      ctx.fillStyle = INK;
      ctx.font = `750 ${pctSize}px ${FONT}`;
      ctx.fillText(pctText(n.pct), cx, pctY);
    }
    if (fit && named) {
      const nameY =
        r >= 22 ? pctY + pctSize * 0.62 + nameSize * 0.62 : cy - ((fit.lines.length - 1) * lineH) / 2;
      ctx.font = `650 ${nameSize}px ${FONT}`;
      const text = fit.lines;
      const w = Math.max(...text.map((l) => ctx.measureText(l).width));
      const kol = named.source === "kol";
      // A KOL's name on gold, as in the dialog; any other gets a dark backing when it runs past the edge.
      if (kol || w > r * 1.7) {
        ctx.fillStyle = kol ? SIDE : "rgba(12, 14, 20, 0.82)";
        ctx.beginPath();
        ctx.roundRect(
          cx - w / 2 - 5,
          nameY - nameSize * 0.72,
          w + 10,
          text.length * lineH + nameSize * 0.3,
          5,
        );
        ctx.fill();
      }
      ctx.fillStyle = kol
        ? "#1a1300"
        : isPumpfunName(named)
          ? "#4ade80"
          : isFomoName(named)
            ? "#c4b5fd"
            : INK;
      text.forEach((l, j) => ctx.fillText(l, cx, nameY + j * lineH));
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
  // The groups' pills, over the bubbles, where placeLabels found them room.
  hubs.forEach((hub, i) => {
    const p = placed[i]!;
    ctx.font = hub.funder ? `600 ${PILL_FONT - 1}px ${MONO}` : `600 ${PILL_FONT}px ${FONT}`;
    const w = ctx.measureText(hub.text).width + PILL_PAD * 2;
    const h = PILL_H;
    ctx.fillStyle = "#1b1e28";
    ctx.strokeStyle = hub.colour;
    ctx.lineWidth = 2;
    ctx.setLineDash(hub.dashed ? [5, 4] : hub.dotted ? [2, 3] : []);
    ctx.beginPath();
    ctx.roundRect(X(p.x) - w / 2, Y(p.y) - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    ctx.fillText(hub.text, X(p.x), Y(p.y) + 1);
  });
  // The legend: one chip per kind of name on the map, its own name written as those names are
  // (user ask 2026-10-14: KOL, "Pump.fun", "FOMO"), centred under it.
  if (legend.length > 0) {
    ctx.font = `650 14px ${FONT}`;
    const widths = legend.map((k) => ctx.measureText(k.text).width + 16);
    // A faint italic "Legend" before the chips (user ask 2026-10-14).
    ctx.font = `italic 500 14px ${FONT}`;
    const titleW = ctx.measureText("Legend").width + 12;
    const total = titleW + widths.reduce((t, w) => t + w, 0) + (legend.length - 1) * 10;
    let x = area.x + (area.w - total) / 2;
    const ly = area.y + area.h + LEGEND_H / 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = alpha("#ffffff", 0.5);
    ctx.fillText("Legend", x, ly + 1);
    x += titleW;
    ctx.font = `650 14px ${FONT}`;
    ctx.textAlign = "center";
    legend.forEach((c, i) => {
      ctx.fillStyle = c.bg;
      ctx.beginPath();
      ctx.roundRect(x, ly - 12, widths[i]!, 24, 6);
      ctx.fill();
      ctx.fillStyle = c.ink;
      ctx.fillText(c.text, x + widths[i]! / 2, ly + 1);
      x += widths[i]! + 10;
    });
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return canvas;
}

/** The legend's height under the map, card pixels. */
const LEGEND_H = 34;

/** The kinds of wallet name on the map's holders, in a fixed order: each kind's name, drawn as those names are. */
function nameLegend(graph: BubbleGraph, names: WalletNames): { text: string; bg: string; ink: string }[] {
  const kinds = new Set(
    graph.nodes.flatMap((n) =>
      n.kind === "holder" && n.wallet && names[n.wallet] ? [names[n.wallet]!.source] : [],
    ),
  );
  const dark = "rgba(12, 14, 20, 0.82)";
  const out: { text: string; bg: string; ink: string }[] = [];
  if (kinds.has("kol")) out.push({ text: "KOL", bg: SIDE, ink: "#1a1300" });
  if (kinds.has("pumpfun")) out.push({ text: '"Pump.fun"', bg: dark, ink: "#4ade80" });
  if (kinds.has("fomo")) out.push({ text: '"FOMO"', bg: dark, ink: "#c4b5fd" });
  if (kinds.has("identity") || kinds.has("exchange"))
    out.push({ text: "Helius / exchange", bg: dark, ink: INK });
  return out;
}
