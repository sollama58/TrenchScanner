import {
  isCurveVenue,
  isLaunchHomeCurve,
  normalizeLaunchpad,
  PUMPFUN_LAUNCHPAD,
  SCANNED_LAUNCHPADS,
  STONKS_LAUNCHPAD,
} from "../launchpads.js";
import { MARKET_SOURCE } from "../marketSource.js";
import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import { RateGate, RateGateDeadlineError, type RateGateStats } from "./rateGate.js";
import { canonicalPairCreatedAt, type DexScreenerClient, type TokenLookupOptions } from "./dexscreener.js";
import type { CandidateToken, FreshQuote, FreshQuoteStats } from "../types.js";
import type { DiscoveredCoin } from "./pumpfun.js";

const logger = createLogger("jupiter");

/** Subset of a Jupiter Tokens API v2 MintInformation (GET /tokens/v2/search). */
interface JupiterStats {
  priceChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
  numBuys?: number | null;
  numSells?: number | null;
  numTraders?: number | null;
  numNetBuyers?: number | null;
  holderChange?: number | null;
}

interface JupiterToken {
  id?: string;
  name?: string;
  symbol?: string;
  usdPrice?: number | null;
  mcap?: number | null;
  fdv?: number | null;
  liquidity?: number | null;
  stats5m?: JupiterStats | null;
  stats1h?: JupiterStats | null;
  stats6h?: JupiterStats | null;
  stats24h?: JupiterStats | null;
  updatedAt?: string | null;
  /** The launchpad the mint was created on ("pump.fun", ...). */
  launchpad?: string | null;
  /** The pool a launchpad coin moved to when its curve filled; absent while on the curve. */
  graduatedPool?: string | null;
  /** When it did. */
  graduatedAt?: string | null;
  /**
   * The mint's first pool. For a Pump.fun coin still on its curve this is the bonding curve,
   * opened at launch. It is not the pool clock once the coin has graduated, and it is not used
   * when it is some other pool.
   */
  firstPool?: { id?: string; createdAt?: string | null } | null;
  holderCount?: number | null;
  icon?: string | null;
}

/** The search endpoint takes up to 100 comma-separated mints a call. */
const BATCH_SIZE = 100;
/**
 * Credits one /tokens/v2/search call costs on a paid plan, however many mints it carries
 * (developers.jup.ag/docs/portal/plans, checked 2026-10-15). The free plan has no credit cap.
 */
export const JUPITER_SEARCH_CREDITS = 10;
/** The Developer plan's monthly credits (25M) and requests a second (10). */
export const DEFAULT_JUPITER_MONTHLY_CREDITS = 25_000_000;
/** Below the plan's 10 a second, so a burst never meets the cap. */
export const DEFAULT_JUPITER_REQUESTS_PER_SECOND = 8;
/** Of the monthly credits, the share the gate plans to spend: the rest is room for a long month. */
const CREDIT_HEADROOM = 0.9;
const MINUTES_IN_LONGEST_MONTH = 31 * 24 * 60;

/**
 * Sustained search calls a minute that fit the plan. On a paid plan the credits bind long before
 * the rate does: 25M credits at 10 a search is about 58 calls a minute over a 31-day month, where
 * 10 a second would be 600 (and ~260M credits). Overage is billed rather than refused, so the gate
 * holds to the credits; 90% of them leaves 50 a minute. `monthlyCredits` 0 means no credit cap
 * (the free plan), and the rate alone decides, also at 90%. Never below 1.
 */
export function jupiterRequestsPerMinute(monthlyCredits: number, requestsPerSecond: number): number {
  const byRate = Math.floor(requestsPerSecond * 60 * CREDIT_HEADROOM);
  if (monthlyCredits <= 0) return Math.max(1, byRate);
  const byCredits = Math.floor(
    (monthlyCredits * CREDIT_HEADROOM) / JUPITER_SEARCH_CREDITS / MINUTES_IN_LONGEST_MONTH,
  );
  return Math.max(1, Math.min(byRate, byCredits));
}

