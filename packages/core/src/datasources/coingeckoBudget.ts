import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { RateGateDeadlineError } from "./rateGate.js";

const logger = createLogger("coingecko-budget");

/**
 * The paid CoinGecko plan's credits, a day at a time, across every process that holds the key (the
 * API, the scanner and the trainer). The Basic plan has 100,000 a month - about 3,300 a day - and
 * one call is one credit. On 2026-10-23 the plan ran out before the month did: nothing capped what
 * a job could spend once Pump.fun refused us and its reads moved onto CoinGecko, and Peaks alone
 * could ask ~75 calls a minute. Once the credits are gone every CoinGecko call answers 429 until
 * the month turns, the market-data fallback included.
 *
 * So the day's credits are shared out in lanes, by the feature a call is counted under (apiUsage.ts):
 *
 *  - "market": token lookups (the DexScreener fallback, the live-launch backup). What the band,
 *    the safety screen and the alerts wait on. Only the day's whole cap stops it.
 *  - "charts": the chart's candle backfill (candleBackfill.ts).
 *  - "peaks": Peaks and the label/quote re-grades when Pump.fun won't answer (minuteCandleReader.ts).
 *
 * The two background lanes have a cap each, and both stop once the day's spend reaches
 * BACKGROUND_SHARE of the cap, so what is left of the day is the market's.
 *
 * What every process spent today is read from ApiUsage (each process adds its counts there every
 * minute), so a restart doesn't hand a lane its day again and one process's spend counts against
 * another's. Calls made since the last read are counted here on top. Only answered calls are
 * credits in ApiUsage, so a 429 storm doesn't eat the budget.
 */

export type CoinGeckoLane = "market" | "charts" | "peaks";

const LANES: readonly CoinGeckoLane[] = ["market", "charts", "peaks"];

/** The day's spend past which the background lanes stop, as a share of the day's cap. */
export const COINGECKO_BACKGROUND_SHARE = 0.85;

/** The scheduler's job names (withApiFeature) of the reads in each background lane. */
const PEAK_FEATURES = ["candle-peaks", "label-regrade"];
/** The candle backfill's own feature name (withOwnApiFeature in candleBackfill.ts). */
export const CANDLE_BACKFILL_FEATURE = "candle-backfill";

/** The lane a call counted under `feature` spends from. */
export function coinGeckoLaneOf(feature: string): CoinGeckoLane {
  const root = feature.split("/")[0]!;
  if (PEAK_FEATURES.includes(root)) return "peaks";
  if (root === CANDLE_BACKFILL_FEATURE) return "charts";
  return "market";
}

/** Thrown in place of a CoinGecko call the day's budget has no room for. A deadline to its callers. */
export class CoinGeckoBudgetSpentError extends RateGateDeadlineError {
  constructor(readonly lane: CoinGeckoLane) {
    super();
    this.name = "CoinGeckoBudgetSpentError";
    this.message = `CoinGecko's daily budget for ${lane} is spent`;
  }
}

export interface CoinGeckoBudgetConfig {
  /** Credits a UTC day across every lane (COINGECKO_DAILY_CREDITS). */
  dailyCredits: number;
  /** Credits a day for Peaks and the re-grades (COINGECKO_PEAK_DAILY_CREDITS). */
  peakDailyCredits: number;
  /** Credits a day for the chart's candle backfill (COINGECKO_CHART_DAILY_CREDITS). */
  chartDailyCredits: number;
}

type ByLane = Record<CoinGeckoLane, number>;
const zero = (): ByLane => ({ market: 0, charts: 0, peaks: 0 });

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

export class CoinGeckoBudget {
  private config: CoinGeckoBudgetConfig | null = null;
  private day = 0;
  /** What ApiUsage said every process had spent today, at the last sync. */
  private synced: ByLane = zero();
  /** What this process has spent since that read. */
  private local: ByLane = zero();
  private logged = new Set<string>();

  /** Turns the budget on (a process with COINGECKO_API_KEY); unconfigured, every call is allowed. */
  configure(config: CoinGeckoBudgetConfig | null): void {
    this.config = config;
  }

  get configured(): boolean {
    return this.config !== null;
  }

