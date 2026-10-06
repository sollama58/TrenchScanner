import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import { normalizeSocialUrl } from "./tokensage.js";
import type { CandidateToken, WatchlistCandidate } from "../types.js";

const logger = createLogger("dexscreener");

/** Subset of the DexScreener pair shape we actually use. See https://docs.dexscreener.com/api/reference */
interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  /** All four windows ship in every pair response - h24 alone was captured for the first year. */
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  /** Percent change per window, e.g. 12.5 for +12.5%. */
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt?: number;
  info?: {
    /** DexScreener's own hosted copy of the token's logo. Absent for plenty of new mints. */
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

/** Subset of https://api.dexscreener.com/token-profiles/latest/v1 and .../token-boosts/latest/v1 - both share this shape. */
interface DexScreenerDiscoveryEntry {
  chainId: string;
  tokenAddress: string;
  links?: { type?: string; url: string }[];
}

const SOLANA_CHAIN_ID = "solana";
/** DexScreener's batch token lookup caps out at 30 addresses per call. */
const BATCH_SIZE = 30;

export interface DexScreenerClientOptions {
  baseUrl?: string;
}

export class DexScreenerClient {
  private readonly baseUrl: string;

  constructor(options: DexScreenerClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.dexscreener.com";
  }

  /**
   * Looks up current market data for a batch of Solana token mint addresses.
   * Splits into chunks of 30 (the API's per-request limit) and merges results.
   * A token can have multiple pairs (e.g. multiple DEXes); we keep the
   * highest-liquidity pair per mint as the canonical price source.
   */
  async getTokensByAddresses(
    mintAddresses: string[],
    concurrency = 5,
    /**
     * Per-batch timeout and retries (fetchJson's defaults when omitted), and `deadlineMs`: how
     * long the whole lookup may take. Past it, the batches already answered are returned and no
     * more are started; mints are looked up in the order given, so put the important ones first.
     */
    options: {
      timeoutMs?: number;
      retries?: number;
      deadlineMs?: number;
      /**
       * When supplied, records the moment each returned mint's batch answered. A lookup of many
       * batches (the outcome watcher's, up to 2000 rows) spans seconds, more with retries: a
       * caller timing price moves against a window reads the time its price was seen from here
       * rather than stamping the whole lookup at its start or end.
       */
      seenAt?: Map<string, Date>;
      /**
       * When supplied, collects the mints whose batch got no answer (an error, or skipped past
       * the deadline) - so a caller can tell "DexScreener has no pair for this" from "we never
       * heard back", which a missing entry in the result can't.
       */
      failed?: Set<string>;
    } = {},
  ): Promise<CandidateToken[]> {
    const { deadlineMs, seenAt, failed, ...fetchOptions } = options;
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      chunks.push(unique.slice(i, i + BATCH_SIZE));
    }

    // Bounded-concurrency worker pool (same shared helper as RugCheckClient.getProfiles):
    // fetching chunks one at a time made the watchlist refresh step scale linearly with
    // watchlist size - at the default WATCHLIST_MAX_TRACKED that's up to 30 sequential round
    // trips, adding real wall-clock time to every scan cycle. A modest concurrency cap gets most
    // of the speedup without hammering a public, unauthenticated API with 30 simultaneous requests.
    const results: CandidateToken[] = [];
    const deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
    let skipped = 0;
    // Mints whose batch came back, for `failed` - see the note at the return.
    const settled = new Set<string>();
    const work = forEachWithConcurrency(chunks, concurrency, async (chunk) => {
      if (Date.now() >= deadline) {
        skipped += chunk.length;
        for (const mint of chunk) failed?.add(mint);
        return;
      }
      try {
        const pairs = await fetchJson<DexScreenerPair[]>(
          `${this.baseUrl}/tokens/v1/${SOLANA_CHAIN_ID}/${chunk.join(",")}`,
          fetchOptions,
        );
        const answered = new Date();
        for (const mint of chunk) settled.add(mint);
        const tokens = this.selectCanonicalPairs(pairs ?? [], new Set(chunk));
        if (seenAt) for (const t of tokens) seenAt.set(t.mintAddress, answered);
        results.push(...tokens);
      } catch (err) {
        for (const mint of chunk) failed?.add(mint);
        logger.warn("failed to fetch token batch", { chunkSize: chunk.length, error: String(err) });
      }
    });
    if (deadline === Infinity) {
      await work;
      return results;
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
      }),
    ]).finally(() => clearTimeout(timer));
    if (expired || skipped > 0) {
      logger.warn("token lookup past its deadline - returning what answered", {
        answered: results.length,
        requested: unique.length,
        deadlineMs,
      });
    }
    // Batches still in flight past the deadline never reach the caller, so they count as failed.
    if (failed) for (const mint of unique) if (!settled.has(mint)) failed.add(mint);
    // A copy: batches still in flight past the deadline keep pushing into `results`.
    return [...results];
  }

  /**
   * Secondary discovery source, alongside Pump.fun: mints DexScreener itself has recently seen a
   * profile update or a paid boost for. This exists for resilience (Pump.fun's API is unofficial
   * and undocumented - if it changes or blocks us, discovery shouldn't stop entirely) and for
   * coverage (catches tokens that launched directly on a DEX rather than through a pump.fun
   * bonding curve, which the Pump.fun-only discovery path would never see at all).
   *
   * Neither endpoint returns market data or a symbol/name, only the mint address and social
   * links - callers add these to the watchlist bare and let the next cycle's DexScreener batch
   * lookup (getTokensByAddresses) fill in the rest, same as freshly-discovered Pump.fun mints do.
   */
  async discoverTrendingMints(): Promise<WatchlistCandidate[]> {
    const [profiles, boosts] = await Promise.all([
      this.fetchDiscoveryEndpoint("/token-profiles/latest/v1"),
      this.fetchDiscoveryEndpoint("/token-boosts/latest/v1"),
    ]);

    // Boosts are paid placements; which mints bought one is recorded (Token.dexBoosted) so the
    // learner can find out whether a paid boost helps or hurts a call.
    const boosted = new Set(boosts.filter((b) => b.chainId === SOLANA_CHAIN_ID).map((b) => b.tokenAddress));
    const byMint = new Map<string, WatchlistCandidate>();
    for (const entry of [...profiles, ...boosts]) {
      if (entry.chainId !== SOLANA_CHAIN_ID || !entry.tokenAddress) continue;
      const links = entry.links ?? [];
      byMint.set(entry.tokenAddress, {
        mintAddress: entry.tokenAddress,
        hasTwitter: links.some((l) => l.type === "twitter"),
        hasTelegram: links.some((l) => l.type === "telegram"),
        hasWebsite: links.some((l) => !l.type || l.type === "website"),
        twitterUrl: normalizeSocialUrl(links.find((l) => l.type === "twitter")?.url, "twitter") ?? undefined,
        websiteUrl:
          normalizeSocialUrl(links.find((l) => !l.type || l.type === "website")?.url, "website") ?? undefined,
        discoverySource: "dexscreener",
        boosted: boosted.has(entry.tokenAddress),
      });
    }
    return [...byMint.values()];
  }

  private async fetchDiscoveryEndpoint(path: string): Promise<DexScreenerDiscoveryEntry[]> {
    try {
      return await fetchJson<DexScreenerDiscoveryEntry[]>(`${this.baseUrl}${path}`, {
        timeoutMs: 8000,
        retries: 1,
      });
    } catch (err) {
      logger.warn("discovery endpoint failed", { path, error: String(err) });
      return [];
    }
  }

  /** Free-text search, mainly useful for manual lookups / debugging rather than the scan loop. */
  async search(query: string): Promise<CandidateToken[]> {
    try {
      const data = await fetchJson<{ pairs?: DexScreenerPair[] }>(
        `${this.baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`,
      );
      return this.selectCanonicalPairs((data.pairs ?? []).filter((p) => p.chainId === SOLANA_CHAIN_ID));
    } catch (err) {
      logger.warn("search failed", { query, error: String(err) });
      return [];
    }
  }

  /**
   * Collapses multiple pairs-per-mint down to one CandidateToken. When `requested` is given, only
   * pairs whose base token is one of those mints count - DexScreener also returns pairs where a
   * requested mint is the quote token, and those carry the other token's price and mcap.
   */
  private selectCanonicalPairs(pairs: DexScreenerPair[], requested?: Set<string>): CandidateToken[] {
    const byMint = new Map<string, DexScreenerPair[]>();
    for (const pair of pairs) {
      if (pair.chainId !== SOLANA_CHAIN_ID) continue;
      const mint = pair.baseToken?.address;
      if (!mint || (requested && !requested.has(mint))) continue;
      const list = byMint.get(mint);
      if (list) list.push(pair);
      else byMint.set(mint, [pair]);
    }
    return [...byMint.values()].map((list) => toCandidateToken(pickCanonicalPair(list)));
  }
}

