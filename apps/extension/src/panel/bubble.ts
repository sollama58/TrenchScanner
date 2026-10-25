import { isMintAddress } from "../shared/mint";
import type { OverlayBubbleHolder, OverlayBubbleMap, OverlayCount, OverlayTrait } from "../shared/types";
import { ago, trenchUrl } from "./card";

/**
 * A coin's bubble map in the panel (user ask 2026-10-24): its latest top holders as bubbles sized
 * by their share of supply, coloured by the cluster one funder paid for (a same-minute group's
 * bubbles dashed), each cluster tied to its largest holder, and above it the category totals the
 * site's map shows. The reading is the site's (apps/api/src/extensionBubble.ts); the full map,
 * with KOLs, risky wallets and transfers, is a click away on TrenchScanner. DOM calls only.
 */

const SVG = "http://www.w3.org/2000/svg";
/** The site's seven cluster colours (web styles.css --bm-0 to --bm-6), in the same order. */
export const CLUSTER_COLOURS = ["#a78bfa", "#f59e0b", "#3b82f6", "#ff7a35", "#06b6d4", "#84cc16", "#ec4899"];
const LONE = "#3a3e4c";
const VIEW_W = 320;
const VIEW_H = 210;
const GAP = 1.5;

export const TRAIT_LABEL: Record<OverlayTrait, { label: string; mark: string }> = {
  blockZero: { label: "Block zero", mark: "0" },
  sniper: { label: "Sniper", mark: "S" },
  fresh: { label: "Fresh", mark: "F" },
  empty: { label: "Empty", mark: "E" },
};

export interface PlacedBubble {
  holder: OverlayBubbleHolder;
  x: number;
  y: number;
  r: number;
}

/** A bubble's radius from its share of supply: area grows with the share. */
export function radiusFor(pct: number): number {
  return 5 + 4.2 * Math.sqrt(Math.max(0, pct));
}

/**
 * The bubbles laid out: clusters first, each member spiralling out from its cluster's placed
 * members, then same-minute groups alike, then the rest from the middle. Deterministic, so a
 * map re-read with the same holders keeps its picture. Scaled to fit VIEW_W by VIEW_H.
 */
export function layoutBubbles(holders: readonly OverlayBubbleHolder[]): PlacedBubble[] {
  const group = (h: OverlayBubbleHolder) =>
    h.cluster !== null ? `c${h.cluster}` : h.sameTime !== null ? `s${h.sameTime}` : null;
  const rank = (h: OverlayBubbleHolder) =>
    h.cluster !== null ? h.cluster : h.sameTime !== null ? 1_000 + h.sameTime : 1_000_000;
  const order = [...holders].sort((a, b) => rank(a) - rank(b) || b.pct - a.pct);
  const placed: PlacedBubble[] = [];
  for (const holder of order) {
    const r = radiusFor(holder.pct);
    const key = group(holder);
    const mates = key === null ? [] : placed.filter((p) => group(p.holder) === key);
    const ax = mates.length ? mates.reduce((t, p) => t + p.x, 0) / mates.length : 0;
    const ay = mates.length ? mates.reduce((t, p) => t + p.y, 0) / mates.length : 0;
    let x = ax;
    let y = ay;
    for (let step = 0; step < 4_000; step++) {
      const angle = step * 0.4;
      const reach = step * 0.45;
      x = ax + Math.cos(angle) * reach;
      y = ay + Math.sin(angle) * reach * 0.8;
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + GAP)) break;
    }
    placed.push({ holder, x, y, r });
  }
  if (placed.length === 0) return placed;
  const minX = Math.min(...placed.map((p) => p.x - p.r));
  const maxX = Math.max(...placed.map((p) => p.x + p.r));
  const minY = Math.min(...placed.map((p) => p.y - p.r));
  const maxY = Math.max(...placed.map((p) => p.y + p.r));
  const scale = Math.min((VIEW_W - 8) / (maxX - minX || 1), (VIEW_H - 8) / (maxY - minY || 1), 1.6);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return placed.map((p) => ({
    ...p,
    x: VIEW_W / 2 + (p.x - cx) * scale,
    y: VIEW_H / 2 + (p.y - cy) * scale,
    r: p.r * scale,
  }));
}

