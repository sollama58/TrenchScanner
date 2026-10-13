import { useEffect, useState } from "react";
import type { Snapshot, Token } from "./api";

/**
 * The linked-wallets bubble map: a coin's top holders as bubbles sized by their share of supply,
 * coloured by the cluster one funder paid for, with a line from each to that funder, and the
 * risky wallets ringed. Open in the address bar as `?bubbles=<mint>` (like `?sage=`, sage.ts), so
 * the map has a link of its own to copy and send.
 *
 * This file is the pure half: the URL state, the graph built from a snapshot's linked clusters
 * (core's wallets/linkedWallets.ts) and the token chart's flagged wallets, and its layout, which
 * both the dialog's SVG (components/BubbleMap.tsx) and the share image (bubbleMapCard.ts) draw.
 */

export const BUBBLES_PARAM = "bubbles";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVENT = "bubbles:change";

/** The mint in the address bar, or null when none (or not a mint). */
export function bubblesFromUrl(search = window.location.search): string | null {
  const mint = new URLSearchParams(search).get(BUBBLES_PARAM);
  return mint && MINT_RE.test(mint) ? mint : null;
}

/** The map's own link, for the Copy link button: this page with only `?bubbles=<mint>`. */
export function bubblesLink(mint: string, href = window.location.href): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(BUBBLES_PARAM, mint);
  return url.toString();
}

function write(mint: string | null) {
  const url = new URL(window.location.href);
  if (mint) url.searchParams.set(BUBBLES_PARAM, mint);
  else url.searchParams.delete(BUBBLES_PARAM);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
}

/** The reading a card already shows, so the map opened from it draws the same one. */
export interface BubbleSeed {
  token: Token;
  snapshot: Snapshot;
}
const seeds = new Map<string, BubbleSeed>();

/** The seed left by openBubbleMap for this mint, if any. */
export function bubbleSeed(mint: string): BubbleSeed | undefined {
  return seeds.get(mint);
}

/** Opens the map. `seed`: the card's own reading, drawn instead of the newest scan's. */
export function openBubbleMap(mint: string, seed?: BubbleSeed) {
  if (seed) seeds.set(mint, seed);
  write(mint);
}

export function closeBubbleMap() {
  write(null);
}

