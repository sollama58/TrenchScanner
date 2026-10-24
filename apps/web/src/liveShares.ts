import type { Snapshot } from "./api";
import type { WideMap } from "./bubbleMap";

/**
 * Live holder shares between holder reads (user ask 2026-10-19): while the bubble map is open the
 * worker keeps its top holders' balances current from the holder stream and writes the list at
 * least once a minute, and until the next list arrives each trade the page's live trades feed
 * brings in moves the share of a wallet on the list by the tokens it bought or sold.
 *
 * Only wallets already on the list move (user ask 2026-10-24: never show wrong data). A wallet off
 * the list may already hold tokens the trade feed never saw, and a trade routed through an
 * aggregator names the router, so adding a buyer at the size of its trades showed wrong holders
 * and wrong shares. A new top holder shows with the next read. And only when the page holds every
 * trade since the list's time (LiveTrades.wholeFrom): with a gap the list is shown as read.
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
  /** From when `trades` holds every trade of the coin (LiveTrades.wholeFrom). */
  wholeFrom: number;
}

/** Whether `live` holds every trade after `fromMs`, so shares read then can be moved by them. */
export function coversFrom(
  live: LiveTradeShares | null | undefined,
  fromMs: number,
): live is LiveTradeShares {
  return !!live && !!live.supply && live.supply > 0 && Number.isFinite(fromMs) && live.wholeFrom <= fromMs;
}

/**
 * Each listed wallet's share of supply moved (in %) by the trades after `fromMs`, the time its
 * share was current (holderListAt, or the top 50's balance time). Empty when the feed doesn't hold
 * every trade since then, or has no supply. Wallets off the list don't move (see above).
 */
export function listedShareDeltas(
  live: LiveTradeShares | null | undefined,
  listed: ReadonlySet<string>,
  fromMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!coversFrom(live, fromMs)) return out;
  const supply = live.supply!;
  for (const t of live.trades) {
    if (!(t.atMs > fromMs) || !(t.tokens > 0) || !listed.has(t.wallet)) continue;
    const pct = ((t.side === "buy" ? 1 : -1) * t.tokens * 100) / supply;
    out.set(t.wallet, (out.get(t.wallet) ?? 0) + pct);
  }
  return out;
}

/** A displayed share of supply: nothing past the whole coin, nothing below zero. */
const clampShare = (n: number) => Math.min(100, Math.max(0, n));
const round2 = (v: number) => Math.round(clampShare(v) * 100) / 100;
const moved = (pct: number, d: number | undefined) => (d === undefined ? round2(pct) : round2(pct + d));

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

/** The holder list with its shares moved, largest first; the ones sold out of it gone. */
function movedHolders<H extends { wallet: string; pct: number }>(
  holders: readonly H[],
  deltas: ReadonlyMap<string, number>,
): H[] {
  return movedWallets(holders, deltas).sort((a, b) => b.pct - a.pct);
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
    linkedHolders: s.linkedHolders ? movedHolders(holders, deltas) : s.linkedHolders,
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
    holders: movedHolders(wide.holders, deltas),
    clusters: movedGroups(wide.clusters, deltas) ?? [],
    ...(wide.clustersExTransfers
      ? { clustersExTransfers: movedGroups(wide.clustersExTransfers, deltas) ?? [] }
      : {}),
    sameTimeClusters: movedGroups(wide.sameTimeClusters, deltas) ?? [],
  };
}
