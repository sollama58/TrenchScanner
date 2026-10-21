import { freshAnchorRatioTrusted } from "./labels.js";

/**
 * Clock-honest readings of inputs the scan already stores under a window's name.
 *
 * DexScreener and Jupiter report each bucket (5m, 1h, 6h, 24h) as the change since the pair
 * opened whenever the pair is younger than that bucket. On a two-minute-old pair the 5m, 1h
 * and 24h price changes are one number — the move since the pair opened — and the 24h volume
 * is the pair's lifetime volume, not a day's. The same is true of the tape's 15 and 30-minute
 * returns: they answer from whatever tick exists, so a short tape's whole move is stored under
 * the longer window's name (pricePath.ts). A linear model cannot divide those levels by the
 * minutes they actually cover, and it was fitting "since the pair opened" four times under
 * four names, each one also a stand-in for how young the pair is.
 *
 * These readings are the level divided by the minutes the bucket actually covers, the named
 * window only when the pair has lived the whole of it, and the since-open move once, as its
 * own input, divided by the pair's age. They are derived from inputs the row already carries
 * (applyClockFeatures), so a training row banked before they existed is filled at load time.
 * Recorded on every row and read by the learners (user ask 2026-10-21). launchAgeMinutes is the
 * launch clock (null when the launch time is unknown). The named-window sums these replace
 * (priceChange5mPct, volume24hUsd, pathRet15mPct and the rest listed in RETIRED_LEARNER_INPUTS)
 * stay recorded at the same numbers so a deployed model still scores; the next fit reads these
 * instead. The onset guard (featureOnset.ts) holds a column out of a run until its history covers
 * the exam.
 */

/** The bucket widths, in minutes, DexScreener and Jupiter name their windows by. */
export const WINDOW_5M_MINUTES = 5;
export const WINDOW_1H_MINUTES = 60;
export const WINDOW_6H_MINUTES = 360;
export const WINDOW_24H_MINUTES = 1440;

/**
 * The clock-honest inputs, in vector order. Append-only: a saved model addresses inputs by
 * these names.
 */
export const CLOCK_HONEST_FEATURES = [
  "volPerMin5m",
  "volPerMin24h",
  "tradesPerMin24h",
  "px5mFullPct",
  "px1hFullPct",
  "pxSincePairPct",
  "pxSincePairPerMin",
  "jupPx5mFullPct",
  "jupPx1hFullPct",
  "jupVolPerMin5m",
  // Both Jupiter sides present. jupVolPerMin5m still treats a missing side as zero so a deployed
  // model keeps that meaning (review 2026-10-21). This column is retired from the fit until it
  // is shown not to hurt the 2x rate.
  "jupVolPerMin5mKnown",
  "launchAgeMinutes",
  "bandDwellShare",
  "decisionMcapUsd",
  "freshQuoteAgeSec",
] as const;

export type ClockHonestFeature = (typeof CLOCK_HONEST_FEATURES)[number];

/** The tape's own clock: how long the 15 and 30-minute returns actually span, and the move per minute. */
export const PATH_CLOCK_FEATURES = [
  "pathSpan15mMin",
  "pathSpan30mMin",
  "pathRet15mPerMin",
  "pathRet30mPerMin",
] as const;

const finite = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Minutes the named bucket actually covers. Null when the pair's age is unknown or not
 * positive: a missing age must not be treated as a full window, which is what left a
 * two-minute pair's lifetime volume labeled as 24h volume.
 */
export function bucketElapsedMinutes(pairAgeMinutes: number | null, windowMinutes: number): number | null {
  if (pairAgeMinutes === null || !(pairAgeMinutes > 0) || !(windowMinutes > 0)) return null;
  return Math.min(pairAgeMinutes, windowMinutes);
}

/**
 * The divisor for a per-minute rate. A pair a few seconds old (age is stored to 0.01 minute)
 * would otherwise turn a small print into a huge rate. One minute is the floor: the rate is at
 * most the level itself until the pair has lived a minute (2026-10-21).
 */
export const MIN_RATE_MINUTES = 1;

export function rateElapsedMinutes(elapsed: number | null): number | null {
  if (elapsed === null || !(elapsed > 0)) return null;
  return Math.max(elapsed, MIN_RATE_MINUTES);
}

