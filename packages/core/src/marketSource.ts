/**
 * Where a candidate's market reading came from (user decision 2026-10-16, "markers everywhere":
 * notes/data-audit-2026-10-16/round2-code.md, section 4). The band refresh prices a young launch
 * from Jupiter, a launch DexScreener has no pair for yet from GeckoTerminal, and everything else
 * from DexScreener's pair, and the three disagree on more than the price: Jupiter's liquidity is
 * its figure doubled, its 5m/1h windows are its own, its pair time is the curve's first pool
 * where DexScreener's is the current pair. Until now nothing on the row said which, so a model
 * trained on the mix could not tell a Jupiter reading from a DexScreener one. Recorded on the
 * snapshot (TokenSnapshot.marketSource) and on every feature vector (mktSource) from the moment
 * the reading is taken; never backfilled.
 */

export const MARKET_SOURCE = {
  /** DexScreener's pair, as it answered: price, cap, windows, pair time all DexScreener's. */
  dexscreener: "dexscreener",
  /**
   * DexScreener's pair with Jupiter's live price (and the cap that price makes on the pair's
   * supply): the refresh's reading of a listed launch under ten minutes old. A pair quoted in
   * another coin takes Jupiter's volumes and price changes too (refreshCandidates.ts). Also a
   * reading of any age whose DexScreener price had stopped at a stale figure Jupiter disagreed
   * with (DexScreenerClient.correctStalePrices, from 2026-10-16).
   */
  dexscreenerLive: "dexscreener_live",
  /** Jupiter's reading outright: a launch DexScreener had not listed when the live read priced it. */
  jupiter: "jupiter",
  /** GeckoTerminal's pool: the fallback for a launch DexScreener has no pair for, or while it is blank. */
  gecko: "gecko",
} as const;

export type MarketSource = (typeof MARKET_SOURCE)[keyof typeof MARKET_SOURCE];

/**
 * The source as the feature vector carries it (mktSource): one small integer, fixed for good like
 * a feature name. A source added later takes the next number; none is ever renumbered.
 */
export const MARKET_SOURCE_CODE: Readonly<Record<MarketSource, number>> = {
  [MARKET_SOURCE.dexscreener]: 1,
  [MARKET_SOURCE.dexscreenerLive]: 2,
  [MARKET_SOURCE.jupiter]: 3,
  [MARKET_SOURCE.gecko]: 4,
};

const SOURCE_BY_CODE: ReadonlyMap<number, MarketSource> = new Map(
  (Object.entries(MARKET_SOURCE_CODE) as [MarketSource, number][]).map(([source, code]) => [code, source]),
);

/** The vector's code for a source; null when the reading carries none (rows banked before, test doubles). */
export function marketSourceCode(source: string | undefined): number | null {
  return source !== undefined && source in MARKET_SOURCE_CODE
    ? MARKET_SOURCE_CODE[source as MarketSource]
    : null;
}

/** The source a replayed vector's code stands for; undefined for null or a code this build doesn't know. */
export function marketSourceFromCode(code: number | null | undefined): MarketSource | undefined {
  return code === null || code === undefined ? undefined : SOURCE_BY_CODE.get(code);
}
