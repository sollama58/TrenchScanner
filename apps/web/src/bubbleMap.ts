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
  /**
   * The top-50 map to draw over it, when the opener already chose one (the token view's "At the
   * alert" holds the map as it stood at the call): null for none. Absent: the coin's live one.
   */
  wide?: WideMap | null;
  /** Which moment it is ("At the alert"), headed on the map. */
  moment?: { label: string; title: string };
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
// The top 50, for model-alerted coins

/** A holder on the wider map: rank only on those past the top 25. */
export interface WideHolder {
  wallet: string;
  pct: number;
  rank?: number;
  cexFunder?: string;
  sniper?: boolean;
  fresh?: boolean;
  empty?: boolean;
}

/**
 * A model-alerted coin's map over its top 50 (GET /tokens/:mint/bubble-holders, user ask
 * 2026-10-14): the top 25, plus every holder ranked 26 to 50 whose funder we already know,
 * clustered by the same rules. Wallets we have never read are left off.
 */
export interface WideMap {
  readAt: string;
  /** How many holders the read listed (pools and the creator aside). */
  holdersRead: number;
  /** Of those past the top 25, how many are on the map. */
  knownExtra: number;
  holders: WideHolder[];
  clusters: NonNullable<Snapshot["linkedClusters"]>;
  sameTimeClusters: NonNullable<Snapshot["sameTimeClusters"]>;
}

/** The map as it stood at the coin's first model call (BubbleMapAtAlert): kept once, never updated. */
export interface AlertWideMap extends WideMap {
  /** The first call the reading is pinned to. */
  alertAt: string;
}

/** GET /tokens/:mint/bubble-holders. `atAlert` is absent from API builds before it was kept. */
export interface BubbleMaps {
  map: WideMap | null;
  atAlert?: AlertWideMap | null;
}

/**
 * How far from an alert the map kept at the call can stand for it (core's
 * BUBBLE_AT_ALERT_WINDOW_MS): a filter alert minutes from the model's call shows it, one hours
 * away does not.
 */
export const AT_ALERT_WINDOW_MS = 15 * 60_000;

/** The map kept at the call, when it was read within AT_ALERT_WINDOW_MS of this alert; else null. */
export function alertWideMap(
  atAlert: AlertWideMap | null | undefined,
  alertAtMs: number,
): AlertWideMap | null {
  if (!atAlert || !Array.isArray(atAlert.holders) || atAlert.holders.length === 0) return null;
  const readAt = Date.parse(atAlert.readAt);
  return Number.isFinite(readAt) && Math.abs(readAt - alertAtMs) <= AT_ALERT_WINDOW_MS ? atAlert : null;
}

/** "40s after the call", "3m before the alert": how far a reading is from the alert, in words. */
export function fromAlertText(readAtMs: number, alertAtMs: number, what: string): string {
  const gap = readAtMs - alertAtMs;
  const abs = Math.abs(gap);
  if (abs < 5_000) return `at the ${what}`;
  const span = abs < 60_000 ? `${Math.round(abs / 1000)}s` : `${Math.round(abs / 60_000)}m`;
  return `${span} ${gap > 0 ? "after" : "before"} the ${what}`;
}

/**
 * The reading the map draws: the snapshot's, with the wider map's holders, clusters and
 * same-minute groups in place of its own when the coin has one. Every count (Linked N/25,
 * Same minute, CEX-funded) stays the snapshot's: the top 50 is for the picture only.
 */
export function withWideMap<
  S extends Pick<Snapshot, "linkedClusters" | "linkedHolders" | "sameTimeClusters">,
>(snapshot: S, wide: WideMap | null | undefined): S & WideReading {
  if (!wide || !Array.isArray(wide.holders) || wide.holders.length === 0) return snapshot;
  return {
    ...snapshot,
    // What the scan counted as linked, and how many holders the wider read listed (mapLinked).
    scanLinkedWallets: clusterWallets(snapshot.linkedClusters),
    holdersRead: wide.holdersRead,
    linkedHolders: withTraits(wide.holders, snapshot.linkedHolders),
    linkedClusters: Array.isArray(wide.clusters) ? wide.clusters : [],
    sameTimeClusters: Array.isArray(wide.sameTimeClusters) ? wide.sameTimeClusters : [],
  };
}

/** What withWideMap keeps of the scan's own reading once the wider map stands in for it. */
export interface WideReading {
  /** The wallets in the scan's own clusters: those its Linked count took in. */
  scanLinkedWallets?: string[];
  /** How many holders the wider read listed. */
  holdersRead?: number;
}

/** The wider map's holders, each with the scan's sniper, fresh and empty marks where it read them. */
function withTraits(holders: WideHolder[], read: Snapshot["linkedHolders"] | undefined): WideHolder[] {
  const byWallet = new Map((read ?? []).map((h) => [h.wallet, h]));
  return holders.map((h) => {
    const r = byWallet.get(h.wallet);
    if (!r) return h;
    return {
      ...h,
      ...(r.sniper ? { sniper: true } : {}),
      ...(r.fresh ? { fresh: true } : {}),
      ...(r.empty ? { empty: true } : {}),
    };
  });
}

function clusterWallets(clusters: Snapshot["linkedClusters"] | undefined): string[] {
  return [...new Set((clusters ?? []).flatMap((c) => (c?.wallets ?? []).map((w) => w.wallet)))];
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
  /** A KOL's Known Side: the KOL's main wallet. Not a KOL bubble of its own; it joins its KOL's group. */
  knownSideOf?: string;
}

/** Where the flagged-wallet read stands: until it is "ok", no rings doesn't mean no risky holders. */
export type FlagsRead = "loading" | "ok" | "failed";

export type Flag = "risky" | "dumper" | "creator";

/**
 * What the scan read of a holder's wallet (user ask 2026-10-15), one per bubble: a launch sniper
 * (among its first 25 buyers), else a fresh wallet, else an otherwise empty one.
 */
export type WalletTrait = "sniper" | "fresh" | "empty";
export const WALLET_TRAITS: readonly WalletTrait[] = ["sniper", "fresh", "empty"];

/** Each trait's word, for the legends. */
export const TRAIT_LABEL: Record<WalletTrait, string> = { sniper: "Sniper", fresh: "Fresh", empty: "Empty" };

/**
 * Each trait's icon as stroke paths on a 24px grid, shared by the map's SVG and the share image's
 * canvas (Path2D): a bullseye, a leaf, a ghost.
 */
export const TRAIT_ICON: Record<WalletTrait, readonly string[]> = {
  sniper: [
    "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0Z",
    "M17 12a5 5 0 1 1-10 0a5 5 0 1 1 10 0Z",
    "M13 12a1 1 0 1 1-2 0a1 1 0 1 1 2 0Z",
  ],
  fresh: [
    "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z",
    "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
  ],
  empty: [
    "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8Z",
    "M9 10h.01",
    "M15 10h.01",
  ],
};

/** A holder's trait from the scan's marks: sniper first, then fresh, then empty; null for none. */
export function traitOf(
  h: { sniper?: boolean; fresh?: boolean; empty?: boolean } | undefined,
): WalletTrait | null {
  if (!h) return null;
  return h.sniper ? "sniper" : h.fresh ? "fresh" : h.empty ? "empty" : null;
}

/** Each trait on the map with its holders' count and share of supply together; in WALLET_TRAITS order. */
export function traitShares(
  graph: Pick<BubbleGraph, "nodes">,
): { trait: WalletTrait; count: number; pct: number }[] {
  return WALLET_TRAITS.flatMap((trait) => {
    const nodes = graph.nodes.filter((n) => n.kind === "holder" && n.trait === trait);
    if (nodes.length === 0) return [];
    return [
      { trait, count: nodes.length, pct: Math.round(nodes.reduce((t, n) => t + n.pct, 0) * 100) / 100 },
    ];
  });
}

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
  /** A holder's wallet trait (traitOf), its icon on the bubble; absent or null for none. */
  trait?: WalletTrait | null;
  /** On the KOL list: its name ("" when unnamed). Absent or null otherwise. */
  kol?: string | null;
  /** Risk score 0-100 from the wallet risk scores, when known. */
  score: number | null;
  dumps: number | null;
  /** On "rest": how many holders it stands for. */
  count: number;
  /** Its rank among the top 50 when the map took it in from past the top 25 (alerted coins); else absent. */
  rank?: number;
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

