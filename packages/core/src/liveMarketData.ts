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
  const now = new Date();
  let updated = 0;

  await Promise.all(
    tokens.map(async (token) => {
      const data = byMint.get(token.mintAddress);
      // Not in the response (delisted, liquidity pulled, DexScreener hasn't indexed it) - leave
      // whatever was last recorded rather than blanking it, exactly as outcomeTrackingJob does.
      if (!data) return;
      try {
        await prisma.token.update({
          where: { id: token.id },
          data: {
            liveMarketCapUsd: data.marketCapUsd,
            livePriceUsd: data.priceUsd,
            liveDataAt: now,
          },
        });
        updated += 1;
      } catch (err) {
        // Almost always the token being deleted by the cleanup job mid-refresh. Not worth failing
        // the whole pass over.
        logger.warn("failed to persist live market data", { mint: token.mintAddress, error: String(err) });
      }
    }),
  );

  return { requested: tokens.length, updated };
}
