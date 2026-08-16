import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import type { CandidateToken } from "../types.js";

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
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
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
  async getTokensByAddresses(mintAddresses: string[]): Promise<CandidateToken[]> {
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      chunks.push(unique.slice(i, i + BATCH_SIZE));
    }

    const results: CandidateToken[] = [];
    for (const chunk of chunks) {
      try {
        const pairs = await fetchJson<DexScreenerPair[]>(
          `${this.baseUrl}/tokens/v1/${SOLANA_CHAIN_ID}/${chunk.join(",")}`,
        );
        results.push(...this.selectCanonicalPairs(pairs ?? []));
      } catch (err) {
        logger.warn("failed to fetch token batch", { chunkSize: chunk.length, error: String(err) });
      }
    }
    return results;
  }

  /** Free-text search, mainly useful for manual lookups / debugging rather than the scan loop. */
  async search(query: string): Promise<CandidateToken[]> {
    try {
      const data = await fetchJson<{ pairs?: DexScreenerPair[] }>(
        `${this.baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`,
      );
      return this.selectCanonicalPairs(
        (data.pairs ?? []).filter((p) => p.chainId === SOLANA_CHAIN_ID),
      );
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
  };
}
