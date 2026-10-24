import type { Snapshot } from "./api";
import type { WalletNames } from "./walletNames";
import { LINKED_HOLDERS_READ, linkedCount, linkedCountText } from "./linkedCount";
import {
  crossingCount,
  laneOffsets,
  lanePoints,
  laneRoute,
  pairSign,
  type LanePoint,
  type LaneRoute,
} from "./linkLanes";

export { linkedCount, linkedCountText };

/**
 * The linked-wallets bubble map: a coin's top holders as bubbles sized by their share of supply,
 * coloured by the cluster one funder paid for, with a line from each to that funder, and the
 * risky wallets ringed.
 *
 * This file is the pure half: the graph built from a snapshot's linked clusters
 * (core's wallets/linkedWallets.ts) and the token chart's flagged wallets, and its layout, which
 * both the token view's SVG (components/BubbleMap.tsx) and the share image (bubbleMapCard.ts) draw.
 */

// ---------------------------------------------------------------------------------------------
// The top 50, for model-alerted coins

/** A holder on the wider map: rank only on those past the top 25. */
export interface WideHolder {
  wallet: string;
  pct: number;
  rank?: number;
  cexFunder?: string;
  sniper?: boolean;
  blockZero?: boolean;
  fresh?: boolean;
  empty?: boolean;
  creatorTied?: boolean;
}

/**
 * A model-alerted coin's map over its top 50 (GET /tokens/:mint/bubble-holders, user ask
 * 2026-10-14): the top 25, plus every holder ranked 26 to 50 whose funder we already know,
 * clustered by the same rules. Wallets we have never read are left off.
 */
export interface WideMap {
  readAt: string;
  /**
   * When the shares were current (the chain read, or the last holder-stream update stored with
   * them). Absent on maps from before it: the shares were current at `readAt`.
   */
  balancesAt?: string;
  /** How many holders the read listed (pools and the creator aside). */
  holdersRead: number;
  /** Of those past the top 25, how many are on the map. */
  knownExtra: number;
  holders: WideHolder[];
  clusters: NonNullable<Snapshot["linkedClusters"]>;
  /** The clusters without holder-to-holder transfers, when transfers changed them; absent otherwise. */
  clustersExTransfers?: NonNullable<Snapshot["linkedClusters"]>;
  sameTimeClusters: NonNullable<Snapshot["sameTimeClusters"]>;
}

/** The map as it stood at the coin's first model call (BubbleMapAtAlert): kept once, never updated. */
export interface AlertWideMap extends WideMap {
  /** The first call the reading is pinned to. */
  alertAt: string;
}

/** The snapshot fields a kept moment's reading carries (core's wallets/bubbleMoments.ts). */
export const MOMENT_FIELDS = [
  "linkedHolders",
  "linkedClusters",
  "sameTimeClusters",
  "holderTransfers",
  "linkedWalletPct",
  "linkedWalletCount",
  "linkedWalletsChecked",
  "top10HolderPct",
  "top10WalletsChecked",
  "sameTimeFundedPct",
  "sameTimeFundedCount",
  "cexFundedPct",
  "cexFundedCount",
  "cexFundedHolders",
  "transferredSupplyPct",
  "transferWalletCount",
  "transferHoldersChecked",
  "kolBundledPct",
  "bundledSupplyPct",
  "bundledSupplyCount",
  "linkedWalletPctExTransfers",
  "linkedWalletCountExTransfers",
  "kolBundledPctExTransfers",
  "bundledSupplyPctExTransfers",
  "bundledSupplyCountExTransfers",
  "linkedClustersExTransfers",
  "linkedCreatorPct",
] as const satisfies readonly (keyof Snapshot)[];

/**
 * A coin's map kept at another moment (BubbleMapMoment, user ask 2026-10-16): "screen", its first
 * safety-screen pass inside the band; "filter", a filter's first catch of it, kept once its owner
 * opened it and shown to them, or to everyone for a public filter.
 */
export interface BubbleMoment {
  id: string;
  kind: "screen" | "filter";
  /** The passing scan, or the filter's match. */
  at: string;
  readAt: string;
  /** The reader's own filter caught it. */
  mine: boolean;
  isPublic: boolean;
  filterName: string | null;
  reading: Partial<Pick<Snapshot, (typeof MOMENT_FIELDS)[number]>>;
}

/**
 * GET /tokens/:mint/bubble-holders. `atAlert` is absent from API builds before it was kept, and
 * `moments` from those before 2026-10-16.
 */
export interface BubbleMaps {
  map: WideMap | null;
  atAlert?: AlertWideMap | null;
  moments?: BubbleMoment[];
}

/**
 * `base` drawn as the moment's reading: every field the map and the top-holder list read is the
 * moment's (null where it had none), the rest stays `base`'s, and its time is the reading's.
 */
export function momentSnapshot<S extends Snapshot>(base: S, moment: BubbleMoment): S {
  const out: Record<string, unknown> = { ...(base as object), takenAt: moment.readAt };
  for (const key of MOMENT_FIELDS) out[key] = moment.reading?.[key] ?? null;
  return out as S;
}

/** What a moment is called on the Holders switch, and in words for its title. */
export function momentLabel(m: Pick<BubbleMoment, "kind" | "mine" | "filterName">): {
  short: string;
  long: string;
} {
  if (m.kind === "screen") return { short: "Passed screen", long: "when it first passed the safety screen" };
  const name = m.filterName ? `"${m.filterName}"` : null;
  if (m.mine)
    return {
      short: "Your filter",
      long: `when your filter${name ? ` ${name}` : ""} first caught it`,
    };
  return {
    short: "Public filter",
    long: `when the public filter${name ? ` ${name}` : ""} first caught it`,
  };
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
 * The coin's live top 50 to draw over `snapshot`, or null when it is too old for it: read more
 * than HOLDER_STALE_MS before the scan's own holder list was, and the scan has that list to draw.
 * The wider read is saved only while the coin is scanned with funder lookups, so for a coin called
 * days ago it can be days older than the list it would stand in for.
 *
 * Measured against the list's enumeration (holderShownAt), not the scan row's time: the top 50 and
 * the top 25 come from the same chain read, and a coin with no trade since keeps both lists
 * without a re-read (worker readTopHolders' quiet keep). Against takenAt, a quiet alerted coin's
 * map fell from 50 bubbles to 25 twelve minutes after its read while both lists were still current.
 */
export function liveWideFor(
  snapshot:
    | Pick<
        Snapshot,
        | "takenAt"
        | "holdersAt"
        | "holderBalancesAt"
        | "holderChainReadAt"
        | "linkedClusters"
        | "linkedHolders"
      >
    | null
    | undefined,
  wide: WideMap | null,
): WideMap | null {
  if (!wide || !snapshot || !hasHolderList(snapshot)) return wide;
  return holderShownAt(snapshot) - Date.parse(wide.readAt) > HOLDER_STALE_MS ? null : wide;
}

/**
 * The reading the map draws: the snapshot's, with the wider map's holders, clusters and
 * same-minute groups in place of its own when the coin has one. Every count (Linked N/25,
 * Same minute, CEX-funded) stays the snapshot's: the top 50 is for the picture only.
 */
export function withWideMap<
  S extends Pick<Snapshot, "linkedClusters" | "linkedHolders" | "sameTimeClusters" | "linkedWalletCount">,
>(snapshot: S, wide: WideMap | null | undefined): S & WideReading {
  if (!wide || !Array.isArray(wide.holders) || wide.holders.length === 0) return snapshot;
  return {
    ...snapshot,
    // What the scan counted as linked, and how many holders the wider read listed (mapLinked).
    scanLinkedWallets: scanLinkedOf(snapshot),
    holdersRead: wide.holdersRead,
    linkedHolders: withTraits(wide.holders, snapshot.linkedHolders),
    linkedClusters: Array.isArray(wide.clusters) ? wide.clusters : [],
    sameTimeClusters: Array.isArray(wide.sameTimeClusters) ? wide.sameTimeClusters : [],
  };
}

/**
 * The reading as it stands without holder-to-holder transfers (user ask 2026-10-16): Linked, its
 * clusters, KOL Bundled and Bundled from the funding-only figures the scan keeps beside the counted
 * ones, for the map with its transfers hidden. A scan from before they were kept reads as it is.
 */
export function withoutTransfers<
  S extends Pick<
    Snapshot,
    | "linkedWalletPct"
    | "linkedWalletCount"
    | "linkedClusters"
    | "kolBundledPct"
    | "bundledSupplyPct"
    | "bundledSupplyCount"
    | "linkedWalletPctExTransfers"
    | "linkedWalletCountExTransfers"
    | "linkedClustersExTransfers"
    | "kolBundledPctExTransfers"
    | "bundledSupplyPctExTransfers"
    | "bundledSupplyCountExTransfers"
  >,
>(s: S): S {
  if (s.linkedWalletPctExTransfers == null) return s;
  return {
    ...s,
    linkedWalletPct: s.linkedWalletPctExTransfers,
    linkedWalletCount: s.linkedWalletCountExTransfers ?? s.linkedWalletCount,
    linkedClusters: s.linkedClustersExTransfers ?? s.linkedClusters,
    kolBundledPct: s.kolBundledPctExTransfers ?? s.kolBundledPct,
    bundledSupplyPct: s.bundledSupplyPctExTransfers ?? s.bundledSupplyPct,
    bundledSupplyCount: s.bundledSupplyCountExTransfers ?? s.bundledSupplyCount,
  };
}

/** The wider map as it reads without holder-to-holder transfers (withoutTransfers' counterpart). */
export function wideWithoutTransfers<W extends WideMap>(wide: W | null | undefined): W | null | undefined {
  return wide && Array.isArray(wide.clustersExTransfers)
    ? { ...wide, clusters: wide.clustersExTransfers }
    : wide;
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
      ...(r.blockZero ? { blockZero: true } : {}),
      ...(r.fresh ? { fresh: true } : {}),
      ...(r.empty ? { empty: true } : {}),
      ...(r.creatorTied ? { creatorTied: true } : {}),
    };
  });
}

