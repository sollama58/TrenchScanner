import {
  prisma,
  createLogger,
  refreshLiveMarketData,
  type Env,
  type DexScreenerClient,
} from "@trenchscanner/core";

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
 * Scope is "tokens someone is actually looking at", using the same lastViewedAt window the scan
 * job uses, so an idle deployment with nobody on the dashboard does no work at all.
 *
 * This is the steady-state cadence. The moment a page is *opened* is handled separately, by the
 * API's on-demand refresh (apps/api/src/liveRefresh.ts) - otherwise paging back to an already-seen
 * page would show up-to-a-minute-old numbers until this job's next tick came round.
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

  let result;
  try {
    result = await refreshLiveMarketData(dexScreener, viewed);
  } catch (err) {
    logger.warn("live price refresh failed", { viewed: viewed.length, error: String(err) });
    return;
  }

  logger.info("live price refresh complete", {
    durationMs: Date.now() - startedAt,
    viewed: result.requested,
    updated: result.updated,
    missingFromDexScreener: result.requested - result.updated,
  });
}
