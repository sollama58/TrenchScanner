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
  needsRegroup,
  bundleOutline,
  kolBundleNodes,
  clusterNumberText,
  funderNamed,
  largestSourceOnly,
  mapLinked,
  TRAIT_ICON,
  TRAIT_LABEL,
  traitShares,
  RISKY_ICON,
  riskyShare,
  type WalletTrait,
  type KolControl,
  type ClusterHalo,
  sameTimeSlot,
  sideMembers,
  sideCounts,
  sideWord,
  bubbleNameLines,
  showsPct,
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
/** Each wallet trait's icon colour (styles.css --bm-trait-*, on the card's dark ground). */
const TRAIT_INK: Record<WalletTrait, string> = { sniper: "#fb923c", fresh: "#4ade80", empty: "#cbd5e1" };

/** A wallet trait's icon, `size` across, centred on x, y (TRAIT_ICON's 24px grid). */
function drawTraitIcon(
  ctx: CanvasRenderingContext2D,
  trait: WalletTrait,
  x: number,
  y: number,
  size: number,
) {
  drawIcon(ctx, TRAIT_ICON[trait], TRAIT_INK[trait], x, y, size);
}
/** A 24px-grid stroke icon in `ink`, `size` across, centred on x, y. */
function drawIcon(
  ctx: CanvasRenderingContext2D,
  paths: readonly string[],
  ink: string,
  x: number,
  y: number,
  size: number,
) {
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const d of paths) ctx.stroke(new Path2D(d));
  ctx.restore();
}
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
/** Each KOL's colour on the card, by its place among the map's KOLs (styles.css --bm-kol-0 to 2). */
const KOL_COLOURS = [SIDE, "#dfe3ea", "#34d399"];
const kolColour = (i: number) => KOL_COLOURS[Math.max(0, i) % KOL_COLOURS.length]!;
/** Half the width of the bands joining a KOL's bundle outline, map units (bundleOutline's pad less a little). */
const BUNDLE_BAND = 10;

/** The left column's bundle list: its first baseline, row height, and the room it can't pass. */
const LIST_TOP = 344;
const ROW_H = 31;
const MORE_H = 24;
const NOTE_H = 27;
const LEFT_BOTTOM = CARD_H - 98;
/** The fewest bundle rows the card lists when there are that many (user ask 2026-10-15). */
const MIN_ROWS = 6;

