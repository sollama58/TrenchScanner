import type { Snapshot } from "./api";
import type { WideMap } from "./bubbleMap";

/**
 * Live holder shares between holder reads (user ask 2026-10-19): while the bubble map is open the
 * worker keeps its top holders' balances current from the holder stream and writes the list at
 * least once a minute, and until the next list arrives each trade the page's live trades feed
 * brings in moves its wallet's share by the tokens it bought or sold. No wallet is
 * looked up for it: a new wallet that buys into the top holders shows at once, unlinked, and gets
 * its funder, tags and cluster from the next read, which corrects any drift too (transfers aren't
 * trades, and a trade routed through an aggregator names the router).
 */

/** The fields of a live trade the shares use (liveTrades.ts LiveTokenTrade). */
export interface ShareTrade {
  wallet: string;
  side: "buy" | "sell";
  tokens: number;
  atMs: number;
}

/** A coin's live trades and its supply in whole tokens (null until the feed has sent it). */
export interface LiveTradeShares {
  trades: readonly ShareTrade[];
  supply: number | null;
  /**
   * Whether the feed follows the coin's trades now (its status "live"): only then do shares move
   * with each trade, and the holders say "Live" instead of their age and next update.
   */
  live?: boolean;
}

/** Each wallet's share of supply moved (in %) by the trades after `fromMs`; empty without a supply. */
export function liveShareDeltas(
  trades: readonly ShareTrade[],
  supply: number | null,
  fromMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!supply || !(supply > 0) || !Number.isFinite(fromMs)) return out;
  for (const t of trades) {
    if (!(t.atMs > fromMs) || !(t.tokens > 0)) continue;
    const pct = ((t.side === "buy" ? 1 : -1) * t.tokens * 100) / supply;
    out.set(t.wallet, (out.get(t.wallet) ?? 0) + pct);
  }
  return out;
}

/**
 * The top 50's deltas when its top 25 are the scan's list (worker linkedWallets wideMapReadings):
 * those wallets move from the list's time, which the holder stream keeps current between reads
 * (user ask 2026-10-19), and only the rest from the top 50's own read. One base for all would count
 * the trades the stream already put on the list a second time.
 */
export function wideShareDeltas(
  trades: readonly ShareTrade[],
  supply: number | null,
  listed: ReadonlySet<string>,
  listAtMs: number,
  wideAtMs: number,
): Map<string, number> {
  const fromList = liveShareDeltas(trades, supply, listAtMs);
  const out = new Map<string, number>();
  for (const [wallet, d] of liveShareDeltas(trades, supply, wideAtMs))
    if (!listed.has(wallet)) out.set(wallet, d);
  for (const [wallet, d] of fromList) if (listed.has(wallet)) out.set(wallet, d);
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const moved = (pct: number, d: number | undefined) => (d === undefined ? pct : Math.max(0, round2(pct + d)));

/** A list's wallets with their shares moved; the ones sold out of it gone. */
function movedWallets<W extends { wallet: string; pct: number }>(
  wallets: readonly W[],
  deltas: ReadonlyMap<string, number>,
): W[] {
  return wallets.flatMap((w) => {
    const pct = moved(w.pct, deltas.get(w.wallet));
    return pct > 0 ? [pct === w.pct ? w : { ...w, pct }] : [];
  });
}

/** Groups (clusters, same-minute groups) with their wallets moved and their totals summed again. */
function movedGroups<G extends { wallets: { wallet: string; pct: number }[]; pct: number }>(
  groups: readonly G[] | null | undefined,
  deltas: ReadonlyMap<string, number>,
): G[] | null | undefined {
  if (!groups) return groups;
  return groups.flatMap((g) => {
    if (!g.wallets.some((w) => deltas.has(w.wallet))) return [g];
    const wallets = movedWallets(g.wallets, deltas);
    if (wallets.length === 0) return [];
    return [{ ...g, wallets, pct: round2(wallets.reduce((s, w) => s + w.pct, 0)) }];
  });
}

/**
 * The holder list with its shares moved, largest first, and the wallets that bought in since the
 * read added where they would rank among it (reaching its smallest share), kept to its length.
 */
function movedHolders<H extends { wallet: string; pct: number }>(
  holders: readonly H[],
  deltas: ReadonlyMap<string, number>,
  make: (wallet: string, pct: number) => H,
): H[] {
  const list = movedWallets(holders, deltas);
  const listed = new Set(holders.map((h) => h.wallet));
  const floor = holders.length > 0 ? Math.min(...holders.map((h) => h.pct)) : 0;
  for (const [wallet, d] of deltas) {
    if (listed.has(wallet) || !(d > 0) || round2(d) < floor) continue;
    list.push(make(wallet, round2(d)));
  }
  return list.sort((a, b) => b.pct - a.pct).slice(0, Math.max(holders.length, 1));
}

/** The sum of the moves over `wallets`, each once. */
function movedBy(wallets: Iterable<string>, deltas: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const w of new Set(wallets)) sum += deltas.get(w) ?? 0;
  return sum;
}

