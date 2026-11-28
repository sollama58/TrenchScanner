/**
 * The fill target (owner decision 2026-11-28, notes/program-audit-2026-11-28/target-study.md):
 * a call wins when the price reaches 2x the price a buyer could really have got, within 30 minutes
 * of the call, before it falls 30% below that price.
 *
 * The fill is the first price seen FILL_DELAY_MS or later after the call (the delay the trade tape
 * measured between a call and a real buy landing), plus FILL_PENALTY_FRACTION. When that price is
 * a curve-tape print inside FILL_TAPE_LATEST_MS it is the tape's 5-second time-weighted price (the
 * same smoothing the labels use) and the fill is marked "tape". Otherwise it is the watcher's
 * minute sample and is marked "minute".
 *
 * This is graded BESIDE the labels in labels.ts, not instead of them: the 2x-in-15-minutes label
 * is what the models learn and are scored on, and nothing here writes to it. Kept pure, like
 * labels.ts, so it can be tested without a database or a price feed.
 */

/** How long after the call the simulated buy lands. FDSA_LAB_FRICTIONS.entryDelaySec is the same 16 s. */
export const FILL_DELAY_MS = 16_000;
/** What the buy pays over the price seen. */
export const FILL_PENALTY_FRACTION = 0.01;
/** A tape print later than this after the call is no longer "the fill at 16 seconds". */
export const FILL_TAPE_LATEST_MS = 60_000;
/** The window the 2x has to land in, measured from the call (not from the fill). */
export const FILL_WINDOW_MINUTES = 30;
/** The multiple of the fill that wins. */
export const FILL_WIN_MULTIPLE = 2;
/** Trading at or below this fraction of the fill stops the trade out. */
export const FILL_STOP_FRACTION = 0.7;
/**
 * What a sale keeps of its gross multiple: a 1% fee on each side and 1% slippage on the sale (the
 * entry's 1% is already in the fill price). The study's `NET` with the entry penalty taken out.
 */
export const FILL_NET_FACTOR = (0.99 * 0.99) / 1.01;

export type FillSource = "tape" | "minute";

/** The running fill-target aggregates a CandidateOutcome row carries between price ticks. */
export interface FillAggregates {
  anchorAt: Date;
  /** The fill, penalty included; null until a price FILL_DELAY_MS or later after the call is seen. */
  fillPriceUsd: number | null;
  fillAt: Date | null;
  /** "tape" or "minute" (FillSource); a plain string on the row. */
  fillSource: string | null;
  /** When the price first reached FILL_WIN_MULTIPLE x the fill, inside the window and before the stop. */
  fillHit2xAt: Date | null;
  /** When the price first fell to the stop, inside the window and before the 2x. */
  fillStoppedAt: Date | null;
  /**
   * The price the trade is out at when it neither won nor stopped: the stop tick's own price for a
   * stop (a fall through the level sells below it), else the last price seen inside the window.
   */
  fillExitPriceUsd: number | null;
}

export function initialFillAggregates(anchorAt: Date): FillAggregates {
  return {
    anchorAt,
    fillPriceUsd: null,
    fillAt: null,
    fillSource: null,
    fillHit2xAt: null,
    fillStoppedAt: null,
    fillExitPriceUsd: null,
  };
}

/**
 * Folds one observed price into the fill aggregates, returning only the fields that changed.
 * `fromTape` says the price is a smoothed curve-tape print rather than the minute sample.
 *
 * A price before the fill delay is ignored. The first one after it is the fill and decides
 * nothing else. Every later price inside the window can stop the trade or win it, the stop first:
 * one price cannot be both, and a price at or under the stop is a loss.
 */
export function applyFillTick(
  agg: FillAggregates,
  priceUsd: number,
  at: Date,
  fromTape: boolean,
): Partial<FillAggregates> {
  const updates: Partial<FillAggregates> = {};
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return updates;
  const elapsedMs = at.getTime() - agg.anchorAt.getTime();
  if (!(elapsedMs >= FILL_DELAY_MS) || elapsedMs > FILL_WINDOW_MINUTES * 60_000) return updates;

  if (agg.fillPriceUsd === null) {
    updates.fillPriceUsd = priceUsd * (1 + FILL_PENALTY_FRACTION);
    updates.fillAt = at;
    updates.fillSource = fromTape && elapsedMs <= FILL_TAPE_LATEST_MS ? "tape" : "minute";
    updates.fillExitPriceUsd = priceUsd;
    return updates;
  }
  // Settled: the trade is out, nothing later moves it.
  if (agg.fillHit2xAt !== null || agg.fillStoppedAt !== null) return updates;

  updates.fillExitPriceUsd = priceUsd;
  if (priceUsd <= agg.fillPriceUsd * FILL_STOP_FRACTION) updates.fillStoppedAt = at;
  else if (priceUsd >= agg.fillPriceUsd * FILL_WIN_MULTIPLE) updates.fillHit2xAt = at;
  return updates;
}

export interface FillLabels {
  /** Won on the fill target. */
  fillWin: boolean;
  /**
   * The trade's return after costs, in percent of the stake: out at 2x for a win, at the stop (or
   * the lower price it fell through to) for a stop, else at the last price seen inside the window.
   */
  fillReturnPct: number;
}

/**
 * The fill-target verdict once the window has closed. Null when no price was seen after the fill
 * delay: there was no trade to grade, which is not a loss.
 */
export function computeFillLabels(agg: FillAggregates): FillLabels | null {
  const fill = agg.fillPriceUsd;
  if (fill === null || !(fill > 0)) return null;
  const fillWin = agg.fillHit2xAt !== null;
  let gross: number;
  if (fillWin) gross = FILL_WIN_MULTIPLE;
  else {
    const exit = agg.fillExitPriceUsd ?? fill / (1 + FILL_PENALTY_FRACTION);
    gross = agg.fillStoppedAt !== null ? Math.min(FILL_STOP_FRACTION, exit / fill) : exit / fill;
  }
  const pct = (gross * FILL_NET_FACTOR - 1) * 100;
  return { fillWin, fillReturnPct: Number.isFinite(pct) ? pct : -100 };
}

/**
 * Grades one call from a list of prices, oldest first: the same fold the watcher runs, for the
 * history backfill and for checking the rule against the target study.
 */
export function gradeFillFromTicks(
  anchorAt: Date,
  ticks: readonly { priceUsd: number; at: Date; fromTape: boolean }[],
): { agg: FillAggregates; labels: FillLabels | null } {
  const agg = initialFillAggregates(anchorAt);
  for (const t of ticks) Object.assign(agg, applyFillTick(agg, t.priceUsd, t.at, t.fromTape));
  return { agg, labels: computeFillLabels(agg) };
}
