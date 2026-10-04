import {
  prisma,
  createLogger,
  clockContext,
  type Env,
  type MarketContextFeatures,
} from "@trenchscanner/core";

const logger = createLogger("market-context");

/** How long one cycle's market reading is reused: the rates move over hours, not seconds. */
const CONTEXT_TTL_MS = 60_000;

let cached: { at: number; context: Omit<MarketContextFeatures, "mktInBandCount"> } | null = null;

/** Test hook. */
export function resetMarketContextCache(): void {
  cached = null;
}

/**
 * What the market is doing right now, as model inputs (see MarketContextFeatures): how often
 * decision moments finalized in the last hour and six hours doubled, how many launches the last
 * hour brought, how crowded the band is this cycle, and the clock. One cheap aggregate per
 * minute; the same reading goes on every candidate sampled in that minute.
 */
export async function loadMarketContext(
  env: Env,
  inBandCount: number,
  now = new Date(),
): Promise<MarketContextFeatures> {
  const clock = clockContext(now);
  if (!cached || now.getTime() - cached.at > CONTEXT_TTL_MS) {
    try {
      const sixHoursAgo = new Date(now.getTime() - 6 * 3_600_000);
      const hourAgo = new Date(now.getTime() - 3_600_000);
      const [rates, launches] = await Promise.all([
        prisma.$queryRaw<{ graded1h: bigint; won1h: bigint; graded6h: bigint; won6h: bigint }[]>`
          SELECT count(*) FILTER (WHERE "finalizedAt" >= ${hourAgo}) AS graded1h,
                 count(*) FILTER (WHERE "finalizedAt" >= ${hourAgo} AND "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS won1h,
                 count(*) AS graded6h,
                 count(*) FILTER (WHERE "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS won6h
          FROM "CandidateOutcome"
          WHERE "finalizedAt" >= ${sixHoursAgo}
            AND "sampleKind" IN ('hourly', 'event')
            AND "anchorMcapUsd" BETWEEN ${env.MCAP_FILTER_MIN} AND ${env.MCAP_FILTER_MAX}`,
        prisma.token.count({ where: { firstSeenAt: { gte: hourAgo } } }),
      ]);
      const r = rates[0];
      const rate = (won: bigint | undefined, graded: bigint | undefined): number | null =>
        graded !== undefined && Number(graded) >= 20 ? (Number(won ?? 0) / Number(graded)) * 100 : null;
      cached = {
        at: now.getTime(),
        context: {
          mktBaseRate1hPct: rate(r?.won1h, r?.graded1h),
          mktBaseRate6hPct: rate(r?.won6h, r?.graded6h),
          mktLaunchesPerHour: launches,
          ...clock,
        },
      };
    } catch (err) {
      logger.warn("market context unavailable this cycle", { error: String(err) });
      cached = {
        at: now.getTime(),
        context: { mktBaseRate1hPct: null, mktBaseRate6hPct: null, mktLaunchesPerHour: null, ...clock },
      };
    }
  }
  return { ...cached.context, ...clock, mktInBandCount: inBandCount };
}
