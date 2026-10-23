import { prisma } from "../db.js";
import { SUBSCRIPTION_MINT, SUBSCRIPTION_MINT_DECIMALS } from "./constants.js";
import type { SacrificeMode } from "./sacrifice.js";

/**
 * The smoothed $ASDFASDFA price the Sacrifice is charged at (ASDF fee plan, Build guide step 2).
 *
 * The worker samples ASDF per SOL every ASDF_PRICE_SAMPLE_MS from two sources: a Jupiter quote of
 * a fixed 1 SOL into ASDF (what a trader would actually get) and the Price API's ASDF/USD over
 * SOL/USD (DexScreener backing it up, jupiterSwap.ts pricesUsd). The fee price is the lower ASDF
 * price (more ASDF per SOL) of two medians, the last 5 minutes and the last 24 hours: ASDF trades
 * thin, so a 5-minute median alone is cheap to push up, and a higher ASDF price means fewer
 * credits per Sacrifice. Taking the lower one means a pump can't cut the Sacrifice below what the
 * day's price gives.
 *
 * Guards: at least ASDF_PRICE_MIN_SAMPLES in the 5-minute window, the newest sample under
 * ASDF_PRICE_MAX_AGE_MS old, both sources answering at that newest sample (within
 * ASDF_PRICE_SOURCE_MAX_AGE_MS of it), and each source's newest sample within ASDF_PRICE_MAX_SPREAD
 * of the other's. A failed guard is a reason, never a guess: the build refuses fee-paying trades.
 *
 * When the sampler pauses (every worker deploy does, for a minute or more), the price as of its
 * newest sample stands for ASDF_PRICE_MAX_AGE_MS: it is a 24-hour / 5-minute smoothing, so a few
 * minutes change nothing material, and fee-paying trades shouldn't stop at each worker restart.
 *
 * While the Sacrifice is off no trade reads this price, so the worker samples only every
 * ASDF_PRICE_OFF_SAMPLE_MS (user ask 2026-10-23: API audit bundle, A8): still some 1,440 samples a
 * day for the 24-hour median, and 8,640 fewer Jupiter calls. The guards the admin panel reads are
 * scaled to that slower cadence while off (ASDF_PRICE_OFF_GUARDS), so it does not read "few
 * samples" or "source down" for samples that are only further apart.
 */

/** The sampler's cadence while the Sacrifice is "shadow" or "on" (the worker job's tick). */
export const ASDF_PRICE_SAMPLE_MS = 15_000;
/** The sampler's cadence while the Sacrifice is "off". */
export const ASDF_PRICE_OFF_SAMPLE_MS = 60_000;
export const ASDF_PRICE_SHORT_MS = 5 * 60_000;
export const ASDF_PRICE_LONG_MS = 24 * 60 * 60_000;
/** Samples older than this are pruned: the long window plus an hour. */
export const ASDF_PRICE_KEEP_MS = 25 * 60 * 60_000;
export const ASDF_PRICE_MIN_SAMPLES = 10;
export const ASDF_PRICE_MAX_AGE_MS = 10 * 60_000;
/** Each source's newest sample must be this close to the newest of all: both were answering. */
export const ASDF_PRICE_SOURCE_MAX_AGE_MS = 60_000;
export const ASDF_PRICE_MAX_SPREAD = 0.05;
/** Old samples are pruned at most this often, not on every sample. */
const PRUNE_EVERY_MS = 60_000;

/** The guards that depend on how far apart the samples are. */
export interface AsdfPriceGuards {
  /** Samples (both sources counted) the 5-minute window needs. */
  minSamples: number;
  /** How far each source's newest sample may lag the newest of all. */
  sourceMaxAgeMs: number;
}

/** At the 15-second cadence (shadow and on): what a trade is charged under. */
export const ASDF_PRICE_GUARDS: AsdfPriceGuards = {
  minSamples: ASDF_PRICE_MIN_SAMPLES,
  sourceMaxAgeMs: ASDF_PRICE_SOURCE_MAX_AGE_MS,
};
/**
 * At the 60-second cadence (off): 5 minutes hold about 10 samples, not 40, so the 15-second
 * guards would sit on the edge. Two readings from each source, and a source may miss one sample
 * (plus timer slack) before it reads as down. Only the admin panel reads the price while off.
 */
export const ASDF_PRICE_OFF_GUARDS: AsdfPriceGuards = {
  minSamples: 4,
  sourceMaxAgeMs: 2.5 * ASDF_PRICE_OFF_SAMPLE_MS,
};

