/**
 * The price path a token has already traced, as features. Every scan cycle sees each candidate's
 * price and holder count; the model has so far only seen DexScreener's fixed-window changes
 * (5m, 1h, 6h, 24h), which say nothing about the shape of the last half hour - whether the move
 * is a steady climb, a spike that is already fading, or a bounce off the hour's low. This book
 * keeps a short in-memory tape per mint (same pattern as curation/tradeFlow.ts: pure, bounded,
 * nothing persisted) and answers with trailing returns, drawdowns from recent highs, how green
 * the last minutes were, and the holder slope. Null until there is enough tape to measure.
 *
 * Market context rides alongside: what the whole market is doing right now (how often tokens
 * have been doubling lately, how many launches an hour, how crowded the band is) and the time of
 * day, so a model can learn that the same chart means different things at 3am on a dead Sunday
 * and in a hot Tuesday afternoon.
 */

export interface PricePathFeatures {
  /** Price change over the last 1/5/15/30 minutes, in percent. */
  pathRet1mPct: number | null;
  pathRet5mPct: number | null;
  pathRet15mPct: number | null;
  pathRet30mPct: number | null;
  /** Current price against the highest observed in the last 15 / 60 minutes, in percent (<= 0). */
  pathDrawdown15mPct: number | null;
  pathDrawdown60mPct: number | null;
  /** Share of the last 10 minutes' observed moves that were up, in [0, 1]. */
  pathGreenShare10m: number | null;
  /** Minutes since the hour's high was set. */
  pathMinutesSinceHigh60m: number | null;
  /** Holder count change per minute over the last 10 minutes. */
  pathHolderSlope10m: number | null;
  /** How many minutes of tape the book holds for the mint - how much the rest can be trusted. */
  pathObservedMinutes: number | null;
}

export const EMPTY_PRICE_PATH: PricePathFeatures = {
  pathRet1mPct: null,
  pathRet5mPct: null,
  pathRet15mPct: null,
  pathRet30mPct: null,
  pathDrawdown15mPct: null,
  pathDrawdown60mPct: null,
  pathGreenShare10m: null,
  pathMinutesSinceHigh60m: null,
  pathHolderSlope10m: null,
  pathObservedMinutes: null,
};

export interface MarketContextFeatures {
  /** Share of decision moments finalized in the last 1h / 6h that doubled, in percent. */
  mktBaseRate1hPct: number | null;
  mktBaseRate6hPct: number | null;
  /** New launches seen per hour over the last hour. */
  mktLaunchesPerHour: number | null;
  /** Candidates inside the curated band this cycle. */
  mktInBandCount: number | null;
  /** Time of day on the unit circle (UTC), and whether it is a weekend (0/1). */
  ctxHourSin: number | null;
  ctxHourCos: number | null;
  ctxWeekend: number | null;
}

export const EMPTY_MARKET_CONTEXT: MarketContextFeatures = {
  mktBaseRate1hPct: null,
  mktBaseRate6hPct: null,
  mktLaunchesPerHour: null,
  mktInBandCount: null,
  ctxHourSin: null,
  ctxHourCos: null,
  ctxWeekend: null,
};

/** The clock part of the market context, for a moment. */
export function clockContext(
  at: Date,
): Pick<MarketContextFeatures, "ctxHourSin" | "ctxHourCos" | "ctxWeekend"> {
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  const angle = (2 * Math.PI * hour) / 24;
  const day = at.getUTCDay();
  return {
    ctxHourSin: Math.sin(angle),
    ctxHourCos: Math.cos(angle),
    ctxWeekend: day === 0 || day === 6 ? 1 : 0,
  };
}

interface Tick {
  at: number;
  priceUsd: number;
  holders: number | null;
}

/** How much tape a mint keeps: the hour the features look back over, plus a little slack. */
const TAPE_MS = 65 * 60_000;
/** Mints the book follows at most; the least recently observed are dropped past it. */
const MAX_MINTS = 6_000;
/** Two observations closer than this are one minute's worth: keep the newest. */
const MIN_TICK_SPACING_MS = 20_000;
const MINUTE = 60_000;
/** How much newer than "N minutes ago" the reference tick for a trailing return may be. */
const PRICE_AGO_SLACK_MS = MIN_TICK_SPACING_MS / 2;

/**
 * The tape: one short price/holder series per mint, fed by the scan. Memory is bounded by
 * TAPE_MS per mint and MAX_MINTS mints, so a worker that runs for weeks holds the same few
 * megabytes it held after its first hour.
 */
export class PricePathBook {
  private readonly tapes = new Map<string, Tick[]>();

