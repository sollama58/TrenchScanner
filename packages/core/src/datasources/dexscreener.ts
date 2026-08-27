import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
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
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
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
  async getTokensByAddresses(mintAddresses: string[], concurrency = 5): Promise<CandidateToken[]> {
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
    await forEachWithConcurrency(chunks, concurrency, async (chunk) => {
      try {
        const pairs = await fetchJson<DexScreenerPair[]>(
          `${this.baseUrl}/tokens/v1/${SOLANA_CHAIN_ID}/${chunk.join(",")}`,
        );
        results.push(...this.selectCanonicalPairs(pairs ?? []));
      } catch (err) {
        logger.warn("failed to fetch token batch", { chunkSize: chunk.length, error: String(err) });
      }
    });
    return results;
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

    const byMint = new Map<string, WatchlistCandidate>();
    for (const entry of [...profiles, ...boosts]) {
      if (entry.chainId !== SOLANA_CHAIN_ID || !entry.tokenAddress) continue;
      const links = entry.links ?? [];
      byMint.set(entry.tokenAddress, {
        mintAddress: entry.tokenAddress,
        hasTwitter: links.some((l) => l.type === "twitter"),
        hasTelegram: links.some((l) => l.type === "telegram"),
        hasWebsite: links.some((l) => !l.type || l.type === "website"),
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

  /** Collapses multiple pairs-per-mint down to one CandidateToken, preferring the deepest liquidity pair. */
  private selectCanonicalPairs(pairs: DexScreenerPair[]): CandidateToken[] {
    const bestByMint = new Map<string, DexScreenerPair>();
    for (const pair of pairs) {
      if (pair.chainId !== SOLANA_CHAIN_ID) continue;
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const existing = bestByMint.get(mint);
      const liq = pair.liquidity?.usd ?? 0;
      if (!existing || liq > (existing.liquidity?.usd ?? 0)) {
        bestByMint.set(mint, pair);
      }
    }

    return [...bestByMint.values()].map(toCandidateToken);
  }
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