/** The sampler's cadence for the Sacrifice's mode. */
export function asdfPriceSampleMs(mode: SacrificeMode): number {
  return mode === "off" ? ASDF_PRICE_OFF_SAMPLE_MS : ASDF_PRICE_SAMPLE_MS;
}

/** The guards for the Sacrifice's mode: the slower cadence's while off. */
export function asdfPriceGuards(mode: SacrificeMode): AsdfPriceGuards {
  return mode === "off" ? ASDF_PRICE_OFF_GUARDS : ASDF_PRICE_GUARDS;
}

/**
 * Whether the worker's tick (every ASDF_PRICE_SAMPLE_MS) should sample now, given the last sample
 * it took at `lastAt` (0: none yet). Half a tick of slack, so a timer that fires a little early
 * does not push an off-mode sample a whole tick late.
 */
export function asdfPriceSampleDue(mode: SacrificeMode, lastAt: number, now: number): boolean {
  return now - lastAt >= asdfPriceSampleMs(mode) - ASDF_PRICE_SAMPLE_MS / 2;
}

export type AsdfPriceSource = "quote" | "price";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const WSOL = "So11111111111111111111111111111111111111112";

/** What sampleAsdfPrice reads from: the trading Jupiter client (JupiterSwapClient) fits. */
export interface AsdfPriceReader {
  quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<{ outAmount: string }>;
  pricesUsd(mints: string[]): Promise<Map<string, number>>;
}

let lastPruneAt: number | null = null;

/**
 * One sample from each source that answers, written to AsdfPriceSample, and samples past
 * ASDF_PRICE_KEEP_MS pruned (at most every PRUNE_EVERY_MS: a statement per sample bought nothing).
 * Throws when neither source answers, so the heartbeat says so.
 */
export async function sampleAsdfPrice(
  reader: AsdfPriceReader,
  now = new Date(),
): Promise<{ quote: number | null; price: number | null }> {
  const scale = 10 ** SUBSCRIPTION_MINT_DECIMALS;
  const [quote, price] = await Promise.all([
    reader
      .quote({ inputMint: WSOL, outputMint: SUBSCRIPTION_MINT, amount: LAMPORTS_PER_SOL, slippageBps: 100 })
      .then((q) => {
        const out = Number(q.outAmount) / scale;
        return Number.isFinite(out) && out > 0 ? out : null;
      })
      .catch(() => null),
    reader
      .pricesUsd([WSOL, SUBSCRIPTION_MINT])
      .then((p) => {
        const sol = p.get(WSOL);
        const asdf = p.get(SUBSCRIPTION_MINT);
        return sol && asdf && sol > 0 && asdf > 0 ? sol / asdf : null;
      })
      .catch(() => null),
  ]);
  const rows = (
    [
      ["quote", quote],
      ["price", price],
    ] as const
  ).flatMap(([source, asdfPerSol]) => (asdfPerSol === null ? [] : [{ at: now, source, asdfPerSol }]));
  if (rows.length > 0) await prisma.asdfPriceSample.createMany({ data: rows });
  if (lastPruneAt === null || Math.abs(now.getTime() - lastPruneAt) >= PRUNE_EVERY_MS) {
    lastPruneAt = now.getTime();
    await prisma.asdfPriceSample.deleteMany({
      where: { at: { lt: new Date(now.getTime() - ASDF_PRICE_KEEP_MS) } },
    });
  }
  if (rows.length === 0) throw new Error("neither the Jupiter quote nor the price sources priced ASDF");
  return { quote, price };
}

export type AsdfPriceRefusal = "few_samples" | "stale" | "source_down" | "sources_apart";

export interface AsdfPriceState {
  /** Whole ASDF per SOL the Sacrifice is charged at, when every guard passes. */
  asdfPerSol: number | null;
  /** Why it can't be used, when a guard fails. */
  refusal: AsdfPriceRefusal | null;
  /** The two medians (null with no samples in the window). */
  shortMedian: number | null;
  longMedian: number | null;
  /** Each source's newest sample, the "spot" prices. */
  spot: Record<AsdfPriceSource, { asdfPerSol: number; at: Date } | null>;
  /** Samples in the 5-minute window, and the newest sample's time. */
  samples: number;
  newestAt: Date | null;
}