/** A row in the card's bundle list: a funder's cluster, a same-minute group or a KOL's sides. */
interface Bundle {
  pct: number;
  mark: { colour: string } | { side: string };
  lead: string;
  from: string;
  fromColour: string;
  /** What groups it (cluster, same minute, KOL) and its wallets, for largestSourceOnly. */
  kind: string;
  wallets: readonly string[];
}

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
  opts: {
    cex?: boolean;
    sides?: readonly SideGroup[];
    flags?: FlagsRead;
    /** KOL Bundled %, listed under the readings when KOLs bundle any supply. */
    kolBundled?: number | null;
    /**
     * Each KOL's bundle (kolControl): outlined on the map with the KOL's name and share, and listed
     * in place of its side wallets (user ask 2026-10-15).
     */
    kols?: readonly KolControl[];
  } = {},
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
  const topic = "bubble map";
  const name =
    token.name && token.symbol ? `${token.name} · ${topic}` : topic[0]!.toUpperCase() + topic.slice(1);
  ctx.fillText(clip(ctx, name, leftW), PAD, 210);

  // KOLs' bundles and the wider map's links counted too, as the dialog's Linked tile (mapLinked).
  const { pct: linked, count } = mapLinked(graph, opts.kols);
  const holders = graph.nodes.filter((n) => n.kind === "holder").length;
  const held = graph.nodes.filter((n) => n.kind === "holder").reduce((t, n) => t + n.pct, 0);
  // Red at the app's cut: the Linked tile's count against the screen's 20 of 25.
  ctx.fillStyle =
    count !== null && count.linked >= countCutFor(SAFETY_REJECT_LINKED_COUNT, count.of) ? "#ff8080" : INK;
  ctx.font = `800 62px ${FONT}`;
  // The headline is the bundled share (user ask 2026-10-15): supply in a funder's cluster or a
  // KOL's bundle (mapLinked; same-exchange holders aren't a confirmed bundle), with the count
  // beside it. Before the funders are read, the top holders' share stands in, said as such.
  const big = linked !== null ? pctText(linked) : pctText(graph.top10Pct ?? held);
  ctx.fillText(big, PAD, 300);
  const bigW = ctx.measureText(big).width;
  ctx.fillStyle = MUTED;
  ctx.font = `500 17px ${FONT}`;
  if (linked !== null) {
    ctx.fillText("of supply bundled,", PAD + bigW + 16, 272);
    ctx.fillText(
      count ? `${count.linked}/${count.of} top holders linked` : "KOL bundles counted",
      PAD + bigW + 16,
      296,
    );
  } else {
    ctx.fillText("of supply held by", PAD + bigW + 16, 272);
    ctx.fillText(`the top ${graph.top10Pct !== null ? 10 : holders} holders`, PAD + bigW + 16, 296);
  }

  // Each KOL's possible side wallets on the map, listed like a funder's cluster (user ask 2026-10-14).
  const sideRows = (opts.sides ?? [])
    .map((g) => ({ g, members: sideMembers(graph, g) }))
    .filter((s) => s.members.length >= 2);
  // With the exchange ties on: which exchanges funded which holders, in their colours.
  const cex = opts.cex && graph.cexLinks.length > 0;
  const exchanges = cex ? cexGroupsOf(graph) : [];
  const cexSlot = cex ? cexSlots(graph) : new Map<string, number>();
  const exchangeText = (funder: string) => {
    const named = names[funder];
    return named ? exchangeName(named.name) : walletText(funder, names);
  };

  // Every bundle on the map in one list, largest share first (user ask 2026-10-15): funders'
  // clusters, same-minute groups and KOLs' side wallets, in rows tight enough for at least six.
  // A bundle under two kinds lists once, under the largest, as under the map (user ask 2026-10-15).
  const walletsOf = (nodes: readonly MapNode[]) => nodes.flatMap((n) => (n.wallet ? [n.wallet] : []));
  const bundles: Bundle[] = largestSourceOnly<Bundle>([
    ...graph.clusters.map((c, i) => ({
      kind: "cluster",
      wallets: c.wallets.map((w) => w.wallet),
      pct: c.pct,
      mark: { colour: slotColour(i % CLUSTER.length) },
      lead: `${c.wallets.length} wallets`,
      from: `${clusterNumberText(graph, i, names) ?? walletText(c.funder, names)}${c.creatorLinked ? " · dev" : ""}`,
      fromColour: MUTED,
    })),
    ...graph.sameTimeGroups.flatMap((_, i) => {
      const members = graph.nodes.filter((n) => n.kind === "holder" && n.sameTime === i);
      if (members.length < 2) return [];
      return [
        {
          kind: "same-minute",
          wallets: walletsOf(members),
          pct: members.reduce((t, m) => t + m.pct, 0),
          mark: { colour: slotColour(sameTimeSlot(graph, i)) },
          lead: `${members.length} wallets`,
          from: "same minute",
          fromColour: MUTED,
        },
      ];
    }),
    ...(opts.kols ?? [])
      .filter((k) => kolBundleNodes(graph, k).members.length >= 2)
      .map((k) => ({
        kind: "kol",
        wallets: k.wallets.map((w) => w.wallet),
        pct: k.pct,
        mark: { side: kolColour((opts.kols ?? []).indexOf(k)) },
        lead: `${k.wallets.length} wallets`,
        from: names[k.kolWallet]?.name ?? k.kolName ?? walletText(k.kolWallet, names),
        fromColour: kolColour((opts.kols ?? []).indexOf(k)),
      })),
    ...(opts.kols ? [] : sideRows).map(({ g, members }) => {
      const { known, funded, possible } = sideCounts(members, g);
      const all = known + funded + possible;
      return {
        kind: "kol",
        wallets: walletsOf(members),
        pct: members.reduce((t, m) => t + m.pct, 0),
        mark: { side: SIDE },
        lead:
          possible === 0 && known === 0
            ? `${funded} funded`
            : `${all} side${all === 1 ? "" : "s"}${funded + known > 0 ? "" : "?"}`,
        from: names[g.kolWallet]?.name ?? g.kolName ?? walletText(g.kolWallet, names),
        fromColour: SIDE,
      };
    }),
  ]).sort((a, b) => b.pct - a.pct);

  // The lines under the list, each on if it has something to say; the list takes the room left,
  // never fewer than six rows (or every bundle when there are fewer).
  // The risky share sits in the legend with the wallet types (user ask 2026-10-16); a line here
  // only says when the flagged wallets weren't read.
  const sameWallets = graph.nodes.filter((n) => n.sameTime !== null).length;
  const notes: { colour: string; text: string }[] = [];
  if ((opts.flags ?? "ok") !== "ok") notes.push({ colour: MUTED, text: "Risky wallets: not read" });
  // KOL Bundled % (user ask 2026-10-14): supply held by KOLs and the holders tied to them.
  if (opts.kolBundled != null && opts.kolBundled > 0)
    notes.push({ colour: SIDE, text: `KOL bundled ${pctText(opts.kolBundled)} of supply` });
  if (sameWallets > 0 && graph.sameTimePct !== null)
    notes.push({
      colour: INK2,
      text: graph.sameTimeCount
        ? `${graph.sameTimeCount.linked}/${graph.sameTimeCount.of} funded the same minute, holding ${pctText(graph.sameTimePct)}`
        : `${pctText(graph.sameTimePct)} in ${sameWallets} wallets funded the same minute`,
    });
  // Without a bundle to list, a line on why: no two share a funder, or the funders aren't read yet.
  const holdersNote =
    bundles.length > 0
      ? null
      : graph.linkedPct === null
        ? "Who funded them isn't checked yet"
        : "No two of them share a funder";
  const notesH = notes.length * NOTE_H + (exchanges.length > 0 ? 36 : 0) + (holdersNote ? NOTE_H : 0);
  const fits = (n: number) =>
    LIST_TOP + n * ROW_H + (bundles.length > n ? MORE_H : 0) + notesH <= LEFT_BOTTOM;
  let shown = Math.min(bundles.length, MIN_ROWS);
  while (shown < bundles.length && fits(shown + 1)) shown++;

  let y = LIST_TOP;
  for (const b of bundles.slice(0, shown)) {
    if ("colour" in b.mark) {
      ctx.fillStyle = b.mark.colour;
      ctx.beginPath();
      ctx.arc(PAD + 8, y - 6, 8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // A ring with a dotted edge in the KOL's colour: the map's KOL key.
      ctx.strokeStyle = b.mark.side;
      ctx.lineWidth = 3;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(PAD + 8, y - 6, 6.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = INK;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(b.lead, PAD + 26, y);
    const w1 = ctx.measureText(b.lead).width;
    ctx.fillStyle = b.fromColour;
    ctx.font = `500 15px ${MONO}`;
    ctx.fillText(clip(ctx, ` ← ${b.from}`, leftW - 100 - w1), PAD + 26 + w1, y);
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 18px ${FONT}`;
    ctx.fillText(pctText(b.pct), PAD + leftW, y);
    ctx.textAlign = "left";
    y += ROW_H;
  }
  if (bundles.length > shown) {
    ctx.fillStyle = MUTED;
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(`and ${bundles.length - shown} more`, PAD + 26, y - 6);
    y += MORE_H;
  }
  if (holdersNote) {
    ctx.fillStyle = INK2;
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(holdersNote, PAD, y);
    y += NOTE_H;
  }
  for (const n of notes) {
    if (y > LEFT_BOTTOM) break;
    ctx.fillStyle = n.colour;
    ctx.font = `600 17px ${FONT}`;
    ctx.fillText(clip(ctx, n.text, leftW), PAD, y);
    y += NOTE_H;
  }
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
  const kols = opts.kols ?? [];
  const regroup = { cex, sides: sideGroups, kols };
  const map = needsRegroup(regroup) ? regroupLayout(graph, regroup) : graph;
  // Each KOL's bundle on the laid-out map, with two or more of its holders there.
  const kolBundles = kols
    .map((k, i) => ({ k, colour: kolColour(i), ...kolBundleNodes(map, k) }))
    .filter((b) => b.members.length >= 2);
  // Which kinds of name the bubbles carry, for the legend under the map (user ask 2026-10-14).
  const legend = nameLegend(graph, names, (opts.flags ?? "ok") === "ok");
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
    // As under the map, an unknown funder's diamond goes unlabeled (user ask 2026-10-15).
    if (n.kind !== "funder" || !n.wallet || !funderNamed(map, n.wallet, names)) continue;
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
  // Each KOL's pill, its name and its bundle's share, by the KOL's own bubble when it holds (user
  // ask 2026-10-15); its possible side wallets tied to the KOL by dotted gold lines.
  const sideByKol = new Map(sideGroups.map((g) => [g.kolWallet, g]));
  const kolSpokes: { from: MapNode; to: MapNode; colour: string }[] = [];
  for (const { k, kol, members, colour } of kolBundles) {
    const kolName = names[k.kolWallet]?.name ?? k.kolName ?? walletText(k.kolWallet, names);
    const text = `${kolName.length > 16 ? `${kolName.slice(0, 15)}…` : kolName} ${pctText(k.pct)}`;
    const g = sideByKol.get(k.kolWallet);
    const sides = g ? sideMembers(map, g).filter((n) => n !== kol) : [];
    if (kol) for (const n of sides) kolSpokes.push({ from: kol, to: n, colour });
    hubs.push({
      id: `kol:${k.kolWallet}`,
      ...(kol ? { x: kol.x, y: kol.y, r: kol.r } : { ...centreOf(members), r: 0 }),
      ...pillSize(text),
      text,
      colour,
      members: kol ? [] : sides,
      dashed: false,
      dotted: true,
      funder: !!kol,
    });
  }
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
  // Without the bundles (an older caller), each KOL's side wallets on a pill of their own.
  for (const g of kols.length > 0 ? [] : sideGroups) {
    const members = sideMembers(map, g);
    const kolName = names[g.kolWallet]?.name ?? g.kolName ?? walletText(g.kolWallet, names);
    const text = `${kolName.length > 16 ? `${kolName.slice(0, 15)}…` : kolName} ${sideWord(members, g)}`;
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

  // Each KOL's bundle: a gold outline round its bubbles, joined along the shortest ties, faintly
  // filled (user ask 2026-10-15). Drawn on its own layer: the shape, less the same shape a stroke
  // smaller, leaves the outline.
  const outline = document.createElement("canvas");
  outline.width = canvas.width;
  outline.height = canvas.height;
  const oc = outline.getContext("2d");
  if (oc) {
    const ratio = canvas.width / CARD_W;
    const band = BUNDLE_BAND * 2 * scale;
    const shape = (o: Pick<ClusterHalo, "circles" | "bands">, inset: number) => {
      oc.lineCap = "round";
      oc.lineWidth = Math.max(0.1, band - inset * 2);
      for (const b of o.bands) {
        oc.beginPath();
        oc.moveTo(X(b.x1), Y(b.y1));
        oc.lineTo(X(b.x2), Y(b.y2));
        oc.stroke();
      }
      oc.beginPath();
      for (const c of o.circles) {
        const r = Math.max(0.1, c.r * scale - inset);
        oc.moveTo(X(c.x) + r, Y(c.y));
        oc.arc(X(c.x), Y(c.y), r, 0, Math.PI * 2);
      }
      oc.fill();
    };
    for (const b of kolBundles) {
      const o = bundleOutline(b.members);
      oc.setTransform(ratio, 0, 0, ratio, 0, 0);
      oc.globalCompositeOperation = "source-over";
      oc.clearRect(0, 0, CARD_W, CARD_H);
      oc.fillStyle = b.colour;
      oc.strokeStyle = b.colour;
      shape(o, 0);
      // The faint fill first, then the outline alone.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.07;
      ctx.drawImage(outline, 0, 0);
      ctx.restore();
      oc.globalCompositeOperation = "destination-out";
      shape(o, 2.5);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(outline, 0, 0);
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
  // A KOL's possible side wallets, each tied to the KOL's bubble.
  ctx.setLineDash([2, 5]);
  for (const { from: a, to: b, colour } of kolSpokes) {
    ctx.strokeStyle = alpha(colour, 0.9);
    const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
    const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
    ctx.beginPath();
    ctx.moveTo(X(a.x), Y(a.y));
    ctx.quadraticCurveTo(X(mx), Y(my), X(b.x), Y(b.y));
    ctx.stroke();
  }
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
    // Every bubble down to 0.1% carries its amount, smaller under 1%, as on the map (showsPct).
    const showPct = showsPct(n.pct);
    const pctSize = n.pct < 1 ? Math.max(10, Math.min(13, r * 0.4)) : Math.max(12, Math.min(28, r * 0.42));
    const nameSize = fit ? Math.max(11, fit.size * scale) : 0;
    const lineH = nameSize * 1.15;
    const pctY = fit ? cy - (fit.lines.length * lineH) / 2 - 1 : cy + 1;
    if (showPct) {
      ctx.fillStyle = INK;
      ctx.font = `750 ${pctSize}px ${FONT}`;
      ctx.fillText(pctText(n.pct), cx, pctY);
    }
    if (fit && named) {
      const nameY = showPct
        ? pctY + pctSize * 0.62 + nameSize * 0.62
        : cy - ((fit.lines.length - 1) * lineH) / 2;
      ctx.font = `650 ${nameSize}px ${FONT}`;
      const text = fit.lines;
      const w = Math.max(...text.map((l) => ctx.measureText(l).width));
      // A KOL's Known Side is the KOL's own wallet: gold too.
      const kol = named.source === "kol" || named.source === "kol-side";
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
    // The wallet's trait, bottom right: a dark disc and its icon, as on the map (user ask 2026-10-15).
    if (n.trait) {
      const tx = cx + r * 0.72;
      const ty = cy + r * 0.72;
      ctx.fillStyle = "#1b1e28";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx, ty, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawTraitIcon(ctx, n.trait, tx, ty, 14);
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
    // A trait's item is its icon and its words, no chip (user ask 2026-10-15: kept minimal).
    const widths = legend.map((k) => ctx.measureText(k.text).width + (k.icon ? 20 : 16));
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
      if (c.icon) {
        drawIcon(ctx, c.icon, c.iconInk ?? c.ink, x + 8, ly, 15);
        ctx.fillStyle = c.ink;
        ctx.fillText(c.text, x + 20 + (widths[i]! - 20) / 2, ly + 1);
      } else {
        ctx.fillStyle = c.bg;
        ctx.beginPath();
        ctx.roundRect(x, ly - 12, widths[i]!, 24, 6);
        ctx.fill();
        ctx.fillStyle = c.ink;
        ctx.fillText(c.text, x + widths[i]! / 2, ly + 1);
      }
      x += widths[i]! + 10;
    });
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return canvas;
}

/** The legend's height under the map, card pixels. */
const LEGEND_H = 34;

/** A legend item: a chip with its name, or (with `icon`) an icon and words with no chip. */
interface LegendItem {
  text: string;
  bg: string;
  ink: string;
  icon?: readonly string[];
  iconInk?: string;
}

/** The kinds of wallet name on the map's holders, in a fixed order: each kind's name, drawn as those names are. */
function nameLegend(graph: BubbleGraph, names: WalletNames, flagsRead: boolean): LegendItem[] {
  const kinds = new Set(
    graph.nodes.flatMap((n) =>
      n.kind === "holder" && n.wallet && names[n.wallet] ? [names[n.wallet]!.source] : [],
    ),
  );
  const dark = "rgba(12, 14, 20, 0.82)";
  const out: LegendItem[] = [];
  if (kinds.has("kol")) out.push({ text: "KOL", bg: SIDE, ink: "#1a1300" });
  if (kinds.has("kol-side")) out.push({ text: "KOL Known Side", bg: SIDE, ink: "#1a1300" });
  if (kinds.has("pumpfun")) out.push({ text: '"Pump.fun"', bg: dark, ink: "#4ade80" });
  if (kinds.has("fomo")) out.push({ text: '"FOMO"', bg: dark, ink: "#c4b5fd" });
  if (kinds.has("identity") || kinds.has("exchange"))
    out.push({ text: "Helius / exchange", bg: dark, ink: INK });
  // Each wallet trait on the map and the share of supply its holders hold (user ask 2026-10-15).
  for (const t of traitShares(graph))
    out.push({
      text: `${TRAIT_LABEL[t.trait]} ${pctText(t.pct)}`,
      bg: dark,
      ink: INK2,
      icon: TRAIT_ICON[t.trait],
      iconInk: TRAIT_INK[t.trait],
    });
  // The risky holders' share of supply beside them, a red exclamation (user ask 2026-10-16).
  const risky = riskyShare(graph);
  if (flagsRead && risky.count > 0)
    out.push({ text: `Risky ${pctText(risky.pct)}`, bg: dark, ink: INK2, icon: RISKY_ICON, iconInk: RISK });
  return out;
}