/**
 * Colour slots on every bubble map (styles.css --bm-0 to --bm-6; bubbleMapCard's CLUSTER): clusters
 * take the first, same-minute groups the next, so no two share a colour while the slots last.
 */
export const MAP_COLOURS = 7;

/** A same-minute group's colour slot: after the clusters'. */
export function sameTimeSlot(graph: Pick<BubbleGraph, "clusters">, group: number): number {
  return (graph.clusters.length + group) % MAP_COLOURS;
}

/** A node's colour slot: its cluster's, else its same-minute group's; null for grey (linked to none). */
export function nodeSlot(
  n: Pick<MapNode, "cluster" | "sameTime">,
  graph: Pick<BubbleGraph, "clusters">,
): number | null {
  if (n.cluster !== null) return n.cluster % MAP_COLOURS;
  return n.sameTime !== null ? sameTimeSlot(graph, n.sameTime) : null;
}

/** Holders one exchange (or busy service) funded: each tied to the group's largest. Drawn only. */
export interface CexLink {
  from: string;
  to: string;
  /** The exchange's address. */
  funder: string;
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
  /** How many top holders are in a same-minute group, of how many were read. */
  sameTimeCount: { linked: number; of: number } | null;
  /** Share of supply in linked wallets, and the top 10's share, as read. */
  linkedPct: number | null;
  /** How many top holders are linked, of how many were read. */
  linkedCount: { linked: number; of: number } | null;
  /** The wallets the scan's Linked count took in (its own clusters'), for mapLinked. */
  scanLinked: ReadonlySet<string>;
  /** How many holders the wider map's read listed; null without one. */
  holdersRead: number | null;
  top10Pct: number | null;
  /** Ties between holders the same exchange funded, on scans that kept it (drawn only, never counted). */
  cexLinks: CexLink[];
  /** How many top holders an exchange funded, of how many were read; and their share of that count. */
  cexCount: { linked: number; of: number } | null;
  cexPct: number | null;
  /**
   * Where the layout kept room for each pill (layoutGraph's label room): by the label's id (a
   * funder node's id, "same:<i>", "cex:<funder>", "side:<kol>"), the centre of the room it holds.
   * placeLabels tries it first. Absent before a layout.
   */
  labelSpots?: ReadonlyMap<string, { x: number; y: number }>;
}

/** Flagged holders held under this % of supply at the call are left off the map (not a top holder). */
const MIN_FLAGGED_HELD_PCT = 0.5;
/** The other top holders together are drawn only above this share. */
const MIN_REST_PCT = 0.2;

/** The smallest share of supply whose bubble still carries its amount (user ask 2026-10-14). */
export const MIN_LABEL_PCT = 0.1;

/** Whether a holder's bubble shows its % of supply: down to MIN_LABEL_PCT, in smaller type under 1%. */
export function showsPct(pct: number): boolean {
  return pct >= MIN_LABEL_PCT - 1e-9;
}

/** A bubble's radius in map units from its share of supply: area grows with the share. */
export function radiusFor(pct: number): number {
  return 9 + 8.5 * Math.sqrt(Math.max(0, pct));
}
const FUNDER_R = 8;

function kolOf(w: FlaggedHolder | undefined): string | null {
  return w && w.tags.includes("kol") && !w.knownSideOf ? (w.kol ?? "") : null;
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
    | "sameTimeFundedCount"
    | "cexFundedPct"
    | "cexFundedCount"
    | "cexFundedHolders"
  > &
    WideReading,
  flagged: readonly FlaggedHolder[] = [],
): BubbleGraph {
  const clusters = (snapshot.linkedClusters ?? []).filter(
    (c) => c && typeof c.funder === "string" && Array.isArray(c.wallets) && c.wallets.length > 0,
  );
  const byWallet = new Map(flagged.map((w) => [w.wallet, w]));
  // Holders the top-50 map took in past the top 25 carry their rank (withWideMap).
  const rankOf = new Map(
    (snapshot.linkedHolders ?? []).flatMap((h) =>
      h && typeof h.rank === "number" ? [[h.wallet, h.rank]] : [],
    ),
  );
  const traits = new Map((snapshot.linkedHolders ?? []).flatMap((h) => (h ? [[h.wallet, traitOf(h)]] : [])));
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
      trait: traits.get(wallet) ?? null,
      kol: kolOf(f),
      score: f?.score ?? null,
      dumps: f?.dumps ?? null,
      count: 1,
      ...(rankOf.has(wallet) ? { rank: rankOf.get(wallet)! } : {}),
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
    cexLinks: cexLinksOf(snapshot.linkedHolders ?? [], nodes),
    cexCount:
      snapshot.cexFundedCount != null && snapshot.cexFundedHolders != null
        ? { linked: snapshot.cexFundedCount, of: snapshot.cexFundedHolders }
        : null,
    cexPct: snapshot.cexFundedPct ?? null,
    sameTimeGroups,
    sameTimePct: snapshot.sameTimeFundedPct ?? null,
    sameTimeCount: sameTimeCount(snapshot),
    linkedPct: snapshot.linkedWalletPct ?? null,
    linkedCount: linkedCount(snapshot),
    scanLinked: new Set(snapshot.scanLinkedWallets ?? clusterWallets(snapshot.linkedClusters)),
    holdersRead: snapshot.holdersRead ?? null,
    top10Pct: top10,
  };
}

/**
 * Ties between the holders on the map that one exchange funded (linkedHolders' cexFunder): each
 * to the largest of its group, groups of two or more. Only drawn, so the layout ignores them.
 */
export function cexLinksOf(
  holders: readonly { wallet: string; pct: number; cexFunder?: string }[],
  nodes: readonly MapNode[],
): CexLink[] {
  const onMap = new Map(nodes.filter((n) => n.kind === "holder").map((n) => [n.wallet, n]));
  const groups = new Map<string, MapNode[]>();
  for (const h of holders) {
    const n = h && typeof h.cexFunder === "string" ? onMap.get(h.wallet) : undefined;
    if (!n) continue;
    const list = groups.get(h.cexFunder!) ?? [];
    if (!list.includes(n)) list.push(n);
    groups.set(h.cexFunder!, list);
  }
  const out: CexLink[] = [];
  for (const [funder, list] of groups) {
    if (list.length < 2) continue;
    const [top, ...rest] = [...list].sort((a, b) => b.pct - a.pct);
    for (const n of rest) out.push({ from: n.id, to: top!.id, funder });
  }
  return out;
}

/**
 * The map laid out again with its same-exchange holders pulled together, on copies of the nodes:
 * the original layout stands untouched for when the ties are switched off.
 */
export function cexLayout(graph: BubbleGraph): BubbleGraph {
  return regroupLayout(graph, { cex: true });
}

/**
 * A KOL and the holders tied to it (possibleSides.ts sideGroups): its possible side wallets, the
 * wallets it funded (`funded`, a KOL Funded Wallet: shown without the question mark), and its own
 * other wallets (`known`, a Known Side).
 */
export interface SideGroup {
  kolWallet: string;
  kolName: string | null;
  wallets: readonly { wallet: string; pct: number; funded?: boolean; known?: boolean }[];
}