/** The gate's default: the Developer plan, at its defaults. */
export const DEFAULT_JUPITER_REQUESTS_PER_MINUTE = jupiterRequestsPerMinute(
  DEFAULT_JUPITER_MONTHLY_CREDITS,
  DEFAULT_JUPITER_REQUESTS_PER_SECOND,
);
/**
 * Of a burst, the slots only the scan's own reads (`priority`: the band refresh's launch prices
 * and the decision's fresh quotes) may take: half, at least 2. The outcome watcher, wallet
 * valuation and the entry watch share this budget, and on 2026-10-13 a cycle's fresh quotes
 * queued up to 2.5 s behind them - every decision in that cycle waiting with them.
 */
export function jupiterPriorityReserve(burst: number): number {
  return Math.max(2, Math.floor(burst / 2));
}

export interface JupiterClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Sustained calls a minute (see jupiterRequestsPerMinute). */
  requestsPerMinute?: number;
  /**
   * Calls that may go out back to back: the plan's requests a second, less headroom. A cycle's
   * reads go out together this many at a time rather than one per sustained interval.
   */
  burst?: number;
  /**
   * Keep a Meteora DBC or Raydium LaunchLab curve's age. Off, those launchpads have no dex id
   * here, which is what shipped.
   */
  launchHomeClock?: boolean;
}

/**
 * Prices from Jupiter's Tokens API, in DexScreener's CandidateToken shape - only the fields the
 * price-only callers read (price, market cap, liquidity, 24h volume and counts).
 *
 * It exists to take load off DexScreener's per-IP budget (2026-10-08: the scan's refresh spent
 * 6.5-10 s of every cycle queued behind the other jobs, and half the cycles ended at it with
 * nothing in band). Jupiter answers 100 mints a call against DexScreener's 30, on a per-account
 * limit rather than a per-IP one that other Render tenants share.
 */