/** A bucket's level (volume, trade count) per minute it actually covers. */
export function levelPerMinute(
  level: number | null,
  pairAgeMinutes: number | null,
  windowMinutes: number,
): number | null {
  const elapsed = rateElapsedMinutes(bucketElapsedMinutes(pairAgeMinutes, windowMinutes));
  if (level === null || elapsed === null) return null;
  return level / elapsed;
}

/** The named-window value only once the pair has lived the whole window. Otherwise null. */
export function fullWindowValue(
  value: number | null,
  pairAgeMinutes: number | null,
  windowMinutes: number,
): number | null {
  if (value === null || pairAgeMinutes === null || pairAgeMinutes < windowMinutes) return null;
  return value;
}

/**
 * The price change that is the move since the pair opened: the shortest bucket whose window
 * is still longer than the pair's age. Once the pair is at least 24h old, every bucket is a
 * real window and this is null. A shorter bucket is never used — at 90 minutes the 5m and 1h
 * changes are real windows, and only the 6h and 24h prints are still "since the pair opened".
 */
export function sincePairOpenPct(
  pairAgeMinutes: number | null,
  buckets: readonly (readonly [windowMinutes: number, value: number | null])[],
): number | null {
  if (pairAgeMinutes === null || !(pairAgeMinutes > 0)) return null;
  for (const [windowMinutes, value] of buckets) {
    if (windowMinutes > pairAgeMinutes && value !== null) return value;
  }
  return null;
}

const sumSides = (a: number | null, b: number | null): number | null => {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
};

/** A total only when both sides were reported. One missing side is unknown, not zero. */
const bothSides = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b;

/** Slack before a band dwell longer than the launch age is treated as two clocks disagreeing. */
const DWELL_SLACK_MINUTES = 1;

/**
 * The decision's market cap. A positive cap already stored — what live scored, and what the
 * label was graded from — wins. Otherwise the scan cap, scaled by a trusted fresh-quote ratio
 * when there is one. A missing stored cap is how a row banked before the column existed is filled.
 */
function storedDecisionCap(
  stored: number | null | undefined,
  mcap: number | null,
  quoteRatio: number | null,
): number | null {
  const kept = finite(stored);
  if (kept !== null && kept > 0) return kept;
  if (mcap !== null && mcap > 0) return quoteRatio !== null ? mcap * quoteRatio : mcap;
  return kept;
}

/**
 * The clock-honest block for one feature vector, from inputs the vector already carries.
 * Path per-minute returns need the spans the tape recorded (pathSpan15mMin / pathSpan30mMin);
 * a row banked before those spans exist reads them null, and the per-minute returns follow.
 */