function clusterWallets(clusters: Snapshot["linkedClusters"] | undefined): string[] {
  return [...new Set((clusters ?? []).flatMap((c) => (c?.wallets ?? []).map((w) => w.wallet)))];
}

/**
 * The wallets the scan's Linked count took in: its clusters' and, since 2026-10-13, its same-minute
 * groups' (core's linkedWallets counts each holder once). A scan from before then counted only the
 * clusters, so its count falls short of the two together and the clusters alone stand.
 */
function scanLinkedOf(
  s: Pick<Snapshot, "linkedClusters" | "sameTimeClusters" | "linkedWalletCount">,
): string[] {
  const clusters = clusterWallets(s.linkedClusters);
  const both = new Set([
    ...clusters,
    ...(s.sameTimeClusters ?? []).flatMap((g) => (g?.wallets ?? []).map((w) => w.wallet)),
  ]);
  return s.linkedWalletCount != null && s.linkedWalletCount >= both.size ? [...both] : clusters;
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
 * What the scan read of a holder's wallet (user ask 2026-10-15), one per bubble: a block-zero sniper
 * (bought in the launch's own slot, user ask 2026-10-22: the "0" label), else a launch sniper
 * (among its first 25 buyers), else a fresh wallet, else an otherwise empty one.
 */
export type WalletTrait = "blockZero" | "sniper" | "fresh" | "empty";
export const WALLET_TRAITS: readonly WalletTrait[] = ["blockZero", "sniper", "fresh", "empty"];

/** Each trait's word, for the legends. */
export const TRAIT_LABEL: Record<WalletTrait, string> = {
  blockZero: "Block 0",
  sniper: "Sniper",
  fresh: "Fresh",
  empty: "Empty",
};

/**
 * Each trait's icon as stroke paths on a 24px grid, shared by the map's SVG and the share image's
 * canvas (Path2D): a zero, a bullseye, a leaf, a ghost.
 */
export const TRAIT_ICON: Record<WalletTrait, readonly string[]> = {
  blockZero: ["M12 3c-3.3 0-5.5 4-5.5 9s2.2 9 5.5 9 5.5-4 5.5-9-2.2-9-5.5-9Z", "M9 17.5 15 6.5"],
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

/** The risky wallets' mark beside the traits (user ask 2026-10-16): a red exclamation in a ring. */
export const RISKY_ICON: readonly string[] = [
  "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0Z",
  "M12 7.5v5.5",
  "M12 16.5h.01",
];

/**
 * A same-minute group's mark on each of its bubbles (user ask 2026-10-16), in place of the
 * "Funded together" pill: a clock, on a 24px grid like the traits.
 */
export const CLOCK_ICON: readonly string[] = ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0Z", "M12 7v5l3 2"];

/** The holders on the map funded the same minute as another, and their supply, for the legends. */
export function sameTimeShare(graph: Pick<BubbleGraph, "nodes">): { count: number; pct: number } {
  const nodes = graph.nodes.filter((n) => n.kind === "holder" && n.sameTime !== null);
  return { count: nodes.length, pct: Math.round(nodes.reduce((t, n) => t + n.pct, 0) * 100) / 100 };
}

/** A box a bubble's text takes (its % or its name), by its centre: map units, or pixels on the card. */
export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a bubble's corner mark goes (user ask 2026-10-16: never over its % or its name): on the rim
 * at the lower right (`side` 1, a wallet type) or lower left (-1, funded together); else the first
 * spot further round the lower rim, then a little further out each round, that clears every box.
 * `mr` is the mark's radius.
 */
export function markerSpot(
  cx: number,
  cy: number,
  r: number,
  mr: number,
  side: 1 | -1,
  boxes: readonly TextBox[],
): { x: number; y: number } {
  const clear = (x: number, y: number) =>
    boxes.every((b) => {
      const dx = Math.max(Math.abs(x - b.x) - b.w / 2, 0);
      const dy = Math.max(Math.abs(y - b.y) - b.h / 2, 0);
      return dx * dx + dy * dy >= (mr + 0.5) ** 2;
    });
  for (const out of [0, 0.35, 0.7, 1, 1.4, 2])
    for (const deg of [45, 35, 55, 25, 65, 15, 75, 0]) {
      const a = (deg * Math.PI) / 180;
      const d = r + out * mr;
      const x = cx + side * Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (clear(x, y)) return { x, y };
    }
  // Nothing on the rim clears them (a long name's backing): under the lowest box.
  const below = Math.max(cy, ...boxes.map((b) => b.y + b.h / 2));
  return { x: cx + side * r * 0.72, y: below + mr + 1 };
}

/**
 * The map spread sideways to fill a wider box (user ask 2026-10-16): each bubble's x pushed out from
 * the middle, up to `max` times, until the map's shape about matches `aspect` (width over height).
 * Only gaps grow, so no two bubbles come to overlap; a map already that wide comes back unchanged.
 */
export function stretchWide(graph: BubbleGraph, aspect: number, max = 1.45): BubbleGraph {
  if (!(aspect > 0) || graph.nodes.length < 2) return graph;
  const box = graphBounds(graph, 0);
  if (box.w <= 0 || box.h <= 0) return graph;
  const k = Math.min(max, aspect / (box.w / box.h));
  if (k <= 1.02) return graph;
  const mid = box.x + box.w / 2;
  const sx = (x: number) => mid + (x - mid) * k;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, x: sx(n.x) })),
    ...(graph.labelSpots
      ? { labelSpots: new Map([...graph.labelSpots].map(([id, p]) => [id, { x: sx(p.x), y: p.y }])) }
      : {}),
  };
}

/** Risky holders on the map (flagged risky or a known dumper, not merely the creator), and their supply. */
export function riskyShare(graph: Pick<BubbleGraph, "nodes">): { count: number; pct: number } {
  const nodes = graph.nodes.filter((n) => n.kind === "holder" && n.flags.some((f) => f !== "creator"));
  return { count: nodes.length, pct: Math.round(nodes.reduce((t, n) => t + n.pct, 0) * 100) / 100 };
}