/** The side wallets of a group that show on the map (the KOL's own bubble aside), split by kind. */
export function sideCounts(
  members: readonly MapNode[],
  g: SideGroup,
): { known: number; funded: number; possible: number } {
  const known = new Set(g.wallets.filter((w) => w.known).map((w) => w.wallet));
  const funded = new Set(g.wallets.filter((w) => w.funded && !w.known).map((w) => w.wallet));
  const sides = members.filter((n) => n.wallet !== g.kolWallet);
  const k = sides.filter((n) => !!n.wallet && known.has(n.wallet)).length;
  const f = sides.filter((n) => !!n.wallet && funded.has(n.wallet)).length;
  return { known: k, funded: f, possible: sides.length - k - f };
}

/** How a wallet in a KOL's holdings ties to the KOL. */
export type KolTie = "kol" | "known" | "funded" | "side" | "cluster" | "same-minute";

/** A KOL on the map and the supply it may control: its own wallet, its side wallets and theirs. */
export interface KolControl {
  kolWallet: string;
  kolName: string | null;
  /** Whether the KOL's own wallet is a holder on the map. */
  holds: boolean;
  /** Holders on the map, largest first, each with how it ties to the KOL. */
  wallets: { wallet: string; pct: number; tie: KolTie }[];
  /** Their share of supply together. */
  pct: number;
}

/**
 * Each KOL with at least one other holder tied to it (user ask 2026-10-14): its KOL Funded Wallets
 * and possible side wallets (`groups`), and any holder that shares a funder or a funding minute
 * with the KOL's wallet or one of those. A KOL holding alone, tied to no one, is left off.
 * `kols`: holders named as KOLs, for KOLs on the map with no side wallets. Largest share first.
 */
export function kolControl(
  graph: Pick<BubbleGraph, "nodes">,
  groups: readonly SideGroup[],
  kols: readonly { wallet: string; name: string | null }[] = [],
): KolControl[] {
  const holders = new Map(
    graph.nodes.flatMap((n) => (n.kind === "holder" && n.wallet ? [[n.wallet, n] as const] : [])),
  );
  const seeds = new Map<string, { kolName: string | null; ties: Map<string, KolTie> }>();
  for (const g of groups) {
    const ties = new Map<string, KolTie>();
    for (const w of g.wallets)
      if (w.wallet !== g.kolWallet) ties.set(w.wallet, w.known ? "known" : w.funded ? "funded" : "side");
    seeds.set(g.kolWallet, { kolName: g.kolName, ties });
  }
  for (const k of kols) {
    if (!seeds.has(k.wallet)) seeds.set(k.wallet, { kolName: k.name, ties: new Map() });
  }
  const out: KolControl[] = [];
  for (const [kolWallet, seed] of seeds) {
    const tie = new Map<string, KolTie>();
    if (holders.has(kolWallet)) tie.set(kolWallet, "kol");
    for (const [w, t] of seed.ties) if (holders.has(w) && !tie.has(w)) tie.set(w, t);
    // One step out: holders sharing a funder cluster or a funding minute with any of those.
    for (const w of [...tie.keys()]) {
      const n = holders.get(w)!;
      for (const o of holders.values()) {
        if (!o.wallet || tie.has(o.wallet)) continue;
        if (n.cluster !== null && o.cluster === n.cluster) tie.set(o.wallet, "cluster");
        else if (n.sameTime !== null && o.sameTime === n.sameTime) tie.set(o.wallet, "same-minute");
      }
    }
    const wallets = [...tie]
      .map(([wallet, t]) => ({ wallet, pct: holders.get(wallet)!.pct, tie: t }))
      .sort((a, b) => Number(b.tie === "kol") - Number(a.tie === "kol") || b.pct - a.pct);
    if (wallets.filter((w) => w.tie !== "kol").length === 0) continue;
    out.push({
      kolWallet,
      kolName: seed.kolName,
      holds: tie.has(kolWallet),
      wallets,
      pct: Math.round(wallets.reduce((t, w) => t + w.pct, 0) * 100) / 100,
    });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/** KOL Bundled % as the map draws it: every KOL group's holders, each counted once (core's kolBundledPct). */
export function kolBundledShare(kols: readonly KolControl[]): number {
  const pct = new Map(kols.flatMap((k) => k.wallets.map((w) => [w.wallet, w.pct] as const)));
  return Math.round([...pct.values()].reduce((t, p) => t + p, 0) * 100) / 100;
}

/** A side group's bubbles on the map: the KOL's own when it holds, then its possible side wallets. */
export function sideMembers(graph: Pick<BubbleGraph, "nodes">, g: SideGroup): MapNode[] {
  const wallets = new Set([g.kolWallet, ...g.wallets.map((w) => w.wallet)]);
  return graph.nodes.filter((n) => n.kind === "holder" && !!n.wallet && wallets.has(n.wallet));
}

/**
 * A KOL pill's word: "funded" when every side wallet on the map is one the KOL funded (no question
 * mark: the tie is on chain), "side" or "sides" when they are all its Known Sides or funded ones,
 * else "side?" for one possible side wallet and "sides?" for more.
 */
export function sideWord(members: readonly MapNode[], g: SideGroup): string {
  const { known, funded, possible } = sideCounts(members, g);
  if (possible === 0 && known > 0) return known + funded > 1 ? "sides" : "side";
  if (possible === 0 && funded > 0) return "funded";
  return known + funded + possible > 1 ? "sides?" : "side?";
}

/** The ties a side group draws, as the layout pulls them: each member to the KOL, else to the largest. */
export function sideTiesOf(
  graph: Pick<BubbleGraph, "nodes">,
  groups: readonly SideGroup[],
): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const g of groups) {
    const members = sideMembers(graph, g);
    if (members.length < 2) continue;
    const top =
      members.find((n) => n.wallet === g.kolWallet) ?? [...members].sort((a, b) => b.pct - a.pct)[0]!;
    for (const n of members) if (n !== top) out.push({ from: n.id, to: top.id });
  }
  return out;
}

/** A KOL's bundle on the map: its own bubble when it holds, and every holder tied to it (kolControl). */
export function kolBundleNodes(
  graph: Pick<BubbleGraph, "nodes">,
  k: Pick<KolControl, "kolWallet" | "wallets">,
): { kol: MapNode | null; members: MapNode[] } {
  const wallets = new Set(k.wallets.map((w) => w.wallet));
  const members = graph.nodes.filter((n) => n.kind === "holder" && !!n.wallet && wallets.has(n.wallet));
  return { kol: members.find((n) => n.wallet === k.kolWallet) ?? null, members };
}

/**
 * The map laid out again with the ties that are switched on pulled together (each exchange's
 * holders; each KOL and its possible side wallets), on copies of the nodes: the original layout
 * stands untouched for when they're off. Each KOL's bundle (`kols`) is pulled together too, and
 * its pill kept by the KOL (user ask 2026-10-15: each KOL's bundle easy to pick out).
 */
export function regroupLayout(
  graph: BubbleGraph,
  opts: { cex?: boolean; sides?: readonly SideGroup[]; kols?: readonly KolControl[] },
): BubbleGraph {
  const copy = { ...graph, nodes: graph.nodes.map((n) => ({ ...n })) };
  const kolTies: { from: string; to: string }[] = [];
  const kolHubs: { id: string; anchor: string | null; members: string[] }[] = [];
  for (const k of opts.kols ?? []) {
    const { kol, members } = kolBundleNodes(copy, k);
    if (members.length < 2) continue;
    const top = kol ?? [...members].sort((a, b) => b.pct - a.pct)[0]!;
    for (const n of members) if (n !== top) kolTies.push({ from: n.id, to: top.id });
    kolHubs.push({ id: `kol:${k.kolWallet}`, anchor: kol?.id ?? null, members: members.map((n) => n.id) });
  }
  return layoutGraph(copy, undefined, {
    cex: opts.cex,
    sideTies: opts.sides && opts.sides.length > 0 ? sideTiesOf(copy, opts.sides) : undefined,
    kolTies,
    kolHubs,
  });
}