export class JupiterClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly gate: RateGate;
  private readonly launchHomeClock: boolean;
  private lastMovingAt = Number.NEGATIVE_INFINITY;

  constructor(options: JupiterClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.jup.ag";
    this.launchHomeClock = options.launchHomeClock === true;
    this.headers = { accept: "application/json", "x-api-key": options.apiKey };
    const burst = Math.max(1, Math.floor(options.burst ?? DEFAULT_JUPITER_REQUESTS_PER_SECOND));
    this.gate = new RateGate({
      name: "jupiter",
      perMinute: options.requestsPerMinute ?? DEFAULT_JUPITER_REQUESTS_PER_MINUTE,
      burst,
      reserve: jupiterPriorityReserve(burst),
      // The plan's limit is per second: a 429 waits that second out before anything else goes.
      minPauseMs: 1_000,
    });
  }

  /**
   * Pump.fun coins moving right now, from Jupiter's own lists: the most traded and trending of
   * the last five minutes, and the newest pools. A discovery source that does not depend on
   * Pump.fun's API, whose coin list (newest and recently traded) has answered every page with a
   * Cloudflare challenge since 2026-10-14 about 21:00 UTC: without either, a coin that started
   * climbing again hours after launch was never put back in front of the scan. Each coin carries
   * its market cap on Pump.fun's 1B supply, as the band refresh reads it.
   *
   * Asked at most once every `minIntervalMs` (the lists move by the minute, and the calls share
   * the scan's Jupiter budget); a call inside it, or one the budget can't fit before `deadlineMs`,
   * returns nothing. A failed list is skipped; the others still count.
   */
  async discoverMovingLaunches(
    options: { deadlineMs?: number; minIntervalMs?: number; now?: number } = {},
  ): Promise<DiscoveredCoin[]> {
    const now = options.now ?? Date.now();
    if (now - this.lastMovingAt < (options.minIntervalMs ?? 60_000)) return [];
    this.lastMovingAt = now;
    const deadline = Date.now() + (options.deadlineMs ?? 4_000);
    const gate = {
      acquire: () => this.gate.acquire(deadline, false),
      throttled: (delayMs: number) => this.gate.throttled(delayMs),
    };
    const paths = ["toptraded/5m?limit=100", "toptrending/5m?limit=100", "recent"];
    const lists = await Promise.allSettled(
      paths.map((path) =>
        fetchJson<unknown>(`${this.baseUrl}/tokens/v2/${path}`, {
          gate,
          headers: this.headers,
          timeoutMs: Math.max(500, deadline - Date.now()),
          retries: 0,
        }),
      ),
    );
    const out = new Map<string, DiscoveredCoin>();
    lists.forEach((result, i) => {
      if (result.status === "rejected") {
        if (!(result.reason instanceof RateGateDeadlineError)) {
          logger.warn("moving-coins list failed", { list: paths[i], error: String(result.reason) });
        }
        return;
      }
      for (const coin of parseJupiterMovingLaunches(result.value)) out.set(coin.mintAddress, coin);
    });
    return [...out.values()];
  }

  /**
   * Jupiter's newest Pump.fun pools alone (the `recent` list of discoverMovingLaunches), for the
   * launch poller (apps/worker discovery/jupiterLaunchPoller.ts), through the same gate as every other call. The list holds the last 30 pools
   * on any launchpad, about half a minute of Pump.fun launches, so read once a minute it showed
   * half of them; PumpPortal's create feed is missing about 45% of launches (2026-10-15: 95 of 210
   * in four minutes, SOL- and coin-paired alike), so the rest were never discovered at all.
   */
  async recentLaunches(options: { deadlineMs?: number } = {}): Promise<DiscoveredCoin[]> {
    const deadline = Date.now() + (options.deadlineMs ?? 4_000);
    const body = await fetchJson<unknown>(`${this.baseUrl}/tokens/v2/recent`, {
      gate: {
        acquire: () => this.gate.acquire(deadline, false),
        throttled: (delayMs: number) => this.gate.throttled(delayMs),
      },
      headers: this.headers,
      timeoutMs: Math.max(500, deadline - Date.now()),
      retries: 0,
    });
    return parseJupiterMovingLaunches(body);
  }

  /** Calls sent, 429 pauses and time spent queued since the last call, then reset. */
  takeCallStats(): RateGateStats {
    return this.gate.takeStats();
  }

  /** Same contract as DexScreenerClient.getTokensByAddresses (deadline, seenAt, failed). */
  async getTokensByAddresses(
    mintAddresses: string[],
    concurrency = 2,
    options: TokenLookupOptions = {},
  ): Promise<CandidateToken[]> {
    const { seenAt, freshSources: _fresh, ...rest } = options;
    const found = await this.search(mintAddresses, concurrency, rest, parseJupiterTokens);
    if (seenAt) for (const { token, answered } of found) seenAt.set(token.mintAddress, answered);
    return found.map((f) => f.token);
  }

  /**
   * The newest launches priced the way the scan's band refresh reads DexScreener (see
   * parseJupiterLaunches), for the ones DexScreener has not listed yet. Same contract as
   * getTokensByAddresses (deadline, seenAt, failed).
   */
  async getLaunches(mintAddresses: string[], options: TokenLookupOptions = {}): Promise<CandidateToken[]> {
    const { seenAt, freshSources: _fresh, ...rest } = options;
    const found = await this.search(mintAddresses, 2, rest, (body, requested) =>
      parseJupiterLaunches(body, requested, this.launchHomeClock),
    );
    if (seenAt) for (const { token, answered } of found) seenAt.set(token.mintAddress, answered);
    return found.map((f) => f.token);
  }

  /**
   * Seconds-old prices and the last minutes' activity for the coins a scan is about to decide on
   * (ScoredToken.freshQuote). Mints Jupiter didn't answer, or answered without a price, are left
   * out; past the deadline the lookup gives what it has.
   */
  async getFreshQuotes(
    mintAddresses: string[],
    options: { deadlineMs?: number; concurrency?: number } = {},
  ): Promise<Map<string, FreshQuote>> {
    const found = await this.search(
      mintAddresses,
      options.concurrency ?? 3,
      { deadlineMs: options.deadlineMs, timeoutMs: options.deadlineMs, retries: 0, priority: true },
      (body, requested) => parseJupiterQuotes(body, requested),
    );
    return new Map(
      found.map(({ token, answered }) => [token.mintAddress, { ...token.quote, fetchedAt: answered }]),
    );
  }

  private async search<T>(
    mintAddresses: string[],
    concurrency: number,
    options: Omit<TokenLookupOptions, "seenAt">,
    parse: (body: unknown, requested: Set<string>) => T[],
  ): Promise<{ token: T; answered: Date }[]> {
    const { deadlineMs, failed, priority, mayBeUnindexed: _unindexed, ...fetchOptions } = options;
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) chunks.push(unique.slice(i, i + BATCH_SIZE));

    const deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
    const gate = {
      acquire: () => this.gate.acquire(deadline, priority === true),
      throttled: (delayMs: number) => this.gate.throttled(delayMs),
    };
    const results: { token: T; answered: Date }[] = [];
    const settled = new Set<string>();
    const work = forEachWithConcurrency(chunks, concurrency, async (chunk) => {
      if (Date.now() >= deadline) return;
      try {
        const body = await fetchJson<JupiterToken[]>(
          `${this.baseUrl}/tokens/v2/search?query=${chunk.join(",")}`,
          { ...fetchOptions, gate, headers: this.headers },
        );
        const answered = new Date();
        // Late answers are dropped: the caller has moved on, and a later read must not be fed
        // something it never waited for.
        if (Date.now() > deadline) return;
        for (const mint of chunk) settled.add(mint);
        for (const token of parse(body, new Set(chunk))) results.push({ token, answered });
      } catch (err) {
        if (err instanceof RateGateDeadlineError) return;
        logger.warn("failed to fetch token batch", { chunkSize: chunk.length, error: String(err) });
      }
    });
    if (deadline !== Infinity) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
    } else {
      await work;
    }
    if (failed) for (const mint of unique) if (!settled.has(mint)) failed.add(mint);
    return [...results];
  }
}

