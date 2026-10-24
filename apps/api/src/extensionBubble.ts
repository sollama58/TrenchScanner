/**
 * The bubble map the browser extension's side panel draws for a coin (user ask 2026-10-24): the
 * coin's latest top holders, coloured by the cluster one funder paid for, and the category totals
 * the site's map shows above it (web components/BubbleMap.tsx MapView's tiles and wallet types).
 *
 * The same reading the site's token view draws: the scan pickReading picks (web bubbleMap.ts, and
 * readTokenReading here), with the coin's top 50 (BubbleMapHolders) for the picture while it is
 * current (web liveWideFor). Every total is the scan's own, as on the site: the top 50 is for the
 * picture only. Pure: the route reads the rows.
 */

/** A wide map read this long before the scan's own holder list is too old to draw over it (web HOLDER_STALE_MS). */
export const HOLDER_STALE_MS = 12 * 60_000;
/** Bubbles the panel draws at most: the site's top 50. */
export const MAX_BUBBLES = 50;
/** Holders the linked reading covered on scans that didn't keep the count (web linkedCount.ts). */
const LINKED_HOLDERS_READ = 20;

export type OverlayTrait = "blockZero" | "sniper" | "fresh" | "empty";
const TRAITS: readonly OverlayTrait[] = ["blockZero", "sniper", "fresh", "empty"];

export interface OverlayBubbleHolder {
  wallet: string;
  /** % of supply, 0-100. */
  pct: number;
  /** Index into `clusters`, or null for a holder in none. */
  cluster: number | null;
  /** Index into `sameTime`, or null for a holder in no same-minute group. */
  sameTime: number | null;
  /** Its wallet type as the scan read it (block zero first, then sniper, fresh, empty); null for none. */
  trait: OverlayTrait | null;
  /** An exchange (or a busy service) paid for it. */
  cex: boolean;
  /** Counted in the supply tied to the creator. */
  creatorTied: boolean;
}

export interface OverlayCount {
  count: number;
  of: number;
}

export interface OverlayBubbleTotals {
  /** Linked: % of supply in linked top holders, and how many of how many read. */
  linkedPct: number | null;
  linkedCount: OverlayCount | null;
  kolBundledPct: number | null;
  /** Bundled: linked or in a KOL's bundle, each holder once. */
  bundledPct: number | null;
  sameMinutePct: number | null;
  sameMinuteCount: OverlayCount | null;
  cexFundedPct: number | null;
  cexFundedCount: OverlayCount | null;
  /** Supply tied to the creator (the creator's own holding left out). */
  devTiedPct: number | null;
  /** Transferred Supply %: the coin moved holder to holder among the top holders. */
  transferredPct: number | null;
  transferredCount: OverlayCount | null;
  top10Pct: number | null;
  /** Each wallet type on the map with its holders' count and supply, in TRAITS order; only those present. */
  traits: { trait: OverlayTrait; count: number; pct: number }[];
}

export interface OverlayBubbleMap {
  mint: string;
  symbol: string | null;
  /** When the holder set shown was read (the chain read, else the scan); null with no reading. */
  readAt: string | null;
  /** The newest scan of the coin. */
  scanAt: string | null;
  /** The picture is the coin's top 50 (a model-alerted coin's wider map), not the scan's top 25. */
  top50: boolean;
  holders: OverlayBubbleHolder[];
  clusters: { funder: string; pct: number; count: number; creatorLinked: boolean }[];
  sameTime: { pct: number; count: number }[];
  totals: OverlayBubbleTotals;
}

type Json = unknown;