/** Whether a map needs regroupLayout: a tie switched on, or a KOL bundling any holder. */
export function needsRegroup(opts: {
  cex?: boolean;
  sides?: readonly SideGroup[];
  kols?: readonly KolControl[];
}): boolean {
  return !!opts.cex || (opts.sides?.length ?? 0) > 0 || (opts.kols?.length ?? 0) > 0;
}

/**
 * The shape round a KOL's bundle (user ask 2026-10-15): its bubbles grown by `pad`, joined by bands
 * along the shortest ties that connect them all, so it hugs the bundle like a cluster's halo
 * rather than boxing in the holders between. Drawn as an outline. Empty under two bubbles.
 */
export function bundleOutline(
  nodes: readonly Pick<MapNode, "x" | "y" | "r">[],
  pad = HALO_PAD + 5,
): Pick<ClusterHalo, "circles" | "bands"> {
  if (nodes.length < 2) return { circles: [], bands: [] };
  const circles = nodes.map((n) => ({ x: n.x, y: n.y, r: n.r + pad }));
  // Prim's tree over the gaps between bubbles: each joins the bundle by its nearest member.
  const bands: ClusterHalo["bands"] = [];
  const inTree = [0];
  const rest = new Set(nodes.map((_, i) => i).slice(1));
  const gap = (a: number, b: number) =>
    Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.y - nodes[b]!.y) - nodes[a]!.r - nodes[b]!.r;
  while (rest.size > 0) {
    let best: [number, number] | null = null;
    for (const a of inTree)
      for (const b of rest) if (!best || gap(a, b) < gap(best[0], best[1])) best = [a, b];
    const [a, b] = best!;
    bands.push({ x1: nodes[a]!.x, y1: nodes[a]!.y, x2: nodes[b]!.x, y2: nodes[b]!.y });
    inTree.push(b);
    rest.delete(b);
  }
  return { circles, bands };
}

/** The same-exchange groups behind the ties: each exchange, its holders on the map, and their share; largest first. */
export function cexGroupsOf(graph: Pick<BubbleGraph, "nodes" | "cexLinks">): {
  funder: string;
  nodes: MapNode[];
  pct: number;
}[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map<string, Set<string>>();
  for (const l of graph.cexLinks) {
    const ids = groups.get(l.funder) ?? new Set<string>();
    ids.add(l.to).add(l.from);
    groups.set(l.funder, ids);
  }
  return [...groups]
    .map(([funder, ids]) => {
      const nodes = [...ids].map((id) => byId.get(id)).filter((n): n is MapNode => !!n);
      return { funder, nodes, pct: Math.round(nodes.reduce((s, n) => s + n.pct, 0) * 100) / 100 };
    })
    .sort((a, b) => b.pct - a.pct);
}

/**
 * The groups to list under the map, each holding only once (user ask 2026-10-15): when groups of
 * different kinds (a funder's cluster, a funding minute, a KOL's bundle) share a
 * wallet, only the largest by share of supply is kept, more wallets breaking a tie. Groups of the
 * same kind all stay. Keeps the order given. Exchanges' groups aren't confirmed clusters, so
 * callers leave them out (user ask 2026-10-15).
 */
export function largestSourceOnly<T extends { kind: string; pct: number; wallets: readonly string[] }>(
  groups: readonly T[],
): T[] {
  const ranked = [...groups].sort((a, b) => b.pct - a.pct || b.wallets.length - a.wallets.length);
  const owner = new Map<string, Set<string>>();
  const kept = new Set<T>();
  for (const g of ranked) {
    if (g.wallets.some((w) => [...(owner.get(w) ?? [])].some((k) => k !== g.kind))) continue;
    kept.add(g);
    for (const w of g.wallets) owner.set(w, (owner.get(w) ?? new Set()).add(g.kind));
  }
  return groups.filter((g) => kept.has(g));
}

// ---------------------------------------------------------------------------------------------
// The layout

/** Gap between bubbles, map units. */
const GAP = 9;
/** How far a line between two bubbles keeps off any other bubble's edge, map units. */
const LINE_CLEARANCE = 6;

/**
 * Places the nodes with a small fixed-step force layout: each cluster starts around its own spot
 * on a ring, holders are pulled to their funder, every bubble pushes overlapping ones apart, and
 * a light pull keeps it all near the middle. Bubbles that sit on a line between two others are
 * pushed off it, so no line runs under a bubble it doesn't belong to (user ask 2026-10-14). Each
 * pill gets a room too, a box by its funder's diamond, KOL or wallets that the bubbles make way
 * for, and its spot goes on `labelSpots` for placeLabels (user ask 2026-10-15: less overlap,
 * shorter label lines). Deterministic (no randomness), so the dialog and the share image draw the
 * same map. Mutates and returns `graph`.
 */
