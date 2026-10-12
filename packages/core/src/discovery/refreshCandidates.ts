import type { DexScreenerClient, TokenLookupOptions } from "../datasources/dexscreener.js";
import type { CandidateToken } from "../types.js";

/** Default widen-the-net factor - see BandFilterOptions.bandPaddingRatio. Exported so anything
 *  that needs to know the true scannable range (e.g. clamping what a user is allowed to set their
 *  own filter's mcapMin/mcapMax to - see scanBand() below) uses the same number this defaults to. */
export const DEFAULT_BAND_PADDING_RATIO = 0.5;

export interface BandFilterOptions {
  mcapMin: number;
  mcapMax: number;
  /** Widen the net beyond the exact band so tokens approaching/leaving it are still tracked across cycles. */
  bandPaddingRatio?: number;
  /** Newest launches, asked of the fallback while DexScreener has no pair - see fallbackIfUnlisted. */
  newestLaunches?: string[];
  /**
   * Young launches priced from a live source instead of DexScreener's reading - see
   * refreshAndFilterToBand. Optional: without it every mint is read from DexScreener alone.
   */
  liveLaunches?: { source: LaunchQuoteSource; mints: string[] };
}

/** Where young launches' live prices come from (JupiterClient.getLaunches). */
export interface LaunchQuoteSource {
  getLaunches(mintAddresses: string[], options?: TokenLookupOptions): Promise<CandidateToken[]>;
}

/**
 * How long the live launch read may take. Jupiter answers a batch in a few hundred milliseconds;
 * past this the refresh goes on with DexScreener's readings, as it did before the read existed.
 */
export const LIVE_LAUNCH_BUDGET_MS = 2_500;

/**
 * The true range of market caps a token could ever be scanned/scored/matched at - the configured
 * $mcapMin-$mcapMax band widened by the same padding refreshAndFilterToBand applies. A token
 * outside this range never gets a snapshot at all (unless it's being actively viewed - see
 * Token.lastViewedAt), so a user's own filter.mcapMin/mcapMax narrower-than-this is meaningful,
 * but wider-than-this can never match anything outside the true range regardless of what the user
 * sets - see UserFilter validation in apps/api/src/routes/filters.ts.
 */
export function scanBand(
  mcapMin: number,
  mcapMax: number,
  bandPaddingRatio: number = DEFAULT_BAND_PADDING_RATIO,
): { min: number; max: number } {
  return { min: mcapMin * (1 - bandPaddingRatio), max: mcapMax * (1 + bandPaddingRatio) };
}

export interface BandRefreshResult {
  /** Candidates currently inside the (padded) target band - what the scan cycle scores. */
  inBand: CandidateToken[];
  /**
   * Every mint DexScreener returned ANY market data for, in or out of band - proof the mint has
   * a real pair (or bonding curve) trading somewhere. The scan job stamps these as
   * Token.lastLiveAt, which is what the watchlist's liveness-prioritized selection runs on.
   */
  liveMints: string[];
  /** The same mints with the market cap each one was just seen at - see Token.lastMcapUsd. */
  liveMarketCaps: { mintAddress: string; marketCapUsd: number }[];
  /**
   * Everything the lookup returned, in band or not. The scan cycle reads its actively-viewed
   * tokens out of this rather than asking DexScreener a second time for mints it just priced.
   */
  marketData: CandidateToken[];
  /**
   * Per mint in `marketData`, when its reading was taken (its batch's answer, or the cached
   * reading's own time). A live figure or a call's peak written from these must carry this time,
   * not the moment the write landed: up to the 10 s deadline plus 10 s of cache reuse later.
   */
  seenAt: Map<string, Date>;
  /**
   * True when at least one requested mint got no answer - its batch failed or was still in
   * flight at the deadline. `inBand` is then a subset of what the band holds, and a caller that
   * treats one refresh as "every in-band token was looked at" (the settling-in pass of a newly
   * armed filter - see markFilterPassComplete) must not.
   */
  partial: boolean;
}

/**
 * Refreshes live market data for a set of already-known mint addresses (the
 * persistent watchlist - see PumpFunClient.discoverNewMints for how new
 * mints get added to it) and filters down to the target mcap band. This
 * does not discover anything new; it only re-checks mints we already know
 * about, which is what actually catches a token as it climbs into the band
 * between scan cycles.
 */