/** The open map's mint, following openBubbleMap/closeBubbleMap and back/forward. */
export function useBubblesMint(): string | null {
  const [mint, setMint] = useState(bubblesFromUrl);
  useEffect(() => {
    const sync = () => setMint(bubblesFromUrl());
    window.addEventListener(EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  return mint;
}

// ---------------------------------------------------------------------------------------------
// The graph

export type Cluster = NonNullable<Snapshot["linkedClusters"]>[number];
/** Top holders funded within a minute of each other, from any funders (core's sameTimeClusters). */
export type SameTimeGroup = NonNullable<Snapshot["sameTimeClusters"]>[number];

/** A flagged wallet from the token chart (apps/api/src/tokenChart.ts MarkedWallet), the parts used here. */
export interface FlaggedHolder {
  wallet: string;
  tags: readonly string[];
  score: number | null;
  dumps: number | null;
  heldPct: number | null;
  /** A known KOL's name ("" when unnamed), when its tags include "kol". */
  kol?: string | null;
}

export type Flag = "risky" | "dumper" | "creator";

export interface MapNode {
  id: string;
  /** A top holder; the funder that paid for a cluster (not itself a holder); the other top holders together. */
  kind: "holder" | "funder" | "rest";
  /** The wallet (holder or funder); null on "rest". */
  wallet: string | null;
  /** % of supply; 0 on a funder. */
  pct: number;
  /** Index into the clusters, or null for a holder in none. */
  cluster: number | null;
  /** A holder that funded the others in its cluster. */
  hub: boolean;
  /** Index into the same-minute groups, or null for a holder in none. */
  sameTime: number | null;
  flags: Flag[];
  /** On the KOL list: its name ("" when unnamed). Absent or null otherwise. */
  kol?: string | null;
  /** Risk score 0-100 from the wallet risk scores, when known. */
  score: number | null;
  dumps: number | null;
  /** On "rest": how many holders it stands for. */
  count: number;
  r: number;
  x: number;
  y: number;
}

export interface MapLink {
  /** The funded holder. */
  from: string;
  /** Its funder (a funder node, or the hub holder). */
  to: string;
  cluster: number;
}

/** A same-minute group's tie: each holder to the group's first-funded one. */
export interface SameTimeLink {
  from: string;
  to: string;
  group: number;
}

export interface BubbleGraph {
  nodes: MapNode[];
  links: MapLink[];
  clusters: readonly Cluster[];
  sameTimeLinks: SameTimeLink[];
  sameTimeGroups: readonly SameTimeGroup[];
  /** Share of supply in same-minute groups, as read. */
  sameTimePct: number | null;
  /** Share of supply in linked wallets, and the top 10's share, as read. */
  linkedPct: number | null;
  /** How many top holders are linked, of how many were read. */
  linkedCount: { linked: number; of: number } | null;
  top10Pct: number | null;
}

/** Flagged holders held under this % of supply at the call are left off the map (not a top holder). */
const MIN_FLAGGED_HELD_PCT = 0.5;
/** The other top holders together are drawn only above this share. */
const MIN_REST_PCT = 0.2;

/** A bubble's radius in map units from its share of supply: area grows with the share. */
export function radiusFor(pct: number): number {
  return 9 + 8.5 * Math.sqrt(Math.max(0, pct));
}
const FUNDER_R = 8;

function kolOf(w: FlaggedHolder | undefined): string | null {
  return w && w.tags.includes("kol") ? (w.kol ?? "") : null;
}

function flagsOf(w: FlaggedHolder | undefined): Flag[] {
  if (!w) return [];
  const out: Flag[] = [];
  if (w.tags.includes("creator")) out.push("creator");
  if (w.tags.includes("risky")) out.push("risky");
  if (w.tags.includes("dumper")) out.push("dumper");
  return out;
}

/**
 * The map's nodes and links. Every wallet in a cluster is a holder bubble linked to the cluster's
 * funder (a node of its own, or the holder that funded the rest). Flagged wallets the chart knows
 * hold at least MIN_FLAGGED_HELD_PCT and in no cluster are bubbles too, unlinked, as is every other
 * holder when the scan kept the list (linkedHolders, on scans since it was added). What the map
 * can't place individually is one dashed bubble: on older scans, the rest of the top 10.
 */
export function buildGraph(
  snapshot: Pick<
    Snapshot,
    | "linkedClusters"
    | "linkedHolders"
    | "linkedWalletPct"
    | "linkedWalletCount"
    | "linkedWalletsChecked"
    | "top10HolderPct"
    | "top10WalletsChecked"
    | "sameTimeClusters"
    | "sameTimeFundedPct"
  >,
  flagged: readonly FlaggedHolder[] = [],
): BubbleGraph {
  const clusters = (snapshot.linkedClusters ?? []).filter(
    (c) => c && typeof c.funder === "string" && Array.isArray(c.wallets) && c.wallets.length > 0,
  );
  const byWallet = new Map(flagged.map((w) => [w.wallet, w]));
  const nodes: MapNode[] = [];
  const links: MapLink[] = [];
  const seen = new Set<string>();
  const holder = (wallet: string, pct: number, cluster: number | null, hub: boolean): MapNode => {
    const f = byWallet.get(wallet);
    return {
      id: `h:${wallet}`,
      kind: "holder",
      wallet,
      pct,
      cluster,
      hub,
      sameTime: null,
      flags: flagsOf(f),
      kol: kolOf(f),
      score: f?.score ?? null,
      dumps: f?.dumps ?? null,
      count: 1,
      r: radiusFor(pct),
      x: 0,
      y: 0,
    };
  };

  clusters.forEach((c, i) => {
    const hubIsHolder = c.wallets.some((w) => w.wallet === c.funder);
    const hubId = hubIsHolder ? `h:${c.funder}` : `f:${c.funder}`;
    if (!hubIsHolder) {
      nodes.push({
        id: hubId,
        kind: "funder",
        wallet: c.funder,
        pct: 0,
        cluster: i,
        hub: true,
        sameTime: null,
        flags: flagsOf(byWallet.get(c.funder)),
        score: byWallet.get(c.funder)?.score ?? null,
        dumps: byWallet.get(c.funder)?.dumps ?? null,
        count: 0,
        r: FUNDER_R,
        x: 0,
        y: 0,
      });
    }
    for (const w of c.wallets) {
      if (seen.has(w.wallet)) continue;
      seen.add(w.wallet);
      const isHub = w.wallet === c.funder;
      nodes.push(holder(w.wallet, w.pct, i, isHub));
      if (!isHub) links.push({ from: `h:${w.wallet}`, to: hubId, cluster: i });
    }
  });

  let shownPct = 0;
  let shownCount = 0;
  for (const n of nodes) {
    if (n.kind !== "holder") continue;
    shownPct += n.pct;
    shownCount += 1;
  }
  // Holders funded in the same minute: each ringed and tied to the group's first-funded holder,
  // added as a bubble of its own when no cluster placed it.
  const sameTimeGroups = (snapshot.sameTimeClusters ?? []).filter(
    (g) => g && Array.isArray(g.wallets) && g.wallets.length > 1,
  );
  const sameTimeLinks: SameTimeLink[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  sameTimeGroups.forEach((g, i) => {
    const first = [...g.wallets].sort((a, b) => a.fundedAtMs - b.fundedAtMs)[0]!.wallet;
    for (const w of g.wallets) {
      let n = byId.get(`h:${w.wallet}`);
      if (!n) {
        seen.add(w.wallet);
        n = holder(w.wallet, w.pct, null, false);
        nodes.push(n);
        byId.set(n.id, n);
        shownPct += w.pct;
        shownCount += 1;
      }
      n.sameTime ??= i;
      if (w.wallet !== first) sameTimeLinks.push({ from: `h:${w.wallet}`, to: `h:${first}`, group: i });
    }
  });

  // The holders in no cluster, each its own bubble, when the scan kept the list.
  for (const h of snapshot.linkedHolders ?? []) {
    if (!h || typeof h.wallet !== "string" || seen.has(h.wallet) || !(h.pct > 0)) continue;
    seen.add(h.wallet);
    nodes.push(holder(h.wallet, h.pct, null, false));
    shownPct += h.pct;
    shownCount += 1;
  }
  for (const w of flagged) {
    if (seen.has(w.wallet) || w.heldPct === null || w.heldPct < MIN_FLAGGED_HELD_PCT) continue;
    if (flagsOf(w).length === 0 && kolOf(w) === null) continue;
    seen.add(w.wallet);
    nodes.push(holder(w.wallet, Math.round(w.heldPct * 100) / 100, null, false));
    shownPct += w.heldPct;
    shownCount += 1;
  }

  const top10 = snapshot.top10HolderPct ?? null;
  const checked = snapshot.top10WalletsChecked ?? null;
  if (top10 !== null && checked !== null) {
    const count = checked - shownCount;
    const pct = Math.round((top10 - shownPct) * 100) / 100;
    if (count > 0 && pct > MIN_REST_PCT) {
      nodes.push({
        id: "rest",
        kind: "rest",
        wallet: null,
        pct,
        cluster: null,
        hub: false,
        sameTime: null,
        flags: [],
        score: null,
        dumps: null,
        count,
        r: radiusFor(pct),
        x: 0,
        y: 0,
      });
    }
  }

  return {
    nodes,
    links,
    clusters,
    sameTimeLinks,
    sameTimeGroups,
    sameTimePct: snapshot.sameTimeFundedPct ?? null,
    linkedPct: snapshot.linkedWalletPct ?? null,
    linkedCount: linkedCount(snapshot),
    top10Pct: top10,
  };
}

// ---------------------------------------------------------------------------------------------
// The layout

/** Gap between bubbles, map units. */
const GAP = 6;

/**
 * Places the nodes with a small fixed-step force layout: each cluster starts around its own spot
 * on a ring, holders are pulled to their funder, every bubble pushes overlapping ones apart, and
 * a light pull keeps it all near the middle. Deterministic (no randomness), so the dialog and the
 * share image draw the same map. Mutates and returns `graph`.
 */
export function layoutGraph(graph: BubbleGraph, iterations = 320): BubbleGraph {
  const { nodes, links } = graph;
  if (nodes.length === 0) return graph;
  const index = new Map(nodes.map((n) => [n.id, n]));
  const groups = graph.clusters.length + (nodes.some((n) => n.cluster === null) ? 1 : 0);
  const ring = groups <= 1 ? 0 : 70 + 26 * groups;

  // Start: each cluster's hub on a ring, its members around it; the unclustered on the far side.
  const groupAngle = (g: number) => -Math.PI / 2 + (2 * Math.PI * g) / Math.max(1, groups);
  const centre = new Map<number, { x: number; y: number }>();
  for (let g = 0; g < groups; g += 1) {
    centre.set(g, { x: Math.cos(groupAngle(g)) * ring, y: Math.sin(groupAngle(g)) * ring });
  }
  const members = new Map<number, MapNode[]>();
  for (const n of nodes) {
    const g = n.cluster ?? graph.clusters.length;
    const list = members.get(g) ?? [];
    list.push(n);
    members.set(g, list);
  }
  for (const [g, list] of members) {
    const c = centre.get(g)!;
    const hubs = list.filter((n) => n.hub);
    const rest = list.filter((n) => !n.hub);
    for (const h of hubs) {
      h.x = c.x;
      h.y = c.y;
    }
    rest.forEach((n, i) => {
      const a = groupAngle(g) + (2 * Math.PI * i) / Math.max(1, rest.length) + 0.4;
      const d = (hubs[0]?.r ?? 0) + n.r + 16 + (hubs.length === 0 ? 10 : 0);
      n.x = c.x + Math.cos(a) * d;
      n.y = c.y + Math.sin(a) * d;
    });
  }

  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    // Springs: a funded holder toward its funder.
    for (const l of links) {
      const a = index.get(l.from);
      const b = index.get(l.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const want = a.r + b.r + 22;
      const k = ((dist - want) / dist) * 0.12;
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k * 0.35;
      b.y -= dy * k * 0.35;
    }
    // Same-minute ties: a looser pull, so the group sits together without leaving its clusters.
    for (const l of graph.sameTimeLinks) {
      const a = index.get(l.from);
      const b = index.get(l.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const want = a.r + b.r + 34;
      if (dist <= want) continue;
      const k = ((dist - want) / dist) * 0.04;
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k;
      b.y -= dy * k;
    }
    // Gravity toward the middle, stronger for the unlinked so clusters keep their room.
    for (const n of nodes) {
      const g = n.cluster === null ? 0.012 : 0.02;
      n.x -= n.x * g * cool + n.x * 0.002;
      n.y -= n.y * g * cool + n.y * 0.002;
    }
    // Collisions: bubbles in different clusters keep a wider berth.
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const pad = a.cluster === b.cluster && a.cluster !== null ? GAP : GAP * 3;
        const min = a.r + b.r + pad;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= min) continue;
        if (dist < 0.01) {
          // Same spot: part them along a fixed, index-based direction.
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          dist = 1;
        }
        const push = ((min - dist) / dist) * 0.5;
        const wa = b.r / (a.r + b.r);
        const wb = a.r / (a.r + b.r);
        a.x -= dx * push * wa;
        a.y -= dy * push * wa;
        b.x += dx * push * wb;
        b.y += dy * push * wb;
      }
    }
  }
  return graph;
}

/** The box the laid-out map fills, with room for the badges and labels around the bubbles. */
export function graphBounds(graph: BubbleGraph, pad = 18): { x: number; y: number; w: number; h: number } {
  if (graph.nodes.length === 0) return { x: -50, y: -50, w: 100, h: 100 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of graph.nodes) {
    // Funders carry a label underneath.
    const below = n.kind === "funder" ? 18 : 0;
    x0 = Math.min(x0, n.x - n.r);
    y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r);
    y1 = Math.max(y1, n.y + n.r + below);
  }
  // The cluster halos reach a little past their bubbles.
  for (const h of clusterHalos(graph)) {
    for (const c of h.circles) {
      x0 = Math.min(x0, c.x - c.r);
      y0 = Math.min(y0, c.y - c.r);
      x1 = Math.max(x1, c.x + c.r);
      y1 = Math.max(y1, c.y + c.r);
    }
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** How far a cluster's halo reaches past its bubbles, map units. */
export const HALO_PAD = 9;

/** One cluster's halo: its bubbles grown by HALO_PAD and its links as thick bands, filled as one. */
export interface ClusterHalo {
  cluster: number;
  circles: { x: number; y: number; r: number }[];
  bands: { x1: number; y1: number; x2: number; y2: number }[];
}

/**
 * A soft shape behind each cluster, hugging only its own bubbles and the lines between them, so
 * a cluster reads as one group at a glance without swallowing the holders next to it. Drawn as a
 * single flattened layer (so overlaps don't darken) by the dialog's SVG and the share image alike.
 */
export function clusterHalos(graph: BubbleGraph): ClusterHalo[] {
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: ClusterHalo[] = [];
  graph.clusters.forEach((_, i) => {
    const members = graph.nodes.filter((n) => n.cluster === i);
    if (members.length < 2) return;
    const bands: ClusterHalo["bands"] = [];
    for (const l of graph.links) {
      if (l.cluster !== i) continue;
      const a = index.get(l.from);
      const b = index.get(l.to);
      if (a && b) bands.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    out.push({
      cluster: i,
      circles: members.map((n) => ({ x: n.x, y: n.y, r: n.r + HALO_PAD })),
      bands,
    });
  });
  return out;
}

/** Holders the linked reading covers when the scan didn't keep the count: the top 20. */
const LINKED_HOLDERS_READ = 20;

/**
 * Linked as a count (user ask 2026-10-13): how many top holders are in a linked cluster, of how
 * many were read, shown "N/20". Scans before the count was kept count the clusters' wallets. Null
 * when the reading isn't in.
 */
export function linkedCount(
  s: Pick<
    Snapshot,
    "linkedWalletPct" | "linkedWalletCount" | "linkedWalletsChecked" | "linkedClusters" | "linkedHolders"
  >,
): { linked: number; of: number } | null {
  if (s.linkedWalletPct == null) return null;
  if (s.linkedWalletCount != null) {
    return { linked: s.linkedWalletCount, of: s.linkedWalletsChecked ?? LINKED_HOLDERS_READ };
  }
  const wallets = new Set((s.linkedClusters ?? []).flatMap((c) => (c?.wallets ?? []).map((w) => w.wallet)));
  return { linked: wallets.size, of: s.linkedHolders?.length || LINKED_HOLDERS_READ };
}

/** "4/20", or null without a reading. */
export function linkedCountText(c: { linked: number; of: number } | null): string | null {
  return c ? `${c.linked}/${c.of}` : null;
}

/** The reading to draw: the card's, else the newest scan's with a linked reading. */
export function pickReading<S extends Pick<Snapshot, "linkedWalletPct" | "linkedClusters">>(
  snapshots: readonly S[],
): S | null {
  return (
    snapshots.find((s) => s.linkedWalletPct != null && (s.linkedClusters?.length ?? 0) > 0) ??
    snapshots.find((s) => s.linkedWalletPct != null) ??
    null
  );
}
