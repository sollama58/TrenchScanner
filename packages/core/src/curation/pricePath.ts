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
  /**
   * Price change over the last 1/5/15/30 minutes, in percent. The 1 and 5-minute returns need
   * the tape to reach their reference; the 15 and 30-minute returns are measured across whatever
   * tape there is, with pathGapMinutes saying how much of the half hour that tape missed.
   */
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
  /**
   * Minutes of the last 30 that no tape covers: the stretch before the tape's first tick, plus
   * every hole inside the window where consecutive ticks sit more than TAPE_HOLE_MS apart. 0 on a
   * full tape, 30 on none. It says nothing about the coin's age: a coin younger than the window
   * reads a gap too (ageMinutes rides alongside in the vector).
   */
  pathGapMinutes: number | null;
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
  pathGapMinutes: null,
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
  /** When the holder count was read (its source's time, not the scan's); `at` when not known. */
  holdersAt: number;
}

/** The holder slope needs two readings at least this far apart: closer, they are mostly one report. */
const HOLDER_SLOPE_MIN_SPAN_MS = 5 * 60_000;

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
 * How far before "`minutes` ago" the reference tick may sit and still stand for it: a fifth of the
 * window, and never under 45 s (one missed 30-second scan cycle). Past that the tape has a gap
 * there and the return is unknown, not the move since whenever the mint was last seen.
 */
export function priceAgoTolerance(minutes: number): number {
  return Math.max(0.75 * MINUTE, 0.2 * minutes * MINUTE);
}

/** The window pathGapMinutes is measured over: the longest trailing return's. */
export const PATH_GAP_WINDOW_MINUTES = 30;
/**
 * Consecutive ticks further apart than this leave a hole in the tape: the minutes between them
 * count as unobserved. Three missed 30-second cycles; a mint that left the scan band is minutes.
 */
const TAPE_HOLE_MS = 2 * MINUTE;

/**
 * The tape: one short price/holder series per mint, fed by the scan. Memory is bounded by
 * TAPE_MS per mint and MAX_MINTS mints, so a worker that runs for weeks holds the same few
 * megabytes it held after its first hour.
 */
export class PricePathBook {
  private readonly tapes = new Map<string, Tick[]>();

  /** Records one observation. Out-of-order observations (older than the newest tick) are ignored. */
  observe(mint: string, at: Date, priceUsd: number, holders?: number | null, holdersAt?: Date): void {
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
    tape.push({ at: t, priceUsd, holders: holders ?? null, holdersAt: holdersAt?.getTime() ?? t });
    const cutoff = t - TAPE_MS;
    while (tape.length > 0 && tape[0]!.at < cutoff) tape.shift();
    this.tapes.set(mint, tape);
  }