export async function refreshAndFilterToBand(
  dexScreener: DexScreenerClient,
  mintAddresses: string[],
  options: BandFilterOptions,
): Promise<BandRefreshResult> {
  if (mintAddresses.length === 0) {
    return {
      inBand: [],
      liveMints: [],
      liveMarketCaps: [],
      marketData: [],
      seenAt: new Map(),
      partial: false,
    };
  }

  const { mcapMin, mcapMax, bandPaddingRatio, newestLaunches, liveLaunches } = options;
  const { min: lowerBound, max: upperBound } = scanBand(mcapMin, mcapMax, bandPaddingRatio);

  // Young launches are read live first. DexScreener lists a new Pump.fun launch 30-50 s after
  // Jupiter prices it, and once listed its market cap still trails Jupiter's by about as much
  // (2026-10-12 probe of every launch under 8 minutes old: DexScreener showed a launch past $10k a
  // median 32 s after Jupiter and Pump.fun did, and its cap best matched Jupiter's from ~45-50 s
  // earlier). Most launch runs that double cross $10k inside their first two minutes, so on
  // DexScreener's figures alone a launch reached the band - and the Stream and the models - at
  // $12-15k or more, a minute or more after it crossed $10k.
  const live = new Map<string, { token: CandidateToken; at: Date }>();
  if (liveLaunches && liveLaunches.mints.length > 0) {
    const liveSeenAt = new Map<string, Date>();
    const read = await liveLaunches.source
      .getLaunches(liveLaunches.mints, {
        timeoutMs: LIVE_LAUNCH_BUDGET_MS,
        retries: 0,
        deadlineMs: LIVE_LAUNCH_BUDGET_MS,
        seenAt: liveSeenAt,
      })
      .catch(() => [] as CandidateToken[]);
    const now = new Date();
    for (const token of read)
      live.set(token.mintAddress, { token, at: liveSeenAt.get(token.mintAddress) ?? now });
  }

  // Tighter than fetchJson's defaults (10s, two retries), which let one slow batch hold the whole
  // scan cycle for half a minute or more - 47s on 2026-10-04 - when a batch normally answers in
  // well under a second. A batch given up on costs its mints one cycle's reading, and the next
  // cycle is seconds away. The deadline bounds the whole refresh the same way: on 2026-10-04 a
  // throttled DexScreener still held cycles for 20-50s at five seconds a batch. Callers pass the
  // mints that matter most first (selectWatchlist puts the near-band tier ahead).
  const failed = new Set<string>();
  const seenAt = new Map<string, Date>();
  const marketData = await dexScreener.getTokensByAddresses(mintAddresses, 5, {
    timeoutMs: 5000,
    retries: 1,
    deadlineMs: 10_000,
    // What puts a coin in front of the safety screen: first call on a fallback's budget.
    priority: true,
    failed,
    seenAt,
    // A launch the live read priced needs no GeckoTerminal call: that budget stays for the rest.
    fallbackIfUnlisted: newestLaunches?.filter((m) => !live.has(m)),
  });
  if (live.size > 0) mergeLiveLaunches(marketData, live, seenAt);
  return {
    partial: failed.size > 0,
    inBand: marketData.filter((t) => t.marketCapUsd >= lowerBound && t.marketCapUsd <= upperBound),
    liveMints: marketData.map((t) => t.mintAddress),
    // A pair with no market cap (or fdv) reads as 0; stamped, that would drop a live mint out of
    // the near-band tier selection ranks on.
    liveMarketCaps: marketData
      .filter((t) => t.marketCapUsd > 0)
      .map((t) => ({ mintAddress: t.mintAddress, marketCapUsd: t.marketCapUsd })),
    marketData,
    seenAt,
  };
}

/**
 * Puts the live launch readings into DexScreener's answer, in place. A launch DexScreener has
 * listed keeps its pair (activity counts, venue, pair age, socials) with the live price and market
 * cap: the band is decided on where the coin is now. One it has not listed yet is the live
 * reading itself. Each carries the live reading's time.
 */
function mergeLiveLaunches(
  marketData: CandidateToken[],
  live: Map<string, { token: CandidateToken; at: Date }>,
  seenAt: Map<string, Date>,
): void {
  const listed = new Set<string>();
  for (let i = 0; i < marketData.length; i++) {
    const pair = marketData[i]!;
    const reading = live.get(pair.mintAddress);
    if (!reading) continue;
    listed.add(pair.mintAddress);
    marketData[i] = { ...pair, priceUsd: reading.token.priceUsd, marketCapUsd: reading.token.marketCapUsd };
    seenAt.set(pair.mintAddress, reading.at);
  }
  for (const [mint, reading] of live) {
    if (listed.has(mint)) continue;
    marketData.push({ ...reading.token });
    seenAt.set(mint, reading.at);
  }
}
