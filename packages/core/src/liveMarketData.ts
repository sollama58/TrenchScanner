import { prisma } from "./db.js";
import { createLogger } from "./logger.js";
import type { DexScreenerClient } from "./datasources/dexscreener.js";

const logger = createLogger("live-market-data");

/** What one refresh pass managed to do. `requested - updated` is what DexScreener had no data for. */
export interface LiveMarketDataRefresh {
  requested: number;
  updated: number;
}

/**
 * Writes current market data onto Token.liveMarketCapUsd/livePriceUsd/liveDataAt for the given
 * tokens, in one batched DexScreener lookup.
 *
 * Deliberately not a TokenSnapshot: a snapshot is a full point-in-time evaluation that feeds
 * scoring, matching and history, and minting one every time a number moves on screen would both
 * bloat that table and attach stale on-chain data to fresh market data. See the comment on those
 * three fields in schema.prisma.
 *
 * Shared by the worker's periodic live-price job and the API's on-demand refresh, so "what a live
 * refresh writes" has exactly one definition. Throws if the DexScreener call itself fails - both
 * callers treat that as "no refresh this time" rather than an error worth surfacing, but that's
 * their decision to make, not this function's.
 */
export async function refreshLiveMarketData(
  dexScreener: DexScreenerClient,
  tokens: readonly { id: string; mintAddress: string }[],
): Promise<LiveMarketDataRefresh> {
  if (tokens.length === 0) return { requested: 0, updated: 0 };

  const live = await dexScreener.getTokensByAddresses(tokens.map((t) => t.mintAddress));
  const byMint = new Map(live.map((c) => [c.mintAddress, c]));
  // Not in the response (delisted, liquidity pulled, DexScreener hasn't indexed it) - leave
  // whatever was last recorded rather than blanking it, exactly as outcomeTrackingJob does.
  const rows = tokens
    .flatMap((t) => {
      const data = byMint.get(t.mintAddress);
      return data ? [{ id: t.id, mcap: data.marketCapUsd, price: data.priceUsd }] : [];
    })
    // A stable order, so two overlapping refreshes take their row locks in the same sequence.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (rows.length === 0) return { requested: tokens.length, updated: 0 };

  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  let updated = 0;
  try {
    // One statement for the whole batch. This used to be one UPDATE per token, all in flight at
    // once - up to 150 from the worker every minute and 12 per API page load, each its own pool
    // checkout, which on the API's 12-connection pool queued every other request behind them. A
    // token deleted mid-refresh simply matches no row.
    updated = await prisma.$executeRaw`
      UPDATE "Token" AS t
      SET "liveMarketCapUsd" = v.mcap, "livePriceUsd" = v.price, "liveDataAt" = now()
      FROM unnest(
        ${rows.map((r) => r.id)}::text[],
        ${rows.map((r) => finite(r.mcap))}::float8[],
        ${rows.map((r) => finite(r.price))}::float8[]
      ) AS v(id, mcap, price)
      WHERE t.id = v.id`;
  } catch (err) {
    logger.warn("failed to persist live market data", { count: rows.length, error: String(err) });
  }

  return { requested: tokens.length, updated };
}
