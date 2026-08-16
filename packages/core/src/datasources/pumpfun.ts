import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";

const logger = createLogger("pumpfun");

/**
 * Pump.fun's frontend API is unofficial/undocumented (no public API contract),
 * used here purely for *discovery* - finding candidate mint addresses to feed
 * into DexScreener + rug screening. Field names come from observed responses
 * and may drift if pump.fun changes their frontend; every call here is
 * wrapped so a failure just yields fewer discovered candidates, never a crash.
 */
interface PumpFunCoin {
  mint: string;
  name?: string;
  symbol?: string;
  description?: string;
  created_timestamp?: number; // epoch ms
  complete?: boolean; // true once the bonding curve has graduated to an AMM pool
  usd_market_cap?: number;
  market_cap_usd?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface DiscoveredCoin {
  mintAddress: string;
  symbol?: string;
  name?: string;
  description?: string;
  createdAt?: Date;
  graduated: boolean;
  marketCapUsd?: number;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
}

export interface PumpFunClientOptions {
  baseUrl?: string;
}

type SortField = "market_cap" | "created_timestamp";
type SortOrder = "ASC" | "DESC";

export class PumpFunClient {
  private readonly baseUrl: string;

  constructor(options: PumpFunClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://frontend-api-v3.pump.fun";
  }

  /**
   * Discovers candidate mints for the scan loop by combining two views:
   * the newest coins (catches tokens still climbing toward the target band)
   * and coins sorted by market cap descending, page-limited so we skip the
   * mega-cap tail and only walk pages likely to still contain sub-$500k coins.
   */
  async discoverCandidates(opts: { pages?: number; limit?: number } = {}): Promise<DiscoveredCoin[]> {
    const { pages = 3, limit = 50 } = opts;
    const seen = new Map<string, DiscoveredCoin>();

    const fetches: Promise<PumpFunCoin[]>[] = [];
    fetches.push(this.listCoins({ offset: 0, limit, sort: "created_timestamp", order: "DESC" }));
    for (let page = 0; page < pages; page++) {
      fetches.push(this.listCoins({ offset: page * limit, limit, sort: "market_cap", order: "ASC" }));
    }

    const settled = await Promise.allSettled(fetches);
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const coin of result.value) {
        if (!coin.mint) continue;
        seen.set(coin.mint, toDiscoveredCoin(coin));
      }
    }
    return [...seen.values()];
  }

  private async listCoins(params: {
    offset: number;
    limit: number;
    sort: SortField;
    order: SortOrder;
  }): Promise<PumpFunCoin[]> {
    const query = new URLSearchParams({
      offset: String(params.offset),
      limit: String(params.limit),
      sort: params.sort,
      order: params.order,
      includeNsfw: "false",
    });
    try {
      return await fetchJson<PumpFunCoin[]>(`${this.baseUrl}/coins?${query.toString()}`, {
        timeoutMs: 8000,
        retries: 1,
      });
    } catch (err) {
      logger.warn("listCoins failed", { params, error: String(err) });
      return [];
    }
  }
}

function toDiscoveredCoin(coin: PumpFunCoin): DiscoveredCoin {
  return {
    mintAddress: coin.mint,
    symbol: coin.symbol,
    name: coin.name,
    description: coin.description,
    createdAt: coin.created_timestamp ? new Date(coin.created_timestamp) : undefined,
    graduated: coin.complete ?? false,
    marketCapUsd: coin.usd_market_cap ?? coin.market_cap_usd,
    hasTwitter: Boolean(coin.twitter),
    hasTelegram: Boolean(coin.telegram),
    hasWebsite: Boolean(coin.website),
  };
}