/** A holder's trait from the scan's marks: block zero first, then sniper, fresh, empty; null for none. */
export function traitOf(
  h: { blockZero?: boolean; sniper?: boolean; fresh?: boolean; empty?: boolean } | undefined,
): WalletTrait | null {
  if (!h) return null;
  return h.blockZero ? "blockZero" : h.sniper ? "sniper" : h.fresh ? "fresh" : h.empty ? "empty" : null;
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
  /** Counted in the supply tied to the creator (tiedHolders). */
  creatorTied?: boolean;
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

/**
 * A holder that sent the coin to another holder (user ask 2026-10-16, TokenSnapshot.holderTransfers):
 * drawn as an arrow from sender to receiver. Only the coin itself counts; never in Linked.
 */
export interface TransferLink {
  /** The sender's node id. */
  from: string;
  /** The receiver's node id. */
  to: string;
  /** % of supply it sent, over every transfer between the two. */
  pct: number;
  count: number;
  lastAtMs: number | null;
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
  /** Transfers between holders on the map, sender to receiver (drawn only, never counted in Linked). */
  transferLinks: TransferLink[];
  /**
   * The clusters funding alone forms, where transfers changed the drawn ones: what a KOL's bundle
   * steps out through (kolControl's kolClusters). Absent: the drawn clusters stand for them.
   */
  fundingClusters?: Cluster[];
  /** Supply tied to the creator, and how many holders on the map hold it; null when not read. */
  creatorPct: number | null;
  creatorCount: number | null;
  /** Transferred Supply %: the coin moved holder to holder among the top 25, as read; null when not read. */
  transferPct: number | null;
  /** How many of the top holders sent or got a transfer, of how many were checked; null when not read. */
  transferCount: { linked: number; of: number } | null;
  /**
   * Where the layout kept room for each pill (layoutGraph's label room): by the label's id (a
   * funder node's id, "cex:<funder>", "side:<kol>"), the centre of the room it holds.
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
 * funder (a node of its own, or the holder that funded the rest). Every other holder is a bubble
 * too, unlinked, when the scan kept the list (linkedHolders, on scans since it was added); without
 * one, the flagged wallets the chart knows held at least MIN_FLAGGED_HELD_PCT at the call stand in. What the map
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
    | "transferredSupplyPct"
    | "transferWalletCount"
    | "transferHoldersChecked"
    | "holderTransfers"
  > &
    Partial<Pick<Snapshot, "linkedCreatorPct">> &
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
  const tied = tiedHolders(snapshot);
  const nodes: MapNode[] = [];
  const links: MapLink[] = [];
  const seen = new Set<string>();
  const holder = (wallet: string, rawPct: number, cluster: number | null, hub: boolean): MapNode => {
    const f = byWallet.get(wallet);
    const pct = Math.min(100, Math.max(0, rawPct));
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
      ...(tied.has(wallet) ? { creatorTied: true } : {}),
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
  // Flagged wallets the reading doesn't place stand in for holders only on a reading with no list
  // of its own (older scans). Their share is the one held at the call: on a reading with the list,
  // one off it isn't a top holder now, and a KOL that sold out was drawn at its call-time 2.86%
  // (user report 2026-10-20).
  const hasList = (snapshot.linkedHolders?.length ?? 0) > 0;
  for (const w of hasList ? [] : flagged) {
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
    creatorPct: snapshot.linkedCreatorPct ?? null,
    creatorCount: snapshot.linkedCreatorPct == null ? null : nodes.filter((n) => n.creatorTied).length,
    transferLinks: transferLinksOf(snapshot.holderTransfers ?? [], nodes),
    transferPct: snapshot.transferredSupplyPct ?? null,
    transferCount:
      snapshot.transferWalletCount != null && snapshot.transferHoldersChecked != null
        ? { linked: snapshot.transferWalletCount, of: snapshot.transferHoldersChecked }
        : null,
    sameTimeGroups,
    sameTimePct: snapshot.sameTimeFundedPct ?? null,
    sameTimeCount: sameTimeCount(snapshot),
    linkedPct: snapshot.linkedWalletPct ?? null,
    linkedCount: linkedCount(snapshot),
    scanLinked: new Set(snapshot.scanLinkedWallets ?? scanLinkedOf(snapshot)),
    holdersRead: snapshot.holdersRead ?? null,
    top10Pct: top10,
  };
}

/**
 * The holders tied to the creator (user ask 2026-10-17): each one the scan counted in
 * linkedCreatorPct (linkedHolders' creatorTied). A scan from before it marked them, with creator-tied
 * supply, falls back on the clusters that hold any: the whole cluster, as those scans tagged it.
 */
export function tiedHolders(
  s: Pick<Snapshot, "linkedHolders" | "linkedClusters"> & Partial<Pick<Snapshot, "linkedCreatorPct">>,
): Set<string> {
  const marked = (s.linkedHolders ?? []).filter((h) => h?.creatorTied).map((h) => h.wallet);
  if (marked.length > 0 || s.linkedCreatorPct === 0) return new Set(marked);
  return new Set(
    (s.linkedClusters ?? []).flatMap((c) => (c?.creatorLinked ? (c.wallets ?? []).map((w) => w.wallet) : [])),
  );
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
 * The transfers between holders on the map (TokenSnapshot.holderTransfers), each pair once per
 * direction, largest first. A pair with either wallet off the map is left out. Drawn only.
 */
export function transferLinksOf(
  transfers: readonly { from: string; to: string; pct: number; count: number; lastAtMs?: number }[],
  nodes: readonly MapNode[],
): TransferLink[] {
  const onMap = new Map(nodes.filter((n) => n.kind === "holder" && n.wallet).map((n) => [n.wallet!, n.id]));
  const out: TransferLink[] = [];
  for (const t of Array.isArray(transfers) ? transfers : []) {
    const from = t && typeof t.from === "string" ? onMap.get(t.from) : undefined;
    const to = t && typeof t.to === "string" ? onMap.get(t.to) : undefined;
    if (!from || !to || from === to || !(t.pct >= 0)) continue;
    out.push({
      from,
      to,
      pct: t.pct,
      count: typeof t.count === "number" ? t.count : 1,
      lastAtMs: typeof t.lastAtMs === "number" ? t.lastAtMs : null,
    });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/** Each holder's transfers on the map: what it sent to, and got from, other holders. */
export function transfersOfNode(
  graph: Pick<BubbleGraph, "transferLinks">,
  id: string,
): { sent: number; sentTo: number; got: number; gotFrom: number } {
  const out = graph.transferLinks.filter((l) => l.from === id);
  const into = graph.transferLinks.filter((l) => l.to === id);
  const sum = (ls: TransferLink[]) => Math.round(ls.reduce((t, l) => t + l.pct, 0) * 100) / 100;
  return { sent: sum(out), sentTo: out.length, got: sum(into), gotFrom: into.length };
}

/** A transfer arrow's width in map units: thicker for more supply moved. */
export function transferWidth(pct: number): number {
  return 1.3 + Math.min(2.6, Math.sqrt(Math.max(0, pct)) * 0.9);
}

/**
 * A transfer arrow's curve between two bubbles, trimmed to stop at their edges so the head
 * shows: a quadratic from (x1, y1) through (cx, cy) to (x2, y2), bent to the sender's right, so
 * a pair that sent both ways draws two arcs side by side. `angle`: the head's direction at the end.
 */
export function transferCurve(
  a: Pick<MapNode, "x" | "y" | "r">,
  b: Pick<MapNode, "x" | "y" | "r">,
  headGap = 2,
  /** How far the curve bows, as a share of the distance; negative bows to the sender's left. */
  bend = 0.2,
): TransferRoute {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cx = (a.x + b.x) / 2 - dy * bend;
  const cy = (a.y + b.y) / 2 + dx * bend;
  // Each end steps out of its bubble along the curve's tangent there.
  const out = (n: Pick<MapNode, "x" | "y" | "r">, gap: number) => {
    const tx = cx - n.x;
    const ty = cy - n.y;
    const len = Math.hypot(tx, ty) || 1;
    return { x: n.x + (tx / len) * (n.r + gap), y: n.y + (ty / len) * (n.r + gap) };
  };
  const p1 = out(a, 1.5);
  const p2 = out(b, headGap);
  return { x1: p1.x, y1: p1.y, cx, cy, x2: p2.x, y2: p2.y, angle: Math.atan2(p2.y - cy, p2.x - cx) };
}

/** A transfer arrow's drawn curve (transferCurve), as every lane on the map is drawn (linkLanes.ts). */
export type TransferRoute = LaneRoute;

/** Points along a quadratic route, its ends included. */
export const routePoints = lanePoints;

/**
 * Each transfer arrow's route, by "from>to": the arrows' lanes of linkRoutes, for a map drawing its
 * arrows alone.
 */
export function transferRoutes(
  graph: Pick<BubbleGraph, "nodes" | "transferLinks">,
  headGap = 1.2,
): Map<string, TransferRoute> {
  const { routes } = linkRoutes({ ...graph, links: [], sameTimeLinks: [] }, { transfers: true, headGap });
  const out = new Map<string, TransferRoute>();
  for (const l of graph.transferLinks) {
    const r = routes.get(linkKey("xfer", l.from, l.to));
    if (r) out.set(`${l.from}>${l.to}`, r);
  }
  return out;
}

/** The kinds of line drawn between two bubbles: a funding tie, a same-minute tie, a KOL's side tie, a transfer. */
export type LinkKind = "fund" | "same" | "side" | "xfer";

/** A drawn line's key in linkRoutes' answer. */
export function linkKey(kind: LinkKind, from: string, to: string): string {
  return `${kind}:${from}>${to}`;
}

/**
 * The same-minute ties the map draws (user ask 2026-10-17: each tie shown once, nothing drawn
 * twice): each group joined by its shortest ties, where holders one funder's cluster already joins
 * count as joined. A group inside one cluster draws none (its clock marks say it); one spanning
 * clusters draws only the ties that bridge them, each between the nearest holders across.
 */
export function sameTimeTies(graph: Pick<BubbleGraph, "nodes" | "sameTimeLinks">): SameTimeLink[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map<number, MapNode[]>();
  for (const l of graph.sameTimeLinks) {
    const list = groups.get(l.group) ?? [];
    for (const id of [l.to, l.from]) {
      const n = byId.get(id);
      if (n && !list.includes(n)) list.push(n);
    }
    groups.set(l.group, list);
  }
  const out: SameTimeLink[] = [];
  for (const [group, members] of groups) {
    // Kruskal over the group, its holders in one cluster starting out joined.
    const root = new Map<MapNode, MapNode>(members.map((n) => [n, n]));
    const find = (n: MapNode): MapNode => {
      let r = n;
      while (root.get(r) !== r) r = root.get(r)!;
      root.set(n, r);
      return r;
    };
    const join = (a: MapNode, b: MapNode) => root.set(find(a), find(b));
    for (const a of members)
      for (const b of members) if (a !== b && a.cluster !== null && a.cluster === b.cluster) join(a, b);
    const pairs: [MapNode, MapNode, number][] = [];
    for (let i = 0; i < members.length; i += 1)
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!;
        const b = members[j]!;
        pairs.push([a, b, Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r]);
      }
    pairs.sort((p, q) => p[2] - q[2]);
    for (const [a, b] of pairs) {
      if (find(a) === find(b)) continue;
      join(a, b);
      out.push({ from: a.id, to: b.id, group });
    }
  }
  return out;
}

/** Each kind's lane order across a bundle (a transfer from the pair's first end leads, one back trails). */
const LANE_ORDER: Record<LinkKind, number> = { xfer: 0, fund: 1, same: 2, side: 3 };
/** Each kind's line weight for spacing lanes, map units (styles.css .bm-link, .bm-side-link). */
const LANE_WIDTH: Record<Exclude<LinkKind, "xfer">, number> = { fund: 1.6, same: 1.6, side: 1.8 };

/**
 * Every line the map draws between two bubbles, routed together (user ask 2026-10-17: a pair tied
 * more than one way, say by a funder and a transfer, reads as one tidy bundle). The lines between
 * one pair become the lanes of one bundle, side by side (linkLanes.ts): a transfer from the pair's
 * first end on one edge, one back on the other, the funding, same-minute and side ties between.
 * Each bundle takes the bow, of a few, that passes under the fewest other bubbles and crosses the
 * fewest bundles already routed, its usual bow winning a tie: a lone funding tie keeps its slight
 * bow, a bundle a gentler one. Same-minute ties are sameTimeTies' (returned as `same`), side ties
 * the KOLs' (kolSideTies). Keyed by linkKey.
 */
export function linkRoutes(
  graph: Pick<BubbleGraph, "nodes" | "links" | "sameTimeLinks" | "transferLinks">,
  opts: {
    /** Route the transfer arrows (the map's transfers toggle). */
    transfers?: boolean;
    sideTies?: readonly { from: string; to: string }[];
    /** How far past the receiver's rim an arrow's tip stops. */
    headGap?: number;
  } = {},
): { routes: Map<string, LaneRoute>; same: SameTimeLink[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const same = sameTimeTies(graph);
  type Lane = { kind: LinkKind; from: string; to: string; width: number };
  const lanes: Lane[] = [
    ...graph.links.map((l) => ({ kind: "fund" as const, from: l.from, to: l.to, width: LANE_WIDTH.fund })),
    ...same.map((l) => ({ kind: "same" as const, from: l.from, to: l.to, width: LANE_WIDTH.same })),
    ...(opts.sideTies ?? []).map((l) => ({
      kind: "side" as const,
      from: l.from,
      to: l.to,
      width: LANE_WIDTH.side,
    })),
    // An arrow's lane holds part of its glow too.
    ...(opts.transfers ? graph.transferLinks : []).map((l) => ({
      kind: "xfer" as const,
      from: l.from,
      to: l.to,
      width: transferWidth(l.pct) * 1.7,
    })),
  ];
  // The bundles: each pair's lanes, by the pair's first end (the lower id) to its second.
  const bundles = new Map<string, { a: MapNode; b: MapNode; lanes: Lane[] }>();
  for (const l of lanes) {
    if (l.from === l.to) continue;
    const [p, q] = l.from <= l.to ? [l.from, l.to] : [l.to, l.from];
    const a = byId.get(p);
    const b = byId.get(q);
    if (!a || !b) continue;
    const key = `${p}|${q}`;
    const bundle = bundles.get(key) ?? { a, b, lanes: [] };
    // One lane per kind and way: a tie listed twice draws once.
    if (!bundle.lanes.some((o) => o.kind === l.kind && o.from === l.from && o.to === l.to))
      bundle.lanes.push(l);
    bundles.set(key, bundle);
  }
  const rank = (l: Lane, a: MapNode) => (l.kind === "xfer" && l.from !== a.id ? 9 : LANE_ORDER[l.kind]);
  // The badges on bubbles' rims (a trait's bottom right, a risk or DEV mark's top right), drawn over
  // the lines: a lane shouldn't run under one.
  const badges = graph.nodes.flatMap((n) => [
    ...(n.trait ? [{ x: n.x + n.r * 0.72, y: n.y + n.r * 0.72, r: 9 }] : []),
    ...(n.flags.length > 0 ? [{ x: n.x + n.r * 0.72, y: n.y - n.r * 0.72, r: 11 }] : []),
  ]);
  const headGap = opts.headGap ?? 1.2;
  // A plain line tucks just under its bubbles' edges; an arrow stops short of them, so its head shows.
  const routeOf = (bundle: { a: MapNode; b: MapNode }, l: Lane, bend: number, offset: number) => {
    const [tail, head] = l.kind === "xfer" ? [1.5, headGap] : [-1, -1];
    const forward = l.from === bundle.a.id;
    const r = laneRoute(bundle.a, bundle.b, bend, offset, forward ? tail : head, forward ? head : tail);
    return forward ? r : reverseLane(r);
  };
  // The busiest bundles, and those with arrows, pick their bows first; then the longest.
  const length = (p: { a: MapNode; b: MapNode }) => Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
  const hasArrow = (p: { lanes: Lane[] }) => Number(p.lanes.some((l) => l.kind === "xfer"));
  const order = [...bundles.values()].sort(
    (p, q) => q.lanes.length - p.lanes.length || hasArrow(q) - hasArrow(p) || length(q) - length(p),
  );
  const drawn: LanePoint[][] = [];
  const routes = new Map<string, LaneRoute>();
  for (const bundle of order) {
    const { a, b } = bundle;
    const sorted = [...bundle.lanes].sort((p, q) => rank(p, a) - rank(q, a));
    const offsets = laneOffsets(sorted.map((l) => l.width));
    // Its usual bow, the pair's first end to its second: a funding tie's slight one, an arrow's wider
    // one; a bundle of several, gentler, so its lanes run near straight side by side.
    const lead = sorted.find((l) => l.kind !== "xfer") ?? sorted[0]!;
    const usual =
      (lead.kind === "xfer" ? 0.2 : -0.12) * (sorted.length > 1 ? 0.6 : 1) * pairSign(lead.from, lead.to);
    const tries = [...new Set([usual, -usual, 0.2, -0.2, 0.32, -0.32, 0.06, -0.06])];
    let best: { bend: number; s: number } | null = null;
    for (const bend of tries) {
      const pts = sorted.map((l, i) => lanePoints(routeOf(bundle, l, bend, offsets[i]!), 4));
      let c = 0;
      for (const n of graph.nodes) {
        if (n === a || n === b) continue;
        const reach = n.r + 3;
        if (pts.some((ps) => ps.some((p) => (p.x - n.x) ** 2 + (p.y - n.y) ** 2 < reach * reach))) c += 5;
      }
      for (const k of badges)
        if (pts.some((ps) => ps.some((p) => (p.x - k.x) ** 2 + (p.y - k.y) ** 2 < k.r * k.r))) c += 1;
      c += crossingCount(lanePoints(routeOf(bundle, sorted[0]!, bend, 0), 8), drawn) * 0.5;
      const s = c + (bend === usual ? 0 : bend === -usual ? 0.1 : 0.2);
      if (!best || s < best.s) best = { bend, s };
    }
    sorted.forEach((l, i) => {
      let r = routeOf(bundle, l, best!.bend, offsets[i]!);
      if (l.kind === "xfer") r = clearOfBadges(r, badges);
      routes.set(linkKey(l.kind, l.from, l.to), r);
    });
    drawn.push(lanePoints(routeOf(bundle, sorted[0]!, best!.bend, 0), 8));
  }
  return { routes, same };
}

/** A lane run the other way: its ends swapped, its heading the new end's. */
function reverseLane(r: LaneRoute): LaneRoute {
  return {
    x1: r.x2,
    y1: r.y2,
    cx: r.cx,
    cy: r.cy,
    x2: r.x1,
    y2: r.y1,
    angle: Math.atan2(r.y1 - r.cy, r.x1 - r.cx),
  };
}

/** An arrow whose tail or tip lands under a badge, starting or ending just past it instead. */
function clearOfBadges(r: LaneRoute, badges: readonly { x: number; y: number; r: number }[]): LaneRoute {
  const pts = lanePoints(r, 1);
  const free = (p: LanePoint) => badges.every((k) => (p.x - k.x) ** 2 + (p.y - k.y) ** 2 >= k.r * k.r);
  const i = pts.findIndex(free);
  const j = pts.length - 1 - [...pts].reverse().findIndex(free);
  // Moved only by the short way round a badge, never along most of the arrow.
  if (i <= 0 && j >= pts.length - 1) return r;
  if (i < 0 || j - i < pts.length / 2) return r;
  const tip = pts[j]!;
  const before = pts[Math.max(i, j - 2)]!;
  return {
    ...r,
    x1: pts[i]!.x,
    y1: pts[i]!.y,
    x2: tip.x,
    y2: tip.y,
    angle: j < pts.length - 1 ? Math.atan2(tip.y - before.y, tip.x - before.x) : r.angle,
  };
}

/**
 * The KOLs' side ties the map draws (user ask 2026-10-15): each KOL that holds, to its possible side
 * wallets on the map, with `kol`, the KOL's index in `kols` (its colour).
 */
export function kolSideTies(
  graph: Pick<BubbleGraph, "nodes">,
  kols: readonly Pick<KolControl, "kolWallet" | "wallets">[],
  groups: readonly SideGroup[],
): { from: string; to: string; kol: number }[] {
  const byKol = new Map(groups.map((g) => [g.kolWallet, g]));
  const out: { from: string; to: string; kol: number }[] = [];
  kols.forEach((k, i) => {
    const { kol, members } = kolBundleNodes(graph, k);
    const g = byKol.get(k.kolWallet);
    if (!kol || !g || members.length < 2) return;
    for (const n of sideMembers(graph, g)) if (n !== kol) out.push({ from: kol.id, to: n.id, kol: i });
  });
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
  /** A wallet the reader labeled as User Tracked, not a KOL (Settings > Labeled wallets). */
  tracked?: boolean;
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
export type KolTie = "kol" | "known" | "funded" | "side" | "cluster" | "same-minute" | "transfer";

/**
 * A send that carries a KOL's bundle on to its receiver (core's bundleTransfers): at least this %
 * of supply (core's TRANSFER_LINK_MIN_PCT)...
 */
export const BUNDLE_TRANSFER_MIN_PCT = 0.05;
/** ...or this share of what the sender held, its holding now plus what it sent (TRANSFER_LINK_MIN_SHARE). */
export const BUNDLE_TRANSFER_MIN_SHARE = 0.1;

/** A KOL on the map and the supply it may control: its own wallet, its side wallets and theirs. */
export interface KolControl {
  kolWallet: string;
  kolName: string | null;
  /** A wallet the reader labeled as User Tracked: drawn as a KOL's bundle, named as tracked. */
  tracked?: boolean;
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
 * `transfers`: the map's holder-to-holder transfers, when shown: a holder the KOL or any wallet in
 * its bundle sent the coin to joins the bundle, and on from there (user decision 2026-10-16).
 * `kolClusters`: the clusters funding alone forms, for the step out by funder, so a wallet that
 * sent the coin into a bundle (often bait) isn't pulled in by the transfer (user decision
 * 2026-10-16); absent, the map's own clusters.
 * `isService`: an exchange or launchpad wallet, whose transfers link no one (as core's
 * linkingTransfers leaves them out).
 */
export function kolControl(
  graph: Pick<BubbleGraph, "nodes">,
  groups: readonly SideGroup[],
  kols: readonly { wallet: string; name: string | null; tracked?: boolean }[] = [],
  transfers: readonly Pick<TransferLink, "from" | "to" | "pct">[] = [],
  kolClusters?: readonly Pick<Cluster, "wallets">[],
  isService: (wallet: string) => boolean = () => false,
): KolControl[] {
  // Each holder's funder cluster for the step out: funding alone where given.
  const clusterOf = new Map<string, number>();
  if (kolClusters)
    kolClusters.forEach((c, i) => {
      for (const w of c?.wallets ?? []) if (!clusterOf.has(w.wallet)) clusterOf.set(w.wallet, i);
    });
  const clusterIn = (n: MapNode): number | null =>
    kolClusters ? (n.wallet ? (clusterOf.get(n.wallet) ?? null) : null) : n.cluster;
  const holders = new Map(
    graph.nodes.flatMap((n) => (n.kind === "holder" && n.wallet ? [[n.wallet, n] as const] : [])),
  );
  const byId = new Map([...holders.values()].map((n) => [n.id, n]));
  // Each holder's sends past dust, by wallet.
  const sentTo = new Map<string, string[]>();
  for (const t of transfers) {
    const from = byId.get(t.from)?.wallet;
    const to = byId.get(t.to)?.wallet;
    if (!from || !to || from === to || isService(from) || isService(to)) continue;
    const held = holders.get(from)!.pct + t.pct;
    if (t.pct < BUNDLE_TRANSFER_MIN_PCT && !(held > 0 && t.pct >= held * BUNDLE_TRANSFER_MIN_SHARE)) continue;
    sentTo.set(from, [...(sentTo.get(from) ?? []), to]);
  }
  const seeds = new Map<string, { kolName: string | null; tracked: boolean; ties: Map<string, KolTie> }>();
  for (const g of groups) {
    const ties = new Map<string, KolTie>();
    for (const w of g.wallets)
      if (w.wallet !== g.kolWallet) ties.set(w.wallet, w.known ? "known" : w.funded ? "funded" : "side");
    seeds.set(g.kolWallet, { kolName: g.kolName, tracked: !!g.tracked, ties });
  }
  for (const k of kols) {
    const seed = seeds.get(k.wallet);
    if (!seed) seeds.set(k.wallet, { kolName: k.name, tracked: !!k.tracked, ties: new Map() });
    // The reader's own label names the wallet over the roster's, and says which kind it is.
    else if (k.tracked !== undefined) seeds.set(k.wallet, { ...seed, kolName: k.name, tracked: k.tracked });
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
        const c = clusterIn(n);
        if (c !== null && clusterIn(o) === c) tie.set(o.wallet, "cluster");
        else if (n.sameTime !== null && o.sameTime === n.sameTime) tie.set(o.wallet, "same-minute");
      }
    }
    // Then every holder the bundle sent the coin to, and those they sent it to.
    const queue = [...tie.keys()];
    while (queue.length > 0) {
      for (const to of sentTo.get(queue.pop()!) ?? []) {
        if (tie.has(to)) continue;
        tie.set(to, "transfer");
        queue.push(to);
      }
    }
    const wallets = [...tie]
      .map(([wallet, t]) => ({ wallet, pct: holders.get(wallet)!.pct, tie: t }))
      .sort((a, b) => Number(b.tie === "kol") - Number(a.tie === "kol") || b.pct - a.pct);
    if (wallets.filter((w) => w.tie !== "kol").length === 0) continue;
    out.push({
      kolWallet,
      kolName: seed.kolName,
      ...(seed.tracked ? { tracked: true } : {}),
      holds: tie.has(kolWallet),
      wallets,
      pct: Math.round(wallets.reduce((t, w) => t + w.pct, 0) * 100) / 100,
    });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/**
 * KOL Bundled % as the map draws it: every KOL group's holders, each counted once (core's
 * kolBundledPct). A User Tracked wallet's bundle is no KOL's, so it isn't counted.
 */
export function kolBundledShare(kols: readonly KolControl[]): number {
  const pct = new Map(
    kols.filter((k) => !k.tracked).flatMap((k) => k.wallets.map((w) => [w.wallet, w.pct] as const)),
  );
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

/** Where each bubble stands on a laid-out map, by node id. */
export type MapPositions = ReadonlyMap<string, { x: number; y: number }>;

export function positionsOf(graph: Pick<BubbleGraph, "nodes">): MapPositions {
  return new Map(graph.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}

/**
 * How far into the layout's run a refresh starts (warmStart): the late, cool steps only, which
 * part what overlaps and keep lines clear without moving the groups.
 */
const WARM_START_AT = 0.7;
/** The share of a refreshed map's bubbles that must have stood on the last one to start from it. */
const WARM_START_MIN_KEPT = 0.6;

/**
 * Puts each bubble where it stood on the last drawing, and a new one beside a bubble of its own
 * group (else where the fresh layout put it), when most of the map was there before. Answers
 * whether it did: false leaves the fresh layout's start, for a map that changed too much.
 */
function warmStart(
  nodes: MapNode[],
  prev: MapPositions | null | undefined,
  groupOf: (n: MapNode) => number,
): boolean {
  if (!prev || prev.size === 0) return false;
  const kept = nodes.filter((n) => prev.has(n.id)).length;
  if (kept < nodes.length * WARM_START_MIN_KEPT) return false;
  const anchorOf = new Map<number, MapNode>();
  for (const n of nodes) {
    const p = prev.get(n.id);
    if (!p) continue;
    n.x = p.x;
    n.y = p.y;
    const g = groupOf(n);
    const a = anchorOf.get(g);
    if (!a || n.hub || (!a.hub && n.r > a.r)) anchorOf.set(g, n);
  }
  let added = 0;
  for (const n of nodes) {
    if (prev.has(n.id)) continue;
    const a = anchorOf.get(groupOf(n));
    if (!a) continue;
    const angle = 0.9 + added * 2.4;
    added += 1;
    n.x = a.x + Math.cos(angle) * (a.r + n.r + 16);
    n.y = a.y + Math.sin(angle) * (a.r + n.r + 16);
  }
  return true;
}

/**
 * The map laid out again with the ties that are switched on pulled together (each exchange's
 * holders; each KOL and its possible side wallets), on copies of the nodes: the original layout
 * stands untouched for when they're off. Each KOL's bundle (`kols`) is pulled together too, and
 * its pill kept by the KOL (user ask 2026-10-15: each KOL's bundle easy to pick out).
 */
export function regroupLayout(
  graph: BubbleGraph,
  opts: {
    cex?: boolean;
    sides?: readonly SideGroup[];
    kols?: readonly KolControl[];
    transfers?: boolean;
    /** The last regrouped drawing with the same ties on, to settle from (layoutGraph's prev). */
    prev?: MapPositions | null;
  },
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
    transferTies: opts.transfers ? graph.transferLinks : undefined,
    prev: opts.prev,
  });
}

/** Whether a map needs regroupLayout: a tie switched on, or a KOL bundling any holder. */
export function needsRegroup(opts: {
  cex?: boolean;
  sides?: readonly SideGroup[];
  kols?: readonly KolControl[];
  transfers?: boolean;
}): boolean {
  return !!opts.cex || !!opts.transfers || (opts.sides?.length ?? 0) > 0 || (opts.kols?.length ?? 0) > 0;
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
    /** Holders that sent the coin to each other, pulled gently together (the map's transfers toggle). */
    transferTies?: readonly { from: string; to: string }[];
    /**
     * Where the bubbles stood on the map's last drawing (positionsOf): a refresh starts from there
     * and only settles, so the map moves gently rather than laying out anew (user ask 2026-10-19).
     */
    prev?: MapPositions | null;
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
  // The transfer arrows bow (transferCurve), so bubbles are kept off the arc itself, each way drawn.
  const arcs = (opts.transferTies ?? []).flatMap((l) => {
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

  const settleFrom = warmStart(nodes, opts.prev, groupOf) ? Math.round(iterations * WARM_START_AT) : 0;
  for (let it = settleFrom; it < iterations; it += 1) {
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
      // Firmer between holders no cluster holds, so the group sits tight.
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
    // Transfers between holders, when drawn: a gentle pull, so a sender sits near who it sent to
    // without leaving its cluster.
    for (const l of opts.transferTies ?? []) {
      const a = index.get(l.from);
      const b = index.get(l.to);
      if (!a || !b || a === b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const want = a.r + b.r + 30;
      if (dist <= want) continue;
      const k = ((dist - want) / dist) * 0.035;
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k;
      b.y -= dy * k;
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
    // Transfer arrows: a bubble under an arrow's arc moves off it, with room for the arrow's glow
    // (user ask 2026-10-16: no arrow hidden under a bubble, none drawn across one).
    if (it >= iterations * 0.3) pushOffArcs(arcs, nodes, 0.3);
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
  // round the bubbles as they now stand. With arrows drawn, bubbles still under one are moved off
  // it in turn, so nothing a collision undoes is left.
  for (let i = 0; i < 30; i += 1) collide(nodes);
  if (arcs.length > 0) {
    for (let i = 0; i < 80; i += 1) {
      pushOffArcs(arcs, nodes, 0.5);
      collide(nodes);
    }
  }
  for (const r of rooms) aimRoom(r, nodes);
  for (let i = 0; i < 40; i += 1) stepRooms(rooms, nodes, fundingLines, true);
  // Then only out of the way, so no room is left a step inside a bubble's berth.
  for (let i = 0; i < 12; i += 1) stepRooms(rooms, nodes, fundingLines, true, false);
  graph.labelSpots = new Map(rooms.map((r) => [r.id, { x: r.x, y: r.y }]));
  return graph;
}

/** How far a transfer arrow's arc keeps off any other bubble's edge, map units: its glow is wide. */
const ARROW_CLEARANCE = 9;

/**
 * Moves each bubble lying under a transfer arrow's arc off it, the arrow's ends giving a little the
 * other way. `strength`: the share of the overlap made up each call.
 */
function pushOffArcs(
  arcs: readonly (readonly [MapNode, MapNode])[],
  nodes: readonly MapNode[],
  strength: number,
) {
  for (const [a, b] of arcs) {
    const pts = arcPoints(a, b);
    for (const n of nodes) {
      if (n === a || n === b) continue;
      let hit = { x: 0, y: 0, d: Infinity, t: 0 };
      pts.forEach((p, i) => {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < hit.d) hit = { x: p.x, y: p.y, d, t: i / (pts.length - 1) };
      });
      const want = n.r + ARROW_CLEARANCE;
      if (hit.d >= want) continue;
      let dx = n.x - hit.x;
      let dy = n.y - hit.y;
      let dist = hit.d;
      if (dist < 0.01) {
        dx = -(b.y - a.y);
        dy = b.x - a.x;
        dist = Math.hypot(dx, dy) || 1;
      }
      const push = ((want - dist) / dist) * strength;
      n.x += dx * push;
      n.y += dy * push;
      a.x -= dx * push * 0.15 * (1 - hit.t);
      a.y -= dy * push * 0.15 * (1 - hit.t);
      b.x -= dx * push * 0.15 * hit.t;
      b.y -= dy * push * 0.15 * hit.t;
    }
  }
}

/** Points along the arc a transfer arrow draws from a to b (transferCurve's plain bow), centre to centre. */
function arcPoints(a: Pick<MapNode, "x" | "y">, b: Pick<MapNode, "x" | "y">): { x: number; y: number }[] {
  const cx = (a.x + b.x) / 2 - (b.y - a.y) * 0.2;
  const cy = (a.y + b.y) / 2 + (b.x - a.x) * 0.2;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12;
    out.push({
      x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cx + t * t * b.x,
      y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cy + t * t * b.y,
    });
  }
  return out;
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
const ROOM_W = { funder: 82, cex: 70, side: 112 } as const;

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
  // A same-minute group has no pill (user ask 2026-10-16: a clock on its bubbles instead).
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
  /** The transfer arrows drawn (transferRoutes): a pill keeps well off them. */
  transfers?: ReadonlyMap<string, TransferRoute> | null,
  /** Every other line drawn between bubbles (linkRoutes), as drawn; absent, the funding links' plain bow. */
  lines?: Iterable<LaneRoute> | null,
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
  if (lines) for (const r of lines) points.push(...lanePoints(r, 3));
  else
    for (const l of graph.links) {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (a && b) sample(a.x, a.y, b.x, b.y, 0.12);
    }
  // The transfer arrows, each point costing several of a plain line's: a pill on one hides its head
  // or its flow (user ask 2026-10-16).
  const arrows: { x: number; y: number }[] = [];
  for (const r of transfers?.values() ?? []) arrows.push(...routePoints(r, 3));
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
    for (const p of arrows) if (p.x > x0 - 2 && p.x < x1 + 2 && p.y > y0 - 2 && p.y < y1 + 2) c += 5;
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

/**
 * One cluster's halo: its bubbles grown by HALO_PAD and its links as thick bands, filled as one. A
 * band follows its funding line's bow (cx, cy, its control point) when the line has a route.
 */
export interface ClusterHalo {
  cluster: number;
  circles: { x: number; y: number; r: number }[];
  bands: { x1: number; y1: number; x2: number; y2: number; cx?: number; cy?: number }[];
}

/** A halo band's SVG path: a quadratic along its line's bow, else straight. */
export function bandD(b: ClusterHalo["bands"][number]): string {
  return b.cx === undefined || b.cy === undefined
    ? `M${b.x1},${b.y1} L${b.x2},${b.y2}`
    : `M${b.x1},${b.y1} Q${b.cx},${b.cy} ${b.x2},${b.y2}`;
}

/**
 * A soft shape behind each cluster, hugging only its own bubbles and the lines between them, so
 * a cluster reads as one group at a glance without swallowing the holders next to it. Drawn as a
 * single flattened layer (so overlaps don't darken) by the dialog's SVG and the share image alike.
 */
export function clusterHalos(
  graph: BubbleGraph,
  /** The drawn lines (linkRoutes), so each band bows with its funding line. */
  routes?: ReadonlyMap<string, LaneRoute> | null,
): ClusterHalo[] {
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
      if (!a || !b) continue;
      const r = routes?.get(linkKey("fund", l.from, l.to));
      bands.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...(r ? { cx: r.cx, cy: r.cy } : {}) });
    }
    out.push({
      cluster: i,
      circles: members.map((n) => ({ x: n.x, y: n.y, r: n.r + HALO_PAD })),
      bands,
    });
  });
  return out;
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

/**
 * The reading to draw (`snapshots` newest first): the newest whose holder list came with its
 * funders read (clusters or none), else with a holder list, else any linked reading. A scan whose
 * funder lookups ran past the cycle keeps the holder list without the linked reading, so the newest
 * list alone would read "not checked yet" while an earlier scan of the coin had checked them. An
 * older scan's clusters never win over a newer checked list: the holders have moved on since.
 */
export function pickReading<S extends Pick<Snapshot, "linkedWalletPct" | "linkedClusters" | "linkedHolders">>(
  snapshots: readonly S[],
): S | null {
  return (
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
 * Chain re-enumeration while a bubble map is open and the holder stream is not covering the coin
 * (worker WATCHED_HOLDERS_REFRESH_SECONDS), and the longest the worker goes between writes of an
 * open coin's holder list, changed or not. A list that changed is written on the next cycle: the
 * holder stream moves the top holders' balances as they trade (user ask 2026-10-19). A streamed
 * watch re-enumerates on HOLDER_STREAMED_READ_MS.
 */
export const HOLDER_WRITE_MS = 60_000;
/**
 * Chain re-enumeration while a bubble map is open and the holder stream already follows the
 * holders (worker WATCHED_HOLDERS_STREAMED_REFRESH_SECONDS). Balances move on each trade; the
 * set of wallets is read again on this cadence, not every minute.
 */
export const HOLDER_STREAMED_READ_MS = 5 * 60_000;
/**
 * How often an open token view re-reads its bubble maps (the top 50). The read also tells the
 * worker the map is open (Token.holdersViewedAt), which has it keep the coin's top holders current
 * and write them at the chain-read cadence instead of every ten minutes (user ask 2026-10-19),
 * so "Now" and its stats keep updating.
 */
export const HOLDER_POLL_MS = 30_000;
/**
 * A wide map read this long before the scan it would stand in for is too old to draw over that
 * scan. Not the holders section's "no longer scanned" line: that follows the scan rows.
 */
export const HOLDER_STALE_MS = 12 * 60_000;
/**
 * No scan row for this long: the coin has left the scan. Matches the safety card's window
 * (TokenModal SCAN_GONE_MS). An old enumeration is not this — a quiet coin keeps its chain-read
 * time while scans are still landing.
 */
export const HOLDER_SCAN_GONE_MS = 15 * 60_000;

/**
 * When a reading's holder shares were current: the chain read or the last holder-stream update
 * stored with them (`holderBalancesAt`), else the earlier row the API carried the list from
 * (`holdersAt`), else its own scan. A scan row lands every few seconds, so its takenAt alone said
 * a list minutes old was just read, and it also sits after the shares were copied, so the trades
 * in between were neither in the shares nor applied on top.
 */
export function holderListAt(s: Pick<Snapshot, "takenAt" | "holdersAt" | "holderBalancesAt">): number {
  const balances = s.holderBalancesAt ? Date.parse(s.holderBalancesAt) : NaN;
  return Number.isFinite(balances) ? balances : Date.parse(s.holdersAt ?? s.takenAt);
}

/**
 * When the holder set was last taken, for the "Last updated" stamp and the next-read countdown.
 * The chain enumeration (`holderChainReadAt`), else the carried list's time, else the balance
 * time, else the scan. The balance time moves with every streamed trade and is what later trades
 * are counted from (holderListAt); using it here made a list read minutes ago look just written,
 * and the countdown to the next read kept starting over (user ask 2026-10-21, token
 * vofbjQG4x2uJBKSe1QLkk6tsjpNk1wwZUucGmp73mab).
 */
export function holderShownAt(
  s: Pick<Snapshot, "takenAt" | "holdersAt" | "holderBalancesAt" | "holderChainReadAt">,
): number {
  const chain = s.holderChainReadAt ? Date.parse(s.holderChainReadAt) : NaN;
  if (Number.isFinite(chain)) return chain;
  const carried = s.holdersAt ? Date.parse(s.holdersAt) : NaN;
  if (Number.isFinite(carried)) return carried;
  // Not holderBalancesAt. A balance tick moves shares; it is not a new read of who holds.
  return Date.parse(s.takenAt);
}

/**
 * How long until the next chain enumeration when the row has no holderNextReadAt. A balance newer
 * than the enumeration means the holder stream is covering the coin, so the chain read is every
 * five minutes. Otherwise an open map's chain read is every minute.
 */
export function holderChainEveryMs(s: Pick<Snapshot, "holderBalancesAt" | "holderChainReadAt">): number {
  const chain = s.holderChainReadAt ? Date.parse(s.holderChainReadAt) : NaN;
  const balances = s.holderBalancesAt ? Date.parse(s.holderBalancesAt) : NaN;
  if (Number.isFinite(chain) && Number.isFinite(balances) && balances > chain + 1_000)
    return HOLDER_STREAMED_READ_MS;
  return HOLDER_WRITE_MS;
}

/**
 * The bubble map badge's time: the top-50 enumeration when that map is what's drawn, else
 * holderShownAt. Not the newest live trade and not the later of the two clocks. A trade or a
 * streamed balance moves a share; it is not a new read of who the holders are.
 */
export function holderBadgeAt(
  reading: Pick<Snapshot, "takenAt" | "holdersAt" | "holderBalancesAt" | "holderChainReadAt">,
  wideReadAt?: string | null,
): number {
  const wide = wideReadAt ? Date.parse(wideReadAt) : NaN;
  return Number.isFinite(wide) ? wide : holderShownAt(reading);
}

/**
 * When the set of wallets on the list was last enumerated from the chain. A buyer from outside
 * the list is counted from here; wallets already on it move from holderListAt, which the holder
 * stream keeps later. Without a chain time, both are the share time, so a stream update isn't
 * counted twice.
 */
export function holderChainReadAt(
  s: Pick<Snapshot, "takenAt" | "holdersAt" | "holderBalancesAt" | "holderChainReadAt">,
): number {
  const chain = s.holderChainReadAt ? Date.parse(s.holderChainReadAt) : NaN;
  return Number.isFinite(chain) ? chain : holderListAt(s);
}

/**
 * The longest redraw interval (Customize) at which an open map still counts as "Live" while the
 * coin's trades stream: a map held for minutes between redraws is not.
 */
export const MAP_LIVE_REDRAW_MS = 15_000;

/**
 * How long past a holder list's next read it still counts as "Live": the read, its write and the
 * push to the page. Past it the list is late, and the status shows its age and the countdown.
 */
export const HOLDER_LIVE_GRACE_MS = 30_000;

/**
 * The bubble map badge's status, for the map on screen. The map is held for the reader's redraw
 * interval (Customize, 5 s to 12 h), so the holder list's own status (`fresh`, Top holders') would
 * say "4s ago · Next update in 0:56" over a map drawn from a reading an hour old. `drawnAt` is when
 * the holders drawn were read (holderBadgeAt of the held reading), and that age always shows. The
 * next update is the list's next read or the next redraw, whichever is later, and "Live" only
 * while the list is (`fresh.live`, until `liveUntil`) and the map redraws within
 * MAP_LIVE_REDRAW_MS; past that a live coin counts down to its next redraw instead.
 */
export function mapBadgeFreshness(
  fresh: { last: number; next: number | null; late?: boolean; live?: boolean; liveUntil?: number | null },
  drawnAt: number,
  redraw: { shownAt: number; everyMs: number },
): { last: number; next: number | null; late: boolean; live: boolean; liveUntil: number | null } {
  const nextRedraw = redraw.shownAt + redraw.everyMs;
  const liveUntil = fresh.liveUntil ?? null;
  if (fresh.live && redraw.everyMs <= MAP_LIVE_REDRAW_MS)
    return {
      last: drawnAt,
      next: fresh.next === null ? null : Math.max(fresh.next, nextRedraw),
      late: !!fresh.late,
      live: true,
      liveUntil,
    };
  if (fresh.next === null)
    return { last: drawnAt, next: fresh.live ? nextRedraw : null, late: false, live: false, liveUntil: null };
  return {
    last: drawnAt,
    next: Math.max(fresh.next, nextRedraw),
    late: !!fresh.late,
    live: false,
    liveUntil: null,
  };
}

/** The first of a view's reads, every `everyMs` from `nextRead`, at or after `at`. */
export function firstReadAfter(at: number, nextRead: number, everyMs: number): number {
  return nextRead >= at ? nextRead : nextRead + Math.ceil((at - nextRead) / everyMs) * everyMs;
}

/**
 * When the holder list shown was written (`last`), when the next one is due from the worker
 * (`due`), and when this view will show it (`next`): its first read of the coin's scans after that
 * (`nextRead`, every `everyMs`), or, past due, its next read (`late` once a read since found none). Null without reads of its own (a
 * lookup, which doesn't follow the scans). `due` is the chain-read schedule (holderNextReadAt, or
 * the streamed five minutes / the open-map minute). Both are null once scans have stopped
 * (HOLDER_SCAN_GONE_MS on takenAt): the coin is no longer being scanned.
 */
export function holderFreshness(
  reading: Pick<
    Snapshot,
    "takenAt" | "holdersAt" | "holderBalancesAt" | "holderChainReadAt" | "holderNextReadAt"
  >,
  now: number,
  reads?: { nextRead: number; everyMs: number } | null,
): { last: number; due: number | null; next: number | null; late: boolean } {
  const last = holderShownAt(reading);
  const scannedAt = Date.parse(reading.takenAt);
  // Scans stopped. An old enumeration on a coin that is still being scanned is not this: a quiet
  // coin bumps the schedule and leaves the enumeration where it was.
  if (!Number.isFinite(scannedAt) || now - scannedAt >= HOLDER_SCAN_GONE_MS)
    return { last, due: null, next: null, late: false };
  const scheduled = reading.holderNextReadAt ? Date.parse(reading.holderNextReadAt) : NaN;
  const due = Number.isFinite(scheduled) ? scheduled : last + holderChainEveryMs(reading);
  if (!reads) return { last, due, next: null, late: false };
  return {
    last,
    due,
    next: firstReadAfter(due, reads.nextRead, reads.everyMs),
    // The view's last read came after the list was due and didn't bring one.
    late: reads.nextRead - reads.everyMs >= due,
  };
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

/**
 * Whether a cluster's funder goes by its wallet on the map and the card (user ask 2026-10-15): only
 * when the wallet is known (a KOL, a KOL's Known Side, a Pump.fun or FOMO name, a Helius label: any
 * name in `names`), is itself a holder, or carries a label of its own anyway (flagged as the
 * creator, risky or a dumper). Any other funder goes by its cluster's number (clusterNumberText).
 */
export function funderNamed(graph: BubbleGraph, funder: string, names: WalletNames): boolean {
  if (names[funder]) return true;
  return graph.nodes.some((n) => n.wallet === funder && (n.kind === "holder" || n.flags.length > 0));
}

/** A cluster's name in a list when its funder isn't named (funderNamed): "Cluster 2"; else null. */
export function clusterNumberText(graph: BubbleGraph, i: number, names: WalletNames): string | null {
  const c = graph.clusters[i];
  return c && funderNamed(graph, c.funder, names) ? null : `Cluster ${i + 1}`;
}