  /** Records one observation. Out-of-order observations (older than the newest tick) are ignored. */
  observe(mint: string, at: Date, priceUsd: number, holders?: number | null): void {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
    const t = at.getTime();
    let tape = this.tapes.get(mint);
    if (!tape) {
      if (this.tapes.size >= MAX_MINTS) this.evictOldest();
      tape = [];
    } else {
      // Re-insert so Map order is "least recently observed first" for eviction.
      this.tapes.delete(mint);
      const last = tape[tape.length - 1];
      if (last && t < last.at) {
        this.tapes.set(mint, tape);
        return;
      }
      if (last && t - last.at < MIN_TICK_SPACING_MS) tape.pop();
    }
    tape.push({ at: t, priceUsd, holders: holders ?? null });
    const cutoff = t - TAPE_MS;
    while (tape.length > 0 && tape[0]!.at < cutoff) tape.shift();
    this.tapes.set(mint, tape);
  }

  /** Forgets every mint not observed since `before` (call between cycles with a stale cutoff). */
  prune(before: Date): void {
    const cutoff = before.getTime();
    for (const [mint, tape] of this.tapes) {
      if (tape.length === 0 || tape[tape.length - 1]!.at < cutoff) this.tapes.delete(mint);
    }
  }

  /** Mints currently on tape. */
  get size(): number {
    return this.tapes.size;
  }

  /** The path features for a mint as of its newest observation (observe first, then ask). */
  features(mint: string): PricePathFeatures {
    const tape = this.tapes.get(mint);
    if (!tape || tape.length < 2) return { ...EMPTY_PRICE_PATH };
    const now = tape[tape.length - 1]!;
    const first = tape[0]!;
    const observedMinutes = (now.at - first.at) / MINUTE;

    // The price `minutes` ago: the newest tick at or before that moment, give or take the slack
    // of one tick's spacing, provided the tape reaches back that far. The slack used to be half a
    // minute, which on the scan's 30-second cadence let the tick from the previous cycle stand
    // in for "a minute ago": pathRet1mPct was a 30-second return, and null only on a one-tick tape.
    const priceAgo = (minutes: number): number | null => {
      const target = now.at - minutes * MINUTE;
      if (first.at > target + PRICE_AGO_SLACK_MS) return null;
      let best: Tick | null = null;
      for (const tick of tape) {
        if (tick.at <= target + PRICE_AGO_SLACK_MS) best = tick;
        else break;
      }
      return best ? best.priceUsd : null;
    };
    const ret = (minutes: number): number | null => {
      const p = priceAgo(minutes);
      return p === null ? null : ((now.priceUsd - p) / p) * 100;
    };
    const drawdown = (minutes: number): { pct: number; highAt: number } | null => {
      const from = now.at - minutes * MINUTE;
      if (first.at > from + MINUTE / 2 && observedMinutes < minutes) {
        // Not a full window yet: still answer from what there is once a few minutes exist.
        if (observedMinutes < 3) return null;
      }
      let high = -Infinity;
      let highAt = now.at;
      for (const tick of tape) {
        if (tick.at < from) continue;
        if (tick.priceUsd > high) {
          high = tick.priceUsd;
          highAt = tick.at;
        }
      }
      if (!Number.isFinite(high) || high <= 0) return null;
      return { pct: ((now.priceUsd - high) / high) * 100, highAt };
    };

    const from10 = now.at - 10 * MINUTE;
    let ups = 0;
    let moves = 0;
    let holdersThen: Tick | null = null;
    for (let i = 1; i < tape.length; i++) {
      const prev = tape[i - 1]!;
      const tick = tape[i]!;
      if (tick.at <= from10) continue;
      if (tick.priceUsd !== prev.priceUsd) {
        moves += 1;
        if (tick.priceUsd > prev.priceUsd) ups += 1;
      }
    }
    for (const tick of tape) {
      if (tick.at <= from10 + MINUTE / 2 && tick.holders !== null) holdersThen = tick;
    }
    const holderSlope =
      holdersThen && now.holders !== null && now.at > holdersThen.at
        ? (now.holders - holdersThen.holders!) / ((now.at - holdersThen.at) / MINUTE)
        : null;

    const dd15 = drawdown(15);
    const dd60 = drawdown(60);
    return {
      pathRet1mPct: ret(1),
      pathRet5mPct: ret(5),
      pathRet15mPct: ret(15),
      pathRet30mPct: ret(30),
      pathDrawdown15mPct: dd15 ? dd15.pct : null,
      pathDrawdown60mPct: dd60 ? dd60.pct : null,
      pathGreenShare10m: observedMinutes >= 3 && moves > 0 ? ups / moves : observedMinutes >= 3 ? 0.5 : null,
      pathMinutesSinceHigh60m: dd60 ? (now.at - dd60.highAt) / MINUTE : null,
      pathHolderSlope10m: holderSlope,
      pathObservedMinutes: Math.round(observedMinutes * 10) / 10,
    };
  }

  private evictOldest(): void {
    const oldest = this.tapes.keys().next();
    if (!oldest.done) this.tapes.delete(oldest.value);
  }
}
