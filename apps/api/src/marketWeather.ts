import { prisma, type Env } from "@trenchscanner/core";

/**
 * "Market weather": how often launches are doubling right now against the last week.
 *
 * The same population and the same definition as the models' mktBaseRate6hPct input
 * (apps/worker/src/jobs/marketContext.ts): hourly and event decision moments in the mcap band,
 * finalized in the window, that won (2x within 15 minutes). The models already see it; this puts it
 * in front of the person trading the alerts. Informational only - nothing reads it to gate the feed.
 */

/** The "right now" window. Six hours, like the model input: one hour is too few moments to read. */
export const WEATHER_RECENT_HOURS = 6;
/** The trailing baseline the recent rate is compared with. */
export const WEATHER_TRAILING_DAYS = 7;
/** Graded moments below which a window's rate is too noisy to call (the model input uses 20). */
export const WEATHER_MIN_RECENT = 20;
export const WEATHER_MIN_TRAILING = 200;
/** Recent rate at or above this multiple of the trailing rate reads "hot", at or below COLD "cold". */
export const WEATHER_HOT_RATIO = 1.25;
export const WEATHER_COLD_RATIO = 0.75;

export type WeatherCondition = "hot" | "normal" | "cold" | "unknown";

export interface MarketWeather {
  condition: WeatherCondition;
  recentHours: number;
  recentGraded: number;
  recentWins: number;
  recentRatePct: number | null;
  trailingDays: number;
  trailingGraded: number;
  trailingWins: number;
  trailingRatePct: number | null;
  /** recentRatePct / trailingRatePct, when both are readable. */
  ratio: number | null;
}

/** Pure: turns the two windows' counts into the reading. */
export function classifyMarketWeather(counts: {
  recentGraded: number;
  recentWins: number;
  trailingGraded: number;
  trailingWins: number;
}): MarketWeather {
  const { recentGraded, recentWins, trailingGraded, trailingWins } = counts;
  const recentRatePct = recentGraded >= WEATHER_MIN_RECENT ? (recentWins / recentGraded) * 100 : null;
  const trailingRatePct =
    trailingGraded >= WEATHER_MIN_TRAILING ? (trailingWins / trailingGraded) * 100 : null;
  let ratio: number | null = null;
  let condition: WeatherCondition = "unknown";
  if (recentRatePct !== null && trailingRatePct !== null) {
    if (trailingRatePct > 0) {
      ratio = recentRatePct / trailingRatePct;
      condition = ratio >= WEATHER_HOT_RATIO ? "hot" : ratio <= WEATHER_COLD_RATIO ? "cold" : "normal";
    } else {
      // Nothing doubled all week: any doubling now is hot, none is normal for this week.
      condition = recentRatePct > 0 ? "hot" : "normal";
    }
  }
  return {
    condition,
    recentHours: WEATHER_RECENT_HOURS,
    recentGraded,
    recentWins,
    recentRatePct,
    trailingDays: WEATHER_TRAILING_DAYS,
    trailingGraded,
    trailingWins,
    trailingRatePct,
    ratio,
  };
}

/**
 * Both windows in one pass over the finalizedAt index: about a week of decision moments (a few
 * tens of thousands of rows), cached by the caller alongside the other base-rate counts.
 */
export async function loadMarketWeather(env: Env, now = new Date()): Promise<MarketWeather> {
  const recentFrom = new Date(now.getTime() - WEATHER_RECENT_HOURS * 3_600_000);
  const trailingFrom = new Date(now.getTime() - WEATHER_TRAILING_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<
    { recent_graded: bigint; recent_wins: bigint; trailing_graded: bigint; trailing_wins: bigint }[]
  >`
    SELECT count(*) FILTER (WHERE "finalizedAt" >= ${recentFrom}) AS recent_graded,
           count(*) FILTER (WHERE "finalizedAt" >= ${recentFrom} AND "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS recent_wins,
           count(*) AS trailing_graded,
           count(*) FILTER (WHERE "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS trailing_wins
    FROM "CandidateOutcome"
    WHERE "finalizedAt" >= ${trailingFrom}
      AND "sampleKind" IN ('hourly', 'event')
      AND "anchorMcapUsd" BETWEEN ${env.MCAP_FILTER_MIN} AND ${env.MCAP_FILTER_MAX}`;
  const r = rows[0];
  return classifyMarketWeather({
    recentGraded: Number(r?.recent_graded ?? 0),
    recentWins: Number(r?.recent_wins ?? 0),
    trailingGraded: Number(r?.trailing_graded ?? 0),
    trailingWins: Number(r?.trailing_wins ?? 0),
  });
}