export function layoutGraph(
  graph: BubbleGraph,
  iterations = 320,
  opts: {
    /** Pull holders the same exchange funded together too (the map's same-exchange toggle). */
    cex?: boolean;
    /** Pull each KOL's possible side wallets to it (sideTiesOf; the map's side-wallet toggle). */
    sideTies?: readonly { from: string; to: string }[];
    /** Each KOL's bundle pulled toward the KOL (or its largest holder), gently. */
    kolTies?: readonly { from: string; to: string }[];
    /** Each KOL's pill: by the KOL's bubble when it holds, else by its bundle; for keeping room for it. */
    kolHubs?: readonly { id: string; anchor: string | null; members: readonly string[] }[];
  } = {},
): BubbleGraph {
  const { nodes, links } = graph;
  if (nodes.length === 0) return graph;
  const index = new Map(nodes.map((n) => [n.id, n]));
  const rooms = labelRooms(graph, index, opts);
  const fundingLines = links.flatMap((l) => {
    const a = index.get(l.from);
    const b = index.get(l.to);
    return a && b ? [[a, b] as const] : [];
  });
  // Every line the map draws between two bubbles, for keeping other bubbles off them.
  const segments = [
    ...links,
    ...graph.sameTimeLinks,
    ...(opts.cex ? graph.cexLinks : []),
    ...(opts.sideTies ?? []),
  ].flatMap((l) => {
    const a = index.get(l.from);
    const b = index.get(l.to);
    return a && b && a !== b ? [[a, b] as const] : [];
  });
  // Each holder's starting group: its cluster; else its same-minute group, so the group starts
  // together and its lines stay short (user ask 2026-10-15); else the unlinked.
  const sameBase = graph.clusters.length;
  const looseGroup = sameBase + graph.sameTimeGroups.length;
  const groupOf = (n: MapNode) => n.cluster ?? (n.sameTime !== null ? sameBase + n.sameTime : looseGroup);
  const used = [...new Set(nodes.map(groupOf))].sort((a, b) => a - b);
  const slotOf = new Map(used.map((g, i) => [g, i]));
  const groups = used.length;
  const ring = groups <= 1 ? 0 : 70 + 26 * groups;

  // Start: each cluster's hub on a ring, its members around it; the unclustered on the far side.
  const groupAngle = (g: number) => -Math.PI / 2 + (2 * Math.PI * g) / Math.max(1, groups);
  const centre = new Map<number, { x: number; y: number }>();
  for (let g = 0; g < groups; g += 1) {
    centre.set(g, { x: Math.cos(groupAngle(g)) * ring, y: Math.sin(groupAngle(g)) * ring });
  }
  const members = new Map<number, MapNode[]>();
  for (const n of nodes) {
    const g = slotOf.get(groupOf(n))!;
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
      const want = a.r + b.r + 24;
      if (dist <= want) continue;
      // Firmer between holders no cluster holds, so the group sits tight round its pill.
      const k = ((dist - want) / dist) * (a.cluster === null && b.cluster === null ? 0.1 : 0.04);
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k;
      b.y -= dy * k;
    }
    // Same-exchange ties, when drawn: a firmer pull, so each exchange's holders gather.
    if (opts.cex) {
      for (const l of graph.cexLinks) {
        const a = index.get(l.from);
        const b = index.get(l.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const want = a.r + b.r + 18;
        if (dist <= want) continue;
        const k = ((dist - want) / dist) * 0.09;
        a.x += dx * k;
        a.y += dy * k;
        b.x -= dx * k * 0.5;
        b.y -= dy * k * 0.5;
      }
    }
    // Side-wallet ties, when drawn: as firm as the exchange ties.
    for (const l of opts.sideTies ?? []) {
      const a = index.get(l.from);
      const b = index.get(l.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const want = a.r + b.r + 18;
      if (dist <= want) continue;
      const k = ((dist - want) / dist) * 0.09;
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k * 0.5;
      b.y -= dy * k * 0.5;
    }
    // Each KOL's bundle: a gentle pull, so it sits together without tearing its clusters apart.
    for (const l of opts.kolTies ?? []) {
      const a = index.get(l.from);
      const b = index.get(l.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const want = a.r + b.r + 26;
      if (dist <= want) continue;
      const k = ((dist - want) / dist) * 0.03;
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k * 0.3;
      b.y -= dy * k * 0.3;
    }
    // Lines: once the groups have formed, a bubble lying on another pair's line moves off it,
    // and the line's ends give a little the other way.
    if (it >= iterations * 0.3) {
      for (const [a, b] of segments) {
        const sx = b.x - a.x;
        const sy = b.y - a.y;
        const len2 = sx * sx + sy * sy;
        if (len2 < 1) continue;
        for (const n of nodes) {
          if (n === a || n === b) continue;
          const t = Math.max(0, Math.min(1, ((n.x - a.x) * sx + (n.y - a.y) * sy) / len2));
          const px = a.x + sx * t;
          const py = a.y + sy * t;
          let dx = n.x - px;
          let dy = n.y - py;
          let dist = Math.hypot(dx, dy);
          const want = n.r + LINE_CLEARANCE;
          if (dist >= want) continue;
          if (dist < 0.01) {
            // Dead on the line: step off to its left.
            dx = -sy;
            dy = sx;
            dist = Math.sqrt(len2);
          }
          const push = ((want - dist) / dist) * 0.3;
          n.x += dx * push;
          n.y += dy * push;
          a.x -= dx * push * 0.15 * (1 - t);
          a.y -= dy * push * 0.15 * (1 - t);
          b.x -= dx * push * 0.15 * t;
          b.y -= dy * push * 0.15 * t;
        }
      }
    }
    // The pills' room: each pulled to its anchor or its wallets, kept clear of bubbles and of
    // each other, so the labels land beside what they name (user ask 2026-10-15).
    if (it > 0 && it % 40 === 0) for (const r of rooms) aimRoom(r, nodes);
    stepRooms(rooms, nodes, fundingLines);
    // Gravity toward the middle, stronger for the unlinked so clusters keep their room.
    for (const n of nodes) {
      const g = n.cluster === null ? 0.012 : 0.02;
      n.x -= n.x * g * cool + n.x * 0.002;
      n.y -= n.y * g * cool + n.y * 0.002;
    }
    collide(nodes);
  }
  // The rooms pushed some bubbles about: part any that ended up touching, then settle the rooms
  // round the bubbles as they now stand.
  for (let i = 0; i < 30; i += 1) collide(nodes);
  for (const r of rooms) aimRoom(r, nodes);
  for (let i = 0; i < 40; i += 1) stepRooms(rooms, nodes, fundingLines, true);
  // Then only out of the way, so no room is left a step inside a bubble's berth.
  for (let i = 0; i < 12; i += 1) stepRooms(rooms, nodes, fundingLines, true, false);
  graph.labelSpots = new Map(rooms.map((r) => [r.id, { x: r.x, y: r.y }]));
  return graph;
}

/** Whether a bubble wears a ring past its edge: a same-minute group's, or a risky wallet's. */
function ringed(n: Pick<MapNode, "sameTime" | "flags">): boolean {
  return n.sameTime !== null || n.flags.some((f) => f !== "creator");
}

/** Collisions: bubbles in different clusters keep a wider berth. */
function collide(nodes: readonly MapNode[]) {
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

/**
 * A pill's room in the layout: a box the size the pill will about be, tied to the funder's diamond
 * it names (anchor) or to the middle of the wallets its lines reach (members).
 */
interface LabelRoom {
  id: string;
  w: number;
  h: number;
  x: number;
  y: number;
  anchor: MapNode | null;
  members: MapNode[];
  /** Whether it has a spot yet (set on the first step). */
  set: boolean;
  /** The way it sits off its anchor or wallets (aimRoom). */
  dir: readonly [number, number];
  /** Bubbles it may part to make its room, besides its own (a KOL's bundle). */
  group?: ReadonlySet<MapNode>;
}

/**
 * The rooms' nominal sizes, map units: about the dialog's pills (5.6 a character plus 14) for a
 * typical name, so the dialog and the share image keep the same room whatever names load.
 */
const ROOM_H = 18;
/** What placeLabels charges a pill for each map unit it sits off its anchor (against 1 a line point, 60 a bubble). */
const LABEL_DISTANCE_COST = 0.15;
/** How far past the middle of its wallets a hub's room aims, as a share of the group's reach. */
const HUB_REACH = 0.4;
/** How much of a room's overlap with its own group's bubbles the room takes; the bubbles take the rest. */
const ROOM_SHARE = 0.2;
const ROOM_W = { funder: 82, same: 150, cex: 70, side: 112 } as const;

function labelRooms(
  graph: BubbleGraph,
  index: ReadonlyMap<string, MapNode>,
  opts: {
    cex?: boolean;
    kolHubs?: readonly { id: string; anchor: string | null; members: readonly string[] }[];
  },
): LabelRoom[] {
  const rooms: LabelRoom[] = [];
  const hub = (id: string, members: MapNode[], w: number) => {
    if (members.length === 0) return;
    rooms.push({ id, w, h: ROOM_H, x: 0, y: 0, anchor: null, members, set: false, dir: [0, 1] });
  };
  for (const n of graph.nodes)
    if (n.kind === "funder")
      rooms.push({
        id: n.id,
        w: ROOM_W.funder,
        h: ROOM_H,
        x: 0,
        y: 0,
        anchor: n,
        members: [],
        set: false,
        dir: [0, 1],
      });
  graph.sameTimeGroups.forEach((_, i) =>
    hub(
      `same:${i}`,
      graph.nodes.filter((n) => n.kind === "holder" && n.sameTime === i),
      ROOM_W.same,
    ),
  );
  if (opts.cex) for (const g of cexGroupsOf(graph)) hub(`cex:${g.funder}`, g.nodes, ROOM_W.cex);
  for (const k of opts.kolHubs ?? []) {
    const anchor = k.anchor ? index.get(k.anchor) : undefined;
    if (anchor)
      rooms.push({
        id: k.id,
        w: ROOM_W.side,
        h: ROOM_H,
        x: 0,
        y: 0,
        anchor,
        members: [],
        set: false,
        dir: [0, 1],
        group: new Set(k.members.flatMap((id) => index.get(id) ?? [])),
      });
    else
      hub(
        k.id,
        k.members.flatMap((id) => index.get(id) ?? []),
        ROOM_W.side,
      );
  }
  return rooms;
}

/** Where a room is pulled: just off its anchor, or a little out from its wallets' middle, its way (aimRoom). */
function roomTarget(r: LabelRoom): { x: number; y: number } {
  const c = r.anchor ? { x: r.anchor.x, y: r.anchor.y } : centreOf(r.members);
  // A hub pill aims near the middle of its wallets (the room's push finds the nearest clear spot),
  // which keeps its lines shortest; a funder's or KOL's pill sits off its bubble.
  const reach = r.anchor
    ? r.anchor.r
    : HUB_REACH * Math.max(0, ...r.members.map((m) => Math.hypot(m.x - c.x, m.y - c.y) + m.r));
  const [ux, uy] = r.dir;
  // Clear of the anchor's rings (a holder's reach about 10 past its edge, a diamond's its own).
  const ring = r.anchor && r.anchor.kind !== "funder" ? 12 : 4;
  const out = reach + ring + Math.abs(ux) * (r.w / 2) + Math.abs(uy) * (r.h / 2);
  return { x: c.x + ux * out, y: c.y + uy * out };
}

/** The directions a room may sit off its anchor or wallets: the sides first, then the diagonals. */
const ROOM_DIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7],
];

/**
 * Points a room the way with most room: of the eight directions, the one whose spot covers the
 * fewest other bubbles, leaning outward from the middle of the map on a tie (user ask 2026-10-15:
 * a label beside what it names, not pushed out across the map).
 */
function aimRoom(r: LabelRoom, nodes: readonly MapNode[]) {
  const own = new Set<MapNode>([...r.members, ...(r.anchor ? [r.anchor] : [])]);
  const c = r.anchor ? { x: r.anchor.x, y: r.anchor.y } : centreOf(r.members);
  const d = Math.hypot(c.x, c.y) || 1;
  let best: { dir: readonly [number, number]; score: number } | null = null;
  for (const dir of ROOM_DIRS) {
    const t = roomTarget({ ...r, dir });
    let score = -(dir[0] * c.x + dir[1] * c.y) / d;
    for (const n of nodes) {
      if (own.has(n)) continue;
      const cx = Math.max(t.x - r.w / 2, Math.min(n.x, t.x + r.w / 2));
      const cy = Math.max(t.y - r.h / 2, Math.min(n.y, t.y + r.h / 2));
      const gap = Math.hypot(cx - n.x, cy - n.y) - (n.r + 10);
      if (gap < 0) score += 2 + -gap / 10;
    }
    if (!best || score < best.score) best = { dir, score };
  }
  r.dir = best!.dir;
}

/**
 * One step of the rooms: each pulled to its target (its wallets pulled a little toward it), pushed
 * out of every bubble and every other room. `settle` moves only the rooms, once the bubbles are set.
 */
function stepRooms(
  rooms: LabelRoom[],
  nodes: readonly MapNode[],
  lines: readonly (readonly [MapNode, MapNode])[],
  settle = false,
  pull = true,
) {
  for (const r of rooms) {
    if (!pull) break;
    if (!r.set) {
      // First step: aimed the roomiest way, and placed there.
      r.set = true;
      aimRoom(r, nodes);
      const t0 = roomTarget(r);
      r.x = t0.x;
      r.y = t0.y;
    }
    const t = roomTarget(r);
    r.x += (t.x - r.x) * 0.1;
    r.y += (t.y - r.y) * 0.1;
    // A hub's wallets drawn in together a little, so its lines stay short; toward their own middle,
    // not the room, which would walk the group off the map.
    if (!settle && !r.anchor && r.members.length > 1) {
      const c = centreOf(r.members);
      for (const m of r.members) {
        m.x += (c.x - m.x) * 0.015;
        m.y += (c.y - m.y) * 0.015;
      }
    }
  }
  for (const r of rooms) {
    for (const n of nodes) {
      // The box's nearest point to the bubble, and how far inside the bubble's berth it is: clear
      // of the rings round a bubble (about 9 past its edge), as placeLabels measures it.
      const own = n === r.anchor || r.members.includes(n);
      const want = (n.kind === "funder" ? n.r : n.r + (ringed(n) ? 10 : 4)) + (own ? 2 : 6);
      const cx = Math.max(r.x - r.w / 2, Math.min(n.x, r.x + r.w / 2));
      const cy = Math.max(r.y - r.h / 2, Math.min(n.y, r.y + r.h / 2));
      let dx = cx - n.x;
      let dy = cy - n.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= want) continue;
      if (dist < 0.01) {
        // The bubble's centre is inside the box: out the nearer side, up or down.
        dx = 0;
        dy = r.y >= n.y ? 1 : -1;
        dist = 1;
      }
      const push = (want - dist) / dist;
      // The room parts only its own group (the anchor's cluster, or the wallets its lines reach),
      // and makes way for everything else: pushing other bubbles would drive them off the map.
      const group =
        own ||
        !!r.group?.has(n) ||
        (r.anchor !== null && r.anchor.cluster !== null && n.cluster === r.anchor.cluster);
      // A hub's own wallets mostly hold their place too: parting them would stretch its lines.
      const share =
        settle || n === r.anchor || !group ? 1 : !r.anchor && r.members.includes(n) ? 0.7 : ROOM_SHARE;
      r.x += dx * push * share;
      r.y += dy * push * share;
      if (!settle) {
        n.x -= dx * push * (1 - share);
        n.y -= dy * push * (1 - share);
      }
    }
  }
  // Off the funding lines (bent as the map draws them), so no pill sits on one.
  for (const r of rooms) {
    for (const [a, b] of lines) {
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
      const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
      for (let k = 1; k < 8; k += 1) {
        const t = k / 8;
        const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
        const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y;
        const ox = r.w / 2 + 4 - Math.abs(px - r.x);
        const oy = r.h / 2 + 4 - Math.abs(py - r.y);
        if (ox <= 0 || oy <= 0) continue;
        if (oy < ox) r.y += (r.y >= py ? 1 : -1) * oy * 0.5;
        else r.x += (r.x >= px ? 1 : -1) * ox * 0.5;
      }
    }
  }
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = rooms[i]!;
      const b = rooms[j]!;
      const ox = (a.w + b.w) / 2 + 6 - Math.abs(a.x - b.x);
      const oy = (a.h + b.h) / 2 + 6 - Math.abs(a.y - b.y);
      if (ox <= 0 || oy <= 0) continue;
      // Apart along the shallower overlap.
      if (oy < ox) {
        const s = a.y <= b.y ? -1 : 1;
        a.y += (s * oy) / 2;
        b.y -= (s * oy) / 2;
      } else {
        const s = a.x <= b.x ? -1 : 1;
        a.x += (s * ox) / 2;
        b.x -= (s * ox) / 2;
      }
    }
  }
}

