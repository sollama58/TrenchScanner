import { prisma, createLogger, type Env, type DexScreenerClient } from "@trenchscanner/core";

const logger = createLogger("live-price-job");

/**
 * Keeps the market cap fresh for tokens someone currently has open on a Live Feed page, far more
 * often than a full scan cycle does.
 *
 * The full scan (scanJob.ts) is expensive - RugCheck per mint, Helius wallet/authority lookups,
 * scoring, rug screening, match creation - which is why it runs on SCAN_INTERVAL_MINUTES. None of
 * that is needed to move a number on screen: the market cap comes from one batched DexScreener
 * call covering 30 tokens at a time. So this job does only that, and can afford to run every
 * minute.
 *
 * It deliberately writes to Token.liveMarketCapUsd/livePriceUsd/liveDataAt rather than creating
 * TokenSnapshot rows - see the comment on those fields for why. Nothing here feeds scoring,
 * matching or alerting; a token's history and everything derived from it still comes exclusively
 * from the scan cycle.
 *
 * Scope is "tokens someone is actually looking at", using the same lastViewedAt window the scan
 * job uses, so an idle deployment with nobody on the dashboard does no work at all.
 */
export async function runLivePriceJob(dexScreener: DexScreenerClient, env: Env): Promise<void> {
  const startedAt = Date.now();

  const viewCutoff = new Date(startedAt - env.ACTIVE_VIEW_WINDOW_MINUTES * 60_000);
  const viewed = await prisma.token.findMany({
    where: { lastViewedAt: { gt: viewCutoff } },
    orderBy: { lastViewedAt: "desc" },
    take: env.LIVE_PRICE_MAX_TRACKED,
    select: { id: true, mintAddress: true },
  });

  if (viewed.length === 0) {
    // Nobody has the dashboard open - the common case for most of the day, and the reason this
    // job being on a one-minute timer costs nothing when idle.
    return;
  }

  let live;
  try {
    live = await dexScreener.getTokensByAddresses(viewed.map((t) => t.mintAddress));
  } catch (err) {
    logger.warn("live price refresh failed", { viewed: viewed.length, error: String(err) });
    return;
  }

  const byMint = new Map(live.map((c) => [c.mintAddress, c]));
  const now = new Date();
  let updated = 0;

  await Promise.all(
    viewed.map(async (token) => {
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
        logger.warn("failed to persist live price", { mint: token.mintAddress, error: String(err) });
      }
    }),
  );

  logger.info("live price refresh complete", {
    durationMs: Date.now() - startedAt,
    viewed: viewed.length,
    updated,
    missingFromDexScreener: viewed.length - updated,
  });
}