/** Below this, a non-curve pool is too thin to be a trustworthy price source. */
const MIN_CANONICAL_POOL_LIQUIDITY_USD = 1000;

/**
 * The pair a mint's market data is read from. A pre-bond Pump.fun curve pair reports no
 * liquidity object at all, so "deepest liquidity" alone let any $1 side pool someone opened for
 * the mint outrank the curve - mispricing it and flipping deriveGraduated to true. So:
 *  - a funded pumpswap pool (Pump.fun's graduation target) means the mint has graduated, and the
 *    deepest real pool is canonical;
 *  - otherwise a curve that is still trading is canonical, whatever side pools exist;
 *  - otherwise (a non-Pump.fun token, or an older Raydium graduation) the deepest real pool,
 *    falling back to the deepest pair of any size.
 */
export function pickCanonicalPair<P extends Pick<DexScreenerPair, "dexId" | "liquidity" | "volume">>(
  pairs: P[],
): P {
  const liq = (p: P) => p.liquidity?.usd ?? 0;
  const deepest = (list: P[]) => list.reduce((best, p) => (liq(p) > liq(best) ? p : best));
  const pools = pairs.filter((p) => p.dexId !== "pumpfun" && liq(p) >= MIN_CANONICAL_POOL_LIQUIDITY_USD);
  if (pools.some((p) => p.dexId === "pumpswap")) return deepest(pools);
  const curve = pairs.find((p) => p.dexId === "pumpfun" && (p.volume?.h1 ?? 0) > 0);
  if (curve) return curve;
  if (pools.length > 0) return deepest(pools);
  // No real pool and a quiet curve: the curve is still where the token lives. Falling through to
  // the deepest pair of any size let a few dollars in a side pool outrank it - pricing the token
  // off that pool and reading it as graduated.
  const quietCurve = pairs.find((p) => p.dexId === "pumpfun");
  return quietCurve ?? deepest(pairs);
}