/** The box the laid-out map fills, with room for the badges and labels around the bubbles. */
/** A label to place near an anchor (a funder's diamond, an exchange's tie): its box size in map units. */
export interface MapLabel {
  id: string;
  /** Its anchor: a bubble, or the middle of the wallets a hub label ties together. */
  x: number;
  y: number;
  /** How far from the anchor's centre the box may start (the anchor's own radius; 0 for a hub). */
  r: number;
  w: number;
  h: number;
  /** A hub's wallets, each tied to the label by a line: a spot whose lines cross other bubbles costs more. */
  members?: readonly Pick<MapNode, "id" | "x" | "y">[];
}

/** A placed label: its box's centre, and whether it moved off its anchor far enough to want a leader line. */
export interface PlacedLabel {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  far: boolean;
}

/**
 * Places each label in the first spot around its anchor that covers no bubble, no other label and
 * no drawn line: below first, then above, the sides and the diagonals, stepping further out. A
 * label with no clear spot takes the one that covers least. Deterministic, like the layout.
 */
export function placeLabels(
  graph: Pick<BubbleGraph, "nodes" | "links" | "labelSpots">,
  labels: readonly MapLabel[],
): PlacedLabel[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Every drawn line as sample points (funding links bend, as the map draws them).
  const points: { x: number; y: number }[] = [];
  const sample = (ax: number, ay: number, bx: number, by: number, bend: number) => {
    const mx = (ax + bx) / 2 + (by - ay) * bend;
    const my = (ay + by) / 2 - (bx - ax) * bend;
    const steps = Math.max(4, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      points.push({
        x: (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * mx + t * t * bx,
        y: (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * my + t * t * by,
      });
    }
  };
  // The funding links (hub labels' own spokes depend on where they land, so they aren't known yet).
  for (const l of graph.links) {
    const a = byId.get(l.from);
    const b = byId.get(l.to);
    if (a && b) sample(a.x, a.y, b.x, b.y, 0.12);
  }
  // Bubbles with their rings (same-minute and risk rings reach about 9 past the edge, plus their stroke).
  const circles = graph.nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    // A ringed bubble (same minute, risky) reaches about 9 past its edge; a plain one about 3.
    r: n.kind === "funder" ? n.r * 0.95 : n.r + (ringed(n) ? 9 : 3),
    // The bubble itself, for the hub lines: they may pass its rings, not cut through it.
    body: n.r + 2,
  }));
  /** Bubbles the lines from (x, y) to a hub's wallets cut through, other than those wallets. */
  const crossings = (x: number, y: number, members: readonly Pick<MapNode, "id" | "x" | "y">[]): number => {
    const own = new Set(members.map((m) => m.id));
    let c = 0;
    for (const m of members) {
      const sx = m.x - x;
      const sy = m.y - y;
      const len2 = sx * sx + sy * sy || 1;
      for (const k of circles) {
        // Its own bubbles, and the one the line starts from (a leader's anchor), don't count.
        if (own.has(k.id) || Math.abs(k.x - m.x) + Math.abs(k.y - m.y) < 0.5) continue;
        const t = Math.max(0, Math.min(1, ((k.x - x) * sx + (k.y - y) * sy) / len2));
        if (Math.hypot(k.x - (x + sx * t), k.y - (y + sy * t)) < k.body) c += 1;
      }
    }
    return c;
  };

  const placed: PlacedLabel[] = [];
  const cost = (x: number, y: number, w: number, h: number): number => {
    const x0 = x - w / 2 - 2;
    const x1 = x + w / 2 + 2;
    const y0 = y - h / 2 - 2;
    const y1 = y + h / 2 + 2;
    let c = 0;
    for (const k of circles) {
      const dx = k.x - Math.max(x0, Math.min(k.x, x1));
      const dy = k.y - Math.max(y0, Math.min(k.y, y1));
      if (dx * dx + dy * dy < k.r * k.r) c += 60;
    }
    for (const p of placed) {
      if (Math.abs(p.x - x) * 2 < p.w + w + 4 && Math.abs(p.y - y) * 2 < p.h + h + 4) c += 30;
    }
    for (const p of points) if (p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1) c += 1;
    return c;
  };
  // Below, above, right, left, then the diagonals.
  const dirs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [0.7, 0.7],
    [-0.7, 0.7],
    [0.7, -0.7],
    [-0.7, -0.7],
    [0.92, 0.38],
    [-0.92, 0.38],
    [0.92, -0.38],
    [-0.92, -0.38],
    [0.38, 0.92],
    [-0.38, 0.92],
    [0.38, -0.92],
    [-0.38, -0.92],
  ] as const;
  // A funder's pill wants a leader line once its box sits this far off the diamond.
  const farOff = (l: MapLabel, x: number, y: number) => {
    const gx = Math.max(0, Math.abs(l.x - x) - l.w / 2);
    const gy = Math.max(0, Math.abs(l.y - y) - l.h / 2);
    return Math.hypot(gx, gy) - l.r >= 12;
  };
  for (const l of labels) {
    let best: { x: number; y: number; c: number; far: boolean } | null = null;
    // The room the layout kept for it, when it's clear (user ask 2026-10-15: labels by what they name).
    const spot = graph.labelSpots?.get(l.id);
    // Each spot's cost, plus a little for every map unit it sits off its anchor: a pill brushing a
    // line beside what it names beats one clear across the map (user ask 2026-10-15).
    // A pill off its bubble (a funder's or KOL's) has a leader line back to it: that line, too,
    // should cross no other bubble.
    const anchorAt = l.r > 0 ? [{ id: l.id, x: l.x, y: l.y }] : null;
    const score = (x: number, y: number) => {
      const lines = l.members ?? (anchorAt && farOff(l, x, y) ? anchorAt : null);
      const c = cost(x, y, l.w, l.h) + (lines ? crossings(x, y, lines) * 6 : 0);
      const gx = Math.max(0, Math.abs(l.x - x) - l.w / 2);
      const gy = Math.max(0, Math.abs(l.y - y) - l.h / 2);
      return { c, s: c + Math.max(0, Math.hypot(gx, gy) - l.r) * LABEL_DISTANCE_COST };
    };
    if (spot) {
      const { c, s } = score(spot.x, spot.y);
      best = { x: spot.x, y: spot.y, c: s, far: farOff(l, spot.x, spot.y) };
      // Clear and close: taken as it is. Clear but pushed well off: the search below may beat it.
      if (c === 0 && s - c < 3) {
        placed.push({ id: l.id, x: best.x, y: best.y, w: l.w, h: l.h, far: best.far });
        continue;
      }
    }
    search: for (const step of [0, 6, 12, 20, 30, 42, 58, 84, 116, 150]) {
      if (best && step * LABEL_DISTANCE_COST > best.c) break;
      for (const [dx, dy] of dirs) {
        // Out from the anchor's edge until the box clears it along that direction.
        const reach = l.r + step + 6 + Math.abs(dx) * (l.w / 2) + Math.abs(dy) * (l.h / 2);
        const x = l.x + dx * reach;
        const y = l.y + dy * reach;
        const { c, s } = score(x, y);
        if (!best || s < best.c) best = { x, y, c: s, far: farOff(l, x, y) };
        if (c === 0) break search;
      }
    }
    placed.push({ id: l.id, x: best!.x, y: best!.y, w: l.w, h: l.h, far: best!.far });
  }
  return placed;
}