/** The scan fields read here (TokenSnapshot), as Prisma returns them. */
export interface BubbleScan {
  takenAt: Date;
  linkedHolders: Json;
  linkedClusters: Json;
  sameTimeClusters: Json;
  holderChainReadAt?: Date | null;
  holdersAt?: Date | string | null;
  linkedWalletPct: number | null;
  linkedWalletCount: number | null;
  linkedWalletsChecked: number | null;
  kolBundledPct: number | null;
  bundledSupplyPct: number | null;
  sameTimeFundedPct: number | null;
  sameTimeFundedCount: number | null;
  cexFundedPct: number | null;
  cexFundedCount: number | null;
  cexFundedHolders: number | null;
  linkedCreatorPct: number | null;
  transferredSupplyPct: number | null;
  transferWalletCount: number | null;
  transferHoldersChecked: number | null;
  top10HolderPct: number | null;
}

/** The coin's top 50 (BubbleMapHolders), as stored. */
export interface BubbleWideRow {
  readAt: Date;
  holders: Json;
  clusters: Json;
  sameTimeClusters: Json;
}

interface ListedHolder {
  wallet: string;
  pct: number;
  cexFunder?: string;
  sniper?: boolean;
  blockZero?: boolean;
  fresh?: boolean;
  empty?: boolean;
  creatorTied?: boolean;
}
interface ListedCluster {
  funder: string;
  wallets: { wallet: string; pct: number }[];
  pct: number;
  creatorLinked?: boolean;
}
interface ListedGroup {
  wallets: { wallet: string; pct: number }[];
  pct: number;
}

function arrayOf<T>(value: Json, ok: (v: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is T => typeof v === "object" && v !== null && ok(v as Record<string, unknown>));
}

const holdersOf = (v: Json) =>
  arrayOf<ListedHolder>(v, (h) => typeof h.wallet === "string" && typeof h.pct === "number");
const clustersOf = (v: Json) =>
  arrayOf<ListedCluster>(
    v,
    (c) => typeof c.funder === "string" && Array.isArray(c.wallets) && c.wallets.length > 0,
  );
const groupsOf = (v: Json) =>
  arrayOf<ListedGroup>(v, (g) => Array.isArray(g.wallets) && g.wallets.length > 0);

const hasList = (s: BubbleScan) =>
  holdersOf(s.linkedHolders).length > 0 || clustersOf(s.linkedClusters).length > 0;

/**
 * The reading to draw (`scans` newest first, web bubbleMap.ts pickReading): the newest whose
 * holder list came with its funders read, else with a list, else any linked reading.
 */
export function pickBubbleScan<S extends BubbleScan>(scans: readonly S[]): S | null {
  return (
    scans.find((s) => s.linkedWalletPct != null && hasList(s)) ??
    scans.find(hasList) ??
    scans.find((s) => s.linkedWalletPct != null) ??
    null
  );
}

/** When the scan's holder set was read: its chain read, else the row it was carried from, else the scan. */
function shownAt(s: BubbleScan): number {
  if (s.holderChainReadAt) return s.holderChainReadAt.getTime();
  if (s.holdersAt) return new Date(s.holdersAt).getTime();
  return s.takenAt.getTime();
}