/** A bubble's colour: its cluster's, else its same-minute group's (after the clusters'), else grey. */
export function colourOf(h: OverlayBubbleHolder, clusters: number): string {
  if (h.cluster !== null) return CLUSTER_COLOURS[h.cluster % CLUSTER_COLOURS.length]!;
  if (h.sameTime !== null) return CLUSTER_COLOURS[(clusters + h.sameTime) % CLUSTER_COLOURS.length]!;
  return LONE;
}

export function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "–" : `${value.toFixed(digits)}%`;
}

/** "2/25 (9.0%)", "9.0%" without a count, "–" when not read. */
export function countText(count: OverlayCount | null, share: number | null): string {
  if (count && share !== null) return `${count.count}/${count.of} (${pct(share)})`;
  if (count) return `${count.count}/${count.of}`;
  return pct(share);
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The headline totals, as the site's tiles name them; a tile only where the scan read it. */
export function totalTiles(map: OverlayBubbleMap): { label: string; value: string; title: string }[] {
  const t = map.totals;
  const tiles: { label: string; value: string; title: string }[] = [
    {
      label: "Linked",
      value: countText(t.linkedCount, t.linkedPct),
      title: "Top holders in a funder's cluster, and the supply they hold",
    },
    {
      label: "KOL bundled",
      value: pct(t.kolBundledPct),
      title: "Supply held by KOLs and the top holders tied to them",
    },
    {
      label: "Bundled",
      value: pct(t.bundledPct),
      title: "Supply held by top holders that are linked or in a KOL's bundle, each once",
    },
  ];
  if (t.sameMinutePct !== null)
    tiles.push({
      label: "Same minute",
      value: countText(t.sameMinuteCount, t.sameMinutePct),
      title: "Top holders funded within a minute of each other, from any funders",
    });
  tiles.push({
    label: "CEX-funded",
    value: countText(t.cexFundedCount, t.cexFundedPct),
    title: "Largest holders opened from an exchange (or a busy service like a bridge)",
  });
  if (t.devTiedPct !== null && t.devTiedPct > 0)
    tiles.push({
      label: "Tied to dev",
      value: pct(t.devTiedPct),
      title: "Supply held by top holders the creator or its funder paid for",
    });
  if (t.transferredPct !== null)
    tiles.push({
      label: "Transferred",
      value:
        t.transferredCount && t.transferredPct > 0
          ? `${pct(t.transferredPct)} (${t.transferredCount.count}/${t.transferredCount.of})`
          : pct(t.transferredPct),
      title: "Supply moved holder to holder among the top holders; not counted in Linked",
    });
  tiles.push({ label: "Top 10", value: pct(t.top10Pct), title: "The 10 largest holders' share of supply" });
  return tiles;
}

/** The map and its totals for one coin, or a line saying why there is none. */
export function bubbleMapView(map: OverlayBubbleMap | null, now = Date.now()): HTMLElement {
  const box = div("bubble");
  if (!map || (map.holders.length === 0 && map.totals.linkedPct === null)) {
    box.append(div("note", "No holder reading for this coin yet. It comes with its next scan."));
    return box;
  }

  const head = div("bm-head");
  const when = map.readAt ? `Holders read ${ago(map.readAt, now)} ago` : "Holders";
  head.append(div("bm-when", `${when} · top ${map.top50 ? 50 : 25}`));
  if (isMintAddress(map.mint)) {
    const full = document.createElement("a");
    full.href = trenchUrl(map.mint);
    full.target = "_blank";
    full.rel = "noopener noreferrer";
    full.className = "site ts";
    full.textContent = "Full map";
    head.append(full);
  }
  box.append(head);

  const tiles = div("bm-tiles");
  for (const tile of totalTiles(map)) {
    const cell = div("bm-tile");
    cell.title = tile.title;
    cell.append(div("bm-l", tile.label), div("bm-v", tile.value));
    tiles.append(cell);
  }
  box.append(tiles);

  if (map.totals.traits.length > 0) {
    const traits = div("bm-traits");
    for (const t of map.totals.traits) {
      const chip = div(
        "chip",
        `${TRAIT_LABEL[t.trait].mark} ${TRAIT_LABEL[t.trait].label} ${t.count} · ${pct(t.pct)}`,
      );
      chip.title = `${t.count} ${TRAIT_LABEL[t.trait].label.toLowerCase()} wallet${t.count === 1 ? "" : "s"} among the top holders, holding ${pct(t.pct)} of supply`;
      traits.append(chip);
    }
    box.append(traits);
  }

  if (map.holders.length > 0) box.append(drawMap(map));
  return box;
}

function drawMap(map: OverlayBubbleMap): SVGSVGElement {
  const placed = layoutBubbles(map.holders);
  const root = svg("svg", { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, class: "bm-svg", role: "img" });
  root.setAttribute(
    "aria-label",
    `Bubble map of the top ${map.holders.length} holders, ${map.clusters.length} linked cluster${map.clusters.length === 1 ? "" : "s"}`,
  );
  // Each cluster's bubbles tied to its largest, under the bubbles.
  const links = svg("g", { class: "bm-links" });
  for (let c = 0; c < map.clusters.length; c++) {
    const members = placed.filter((p) => p.holder.cluster === c);
    const hub = members.reduce<PlacedBubble | null>(
      (a, b) => (a && a.holder.pct >= b.holder.pct ? a : b),
      null,
    );
    if (!hub) continue;
    for (const m of members) {
      if (m === hub) continue;
      links.append(
        svg("line", {
          x1: hub.x,
          y1: hub.y,
          x2: m.x,
          y2: m.y,
          stroke: CLUSTER_COLOURS[c % CLUSTER_COLOURS.length]!,
          "stroke-opacity": 0.55,
          "stroke-width": 1.2,
        }),
      );
    }
  }
  root.append(links);
  for (const p of placed) {
    const h = p.holder;
    const colour = colourOf(h, map.clusters.length);
    const g = svg("g", {});
    const title = svg("title", {});
    const bits = [`${h.wallet.slice(0, 4)}…${h.wallet.slice(-4)}`, `${pct(h.pct, 2)} of supply`];
    if (h.cluster !== null) bits.push(`cluster ${h.cluster + 1}`);
    else if (h.sameTime !== null) bits.push("funded the same minute as others");
    if (h.trait) bits.push(TRAIT_LABEL[h.trait].label.toLowerCase());
    if (h.cex) bits.push("CEX-funded");
    if (h.creatorTied) bits.push("tied to dev");
    title.textContent = bits.join(" · ");
    g.append(title);
    g.append(
      svg("circle", {
        cx: p.x,
        cy: p.y,
        r: p.r,
        fill: colour,
        "fill-opacity": h.cluster === null && h.sameTime === null ? 0.9 : 0.75,
        stroke: h.creatorTied ? "#ff4d6a" : colour,
        "stroke-width": h.creatorTied ? 1.6 : 1,
        ...(h.sameTime !== null && h.cluster === null ? { "stroke-dasharray": "3 2" } : {}),
      }),
    );
    if (h.pct >= 1 && p.r >= 9) {
      const label = svg("text", {
        x: p.x,
        y: p.y + 3,
        "text-anchor": "middle",
        class: "bm-pct",
        "font-size": Math.min(11, Math.max(7, p.r * 0.55)),
      });
      label.textContent = `${h.pct >= 10 ? Math.round(h.pct) : h.pct.toFixed(1)}%`;
      g.append(label);
    }
    if (h.trait && p.r >= 6) {
      const bx = p.x + p.r * 0.7;
      const by = p.y - p.r * 0.7;
      g.append(svg("circle", { cx: bx, cy: by, r: 4.2, class: "bm-mark" }));
      const mark = svg("text", { x: bx, y: by + 2.4, "text-anchor": "middle", class: "bm-mark-t" });
      mark.textContent = TRAIT_LABEL[h.trait].mark;
      g.append(mark);
    }
    root.append(g);
  }
  return root;
}