function toCandidateToken(pair: DexScreenerPair): CandidateToken {
  const socials = pair.info?.socials ?? [];
  return {
    mintAddress: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    pairAddress: pair.pairAddress,
    priceUsd: Number(pair.priceUsd ?? 0),
    marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
    liquidityUsd: pair.liquidity?.usd,
    volume24hUsd: pair.volume?.h24,
    buys24h: pair.txns?.h24?.buys,
    sells24h: pair.txns?.h24?.sells,
    priceChange5mPct: pair.priceChange?.m5,
    priceChange1hPct: pair.priceChange?.h1,
    priceChange6hPct: pair.priceChange?.h6,
    priceChange24hPct: pair.priceChange?.h24,
    volume5mUsd: pair.volume?.m5,
    volume1hUsd: pair.volume?.h1,
    buys5m: pair.txns?.m5?.buys,
    sells5m: pair.txns?.m5?.sells,
    buys1h: pair.txns?.h1?.buys,
    sells1h: pair.txns?.h1?.sells,
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : undefined,
    hasTwitter: socials.some((s) => s.type === "twitter"),
    hasTelegram: socials.some((s) => s.type === "telegram"),
    hasWebsite: (pair.info?.websites?.length ?? 0) > 0,
    imageUrl: pair.info?.imageUrl,
    dexId: pair.dexId,
  };
}

/**
 * Whether a Pump.fun mint has graduated off its bonding curve, derived from which DEX its
 * DexScreener pair currently trades on - the reliable, current signal, unlike Pump.fun's own
 * `complete` flag (only known at discovery time, and discarded well before a mint reaches
 * scoring - see WatchlistCandidate's comment). Confirmed live: a pre-bond mint's pair reports
 * `dexId: "pumpfun"` with no liquidity object at all (the bonding curve isn't a discrete pool);
 * a graduated one reports `dexId: "pumpswap"` (Pump.fun's own AMM, their current graduation
 * target) with real liquidity. Undefined dexId (no pair at all, e.g. a mint DexScreener hasn't
 * indexed) means unknown, not "not graduated" - deliberately not assumed either way.
 */
export function deriveGraduated(dexId: string | undefined): boolean | undefined {
  return dexId === undefined ? undefined : dexId !== "pumpfun";
}