function traitOf(h: ListedHolder | undefined): OverlayTrait | null {
  if (!h) return null;
  return h.blockZero ? "blockZero" : h.sniper ? "sniper" : h.fresh ? "fresh" : h.empty ? "empty" : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function countOf(count: number | null, of: number | null): OverlayCount | null {
  return count === null || of === null || of <= 0 ? null : { count, of };
}

/** Holders the linked reading covered: as kept, else the list's length, else RugCheck's 20 (web linkedCount). */
function readOf(scan: BubbleScan, list: readonly ListedHolder[]): number {
  return scan.linkedWalletsChecked ?? (list.length || LINKED_HOLDERS_READ);
}

/** The panel's map for a coin, from its picked scan, its newest scan and its top 50 (any may be missing). */
export function overlayBubbleMap(
  mint: string,
  symbol: string | null,
  scan: BubbleScan | null,
  newest: { takenAt: Date } | null,
  wide: BubbleWideRow | null,
): OverlayBubbleMap {
  const scanHolders = scan ? holdersOf(scan.linkedHolders) : [];
  // The top 50 stands in for the picture while it is no older than the scan's list (web liveWideFor).
  const wideHolders = wide ? holdersOf(wide.holders) : [];
  const useWide =
    wideHolders.length > 0 &&
    (!scan || !hasList(scan) || shownAt(scan) - wide!.readAt.getTime() <= HOLDER_STALE_MS);
  const byWallet = new Map(scanHolders.map((h) => [h.wallet, h]));
  const listed = (useWide ? wideHolders : scanHolders)
    .slice()
    .sort((a, b) => b.pct - a.pct)
    .slice(0, MAX_BUBBLES);
  const clusters = clustersOf(useWide ? wide!.clusters : (scan?.linkedClusters ?? null));
  const groups = groupsOf(useWide ? wide!.sameTimeClusters : (scan?.sameTimeClusters ?? null));

  const clusterOf = new Map<string, number>();
  clusters.forEach((c, i) => {
    for (const w of c.wallets) if (!clusterOf.has(w.wallet)) clusterOf.set(w.wallet, i);
  });
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => {
    for (const w of g.wallets) if (!groupOf.has(w.wallet)) groupOf.set(w.wallet, i);
  });
  // A cluster's wallets the list left off (an older scan without one) still get their bubbles.
  const seen = new Set(listed.map((h) => h.wallet));
  const extra: ListedHolder[] = clusters.flatMap((c) =>
    c.wallets.filter((w) => !seen.has(w.wallet) && (seen.add(w.wallet), true)),
  );

  const holders: OverlayBubbleHolder[] = [...listed, ...extra].slice(0, MAX_BUBBLES).map((h) => {
    const read = byWallet.get(h.wallet) ?? h;
    return {
      wallet: h.wallet,
      pct: round2(h.pct),
      cluster: clusterOf.get(h.wallet) ?? null,
      sameTime: groupOf.get(h.wallet) ?? null,
      trait: traitOf(read),
      cex: typeof (h.cexFunder ?? read.cexFunder) === "string",
      creatorTied: read.creatorTied === true,
    };
  });

  const traits = TRAITS.flatMap((trait) => {
    const of = holders.filter((h) => h.trait === trait);
    return of.length === 0
      ? []
      : [{ trait, count: of.length, pct: round2(of.reduce((t, h) => t + h.pct, 0)) }];
  });

  return {
    mint,
    symbol,
    readAt: useWide ? wide!.readAt.toISOString() : scan ? new Date(shownAt(scan)).toISOString() : null,
    scanAt: newest ? newest.takenAt.toISOString() : null,
    top50: useWide,
    holders,
    clusters: clusters.map((c) => ({
      funder: c.funder,
      pct: round2(c.pct),
      count: c.wallets.length,
      creatorLinked: c.creatorLinked === true,
    })),
    sameTime: groups.map((g) => ({ pct: round2(g.pct), count: g.wallets.length })),
    totals: {
      linkedPct: scan?.linkedWalletPct ?? null,
      linkedCount:
        scan?.linkedWalletPct != null ? countOf(scan.linkedWalletCount, readOf(scan, scanHolders)) : null,
      kolBundledPct: scan?.kolBundledPct ?? null,
      bundledPct: scan?.bundledSupplyPct ?? null,
      sameMinutePct: scan?.sameTimeFundedPct ?? null,
      sameMinuteCount:
        scan?.sameTimeFundedPct != null ? countOf(scan.sameTimeFundedCount, readOf(scan, scanHolders)) : null,
      cexFundedPct: scan?.cexFundedPct ?? null,
      cexFundedCount: scan ? countOf(scan.cexFundedCount, scan.cexFundedHolders) : null,
      devTiedPct: scan?.linkedCreatorPct ?? null,
      transferredPct: scan?.transferredSupplyPct ?? null,
      transferredCount: scan ? countOf(scan.transferWalletCount, scan.transferHoldersChecked) : null,
      top10Pct: scan?.top10HolderPct ?? null,
      traits,
    },
  };
}