export function graphBounds(
  graph: BubbleGraph,
  pad = 18,
  /** Placed labels the box must hold too. */
  labels: readonly PlacedLabel[] = [],
): { x: number; y: number; w: number; h: number } {
  if (graph.nodes.length === 0) return { x: -50, y: -50, w: 100, h: 100 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of graph.nodes) {
    x0 = Math.min(x0, n.x - n.r);
    y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r);
    y1 = Math.max(y1, n.y + n.r);
  }
  for (const l of labels) {
    x0 = Math.min(x0, l.x - l.w / 2);
    y0 = Math.min(y0, l.y - l.h / 2);
    x1 = Math.max(x1, l.x + l.w / 2);
    y1 = Math.max(y1, l.y + l.h / 2);
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

/** Holders the linked reading covered on scans that didn't keep the count: RugCheck's top 20. */
const LINKED_HOLDERS_READ = 20;

/**
 * Linked as a count (user ask 2026-10-13): how many top holders are in a linked cluster, of how
 * many were read, shown "N/25". Scans before the count was kept count the clusters' wallets. Null
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

/**
 * Same-minute funding as a count (user ask 2026-10-13): how many top holders sit in a same-minute
 * group, of how many were read, "N/25". Scans before the count was kept count the groups' wallets.
 */
export function sameTimeCount(
  s: Pick<
    Snapshot,
    | "sameTimeFundedPct"
    | "sameTimeFundedCount"
    | "sameTimeClusters"
    | "linkedWalletPct"
    | "linkedWalletCount"
    | "linkedWalletsChecked"
    | "linkedClusters"
    | "linkedHolders"
  >,
): { linked: number; of: number } | null {
  if (s.sameTimeFundedPct == null) return null;
  const of = linkedCount(s)?.of ?? (s.linkedWalletsChecked || s.linkedHolders?.length || LINKED_HOLDERS_READ);
  if (s.sameTimeFundedCount != null) return { linked: s.sameTimeFundedCount, of };
  const wallets = new Set((s.sameTimeClusters ?? []).flatMap((g) => (g?.wallets ?? []).map((w) => w.wallet)));
  return { linked: wallets.size, of };
}

/**
 * Linked as the map shows it (user ask 2026-10-15): the scan's count, plus every holder on the map
 * in a funder's cluster or a KOL's bundle (kolControl) that the scan didn't count: KOL-tied
 * holders, and those the wider map links. When any of those ranks past the holders the scan read,
 * the count is out of every holder the wider map read, so the ratio stays true. The safety screen
 * and the models keep the scan's own count.
 */
export function mapLinked(
  graph: Pick<BubbleGraph, "nodes" | "linkedCount" | "linkedPct" | "scanLinked" | "holdersRead">,
  kols: readonly Pick<KolControl, "wallets">[] = [],
): { count: { linked: number; of: number } | null; pct: number | null } {
  const base = graph.linkedCount;
  if (base === null || graph.linkedPct === null) return { count: base, pct: graph.linkedPct };
  const holders = new Map(
    graph.nodes.flatMap((n) => (n.kind === "holder" && n.wallet ? [[n.wallet, n] as const] : [])),
  );
  const linked = new Set(
    graph.nodes.flatMap((n) => (n.kind === "holder" && n.cluster !== null && n.wallet ? [n.wallet] : [])),
  );
  for (const k of kols) for (const w of k.wallets) if (holders.has(w.wallet)) linked.add(w.wallet);
  const extra = [...linked].filter((w) => !graph.scanLinked.has(w)).map((w) => holders.get(w)!);
  if (extra.length === 0) return { count: base, pct: graph.linkedPct };
  const past = extra.flatMap((n) => (n.rank !== undefined && n.rank > base.of ? [n.rank] : []));
  const of = past.length > 0 ? Math.max(base.of, graph.holdersRead ?? 0, ...past) : base.of;
  return {
    count: { linked: base.linked + extra.length, of },
    pct: Math.round((graph.linkedPct + extra.reduce((t, n) => t + n.pct, 0)) * 100) / 100,
  };
}

/** "4/20", or null without a reading. */
export function linkedCountText(c: { linked: number; of: number } | null): string | null {
  return c ? `${c.linked}/${c.of}` : null;
}

/**
 * The reading to draw: the newest with linked clusters, else the newest whose holder list came
 * with its funders read, else with a holder list, else any linked reading. A scan whose funder
 * lookups ran past the cycle keeps the holder list without the linked reading, so the newest list
 * alone would read "not checked yet" while an earlier scan of the coin had checked them.
 */
export function pickReading<S extends Pick<Snapshot, "linkedWalletPct" | "linkedClusters" | "linkedHolders">>(
  snapshots: readonly S[],
): S | null {
  return (
    snapshots.find((s) => s.linkedWalletPct != null && (s.linkedClusters?.length ?? 0) > 0) ??
    snapshots.find((s) => s.linkedWalletPct != null && hasHolderList(s)) ??
    snapshots.find(hasHolderList) ??
    snapshots.find((s) => s.linkedWalletPct != null) ??
    null
  );
}

/**
 * Whether a reading can draw the bubble map and the holder list: it kept the top holders the scan
 * read (every scan with a list since 2026-10-13), or found linked clusters.
 */
export function hasHolderList(s: Pick<Snapshot, "linkedClusters" | "linkedHolders">): boolean {
  return (s.linkedHolders?.length ?? 0) > 0 || (s.linkedClusters?.length ?? 0) > 0;
}

/**
 * How often the worker saves a reading for a coin it is scanning (SCAN_INTERVAL_MINUTES): each
 * cycle writes a snapshot with the holder list it holds, read at most RUGCHECK_CACHE_TTL_MINUTES ago.
 */
export const HOLDER_SCAN_MS = 60_000;
/** No reading for this long means the worker has stopped scanning the coin (out of band, unviewed). */
export const HOLDER_STALE_MS = 10 * 60_000;

/**
 * When the holder reading was saved and when the next one is due: the next scan, or null once
 * none has come for HOLDER_STALE_MS, so the coin is no longer being scanned.
 */
export function holderFreshness(takenAt: string, now: number): { last: number; next: number | null } {
  const last = Date.parse(takenAt);
  if (now - last >= HOLDER_STALE_MS) return { last, next: null };
  return { last, next: Math.max(last + HOLDER_SCAN_MS, now) };
}

/**
 * How a wallet's name sits in its bubble (user ask 2026-10-14): under the %, wrapped onto at most
 * two lines no wider than NAME_MAX_W map units, the second clipped with "…". `wide` when the block
 * runs past the bubble's edge, so it gets a backing. Null for a bubble too small to carry one; its
 * name is still in the tooltip and the detail panel.
 */
export function bubbleNameLines(
  r: number,
  name: string,
  /** A Pump.fun username: shown in quotes, which stay on when the name is clipped. */
  quoted = false,
): { lines: string[]; size: number; w: number; wide: boolean } | null {
  if (r < 13) return null;
  const size = Math.min(10.5, Math.max(8, r * 0.26));
  const charW = size * 0.56;
  const maxW = Math.min(NAME_MAX_W, Math.max(r * 1.6, 44));
  const perLine = Math.max(4, Math.floor(maxW / charW));
  const text = quoted ? `"${name}"` : name;
  const lines: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && lines.length < 2) {
    // A word only a few letters too long stays whole rather than leave them on a line alone
    // ("Moonwalke" / "r"): the backing widens to hold it.
    if (rest.length <= perLine || (rest.length <= perLine + 3 && !rest.includes(" "))) {
      lines.push(rest);
      rest = "";
      break;
    }
    // Break at the last space that fits, else mid-word.
    const cut = rest.lastIndexOf(" ", perLine);
    const at = cut > perLine / 3 ? cut : perLine;
    lines.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) {
    const last = lines[lines.length - 1]!;
    const keep = last.slice(0, Math.max(1, perLine - (quoted ? 2 : 1)));
    lines[lines.length - 1] = `${keep}…${quoted ? '"' : ""}`;
  }
  const w = Math.max(...lines.map((l) => l.length)) * charW;
  // The bubble's width where the name sits, about halfway down.
  const chord = 2 * Math.sqrt(Math.max(0, r * r - (r * 0.45) ** 2));
  return { lines, size, w, wide: w > chord - 4 };
}