const finite = (v: number | null | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** A missing or zero cap is not a cap. Zero must not hide a real fdv. */
const positive = (v: number | null | undefined): number | undefined => {
  const n = finite(v);
  return n !== undefined && n > 0 ? n : undefined;
};

/** A two-sided total only when both sides were reported. One missing side is not zero. */
const sumBoth = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined || b === undefined ? undefined : a + b;

/**
 * Exported for tests. The launches in one of Jupiter's lists from a launchpad the scan takes
 * (SCANNED_LAUNCHPADS: Pump.fun and Stonks), as discovered coins: no description or socials (the
 * lists carry none - left unknown, not "none"), the market cap on the coin's supply now
 * (Jupiter's fdv, after burns).
 */
export function parseJupiterMovingLaunches(body: unknown): DiscoveredCoin[] {
  if (!Array.isArray(body)) return [];
  const out: DiscoveredCoin[] = [];
  for (const t of body as JupiterToken[]) {
    const launchpad = normalizeLaunchpad(t?.launchpad);
    if (!t || typeof t.id !== "string" || !launchpad || !SCANNED_LAUNCHPADS.has(launchpad)) continue;
    const priceUsd = finite(t.usdPrice);
    const created = t.firstPool?.createdAt ? new Date(t.firstPool.createdAt) : undefined;
    out.push({
      mintAddress: t.id,
      symbol: typeof t.symbol === "string" ? t.symbol.slice(0, 40) : undefined,
      name: typeof t.name === "string" ? t.name.slice(0, 120) : undefined,
      imageUrl:
        typeof t.icon === "string" && t.icon.startsWith("https://") ? t.icon.slice(0, 500) : undefined,
      createdAt:
        created && !Number.isNaN(created.getTime()) && created.getTime() <= Date.now() + 60_000
          ? created
          : undefined,
      graduated: Boolean(t.graduatedPool || t.graduatedAt),
      // On the coin's supply now (fdv: its price on the mint's supply, after burns - mintSupply.ts).
      marketCapUsd:
        priceUsd === undefined || priceUsd <= 0 ? undefined : (positive(t.fdv) ?? positive(t.mcap)),
      launchpad,
      // No socials on the list: left undefined (unknown), never false. The scan stored a false
      // here until 2026-10-16 and the models read "0 = unread" as a signal (data audit).
    });
  }
  return out;
}

/** Exported for tests. Only the requested mints, each once. */
export function parseJupiterTokens(body: unknown, requested: Set<string>): CandidateToken[] {
  if (!Array.isArray(body)) return [];
  const out = new Map<string, CandidateToken>();
  for (const t of body as JupiterToken[]) {
    if (!t || typeof t.id !== "string" || !requested.has(t.id) || out.has(t.id)) continue;
    const stats = t.stats24h ?? undefined;
    const buyVolume = finite(stats?.buyVolume);
    const sellVolume = finite(stats?.sellVolume);
    out.set(t.id, {
      mintAddress: t.id,
      symbol: t.symbol,
      name: t.name,
      // No price reads as 0, the same "no price" DexScreener's parser gives a pair without one.
      priceUsd: finite(t.usdPrice) ?? 0,
      marketCapUsd: positive(t.mcap) ?? positive(t.fdv) ?? 0,
      // Jupiter's liquidity reads about half of DexScreener's for the same pools (2026-10-08: 0.47
      // to 0.50 of it on four pumpswap pools), one side of the pool where DexScreener counts both.
      // Doubled, so the empty-wallet check's cap (half the liquidity) means what it always has.
      liquidityUsd: finite(t.liquidity) === undefined ? undefined : finite(t.liquidity)! * 2,
      volume24hUsd: sumBoth(buyVolume, sellVolume),
      buys24h: finite(stats?.numBuys),
      sells24h: finite(stats?.numSells),
      priceChange24hPct: finite(stats?.priceChange),
      marketSource: MARKET_SOURCE.jupiter,
    });
  }
  return [...out.values()];
}

/**
 * DexScreener's venue id for a Jupiter launchpad. Pump.fun and Stonks as before. Meteora DBC
 * (`met-dbc`) and Raydium LaunchLab stay on their curve until Jupiter reports a graduated pool;
 * LaunchLab then moves to Raydium, and a graduated DBC has no dex id of its own here.
 */
function dexIdForLaunch(
  launchpad: string | undefined,
  graduated: boolean,
  launchHomeClock: boolean,
): string | undefined {
  if (launchpad === PUMPFUN_LAUNCHPAD) return graduated ? "pumpswap" : "pumpfun";
  if (launchpad === STONKS_LAUNCHPAD) return graduated ? "raydium" : "stonkfun";
  if (!launchHomeClock) return undefined;
  if (launchpad === "met-dbc" || launchpad === "meteora-dbc" || launchpad === "meteoradbc") {
    return graduated ? undefined : "meteoradbc";
  }
  if (launchpad === "raydium-launchlab" || launchpad === "launchlab") {
    return graduated ? "raydium" : "launchlab";
  }
  return undefined;
}

/**
 * Exported for tests. A launch as the scan's band refresh reads a DexScreener pair: price, cap and
 * the 5m/1h/24h activity, the venue and when its first pool opened. Only the requested mints, each
 * once, and only with a positive price and market cap: a launch nobody has traded yet has neither,
 * and the refresh has nothing to place in or out of the band.
 *
 * The venue is DexScreener's spelling, which the safety screen and graduation logic read: a
 * Pump.fun coin is "pumpfun" (still on its bonding curve) until it has a graduated pool, then
 * "pumpswap". A curve's liquidity is left unset, as DexScreener and GeckoTerminal leave it, so a
 * coin reads the same whichever of them priced it.
 */
export function parseJupiterLaunches(
  body: unknown,
  requested: Set<string>,
  launchHomeClock = false,
): CandidateToken[] {
  if (!Array.isArray(body)) return [];
  const out = new Map<string, CandidateToken>();
  for (const t of body as JupiterToken[]) {
    if (!t || typeof t.id !== "string" || !requested.has(t.id) || out.has(t.id)) continue;
    const priceUsd = finite(t.usdPrice);
    const launchpad = normalizeLaunchpad(t.launchpad);
    // On the coin's supply now, after burns, as DexScreener counts it too (mintSupply.ts): fdv is
    // the price on the mint's whole supply, which burns take out of.
    const marketCapUsd = positive(t.fdv) ?? positive(t.mcap);
    if (priceUsd === undefined || priceUsd <= 0 || marketCapUsd === undefined || marketCapUsd <= 0) continue;
    // A Stonks coin's LaunchLab curve is "stonkfun" (GeckoTerminal's name: DexScreener lists no
    // curve), and it graduates into a Raydium pool. Meteora DBC and Raydium LaunchLab are the
    // same kind of home: on the curve their created time is the pair clock, and a graduated
    // LaunchLab coin moves to Raydium. A graduated DBC's AMM shares Jupiter's lack of a dex id
    // with every other pool, so that clock stays unknown rather than trusting a side pool.
    const dexId = dexIdForLaunch(launchpad, Boolean(t.graduatedPool), launchHomeClock);
    const liquidity = finite(t.liquidity);
    // On the curve the canonical pair is the bonding curve (firstPool, opened at launch). Once
    // graduated, the pair we price is the graduation pool, whose created time is graduatedAt.
    // firstPool is then a different pair — the curve, or a junk pool opened beside it — and must
    // not keep the clock. A graduate with no graduation time has an unknown pool age.
    const curveAt = t.firstPool?.createdAt ? new Date(t.firstPool.createdAt) : undefined;
    const graduatedAt = t.graduatedPool && t.graduatedAt ? new Date(t.graduatedAt) : undefined;
    const onCurve = launchHomeClock ? isLaunchHomeCurve(dexId) : isCurveVenue(dexId);
    const pairCreatedAt = canonicalPairCreatedAt(dexId, onCurve ? curveAt : graduatedAt, launchHomeClock);
    const m5 = t.stats5m ?? undefined;
    const h1 = t.stats1h ?? undefined;
    const h24 = t.stats24h ?? undefined;
    out.set(t.id, {
      mintAddress: t.id,
      symbol: t.symbol,
      name: t.name,
      priceUsd,
      marketCapUsd,
      // Doubled, as parseJupiterTokens does: Jupiter counts one side of the pool.
      liquidityUsd: isCurveVenue(dexId) || liquidity === undefined ? undefined : liquidity * 2,
      volume24hUsd: sumBoth(finite(h24?.buyVolume), finite(h24?.sellVolume)),
      buys24h: finite(h24?.numBuys),
      sells24h: finite(h24?.numSells),
      priceChange5mPct: finite(m5?.priceChange),
      priceChange1hPct: finite(h1?.priceChange),
      priceChange6hPct: finite(t.stats6h?.priceChange),
      priceChange24hPct: finite(h24?.priceChange),
      volume5mUsd: sumBoth(finite(m5?.buyVolume), finite(m5?.sellVolume)),
      volume1hUsd: sumBoth(finite(h1?.buyVolume), finite(h1?.sellVolume)),
      buys5m: finite(m5?.numBuys),
      sells5m: finite(m5?.numSells),
      buys1h: finite(h1?.numBuys),
      sells1h: finite(h1?.numSells),
      pairCreatedAt,
      dexId,
      graduatedAt: graduatedAt && !Number.isNaN(graduatedAt.getTime()) ? graduatedAt : undefined,
      launchpad,
      marketSource: MARKET_SOURCE.jupiter,
    });
  }
  return [...out.values()];
}

function parseStats(stats: JupiterStats | null | undefined): FreshQuoteStats | undefined {
  if (!stats) return undefined;
  return {
    priceChangePct: finite(stats.priceChange),
    buyVolumeUsd: finite(stats.buyVolume),
    sellVolumeUsd: finite(stats.sellVolume),
    buys: finite(stats.numBuys),
    sells: finite(stats.numSells),
    traders: finite(stats.numTraders),
    netBuyers: finite(stats.numNetBuyers),
    holderChange: finite(stats.holderChange),
  };
}

/**
 * Exported for tests. Only the requested mints, each once, and only with a positive price and
 * market cap: a quote without them anchors nothing.
 */
export function parseJupiterQuotes(
  body: unknown,
  requested: Set<string>,
): { mintAddress: string; quote: Omit<FreshQuote, "fetchedAt"> }[] {
  if (!Array.isArray(body)) return [];
  const out = new Map<string, { mintAddress: string; quote: Omit<FreshQuote, "fetchedAt"> }>();
  for (const t of body as JupiterToken[]) {
    if (!t || typeof t.id !== "string" || !requested.has(t.id) || out.has(t.id)) continue;
    const priceUsd = finite(t.usdPrice);
    const marketCapUsd = positive(t.mcap) ?? positive(t.fdv);
    if (priceUsd === undefined || priceUsd <= 0 || marketCapUsd === undefined || marketCapUsd <= 0) continue;
    const updatedAt = typeof t.updatedAt === "string" ? new Date(t.updatedAt) : undefined;
    out.set(t.id, {
      mintAddress: t.id,
      quote: {
        priceUsd,
        marketCapUsd,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
        stats5m: parseStats(t.stats5m),
        stats1h: parseStats(t.stats1h),
        holderCount: finite(t.holderCount),
      },
    });
  }
  return [...out.values()];
}

/**
 * Price lookups for the jobs that only need a price (the outcome watcher, the empty-wallet
 * valuation): Jupiter first, DexScreener for what it didn't answer, so DexScreener's per-IP budget
 * is left to the scan and fast-match, whose model inputs are DexScreener's numbers.
 *
 * DexScreener is asked again for every mint Jupiter's batch never answered, and - unless the
 * lookup says its mints may be unindexed (a holder's airdrops and dead coins, which DexScreener
 * won't know either) - for every mint Jupiter answered without a token.
 */
export class JupiterFirstLookup {
  constructor(
    private readonly jupiter: Pick<JupiterClient, "getTokensByAddresses">,
    private readonly dexScreener: Pick<DexScreenerClient, "getTokensByAddresses">,
  ) {}

  async getTokensByAddresses(
    mintAddresses: string[],
    concurrency?: number,
    options: TokenLookupOptions = {},
  ): Promise<CandidateToken[]> {
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];
    const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs;
    const jupiterFailed = new Set<string>();
    const found = await this.jupiter.getTokensByAddresses(unique, 2, {
      ...options,
      failed: jupiterFailed,
    });
    const priced = new Set(found.filter((t) => t.priceUsd > 0).map((t) => t.mintAddress));
    if (options.freshSources) for (const mint of priced) options.freshSources.add(mint);
    const rest = unique.filter(
      (mint) => jupiterFailed.has(mint) || (!options.mayBeUnindexed && !priced.has(mint)),
    );
    // Jupiter's misses that DexScreener is not asked about: left out of the answer, and said so.
    // A token Jupiter answered without a price was answered (no route to price it on).
    if (options.unasked && options.mayBeUnindexed) {
      const answered = new Set(found.map((t) => t.mintAddress));
      for (const mint of unique) {
        if (!answered.has(mint) && !jupiterFailed.has(mint)) options.unasked.add(mint);
      }
    }
    if (rest.length === 0) return found;
    const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      if (options.failed) for (const mint of jupiterFailed) options.failed.add(mint);
      return found;
    }
    const fromDex = await this.dexScreener.getTokensByAddresses(rest, concurrency, {
      ...options,
      deadlineMs: remaining,
    });
    const byMint = new Map(found.map((t) => [t.mintAddress, t]));
    for (const t of fromDex) if (!priced.has(t.mintAddress)) byMint.set(t.mintAddress, t);
    return [...byMint.values()];
  }
}