  private roll(now: number): void {
    const day = dayOf(now);
    if (day === this.day) return;
    this.day = day;
    this.synced = zero();
    this.local = zero();
    this.logged.clear();
  }

  /** Today's credits by lane, every process's as last read plus this process's since. */
  spent(now = Date.now()): ByLane & { total: number } {
    this.roll(now);
    const out = zero();
    for (const lane of LANES) out[lane] = this.synced[lane] + this.local[lane];
    return { ...out, total: out.market + out.charts + out.peaks };
  }

  /** Whether `lane` may make one more call today. */
  allows(lane: CoinGeckoLane, now = Date.now()): boolean {
    const config = this.config;
    if (!config) return true;
    const spent = this.spent(now);
    let why: string | null = null;
    if (spent.total >= config.dailyCredits) why = "day";
    else if (lane !== "market") {
      if (spent.total >= config.dailyCredits * COINGECKO_BACKGROUND_SHARE) why = "background share";
      else if (lane === "peaks" && spent.peaks >= config.peakDailyCredits) why = "lane";
      else if (lane === "charts" && spent.charts >= config.chartDailyCredits) why = "lane";
    }
    if (why === null) return true;
    const key = `${lane}:${why}`;
    if (!this.logged.has(key)) {
      this.logged.add(key);
      logger.warn("CoinGecko daily budget reached; holding calls until the UTC day turns", {
        lane,
        why,
        spent,
        config,
      });
    }
    return false;
  }

  /** Throws CoinGeckoBudgetSpentError when `lane` has no room, else counts one call against it. */
  take(lane: CoinGeckoLane, now = Date.now()): void {
    if (!this.config) return;
    if (!this.allows(lane, now)) throw new CoinGeckoBudgetSpentError(lane);
    this.local[lane] += 1;
  }

  /** Takes what ApiUsage says every process spent today in place of the last read. */
  setSynced(byFeature: readonly { feature: string; credits: number }[], now = Date.now()): void {
    this.roll(now);
    const out = zero();
    for (const row of byFeature) out[coinGeckoLaneOf(row.feature)] += row.credits;
    this.synced = out;
    this.local = zero();
  }

  /**
   * Re-reads today's spend from ApiUsage. Called right after this process's own flush
   * (installApiUsageMeter), so its calls since are the only ones not in the read.
   */
  async sync(now = Date.now()): Promise<void> {
    if (!this.config) return;
    const rows = await prisma.$queryRaw<{ feature: string; credits: bigint | number | null }[]>(Prisma.sql`
      SELECT "feature", SUM("credits") AS credits FROM "ApiUsage"
      WHERE "bucket" >= ${new Date(dayOf(now))} AND "provider" = 'coingecko'
      GROUP BY "feature"`);
    this.setSynced(
      rows.map((r) => ({ feature: r.feature, credits: Number(r.credits ?? 0) })),
      now,
    );
  }

  /** Tests. */
  reset(): void {
    this.config = null;
    this.day = 0;
    this.synced = zero();
    this.local = zero();
    this.logged.clear();
  }
}

/** The one budget of this process, shared by its CoinGecko clients. */
export const coinGeckoBudget = new CoinGeckoBudget();

/** Turns this process's budget on from its environment; off without COINGECKO_API_KEY. */
export function configureCoinGeckoBudget(env: {
  COINGECKO_API_KEY: string;
  COINGECKO_DAILY_CREDITS: number;
  COINGECKO_PEAK_DAILY_CREDITS: number;
  COINGECKO_CHART_DAILY_CREDITS: number;
}): void {
  coinGeckoBudget.configure(
    env.COINGECKO_API_KEY
      ? {
          dailyCredits: env.COINGECKO_DAILY_CREDITS,
          peakDailyCredits: env.COINGECKO_PEAK_DAILY_CREDITS,
          chartDailyCredits: env.COINGECKO_CHART_DAILY_CREDITS,
        }
      : null,
  );
  // The first read now, so a process that just started doesn't spend a day it already spent.
  void coinGeckoBudget
    .sync()
    .catch((err: unknown) => logger.warn("CoinGecko spend not read", { error: String(err) }));
}