export function clockFeatureValues(
  features: Record<string, number | null | undefined>,
): Record<ClockHonestFeature | (typeof PATH_CLOCK_FEATURES)[number], number | null> {
  const pairAge = finite(features.pairAgeMinutes);
  const m5 = finite(features.priceChange5mPct);
  const h1 = finite(features.priceChange1hPct);
  const h6 = finite(features.priceChange6hPct);
  const h24 = finite(features.priceChange24hPct);
  const since = sincePairOpenPct(pairAge, [
    [WINDOW_5M_MINUTES, m5],
    [WINDOW_1H_MINUTES, h1],
    [WINDOW_6H_MINUTES, h6],
    [WINDOW_24H_MINUTES, h24],
  ]);
  // Launch clock only. ageSource 0 is the pool's age in ageMinutes; a missing source is unknown.
  // withLaunchAge sets ageSource to 1 when it rebuilds ageMinutes from Token.launchedAt.
  const launchAge = features.ageSource === 1 ? finite(features.ageMinutes) : null;
  const dwell = finite(features.minutesSinceFirstInBand);
  let bandDwellShare: number | null = null;
  if (
    launchAge !== null &&
    launchAge > 0 &&
    dwell !== null &&
    dwell >= 0 &&
    dwell <= launchAge + DWELL_SLACK_MINUTES
  ) {
    bandDwellShare = Math.min(1, dwell / launchAge);
  }
  const mcap = finite(features.mcapUsd);
  const gap = finite(features.freshGapPct);
  const quoteRatio = gap === null ? null : 1 + gap / 100;
  const quoteTrusted = quoteRatio !== null && freshAnchorRatioTrusted(quoteRatio);
  const jupBuy = finite(features.jup5mBuyVolumeUsd);
  const jupSell = finite(features.jup5mSellVolumeUsd);
  const jup5mVol = sumSides(jupBuy, jupSell);
  const jup5mVolKnown = bothSides(jupBuy, jupSell);
  const span15 = finite(features.pathSpan15mMin);
  const span30 = finite(features.pathSpan30mMin);
  const ret15 = finite(features.pathRet15mPct);
  const ret30 = finite(features.pathRet30mPct);
  const perMinute = (level: number | null, elapsed: number | null): number | null => {
    const minutes = rateElapsedMinutes(elapsed);
    if (level === null || minutes === null) return null;
    return level / minutes;
  };
  return {
    volPerMin5m: levelPerMinute(finite(features.volume5mUsd), pairAge, WINDOW_5M_MINUTES),
    volPerMin24h: levelPerMinute(finite(features.volume24hUsd), pairAge, WINDOW_24H_MINUTES),
    tradesPerMin24h: levelPerMinute(
      sumSides(finite(features.buys24h), finite(features.sells24h)),
      pairAge,
      WINDOW_24H_MINUTES,
    ),
    px5mFullPct: fullWindowValue(m5, pairAge, WINDOW_5M_MINUTES),
    px1hFullPct: fullWindowValue(h1, pairAge, WINDOW_1H_MINUTES),
    pxSincePairPct: since,
    pxSincePairPerMin: perMinute(since, pairAge),
    jupPx5mFullPct: fullWindowValue(finite(features.jup5mPriceChangePct), pairAge, WINDOW_5M_MINUTES),
    jupPx1hFullPct: fullWindowValue(finite(features.jup1hPriceChangePct), pairAge, WINDOW_1H_MINUTES),
    jupVolPerMin5m: levelPerMinute(jup5mVol, pairAge, WINDOW_5M_MINUTES),
    jupVolPerMin5mKnown: levelPerMinute(jup5mVolKnown, pairAge, WINDOW_5M_MINUTES),
    launchAgeMinutes: launchAge,
    bandDwellShare,
    // The cap the label is graded from: the fresh quote on the scan's supply when the gap was
    // trusted, else the scan's own cap (decisionAnchor / freshAnchorRatioTrusted in labels.ts).
    // A gap past the anchor's ratio is a bad quote, not the anchor. A linear model cannot
    // multiply mcap by the gap, so the product is its own input.
    // Live writes that cap onto the vector (buildCandidateFeatures), including when the anchor
    // refused the quote — a price with no market cap, gap still inside the ratio — and stored
    // the scan cap. Rebuilding mcap * (1 + gap/100) whenever the scan cap is positive would
    // replace that stored cap on every training load. A cap already on the row is kept. A row
    // banked before the column existed (no stored cap) is still filled from the scan cap and
    // the gap. A scan cap of 0 cannot rebuild the product either, so a stored cap is what is left.
    decisionMcapUsd: storedDecisionCap(features.decisionMcapUsd, mcap, quoteTrusted ? quoteRatio : null),
    // How old the fresh quote is. The training load cannot rebuild it (the fetch time was never
    // stored); live scoring sets it from FreshQuote.fetchedAt before this runs. Null is unknown,
    // not "fresh".
    freshQuoteAgeSec: finite(features.freshQuoteAgeSec),
    pathSpan15mMin: span15,
    pathSpan30mMin: span30,
    pathRet15mPerMin: perMinute(ret15, span15),
    pathRet30mPerMin: perMinute(ret30, span30),
  };
}

/**
 * The vector with the clock-honest block filled from the inputs it already carries. A row that
 * already holds the same values comes back as it is. The path spans are left as the tape wrote
 * them: this never invents a span for a row that has none.
 */
export function applyClockFeatures<T extends Record<string, number | null | undefined>>(
  features: T,
): T & Record<ClockHonestFeature | (typeof PATH_CLOCK_FEATURES)[number], number | null> {
  const next = clockFeatureValues(features);
  let out: Record<string, number | null | undefined> | null = null;
  for (const name of Object.keys(next) as (keyof typeof next)[]) {
    if (features[name] === next[name]) continue;
    out ??= { ...features };
    out[name] = next[name];
  }
  return (out ?? features) as T &
    Record<ClockHonestFeature | (typeof PATH_CLOCK_FEATURES)[number], number | null>;
}
