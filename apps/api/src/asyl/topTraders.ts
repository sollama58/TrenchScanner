import { isWalletAddress, type SolanaTrackerClient, type TokenTrader } from "@trenchscanner/core";
import { SharedCacheMap } from "../sharedCache.js";
import { linkHolders, type GraphBuilder } from "./graph.js";

/**
 * A coin's most profitable wallets of all time (user ask 2026-10-27: "the top profitable wallets in
 * all history, say top 100"), from Solana Tracker's PnL v2 token traders: every wallet that traded
 * it, ranked by profit on it, realised plus what it still holds. Free to the reader. Any coin, not
 * only those TrenchScanner called, at no Helius cost: a page or two of Solana Tracker's free plan,
 * and each coin's answer is shared for TOP_TRADERS_TTL_MS so the plan's monthly calls stretch.
 */

export const TOP_TRADERS = 100;
/** Pages asked at most, in case Solana Tracker hands back fewer than asked per page. */
const TOP_TRADERS_PAGES = 3;
export const TOP_TRADERS_TTL_MS = 3 * 3_600_000;

export interface TopTraders {
  traders: TokenTrader[];
  /** Every wallet Solana Tracker counts as having traded it. */
  total: number | null;
}

const kept = new SharedCacheMap<TopTraders>(TOP_TRADERS_TTL_MS, 300);

/** The coin's top TOP_TRADERS wallets by profit on it, most first; shared for a few hours. */
export function loadTopTraders(
  client: Pick<SolanaTrackerClient, "tokenTraders">,
  mint: string,
): Promise<TopTraders> {
  return kept.for(mint).get(async () => {
    const traders: TokenTrader[] = [];
    let total: number | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < TOP_TRADERS_PAGES && traders.length < TOP_TRADERS; page++) {
      const r = await client.tokenTraders(mint, cursor, TOP_TRADERS);
      total ??= r.total;
      traders.push(...r.traders.filter((t) => isWalletAddress(t.wallet)));
      if (!r.nextCursor || r.traders.length === 0) break;
      cursor = r.nextCursor;
    }
    return { traders: traders.slice(0, TOP_TRADERS), total };
  });
}

export const usdShort = (n: number) => {
  const a = Math.abs(n);
  const v = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${v}`;
};

/**
 * The traders drawn: each a "traded" line to the coin labelled with its profit (in SOL at
 * `solUsd` for the map's sliders, when known), then the funding and transfers that tie them.
 */
export async function addTopTraders(
  g: GraphBuilder,
  mint: string,
  traders: readonly TokenTrader[],
  solUsd: number | null,
): Promise<void> {
  g.node(mint, "token");
  const sol = (usd: number | null) => (usd !== null && solUsd ? usd / solUsd : null);
  traders.forEach((t, i) => {
    g.node(t.wallet, "wallet");
    const net = sol(t.pnlUsd);
    g.edge({
      a: t.wallet,
      b: mint,
      kind: "traded",
      weight: Math.max(Math.abs(net ?? t.pnlUsd / 150), 0.01),
      label: [
        `#${i + 1} · ${t.pnlUsd >= 0 ? "made" : "lost"} ${usdShort(Math.abs(t.pnlUsd))} on it`,
        t.unrealizedUsd
          ? `${usdShort(t.unrealizedUsd)} still held`
          : t.balance > 0
            ? "still holds"
            : "sold out",
        `${t.buys} buy${t.buys === 1 ? "" : "s"}, ${t.sells} sell${t.sells === 1 ? "" : "s"}`,
      ].join(" · "),
      source: "chain",
      mint,
      at: t.firstTradeAt === null ? null : new Date(t.firstTradeAt).toISOString(),
      sol: sol(Math.max(t.investedUsd ?? 0, t.proceedsUsd ?? 0)),
      net,
    });
  });
  await linkHolders(
    g,
    mint,
    traders.map((t) => t.wallet),
  );
}

/** What the read found, in a line. */
export function topTradersNote(r: TopTraders): string {
  const n = r.traders.length;
  if (n === 0) return "Solana Tracker has no traders on record for this coin.";
  const made = r.traders.reduce((a, t) => a + t.pnlUsd, 0);
  const holding = r.traders.filter((t) => t.balance > 0).length;
  const steady = r.traders.filter((t) => (t.walletPnlUsd ?? 0) > 0 && (t.tokensTraded ?? 0) >= 20).length;
  return (
    `The ${n} most profitable wallets on it of all time${r.total ? `, of ${r.total.toLocaleString("en-US")} that traded it` : ""}: together ${made >= 0 ? "up" : "down"} ${usdShort(Math.abs(made))}, ${holding} still holding. ` +
    `${steady} of them are up overall across 20+ coins, so not a one-off. From Solana Tracker; bots and airdrops left out.`
  );
}