const movedFigure = (v: number | null | undefined, d: number) =>
  v == null || d === 0 ? v : Math.max(0, round2(v + d));

/**
 * The scan's reading with the trades since it moved in: its holder list, clusters and same-minute
 * groups, and the Linked, same-minute, CEX-funded and creator-tied shares over the same wallets.
 * The counts stay the read's: a wallet's links come only from a read. Unchanged with no moves.
 */
export function withLiveShares<
  S extends Pick<
    Snapshot,
    | "linkedHolders"
    | "linkedClusters"
    | "sameTimeClusters"
    | "linkedWalletPct"
    | "sameTimeFundedPct"
    | "cexFundedPct"
    | "linkedCreatorPct"
  >,
>(s: S, deltas: ReadonlyMap<string, number>): S {
  if (deltas.size === 0) return s;
  const holders = s.linkedHolders ?? [];
  const clusterWallets = (s.linkedClusters ?? []).flatMap((c) => c.wallets.map((w) => w.wallet));
  const sameTimeWallets = (s.sameTimeClusters ?? []).flatMap((g) => g.wallets.map((w) => w.wallet));
  return {
    ...s,
    linkedHolders: s.linkedHolders
      ? movedHolders(holders, deltas, (wallet, pct) => ({ wallet, pct }))
      : s.linkedHolders,
    linkedClusters: movedGroups(s.linkedClusters, deltas),
    sameTimeClusters: movedGroups(s.sameTimeClusters, deltas),
    linkedWalletPct: movedFigure(s.linkedWalletPct, movedBy(clusterWallets, deltas)),
    sameTimeFundedPct: movedFigure(s.sameTimeFundedPct, movedBy(sameTimeWallets, deltas)),
    cexFundedPct: movedFigure(
      s.cexFundedPct,
      movedBy(
        holders.filter((h) => h.cexFunder).map((h) => h.wallet),
        deltas,
      ),
    ),
    linkedCreatorPct: movedFigure(
      s.linkedCreatorPct,
      movedBy(
        holders.filter((h) => h.creatorTied).map((h) => h.wallet),
        deltas,
      ),
    ),
  };
}

/** The coin's top-50 map with the trades since its read moved in, as withLiveShares. */
export function wideWithLiveShares(wide: WideMap, deltas: ReadonlyMap<string, number>): WideMap {
  if (deltas.size === 0) return wide;
  return {
    ...wide,
    holders: movedHolders(wide.holders, deltas, (wallet, pct) => ({ wallet, pct })),
    clusters: movedGroups(wide.clusters, deltas) ?? [],
    ...(wide.clustersExTransfers
      ? { clustersExTransfers: movedGroups(wide.clustersExTransfers, deltas) ?? [] }
      : {}),
    sameTimeClusters: movedGroups(wide.sameTimeClusters, deltas) ?? [],
  };
}