/** What smoothedAsdfPerSol works on: every sample of the last ASDF_PRICE_LONG_MS. */
export interface AsdfPriceSampleRow {
  at: Date;
  source: string;
  asdfPerSol: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The guards and medians over `rows` (pure: the tests and smoothedAsdfPerSol share it). `guards`
 * are the 15-second cadence's unless the caller knows the Sacrifice is off (asdfPriceGuards).
 */
export function asdfPriceFrom(
  rows: readonly AsdfPriceSampleRow[],
  now: Date,
  guards: AsdfPriceGuards = ASDF_PRICE_GUARDS,
): AsdfPriceState {
  const t = now.getTime();
  const long = rows.filter((r) => r.at.getTime() > t - ASDF_PRICE_LONG_MS && r.at.getTime() <= t);
  // The 5-minute window ends at the newest sample, not now: a paused sampler keeps the price it
  // last had (for ASDF_PRICE_MAX_AGE_MS) instead of its window running empty.
  const anchor = long.reduce((best, r) => Math.max(best, r.at.getTime()), -Infinity);
  const short = long.filter((r) => r.at.getTime() > anchor - ASDF_PRICE_SHORT_MS);
  const newest = (source: AsdfPriceSource) =>
    short
      .filter((r) => r.source === source)
      .reduce<AsdfPriceSampleRow | null>((best, r) => (!best || r.at > best.at ? r : best), null);
  const spot = { quote: newest("quote"), price: newest("price") };
  const shortMedian = median(short.map((r) => r.asdfPerSol));
  const longMedian = median(long.map((r) => r.asdfPerSol));
  const newestAt = short.reduce<Date | null>((best, r) => (!best || r.at > best ? r.at : best), null);
  let refusal: AsdfPriceRefusal | null = null;
  const fresh = (r: AsdfPriceSampleRow | null) => !!r && anchor - r.at.getTime() <= guards.sourceMaxAgeMs;
  if (short.length < guards.minSamples) refusal = "few_samples";
  else if (!newestAt || t - newestAt.getTime() > ASDF_PRICE_MAX_AGE_MS) refusal = "stale";
  else if (!fresh(spot.quote) || !fresh(spot.price)) refusal = "source_down";
  else {
    const a = spot.quote!.asdfPerSol;
    const b = spot.price!.asdfPerSol;
    if (Math.abs(a - b) / Math.min(a, b) > ASDF_PRICE_MAX_SPREAD) refusal = "sources_apart";
  }
  return {
    // The lower ASDF price is the higher ASDF per SOL.
    asdfPerSol: refusal === null ? Math.max(shortMedian!, longMedian!) : null,
    refusal,
    shortMedian,
    longMedian,
    spot: {
      quote: spot.quote ? { asdfPerSol: spot.quote.asdfPerSol, at: spot.quote.at } : null,
      price: spot.price ? { asdfPerSol: spot.price.asdfPerSol, at: spot.price.at } : null,
    },
    samples: short.length,
    newestAt,
  };
}

let cache: { at: number; guards: AsdfPriceGuards; state: AsdfPriceState } | null = null;
/** The samples change every ASDF_PRICE_SAMPLE_MS: a build reads at most this stale a state. */
const CACHE_MS = 5_000;

/**
 * The smoothed ASDF price now, or why it can't be used (see asdfPriceFrom). A trade's build uses
 * the default guards; the admin panel passes the off mode's while the Sacrifice is off.
 */
export async function smoothedAsdfPerSol(
  now = new Date(),
  guards: AsdfPriceGuards = ASDF_PRICE_GUARDS,
): Promise<AsdfPriceState> {
  if (cache && cache.guards === guards && Math.abs(now.getTime() - cache.at) < CACHE_MS) return cache.state;
  const rows = await prisma.asdfPriceSample.findMany({
    where: { at: { gt: new Date(now.getTime() - ASDF_PRICE_LONG_MS) } },
    select: { at: true, source: true, asdfPerSol: true },
  });
  const state = asdfPriceFrom(rows, now, guards);
  cache = { at: now.getTime(), guards, state };
  return state;
}

/** Tests: forget the cached state. */
export function resetAsdfPriceCacheForTests(): void {
  cache = null;
}

/** ASDF base units per SOL at `asdfPerSol` whole ASDF per SOL: the Sacrifice maths' P_raw. */
export function asdfRawPerSol(asdfPerSol: number): bigint {
  return BigInt(Math.round(asdfPerSol * 10 ** SUBSCRIPTION_MINT_DECIMALS));
}

export function describeAsdfPriceRefusal(refusal: AsdfPriceRefusal): string {
  switch (refusal) {
    case "few_samples":
      return "The ASDF price has too few recent readings to charge the Sacrifice. Try again in a few minutes.";
    case "stale":
      return "The ASDF price hasn't updated in the last 10 minutes, so the Sacrifice can't be worked out. Try again shortly.";
    case "source_down":
      return "One of the two ASDF price sources isn't answering, so the Sacrifice can't be checked. Try again shortly.";
    case "sources_apart":
      return "The two ASDF price sources disagree by more than 5%, so the Sacrifice isn't charged until they agree. Try again shortly.";
  }
}
