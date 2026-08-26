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
   * Discovers newly-created mints, newest first. This is deliberately NOT
   * filtered by market cap: pump.fun's `sort=market_cap&order=ASC` was
   * tried and found useless for finding our target band - the vast
   * majority of tokens sit at ~0 mcap (freshly launched, untraded) or
   * exactly at pump.fun's bonding-curve starting value, so ascending pages
   * are dominated by dead-on-arrival tokens and rarely reach five figures
   * within any reasonable page depth. `order=DESC` is just as useless from
   * the top (hundreds of millions in mcap, thousands of pages to page
   * through). There is no market-cap range filter in this API.
   *
   * Instead, the caller (the worker's scan job) is expected to add every
   * newly-seen mint to a persistent watchlist and re-check its live mcap
   * via DexScreener on every subsequent cycle - that's what actually
   * catches a token as it climbs from ~$2k at launch into the 50k-500k
   * band, rather than needing this snapshot to catch it mid-band by luck.
   */
  async discoverNewMints(opts: { pages?: number; limit?: number } = {}): Promise<DiscoveredCoin[]> {
    const { pages = 6, limit = 100 } = opts;
    const seen = new Map<string, DiscoveredCoin>();

    const fetches: Promise<PumpFunCoin[]>[] = [];
    for (let page = 0; page < pages; page++) {
      fetches.push(this.listCoins({ offset: page * limit, limit, sort: "created_timestamp", order: "DESC" }));
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