  /**
   * Lays earlier observations under a mint's tape: the scan's stored snapshots, for a book that
   * started after them. The tape lives in memory, so every deploy emptied it, and for the next
   * half hour every coin read as freshly observed - the 15 and 30-minute returns and the holder
   * slope, the strongest inputs the models have, went null on every decision (inputs thread,
   * 2026-10-13: 13-14 deploys in three days). Only ticks older than the tape's first are taken,
   * spaced as observe() would have kept them, so seeding after the scan has already observed
   * the mint (or twice) changes nothing it has seen.
   */
  seed(
    mint: string,
    ticks: readonly { at: Date; priceUsd: number; holders?: number | null; holdersAt?: Date | null }[],
  ): void {
    const tape = this.tapes.get(mint);
    if (!tape && this.tapes.size >= MAX_MINTS) return;
    const firstAt = tape?.[0]?.at ?? Infinity;
    const newest = Math.max(tape?.[tape.length - 1]?.at ?? -Infinity, ...ticks.map((t) => t.at.getTime()));
    const cutoff = newest - TAPE_MS;
    const earlier: Tick[] = [];
    for (const t of [...ticks].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const at = t.at.getTime();
      if (!Number.isFinite(t.priceUsd) || t.priceUsd <= 0 || at < cutoff) continue;
      if (at > firstAt - MIN_TICK_SPACING_MS) break;
      const last = earlier[earlier.length - 1];
      if (last && at - last.at < MIN_TICK_SPACING_MS) earlier.pop();
      earlier.push({
        at,
        priceUsd: t.priceUsd,
        holders: t.holders ?? null,
        holdersAt: t.holdersAt?.getTime() ?? at,
      });
    }
    if (earlier.length === 0) return;
    if (tape) tape.unshift(...earlier);
    else this.tapes.set(mint, earlier);
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
    // No tape, or one tick: nothing to measure, and the whole window unobserved.
    if (!tape || tape.length < 2) return { ...EMPTY_PRICE_PATH, pathGapMinutes: PATH_GAP_WINDOW_MINUTES };
    const now = tape[tape.length - 1]!;
    const first = tape[0]!;
    const observedMinutes = (now.at - first.at) / MINUTE;

    // The price `minutes` ago: the newest tick at or before that moment, give or take the slack
    // of one tick's spacing. The slack used to be half a minute, which on the scan's 30-second
    // cadence let the tick from the previous cycle stand in for "a minute ago": pathRet1mPct was
    // a 30-second return, and null only on a one-tick tape.
    //
    // For the 1 and 5-minute returns the tape must reach back that far and the tick must sit
    // near that moment: a mint that left the scan and came back keeps its old ticks (the tape is
    // pruned only after two hours unseen), so without the bound a coin revived after 40 minutes
    // read its 40-minute move as the 5-minute return, and a gap of a cycle or two stretched the
    // 1-minute return over three (features audit 2026-10-12, #376).
    //
    // The 15 and 30-minute returns are measured across whatever tape there is (user decision
    // 2026-10-16, notes/data-audit-2026-10-16/round2-hunt.md finding 3): a tape shorter than the
    // window answers from its oldest tick, and a hole in the tape where the reference should sit
    // answers from the tick before the hole. Null only read "the scanner only just started
    // watching this coin, or lost it and found it again", which is when a coin pumps back into
    // the band: on 20+ minute-old coins a missing 15-minute return doubled 9.2% against 3.1%, and
    // the seats scored those rows about three times the ones carrying a value. Now the move is a
    // value and pathGapMinutes says how much of the window the tape missed, so the models see both.
    const priceAgo = (minutes: number, acrossGaps: boolean): number | null => {
      const target = now.at - minutes * MINUTE;
      let best: Tick | null = null;
      for (const tick of tape) {
        if (tick.at <= target + PRICE_AGO_SLACK_MS) best = tick;
        else break;
      }
      if (!best) return acrossGaps ? first.priceUsd : null;
      if (!acrossGaps && target - best.at > priceAgoTolerance(minutes)) return null;
      return best.priceUsd;
    };
    const ret = (minutes: number, acrossGaps = false): number | null => {
      const p = priceAgo(minutes, acrossGaps);
      return p === null ? null : ((now.priceUsd - p) / p) * 100;
    };
    // Minutes of the window no tape covers: before its first tick, and every hole inside it.
    const windowStart = now.at - PATH_GAP_WINDOW_MINUTES * MINUTE;
    let uncoveredMs = Math.max(0, first.at - windowStart);
    for (let i = 1; i < tape.length; i++) {
      const prev = tape[i - 1]!;
      const tick = tape[i]!;
      if (tick.at <= windowStart || tick.at - prev.at <= TAPE_HOLE_MS) continue;
      uncoveredMs += tick.at - Math.max(prev.at, windowStart);
    }
    const gapMinutes = Math.min(PATH_GAP_WINDOW_MINUTES, Math.round((uncoveredMs / MINUTE) * 10) / 10);
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
    // Measured between readings of the count, not scans: the scan can serve one cached RugCheck
    // report for several cycles, which read as no growth at all over what looked like minutes.
    for (const tick of tape) {
      if (tick.holdersAt <= from10 + MINUTE / 2 && tick.holders !== null) holdersThen = tick;
    }
    // A report is re-read every few minutes (the RugCheck cache's TTL), so the baseline reading may
    // sit a few minutes before the mark, but not past twice the window: a baseline from before a
    // gap in the tape would spread an hour's growth over what reads as ten minutes.
    if (holdersThen && now.at - holdersThen.holdersAt > 2 * 10 * MINUTE) holdersThen = null;
    const holderSpan = holdersThen ? now.holdersAt - holdersThen.holdersAt : 0;
    const holderSlope =
      holdersThen && now.holders !== null && holderSpan >= HOLDER_SLOPE_MIN_SPAN_MS
        ? (now.holders - holdersThen.holders!) / (holderSpan / MINUTE)
        : null;

    const dd15 = drawdown(15);
    const dd60 = drawdown(60);
    return {
      pathRet1mPct: ret(1),
      pathRet5mPct: ret(5),
      pathRet15mPct: ret(15, true),
      pathRet30mPct: ret(30, true),
      pathDrawdown15mPct: dd15 ? dd15.pct : null,
      pathDrawdown60mPct: dd60 ? dd60.pct : null,
      pathGreenShare10m: observedMinutes >= 3 && moves > 0 ? ups / moves : observedMinutes >= 3 ? 0.5 : null,
      pathMinutesSinceHigh60m: dd60 ? (now.at - dd60.highAt) / MINUTE : null,
      pathHolderSlope10m: holderSlope,
      pathObservedMinutes: Math.round(observedMinutes * 10) / 10,
      pathGapMinutes: gapMinutes,
    };
  }

  private evictOldest(): void {
    const oldest = this.tapes.keys().next();
    if (!oldest.done) this.tapes.delete(oldest.value);
  }
}