/** The widest a name block may get, in map units (bubbles run about 18 to 75 across). */
export const NAME_MAX_W = 64;

/** The same-exchange colours (styles.css --bm-cex-0 to 3): light tints, apart from the cluster fills. */
export const CEX_COLOURS = 4;

/** Each exchange's colour slot, in cexGroupsOf's order (largest first), so its lines, label and row match. */
export function cexSlots(graph: Pick<BubbleGraph, "nodes" | "cexLinks">): Map<string, number> {
  return new Map(cexGroupsOf(graph).map((g, i) => [g.funder, i % CEX_COLOURS]));
}

/** Words that end an exchange's name in a wallet label: "Binance Hot Wallet 2" is Binance's. */
const EXCHANGE_SUFFIX =
  /^(hot|cold|wallet|wallets|deposit|withdraw|withdrawal|withdrawals|exchange|treasury|main|old|new|#?\d+|\(.*)$/i;

/** An exchange wallet's label cut to the exchange's name ("Binance Hot Wallet 2" → "Binance"). */
export function exchangeName(label: string): string {
  const words = label.trim().split(/\s+/);
  const end = words.findIndex((w, i) => i > 0 && EXCHANGE_SUFFIX.test(w.replace(/[:,.-]+$/, "")));
  return (end < 0 ? words : words.slice(0, end)).join(" ").replace(/[:,.-]+$/, "") || label;
}

/** The middle of some bubbles: where a hub label tying them together starts its search. */
export function centreOf(nodes: readonly Pick<MapNode, "x" | "y">[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  return {
    x: nodes.reduce((s, n) => s + n.x, 0) / nodes.length,
    y: nodes.reduce((s, n) => s + n.y, 0) / nodes.length,
  };
}
